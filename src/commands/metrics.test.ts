import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMetricsStore } from "../metrics/store.ts";
import type { SessionMetrics } from "../types.ts";
import { metricsCommand } from "./metrics.ts";

/**
 * Tests for `overstory metrics` command.
 *
 * Uses real bun:sqlite (temp files) to test the metrics command end-to-end.
 * Captures process.stdout.write to verify output formatting.
 */

describe("metricsCommand", () => {
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

		// Create temp dir with .overstory/config.yaml structure
		tempDir = await mkdtemp(join(tmpdir(), "metrics-test-"));
		const overstoryDir = join(tempDir, ".overstory");
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
		await rm(tempDir, { recursive: true, force: true });
	});

	function output(): string {
		return chunks.join("");
	}

	function makeSession(overrides: Partial<SessionMetrics> = {}): SessionMetrics {
		return {
			agentName: "test-agent",
			beadId: "bead-001",
			capability: "builder",
			startedAt: new Date(Date.now() - 120_000).toISOString(),
			completedAt: new Date().toISOString(),
			durationMs: 120_000,
			exitCode: 0,
			mergeResult: "clean-merge",
			parentAgent: null,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			estimatedCostUsd: null,
			modelUsed: null,
			runId: null,
			...overrides,
		};
	}

	test("--help flag shows help text", async () => {
		await metricsCommand(["--help"]);
		const out = output();

		expect(out).toContain("overstory metrics");
		expect(out).toContain("--last <n>");
		expect(out).toContain("--json");
		expect(out).toContain("--help");
	});

	test("-h flag shows help text", async () => {
		await metricsCommand(["-h"]);
		const out = output();

		expect(out).toContain("overstory metrics");
		expect(out).toContain("--last <n>");
	});

	test("no metrics DB returns empty message (text)", async () => {
		await metricsCommand([]);
		const out = output();

		expect(out).toBe("No metrics data yet.\n");
	});

	test("no metrics DB returns empty JSON (--json)", async () => {
		await metricsCommand(["--json"]);
		const out = output();

		expect(out).toBe('{"sessions":[]}\n');
	});

	test("empty DB with no sessions", async () => {
		// Create the DB but don't insert any sessions
		const dbPath = join(tempDir, ".overstory", "metrics.db");
		const store = createMetricsStore(dbPath);
		store.close();

		await metricsCommand([]);
		const out = output();

		expect(out).toBe("No sessions recorded yet.\n");
	});

	test("basic output with sample sessions", async () => {
		const dbPath = join(tempDir, ".overstory", "metrics.db");
		const store = createMetricsStore(dbPath);

		// Insert sample sessions
		store.recordSession(
			makeSession({
				agentName: "builder-1",
				capability: "builder",
				durationMs: 45_000,
			}),
		);
		store.recordSession(
			makeSession({
				agentName: "scout-1",
				capability: "scout",
				durationMs: 90_000,
			}),
		);
		store.recordSession(
			makeSession({
				agentName: "builder-2",
				capability: "builder",
				durationMs: 30_000,
				completedAt: null, // Still running
			}),
		);

		store.close();

		await metricsCommand([]);
		const out = output();

		// Check summary stats
		expect(out).toContain("📈 Session Metrics");
		expect(out).toContain("Total sessions: 3");
		expect(out).toContain("Completed: 2");
		expect(out).toContain("Avg duration:");

		// Check capability breakdown
		expect(out).toContain("By capability:");
		expect(out).toContain("builder:");
		expect(out).toContain("scout:");

		// Check recent sessions table
		expect(out).toContain("Recent sessions:");
		expect(out).toContain("builder-1");
		expect(out).toContain("scout-1");
		expect(out).toContain("builder-2");
		expect(out).toContain("done");
		expect(out).toContain("running");
	});

	test("--json flag returns structured JSON", async () => {
		const dbPath = join(tempDir, ".overstory", "metrics.db");
		const store = createMetricsStore(dbPath);

		store.recordSession(
			makeSession({
				agentName: "test-builder",
				beadId: "bead-123",
				capability: "builder",
			}),
		);

		store.close();

		await metricsCommand(["--json"]);
		const out = output();

		const parsed = JSON.parse(out.trim()) as { sessions: SessionMetrics[] };
		expect(parsed.sessions).toHaveLength(1);
		expect(parsed.sessions[0]?.agentName).toBe("test-builder");
		expect(parsed.sessions[0]?.beadId).toBe("bead-123");
		expect(parsed.sessions[0]?.capability).toBe("builder");
	});

	test("--last flag limits number of sessions", async () => {
		const dbPath = join(tempDir, ".overstory", "metrics.db");
		const store = createMetricsStore(dbPath);

		// Insert 5 sessions
		for (let i = 0; i < 5; i++) {
			store.recordSession(
				makeSession({
					agentName: `agent-${i}`,
					beadId: `bead-${i}`,
					startedAt: new Date(Date.now() - (5 - i) * 1000).toISOString(),
				}),
			);
		}

		store.close();

		await metricsCommand(["--last", "2"]);
		const out = output();

		// Should only show 2 sessions
		expect(out).toContain("Total sessions: 2");
	});

	test("--last flag with --json limits sessions", async () => {
		const dbPath = join(tempDir, ".overstory", "metrics.db");
		const store = createMetricsStore(dbPath);

		// Insert 5 sessions
		for (let i = 0; i < 5; i++) {
			store.recordSession(
				makeSession({
					agentName: `agent-${i}`,
					beadId: `bead-${i}`,
				}),
			);
		}

		store.close();

		await metricsCommand(["--last", "3", "--json"]);
		const out = output();

		const parsed = JSON.parse(out.trim()) as { sessions: SessionMetrics[] };
		expect(parsed.sessions).toHaveLength(3);
	});

	test("merge tier distribution shows in output", async () => {
		const dbPath = join(tempDir, ".overstory", "metrics.db");
		const store = createMetricsStore(dbPath);

		// Insert sessions with different merge tiers
		store.recordSession(
			makeSession({
				agentName: "agent-1",
				mergeResult: "clean-merge",
			}),
		);
		store.recordSession(
			makeSession({
				agentName: "agent-2",
				mergeResult: "clean-merge",
			}),
		);
		store.recordSession(
			makeSession({
				agentName: "agent-3",
				mergeResult: "auto-resolve",
			}),
		);
		store.recordSession(
			makeSession({
				agentName: "agent-4",
				mergeResult: "ai-resolve",
			}),
		);

		store.close();

		await metricsCommand([]);
		const out = output();

		// Check merge tier counts
		expect(out).toContain("Merge tiers:");
		expect(out).toContain("clean-merge: 2");
		expect(out).toContain("auto-resolve: 1");
		expect(out).toContain("ai-resolve: 1");
	});

	test("sessions without merge results don't show in tier distribution", async () => {
		const dbPath = join(tempDir, ".overstory", "metrics.db");
		const store = createMetricsStore(dbPath);

		// Insert sessions: one with merge result, two without
		store.recordSession(
			makeSession({
				agentName: "agent-1",
				mergeResult: "clean-merge",
			}),
		);
		store.recordSession(
			makeSession({
				agentName: "agent-2",
				mergeResult: null,
			}),
		);
		store.recordSession(
			makeSession({
				agentName: "agent-3",
				mergeResult: null,
				completedAt: null,
			}),
		);

		store.close();

		await metricsCommand([]);
		const out = output();

		expect(out).toContain("Merge tiers:");
		expect(out).toContain("clean-merge: 1");
		// Should not include sessions without merge results
		expect(out).toContain("Total sessions: 3");
		expect(out).toContain("Completed: 2");
	});
});

