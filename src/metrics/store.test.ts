/**
 * Tests for MetricsStore (SQLite-backed session metrics storage).
 *
 * Uses real bun:sqlite with temp files. No mocks.
 * Philosophy: "never mock what you can use for real" (mx-252b16).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir } from "../test-helpers.ts";
import type { SessionMetrics } from "../types.ts";
import { createMetricsStore, type MetricsStore } from "./store.ts";

let tempDir: string;
let dbPath: string;
let store: MetricsStore;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "overstory-metrics-test-"));
	dbPath = join(tempDir, "metrics.db");
	store = createMetricsStore(dbPath);
});

afterEach(async () => {
	store.close();
	await cleanupTempDir(tempDir);
});

/** Helper to create a SessionMetrics object with optional overrides. */
function makeSession(overrides: Partial<SessionMetrics> = {}): SessionMetrics {
	return {
		agentName: "test-agent",
		beadId: "test-task-123",
		capability: "builder",
		startedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
		completedAt: new Date("2026-01-01T00:05:00Z").toISOString(),
		durationMs: 300_000,
		exitCode: 0,
		mergeResult: "auto-resolve",
		parentAgent: "coordinator",
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

// === recordSession ===

describe("recordSession", () => {
	test("inserts a session and retrieves it via getRecentSessions", () => {
		const session = makeSession();
		store.recordSession(session);

		const retrieved = store.getRecentSessions(10);
		expect(retrieved).toHaveLength(1);
		expect(retrieved[0]).toEqual(session);
	});

	test("INSERT OR REPLACE: same (agent_name, bead_id) key overwrites previous row", () => {
		const session1 = makeSession({ durationMs: 100_000 });
		const session2 = makeSession({ durationMs: 200_000 });

		store.recordSession(session1);
		store.recordSession(session2);

		const retrieved = store.getRecentSessions(10);
		expect(retrieved).toHaveLength(1);
		expect(retrieved[0]?.durationMs).toBe(200_000);
	});

	test("all fields roundtrip correctly (camelCase TS → snake_case SQLite → camelCase TS)", () => {
		const session = makeSession({
			agentName: "special-agent",
			beadId: "task-xyz",
			capability: "reviewer",
			startedAt: "2026-02-01T12:00:00Z",
			completedAt: "2026-02-01T12:30:00Z",
			durationMs: 1_800_000,
			exitCode: 42,
			mergeResult: "ai-resolve",
			parentAgent: "lead-agent",
		});

		store.recordSession(session);
		const retrieved = store.getRecentSessions(10);

		expect(retrieved).toHaveLength(1);
		expect(retrieved[0]).toEqual(session);
	});

	test("null fields (completedAt, exitCode, mergeResult, parentAgent) stored and retrieved as null", () => {
		const session = makeSession({
			completedAt: null,
			exitCode: null,
			mergeResult: null,
			parentAgent: null,
		});

		store.recordSession(session);
		const retrieved = store.getRecentSessions(10);

		expect(retrieved).toHaveLength(1);
		expect(retrieved[0]?.completedAt).toBeNull();
		expect(retrieved[0]?.exitCode).toBeNull();
		expect(retrieved[0]?.mergeResult).toBeNull();
		expect(retrieved[0]?.parentAgent).toBeNull();
	});
});

// === getRecentSessions ===

describe("getRecentSessions", () => {
	test("returns sessions ordered by started_at DESC (most recent first)", () => {
		const session1 = makeSession({
			beadId: "task-1",
			startedAt: "2026-01-01T10:00:00Z",
		});
		const session2 = makeSession({
			beadId: "task-2",
			startedAt: "2026-01-01T12:00:00Z",
		});
		const session3 = makeSession({
			beadId: "task-3",
			startedAt: "2026-01-01T11:00:00Z",
		});

		store.recordSession(session1);
		store.recordSession(session2);
		store.recordSession(session3);

		const retrieved = store.getRecentSessions(10);
		expect(retrieved).toHaveLength(3);
		expect(retrieved[0]?.beadId).toBe("task-2"); // most recent
		expect(retrieved[1]?.beadId).toBe("task-3");
		expect(retrieved[2]?.beadId).toBe("task-1"); // oldest
	});

	test("default limit is 20", () => {
		// Insert 25 sessions
		for (let i = 0; i < 25; i++) {
			store.recordSession(
				makeSession({
					beadId: `task-${i}`,
					startedAt: new Date(Date.now() + i * 1000).toISOString(),
				}),
			);
		}

		const retrieved = store.getRecentSessions();
		expect(retrieved).toHaveLength(20);
	});

	test("custom limit works (e.g., limit=2 returns only 2)", () => {
		store.recordSession(makeSession({ beadId: "task-1" }));
		store.recordSession(makeSession({ beadId: "task-2" }));
		store.recordSession(makeSession({ beadId: "task-3" }));

		const retrieved = store.getRecentSessions(2);
		expect(retrieved).toHaveLength(2);
	});

	test("empty DB returns empty array", () => {
		const retrieved = store.getRecentSessions(10);
		expect(retrieved).toEqual([]);
	});
});

// === getSessionsByAgent ===

describe("getSessionsByAgent", () => {
	test("filters by agent name correctly", () => {
		store.recordSession(makeSession({ agentName: "agent-a", beadId: "task-1" }));
		store.recordSession(makeSession({ agentName: "agent-b", beadId: "task-2" }));
		store.recordSession(makeSession({ agentName: "agent-a", beadId: "task-3" }));

		const retrieved = store.getSessionsByAgent("agent-a");
		expect(retrieved).toHaveLength(2);
		expect(retrieved[0]?.agentName).toBe("agent-a");
		expect(retrieved[1]?.agentName).toBe("agent-a");
	});

	test("returns empty array for unknown agent", () => {
		store.recordSession(makeSession({ agentName: "known-agent" }));

		const retrieved = store.getSessionsByAgent("unknown-agent");
		expect(retrieved).toEqual([]);
	});

	test("multiple sessions for same agent all returned, ordered by started_at DESC", () => {
		store.recordSession(
			makeSession({
				agentName: "agent-x",
				beadId: "task-1",
				startedAt: "2026-01-01T10:00:00Z",
			}),
		);
		store.recordSession(
			makeSession({
				agentName: "agent-x",
				beadId: "task-2",
				startedAt: "2026-01-01T12:00:00Z",
			}),
		);
		store.recordSession(
			makeSession({
				agentName: "agent-x",
				beadId: "task-3",
				startedAt: "2026-01-01T11:00:00Z",
			}),
		);

		const retrieved = store.getSessionsByAgent("agent-x");
		expect(retrieved).toHaveLength(3);
		expect(retrieved[0]?.beadId).toBe("task-2"); // most recent
		expect(retrieved[1]?.beadId).toBe("task-3");
		expect(retrieved[2]?.beadId).toBe("task-1"); // oldest
	});
});

// === getAverageDuration ===

describe("getAverageDuration", () => {
	test("average across all completed sessions (completedAt IS NOT NULL)", () => {
		store.recordSession(makeSession({ beadId: "task-1", durationMs: 100_000 }));
		store.recordSession(makeSession({ beadId: "task-2", durationMs: 200_000 }));
		store.recordSession(makeSession({ beadId: "task-3", durationMs: 300_000 }));

		const avg = store.getAverageDuration();
		expect(avg).toBe(200_000);
	});

	test("average filtered by capability", () => {
		store.recordSession(
			makeSession({ beadId: "task-1", capability: "builder", durationMs: 100_000 }),
		);
		store.recordSession(makeSession({ beadId: "task-2", capability: "scout", durationMs: 50_000 }));
		store.recordSession(
			makeSession({ beadId: "task-3", capability: "builder", durationMs: 200_000 }),
		);

		const avgBuilder = store.getAverageDuration("builder");
		const avgScout = store.getAverageDuration("scout");

		expect(avgBuilder).toBe(150_000);
		expect(avgScout).toBe(50_000);
	});

	test("returns 0 when no completed sessions exist", () => {
		const avg = store.getAverageDuration();
		expect(avg).toBe(0);
	});

	test("sessions with completedAt=null are excluded from average", () => {
		store.recordSession(makeSession({ beadId: "task-1", durationMs: 100_000, completedAt: null }));
		store.recordSession(makeSession({ beadId: "task-2", durationMs: 200_000 }));
		store.recordSession(makeSession({ beadId: "task-3", durationMs: 300_000 }));

		const avg = store.getAverageDuration();
		expect(avg).toBe(250_000); // (200_000 + 300_000) / 2
	});

	test("single session returns that session's duration", () => {
		store.recordSession(makeSession({ durationMs: 123_456 }));

		const avg = store.getAverageDuration();
		expect(avg).toBe(123_456);
	});
});

// === token fields ===

describe("token fields", () => {
	test("token data roundtrips correctly", () => {
		const session = makeSession({
			inputTokens: 15_000,
			outputTokens: 3_000,
			cacheReadTokens: 100_000,
			cacheCreationTokens: 10_000,
			estimatedCostUsd: 1.23,
			modelUsed: "claude-opus-4-6",
		});

		store.recordSession(session);
		const retrieved = store.getRecentSessions(10);

		expect(retrieved).toHaveLength(1);
		expect(retrieved[0]?.inputTokens).toBe(15_000);
		expect(retrieved[0]?.outputTokens).toBe(3_000);
		expect(retrieved[0]?.cacheReadTokens).toBe(100_000);
		expect(retrieved[0]?.cacheCreationTokens).toBe(10_000);
		expect(retrieved[0]?.estimatedCostUsd).toBeCloseTo(1.23, 2);
		expect(retrieved[0]?.modelUsed).toBe("claude-opus-4-6");
	});

	test("token fields default to 0 and cost/model default to null", () => {
		const session = makeSession();

		store.recordSession(session);
		const retrieved = store.getRecentSessions(10);

		expect(retrieved).toHaveLength(1);
		expect(retrieved[0]?.inputTokens).toBe(0);
		expect(retrieved[0]?.outputTokens).toBe(0);
		expect(retrieved[0]?.cacheReadTokens).toBe(0);
		expect(retrieved[0]?.cacheCreationTokens).toBe(0);
		expect(retrieved[0]?.estimatedCostUsd).toBeNull();
		expect(retrieved[0]?.modelUsed).toBeNull();
	});

	test("migration adds token columns to existing table without them", () => {
		// Close the current store which has the new schema
		store.close();

		// Create a DB with the old schema (no token columns)
		const { Database } = require("bun:sqlite");
		const oldDb = new Database(dbPath);
		oldDb.exec("DROP TABLE IF EXISTS sessions");
		oldDb.exec(`
			CREATE TABLE sessions (
				agent_name TEXT NOT NULL,
				bead_id TEXT NOT NULL,
				capability TEXT NOT NULL,
				started_at TEXT NOT NULL,
				completed_at TEXT,
				duration_ms INTEGER NOT NULL DEFAULT 0,
				exit_code INTEGER,
				merge_result TEXT,
				parent_agent TEXT,
				PRIMARY KEY (agent_name, bead_id)
			)
		`);
		// Insert a row with old schema
		oldDb.exec(`
			INSERT INTO sessions (agent_name, bead_id, capability, started_at, duration_ms)
			VALUES ('old-agent', 'old-task', 'builder', '2026-01-01T00:00:00Z', 100000)
		`);
		oldDb.close();

		// Re-open with createMetricsStore which should migrate
		store = createMetricsStore(dbPath);

		// The old row should still be readable with token defaults
		const sessions = store.getRecentSessions(10);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.agentName).toBe("old-agent");
		expect(sessions[0]?.inputTokens).toBe(0);
		expect(sessions[0]?.outputTokens).toBe(0);
		expect(sessions[0]?.estimatedCostUsd).toBeNull();
		expect(sessions[0]?.modelUsed).toBeNull();

		// New rows with token data should work
		store.recordSession(
			makeSession({
				agentName: "new-agent",
				beadId: "new-task",
				inputTokens: 5000,
				outputTokens: 1000,
				estimatedCostUsd: 0.42,
				modelUsed: "claude-sonnet-4-20250514",
			}),
		);

		const newSessions = store.getSessionsByAgent("new-agent");
		expect(newSessions).toHaveLength(1);
		expect(newSessions[0]?.inputTokens).toBe(5000);
		expect(newSessions[0]?.estimatedCostUsd).toBeCloseTo(0.42, 2);
	});
});

// === getSessionsByRun ===

describe("getSessionsByRun", () => {
	test("returns sessions matching run_id", () => {
		store.recordSession(makeSession({ agentName: "a1", beadId: "t1", runId: "run-001" }));
		store.recordSession(makeSession({ agentName: "a2", beadId: "t2", runId: "run-001" }));
		store.recordSession(makeSession({ agentName: "a3", beadId: "t3", runId: "run-002" }));

		const sessions = store.getSessionsByRun("run-001");
		expect(sessions).toHaveLength(2);
		expect(sessions.every((s) => s.runId === "run-001")).toBe(true);
	});

	test("returns empty array for unknown run_id", () => {
		store.recordSession(makeSession({ agentName: "a1", beadId: "t1", runId: "run-001" }));
		expect(store.getSessionsByRun("run-nonexistent")).toEqual([]);
	});

	test("sessions with null run_id are not returned", () => {
		store.recordSession(makeSession({ agentName: "a1", beadId: "t1", runId: null }));
		store.recordSession(makeSession({ agentName: "a2", beadId: "t2", runId: "run-001" }));
		expect(store.getSessionsByRun("run-001")).toHaveLength(1);
	});
});

// === purge ===

describe("purge", () => {
	test("purge all deletes everything and returns count", () => {
		store.recordSession(makeSession({ agentName: "agent-a", beadId: "task-1" }));
		store.recordSession(makeSession({ agentName: "agent-b", beadId: "task-2" }));
		store.recordSession(makeSession({ agentName: "agent-c", beadId: "task-3" }));

		const count = store.purge({ all: true });
		expect(count).toBe(3);
		expect(store.getRecentSessions(10)).toEqual([]);
	});

	test("purge by agent deletes only that agent's records", () => {
		store.recordSession(makeSession({ agentName: "agent-a", beadId: "task-1" }));
		store.recordSession(makeSession({ agentName: "agent-b", beadId: "task-2" }));
		store.recordSession(makeSession({ agentName: "agent-a", beadId: "task-3" }));

		const count = store.purge({ agent: "agent-a" });
		expect(count).toBe(2);

		const remaining = store.getRecentSessions(10);
		expect(remaining).toHaveLength(1);
		expect(remaining[0]?.agentName).toBe("agent-b");
	});

	test("purge on empty DB returns 0", () => {
		const count = store.purge({ all: true });
		expect(count).toBe(0);
	});

	test("purge with no options returns 0 without deleting", () => {
		store.recordSession(makeSession({ beadId: "task-1" }));

		const count = store.purge({});
		expect(count).toBe(0);
		expect(store.getRecentSessions(10)).toHaveLength(1);
	});
});

// === token snapshots ===

describe("token snapshots", () => {
	test("recordSnapshot inserts and can be retrieved via getLatestSnapshots", () => {
		const snapshot = {
			agentName: "test-agent",
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadTokens: 200,
			cacheCreationTokens: 100,
			estimatedCostUsd: 0.15,
			modelUsed: "claude-sonnet-4-5",
			createdAt: new Date().toISOString(),
		};

		store.recordSnapshot(snapshot);

		const snapshots = store.getLatestSnapshots();
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]?.agentName).toBe("test-agent");
		expect(snapshots[0]?.inputTokens).toBe(1000);
		expect(snapshots[0]?.outputTokens).toBe(500);
		expect(snapshots[0]?.estimatedCostUsd).toBeCloseTo(0.15, 2);
	});

	test("getLatestSnapshots returns one row per agent (the most recent)", () => {
		const now = Date.now();
		store.recordSnapshot({
			agentName: "agent-a",
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			estimatedCostUsd: 0.01,
			modelUsed: "claude-sonnet-4-5",
			createdAt: new Date(now - 60_000).toISOString(), // 1 min ago
		});

		store.recordSnapshot({
			agentName: "agent-a",
			inputTokens: 200,
			outputTokens: 100,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			estimatedCostUsd: 0.02,
			modelUsed: "claude-sonnet-4-5",
			createdAt: new Date(now).toISOString(), // now (most recent)
		});

		store.recordSnapshot({
			agentName: "agent-b",
			inputTokens: 300,
			outputTokens: 150,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			estimatedCostUsd: 0.03,
			modelUsed: "claude-sonnet-4-5",
			createdAt: new Date(now - 30_000).toISOString(), // 30s ago
		});

		const snapshots = store.getLatestSnapshots();
		expect(snapshots).toHaveLength(2); // one per agent

		const agentASnapshot = snapshots.find((s) => s.agentName === "agent-a");
		const agentBSnapshot = snapshots.find((s) => s.agentName === "agent-b");

		expect(agentASnapshot?.inputTokens).toBe(200); // most recent for agent-a
		expect(agentBSnapshot?.inputTokens).toBe(300);
	});

	test("getLatestSnapshotTime returns the most recent timestamp for an agent", () => {
		const now = Date.now();
		const time1 = new Date(now - 60_000).toISOString();
		const time2 = new Date(now).toISOString();

		store.recordSnapshot({
			agentName: "test-agent",
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			estimatedCostUsd: null,
			modelUsed: null,
			createdAt: time1,
		});

		store.recordSnapshot({
			agentName: "test-agent",
			inputTokens: 200,
			outputTokens: 100,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			estimatedCostUsd: null,
			modelUsed: null,
			createdAt: time2,
		});

		const latestTime = store.getLatestSnapshotTime("test-agent");
		expect(latestTime).toBe(time2);
	});

	test("getLatestSnapshotTime returns null for unknown agent", () => {
		const latestTime = store.getLatestSnapshotTime("unknown-agent");
		expect(latestTime).toBeNull();
	});

	test("purgeSnapshots with all=true deletes everything", () => {
		store.recordSnapshot({
			agentName: "agent-a",
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			estimatedCostUsd: null,
			modelUsed: null,
			createdAt: new Date().toISOString(),
		});

		store.recordSnapshot({
			agentName: "agent-b",
			inputTokens: 200,
			outputTokens: 100,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			estimatedCostUsd: null,
			modelUsed: null,
			createdAt: new Date().toISOString(),
		});

		const count = store.purgeSnapshots({ all: true });
		expect(count).toBe(2);
		expect(store.getLatestSnapshots()).toEqual([]);
	});

	test("purgeSnapshots with agent filter deletes only that agent", () => {
		store.recordSnapshot({
			agentName: "agent-a",
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			estimatedCostUsd: null,
			modelUsed: null,
			createdAt: new Date().toISOString(),
		});

		store.recordSnapshot({
			agentName: "agent-b",
			inputTokens: 200,
			outputTokens: 100,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			estimatedCostUsd: null,
			modelUsed: null,
			createdAt: new Date().toISOString(),
		});

		const count = store.purgeSnapshots({ agent: "agent-a" });
		expect(count).toBe(1);

		const remaining = store.getLatestSnapshots();
		expect(remaining).toHaveLength(1);
		expect(remaining[0]?.agentName).toBe("agent-b");
	});

	test("purgeSnapshots with olderThanMs deletes old snapshots", () => {
		const now = Date.now();
		store.recordSnapshot({
			agentName: "agent-a",
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			estimatedCostUsd: null,
			modelUsed: null,
			createdAt: new Date(now - 120_000).toISOString(), // 2 min ago
		});

		store.recordSnapshot({
			agentName: "agent-b",
			inputTokens: 200,
			outputTokens: 100,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			estimatedCostUsd: null,
			modelUsed: null,
			createdAt: new Date(now - 10_000).toISOString(), // 10s ago (recent)
		});

		const count = store.purgeSnapshots({ olderThanMs: 60_000 }); // delete older than 1 min
		expect(count).toBe(1); // only the 2-min-old one

		const remaining = store.getLatestSnapshots();
		expect(remaining).toHaveLength(1);
		expect(remaining[0]?.agentName).toBe("agent-b");
	});

	test("table creation is idempotent (re-opening store does not fail)", () => {
		store.recordSnapshot({
			agentName: "test-agent",
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			estimatedCostUsd: null,
			modelUsed: null,
			createdAt: new Date().toISOString(),
		});

		store.close();

		// Re-open and verify data persists
		store = createMetricsStore(dbPath);
		const snapshots = store.getLatestSnapshots();
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]?.agentName).toBe("test-agent");
	});
});

// === close ===

describe("close", () => {
	test("calling close does not throw", () => {
		expect(() => store.close()).not.toThrow();
	});
});
