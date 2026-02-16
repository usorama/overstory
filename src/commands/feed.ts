/**
 * CLI command: overstory feed [--follow] [--agent <name>...] [--run <id>]
 *              [--since <ts>] [--limit <n>] [--interval <ms>] [--json]
 *
 * Unified real-time event stream across all agents — like `tail -f` for the fleet.
 * Shows chronological events from all agents merged into a single feed.
 */

import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { color } from "../logging/color.ts";
import type { EventType, StoredEvent } from "../types.ts";

/** Compact 5-char labels for feed output. */
const EVENT_LABELS: Record<EventType, { label: string; color: string }> = {
	tool_start: { label: "TOOL+", color: color.blue },
	tool_end: { label: "TOOL-", color: color.blue },
	session_start: { label: "SESS+", color: color.green },
	session_end: { label: "SESS-", color: color.yellow },
	mail_sent: { label: "MAIL>", color: color.cyan },
	mail_received: { label: "MAIL<", color: color.cyan },
	spawn: { label: "SPAWN", color: color.magenta },
	error: { label: "ERROR", color: color.red },
	custom: { label: "CUSTM", color: color.gray },
};

/** Colors assigned to agents in order of first appearance. */
const AGENT_COLORS = [color.blue, color.green, color.yellow, color.cyan, color.magenta] as const;

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
 * Parse all occurrences of a named flag from args.
 * Returns an array of values (e.g., --agent a --agent b => ["a", "b"]).
 */
function getAllFlags(args: string[], flag: string): string[] {
	const values: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === flag && i + 1 < args.length) {
			const value = args[i + 1];
			if (value !== undefined) {
				values.push(value);
			}
			i++; // skip the value
		}
	}
	return values;
}

function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

/**
 * Format an absolute time from an ISO timestamp.
 * Returns "HH:MM:SS" portion.
 */
function formatAbsoluteTime(timestamp: string): string {
	const match = /T(\d{2}:\d{2}:\d{2})/.exec(timestamp);
	if (match?.[1]) {
		return match[1];
	}
	return timestamp;
}

/**
 * Build a detail string for a feed event based on its type and fields.
 */
function buildEventDetail(event: StoredEvent): string {
	const parts: string[] = [];

	if (event.toolName) {
		parts.push(`tool=${event.toolName}`);
	}

	if (event.toolDurationMs !== null) {
		parts.push(`${event.toolDurationMs}ms`);
	}

	if (event.data) {
		try {
			const parsed: unknown = JSON.parse(event.data);
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				const data = parsed as Record<string, unknown>;
				for (const [key, value] of Object.entries(data)) {
					if (value !== null && value !== undefined) {
						const strValue = typeof value === "string" ? value : JSON.stringify(value);
						// Truncate long values
						const truncated = strValue.length > 60 ? `${strValue.slice(0, 57)}...` : strValue;
						parts.push(`${key}=${truncated}`);
					}
				}
			}
		} catch {
			// data is not valid JSON; show it raw if short enough
			if (event.data.length <= 60) {
				parts.push(event.data);
			}
		}
	}

	return parts.join(" ");
}

/**
 * Assign a stable color to each agent based on order of first appearance.
 */
function buildAgentColorMap(events: StoredEvent[]): Map<string, string> {
	const colorMap = new Map<string, string>();
	for (const event of events) {
		if (!colorMap.has(event.agentName)) {
			const colorIndex = colorMap.size % AGENT_COLORS.length;
			const agentColor = AGENT_COLORS[colorIndex];
			if (agentColor !== undefined) {
				colorMap.set(event.agentName, agentColor);
			}
		}
	}
	return colorMap;
}

/**
 * Print a single event in compact feed format:
 * HH:MM:SS LABEL agentname    detail
 */
function printEvent(event: StoredEvent, colorMap: Map<string, string>): void {
	const w = process.stdout.write.bind(process.stdout);

	const timeStr = formatAbsoluteTime(event.createdAt);

	const eventInfo = EVENT_LABELS[event.eventType] ?? {
		label: event.eventType.padEnd(5),
		color: color.gray,
	};

	const levelColor =
		event.level === "error" ? color.red : event.level === "warn" ? color.yellow : "";
	const levelReset = levelColor ? color.reset : "";

	const detail = buildEventDetail(event);
	const detailSuffix = detail ? ` ${color.dim}${detail}${color.reset}` : "";

	const agentColor = colorMap.get(event.agentName) ?? color.gray;
	const agentLabel = ` ${agentColor}${event.agentName.padEnd(15)}${color.reset}`;

	w(
		`${color.dim}${timeStr}${color.reset} ` +
			`${levelColor}${eventInfo.color}${color.bold}${eventInfo.label}${color.reset}${levelReset}` +
			`${agentLabel}${detailSuffix}\n`,
	);
}

const FEED_HELP = `overstory feed -- Unified real-time event stream across all agents

Usage: overstory feed [options]

Options:
  --follow, -f         Continuously poll for new events (like tail -f)
  --interval <ms>      Polling interval for --follow (default: 1000, min: 200)
  --agent <name>       Filter by agent name (can appear multiple times)
  --run <id>           Filter events by run ID
  --since <timestamp>  Start time (ISO 8601, default: 5 minutes ago)
  --limit <n>          Max initial events to show (default: 50)
  --json               Output events as JSON (one per line in follow mode)
  --help, -h           Show this help`;

