/**
 * Tier 1 mechanical process monitoring daemon.
 *
 * Runs on a configurable interval, checking the health of all active agent
 * sessions. Handles automatic termination of zombie agents and escalation
 * of stalled agents to Tier 2 triage.
 *
 * ZFC Principle: Observable state (tmux alive, pid alive) is the source of
 * truth. See health.ts for the full ZFC documentation.
 */

import { join } from "node:path";
import type { AgentSession, HealthCheck } from "../types.ts";
import { isSessionAlive, killSession } from "../worktree/tmux.ts";
import { evaluateHealth, transitionState } from "./health.ts";
import { triageAgent } from "./triage.ts";

/**
 * Start the watchdog daemon that periodically monitors agent health.
 *
 * On each tick:
 * 1. Loads sessions.json from {root}/.overstory/sessions.json
 * 2. For each session (including zombies — ZFC requires re-checking observable
 *    state), checks tmux liveness and evaluates health
 * 3. Terminates zombie agents (kills tmux session, updates state)
 * 4. Flags "investigate" cases where tmux is alive but sessions.json says zombie
 * 5. Escalates stalled agents to AI triage
 * 6. Persists updated session states back to sessions.json
 *
 * @param options.root - Project root directory (contains .overstory/)
 * @param options.intervalMs - Polling interval in milliseconds
 * @param options.staleThresholdMs - Time after which an agent is considered stale
 * @param options.zombieThresholdMs - Time after which an agent is considered a zombie
 * @param options.onHealthCheck - Optional callback for each health check result
 * @returns An object with a `stop` function to halt the daemon
 */
export function startDaemon(options: {
	root: string;
	intervalMs: number;
	staleThresholdMs: number;
	zombieThresholdMs: number;
	onHealthCheck?: (check: HealthCheck) => void;
}): { stop: () => void } {
	const { root, intervalMs, staleThresholdMs, zombieThresholdMs, onHealthCheck } = options;
	const sessionsPath = join(root, ".overstory", "sessions.json");

	const thresholds = {
		staleMs: staleThresholdMs,
		zombieMs: zombieThresholdMs,
	};

	async function tick(): Promise<void> {
		const sessions = await loadSessions(sessionsPath);
		let updated = false;

		for (const session of sessions) {
			// Skip completed sessions — they are terminal and don't need monitoring
			if (session.state === "completed") {
				continue;
			}

			// ZFC: Don't skip zombies. Re-check tmux liveness on every tick.
			// A zombie with a live tmux session needs investigation, not silence.

			const tmuxAlive = await isSessionAlive(session.tmuxSession);
			const check = evaluateHealth(session, tmuxAlive, thresholds);

			// Transition state forward only (investigate action holds state)
			const newState = transitionState(session.state, check);
			if (newState !== session.state) {
				session.state = newState;
				updated = true;
			}

			if (onHealthCheck) {
				onHealthCheck(check);
			}

			if (check.action === "terminate") {
				// Kill the tmux session if it's still alive
				if (tmuxAlive) {
					try {
						await killSession(session.tmuxSession);
					} catch {
						// Session may have died between check and kill — not an error
					}
				}
				session.state = "zombie";
				updated = true;
			} else if (check.action === "investigate") {
				// ZFC: tmux alive but sessions.json says zombie.
				// Log the conflict but do NOT auto-kill.
				// The onHealthCheck callback surfaces this to the operator.
				// No state change — keep zombie until a human or higher-tier agent decides.
			} else if (check.action === "escalate") {
				// Delegate to Tier 2 AI triage
				const verdict = await triageAgent({
					agentName: session.agentName,
					root,
					lastActivity: session.lastActivity,
				});

				if (verdict === "terminate") {
					if (tmuxAlive) {
						try {
							await killSession(session.tmuxSession);
						} catch {
							// Session may have died — not an error
						}
					}
					session.state = "zombie";
					updated = true;
				}
				// "retry" and "extend" leave the session running — no state change needed
			}
		}

		if (updated) {
			await saveSessions(sessionsPath, sessions);
		}
	}

	// Run the first tick immediately, then on interval
	tick().catch(() => {
		// Swallow errors in the first tick — daemon must not crash
	});

	const interval = setInterval(() => {
		tick().catch(() => {
			// Swallow errors in periodic ticks — daemon must not crash
		});
	}, intervalMs);

	return {
		stop(): void {
			clearInterval(interval);
		},
	};
}

/**
 * Load agent sessions from the sessions.json file.
 *
 * @param sessionsPath - Absolute path to sessions.json
 * @returns Array of agent sessions, or empty array if the file doesn't exist
 */
async function loadSessions(sessionsPath: string): Promise<AgentSession[]> {
	const file = Bun.file(sessionsPath);
	const exists = await file.exists();

	if (!exists) {
		return [];
	}

	const text = await file.text();
	const parsed: unknown = JSON.parse(text);

	if (!Array.isArray(parsed)) {
		return [];
	}

	return parsed as AgentSession[];
}

/**
 * Save agent sessions back to sessions.json.
 *
 * @param sessionsPath - Absolute path to sessions.json
 * @param sessions - The sessions array to persist
 */
async function saveSessions(sessionsPath: string, sessions: AgentSession[]): Promise<void> {
	await Bun.write(sessionsPath, `${JSON.stringify(sessions, null, "\t")}\n`);
}
