/**
 * CLI command: overstory clean [--all] [--mail] [--sessions] [--metrics]
 *   [--logs] [--worktrees] [--branches] [--agents] [--specs]
 *
 * Nuclear cleanup of overstory runtime state.
 * --all does everything. Individual flags allow selective cleanup.
 *
 * Execution order for --all (processes → filesystem → databases):
 *   1. Kill all overstory tmux sessions
 *   2. Remove all worktrees
 *   3. Delete orphaned overstory/* branches
 *   4. Delete SQLite databases (mail.db, metrics.db)
 *   5. Reset JSON files (sessions.json, merge-queue.json)
 *   6. Clear directory contents (logs/, agents/, specs/)
 *   7. Delete nudge-state.json
 */

import { readdir, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { listWorktrees, removeWorktree } from "../worktree/manager.ts";
import { killSession, listSessions } from "../worktree/tmux.ts";

function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

interface CleanResult {
	tmuxKilled: number;
	worktreesCleaned: number;
	branchesDeleted: number;
	mailWiped: boolean;
	sessionsCleared: boolean;
	mergeQueueCleared: boolean;
	metricsWiped: boolean;
	logsCleared: boolean;
	agentsCleared: boolean;
	specsCleared: boolean;
	nudgeStateCleared: boolean;
}

/**
 * Kill all overstory-prefixed tmux sessions.
 */
async function killAllTmuxSessions(): Promise<number> {
	let killed = 0;
	try {
		const sessions = await listSessions();
		const overStorySessions = sessions.filter((s) => s.name.startsWith("overstory-"));
		for (const session of overStorySessions) {
			try {
				await killSession(session.name);
				killed++;
			} catch {
				// Best effort
			}
		}
	} catch {
		// tmux not available or no server running
	}
	return killed;
}

/**
 * Remove all overstory worktrees (force remove with branch deletion).
 */
async function cleanAllWorktrees(root: string): Promise<number> {
	let cleaned = 0;
	try {
		const worktrees = await listWorktrees(root);
		const overstoryWts = worktrees.filter((wt) => wt.branch.startsWith("overstory/"));
		for (const wt of overstoryWts) {
			try {
				await removeWorktree(root, wt.path, { force: true, forceBranch: true });
				cleaned++;
			} catch {
				// Best effort
			}
		}
	} catch {
		// No worktrees or git error
	}
	return cleaned;
}

/**
 * Delete orphaned overstory/* branch refs not tied to a worktree.
 */
async function deleteOrphanedBranches(root: string): Promise<number> {
	let deleted = 0;
	try {
		const proc = Bun.spawn(
			["git", "for-each-ref", "refs/heads/overstory/", "--format=%(refname:short)"],
			{ cwd: root, stdout: "pipe", stderr: "pipe" },
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;

		const branches = stdout
			.trim()
			.split("\n")
			.filter((b) => b.length > 0);
		for (const branch of branches) {
			try {
				const del = Bun.spawn(["git", "branch", "-D", branch], {
					cwd: root,
					stdout: "pipe",
					stderr: "pipe",
				});
				const exitCode = await del.exited;
				if (exitCode === 0) deleted++;
			} catch {
				// Best effort
			}
		}
	} catch {
		// Git error
	}
	return deleted;
}

/**
 * Delete a SQLite database file and its WAL/SHM companions.
 */
async function wipeSqliteDb(dbPath: string): Promise<boolean> {
	const extensions = ["", "-wal", "-shm"];
	let wiped = false;
	for (const ext of extensions) {
		try {
			await unlink(`${dbPath}${ext}`);
			if (ext === "") wiped = true;
		} catch {
			// File may not exist
		}
	}
	return wiped;
}

/**
 * Reset a JSON file to an empty array.
 */
async function resetJsonFile(path: string): Promise<boolean> {
	const file = Bun.file(path);
	if (await file.exists()) {
		await Bun.write(path, "[]\n");
		return true;
	}
	return false;
}

/**
 * Clear all entries inside a directory but keep the directory itself.
 */
async function clearDirectory(dirPath: string): Promise<boolean> {
	try {
		const entries = await readdir(dirPath);
		for (const entry of entries) {
			await rm(join(dirPath, entry), { recursive: true, force: true });
		}
		return entries.length > 0;
	} catch {
		// Directory may not exist
		return false;
	}
}

/**
 * Delete a single file if it exists.
 */
async function deleteFile(path: string): Promise<boolean> {
	try {
		await unlink(path);
		return true;
	} catch {
		return false;
	}
}

const CLEAN_HELP = `overstory clean — Wipe runtime state (nuclear cleanup)

Usage: overstory clean [flags]

Flags:
  --all           Wipe everything (nuclear option)
  --mail          Delete mail.db (all messages)
  --sessions      Reset sessions.json
  --metrics       Delete metrics.db
  --logs          Remove all agent logs
  --worktrees     Remove all worktrees + kill tmux sessions
  --branches      Delete all overstory/* branch refs
  --agents        Remove agent identity files
  --specs         Remove task spec files

Options:
  --json          Output as JSON
  --help, -h      Show this help

When --all is passed, ALL of the above are executed in safe order:
  1. Kill all overstory tmux sessions (processes first)
  2. Remove all worktrees
  3. Delete orphaned branch refs
  4. Wipe mail.db, metrics.db, sessions.json, merge-queue.json
  5. Clear logs, agents, specs, nudge state`;

export async function cleanCommand(args: string[]): Promise<void> {
	if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
		process.stdout.write(`${CLEAN_HELP}\n`);
		return;
	}

	const json = hasFlag(args, "--json");
	const all = hasFlag(args, "--all");

	const doWorktrees = all || hasFlag(args, "--worktrees");
	const doBranches = all || hasFlag(args, "--branches");
	const doMail = all || hasFlag(args, "--mail");
	const doSessions = all || hasFlag(args, "--sessions");
	const doMetrics = all || hasFlag(args, "--metrics");
	const doLogs = all || hasFlag(args, "--logs");
	const doAgents = all || hasFlag(args, "--agents");
	const doSpecs = all || hasFlag(args, "--specs");

	const anySelected =
		doWorktrees || doBranches || doMail || doSessions || doMetrics || doLogs || doAgents || doSpecs;

	if (!anySelected) {
		throw new ValidationError(
			"No cleanup targets specified. Use --all for full cleanup, or individual flags (--mail, --sessions, --metrics, --logs, --worktrees, --branches, --agents, --specs).",
			{ field: "flags" },
		);
	}

	const config = await loadConfig(process.cwd());
	const root = config.project.root;
	const overstoryDir = join(root, ".overstory");

	const result: CleanResult = {
		tmuxKilled: 0,
		worktreesCleaned: 0,
		branchesDeleted: 0,
		mailWiped: false,
		sessionsCleared: false,
		mergeQueueCleared: false,
		metricsWiped: false,
		logsCleared: false,
		agentsCleared: false,
		specsCleared: false,
		nudgeStateCleared: false,
	};

	// 1. Kill tmux sessions (must happen before worktree removal)
	if (doWorktrees || all) {
		result.tmuxKilled = await killAllTmuxSessions();
	}

	// 2. Remove worktrees
	if (doWorktrees) {
		result.worktreesCleaned = await cleanAllWorktrees(root);
	}

	// 3. Delete orphaned branches
	if (doBranches) {
		result.branchesDeleted = await deleteOrphanedBranches(root);
	}

	// 4. Wipe databases
	if (doMail) {
		result.mailWiped = await wipeSqliteDb(join(overstoryDir, "mail.db"));
	}
	if (doMetrics) {
		result.metricsWiped = await wipeSqliteDb(join(overstoryDir, "metrics.db"));
	}

	// 5. Reset JSON files
	if (doSessions) {
		result.sessionsCleared = await resetJsonFile(join(overstoryDir, "sessions.json"));
	}
	if (all) {
		result.mergeQueueCleared = await resetJsonFile(join(overstoryDir, "merge-queue.json"));
	}

	// 6. Clear directories
	if (doLogs) {
		result.logsCleared = await clearDirectory(join(overstoryDir, "logs"));
	}
	if (doAgents) {
		result.agentsCleared = await clearDirectory(join(overstoryDir, "agents"));
	}
	if (doSpecs) {
		result.specsCleared = await clearDirectory(join(overstoryDir, "specs"));
	}

	// 7. Delete nudge state
	if (all) {
		result.nudgeStateCleared = await deleteFile(join(overstoryDir, "nudge-state.json"));
	}

	// Output
	if (json) {
		process.stdout.write(`${JSON.stringify(result, null, "\t")}\n`);
		return;
	}

	const lines: string[] = [];
	if (result.tmuxKilled > 0) {
		lines.push(`Killed ${result.tmuxKilled} tmux session${result.tmuxKilled === 1 ? "" : "s"}`);
	}
	if (result.worktreesCleaned > 0) {
		lines.push(
			`Removed ${result.worktreesCleaned} worktree${result.worktreesCleaned === 1 ? "" : "s"}`,
		);
	}
	if (result.branchesDeleted > 0) {
		lines.push(
			`Deleted ${result.branchesDeleted} orphaned branch${result.branchesDeleted === 1 ? "" : "es"}`,
		);
	}
	if (result.mailWiped) lines.push("Wiped mail.db");
	if (result.metricsWiped) lines.push("Wiped metrics.db");
	if (result.sessionsCleared) lines.push("Reset sessions.json");
	if (result.mergeQueueCleared) lines.push("Reset merge-queue.json");
	if (result.logsCleared) lines.push("Cleared logs/");
	if (result.agentsCleared) lines.push("Cleared agents/");
	if (result.specsCleared) lines.push("Cleared specs/");
	if (result.nudgeStateCleared) lines.push("Cleared nudge-state.json");

	if (lines.length === 0) {
		process.stdout.write("Nothing to clean.\n");
	} else {
		for (const line of lines) {
			process.stdout.write(`${line}\n`);
		}
		process.stdout.write("\nClean complete.\n");
	}
}
