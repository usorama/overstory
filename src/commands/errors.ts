/**
 * CLI command: overstory errors [--agent <name>] [--run <id>] [--json] [--since <ts>] [--until <ts>] [--limit <n>]
 *
 * Shows aggregated error-level events across all agents.
 * Errors can be filtered by agent name, run ID, or time range.
 * Human output groups errors by agent; JSON output returns a flat array.
 */

import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import type { StoredEvent } from "../types.ts";

// ANSI escape codes consistent with src/logging/reporter.ts
const ANSI = {
	reset: "\x1b[0m",
	gray: "\x1b[90m",
	red: "\x1b[31m",
	yellow: "\x1b[33m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
} as const;

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
 * Format the date portion of an ISO timestamp.
 * Returns "YYYY-MM-DD".
 */
function formatDate(timestamp: string): string {
	const match = /^(\d{4}-\d{2}-\d{2})/.exec(timestamp);
	if (match?.[1]) {
		return match[1];
	}
	return "";
}

/**
 * Build a detail string for an error event based on its fields.
 */
function buildErrorDetail(event: StoredEvent): string {
	const parts: string[] = [];

	if (event.toolName) {
		parts.push(`tool=${event.toolName}`);
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
						const truncated = strValue.length > 80 ? `${strValue.slice(0, 77)}...` : strValue;
						parts.push(`${key}=${truncated}`);
					}
				}
			}
		} catch {
			// data is not valid JSON; show it raw if short enough
			if (event.data.length <= 80) {
				parts.push(event.data);
			}
		}
	}

	return parts.join(" ");
}

/**
 * Group errors by agent name, preserving insertion order.
 */
function groupByAgent(events: StoredEvent[]): Map<string, StoredEvent[]> {
	const groups = new Map<string, StoredEvent[]>();
	for (const event of events) {
		const existing = groups.get(event.agentName);
		if (existing) {
			existing.push(event);
		} else {
			groups.set(event.agentName, [event]);
		}
	}
	return groups;
}

/**
 * Print errors grouped by agent with ANSI colors.
 */
function printErrors(events: StoredEvent[]): void {
	const w = process.stdout.write.bind(process.stdout);

	w(`${ANSI.bold}${ANSI.red}Errors${ANSI.reset}\n`);
	w(`${"=".repeat(70)}\n`);

	if (events.length === 0) {
		w(`${ANSI.dim}No errors found.${ANSI.reset}\n`);
		return;
	}

	w(`${ANSI.dim}${events.length} error${events.length === 1 ? "" : "s"}${ANSI.reset}\n\n`);

	const grouped = groupByAgent(events);

	let firstGroup = true;
	for (const [agentName, agentEvents] of grouped) {
		if (!firstGroup) {
			w("\n");
		}
		firstGroup = false;

		w(
			`${ANSI.bold}${agentName}${ANSI.reset} ${ANSI.dim}(${agentEvents.length} error${agentEvents.length === 1 ? "" : "s"})${ANSI.reset}\n`,
		);

		for (const event of agentEvents) {
			const date = formatDate(event.createdAt);
			const time = formatAbsoluteTime(event.createdAt);
			const timestamp = date ? `${date} ${time}` : time;

			const detail = buildErrorDetail(event);
			const detailSuffix = detail ? ` ${ANSI.dim}${detail}${ANSI.reset}` : "";

			w(
				`  ${ANSI.dim}${timestamp}${ANSI.reset} ${ANSI.red}${ANSI.bold}ERROR${ANSI.reset}${detailSuffix}\n`,
			);
		}
	}
}

const ERRORS_HELP = `overstory errors -- Aggregated error view across agents

Usage: overstory errors [options]

Options:
  --agent <name>         Filter errors by agent name
  --run <id>             Filter errors by run ID
  --since <timestamp>    Start time filter (ISO 8601)
  --until <timestamp>    End time filter (ISO 8601)
  --limit <n>            Max errors to show (default: 100)
  --json                 Output as JSON array of StoredEvent objects
  --help, -h             Show this help`;

/**
 * Entry point for `overstory errors [--agent <name>] [--run <id>] [--json] [--since] [--until] [--limit]`.
 */
export async function errorsCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${ERRORS_HELP}\n`);
		return;
	}

	const json = hasFlag(args, "--json");
	const agentName = getFlag(args, "--agent");
	const runId = getFlag(args, "--run");
	const sinceStr = getFlag(args, "--since");
	const untilStr = getFlag(args, "--until");
	const limitStr = getFlag(args, "--limit");
	const limit = limitStr ? Number.parseInt(limitStr, 10) : 100;

	if (Number.isNaN(limit) || limit < 1) {
		throw new ValidationError("--limit must be a positive integer", {
			field: "limit",
			value: limitStr,
		});
	}

	// Validate timestamps if provided
	if (sinceStr !== undefined && Number.isNaN(new Date(sinceStr).getTime())) {
		throw new ValidationError("--since must be a valid ISO 8601 timestamp", {
			field: "since",
			value: sinceStr,
		});
	}
	if (untilStr !== undefined && Number.isNaN(new Date(untilStr).getTime())) {
		throw new ValidationError("--until must be a valid ISO 8601 timestamp", {
			field: "until",
			value: untilStr,
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
		const queryOpts = {
			since: sinceStr,
			until: untilStr,
			limit,
		};

		let events: StoredEvent[];

		if (agentName !== undefined) {
			// Filter by agent: use getByAgent with level filter
			events = eventStore.getByAgent(agentName, { ...queryOpts, level: "error" });
		} else if (runId !== undefined) {
			// Filter by run: use getByRun with level filter
			events = eventStore.getByRun(runId, { ...queryOpts, level: "error" });
		} else {
			// Global errors: use getErrors (already filters level='error')
			events = eventStore.getErrors(queryOpts);
		}

		if (json) {
			process.stdout.write(`${JSON.stringify(events)}\n`);
			return;
		}

		printErrors(events);
	} finally {
		eventStore.close();
	}
}