/**
 * Entry point for `overstory feed [--follow] [--agent <name>...] [--run <id>] [--json]`.
 */
export async function feedCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${FEED_HELP}\n`);
		return;
	}

	const json = hasFlag(args, "--json");
	const follow = hasFlag(args, "--follow") || hasFlag(args, "-f");
	const runId = getFlag(args, "--run");
	const agentNames = getAllFlags(args, "--agent");
	const sinceStr = getFlag(args, "--since");
	const limitStr = getFlag(args, "--limit");
	const limit = limitStr ? Number.parseInt(limitStr, 10) : 50;

	const intervalStr = getFlag(args, "--interval");
	const interval = intervalStr ? Number.parseInt(intervalStr, 10) : 1000;

	if (Number.isNaN(limit) || limit < 1) {
		throw new ValidationError("--limit must be a positive integer", {
			field: "limit",
			value: limitStr,
		});
	}

	if (Number.isNaN(interval) || interval < 200) {
		throw new ValidationError("--interval must be a number >= 200 (milliseconds)", {
			field: "interval",
			value: intervalStr,
		});
	}

	// Validate timestamp if provided
	if (sinceStr !== undefined && Number.isNaN(new Date(sinceStr).getTime())) {
		throw new ValidationError("--since must be a valid ISO 8601 timestamp", {
			field: "since",
			value: sinceStr,
		});
	}

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const overstoryDir = join(config.project.root, ".overstory");

	// Open event store
	const eventsDbPath = join(overstoryDir, "events.db");
	const eventsFile = Bun.file(eventsDbPath);
	if (!(await eventsFile.exists())) {
		if (json) {
			process.stdout.write("[]\n");
		} else {
			process.stdout.write("No events data yet.\n");
		}
		return;
	}

	const eventStore = createEventStore(eventsDbPath);

	try {
		// Default since: 5 minutes ago
		const since = sinceStr ?? new Date(Date.now() - 5 * 60 * 1000).toISOString();

		// Helper to query events based on filters
		const queryEvents = (queryOpts: { since: string; limit: number }): StoredEvent[] => {
			if (runId) {
				return eventStore.getByRun(runId, queryOpts);
			}
			if (agentNames.length > 0) {
				const allEvents: StoredEvent[] = [];
				for (const name of agentNames) {
					const agentEvents = eventStore.getByAgent(name, {
						since: queryOpts.since,
					});
					allEvents.push(...agentEvents);
				}
				// Sort by createdAt chronologically
				allEvents.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
				// Apply limit after merge
				return allEvents.slice(0, queryOpts.limit);
			}
			return eventStore.getTimeline(queryOpts);
		};

		if (!follow) {
			// Non-follow mode: single snapshot
			const events = queryEvents({ since, limit });

			if (json) {
				process.stdout.write(`${JSON.stringify(events)}\n`);
				return;
			}

			if (events.length === 0) {
				process.stdout.write("No events found.\n");
				return;
			}

			const colorMap = buildAgentColorMap(events);
			for (const event of events) {
				printEvent(event, colorMap);
			}
			return;
		}

		// Follow mode: continuous polling
		// Print initial events
		let lastSeenId = 0;
		const initialEvents = queryEvents({ since, limit });

		if (!json) {
			const colorMap = buildAgentColorMap(initialEvents);
			for (const event of initialEvents) {
				printEvent(event, colorMap);
			}
			if (initialEvents.length > 0) {
				const lastEvent = initialEvents[initialEvents.length - 1];
				if (lastEvent) {
					lastSeenId = lastEvent.id;
				}
			}
		} else {
			// JSON mode: print each event as a line
			for (const event of initialEvents) {
				process.stdout.write(`${JSON.stringify(event)}\n`);
			}
			if (initialEvents.length > 0) {
				const lastEvent = initialEvents[initialEvents.length - 1];
				if (lastEvent) {
					lastSeenId = lastEvent.id;
				}
			}
		}

		// Maintain a color map across polling iterations (for non-JSON mode)
		const globalColorMap = buildAgentColorMap(initialEvents);

		// Poll for new events
		while (true) {
			await Bun.sleep(interval);

			// Query events from 60s ago, then filter client-side for id > lastSeenId
			const pollSince = new Date(Date.now() - 60 * 1000).toISOString();
			const recentEvents = queryEvents({ since: pollSince, limit: 1000 });

			// Filter to new events only
			const newEvents = recentEvents.filter((e) => e.id > lastSeenId);

			if (newEvents.length > 0) {
				if (!json) {
					// Update color map for any new agents
					for (const event of newEvents) {
						if (!globalColorMap.has(event.agentName)) {
							const colorIndex = globalColorMap.size % AGENT_COLORS.length;
							const agentColor = AGENT_COLORS[colorIndex];
							if (agentColor !== undefined) {
								globalColorMap.set(event.agentName, agentColor);
							}
						}
					}

					// Print new events
					for (const event of newEvents) {
						printEvent(event, globalColorMap);
					}
				} else {
					// JSON mode: print each event as a line
					for (const event of newEvents) {
						process.stdout.write(`${JSON.stringify(event)}\n`);
					}
				}

				// Update lastSeenId
				const lastNew = newEvents[newEvents.length - 1];
				if (lastNew) {
					lastSeenId = lastNew.id;
				}
			}
		}
	} finally {
		eventStore.close();
	}
}
