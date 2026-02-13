/**
 * CLI command: overstory nudge <agent-name> [message]
 *
 * Sends a text nudge to an agent's interactive Claude Code session via
 * tmux send-keys. Used to notify agents of new mail or relay urgent
 * instructions mid-conversation.
 *
 * Includes retry logic (3 attempts) and debounce (500ms) to prevent
 * rapid-fire nudges to the same agent.
 */

import { join } from "node:path";
import { AgentError, ValidationError } from "../errors.ts";
import type { AgentSession } from "../types.ts";
import { isSessionAlive, sendKeys } from "../worktree/tmux.ts";

const DEFAULT_MESSAGE = "Check your mail inbox for new messages.";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;
const DEBOUNCE_MS = 500;

/**
 * Parse a named flag value from args.
 */
function getFlag(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx === -1 || idx + 1 >= args.length) {
		return undefined;
	}
	return args[idx + 1];
}

/** Boolean flags that do NOT consume the next arg. */
const BOOLEAN_FLAGS = new Set(["--json", "--force", "--help", "-h"]);

/**
 * Extract positional arguments, skipping flag-value pairs.
 */
function getPositionalArgs(args: string[]): string[] {
	const positional: string[] = [];
	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		if (arg?.startsWith("-")) {
			if (BOOLEAN_FLAGS.has(arg)) {
				i += 1;
			} else {
				i += 2;
			}
		} else {
			if (arg !== undefined) {
				positional.push(arg);
			}
			i += 1;
		}
	}
	return positional;
}

/**
 * Load agent sessions from .overstory/sessions.json.
 */
async function loadSessions(projectRoot: string): Promise<AgentSession[]> {
	const sessionsPath = join(projectRoot, ".overstory", "sessions.json");
	const file = Bun.file(sessionsPath);
	if (!(await file.exists())) {
		return [];
	}
	try {
		const text = await file.text();
		return JSON.parse(text) as AgentSession[];
	} catch {
		return [];
	}
}

/**
 * Load the orchestrator's registered tmux session name.
 *
 * Written by `overstory prime` at SessionStart when the orchestrator
 * is running inside tmux. Enables agents to nudge the orchestrator
 * even though it's not tracked in sessions.json.
 */
async function loadOrchestratorTmuxSession(projectRoot: string): Promise<string | null> {
	const regPath = join(projectRoot, ".overstory", "orchestrator-tmux.json");
	const file = Bun.file(regPath);
	if (!(await file.exists())) {
		return null;
	}
	try {
		const text = await file.text();
		const reg = JSON.parse(text) as { tmuxSession?: string };
		return reg.tmuxSession ?? null;
	} catch {
		return null;
	}
}

/**
 * Resolve the tmux session name for an agent.
 *
 * For regular agents, looks up sessions.json.
 * For "orchestrator", falls back to the orchestrator-tmux.json registration
 * file written by `overstory prime`.
 */
async function resolveTargetSession(
	projectRoot: string,
	agentName: string,
): Promise<string | null> {
	const sessions = await loadSessions(projectRoot);
	const session = sessions.find(
		(s) => s.agentName === agentName && s.state !== "zombie" && s.state !== "completed",
	);
	if (session) {
		return session.tmuxSession;
	}

	// Fallback for orchestrator: check orchestrator-tmux.json
	if (agentName === "orchestrator") {
		return await loadOrchestratorTmuxSession(projectRoot);
	}

	return null;
}

/**
 * Check debounce state for an agent. Returns true if a nudge was sent
 * within the debounce window and should be skipped.
 */
async function isDebounced(statePath: string, agentName: string): Promise<boolean> {
	const file = Bun.file(statePath);
	if (!(await file.exists())) {
		return false;
	}
	try {
		const text = await file.text();
		const state = JSON.parse(text) as Record<string, number>;
		const lastNudge = state[agentName];
		if (lastNudge === undefined) {
			return false;
		}
		return Date.now() - lastNudge < DEBOUNCE_MS;
	} catch {
		return false;
	}
}

/**
 * Record a nudge timestamp for debounce tracking.
 */
async function recordNudge(statePath: string, agentName: string): Promise<void> {
	let state: Record<string, number> = {};
	const file = Bun.file(statePath);
	if (await file.exists()) {
		try {
			const text = await file.text();
			state = JSON.parse(text) as Record<string, number>;
		} catch {
			// Corrupt state file — start fresh
		}
	}
	state[agentName] = Date.now();
	await Bun.write(statePath, `${JSON.stringify(state, null, "\t")}\n`);
}

