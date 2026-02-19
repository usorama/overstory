/**
 * CLI command: overstory costs [--agent <name>] [--run <id>] [--by-capability] [--last <n>] [--json]
 *
 * Shows token/cost analysis and breakdown for agent sessions.
 * Data source: metrics.db via createMetricsStore().
 */

import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { color } from "../logging/color.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { SessionMetrics } from "../types.ts";

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

/** Format a number with thousands separators (e.g., 12345 -> "12,345"). */
function formatNumber(n: number): string {
	return n.toLocaleString("en-US");
}

/** Format a cost value as "$X.XX". Returns "$0.00" for null/undefined. */
function formatCost(cost: number | null): string {
	if (cost === null || cost === undefined) {
		return "$0.00";
	}
	return `$${cost.toFixed(2)}`;
}

/** Right-pad a string to the given width. */
function padRight(str: string, width: number): string {
	return str.length >= width ? str : str + " ".repeat(width - str.length);
}

/** Left-pad a string to the given width. */
function padLeft(str: string, width: number): string {
	return str.length >= width ? str : " ".repeat(width - str.length) + str;
}

/** Aggregate totals from a list of SessionMetrics. */
interface Totals {
	inputTokens: number;
	outputTokens: number;
	cacheTokens: number;
	costUsd: number;
}

function computeTotals(sessions: SessionMetrics[]): Totals {
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheTokens = 0;
	let costUsd = 0;
	for (const s of sessions) {
		inputTokens += s.inputTokens;
		outputTokens += s.outputTokens;
		cacheTokens += s.cacheReadTokens + s.cacheCreationTokens;
		costUsd += s.estimatedCostUsd ?? 0;
	}
	return { inputTokens, outputTokens, cacheTokens, costUsd };
}

/** Group SessionMetrics by capability. */
interface CapabilityGroup {
	capability: string;
	sessions: SessionMetrics[];
	totals: Totals;
}

function groupByCapability(sessions: SessionMetrics[]): CapabilityGroup[] {
	const groups = new Map<string, SessionMetrics[]>();
	for (const s of sessions) {
		const existing = groups.get(s.capability);
		if (existing) {
			existing.push(s);
		} else {
			groups.set(s.capability, [s]);
		}
	}
	const result: CapabilityGroup[] = [];
	for (const [capability, capSessions] of groups) {
		result.push({
			capability,
			sessions: capSessions,
			totals: computeTotals(capSessions),
		});
	}
	// Sort by cost descending
	result.sort((a, b) => b.totals.costUsd - a.totals.costUsd);
	return result;
}

/** Print the standard per-agent cost summary table. */
function printCostSummary(sessions: SessionMetrics[]): void {
	const w = process.stdout.write.bind(process.stdout);
	const separator = "\u2500".repeat(70);

	w(`${color.bold}Cost Summary${color.reset}\n`);
	w(`${"=".repeat(70)}\n`);

	if (sessions.length === 0) {
		w(`${color.dim}No session data found.${color.reset}\n`);
		return;
	}

	w(
		`${padRight("Agent", 19)}${padRight("Capability", 12)}` +
			`${padLeft("Input", 10)}${padLeft("Output", 10)}` +
			`${padLeft("Cache", 10)}${padLeft("Cost", 10)}\n`,
	);
	w(`${color.dim}${separator}${color.reset}\n`);

	for (const s of sessions) {
		const cacheTotal = s.cacheReadTokens + s.cacheCreationTokens;
		w(
			`${padRight(s.agentName, 19)}${padRight(s.capability, 12)}` +
				`${padLeft(formatNumber(s.inputTokens), 10)}` +
				`${padLeft(formatNumber(s.outputTokens), 10)}` +
				`${padLeft(formatNumber(cacheTotal), 10)}` +
				`${padLeft(formatCost(s.estimatedCostUsd), 10)}\n`,
		);
	}

	const totals = computeTotals(sessions);
	w(`${color.dim}${separator}${color.reset}\n`);
	w(
		`${color.green}${color.bold}${padRight("Total", 31)}` +
			`${padLeft(formatNumber(totals.inputTokens), 10)}` +
			`${padLeft(formatNumber(totals.outputTokens), 10)}` +
			`${padLeft(formatNumber(totals.cacheTokens), 10)}` +
			`${padLeft(formatCost(totals.costUsd), 10)}${color.reset}\n`,
	);
}

