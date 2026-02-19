/**
 * Tests for `overstory inspect` command.
 *
 * Uses real bun:sqlite (temp files) to test the inspect command end-to-end.
 * Captures process.stdout.write to verify output formatting.
 *
 * Real implementations used for: filesystem (temp dirs), SQLite (EventStore,
 * SessionStore, MetricsStore). No mocks needed -- all dependencies are cheap and local.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { createSessionStore } from "../sessions/store.ts";
import type { InsertEvent, SessionMetrics } from "../types.ts";
import { gatherInspectData, inspectCommand } from "./inspect.ts";

/** Helper to create an InsertEvent with sensible defaults. */
function makeEvent(overrides: Partial<InsertEvent> = {}): InsertEvent {
	return {
		runId: "run-001",
		agentName: "builder-1",
		sessionId: "sess-abc",
		eventType: "tool_start",
		toolName: "Read",
		toolArgs: '{"file_path": "src/index.ts"}',
		toolDurationMs: null,
		level: "info",
		data: null,
		...overrides,
	};
}

/** Helper to create a SessionMetrics with sensible defaults. */
function makeMetrics(overrides: Partial<SessionMetrics> = {}): SessionMetrics {
	return {
		agentName: "builder-1",
		beadId: "overstory-001",
		capability: "builder",
		startedAt: new Date().toISOString(),
		completedAt: null,
		durationMs: 0,
		exitCode: null,
		mergeResult: null,
		parentAgent: null,
		inputTokens: 1000,
		outputTokens: 500,
		cacheReadTokens: 200,
		cacheCreationTokens: 100,
		estimatedCostUsd: 0.025,
		modelUsed: "claude-sonnet-4-5-20250929",
		runId: null,
		...overrides,
	};
}