/**
 * Send a nudge to an agent's tmux session with retry logic.
 *
 * @param tmuxSession - The tmux session name
 * @param message - The text to send
 * @returns true if the nudge was delivered, false if all retries failed
 */
async function sendNudgeWithRetry(tmuxSession: string, message: string): Promise<boolean> {
	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			await sendKeys(tmuxSession, message);
			// Follow-up Enter after a short delay to ensure submission.
			// Claude Code's TUI may consume the first Enter during re-render/focus
			// events, leaving text visible but unsubmitted (overstory-t62v).
			// Same workaround as sling.ts and coordinator.ts.
			await Bun.sleep(500);
			await sendKeys(tmuxSession, "");
			return true;
		} catch {
			if (attempt < MAX_RETRIES) {
				await Bun.sleep(RETRY_DELAY_MS);
			}
		}
	}
	return false;
}

/**
 * Core nudge function. Exported for use by mail send auto-nudge.
 *
 * @param projectRoot - Absolute path to the project root
 * @param agentName - Name of the agent to nudge
 * @param message - Text to send (defaults to mail check prompt)
 * @param force - Skip debounce check
 * @returns Object with delivery status
 */
export async function nudgeAgent(
	projectRoot: string,
	agentName: string,
	message: string = DEFAULT_MESSAGE,
	force = false,
): Promise<{ delivered: boolean; reason?: string }> {
	// Resolve tmux session (sessions.json for agents, orchestrator-tmux.json for orchestrator)
	const tmuxSessionName = await resolveTargetSession(projectRoot, agentName);

	if (!tmuxSessionName) {
		return { delivered: false, reason: `No active session for agent "${agentName}"` };
	}

	// Check debounce (unless forced)
	if (!force) {
		const statePath = join(projectRoot, ".overstory", "nudge-state.json");
		const debounced = await isDebounced(statePath, agentName);
		if (debounced) {
			return { delivered: false, reason: "Debounced: nudge sent too recently" };
		}
	}

	// Verify tmux session is alive
	const alive = await isSessionAlive(tmuxSessionName);
	if (!alive) {
		return { delivered: false, reason: `Tmux session "${tmuxSessionName}" is not alive` };
	}

	// Send with retry
	const delivered = await sendNudgeWithRetry(tmuxSessionName, message);

	if (delivered) {
		// Record nudge for debounce tracking
		const statePath = join(projectRoot, ".overstory", "nudge-state.json");
		await recordNudge(statePath, agentName);
	}

	return delivered
		? { delivered: true }
		: { delivered: false, reason: `Failed to send after ${MAX_RETRIES} attempts` };
}

/**
 * Entry point for `overstory nudge <agent-name> [message]`.
 */
const NUDGE_HELP = `overstory nudge — Send a text nudge to an agent

Usage: overstory nudge <agent-name> [message]

Arguments:
  <agent-name>           Name of the agent to nudge
  [message]              Text to send (default: "${DEFAULT_MESSAGE}")

Options:
  --from <name>          Sender name for the nudge prefix (default: orchestrator)
  --force                Skip debounce check
  --json                 Output result as JSON
  --help, -h             Show this help`;

export async function nudgeCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${NUDGE_HELP}\n`);
		return;
	}

	const positional = getPositionalArgs(args);
	const agentName = positional[0];
	if (!agentName || agentName.trim().length === 0) {
		throw new ValidationError("Agent name is required: overstory nudge <agent-name> [message]", {
			field: "agentName",
		});
	}

	const from = getFlag(args, "--from") ?? "orchestrator";
	const force = args.includes("--force");
	const json = args.includes("--json");

	// Build the nudge message: prefix with sender, use custom or default text
	const customMessage = positional.slice(1).join(" ");
	const rawMessage = customMessage.length > 0 ? customMessage : DEFAULT_MESSAGE;
	const message = `[NUDGE from ${from}] ${rawMessage}`;

	// Resolve project root
	const { resolveProjectRoot } = await import("../config.ts");
	const projectRoot = await resolveProjectRoot(process.cwd());

	const result = await nudgeAgent(projectRoot, agentName, message, force);

	if (json) {
		process.stdout.write(
			`${JSON.stringify({ agentName, delivered: result.delivered, reason: result.reason })}\n`,
		);
	} else if (result.delivered) {
		process.stdout.write(`📢 Nudged "${agentName}"\n`);
	} else {
		throw new AgentError(`Nudge failed: ${result.reason}`, { agentName });
	}
}