/** Print the capability-grouped cost table. */
function printByCapability(sessions: SessionMetrics[]): void {
	const w = process.stdout.write.bind(process.stdout);
	const separator = "\u2500".repeat(70);

	w(`${color.bold}Cost by Capability${color.reset}\n`);
	w(`${"=".repeat(70)}\n`);

	if (sessions.length === 0) {
		w(`${color.dim}No session data found.${color.reset}\n`);
		return;
	}

	w(
		`${padRight("Capability", 14)}${padLeft("Sessions", 10)}` +
			`${padLeft("Input", 10)}${padLeft("Output", 10)}` +
			`${padLeft("Cache", 10)}${padLeft("Cost", 10)}\n`,
	);
	w(`${color.dim}${separator}${color.reset}\n`);

	const groups = groupByCapability(sessions);

	for (const group of groups) {
		w(
			`${padRight(group.capability, 14)}` +
				`${padLeft(formatNumber(group.sessions.length), 10)}` +
				`${padLeft(formatNumber(group.totals.inputTokens), 10)}` +
				`${padLeft(formatNumber(group.totals.outputTokens), 10)}` +
				`${padLeft(formatNumber(group.totals.cacheTokens), 10)}` +
				`${padLeft(formatCost(group.totals.costUsd), 10)}\n`,
		);
	}

	const totals = computeTotals(sessions);
	w(`${color.dim}${separator}${color.reset}\n`);
	w(
		`${color.green}${color.bold}${padRight("Total", 14)}` +
			`${padLeft(formatNumber(sessions.length), 10)}` +
			`${padLeft(formatNumber(totals.inputTokens), 10)}` +
			`${padLeft(formatNumber(totals.outputTokens), 10)}` +
			`${padLeft(formatNumber(totals.cacheTokens), 10)}` +
			`${padLeft(formatCost(totals.costUsd), 10)}${color.reset}\n`,
	);
}

const COSTS_HELP = `overstory costs -- Token/cost analysis and breakdown

Usage: overstory costs [options]

Options:
  --live                 Show real-time token usage for active agents
  --agent <name>         Filter by agent name
  --run <id>             Filter by run ID
  --by-capability        Group results by capability with subtotals
  --last <n>             Number of recent sessions (default: 20)
  --json                 Output as JSON
  --help, -h             Show this help`;

/**
 * Entry point for `overstory costs [--agent <name>] [--run <id>] [--by-capability] [--last <n>] [--json]`.
 */
