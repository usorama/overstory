import { join } from "node:path";
import { WorktreeError } from "../errors.ts";

/**
 * Run a git command and return stdout. Throws WorktreeError on non-zero exit.
 */
async function runGit(
	repoRoot: string,
	args: string[],
	context?: { worktreePath?: string; branchName?: string },
): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	if (exitCode !== 0) {
		throw new WorktreeError(
			`git ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`,
			{
				worktreePath: context?.worktreePath,
				branchName: context?.branchName,
			},
		);
	}

	return stdout;
}

/**
 * Create a new git worktree for an agent.
 *
 * Creates a worktree at `{baseDir}/{agentName}` with a new branch
 * named `overstory/{agentName}/{beadId}` based on `baseBranch`.
 *
 * @returns The absolute worktree path and branch name.
 */
export async function createWorktree(options: {
	repoRoot: string;
	baseDir: string;
	agentName: string;
	baseBranch: string;
	beadId: string;
}): Promise<{ path: string; branch: string }> {
	const { repoRoot, baseDir, agentName, baseBranch, beadId } = options;

	const worktreePath = join(baseDir, agentName);
	const branchName = `overstory/${agentName}/${beadId}`;

	await runGit(repoRoot, ["worktree", "add", "-b", branchName, worktreePath, baseBranch], {
		worktreePath,
		branchName,
	});

	return { path: worktreePath, branch: branchName };
}

/**
 * Parsed representation of a single worktree entry from `git worktree list --porcelain`.
 */
interface WorktreeEntry {
	path: string;
	branch: string;
	head: string;
}

/**
 * Parse the output of `git worktree list --porcelain` into structured entries.
 *
 * Porcelain format example:
 * ```
 * worktree /path/to/main
 * HEAD abc123
 * branch refs/heads/main
 *
 * worktree /path/to/wt
 * HEAD def456
 * branch refs/heads/overstory/agent/bead
 * ```
 */
function parseWorktreeOutput(output: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	const blocks = output.trim().split("\n\n");

	for (const block of blocks) {
		if (block.trim() === "") continue;

		let path = "";
		let head = "";
		let branch = "";

		const lines = block.trim().split("\n");
		for (const line of lines) {
			if (line.startsWith("worktree ")) {
				path = line.slice("worktree ".length);
			} else if (line.startsWith("HEAD ")) {
				head = line.slice("HEAD ".length);
			} else if (line.startsWith("branch ")) {
				// Strip refs/heads/ prefix to get the short branch name
				const ref = line.slice("branch ".length);
				branch = ref.replace(/^refs\/heads\//, "");
			}
		}

		if (path.length > 0) {
			entries.push({ path, head, branch });
		}
	}

	return entries;
}

/**
 * List all git worktrees in the repository.
 *
 * @returns Array of worktree entries with path, branch name, and HEAD commit.
 */
export async function listWorktrees(
	repoRoot: string,
): Promise<Array<{ path: string; branch: string; head: string }>> {
	const stdout = await runGit(repoRoot, ["worktree", "list", "--porcelain"]);
	return parseWorktreeOutput(stdout);
}

/**
 * Check if a branch has been merged into a target branch.
 * Uses `git merge-base --is-ancestor` which returns exit 0 if merged, 1 if not.
 */
export async function isBranchMerged(
	repoRoot: string,
	branch: string,
	targetBranch: string,
): Promise<boolean> {
	const proc = Bun.spawn(["git", "merge-base", "--is-ancestor", branch, targetBranch], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});

	const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

	if (exitCode === 0) return true;
	if (exitCode === 1) return false;

	throw new WorktreeError(
		`git merge-base --is-ancestor failed (exit ${exitCode}): ${stderr.trim()}`,
		{ branchName: branch },
	);
}

/**
 * Remove a git worktree and delete its associated branch.
 *
 * Runs `git worktree remove {path}` to remove the worktree, then
 * deletes the branch. With `forceBranch: true`, uses `git branch -D`
 * to force-delete even unmerged branches. Otherwise uses `git branch -d`
 * which only deletes merged branches.
 */
export async function removeWorktree(
	repoRoot: string,
	path: string,
	options?: { force?: boolean; forceBranch?: boolean },
): Promise<void> {
	// First, figure out which branch this worktree is on so we can clean it up
	const worktrees = await listWorktrees(repoRoot);
	const entry = worktrees.find((wt) => wt.path === path);
	const branchName = entry?.branch ?? "";

	// Remove the worktree (--force handles untracked files and uncommitted changes)
	const removeArgs = ["worktree", "remove", path];
	if (options?.force) {
		removeArgs.push("--force");
	}
	await runGit(repoRoot, removeArgs, {
		worktreePath: path,
		branchName,
	});

	// Delete the associated branch after worktree removal.
	// Use -D (force) when forceBranch is set, since the branch may not have
	// been merged yet. Use -d (safe) otherwise, which only deletes merged branches.
	if (branchName.length > 0) {
		const deleteFlag = options?.forceBranch ? "-D" : "-d";
		try {
			await runGit(repoRoot, ["branch", deleteFlag, branchName], { branchName });
		} catch {
			// Branch deletion failed — may be unmerged (with -d) or checked out elsewhere.
			// This is best-effort; the worktree itself is already removed.
		}
	}
}
