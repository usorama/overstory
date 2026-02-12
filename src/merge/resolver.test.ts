import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	spyOn,
	test,
} from "bun:test";
import { join } from "node:path";
import { MergeError } from "../errors.ts";
import { cleanupTempDir, commitFile, createTempGitRepo, runGitInDir } from "../test-helpers.ts";
import type { MergeEntry } from "../types.ts";
import { createMergeResolver, looksLikeProse } from "./resolver.ts";

/**
 * Helper to create a mock Bun.spawn return value for claude CLI mocking.
 *
 * The resolver reads stdout/stderr via `new Response(proc.stdout).text()`
 * and `new Response(proc.stderr).text()`, so we need ReadableStreams.
 */
function mockSpawnResult(
	stdout: string,
	stderr: string,
	exitCode: number,
): {
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	pid: number;
} {
	return {
		stdout: new Response(stdout).body as ReadableStream<Uint8Array>,
		stderr: new Response(stderr).body as ReadableStream<Uint8Array>,
		exited: Promise.resolve(exitCode),
		pid: 12345,
	};
}

function makeTestEntry(overrides?: Partial<MergeEntry>): MergeEntry {
	return {
		branchName: overrides?.branchName ?? "feature-branch",
		beadId: overrides?.beadId ?? "bead-123",
		agentName: overrides?.agentName ?? "test-agent",
		filesModified: overrides?.filesModified ?? ["src/test.ts"],
		enqueuedAt: overrides?.enqueuedAt ?? new Date().toISOString(),
		status: overrides?.status ?? "pending",
		resolvedTier: overrides?.resolvedTier ?? null,
	};
}

/**
 * Set up a clean merge scenario: feature branch adds a new file with no conflict.
 */
async function setupCleanMerge(dir: string): Promise<void> {
	await commitFile(dir, "src/main-file.ts", "main content\n");
	await runGitInDir(dir, ["checkout", "-b", "feature-branch"]);
	await commitFile(dir, "src/feature-file.ts", "feature content\n");
	await runGitInDir(dir, ["checkout", "main"]);
}

/**
 * Set up a real content conflict: create a file, branch, modify on both
 * branches. Both sides must diverge from the common ancestor to produce
 * conflict markers.
 */
async function setupContentConflict(dir: string): Promise<void> {
	await commitFile(dir, "src/test.ts", "original content\n");
	await runGitInDir(dir, ["checkout", "-b", "feature-branch"]);
	await commitFile(dir, "src/test.ts", "feature content\n");
	await runGitInDir(dir, ["checkout", "main"]);
	await commitFile(dir, "src/test.ts", "main modified content\n");
}

/**
 * Create a delete/modify conflict: file is deleted on main but modified on
 * the feature branch. This produces a conflict with NO conflict markers in
 * the working copy, causing Tier 2 auto-resolve to fail (resolveConflictsKeepIncoming
 * returns null). This naturally escalates to Tier 3 or 4.
 */
async function setupDeleteModifyConflict(
	dir: string,
	branchName = "feature-branch",
): Promise<void> {
	await commitFile(dir, "src/test.ts", "original content\n");
	await runGitInDir(dir, ["checkout", "-b", branchName]);
	await commitFile(dir, "src/test.ts", "modified by agent\n");
	await runGitInDir(dir, ["checkout", "main"]);
	await runGitInDir(dir, ["rm", "src/test.ts"]);
	await runGitInDir(dir, ["commit", "-m", "delete src/test.ts"]);
}

/**
 * Set up a scenario where Tier 2 auto-resolve fails but Tier 4 reimagine can
 * succeed. We create a delete/modify conflict on one file (causes Tier 2 to fail)
 * and set entry.filesModified to a different file that exists on both branches
 * (so git show works for both in reimagine).
 */
async function setupReimagineScenario(dir: string): Promise<void> {
	await commitFile(dir, "src/conflict-file.ts", "original content\n");
	await commitFile(dir, "src/reimagine-target.ts", "main version of target\n");
	await runGitInDir(dir, ["checkout", "-b", "feature-branch"]);
	await commitFile(dir, "src/conflict-file.ts", "modified by agent\n");
	await commitFile(dir, "src/reimagine-target.ts", "feature version of target\n");
	await runGitInDir(dir, ["checkout", "main"]);
	await runGitInDir(dir, ["rm", "src/conflict-file.ts"]);
	await runGitInDir(dir, ["commit", "-m", "delete conflict file"]);
}

