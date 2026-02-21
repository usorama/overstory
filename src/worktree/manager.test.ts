import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeError } from "../errors.ts";
import {
	cleanupTempDir,
	commitFile,
	createTempGitRepo,
	getDefaultBranch,
} from "../test-helpers.ts";
import { createWorktree, isBranchMerged, listWorktrees, removeWorktree } from "./manager.ts";

/**
 * Run a git command in a directory and return stdout. Throws on non-zero exit.
 */
async function git(cwd: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	if (exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`);
	}

	return stdout;
}

describe("createWorktree", () => {
	let repoDir: string;
	let worktreesDir: string;
	let defaultBranch: string;

	beforeEach(async () => {
		// realpathSync resolves macOS /var -> /private/var symlink so paths match git output
		repoDir = realpathSync(await createTempGitRepo());
		defaultBranch = await getDefaultBranch(repoDir);
		worktreesDir = join(repoDir, ".overstory", "worktrees");
		await mkdir(worktreesDir, { recursive: true });
	});

	afterEach(async () => {
		await cleanupTempDir(repoDir);
	});

	test("returns correct path and branch name", async () => {
		const result = await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "auth-login",
			baseBranch: defaultBranch,
			beadId: "bead-abc123",
		});

		expect(result.path).toBe(join(worktreesDir, "auth-login"));
		expect(result.branch).toBe("overstory/auth-login/bead-abc123");
	});

	test("creates worktree directory on disk", async () => {
		const result = await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "auth-login",
			baseBranch: defaultBranch,
			beadId: "bead-abc123",
		});

		expect(existsSync(result.path)).toBe(true);
		// The worktree should contain a .git file (not a directory, since it's a linked worktree)
		expect(existsSync(join(result.path, ".git"))).toBe(true);
	});

	test("creates the branch in the repo", async () => {
		await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "auth-login",
			baseBranch: defaultBranch,
			beadId: "bead-abc123",
		});

		const branchList = await git(repoDir, ["branch", "--list"]);
		expect(branchList).toContain("overstory/auth-login/bead-abc123");
	});

	test("throws WorktreeError when creating same worktree twice", async () => {
		await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "auth-login",
			baseBranch: defaultBranch,
			beadId: "bead-abc123",
		});

		await expect(
			createWorktree({
				repoRoot: repoDir,
				baseDir: worktreesDir,
				agentName: "auth-login",
				baseBranch: defaultBranch,
				beadId: "bead-abc123",
			}),
		).rejects.toThrow(WorktreeError);
	});

	test("WorktreeError includes worktree path and branch name", async () => {
		// Create once to occupy the branch name
		await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "auth-login",
			baseBranch: defaultBranch,
			beadId: "bead-abc123",
		});

		try {
			await createWorktree({
				repoRoot: repoDir,
				baseDir: worktreesDir,
				agentName: "auth-login",
				baseBranch: defaultBranch,
				beadId: "bead-abc123",
			});
			// Should not reach here
			expect(true).toBe(false);
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(WorktreeError);
			const wtErr = err as WorktreeError;
			expect(wtErr.worktreePath).toBe(join(worktreesDir, "auth-login"));
			expect(wtErr.branchName).toBe("overstory/auth-login/bead-abc123");
		}
	});
});

describe("listWorktrees", () => {
	let repoDir: string;
	let worktreesDir: string;
	let defaultBranch: string;

	beforeEach(async () => {
		repoDir = realpathSync(await createTempGitRepo());
		defaultBranch = await getDefaultBranch(repoDir);
		worktreesDir = join(repoDir, ".overstory", "worktrees");
		await mkdir(worktreesDir, { recursive: true });
	});

	afterEach(async () => {
		await cleanupTempDir(repoDir);
	});

	test("lists main worktree when no additional worktrees exist", async () => {
		const entries = await listWorktrees(repoDir);

		expect(entries.length).toBeGreaterThanOrEqual(1);
		// The first entry should be the main repo
		const mainEntry = entries[0];
		expect(mainEntry?.path).toBe(repoDir);
		expect(mainEntry?.branch).toMatch(/^(main|master)$/);
		expect(mainEntry?.head).toMatch(/^[a-f0-9]{40}$/);
	});

	test("lists multiple worktrees after creation", async () => {
		await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "auth-login",
			baseBranch: defaultBranch,
			beadId: "bead-abc",
		});

		await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "data-sync",
			baseBranch: defaultBranch,
			beadId: "bead-xyz",
		});

		const entries = await listWorktrees(repoDir);

		// Main worktree + 2 created = 3
		expect(entries).toHaveLength(3);

		const paths = entries.map((e) => e.path);
		expect(paths).toContain(repoDir);
		expect(paths).toContain(join(worktreesDir, "auth-login"));
		expect(paths).toContain(join(worktreesDir, "data-sync"));

		const branches = entries.map((e) => e.branch);
		expect(branches).toContain("overstory/auth-login/bead-abc");
		expect(branches).toContain("overstory/data-sync/bead-xyz");
	});

	test("strips refs/heads/ prefix from branch names", async () => {
		await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "feature-worker",
			baseBranch: defaultBranch,
			beadId: "bead-123",
		});

		const entries = await listWorktrees(repoDir);
		const worktreeEntry = entries.find((e) => e.path === join(worktreesDir, "feature-worker"));

		expect(worktreeEntry?.branch).toBe("overstory/feature-worker/bead-123");
		// Ensure no refs/heads/ prefix leaked through
		expect(worktreeEntry?.branch).not.toContain("refs/heads/");
	});

	test("each entry has a valid HEAD commit hash", async () => {
		await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "auth-login",
			baseBranch: defaultBranch,
			beadId: "bead-abc",
		});

		const entries = await listWorktrees(repoDir);

		for (const entry of entries) {
			expect(entry.head).toMatch(/^[a-f0-9]{40}$/);
		}
	});

	test("throws WorktreeError for non-git directory", async () => {
		// Use a separate temp dir outside the git repo so git won't find a parent .git
		const tmpDir = realpathSync(await mkdtemp(join(tmpdir(), "overstory-notgit-")));
		try {
			await expect(listWorktrees(tmpDir)).rejects.toThrow(WorktreeError);
		} finally {
			await cleanupTempDir(tmpDir);
		}
	});
});

describe("isBranchMerged", () => {
	let repoDir: string;
	let worktreesDir: string;
	let defaultBranch: string;

	beforeEach(async () => {
		repoDir = realpathSync(await createTempGitRepo());
		defaultBranch = await getDefaultBranch(repoDir);
		worktreesDir = join(repoDir, ".overstory", "worktrees");
		await mkdir(worktreesDir, { recursive: true });
	});

	afterEach(async () => {
		await cleanupTempDir(repoDir);
	});

	test("returns true for a branch that has been merged via git merge", async () => {
		const { path: wtPath, branch } = await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "feature-agent",
			baseBranch: defaultBranch,
			beadId: "bead-merged",
		});

		// Add a commit to the feature branch
		await commitFile(wtPath, "feature.ts", "export const x = 1;", "add feature");

		// Merge the feature branch into defaultBranch
		await git(repoDir, ["merge", "--no-ff", branch, "-m", "merge feature"]);

		const merged = await isBranchMerged(repoDir, branch, defaultBranch);
		expect(merged).toBe(true);
	});

	test("returns false for a branch with unmerged commits", async () => {
		const { path: wtPath, branch } = await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "feature-agent",
			baseBranch: defaultBranch,
			beadId: "bead-unmerged",
		});

		// Add a commit to the feature branch (not merged)
		await commitFile(wtPath, "feature.ts", "export const x = 1;", "add feature");

		const merged = await isBranchMerged(repoDir, branch, defaultBranch);
		expect(merged).toBe(false);
	});

	test("returns true for an identical branch (same commit, no additional commits)", async () => {
		// A freshly created worktree branch has the same HEAD as the base branch
		const { branch } = await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "feature-agent",
			baseBranch: defaultBranch,
			beadId: "bead-same",
		});

		// The branch was created from defaultBranch with no additional commits,
		// so its tip is an ancestor of (equal to) defaultBranch
		const merged = await isBranchMerged(repoDir, branch, defaultBranch);
		expect(merged).toBe(true);
	});
});

describe("removeWorktree", () => {
	let repoDir: string;
	let worktreesDir: string;
	let defaultBranch: string;

	beforeEach(async () => {
		repoDir = realpathSync(await createTempGitRepo());
		defaultBranch = await getDefaultBranch(repoDir);
		worktreesDir = join(repoDir, ".overstory", "worktrees");
		await mkdir(worktreesDir, { recursive: true });
	});

	afterEach(async () => {
		await cleanupTempDir(repoDir);
	});

	test("removes worktree directory from disk", async () => {
		const { path: wtPath } = await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "auth-login",
			baseBranch: defaultBranch,
			beadId: "bead-abc",
		});

		expect(existsSync(wtPath)).toBe(true);

		await removeWorktree(repoDir, wtPath);

		expect(existsSync(wtPath)).toBe(false);
	});

	test("deletes the associated branch after removal", async () => {
		const { path: wtPath } = await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "auth-login",
			baseBranch: defaultBranch,
			beadId: "bead-abc",
		});

		await removeWorktree(repoDir, wtPath);

		const branchList = await git(repoDir, ["branch", "--list"]);
		expect(branchList).not.toContain("overstory/auth-login/bead-abc");
	});

	test("worktree no longer appears in listWorktrees after removal", async () => {
		const { path: wtPath } = await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "auth-login",
			baseBranch: defaultBranch,
			beadId: "bead-abc",
		});

		await removeWorktree(repoDir, wtPath);

		const entries = await listWorktrees(repoDir);
		const paths = entries.map((e) => e.path);
		expect(paths).not.toContain(wtPath);
	});

	test("force flag removes worktree with uncommitted changes", async () => {
		const { path: wtPath } = await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "auth-login",
			baseBranch: defaultBranch,
			beadId: "bead-abc",
		});

		// Create an untracked file in the worktree
		await Bun.write(join(wtPath, "untracked.txt"), "some content");

		// Without force, git worktree remove may fail on dirty worktrees.
		// With force, it should succeed.
		await removeWorktree(repoDir, wtPath, { force: true, forceBranch: true });

		expect(existsSync(wtPath)).toBe(false);
	});

	test("forceBranch deletes unmerged branch", async () => {
		const { path: wtPath } = await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "auth-login",
			baseBranch: defaultBranch,
			beadId: "bead-abc",
		});

		// Add a commit in the worktree so the branch diverges (making it "unmerged")
		await commitFile(wtPath, "new-file.ts", "export const x = 1;", "add new file");

		// forceBranch uses -D instead of -d, so even unmerged branches get deleted
		await removeWorktree(repoDir, wtPath, { force: true, forceBranch: true });

		const branchList = await git(repoDir, ["branch", "--list"]);
		expect(branchList).not.toContain("overstory/auth-login/bead-abc");
	});

	test("without forceBranch, unmerged branch deletion is silently ignored", async () => {
		const { path: wtPath } = await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "auth-login",
			baseBranch: defaultBranch,
			beadId: "bead-abc",
		});

		// Add a commit to make the branch unmerged
		await commitFile(wtPath, "new-file.ts", "export const x = 1;", "add new file");

		// Without forceBranch, branch -d will fail because it's not merged, but
		// removeWorktree should not throw (it catches the error)
		await removeWorktree(repoDir, wtPath, { force: true });

		// Worktree is gone
		expect(existsSync(wtPath)).toBe(false);

		// But branch still exists because -d failed silently
		const branchList = await git(repoDir, ["branch", "--list"]);
		expect(branchList).toContain("overstory/auth-login/bead-abc");
	});
});