export async function costsCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${COSTS_HELP}\n`);
		return;
	}

	const json = hasFlag(args, "--json");
	const live = hasFlag(args, "--live");
	const byCapability = hasFlag(args, "--by-capability");
	const agentName = getFlag(args, "--agent");
	const runId = getFlag(args, "--run");
	const lastStr = getFlag(args, "--last");

	if (lastStr !== undefined) {
		const parsed = Number.parseInt(lastStr, 10);
		if (Number.isNaN(parsed) || parsed < 1) {
			throw new ValidationError("--last must be a positive integer", {
				field: "last",
				value: lastStr,
			});
		}
	}

	const last = lastStr ? Number.parseInt(lastStr, 10) : 20;

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const overstoryDir = join(config.project.root, ".overstory");

	// Handle --live flag (early return for live view)
	if (live) {
		const metricsDbPath = join(overstoryDir, "metrics.db");
		const metricsFile = Bun.file(metricsDbPath);
		if (!(await metricsFile.exists())) {
			if (json) {
				process.stdout.write(
					`${JSON.stringify({ agents: [], totals: { inputTokens: 0, outputTokens: 0, cacheTokens: 0, costUsd: 0, burnRatePerMin: 0, tokensPerMin: 0 } })}\n`,
				);
			} else {
				process.stdout.write(
					"No live data available. Token snapshots begin after first tool call.\n",
				);
			}
			return;
		}

		const metricsStore = createMetricsStore(metricsDbPath);
		const { store: sessionStore } = openSessionStore(overstoryDir);

		try {
			const snapshots = metricsStore.getLatestSnapshots();
			if (snapshots.length === 0) {
				if (json) {
					process.stdout.write(
						`${JSON.stringify({ agents: [], totals: { inputTokens: 0, outputTokens: 0, cacheTokens: 0, costUsd: 0, burnRatePerMin: 0, tokensPerMin: 0 } })}\n`,
					);
				} else {
					process.stdout.write(
						"No live data available. Token snapshots begin after first tool call.\n",
					);
				}
				return;
			}

			// Get active sessions to join with snapshots
			const activeSessions = sessionStore.getActive();

			// Filter snapshots by agent if --agent is provided
			const filteredSnapshots = agentName
				? snapshots.filter((s) => s.agentName === agentName)
				: snapshots;

			// Build agent data with session info
			interface LiveAgentData {
				agentName: string;
				capability: string;
				inputTokens: number;
				outputTokens: number;
				cacheReadTokens: number;
				cacheCreationTokens: number;
				estimatedCostUsd: number;
				modelUsed: string | null;
				snapshotAt: string;
				sessionStartedAt: string;
				elapsedMs: number;
			}

			const agentData: LiveAgentData[] = [];
			const now = Date.now();

			for (const snapshot of filteredSnapshots) {
				const session = activeSessions.find((s) => s.agentName === snapshot.agentName);
				if (!session) continue; // Skip inactive agents

				const startedAt = new Date(session.startedAt).getTime();
				const elapsedMs = now - startedAt;

				agentData.push({
					agentName: snapshot.agentName,
					capability: session.capability,
					inputTokens: snapshot.inputTokens,
					outputTokens: snapshot.outputTokens,
					cacheReadTokens: snapshot.cacheReadTokens,
					cacheCreationTokens: snapshot.cacheCreationTokens,
					estimatedCostUsd: snapshot.estimatedCostUsd ?? 0,
					modelUsed: snapshot.modelUsed,
					snapshotAt: snapshot.createdAt,
					sessionStartedAt: session.startedAt,
					elapsedMs,
				});
			}

			// Compute totals
			let totalInput = 0;
			let totalOutput = 0;
			let totalCacheRead = 0;
			let totalCacheCreate = 0;
			let totalCost = 0;
			let totalElapsedMs = 0;

			for (const agent of agentData) {
				totalInput += agent.inputTokens;
				totalOutput += agent.outputTokens;
				totalCacheRead += agent.cacheReadTokens;
				totalCacheCreate += agent.cacheCreationTokens;
				totalCost += agent.estimatedCostUsd;
				totalElapsedMs += agent.elapsedMs;
			}

			const avgElapsedMs = agentData.length > 0 ? totalElapsedMs / agentData.length : 0;
			const totalCacheTokens = totalCacheRead + totalCacheCreate;
			const totalTokens = totalInput + totalOutput;
			const burnRatePerMin = avgElapsedMs > 0 ? totalCost / (avgElapsedMs / 60_000) : 0;
			const tokensPerMin = avgElapsedMs > 0 ? totalTokens / (avgElapsedMs / 60_000) : 0;

			if (json) {
				process.stdout.write(
					`${JSON.stringify({
						agents: agentData,
						totals: {
							inputTokens: totalInput,
							outputTokens: totalOutput,
							cacheTokens: totalCacheTokens,
							costUsd: totalCost,
							burnRatePerMin,
							tokensPerMin,
						},
					})}\n`,
				);
			} else {
				const w = process.stdout.write.bind(process.stdout);
				const separator = "\u2500".repeat(70);

				w(`${color.bold}Live Token Usage (${agentData.length} active agents)${color.reset}\n`);
				w(`${"=".repeat(70)}\n`);
				w(
					`${padRight("Agent", 19)}${padRight("Capability", 12)}` +
						`${padLeft("Input", 10)}${padLeft("Output", 10)}` +
						`${padLeft("Cache", 10)}${padLeft("Cost", 10)}\n`,
				);
				w(`${color.dim}${separator}${color.reset}\n`);

				for (const agent of agentData) {
					const cacheTotal = agent.cacheReadTokens + agent.cacheCreationTokens;
					w(
						`${padRight(agent.agentName, 19)}${padRight(agent.capability, 12)}` +
							`${padLeft(formatNumber(agent.inputTokens), 10)}` +
							`${padLeft(formatNumber(agent.outputTokens), 10)}` +
							`${padLeft(formatNumber(cacheTotal), 10)}` +
							`${padLeft(formatCost(agent.estimatedCostUsd), 10)}\n`,
					);
				}

				w(`${color.dim}${separator}${color.reset}\n`);
				w(
					`${color.green}${color.bold}${padRight("Total", 31)}` +
						`${padLeft(formatNumber(totalInput), 10)}` +
						`${padLeft(formatNumber(totalOutput), 10)}` +
						`${padLeft(formatNumber(totalCacheTokens), 10)}` +
						`${padLeft(formatCost(totalCost), 10)}${color.reset}\n\n`,
				);

				// Format elapsed time
				const totalElapsedSec = Math.floor(avgElapsedMs / 1000);
				const minutes = Math.floor(totalElapsedSec / 60);
				const seconds = totalElapsedSec % 60;
				const elapsedStr = `${minutes}m ${seconds}s`;

				w(
					`Burn rate: ${formatCost(burnRatePerMin)}/min  |  ` +
						`${formatNumber(Math.floor(tokensPerMin))} tokens/min  |  ` +
						`Elapsed: ${elapsedStr}\n`,
				);
			}
		} finally {
			metricsStore.close();
			sessionStore.close();
		}
		return;
	}

	// Check if metrics.db exists
	const metricsDbPath = join(overstoryDir, "metrics.db");
	const metricsFile = Bun.file(metricsDbPath);
	if (!(await metricsFile.exists())) {
		if (json) {
			process.stdout.write("[]\n");
		} else {
			process.stdout.write("No metrics data yet.\n");
		}
		return;
	}

	const metricsStore = createMetricsStore(metricsDbPath);

	try {
		let sessions: SessionMetrics[];

		if (agentName !== undefined) {
			sessions = metricsStore.getSessionsByAgent(agentName);
		} else if (runId !== undefined) {
			sessions = metricsStore.getSessionsByRun(runId);
		} else {
			sessions = metricsStore.getRecentSessions(last);
		}

		if (json) {
			if (byCapability) {
				const groups = groupByCapability(sessions);
				const grouped: Record<string, { sessions: SessionMetrics[]; totals: Totals }> = {};
				for (const group of groups) {
					grouped[group.capability] = {
						sessions: group.sessions,
						totals: group.totals,
					};
				}
				process.stdout.write(`${JSON.stringify(grouped)}\n`);
			} else {
				process.stdout.write(`${JSON.stringify(sessions)}\n`);
			}
			return;
		}

		if (byCapability) {
			printByCapability(sessions);
		} else {
			printCostSummary(sessions);
		}
	} finally {
		metricsStore.close();
	}
}
