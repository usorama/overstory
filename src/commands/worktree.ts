/**
 * CLI command: overstory worktree list | clean [--completed] [--all]
 *
 * List shows worktrees with agent status.
 * Clean removes worktree dirs, branch refs (if merged), and tmux sessions.
 * Logs are never auto-deleted.
 */

import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { createMailStore } from "../mail/store.ts";
import type { AgentSession } from "../types.ts";
import { listWorktrees, removeWorktree } from "../worktree/manager.ts";
import { isSessionAlive, killSession } from "../worktree/tmux.ts";

function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

/**
 * Load sessions.json from .overstory/sessions.json.
 */
async function loadSessions(root: string): Promise<AgentSession[]> {
	const path = join(root, ".overstory", "sessions.json");
	const file = Bun.file(path);
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
 * Save sessions back to sessions.json.
 */
async function saveSessions(root: string, sessions: AgentSession[]): Promise<void> {
	const path = join(root, ".overstory", "sessions.json");
	await Bun.write(path, `${JSON.stringify(sessions, null, "\t")}\n`);
}

/**
 * Handle `overstory worktree list`.
 */
async function handleList(root: string, json: boolean): Promise<void> {
	const worktrees = await listWorktrees(root);
	const sessions = await loadSessions(root);

	const overstoryWts = worktrees.filter((wt) => wt.branch.startsWith("overstory/"));

	if (json) {
		const entries = overstoryWts.map((wt) => {
			const session = sessions.find((s) => s.worktreePath === wt.path);
			return {
				path: wt.path,
				branch: wt.branch,
				head: wt.head,
				agentName: session?.agentName ?? null,
				state: session?.state ?? null,
				beadId: session?.beadId ?? null,
			};
		});
		process.stdout.write(`${JSON.stringify(entries, null, "\t")}\n`);
		return;
	}

	if (overstoryWts.length === 0) {
		process.stdout.write("No agent worktrees found.\n");
		return;
	}

	process.stdout.write(`🌳 Agent worktrees: ${overstoryWts.length}\n\n`);
	for (const wt of overstoryWts) {
		const session = sessions.find((s) => s.worktreePath === wt.path);
		const state = session?.state ?? "unknown";
		const agent = session?.agentName ?? "?";
		const bead = session?.beadId ?? "?";
		process.stdout.write(`  ${wt.branch}\n`);
		process.stdout.write(`    Agent: ${agent} | State: ${state} | Task: ${bead}\n`);
		process.stdout.write(`    Path: ${wt.path}\n\n`);
	}
}

/**
 * Handle `overstory worktree clean [--completed] [--all]`.
 */
async function handleClean(args: string[], root: string, json: boolean): Promise<void> {
	const all = hasFlag(args, "--all");
	const completedOnly = hasFlag(args, "--completed") || !all;

	const worktrees = await listWorktrees(root);
	const sessions = await loadSessions(root);

	const overstoryWts = worktrees.filter((wt) => wt.branch.startsWith("overstory/"));
	const cleaned: string[] = [];
	const failed: string[] = [];

	for (const wt of overstoryWts) {
		const session = sessions.find((s) => s.worktreePath === wt.path);

		// If --completed (default), only clean worktrees whose agent is done/zombie
		if (completedOnly && session && session.state !== "completed" && session.state !== "zombie") {
			continue;
		}

		// If --all, clean everything
		// Kill tmux session if still alive
		if (session?.tmuxSession) {
			const alive = await isSessionAlive(session.tmuxSession);
			if (alive) {
				try {
					await killSession(session.tmuxSession);
				} catch {
					// Best effort
				}
			}
		}

		// Remove worktree and its branch.
		// Always force worktree removal since deployed .claude/ files create untracked
		// files that cause non-forced removal to fail.
		// Always force-delete the branch since we're cleaning up finished/zombie agents
		// whose branches are typically unmerged.
		try {
			await removeWorktree(root, wt.path, { force: true, forceBranch: true });
			cleaned.push(wt.branch);

			if (!json) {
				process.stdout.write(`🗑️  Removed: ${wt.branch}\n`);
			}
		} catch (err) {
			failed.push(wt.branch);
			if (!json) {
				const msg = err instanceof Error ? err.message : String(err);
				process.stderr.write(`⚠️  Failed to remove ${wt.branch}: ${msg}\n`);
			}
		}
	}

	// Purge mail for cleaned agents
	let mailPurged = 0;
	if (cleaned.length > 0) {
		const mailDbPath = join(root, ".overstory", "mail.db");
		const mailDbFile = Bun.file(mailDbPath);
		if (await mailDbFile.exists()) {
			const mailStore = createMailStore(mailDbPath);
			try {
				for (const branch of cleaned) {
					const session = sessions.find((s) => s.branchName === branch);
					if (session) {
						mailPurged += mailStore.purge({ agent: session.agentName });
					}
				}
			} finally {
				mailStore.close();
			}
		}
	}

	// Update sessions.json — mark cleaned sessions as zombie
	const markedSessions = sessions.map((s) => {
		if (cleaned.some((branch) => s.branchName === branch)) {
			return { ...s, state: "zombie" as const };
		}
		return s;
	});

	// Prune zombie entries whose worktree paths no longer exist on disk.
	// This prevents sessions.json from growing unbounded with stale entries.
	const remainingWorktrees = await listWorktrees(root);
	const worktreePaths = new Set(remainingWorktrees.map((wt) => wt.path));
	const prunedSessions: AgentSession[] = [];
	let pruneCount = 0;

	for (const session of markedSessions) {
		if (session.state === "zombie" && !worktreePaths.has(session.worktreePath)) {
			pruneCount++;
		} else {
			prunedSessions.push(session);
		}
	}

	await saveSessions(root, prunedSessions);

	if (json) {
		process.stdout.write(
			`${JSON.stringify({ cleaned, failed, pruned: pruneCount, mailPurged })}\n`,
		);
	} else if (cleaned.length === 0 && pruneCount === 0 && failed.length === 0) {
		process.stdout.write("No worktrees to clean.\n");
	} else {
		if (cleaned.length > 0) {
			process.stdout.write(
				`\nCleaned ${cleaned.length} worktree${cleaned.length === 1 ? "" : "s"}.\n`,
			);
		}
		if (failed.length > 0) {
			process.stdout.write(
				`Failed to clean ${failed.length} worktree${failed.length === 1 ? "" : "s"}.\n`,
			);
		}
		if (mailPurged > 0) {
			process.stdout.write(
				`Purged ${mailPurged} mail message${mailPurged === 1 ? "" : "s"} from cleaned agents.\n`,
			);
		}
		if (pruneCount > 0) {
			process.stdout.write(
				`Pruned ${pruneCount} zombie session${pruneCount === 1 ? "" : "s"} from sessions.json.\n`,
			);
		}
	}
}

/**
 * Entry point for `overstory worktree <subcommand> [flags]`.
 *
 * Subcommands: list, clean.
 */
const WORKTREE_HELP = `overstory worktree — Manage agent worktrees

Usage: overstory worktree <subcommand> [flags]

Subcommands:
  list               List worktrees with agent status
  clean              Remove completed worktrees
                       [--completed]  Only finished agents (default)
                       [--all]        Force remove all

Options:
  --json             Output as JSON
  --help, -h         Show this help`;

export async function worktreeCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${WORKTREE_HELP}\n`);
		return;
	}

	const subcommand = args[0];
	const subArgs = args.slice(1);
	const jsonFlag = hasFlag(args, "--json");

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const root = config.project.root;

	switch (subcommand) {
		case "list":
			await handleList(root, jsonFlag);
			break;
		case "clean":
			await handleClean(subArgs, root, jsonFlag);
			break;
		default:
			throw new ValidationError(
				`Unknown worktree subcommand: ${subcommand ?? "(none)"}. Use: list, clean`,
				{ field: "subcommand" },
			);
	}
}
