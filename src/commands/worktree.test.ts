import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createSessionStore } from "../sessions/store.ts";
import { cleanupTempDir, commitFile, createTempGitRepo, runGitInDir } from "../test-helpers.ts";
import type { AgentSession } from "../types.ts";
import { createWorktree } from "../worktree/manager.ts";
import { worktreeCommand } from "./worktree.ts";

/**
 * Tests for `overstory worktree` command.
 *
 * Uses real git worktrees in temp repos to test list and clean subcommands.
 * Captures process.stdout.write to verify output formatting.
 */

describe("worktreeCommand", () => {
	let chunks: string[];
	let originalWrite: typeof process.stdout.write;
	let tempDir: string;
	let originalCwd: string;

	beforeEach(async () => {
		// Spy on stdout
		chunks = [];
		originalWrite = process.stdout.write;
		process.stdout.write = ((chunk: string) => {
			chunks.push(chunk);
			return true;
		}) as typeof process.stdout.write;

		// Create temp git repo with .overstory/config.yaml structure
		tempDir = await createTempGitRepo();
		// Normalize tempDir to resolve macOS /var -> /private/var symlink
		tempDir = realpathSync(tempDir);
		const overstoryDir = join(tempDir, ".overstory");
		await mkdir(overstoryDir, { recursive: true });
		await Bun.write(
			join(overstoryDir, "config.yaml"),
			`project:\n  name: test\n  root: ${tempDir}\n  canonicalBranch: main\n`,
		);

		// Change to temp dir so loadConfig() works
		originalCwd = process.cwd();
		process.chdir(tempDir);
	});

	afterEach(async () => {
		process.stdout.write = originalWrite;
		process.chdir(originalCwd);
		await cleanupTempDir(tempDir);
	});

	function output(): string {
		return chunks.join("");
	}

	/**
	 * Helper to create an AgentSession with sensible defaults.
	 * Uses FAKE tmux session names to avoid real tmux calls during tests.
	 */
	function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
		return {
			id: "session-test",
			agentName: "test-agent",
			capability: "builder",
			worktreePath: join(tempDir, ".overstory", "worktrees", "test-agent"),
			branchName: "overstory/test-agent/task-1",
			beadId: "task-1",
			tmuxSession: "overstory-test-agent-fake", // FAKE tmux session name
			state: "working",
			pid: 12345,
			parentAgent: null,
			depth: 0,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
			...overrides,
		};
	}

	/**
	 * Helper to write sessions to SessionStore (sessions.db) in the temp repo.
	 */
	function writeSessionsToStore(sessions: AgentSession[]): void {
		const dbPath = join(tempDir, ".overstory", "sessions.db");
		const store = createSessionStore(dbPath);
		for (const session of sessions) {
			store.upsert(session);
		}
		store.close();
	}

	describe("help flags", () => {
		test("--help shows help text", async () => {
			await worktreeCommand(["--help"]);
			const out = output();

			expect(out).toContain("overstory worktree");
			expect(out).toContain("list");
			expect(out).toContain("clean");
			expect(out).toContain("--json");
		});

		test("-h shows help text", async () => {
			await worktreeCommand(["-h"]);
			const out = output();

			expect(out).toContain("overstory worktree");
			expect(out).toContain("list");
		});
	});

	describe("validation", () => {
		test("unknown subcommand throws ValidationError", async () => {
			await expect(worktreeCommand(["unknown"])).rejects.toThrow(
				"Unknown worktree subcommand: unknown",
			);
		});

		test("missing subcommand throws ValidationError with (none)", async () => {
			await expect(worktreeCommand([])).rejects.toThrow("Unknown worktree subcommand: (none)");
		});
	});

	describe("worktree list", () => {
		test("no overstory worktrees returns empty message", async () => {
			await worktreeCommand(["list"]);
			const out = output();

			expect(out).toBe("No agent worktrees found.\n");
		});

		test("with overstory worktrees lists them with agent info", async () => {
			// Create a real git worktree with overstory/ prefix branch
			const worktreesDir = join(tempDir, ".overstory", "worktrees");
			await mkdir(worktreesDir, { recursive: true });

			const worktreePath = join(worktreesDir, "test-agent");
			await runGitInDir(tempDir, [
				"worktree",
				"add",
				worktreePath,
				"-b",
				"overstory/test-agent/task-1",
			]);

			// Write sessions.db to associate worktree with agent
			writeSessionsToStore([
				{
					id: "session-1",
					agentName: "test-agent",
					capability: "builder",
					worktreePath,
					branchName: "overstory/test-agent/task-1",
					beadId: "task-1",
					tmuxSession: "overstory-test-agent",
					state: "working",
					pid: 12345,
					parentAgent: null,
					depth: 0,
					runId: null,
					startedAt: new Date().toISOString(),
					lastActivity: new Date().toISOString(),
					escalationLevel: 0,
					stalledSince: null,
				},
			]);

			await worktreeCommand(["list"]);
			const out = output();

			expect(out).toContain("🌳 Agent worktrees: 1");
			expect(out).toContain("overstory/test-agent/task-1");
			expect(out).toContain("Agent: test-agent");
			expect(out).toContain("State: working");
			expect(out).toContain("Task: task-1");
			expect(out).toContain(`Path: ${worktreePath}`);
		});

		test("--json flag outputs valid JSON array", async () => {
			// Create a real git worktree
			const worktreesDir = join(tempDir, ".overstory", "worktrees");
			await mkdir(worktreesDir, { recursive: true });

			const worktreePath = join(worktreesDir, "test-agent");
			await runGitInDir(tempDir, [
				"worktree",
				"add",
				worktreePath,
				"-b",
				"overstory/test-agent/task-1",
			]);

			// Write sessions.db
			writeSessionsToStore([
				{
					id: "session-1",
					agentName: "test-agent",
					capability: "builder",
					worktreePath,
					branchName: "overstory/test-agent/task-1",
					beadId: "task-1",
					tmuxSession: "overstory-test-agent",
					state: "working",
					pid: 12345,
					parentAgent: null,
					depth: 0,
					runId: null,
					startedAt: new Date().toISOString(),
					lastActivity: new Date().toISOString(),
					escalationLevel: 0,
					stalledSince: null,
				},
			]);

			await worktreeCommand(["list", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as Array<{
				path: string;
				branch: string;
				head: string;
				agentName: string | null;
				state: string | null;
				beadId: string | null;
			}>;

			expect(parsed).toHaveLength(1);
			expect(parsed[0]?.path).toBe(worktreePath);
			expect(parsed[0]?.branch).toBe("overstory/test-agent/task-1");
			expect(parsed[0]?.agentName).toBe("test-agent");
			expect(parsed[0]?.state).toBe("working");
			expect(parsed[0]?.beadId).toBe("task-1");
		});

		test("worktrees without sessions show unknown state", async () => {
			// Create a worktree but no sessions.db entry
			const worktreesDir = join(tempDir, ".overstory", "worktrees");
			await mkdir(worktreesDir, { recursive: true });

			const worktreePath = join(worktreesDir, "orphan-agent");
			await runGitInDir(tempDir, [
				"worktree",
				"add",
				worktreePath,
				"-b",
				"overstory/orphan-agent/task-2",
			]);

			await worktreeCommand(["list"]);
			const out = output();

			expect(out).toContain("overstory/orphan-agent/task-2");
			expect(out).toContain("Agent: ?");
			expect(out).toContain("State: unknown");
			expect(out).toContain("Task: ?");
		});
	});

	describe("worktree clean", () => {
		test("no overstory worktrees returns empty message", async () => {
			await worktreeCommand(["clean"]);
			const out = output();

			expect(out).toBe("No worktrees to clean.\n");
		});

		test("with completed agent worktree removes it and reports count", async () => {
			// Create a real git worktree
			const worktreesDir = join(tempDir, ".overstory", "worktrees");
			await mkdir(worktreesDir, { recursive: true });

			const worktreePath = join(worktreesDir, "completed-agent");
			await runGitInDir(tempDir, [
				"worktree",
				"add",
				worktreePath,
				"-b",
				"overstory/completed-agent/task-done",
			]);

			// Write sessions.db with completed state
			writeSessionsToStore([
				{
					id: "session-1",
					agentName: "completed-agent",
					capability: "builder",
					worktreePath,
					branchName: "overstory/completed-agent/task-done",
					beadId: "task-done",
					tmuxSession: "overstory-completed-agent",
					state: "completed",
					pid: 12345,
					parentAgent: null,
					depth: 0,
					runId: null,
					startedAt: new Date().toISOString(),
					lastActivity: new Date().toISOString(),
					escalationLevel: 0,
					stalledSince: null,
				},
			]);

			await worktreeCommand(["clean"]);
			const out = output();

			expect(out).toContain("🗑️  Removed: overstory/completed-agent/task-done");
			expect(out).toContain("Cleaned 1 worktree");

			// Verify the worktree directory is gone
			const worktreeExists = await Bun.file(worktreePath).exists();
			expect(worktreeExists).toBe(false);

			// Verify the branch is deleted
			const branchListProc = Bun.spawn(["git", "branch", "--list", "overstory/completed-agent/*"], {
				cwd: tempDir,
				stdout: "pipe",
			});
			const branchList = await new Response(branchListProc.stdout).text();
			expect(branchList.trim()).toBe("");
		});

		test("--json flag returns JSON with cleaned/failed/pruned arrays", async () => {
			// Create a completed worktree
			const worktreesDir = join(tempDir, ".overstory", "worktrees");
			await mkdir(worktreesDir, { recursive: true });

			const worktreePath = join(worktreesDir, "done-agent");
			await runGitInDir(tempDir, [
				"worktree",
				"add",
				worktreePath,
				"-b",
				"overstory/done-agent/task-x",
			]);

			writeSessionsToStore([
				{
					id: "session-1",
					agentName: "done-agent",
					capability: "builder",
					worktreePath,
					branchName: "overstory/done-agent/task-x",
					beadId: "task-x",
					tmuxSession: "overstory-done-agent",
					state: "completed",
					pid: 12345,
					parentAgent: null,
					depth: 0,
					runId: null,
					startedAt: new Date().toISOString(),
					lastActivity: new Date().toISOString(),
					escalationLevel: 0,
					stalledSince: null,
				},
			]);

			await worktreeCommand(["clean", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as {
				cleaned: string[];
				failed: string[];
				pruned: number;
			};

			expect(parsed.cleaned).toEqual(["overstory/done-agent/task-x"]);
			expect(parsed.failed).toEqual([]);
			expect(parsed.pruned).toBe(1); // The zombie session was pruned
		});

		test("zombie sessions whose worktree paths no longer exist get pruned from sessions.db", async () => {
			// Create sessions.db with a zombie entry whose worktree doesn't exist
			const nonExistentPath = join(tempDir, ".overstory", "worktrees", "ghost-agent");
			writeSessionsToStore([
				{
					id: "session-ghost",
					agentName: "ghost-agent",
					capability: "builder",
					worktreePath: nonExistentPath,
					branchName: "overstory/ghost-agent/task-ghost",
					beadId: "task-ghost",
					tmuxSession: "overstory-ghost-agent",
					state: "zombie",
					pid: null,
					parentAgent: null,
					depth: 0,
					runId: null,
					startedAt: new Date().toISOString(),
					lastActivity: new Date().toISOString(),
					escalationLevel: 0,
					stalledSince: null,
				},
			]);

			await worktreeCommand(["clean", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as {
				cleaned: string[];
				failed: string[];
				pruned: number;
			};

			expect(parsed.pruned).toBe(1);

			// Verify sessions.db no longer contains the zombie
			const dbPath = join(tempDir, ".overstory", "sessions.db");
			const store = createSessionStore(dbPath);
			const updatedSessions = store.getAll();
			store.close();
			expect(updatedSessions).toHaveLength(0);
		});

		test("stalled agents are cleaned like working agents (not by default)", async () => {
			// Create a worktree with stalled state
			const worktreesDir = join(tempDir, ".overstory", "worktrees");
			await mkdir(worktreesDir, { recursive: true });

			const worktreePath = join(worktreesDir, "stalled-agent");
			await runGitInDir(tempDir, [
				"worktree",
				"add",
				worktreePath,
				"-b",
				"overstory/stalled-agent/task-stuck",
			]);

			writeSessionsToStore([
				{
					id: "session-1",
					agentName: "stalled-agent",
					capability: "builder",
					worktreePath,
					branchName: "overstory/stalled-agent/task-stuck",
					beadId: "task-stuck",
					tmuxSession: "overstory-stalled-agent",
					state: "stalled",
					pid: 12345,
					parentAgent: null,
					depth: 0,
					runId: null,
					startedAt: new Date().toISOString(),
					lastActivity: new Date().toISOString(),
					escalationLevel: 0,
					stalledSince: new Date().toISOString(),
				},
			]);

			await worktreeCommand(["clean"]);
			const out = output();

			// Stalled agents should not be cleaned by default (only completed/zombie are cleaned)
			expect(out).toBe("No worktrees to clean.\n");
		});

		test("--completed flag only cleans completed agents", async () => {
			// Create two worktrees using createWorktree
			const worktreesDir = join(tempDir, ".overstory", "worktrees");
			await mkdir(worktreesDir, { recursive: true });

			const { path: completedPath } = await createWorktree({
				repoRoot: tempDir,
				baseDir: worktreesDir,
				agentName: "completed-agent",
				baseBranch: "main",
				beadId: "task-done",
			});

			const { path: workingPath } = await createWorktree({
				repoRoot: tempDir,
				baseDir: worktreesDir,
				agentName: "working-agent",
				baseBranch: "main",
				beadId: "task-wip",
			});

			// Write sessions.db with both agents
			writeSessionsToStore([
				makeSession({
					id: "session-1",
					agentName: "completed-agent",
					worktreePath: completedPath,
					branchName: "overstory/completed-agent/task-done",
					beadId: "task-done",
					tmuxSession: "overstory-completed-agent-fake",
					state: "completed",
				}),
				makeSession({
					id: "session-2",
					agentName: "working-agent",
					worktreePath: workingPath,
					branchName: "overstory/working-agent/task-wip",
					beadId: "task-wip",
					tmuxSession: "overstory-working-agent-fake",
					state: "working",
					pid: 12346,
				}),
			]);

			await worktreeCommand(["clean", "--completed"]);
			const out = output();

			expect(out).toContain("Cleaned 1 worktree");

			// Verify only the completed worktree is removed
			expect(existsSync(completedPath)).toBe(false);
			expect(existsSync(workingPath)).toBe(true);
		});

		test("--all flag cleans all worktrees regardless of state", async () => {
			// Create three worktrees with different states
			const worktreesDir = join(tempDir, ".overstory", "worktrees");
			await mkdir(worktreesDir, { recursive: true });

			const { path: completedPath } = await createWorktree({
				repoRoot: tempDir,
				baseDir: worktreesDir,
				agentName: "completed-agent",
				baseBranch: "main",
				beadId: "task-done",
			});

			const { path: workingPath } = await createWorktree({
				repoRoot: tempDir,
				baseDir: worktreesDir,
				agentName: "working-agent",
				baseBranch: "main",
				beadId: "task-wip",
			});

			const { path: stalledPath } = await createWorktree({
				repoRoot: tempDir,
				baseDir: worktreesDir,
				agentName: "stalled-agent",
				baseBranch: "main",
				beadId: "task-stuck",
			});

			// Write sessions with different states
			writeSessionsToStore([
				makeSession({
					id: "session-1",
					agentName: "completed-agent",
					worktreePath: completedPath,
					branchName: "overstory/completed-agent/task-done",
					beadId: "task-done",
					state: "completed",
				}),
				makeSession({
					id: "session-2",
					agentName: "working-agent",
					worktreePath: workingPath,
					branchName: "overstory/working-agent/task-wip",
					beadId: "task-wip",
					state: "working",
				}),
				makeSession({
					id: "session-3",
					agentName: "stalled-agent",
					worktreePath: stalledPath,
					branchName: "overstory/stalled-agent/task-stuck",
					beadId: "task-stuck",
					state: "stalled",
				}),
			]);

			await worktreeCommand(["clean", "--all"]);
			const out = output();

			expect(out).toContain("Cleaned 3 worktrees");

			// Verify all worktrees are removed
			expect(existsSync(completedPath)).toBe(false);
			expect(existsSync(workingPath)).toBe(false);
			expect(existsSync(stalledPath)).toBe(false);
		});

		test("multiple completed worktrees reports correct count", async () => {
			// Create two completed worktrees
			const worktreesDir = join(tempDir, ".overstory", "worktrees");
			await mkdir(worktreesDir, { recursive: true });

			const path1 = join(worktreesDir, "agent-1");
			await runGitInDir(tempDir, ["worktree", "add", path1, "-b", "overstory/agent-1/task-1"]);

			const path2 = join(worktreesDir, "agent-2");
			await runGitInDir(tempDir, ["worktree", "add", path2, "-b", "overstory/agent-2/task-2"]);

			writeSessionsToStore([
				{
					id: "session-1",
					agentName: "agent-1",
					capability: "builder",
					worktreePath: path1,
					branchName: "overstory/agent-1/task-1",
					beadId: "task-1",
					tmuxSession: "overstory-agent-1",
					state: "completed",
					pid: 12345,
					parentAgent: null,
					depth: 0,
					runId: null,
					startedAt: new Date().toISOString(),
					lastActivity: new Date().toISOString(),
					escalationLevel: 0,
					stalledSince: null,
				},
				{
					id: "session-2",
					agentName: "agent-2",
					capability: "builder",
					worktreePath: path2,
					branchName: "overstory/agent-2/task-2",
					beadId: "task-2",
					tmuxSession: "overstory-agent-2",
					state: "completed",
					pid: 12346,
					parentAgent: null,
					depth: 0,
					runId: null,
					startedAt: new Date().toISOString(),
					lastActivity: new Date().toISOString(),
					escalationLevel: 0,
					stalledSince: null,
				},
			]);

			await worktreeCommand(["clean"]);
			const out = output();

			expect(out).toContain("Cleaned 2 worktrees");
		});

		test("without --force, skips worktrees with unmerged branches and prints warning", async () => {
			const worktreesDir = join(tempDir, ".overstory", "worktrees");
			await mkdir(worktreesDir, { recursive: true });

			const { path: wtPath } = await createWorktree({
				repoRoot: tempDir,
				baseDir: worktreesDir,
				agentName: "unmerged-agent",
				baseBranch: "main",
				beadId: "task-unmerged",
			});

			// Add an unmerged commit
			await commitFile(wtPath, "work.ts", "export const y = 2;", "unmerged work");

			writeSessionsToStore([
				makeSession({
					id: "session-u",
					agentName: "unmerged-agent",
					worktreePath: wtPath,
					branchName: "overstory/unmerged-agent/task-unmerged",
					beadId: "task-unmerged",
					state: "completed",
				}),
			]);

			await worktreeCommand(["clean"]);
			const out = output();

			// Worktree should NOT have been removed
			expect(existsSync(wtPath)).toBe(true);
			// Warning should be printed
			expect(out).toContain("Skipped 1 worktree");
			expect(out).toContain("overstory/unmerged-agent/task-unmerged");
			expect(out).toContain("--force");
		});

		test("with --force, deletes worktrees with unmerged branches", async () => {
			const worktreesDir = join(tempDir, ".overstory", "worktrees");
			await mkdir(worktreesDir, { recursive: true });

			const { path: wtPath } = await createWorktree({
				repoRoot: tempDir,
				baseDir: worktreesDir,
				agentName: "unmerged-agent",
				baseBranch: "main",
				beadId: "task-force",
			});

			// Add an unmerged commit
			await commitFile(wtPath, "work.ts", "export const y = 2;", "unmerged work");

			writeSessionsToStore([
				makeSession({
					id: "session-f",
					agentName: "unmerged-agent",
					worktreePath: wtPath,
					branchName: "overstory/unmerged-agent/task-force",
					beadId: "task-force",
					state: "completed",
				}),
			]);

			await worktreeCommand(["clean", "--force"]);
			const out = output();

			// Worktree should be removed
			expect(existsSync(wtPath)).toBe(false);
			expect(out).toContain("🗑️  Removed: overstory/unmerged-agent/task-force");
		});

		test("without --force, removes worktrees whose branches ARE merged", async () => {
			const worktreesDir = join(tempDir, ".overstory", "worktrees");
			await mkdir(worktreesDir, { recursive: true });

			const { path: wtPath, branch } = await createWorktree({
				repoRoot: tempDir,
				baseDir: worktreesDir,
				agentName: "merged-agent",
				baseBranch: "main",
				beadId: "task-merged",
			});

			// Add a commit and merge it into main
			await commitFile(wtPath, "work.ts", "export const z = 3;", "work to merge");
			await runGitInDir(tempDir, ["merge", "--no-ff", branch, "-m", "merge feature"]);

			writeSessionsToStore([
				makeSession({
					id: "session-m",
					agentName: "merged-agent",
					worktreePath: wtPath,
					branchName: branch,
					beadId: "task-merged",
					state: "completed",
				}),
			]);

			await worktreeCommand(["clean"]);
			const out = output();

			// Merged worktree should be cleaned
			expect(existsSync(wtPath)).toBe(false);
			expect(out).toContain("Cleaned 1 worktree");
		});

		test("--json output includes skipped array for unmerged branches", async () => {
			const worktreesDir = join(tempDir, ".overstory", "worktrees");
			await mkdir(worktreesDir, { recursive: true });

			const { path: wtPath } = await createWorktree({
				repoRoot: tempDir,
				baseDir: worktreesDir,
				agentName: "unmerged-json-agent",
				baseBranch: "main",
				beadId: "task-json",
			});

			// Add an unmerged commit
			await commitFile(wtPath, "work.ts", "export const w = 4;", "unmerged work");

			writeSessionsToStore([
				makeSession({
					id: "session-j",
					agentName: "unmerged-json-agent",
					worktreePath: wtPath,
					branchName: "overstory/unmerged-json-agent/task-json",
					beadId: "task-json",
					state: "completed",
				}),
			]);

			await worktreeCommand(["clean", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as {
				cleaned: string[];
				failed: string[];
				skipped: string[];
				pruned: number;
				mailPurged: number;
			};

			expect(parsed.cleaned).toEqual([]);
			expect(parsed.skipped).toEqual(["overstory/unmerged-json-agent/task-json"]);
		});
	});
});