describe("createMergeResolver", () => {
	describe("Tier 1: Clean merge", () => {
		test("returns success with correct result shape and file content", async () => {
			const repoDir = await createTempGitRepo();
			try {
				await setupCleanMerge(repoDir);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/feature-file.ts"],
				});

				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
				});

				const result = await resolver.resolve(entry, "main", repoDir);

				expect(result.success).toBe(true);
				expect(result.tier).toBe("clean-merge");
				expect(result.entry.status).toBe("merged");
				expect(result.entry.resolvedTier).toBe("clean-merge");
				expect(result.conflictFiles).toEqual([]);
				expect(result.errorMessage).toBeNull();

				// After merge, the feature file should exist on main
				const file = Bun.file(join(repoDir, "src/feature-file.ts"));
				const content = await file.text();
				expect(content).toBe("feature content\n");
			} finally {
				await cleanupTempDir(repoDir);
			}
		});
	});

	describe("Tier 1: Checkout failure", () => {
		// Both tests only attempt checkout of nonexistent branches -- no repo mutation.
		let repoDir: string;

		beforeAll(async () => {
			repoDir = await createTempGitRepo();
		});

		afterAll(async () => {
			await cleanupTempDir(repoDir);
		});

		test("throws MergeError if checkout fails", async () => {
			const entry = makeTestEntry();

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			await expect(resolver.resolve(entry, "nonexistent-branch", repoDir)).rejects.toThrow(
				MergeError,
			);
		});

		test("MergeError from checkout failure includes branch name", async () => {
			const entry = makeTestEntry();

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			try {
				await resolver.resolve(entry, "develop", repoDir);
				expect(true).toBe(false);
			} catch (err: unknown) {
				expect(err).toBeInstanceOf(MergeError);
				const mergeErr = err as MergeError;
				expect(mergeErr.message).toContain("develop");
			}
		});
	});

	describe("Tier 1 fail -> Tier 2: Auto-resolve", () => {
		test("auto-resolves conflicts keeping incoming changes with correct content", async () => {
			const repoDir = await createTempGitRepo();
			try {
				await setupContentConflict(repoDir);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/test.ts"],
				});

				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
				});

				const result = await resolver.resolve(entry, "main", repoDir);

				expect(result.success).toBe(true);
				expect(result.tier).toBe("auto-resolve");
				expect(result.entry.status).toBe("merged");
				expect(result.entry.resolvedTier).toBe("auto-resolve");

				// The resolved file should contain the incoming (feature branch) content
				const file = Bun.file(join(repoDir, "src/test.ts"));
				const content = await file.text();
				expect(content).toBe("feature content\n");
			} finally {
				await cleanupTempDir(repoDir);
			}
		});
	});

	describe("Tier 3: AI-resolve", () => {
		// After the first test (aiResolve=false), the resolver aborts the merge and
		// leaves the repo clean. The second test can retry the merge on the same repo.
		let repoDir: string;

		beforeAll(async () => {
			repoDir = await createTempGitRepo();
			await setupDeleteModifyConflict(repoDir);
		});

		afterAll(async () => {
			await cleanupTempDir(repoDir);
		});

		// This test MUST run first -- it fails to merge and aborts, leaving repo clean
		test("is skipped when aiResolveEnabled is false", async () => {
			const entry = makeTestEntry({
				branchName: "feature-branch",
				filesModified: ["src/test.ts"],
			});

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			const result = await resolver.resolve(entry, "main", repoDir);

			expect(result.success).toBe(false);
			expect(result.entry.status).toBe("failed");
		});

		// This test runs second -- repo is clean from the abort, same conflict is available
		test("invokes claude when aiResolveEnabled is true and tier 2 fails", async () => {
			// Selective spy: mock only claude, let git commands through.
			const originalSpawn = Bun.spawn;
			let claudeCalled = false;

			const selectiveMock = (...args: unknown[]): unknown => {
				const cmd = args[0] as string[];
				if (cmd?.[0] === "claude") {
					claudeCalled = true;
					return mockSpawnResult("resolved content from AI\n", "", 0);
				}
				return originalSpawn.apply(Bun, args as Parameters<typeof Bun.spawn>);
			};

			const spawnSpy = spyOn(Bun, "spawn").mockImplementation(selectiveMock as typeof Bun.spawn);

			try {
				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/test.ts"],
				});

				const resolver = createMergeResolver({
					aiResolveEnabled: true,
					reimagineEnabled: false,
				});

				const result = await resolver.resolve(entry, "main", repoDir);

				expect(claudeCalled).toBe(true);
				expect(result.success).toBe(true);
				expect(result.tier).toBe("ai-resolve");
				expect(result.entry.status).toBe("merged");
				expect(result.entry.resolvedTier).toBe("ai-resolve");
			} finally {
				spawnSpy.mockRestore();
			}
		});
	});

	describe("Tier 4: Re-imagine", () => {
		// After the first test (reimagine=false), the resolver aborts the merge and
		// leaves the repo clean. The second test can retry the merge on the same repo.
		let repoDir: string;

		beforeAll(async () => {
			repoDir = await createTempGitRepo();
			await setupReimagineScenario(repoDir);
		});

		afterAll(async () => {
			await cleanupTempDir(repoDir);
		});

		// This test MUST run first -- it fails to merge and aborts, leaving repo clean
		test("is skipped when reimagineEnabled is false", async () => {
			const entry = makeTestEntry({
				branchName: "feature-branch",
				filesModified: ["src/reimagine-target.ts"],
			});

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			const result = await resolver.resolve(entry, "main", repoDir);

			expect(result.success).toBe(false);
			expect(result.entry.status).toBe("failed");
		});

		// This test runs second -- repo is clean from the abort, same conflict is available
		test("aborts merge and reimplements when reimagineEnabled is true", async () => {
			// Selective spy: mock only claude, let git commands through.
			const originalSpawn = Bun.spawn;
			let claudeCalled = false;

			const selectiveMock = (...args: unknown[]): unknown => {
				const cmd = args[0] as string[];
				if (cmd?.[0] === "claude") {
					claudeCalled = true;
					return mockSpawnResult("reimagined content\n", "", 0);
				}
				return originalSpawn.apply(Bun, args as Parameters<typeof Bun.spawn>);
			};

			const spawnSpy = spyOn(Bun, "spawn").mockImplementation(selectiveMock as typeof Bun.spawn);

			try {
				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/reimagine-target.ts"],
				});

				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: true,
				});

				const result = await resolver.resolve(entry, "main", repoDir);

				expect(claudeCalled).toBe(true);
				expect(result.success).toBe(true);
				expect(result.tier).toBe("reimagine");
				expect(result.entry.status).toBe("merged");
				expect(result.entry.resolvedTier).toBe("reimagine");

				// Verify the reimagined content was written
				const file = Bun.file(join(repoDir, "src/reimagine-target.ts"));
				const content = await file.text();
				expect(content).toBe("reimagined content\n");
			} finally {
				spawnSpy.mockRestore();
			}
		});
	});

	describe("All tiers fail", () => {
		test("returns failed status and repo is clean when all tiers fail", async () => {
			const repoDir = await createTempGitRepo();
			try {
				await setupDeleteModifyConflict(repoDir);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/test.ts"],
				});

				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
				});

				const result = await resolver.resolve(entry, "main", repoDir);

				expect(result.success).toBe(false);
				expect(result.entry.status).toBe("failed");
				expect(result.entry.resolvedTier).toBeNull();
				expect(result.errorMessage).not.toBeNull();
				expect(result.errorMessage).toContain("failed");

				// Verify the repo is in a clean state (merge was aborted)
				const status = await runGitInDir(repoDir, ["status", "--porcelain"]);
				expect(status.trim()).toBe("");
			} finally {
				await cleanupTempDir(repoDir);
			}
		});
	});

	describe("result shape", () => {
		let repoDir: string;

		beforeEach(async () => {
			repoDir = await createTempGitRepo();
		});

		afterEach(async () => {
			await cleanupTempDir(repoDir);
		});

		test("successful result has correct MergeResult shape", async () => {
			await setupCleanMerge(repoDir);

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			const result = await resolver.resolve(
				makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/feature-file.ts"],
				}),
				"main",
				repoDir,
			);

			expect(result).toHaveProperty("entry");
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("tier");
			expect(result).toHaveProperty("conflictFiles");
			expect(result).toHaveProperty("errorMessage");
		});

		test("failed result preserves original entry fields", async () => {
			await setupDeleteModifyConflict(repoDir, "overstory/my-agent/bead-xyz");

			const entry = makeTestEntry({
				branchName: "overstory/my-agent/bead-xyz",
				beadId: "bead-xyz",
				agentName: "my-agent",
				filesModified: ["src/test.ts"],
			});

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			const result = await resolver.resolve(entry, "main", repoDir);

			expect(result.entry.branchName).toBe("overstory/my-agent/bead-xyz");
			expect(result.entry.beadId).toBe("bead-xyz");
			expect(result.entry.agentName).toBe("my-agent");
		});
	});

	describe("checkout skip when already on canonical branch", () => {
		test("succeeds when already on canonical branch (skips checkout)", async () => {
			const repoDir = await createTempGitRepo();
			try {
				await setupCleanMerge(repoDir);

				// Verify we're on main
				const branch = await runGitInDir(repoDir, ["symbolic-ref", "--short", "HEAD"]);
				expect(branch.trim()).toBe("main");

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/feature-file.ts"],
				});

				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
				});

				const result = await resolver.resolve(entry, "main", repoDir);
				expect(result.success).toBe(true);
				expect(result.tier).toBe("clean-merge");
			} finally {
				await cleanupTempDir(repoDir);
			}
		});

		test("checks out canonical when on a different branch", async () => {
			const repoDir = await createTempGitRepo();
			try {
				await setupCleanMerge(repoDir);

				// Switch to a different branch
				await runGitInDir(repoDir, ["checkout", "-b", "some-other-branch"]);
				const branch = await runGitInDir(repoDir, ["symbolic-ref", "--short", "HEAD"]);
				expect(branch.trim()).toBe("some-other-branch");

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/feature-file.ts"],
				});

				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
				});

				const result = await resolver.resolve(entry, "main", repoDir);
				expect(result.success).toBe(true);
				expect(result.tier).toBe("clean-merge");
			} finally {
				await cleanupTempDir(repoDir);
			}
		});
	});

	describe("looksLikeProse", () => {
		test("detects conversational prose", () => {
			expect(looksLikeProse("I need permission to edit the file")).toBe(true);
			expect(looksLikeProse("Here's the resolved content:")).toBe(true);
			expect(looksLikeProse("Here is the file")).toBe(true);
			expect(looksLikeProse("The conflict can be resolved by")).toBe(true);
			expect(looksLikeProse("Let me resolve this for you")).toBe(true);
			expect(looksLikeProse("Sure, here's the resolved file")).toBe(true);
			expect(looksLikeProse("I cannot access the file")).toBe(true);
			expect(looksLikeProse("I don't have access")).toBe(true);
			expect(looksLikeProse("To resolve this, we need to")).toBe(true);
			expect(looksLikeProse("Looking at the conflict")).toBe(true);
			expect(looksLikeProse("Based on both versions")).toBe(true);
		});

		test("detects markdown fencing", () => {
			expect(looksLikeProse("```typescript\nconst x = 1;\n```")).toBe(true);
			expect(looksLikeProse("```\nsome code\n```")).toBe(true);
		});

		test("detects empty output", () => {
			expect(looksLikeProse("")).toBe(true);
			expect(looksLikeProse("   ")).toBe(true);
		});

		test("accepts valid code", () => {
			expect(looksLikeProse("const x = 1;")).toBe(false);
			expect(looksLikeProse("import { foo } from 'bar';")).toBe(false);
			expect(looksLikeProse("export function resolve() {}")).toBe(false);
			expect(looksLikeProse("function hello() {\n  return 'world';\n}")).toBe(false);
			expect(looksLikeProse("// comment\nconst a = 1;")).toBe(false);
		});
	});

	describe("Tier 3: AI-resolve prose rejection", () => {
		test("rejects prose output and falls through to failure", async () => {
			const repoDir = await createTempGitRepo();
			try {
				await setupDeleteModifyConflict(repoDir);

				const originalSpawn = Bun.spawn;
				const selectiveMock = (...args: unknown[]): unknown => {
					const cmd = args[0] as string[];
					if (cmd?.[0] === "claude") {
						// Return prose instead of code
						return mockSpawnResult(
							"I need permission to edit the file. Here's the resolved content:\n```\nresolved\n```",
							"",
							0,
						);
					}
					return originalSpawn.apply(Bun, args as Parameters<typeof Bun.spawn>);
				};

				const spawnSpy = spyOn(Bun, "spawn").mockImplementation(selectiveMock as typeof Bun.spawn);

				try {
					const entry = makeTestEntry({
						branchName: "feature-branch",
						filesModified: ["src/test.ts"],
					});

					const resolver = createMergeResolver({
						aiResolveEnabled: true,
						reimagineEnabled: false,
					});

					const result = await resolver.resolve(entry, "main", repoDir);

					// Should fail because prose was rejected
					expect(result.success).toBe(false);
				} finally {
					spawnSpy.mockRestore();
				}
			} finally {
				await cleanupTempDir(repoDir);
			}
		});
	});
});
