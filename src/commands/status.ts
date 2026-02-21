/**
 * CLI command: overstory status [--json] [--watch]
 *
 * Shows active agents, worktree status, beads summary, mail queue depth,
 * and merge queue state. --watch mode uses polling for live updates.
 */

import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { createMailStore } from "../mail/store.ts";
import { createMergeQueue } from "../merge/queue.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { AgentSession } from "../types.ts";
import { listWorktrees } from "../worktree/manager.ts";
import { listSessions } from "../worktree/tmux.ts";

// ---------------------------------------------------------------------------
// Subprocess result cache (TTL-based, module-level)
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
	data: T;
	timestamp: number;
}

let worktreeCache: CacheEntry<Array<{ path: string; branch: string; head: string }>> | null = null;
let tmuxCache: CacheEntry<Array<{ name: string; pid: number }>> | null = null;

const DEFAULT_CACHE_TTL_MS = 10_000; // 10 seconds

export function invalidateStatusCache(): void {
	worktreeCache = null;
	tmuxCache = null;
}

export async function getCachedWorktrees(
	root: string,
	ttlMs: number = DEFAULT_CACHE_TTL_MS,
): Promise<Array<{ path: string; branch: string; head: string }>> {
	const now = Date.now();
	if (worktreeCache && now - worktreeCache.timestamp < ttlMs) {
		return worktreeCache.data;
	}
	const data = await listWorktrees(root);
	worktreeCache = { data, timestamp: now };
	return data;
}

export async function getCachedTmuxSessions(
	ttlMs: number = DEFAULT_CACHE_TTL_MS,
): Promise<Array<{ name: string; pid: number }>> {
	const now = Date.now();
	if (tmuxCache && now - tmuxCache.timestamp < ttlMs) {
		return tmuxCache.data;
	}
	try {
		const data = await listSessions();
		tmuxCache = { data, timestamp: now };
		return data;
	} catch {
		return tmuxCache?.data ?? [];
	}
}

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
 * Format a duration in ms to a human-readable string.
 */
function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainSec = seconds % 60;
	if (minutes < 60) return `${minutes}m ${remainSec}s`;
	const hours = Math.floor(minutes / 60);
	const remainMin = minutes % 60;
	return `${hours}h ${remainMin}m`;
}

export interface VerboseAgentDetail {
	worktreePath: string;
	logsDir: string;
	lastMailSent: string | null;
	lastMailReceived: string | null;
	capability: string;
}

export interface StatusData {
	currentRunId?: string | null;
	agents: AgentSession[];
	worktrees: Array<{ path: string; branch: string; head: string }>;
	tmuxSessions: Array<{ name: string; pid: number }>;
	unreadMailCount: number;
	mergeQueueCount: number;
	recentMetricsCount: number;
	verboseDetails?: Record<string, VerboseAgentDetail>;
}

