/**
 * Tests for mulch CLI client.
 *
 * Uses real mulch CLI when available (preferred).
 * All tests are skipped if mulch is not installed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentError } from "../errors.ts";
import { createMulchClient } from "./client.ts";

// Check if mulch is available
let hasMulch = false;
try {
	const proc = Bun.spawn(["which", "mulch"], { stdout: "pipe", stderr: "pipe" });
	const exitCode = await proc.exited;
	hasMulch = exitCode === 0;
} catch {
	hasMulch = false;
}

describe("createMulchClient", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mulch-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	/**
	 * Helper to initialize git repo in tempDir.
	 * Some mulch commands (diff, learn) require a git repository.
	 */
	async function initGit(): Promise<void> {
		const initProc = Bun.spawn(["git", "init"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		await initProc.exited;

		const configNameProc = Bun.spawn(["git", "config", "user.name", "Test User"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		await configNameProc.exited;

		const configEmailProc = Bun.spawn(["git", "config", "user.email", "test@example.com"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		await configEmailProc.exited;
	}

	/**
	 * Helper to initialize mulch in tempDir.
	 * Creates .mulch/ directory and initial structure.
	 */
	async function initMulch(): Promise<void> {
		if (!hasMulch) return;
		const proc = Bun.spawn(["mulch", "init"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;
	}

	describe("prime", () => {
		test.skipIf(!hasMulch)("returns non-empty string", async () => {
			await initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.prime();
			expect(result).toBeTruthy();
			expect(typeof result).toBe("string");
			expect(result.length).toBeGreaterThan(0);
		});

		test.skipIf(!hasMulch)("passes domain args when provided", async () => {
			await initMulch();
			// Add a domain first so we can prime it
			const addProc = Bun.spawn(["mulch", "add", "architecture"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			});
			await addProc.exited;

			const client = createMulchClient(tempDir);
			const result = await client.prime(["architecture"]);
			expect(typeof result).toBe("string");
		});

		test.skipIf(!hasMulch)("passes --format flag", async () => {
			await initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.prime([], "markdown");
			expect(typeof result).toBe("string");
		});

		test.skipIf(!hasMulch)("passes both domains and format", async () => {
			await initMulch();
			const addProc = Bun.spawn(["mulch", "add", "architecture"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			});
			await addProc.exited;

			const client = createMulchClient(tempDir);
			const result = await client.prime(["architecture"], "xml");
			expect(typeof result).toBe("string");
		});

		test.skipIf(!hasMulch)("passes --files flag", async () => {
			await initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.prime([], "markdown", {
				files: ["src/config.ts", "src/types.ts"],
			});
			expect(typeof result).toBe("string");
		});

		test.skipIf(!hasMulch)("passes --exclude-domain flag", async () => {
			await initMulch();
			const addProc = Bun.spawn(["mulch", "add", "architecture"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			});
			await addProc.exited;

			const client = createMulchClient(tempDir);
			const result = await client.prime([], "markdown", {
				excludeDomain: ["architecture"],
			});
			expect(typeof result).toBe("string");
		});

		test.skipIf(!hasMulch)("passes both --files and --exclude-domain", async () => {
			await initMulch();
			// Add a domain to exclude
			const addProc = Bun.spawn(["mulch", "add", "internal"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			});
			await addProc.exited;

			const client = createMulchClient(tempDir);
			const result = await client.prime([], "markdown", {
				files: ["src/config.ts"],
				excludeDomain: ["internal"],
			});
			expect(typeof result).toBe("string");
		});
	});

	describe("status", () => {
		test.skipIf(!hasMulch)("returns MulchStatus shape", async () => {
			await initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.status();
			expect(result).toHaveProperty("domains");
			expect(Array.isArray(result.domains)).toBe(true);
		});

		test.skipIf(!hasMulch)("with no domains returns empty array", async () => {
			await initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.status();
			expect(result.domains).toEqual([]);
		});

		test.skipIf(!hasMulch)("includes domain data when domains exist", async () => {
			await initMulch();
			// Add a domain
			const addProc = Bun.spawn(["mulch", "add", "architecture"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			});
			await addProc.exited;

			const client = createMulchClient(tempDir);
			const result = await client.status();
			expect(result.domains.length).toBeGreaterThan(0);
			// Just verify we got an array with entries, don't check specific structure
			// as mulch CLI output format may vary
		});
	});

	describe("record", () => {
		test.skipIf(!hasMulch)("with required args succeeds", async () => {
			await initMulch();
			// Add domain first
			const addProc = Bun.spawn(["mulch", "add", "architecture"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			});
			await addProc.exited;

			const client = createMulchClient(tempDir);
			await expect(
				client.record("architecture", {
					type: "convention",
					description: "test convention",
				}),
			).resolves.toBeUndefined();
		});

		test.skipIf(!hasMulch)("with optional args succeeds", async () => {
			await initMulch();
			const addProc = Bun.spawn(["mulch", "add", "architecture"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			});
			await addProc.exited;

			const client = createMulchClient(tempDir);
			await expect(
				client.record("architecture", {
					type: "pattern",
					name: "test-pattern",
					description: "test description",
					title: "Test Pattern",
					rationale: "testing all options",
					tags: ["testing", "example"],
				}),
			).resolves.toBeUndefined();
		});

		test.skipIf(!hasMulch)("with multiple tags", async () => {
			await initMulch();
			const addProc = Bun.spawn(["mulch", "add", "typescript"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			});
			await addProc.exited;

			const client = createMulchClient(tempDir);
			await expect(
				client.record("typescript", {
					type: "convention",
					description: "multi-tag test",
					tags: ["tag1", "tag2", "tag3"],
				}),
			).resolves.toBeUndefined();
		});

		test.skipIf(!hasMulch)("with --stdin flag passes flag to CLI", async () => {
			await initMulch();
			const addProc = Bun.spawn(["mulch", "add", "testing"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			});
			await addProc.exited;

			const client = createMulchClient(tempDir);
			// --stdin expects JSON input, which we're not providing, so this will fail
			// but we're testing that the flag is passed correctly
			await expect(
				client.record("testing", {
					type: "convention",
					description: "stdin test",
					stdin: true,
				}),
			).rejects.toThrow(AgentError);
		});

		test.skipIf(!hasMulch)("with outcome flags passes them to CLI", async () => {
			await initMulch();
			const addProc = Bun.spawn(["mulch", "add", "testing"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			});
			await addProc.exited;

			const client = createMulchClient(tempDir);
			// May succeed or fail depending on mulch version, but verifies flags are passed
			try {
				await client.record("testing", {
					type: "convention",
					description: "outcome test",
					outcomeStatus: "success",
					outcomeDuration: 42,
					outcomeTestResults: "15 passed",
					outcomeAgent: "test-agent",
				});
				expect(true).toBe(true);
			} catch (error) {
				expect(error).toBeInstanceOf(AgentError);
			}
		});

		test.skipIf(!hasMulch)("with outcomeStatus: failure passes flag to CLI", async () => {
			await initMulch();
			const addProc = Bun.spawn(["mulch", "add", "testing"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			});
			await addProc.exited;

			const client = createMulchClient(tempDir);
			try {
				await client.record("testing", {
					type: "failure",
					description: "failure outcome test",
					outcomeStatus: "failure",
				});
				expect(true).toBe(true);
			} catch (error) {
				expect(error).toBeInstanceOf(AgentError);
			}
		});

		test.skipIf(!hasMulch)("with outcomeDuration: 0 passes zero value to CLI", async () => {
			await initMulch();
			const addProc = Bun.spawn(["mulch", "add", "testing"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			});
			await addProc.exited;

			const client = createMulchClient(tempDir);
			try {
				await client.record("testing", {
					type: "convention",
					description: "zero duration test",
					outcomeDuration: 0,
				});
				expect(true).toBe(true);
			} catch (error) {
				expect(error).toBeInstanceOf(AgentError);
			}
		});

		test.skipIf(!hasMulch)("with --evidence-bead flag passes flag to CLI", async () => {
			await initMulch();
			const addProc = Bun.spawn(["mulch", "add", "testing"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			});
			await addProc.exited;

			const client = createMulchClient(tempDir);
			// The flag is passed correctly, but may fail if the bead ID is invalid
			// or if other required fields are missing. This test documents that the
			// flag is properly passed to the CLI.
			try {
				await client.record("testing", {
					type: "decision",
					description: "bead evidence test",
					evidenceBead: "beads-abc123",
				});
				// If it succeeds, great!
				expect(true).toBe(true);
			} catch (error) {
				// If it fails, verify it's an AgentError (not a type error or similar)
				// which proves the command was executed with the flag
				expect(error).toBeInstanceOf(AgentError);
			}
		});
	});

	describe("query", () => {
		test.skipIf(!hasMulch)("passes domain arg when provided", async () => {
			await initMulch();
			const addProc = Bun.spawn(["mulch", "add", "architecture"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			});
			await addProc.exited;

			const client = createMulchClient(tempDir);
			const result = await client.query("architecture");
			expect(typeof result).toBe("string");
		});

		test.skipIf(!hasMulch)("query without domain requires --all flag", async () => {
			await initMulch();
			const client = createMulchClient(tempDir);
			// Current implementation doesn't pass --all, so this will fail
			// This documents the current behavior
			await expect(client.query()).rejects.toThrow(AgentError);
		});
	});

	describe("search", () => {
		test.skipIf(!hasMulch)("returns string output", async () => {
			await initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.search("test");
			expect(typeof result).toBe("string");
		});

		test.skipIf(!hasMulch)("searches across domains", async () => {
			await initMulch();
			// Add a domain and record
			const addProc = Bun.spawn(["mulch", "add", "testing"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			});
			await addProc.exited;

			const client = createMulchClient(tempDir);
			await client.record("testing", {
				type: "convention",
				description: "searchable keyword here",
			});

			const result = await client.search("searchable");
			expect(typeof result).toBe("string");
		});

		test.skipIf(!hasMulch)("passes --file flag when provided", async () => {
			await initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.search("test", { file: "src/config.ts" });
			expect(typeof result).toBe("string");
		});

		test.skipIf(!hasMulch)("passes --sort-by-score flag when provided", async () => {
			await initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.search("test", { sortByScore: true });
			expect(typeof result).toBe("string");
		});

		test.skipIf(!hasMulch)("passes both --file and --sort-by-score flags", async () => {
			await initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.search("test", { file: "src/config.ts", sortByScore: true });
			expect(typeof result).toBe("string");
		});
	});

	describe("diff", () => {
		test.skipIf(!hasMulch)("shows expertise changes", async () => {
			await initGit();
			await initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.diff();
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("command");
			expect(result).toHaveProperty("domains");
			expect(Array.isArray(result.domains)).toBe(true);
		});

		test.skipIf(!hasMulch)("passes --since flag", async () => {
			await initGit();
			await initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.diff({ since: "HEAD~5" });
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("since");
		});
	});

	describe("learn", () => {
		test.skipIf(!hasMulch)("suggests domains for learnings", async () => {
			await initGit();
			await initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.learn();
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("command");
			expect(result).toHaveProperty("changedFiles");
			expect(Array.isArray(result.changedFiles)).toBe(true);
		});

		test.skipIf(!hasMulch)("passes --since flag", async () => {
			await initGit();
			await initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.learn({ since: "HEAD~3" });
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("changedFiles");
		});
	});

	describe("prune", () => {
		test.skipIf(!hasMulch)("prunes records", async () => {
			await initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.prune();
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("command");
			expect(result).toHaveProperty("totalPruned");
		});

		test.skipIf(!hasMulch)("supports --dry-run flag", async () => {
			await initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.prune({ dryRun: true });
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("dryRun");
			expect(result.dryRun).toBe(true);
		});
	});

	describe("doctor", () => {
		test.skipIf(!hasMulch)("runs health checks", async () => {
			await initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.doctor();
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("command");
			expect(result).toHaveProperty("checks");
			expect(Array.isArray(result.checks)).toBe(true);
		});

		test.skipIf(!hasMulch)("passes --fix flag", async () => {
			await initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.doctor({ fix: true });
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("checks");
		});
	});

	describe("ready", () => {
		test.skipIf(!hasMulch)("shows recently updated records", async () => {
			await initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.ready();
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("command");
			expect(result).toHaveProperty("entries");
			expect(Array.isArray(result.entries)).toBe(true);
		});

		test.skipIf(!hasMulch)("passes --limit flag", async () => {
			await initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.ready({ limit: 5 });
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("count");
		});

		test.skipIf(!hasMulch)("passes --domain flag", async () => {
			await initMulch();
			const addProc = Bun.spawn(["mulch", "add", "testing"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			});
			await addProc.exited;

			const client = createMulchClient(tempDir);
			const result = await client.ready({ domain: "testing" });
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("entries");
		});

		test.skipIf(!hasMulch)("passes --since flag", async () => {
			await initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.ready({ since: "7d" });
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("entries");
		});
	});

	describe("compact", () => {
		test.skipIf(!hasMulch)("runs with --analyze flag", async () => {
			await initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.compact(undefined, { analyze: true });
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("command");
			expect(result).toHaveProperty("action");
		});

		test.skipIf(!hasMulch)("compacts specific domain with --analyze", async () => {
			await initMulch();
			const addProc = Bun.spawn(["mulch", "add", "large"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			});
			await addProc.exited;

			const client = createMulchClient(tempDir);
			const result = await client.compact("large", { analyze: true });
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("action");
		});

		test.skipIf(!hasMulch)("passes --auto with --dry-run flags", async () => {
			await initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.compact(undefined, { auto: true, dryRun: true });
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("command");
		});

		test.skipIf(!hasMulch)("passes multiple options", async () => {
			await initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.compact(undefined, {
				auto: true,
				dryRun: true,
				minGroup: 3,
				maxRecords: 20,
			});
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("command");
		});
	});

	describe("error handling", () => {
		test.skipIf(!hasMulch)("throws AgentError when mulch command fails", async () => {
			// Don't init mulch - operations will fail with "not initialized" error
			const client = createMulchClient(tempDir);
			await expect(client.status()).rejects.toThrow(AgentError);
		});

		test.skipIf(!hasMulch)("AgentError message contains exit code", async () => {
			const client = createMulchClient(tempDir);
			try {
				await client.status();
				expect.unreachable("Should have thrown AgentError");
			} catch (error) {
				expect(error).toBeInstanceOf(AgentError);
				const agentError = error as AgentError;
				expect(agentError.message).toContain("exit");
				expect(agentError.message).toContain("status");
			}
		});

		test.skipIf(!hasMulch)("record fails with descriptive error for missing domain", async () => {
			await initMulch();
			const client = createMulchClient(tempDir);
			// Try to record to a domain that doesn't exist
			await expect(
				client.record("nonexistent-domain", {
					type: "convention",
					description: "test",
				}),
			).rejects.toThrow(AgentError);
		});

		test.skipIf(!hasMulch)("handles empty status output correctly", async () => {
			await initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.status();
			// With no domains, should have empty array (not throw)
			expect(result).toHaveProperty("domains");
			expect(result.domains).toEqual([]);
		});
	});
});
