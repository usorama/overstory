/**
 * CLI command: overstory log <event> --agent <name> [--stdin]
 *
 * Called by Pre/PostToolUse and Stop hooks.
 * Events: tool-start, tool-end, session-end.
 * Writes to .overstory/logs/{agent-name}/{session-timestamp}/.
 *
 * When --stdin is passed, reads one line of JSON from stdin containing the full
 * hook payload (tool_name, tool_input, transcript_path, session_id, etc.)
 * and writes structured events to the EventStore for observability.
 */

import { join } from "node:path";
import { updateIdentity } from "../agents/identity.ts";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { filterToolArgs } from "../events/tool-filter.ts";
import { createLogger } from "../logging/logger.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { estimateCost, parseTranscriptUsage } from "../metrics/transcript.ts";
import type { AgentSession } from "../types.ts";

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

/**
 * Get or create a session timestamp directory for the agent.
 * Uses a file-based marker to track the current session directory.
 */
async function getSessionDir(logsBase: string, agentName: string): Promise<string> {
	const agentLogsDir = join(logsBase, agentName);
	const markerPath = join(agentLogsDir, ".current-session");

	const markerFile = Bun.file(markerPath);
	if (await markerFile.exists()) {
		const sessionDir = (await markerFile.text()).trim();
		if (sessionDir.length > 0) {
			return sessionDir;
		}
	}

	// Create a new session directory
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const sessionDir = join(agentLogsDir, timestamp);
	const { mkdir } = await import("node:fs/promises");
	await mkdir(sessionDir, { recursive: true });
	await Bun.write(markerPath, sessionDir);
	return sessionDir;
}

/**
 * Update the lastActivity timestamp for an agent in sessions.json.
 * Non-fatal: silently ignores errors to avoid breaking hook execution.
 */
async function updateLastActivity(projectRoot: string, agentName: string): Promise<void> {
	const sessionsPath = join(projectRoot, ".overstory", "sessions.json");
	const file = Bun.file(sessionsPath);
	if (!(await file.exists())) return;

	try {
		const text = await file.text();
		const sessions = JSON.parse(text) as AgentSession[];
		const session = sessions.find((s) => s.agentName === agentName);
		if (session) {
			session.lastActivity = new Date().toISOString();
			// Transition from booting to working on first activity
			if (session.state === "booting") {
				session.state = "working";
			}
			await Bun.write(sessionsPath, `${JSON.stringify(sessions, null, "\t")}\n`);
		}
	} catch {
		// Non-fatal: don't break logging if session update fails
	}
}

/**
 * Transition agent state to 'completed' in sessions.json.
 * Called when session-end event fires.
 * Non-fatal: silently ignores errors to avoid breaking hook execution.
 */
async function transitionToCompleted(projectRoot: string, agentName: string): Promise<void> {
	const sessionsPath = join(projectRoot, ".overstory", "sessions.json");
	const file = Bun.file(sessionsPath);
	if (!(await file.exists())) return;

	try {
		const text = await file.text();
		const sessions = JSON.parse(text) as AgentSession[];
		const session = sessions.find((s) => s.agentName === agentName);
		if (session) {
			session.state = "completed";
			session.lastActivity = new Date().toISOString();
			await Bun.write(sessionsPath, `${JSON.stringify(sessions, null, "\t")}\n`);
		}
	} catch {
		// Non-fatal: don't break logging if session update fails
	}
}

/**
 * Look up an agent's session record.
 * Returns null if not found.
 */
async function getAgentSession(
	projectRoot: string,
	agentName: string,
): Promise<AgentSession | null> {
	const sessionsPath = join(projectRoot, ".overstory", "sessions.json");
	const file = Bun.file(sessionsPath);
	if (!(await file.exists())) return null;

	try {
		const text = await file.text();
		const sessions = JSON.parse(text) as AgentSession[];
		return sessions.find((s) => s.agentName === agentName) ?? null;
	} catch {
		return null;
	}
}

/**
 * Read one line of JSON from stdin. Returns parsed object or null on failure.
 * Used when --stdin flag is present to receive hook payload from Claude Code.
 */