async function readCurrentRunId(overstoryDir: string): Promise<string | null> {
	const path = join(overstoryDir, "current-run.txt");
	const file = Bun.file(path);
	if (!(await file.exists())) {
		return null;
	}
	const text = await file.text();
	const trimmed = text.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * Gather all status data.
 * @param agentName - Which agent's perspective for unread mail count (default "orchestrator")
 * @param verbose - When true, collect extra per-agent detail (worktree path, logs dir, last mail)
 * @param runId - When provided, only sessions for that run are returned; null/undefined shows all
 */
export async function gatherStatus(
	root: string,
	agentName = "orchestrator",
	verbose = false,
	runId?: string | null,
): Promise<StatusData> {
	const overstoryDir = join(root, ".overstory");
	const { store } = openSessionStore(overstoryDir);

	let sessions: AgentSession[];
	try {
		// When run-scoped, also include sessions with null runId (e.g. coordinator)
		// because SQL WHERE run_id = $run_id never matches NULL rows.
		sessions = runId
			? [...store.getByRun(runId), ...store.getAll().filter((s) => s.runId === null)]
			: store.getAll();

		const worktrees = await getCachedWorktrees(root);

		const tmuxSessions = await getCachedTmuxSessions();

		// Reconcile agent states: if tmux session is dead but agent state
		// indicates it should be alive, mark it as zombie
		const tmuxSessionNames = new Set(tmuxSessions.map((s) => s.name));
		for (const session of sessions) {
			if (
				session.state === "booting" ||
				session.state === "working" ||
				session.state === "stalled"
			) {
				const tmuxAlive = tmuxSessionNames.has(session.tmuxSession);
				if (!tmuxAlive) {
					try {
						store.updateState(session.agentName, "zombie");
						session.state = "zombie";
					} catch {
						// Best effort: don't fail status display if update fails
					}
				}
			}
		}

		let unreadMailCount = 0;
		let mailStore: ReturnType<typeof createMailStore> | null = null;
		try {
			const mailDbPath = join(root, ".overstory", "mail.db");
			const mailFile = Bun.file(mailDbPath);
			if (await mailFile.exists()) {
				mailStore = createMailStore(mailDbPath);
				const unread = mailStore.getAll({ to: agentName, unread: true });
				unreadMailCount = unread.length;
			}
		} catch {
			// mail db might not exist
		}

		let mergeQueueCount = 0;
		try {
			const queuePath = join(root, ".overstory", "merge-queue.db");
			const queue = createMergeQueue(queuePath);
			mergeQueueCount = queue.list("pending").length;
			queue.close();
		} catch {
			// queue might not exist
		}

		let recentMetricsCount = 0;
		try {
			const metricsDbPath = join(root, ".overstory", "metrics.db");
			const metricsFile = Bun.file(metricsDbPath);
			if (await metricsFile.exists()) {
				const metricsStore = createMetricsStore(metricsDbPath);
				recentMetricsCount = metricsStore.getRecentSessions(100).length;
				metricsStore.close();
			}
		} catch {
			// metrics db might not exist
		}

		let verboseDetails: Record<string, VerboseAgentDetail> | undefined;
		if (verbose && sessions.length > 0) {
			verboseDetails = {};
			for (const session of sessions) {
				const logsDir = join(root, ".overstory", "logs", session.agentName);

				let lastMailSent: string | null = null;
				let lastMailReceived: string | null = null;
				if (mailStore) {
					try {
						const sent = mailStore.getAll({ from: session.agentName });
						if (sent.length > 0 && sent[0]) {
							lastMailSent = sent[0].createdAt;
						}
						const received = mailStore.getAll({ to: session.agentName });
						if (received.length > 0 && received[0]) {
							lastMailReceived = received[0].createdAt;
						}
					} catch {
						// Best effort
					}
				}

				verboseDetails[session.agentName] = {
					worktreePath: session.worktreePath,
					logsDir,
					lastMailSent,
					lastMailReceived,
					capability: session.capability,
				};
			}
		}

		if (mailStore) {
			mailStore.close();
		}

		return {
			currentRunId: runId,
			agents: sessions,
			worktrees,
			tmuxSessions,
			unreadMailCount,
			mergeQueueCount,
			recentMetricsCount,
			verboseDetails,
		};
	} finally {
		store.close();
	}
}

/**
 * Print status in human-readable format.
 */
export function printStatus(data: StatusData): void {
	const now = Date.now();
	const w = process.stdout.write.bind(process.stdout);

	w("📊 Overstory Status\n");
	w(`${"═".repeat(60)}\n\n`);
	if (data.currentRunId) {
		w(`🏃 Run: ${data.currentRunId}\n`);
	}

	// Active agents
	const active = data.agents.filter((a) => a.state !== "zombie" && a.state !== "completed");
	w(`🤖 Agents: ${active.length} active\n`);
	if (active.length > 0) {
		const tmuxSessionNames = new Set(data.tmuxSessions.map((s) => s.name));
		for (const agent of active) {
			const endTime =
				agent.state === "completed" || agent.state === "zombie"
					? new Date(agent.lastActivity).getTime()
					: now;
			const duration = formatDuration(endTime - new Date(agent.startedAt).getTime());
			const tmuxAlive = tmuxSessionNames.has(agent.tmuxSession);
			const aliveMarker = tmuxAlive ? "●" : "○";
			w(`   ${aliveMarker} ${agent.agentName} [${agent.capability}] `);
			w(`${agent.state} | ${agent.beadId} | ${duration}\n`);

			const detail = data.verboseDetails?.[agent.agentName];
			if (detail) {
				w(`     Worktree: ${detail.worktreePath}\n`);
				w(`     Logs:     ${detail.logsDir}\n`);
				w(`     Mail sent: ${detail.lastMailSent ?? "none"}`);
				w(` | received: ${detail.lastMailReceived ?? "none"}\n`);
			}
		}
	} else {
		w("   No active agents\n");
	}
	w("\n");

	// Worktrees
	const overstoryWts = data.worktrees.filter((wt) => wt.branch.startsWith("overstory/"));
	w(`🌳 Worktrees: ${overstoryWts.length}\n`);
	for (const wt of overstoryWts) {
		w(`   ${wt.branch}\n`);
	}
	if (overstoryWts.length === 0) {
		w("   No agent worktrees\n");
	}
	w("\n");

	// Mail
	w(`📬 Mail: ${data.unreadMailCount} unread\n`);

	// Merge queue
	w(`🔀 Merge queue: ${data.mergeQueueCount} pending\n`);

	// Metrics
	w(`📈 Sessions recorded: ${data.recentMetricsCount}\n`);
}

/**
 * Entry point for `overstory status [--json] [--watch]`.
 */
const STATUS_HELP = `overstory status — Show all active agents and project state

Usage: overstory status [--json] [--verbose] [--agent <name>] [--all]

Options:
  --json             Output as JSON
  --verbose          Show extra detail per agent (worktree, logs, mail timestamps)
  --agent <name>     Show unread mail for this agent (default: orchestrator)
  --all              Show sessions from all runs (default: current run only)
  --watch            (deprecated) Use 'overstory dashboard' for live monitoring
  --interval <ms>    Poll interval for --watch in milliseconds (default: 3000)
  --help, -h         Show this help`;

export async function statusCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${STATUS_HELP}\n`);
		return;
	}

	const json = hasFlag(args, "--json");
	const watch = hasFlag(args, "--watch");
	const verbose = hasFlag(args, "--verbose");
	const all = hasFlag(args, "--all");
	const intervalStr = getFlag(args, "--interval");
	const interval = intervalStr ? Number.parseInt(intervalStr, 10) : 3000;

	if (Number.isNaN(interval) || interval < 500) {
		throw new ValidationError("--interval must be a number >= 500 (milliseconds)", {
			field: "interval",
			value: intervalStr,
		});
	}

	const agentName = getFlag(args, "--agent") ?? "orchestrator";

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const root = config.project.root;

	let runId: string | null | undefined;
	if (!all) {
		const overstoryDir = join(root, ".overstory");
		runId = await readCurrentRunId(overstoryDir);
	}

	if (watch) {
		process.stderr.write(
			"⚠️  --watch is deprecated. Use 'overstory dashboard' for live monitoring.\n\n",
		);
		// Polling loop (kept for one release cycle)
		while (true) {
			// Clear screen
			process.stdout.write("\x1b[2J\x1b[H");
			const data = await gatherStatus(root, agentName, verbose, runId);
			if (json) {
				process.stdout.write(`${JSON.stringify(data, null, "\t")}\n`);
			} else {
				printStatus(data);
			}
			await Bun.sleep(interval);
		}
	} else {
		const data = await gatherStatus(root, agentName, verbose, runId);
		if (json) {
			process.stdout.write(`${JSON.stringify(data, null, "\t")}\n`);
		} else {
			printStatus(data);
		}
	}
}