describe("formatDuration helper", () => {
	// We need to test the formatDuration helper directly, but it's not exported.
	// We can infer its behavior from the output format.
	// Alternatively, we can test it indirectly through the command output.

	let chunks: string[];
	let originalWrite: typeof process.stdout.write;
	let tempDir: string;
	let originalCwd: string;

	beforeEach(async () => {
		chunks = [];
		originalWrite = process.stdout.write;
		process.stdout.write = ((chunk: string) => {
			chunks.push(chunk);
			return true;
		}) as typeof process.stdout.write;

		tempDir = await mkdtemp(join(tmpdir(), "metrics-test-"));
		const overstoryDir = join(tempDir, ".overstory");
		await Bun.write(
			join(overstoryDir, "config.yaml"),
			`project:\n  name: test\n  root: ${tempDir}\n  canonicalBranch: main\n`,
		);

		originalCwd = process.cwd();
		process.chdir(tempDir);
	});

	afterEach(async () => {
		process.stdout.write = originalWrite;
		process.chdir(originalCwd);
		await rm(tempDir, { recursive: true, force: true });
	});

	function output(): string {
		return chunks.join("");
	}

	function makeSession(durationMs: number): SessionMetrics {
		return {
			agentName: "test-agent",
			beadId: "bead-001",
			capability: "builder",
			startedAt: new Date(Date.now() - durationMs).toISOString(),
			completedAt: new Date().toISOString(),
			durationMs,
			exitCode: 0,
			mergeResult: "clean-merge",
			parentAgent: null,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			estimatedCostUsd: null,
			modelUsed: null,
			runId: null,
		};
	}

	test("0ms formats as 0s", async () => {
		const dbPath = join(tempDir, ".overstory", "metrics.db");
		const store = createMetricsStore(dbPath);
		store.recordSession(makeSession(0));
		store.close();

		await metricsCommand([]);
		const out = output();

		// Should contain "0s" somewhere in the output
		expect(out).toContain("0s");
	});

	test("45000ms formats as 45s", async () => {
		const dbPath = join(tempDir, ".overstory", "metrics.db");
		const store = createMetricsStore(dbPath);
		store.recordSession(makeSession(45_000));
		store.close();

		await metricsCommand([]);
		const out = output();

		expect(out).toContain("45s");
	});

	test("90000ms formats as 1m 30s", async () => {
		const dbPath = join(tempDir, ".overstory", "metrics.db");
		const store = createMetricsStore(dbPath);
		store.recordSession(makeSession(90_000));
		store.close();

		await metricsCommand([]);
		const out = output();

		expect(out).toContain("1m 30s");
	});

	test("3720000ms formats as 1h 2m", async () => {
		const dbPath = join(tempDir, ".overstory", "metrics.db");
		const store = createMetricsStore(dbPath);
		store.recordSession(makeSession(3_720_000));
		store.close();

		await metricsCommand([]);
		const out = output();

		expect(out).toContain("1h 2m");
	});

	test("3600000ms formats as 1h 0m", async () => {
		const dbPath = join(tempDir, ".overstory", "metrics.db");
		const store = createMetricsStore(dbPath);
		store.recordSession(makeSession(3_600_000));
		store.close();

		await metricsCommand([]);
		const out = output();

		expect(out).toContain("1h 0m");
	});
});