async function readStdinJson(): Promise<Record<string, unknown> | null> {
	try {
		const reader = Bun.stdin.stream().getReader();
		const { value } = await reader.read();
		reader.releaseLock();
		if (!value) return null;
		const text = new TextDecoder().decode(value).trim();
		if (text.length === 0) return null;
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * Entry point for `overstory log <event> --agent <name>`.
 */
const LOG_HELP = `overstory log — Log a hook event

Usage: overstory log <event> --agent <name> [--stdin]

Arguments:
  <event>            Event type: tool-start, tool-end, session-end

Options:
  --agent <name>            Agent name (required)
  --tool-name <name>        Tool name (for tool-start/tool-end events, legacy)
  --transcript <path>       Path to Claude Code transcript JSONL (for session-end, legacy)
  --stdin                   Read hook payload JSON from stdin (preferred)
  --help, -h                Show this help`;

export async function logCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${LOG_HELP}\n`);
		return;
	}

	const event = args.find((a) => !a.startsWith("--"));
	const agentName = getFlag(args, "--agent");
	const useStdin = args.includes("--stdin");
	const toolNameFlag = getFlag(args, "--tool-name") ?? "unknown";
	const transcriptPathFlag = getFlag(args, "--transcript");

	if (!event) {
		throw new ValidationError("Event is required: overstory log <event> --agent <name>", {
			field: "event",
		});
	}

	const validEvents = ["tool-start", "tool-end", "session-end"];
	if (!validEvents.includes(event)) {
		throw new ValidationError(`Invalid event "${event}". Valid: ${validEvents.join(", ")}`, {
			field: "event",
			value: event,
		});
	}

	if (!agentName) {
		throw new ValidationError("--agent is required for log command", {
			field: "agent",
		});
	}

	// Read stdin payload if --stdin flag is set
	let stdinPayload: Record<string, unknown> | null = null;
	if (useStdin) {
		stdinPayload = await readStdinJson();
	}

	// Extract fields from stdin payload (preferred) or fall back to flags
	const toolName =
		typeof stdinPayload?.tool_name === "string" ? stdinPayload.tool_name : toolNameFlag;
	const toolInput =
		stdinPayload?.tool_input !== undefined &&
		stdinPayload?.tool_input !== null &&
		typeof stdinPayload.tool_input === "object"
			? (stdinPayload.tool_input as Record<string, unknown>)
			: null;
	const sessionId = typeof stdinPayload?.session_id === "string" ? stdinPayload.session_id : null;
	const transcriptPath =
		typeof stdinPayload?.transcript_path === "string"
			? stdinPayload.transcript_path
			: transcriptPathFlag;

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const logsBase = join(config.project.root, ".overstory", "logs");
	const sessionDir = await getSessionDir(logsBase, agentName);

	const logger = createLogger({
		logDir: sessionDir,
		agentName,
		verbose: config.logging.verbose,
		redactSecrets: config.logging.redactSecrets,
	});

	switch (event) {
		case "tool-start": {
			// Backward compatibility: always write to per-agent log files
			logger.toolStart(toolName, toolInput ?? {});
			await updateLastActivity(config.project.root, agentName);

			// When --stdin is used, also write to EventStore for structured observability
			if (useStdin) {
				try {
					const eventsDbPath = join(config.project.root, ".overstory", "events.db");
					const eventStore = createEventStore(eventsDbPath);
					const filtered = toolInput
						? filterToolArgs(toolName, toolInput)
						: { args: {}, summary: toolName };
					eventStore.insert({
						runId: null,
						agentName,
						sessionId,
						eventType: "tool_start",
						toolName,
						toolArgs: JSON.stringify(filtered.args),
						toolDurationMs: null,
						level: "info",
						data: JSON.stringify({ summary: filtered.summary }),
					});
					eventStore.close();
				} catch {
					// Non-fatal: EventStore write should not break hook execution
				}
			}
			break;
		}
		case "tool-end": {
			// Backward compatibility: always write to per-agent log files
			logger.toolEnd(toolName, 0);
			await updateLastActivity(config.project.root, agentName);

			// When --stdin is used, write to EventStore and correlate with tool-start
			if (useStdin) {
				try {
					const eventsDbPath = join(config.project.root, ".overstory", "events.db");
					const eventStore = createEventStore(eventsDbPath);
					const filtered = toolInput
						? filterToolArgs(toolName, toolInput)
						: { args: {}, summary: toolName };
					eventStore.insert({
						runId: null,
						agentName,
						sessionId,
						eventType: "tool_end",
						toolName,
						toolArgs: JSON.stringify(filtered.args),
						toolDurationMs: null,
						level: "info",
						data: JSON.stringify({ summary: filtered.summary }),
					});
					const correlation = eventStore.correlateToolEnd(agentName, toolName);
					if (correlation) {
						logger.toolEnd(toolName, correlation.durationMs);
					}
					eventStore.close();
				} catch {
					// Non-fatal: EventStore write should not break hook execution
				}
			}
			break;
		}
		case "session-end":
			logger.info("session.end", { agentName });
			// Transition agent state to completed
			await transitionToCompleted(config.project.root, agentName);
			// Look up agent session for identity update and metrics recording
			{
				const agentSession = await getAgentSession(config.project.root, agentName);
				const beadId = agentSession?.beadId ?? null;

				// Update agent identity with completed session
				const identityBaseDir = join(config.project.root, ".overstory", "agents");
				try {
					await updateIdentity(identityBaseDir, agentName, {
						sessionsCompleted: 1,
						completedTask: beadId ? { beadId, summary: `Completed task ${beadId}` } : undefined,
					});
				} catch {
					// Non-fatal: identity may not exist for this agent
				}

				// Record session metrics (with optional token data from transcript)
				if (agentSession) {
					try {
						const metricsDbPath = join(config.project.root, ".overstory", "metrics.db");
						const metricsStore = createMetricsStore(metricsDbPath);
						const now = new Date().toISOString();
						const durationMs = new Date(now).getTime() - new Date(agentSession.startedAt).getTime();

						// Parse token usage from transcript if path provided
						let inputTokens = 0;
						let outputTokens = 0;
						let cacheReadTokens = 0;
						let cacheCreationTokens = 0;
						let estimatedCostUsd: number | null = null;
						let modelUsed: string | null = null;

						if (transcriptPath) {
							try {
								const usage = await parseTranscriptUsage(transcriptPath);
								inputTokens = usage.inputTokens;
								outputTokens = usage.outputTokens;
								cacheReadTokens = usage.cacheReadTokens;
								cacheCreationTokens = usage.cacheCreationTokens;
								modelUsed = usage.modelUsed;
								estimatedCostUsd = estimateCost(usage);
							} catch {
								// Non-fatal: transcript parsing should not break metrics
							}
						}

						metricsStore.recordSession({
							agentName,
							beadId: agentSession.beadId,
							capability: agentSession.capability,
							startedAt: agentSession.startedAt,
							completedAt: now,
							durationMs,
							exitCode: null,
							mergeResult: null,
							parentAgent: agentSession.parentAgent,
							inputTokens,
							outputTokens,
							cacheReadTokens,
							cacheCreationTokens,
							estimatedCostUsd,
							modelUsed,
						});
						metricsStore.close();
					} catch {
						// Non-fatal: metrics recording should not break session-end handling
					}
				}

				// Write session-end event to EventStore when --stdin is used
				if (useStdin) {
					try {
						const eventsDbPath = join(config.project.root, ".overstory", "events.db");
						const eventStore = createEventStore(eventsDbPath);
						eventStore.insert({
							runId: null,
							agentName,
							sessionId,
							eventType: "session_end",
							toolName: null,
							toolArgs: null,
							toolDurationMs: null,
							level: "info",
							data: transcriptPath ? JSON.stringify({ transcriptPath }) : null,
						});
						eventStore.close();
					} catch {
						// Non-fatal: EventStore write should not break session-end
					}
				}
			}
			// Clear the current session marker
			{
				const markerPath = join(logsBase, agentName, ".current-session");
				try {
					const { unlink } = await import("node:fs/promises");
					await unlink(markerPath);
				} catch {
					// Marker may not exist
				}
			}
			break;
	}

	logger.close();
}