describe("inspectCommand", () => {
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
		tempDir = await mkdtemp(join(tmpdir(), "inspect-test-"));
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

	// === Help flag ===

	describe("help flag", () => {
		test("--help shows help text", async () => {
			await inspectCommand(["--help"]);
			const out = output();
			expect(out).toContain("overstory inspect");
			expect(out).toContain("--json");
			expect(out).toContain("--follow");
			expect(out).toContain("--limit");
			expect(out).toContain("--no-tmux");
		});

		test("-h shows help text", async () => {
			await inspectCommand(["-h"]);
			const out = output();
			expect(out).toContain("overstory inspect");
		});
	});

	// === Validation errors ===

	describe("validation", () => {
		test("throws if no agent name provided", async () => {
			await expect(inspectCommand([])).rejects.toThrow(ValidationError);
		});

		test("throws if agent not found", async () => {
			const overstoryDir = join(tempDir, ".overstory");
			const sessionsDbPath = join(overstoryDir, "sessions.db");
			const store = createSessionStore(sessionsDbPath);
			store.close();

			await expect(inspectCommand(["nonexistent-agent"])).rejects.toThrow(ValidationError);
		});

		test("throws if --interval is invalid", async () => {
			const overstoryDir = join(tempDir, ".overstory");
			const sessionsDbPath = join(overstoryDir, "sessions.db");
			const store = createSessionStore(sessionsDbPath);
			store.upsert({
				id: "sess-1",
				agentName: "builder-1",
				capability: "builder",
				worktreePath: "/tmp/wt",
				branchName: "overstory/builder-1/test",
				beadId: "overstory-001",
				tmuxSession: "overstory-test-builder-1",
				state: "working",
				pid: 12345,
				parentAgent: null,
				depth: 0,
				runId: null,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
			});
			store.close();

			await expect(inspectCommand(["builder-1", "--interval", "abc"])).rejects.toThrow(
				ValidationError,
			);
			await expect(inspectCommand(["builder-1", "--interval", "100"])).rejects.toThrow(
				ValidationError,
			);
		});

		test("throws if --limit is invalid", async () => {
			const overstoryDir = join(tempDir, ".overstory");
			const sessionsDbPath = join(overstoryDir, "sessions.db");
			const store = createSessionStore(sessionsDbPath);
			store.upsert({
				id: "sess-1",
				agentName: "builder-1",
				capability: "builder",
				worktreePath: "/tmp/wt",
				branchName: "overstory/builder-1/test",
				beadId: "overstory-001",
				tmuxSession: "overstory-test-builder-1",
				state: "working",
				pid: 12345,
				parentAgent: null,
				depth: 0,
				runId: null,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
			});
			store.close();

			await expect(inspectCommand(["builder-1", "--limit", "abc"])).rejects.toThrow(
				ValidationError,
			);
			await expect(inspectCommand(["builder-1", "--limit", "0"])).rejects.toThrow(ValidationError);
		});
	});

	// === gatherInspectData ===

	describe("gatherInspectData", () => {
		test("gathers basic session data", async () => {
			const overstoryDir = join(tempDir, ".overstory");
			const sessionsDbPath = join(overstoryDir, "sessions.db");
			const store = createSessionStore(sessionsDbPath);

			const startedAt = new Date(Date.now() - 60_000).toISOString(); // 60s ago
			store.upsert({
				id: "sess-1",
				agentName: "builder-1",
				capability: "builder",
				worktreePath: "/tmp/wt",
				branchName: "overstory/builder-1/test",
				beadId: "overstory-001",
				tmuxSession: "overstory-test-builder-1",
				state: "working",
				pid: 12345,
				parentAgent: "orchestrator",
				depth: 1,
				runId: "run-001",
				startedAt,
				lastActivity: new Date(Date.now() - 5_000).toISOString(),
				escalationLevel: 0,
				stalledSince: null,
			});
			store.close();

			const data = await gatherInspectData(tempDir, "builder-1", { noTmux: true });

			expect(data.session.agentName).toBe("builder-1");
			expect(data.session.capability).toBe("builder");
			expect(data.session.state).toBe("working");
			expect(data.session.beadId).toBe("overstory-001");
			expect(data.timeSinceLastActivity).toBeGreaterThan(4000);
			expect(data.timeSinceLastActivity).toBeLessThan(10000);
		});

		test("extracts current file from recent Edit tool_start event", async () => {
			const overstoryDir = join(tempDir, ".overstory");
			const sessionsDbPath = join(overstoryDir, "sessions.db");
			const eventsDbPath = join(overstoryDir, "events.db");

			const store = createSessionStore(sessionsDbPath);
			store.upsert({
				id: "sess-1",
				agentName: "builder-1",
				capability: "builder",
				worktreePath: "/tmp/wt",
				branchName: "overstory/builder-1/test",
				beadId: "overstory-001",
				tmuxSession: "overstory-test-builder-1",
				state: "working",
				pid: 12345,
				parentAgent: null,
				depth: 0,
				runId: null,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
			});
			store.close();

			const eventStore = createEventStore(eventsDbPath);
			eventStore.insert(makeEvent({ toolName: "Read", toolArgs: '{"file_path": "src/a.ts"}' }));
			eventStore.insert(
				makeEvent({ toolName: "Edit", toolArgs: '{"file_path": "src/commands/inspect.ts"}' }),
			);
			eventStore.insert(makeEvent({ toolName: "Bash", toolArgs: '{"command": "bun test"}' }));
			eventStore.close();

			const data = await gatherInspectData(tempDir, "builder-1", { noTmux: true });

			expect(data.currentFile).toBe("src/commands/inspect.ts");
		});

		test("extracts current file from Write tool_start with path field", async () => {
			const overstoryDir = join(tempDir, ".overstory");
			const sessionsDbPath = join(overstoryDir, "sessions.db");
			const eventsDbPath = join(overstoryDir, "events.db");

			const store = createSessionStore(sessionsDbPath);
			store.upsert({
				id: "sess-1",
				agentName: "builder-1",
				capability: "builder",
				worktreePath: "/tmp/wt",
				branchName: "overstory/builder-1/test",
				beadId: "overstory-001",
				tmuxSession: "overstory-test-builder-1",
				state: "working",
				pid: 12345,
				parentAgent: null,
				depth: 0,
				runId: null,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
			});
			store.close();

			const eventStore = createEventStore(eventsDbPath);
			eventStore.insert(makeEvent({ toolName: "Write", toolArgs: '{"path": "src/new-file.ts"}' }));
			eventStore.close();

			const data = await gatherInspectData(tempDir, "builder-1", { noTmux: true });

			expect(data.currentFile).toBe("src/new-file.ts");
		});

		test("returns null current file if no Edit/Write/Read events", async () => {
			const overstoryDir = join(tempDir, ".overstory");
			const sessionsDbPath = join(overstoryDir, "sessions.db");
			const eventsDbPath = join(overstoryDir, "events.db");

			const store = createSessionStore(sessionsDbPath);
			store.upsert({
				id: "sess-1",
				agentName: "builder-1",
				capability: "builder",
				worktreePath: "/tmp/wt",
				branchName: "overstory/builder-1/test",
				beadId: "overstory-001",
				tmuxSession: "overstory-test-builder-1",
				state: "working",
				pid: 12345,
				parentAgent: null,
				depth: 0,
				runId: null,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
			});
			store.close();

			const eventStore = createEventStore(eventsDbPath);
			eventStore.insert(makeEvent({ toolName: "Bash", toolArgs: '{"command": "bun test"}' }));
			eventStore.close();

			const data = await gatherInspectData(tempDir, "builder-1", { noTmux: true });

			expect(data.currentFile).toBeNull();
		});

		test("gathers recent tool calls (respects limit)", async () => {
			const overstoryDir = join(tempDir, ".overstory");
			const sessionsDbPath = join(overstoryDir, "sessions.db");
			const eventsDbPath = join(overstoryDir, "events.db");

			const store = createSessionStore(sessionsDbPath);
			store.upsert({
				id: "sess-1",
				agentName: "builder-1",
				capability: "builder",
				worktreePath: "/tmp/wt",
				branchName: "overstory/builder-1/test",
				beadId: "overstory-001",
				tmuxSession: "overstory-test-builder-1",
				state: "working",
				pid: 12345,
				parentAgent: null,
				depth: 0,
				runId: null,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
			});
			store.close();

			const eventStore = createEventStore(eventsDbPath);
			for (let i = 0; i < 30; i++) {
				eventStore.insert(
					makeEvent({
						toolName: "Read",
						toolArgs: `{"file_path": "src/file${i}.ts"}`,
						toolDurationMs: 10 + i,
					}),
				);
			}
			eventStore.close();

			const data = await gatherInspectData(tempDir, "builder-1", { noTmux: true, limit: 5 });

			expect(data.recentToolCalls.length).toBe(5);
			expect(data.recentToolCalls[0]?.toolName).toBe("Read");
		});

		test("gathers tool stats", async () => {
			const overstoryDir = join(tempDir, ".overstory");
			const sessionsDbPath = join(overstoryDir, "sessions.db");
			const eventsDbPath = join(overstoryDir, "events.db");

			const store = createSessionStore(sessionsDbPath);
			store.upsert({
				id: "sess-1",
				agentName: "builder-1",
				capability: "builder",
				worktreePath: "/tmp/wt",
				branchName: "overstory/builder-1/test",
				beadId: "overstory-001",
				tmuxSession: "overstory-test-builder-1",
				state: "working",
				pid: 12345,
				parentAgent: null,
				depth: 0,
				runId: null,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
			});
			store.close();

			const eventStore = createEventStore(eventsDbPath);
			for (let i = 0; i < 10; i++) {
				eventStore.insert(makeEvent({ toolName: "Read", toolDurationMs: 100 }));
			}
			for (let i = 0; i < 5; i++) {
				eventStore.insert(makeEvent({ toolName: "Edit", toolDurationMs: 200 }));
			}
			eventStore.close();

			const data = await gatherInspectData(tempDir, "builder-1", { noTmux: true });

			expect(data.toolStats.length).toBeGreaterThan(0);
			const readStats = data.toolStats.find((s) => s.toolName === "Read");
			expect(readStats?.count).toBe(10);
			expect(readStats?.avgDurationMs).toBe(100);
		});

		test("gathers token usage from metrics", async () => {
			const overstoryDir = join(tempDir, ".overstory");
			const sessionsDbPath = join(overstoryDir, "sessions.db");
			const metricsDbPath = join(overstoryDir, "metrics.db");

			const store = createSessionStore(sessionsDbPath);
			store.upsert({
				id: "sess-1",
				agentName: "builder-1",
				capability: "builder",
				worktreePath: "/tmp/wt",
				branchName: "overstory/builder-1/test",
				beadId: "overstory-001",
				tmuxSession: "overstory-test-builder-1",
				state: "working",
				pid: 12345,
				parentAgent: null,
				depth: 0,
				runId: null,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
			});
			store.close();

			const metricsStore = createMetricsStore(metricsDbPath);
			metricsStore.recordSession(
				makeMetrics({
					inputTokens: 5000,
					outputTokens: 3000,
					cacheReadTokens: 1000,
					cacheCreationTokens: 500,
					estimatedCostUsd: 0.123,
					modelUsed: "claude-sonnet-4-5-20250929",
				}),
			);
			metricsStore.close();

			const data = await gatherInspectData(tempDir, "builder-1", { noTmux: true });

			expect(data.tokenUsage).not.toBeNull();
			expect(data.tokenUsage?.inputTokens).toBe(5000);
			expect(data.tokenUsage?.outputTokens).toBe(3000);
			expect(data.tokenUsage?.cacheReadTokens).toBe(1000);
			expect(data.tokenUsage?.cacheCreationTokens).toBe(500);
			expect(data.tokenUsage?.estimatedCostUsd).toBe(0.123);
			expect(data.tokenUsage?.modelUsed).toBe("claude-sonnet-4-5-20250929");
		});

		test("handles missing databases gracefully", async () => {
			const overstoryDir = join(tempDir, ".overstory");
			const sessionsDbPath = join(overstoryDir, "sessions.db");

			const store = createSessionStore(sessionsDbPath);
			store.upsert({
				id: "sess-1",
				agentName: "builder-1",
				capability: "builder",
				worktreePath: "/tmp/wt",
				branchName: "overstory/builder-1/test",
				beadId: "overstory-001",
				tmuxSession: "overstory-test-builder-1",
				state: "working",
				pid: 12345,
				parentAgent: null,
				depth: 0,
				runId: null,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
			});
			store.close();

			// Don't create events.db or metrics.db
			const data = await gatherInspectData(tempDir, "builder-1", { noTmux: true });

			expect(data.recentToolCalls).toEqual([]);
			expect(data.currentFile).toBeNull();
			expect(data.toolStats).toEqual([]);
			expect(data.tokenUsage).toBeNull();
		});
	});

	// === JSON output ===

	describe("json output", () => {
		test("--json outputs valid JSON", async () => {
			const overstoryDir = join(tempDir, ".overstory");
			const sessionsDbPath = join(overstoryDir, "sessions.db");
			const store = createSessionStore(sessionsDbPath);
			store.upsert({
				id: "sess-1",
				agentName: "builder-1",
				capability: "builder",
				worktreePath: "/tmp/wt",
				branchName: "overstory/builder-1/test",
				beadId: "overstory-001",
				tmuxSession: "overstory-test-builder-1",
				state: "working",
				pid: 12345,
				parentAgent: null,
				depth: 0,
				runId: null,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
			});
			store.close();

			await inspectCommand(["builder-1", "--json", "--no-tmux"]);
			const out = output();

			const parsed = JSON.parse(out);
			expect(parsed.session.agentName).toBe("builder-1");
			expect(parsed.timeSinceLastActivity).toBeGreaterThan(0);
		});
	});

	// === Human-readable output ===

	describe("human-readable output", () => {
		test("displays agent metadata", async () => {
			const overstoryDir = join(tempDir, ".overstory");
			const sessionsDbPath = join(overstoryDir, "sessions.db");
			const store = createSessionStore(sessionsDbPath);
			store.upsert({
				id: "sess-1",
				agentName: "builder-1",
				capability: "builder",
				worktreePath: "/tmp/wt",
				branchName: "overstory/builder-1/test",
				beadId: "overstory-001",
				tmuxSession: "overstory-test-builder-1",
				state: "working",
				pid: 12345,
				parentAgent: "orchestrator",
				depth: 1,
				runId: null,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
			});
			store.close();

			await inspectCommand(["builder-1", "--no-tmux"]);
			const out = output();

			expect(out).toContain("builder-1");
			expect(out).toContain("working");
			expect(out).toContain("overstory-001");
			expect(out).toContain("builder");
			expect(out).toContain("overstory/builder-1/test");
			expect(out).toContain("orchestrator");
		});

		test("displays token usage", async () => {
			const overstoryDir = join(tempDir, ".overstory");
			const sessionsDbPath = join(overstoryDir, "sessions.db");
			const metricsDbPath = join(overstoryDir, "metrics.db");

			const store = createSessionStore(sessionsDbPath);
			store.upsert({
				id: "sess-1",
				agentName: "builder-1",
				capability: "builder",
				worktreePath: "/tmp/wt",
				branchName: "overstory/builder-1/test",
				beadId: "overstory-001",
				tmuxSession: "overstory-test-builder-1",
				state: "working",
				pid: 12345,
				parentAgent: null,
				depth: 0,
				runId: null,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
			});
			store.close();

			const metricsStore = createMetricsStore(metricsDbPath);
			metricsStore.recordSession(makeMetrics({ estimatedCostUsd: 0.123 }));
			metricsStore.close();

			await inspectCommand(["builder-1", "--no-tmux"]);
			const out = output();

			expect(out).toContain("Token Usage");
			expect(out).toContain("1,000");
			expect(out).toContain("$0.1230");
		});

		test("displays tool stats and recent calls", async () => {
			const overstoryDir = join(tempDir, ".overstory");
			const sessionsDbPath = join(overstoryDir, "sessions.db");
			const eventsDbPath = join(overstoryDir, "events.db");

			const store = createSessionStore(sessionsDbPath);
			store.upsert({
				id: "sess-1",
				agentName: "builder-1",
				capability: "builder",
				worktreePath: "/tmp/wt",
				branchName: "overstory/builder-1/test",
				beadId: "overstory-001",
				tmuxSession: "overstory-test-builder-1",
				state: "working",
				pid: 12345,
				parentAgent: null,
				depth: 0,
				runId: null,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
			});
			store.close();

			const eventStore = createEventStore(eventsDbPath);
			eventStore.insert(makeEvent({ toolName: "Read", toolDurationMs: 100 }));
			eventStore.insert(makeEvent({ toolName: "Edit", toolDurationMs: 200 }));
			eventStore.close();

			await inspectCommand(["builder-1", "--no-tmux"]);
			const out = output();

			expect(out).toContain("Tool Usage");
			expect(out).toContain("Recent Tool Calls");
			expect(out).toContain("Read");
			expect(out).toContain("Edit");
		});
	});
});
