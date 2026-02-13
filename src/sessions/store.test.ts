/**
 * Tests for SessionStore (SQLite-backed agent session tracking).
 *
 * Uses real bun:sqlite with temp files. No mocks.
 * Temp files (not :memory:) because file-based migration must be tested.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, AgentState } from "../types.ts";
import { type SessionStore, createSessionStore } from "./store.ts";

let tempDir: string;
let dbPath: string;
let store: SessionStore;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "overstory-sessions-test-"));
	dbPath = join(tempDir, "sessions.db");
	store = createSessionStore(dbPath);
});

afterEach(async () => {
	store.close();
	await rm(tempDir, { recursive: true, force: true });
});

/** Helper to create an AgentSession with optional overrides. */
function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		id: "session-001-test-agent",
		agentName: "test-agent",
		capability: "builder",
		worktreePath: "/tmp/worktrees/test-agent",
		branchName: "overstory/test-agent/task-1",
		beadId: "task-1",
		tmuxSession: "overstory-test-agent",
		state: "booting",
		pid: 12345,
		parentAgent: null,
		depth: 0,
		runId: null,
		startedAt: "2026-01-15T10:00:00.000Z",
		lastActivity: "2026-01-15T10:00:00.000Z",
		escalationLevel: 0,
		stalledSince: null,
		...overrides,
	};
}

// === upsert ===

describe("upsert", () => {
	test("inserts a new session", () => {
		const session = makeSession();
		store.upsert(session);

		const result = store.getByName("test-agent");
		expect(result).not.toBeNull();
		expect(result).toEqual(session);
	});

	test("updates an existing session with the same agent name", () => {
		store.upsert(makeSession({ state: "booting" }));
		store.upsert(makeSession({ id: "session-002-test-agent", state: "working" }));

		const all = store.getAll();
		expect(all).toHaveLength(1);

		const result = store.getByName("test-agent");
		expect(result?.state).toBe("working");
		expect(result?.id).toBe("session-002-test-agent");
	});

	test("all fields roundtrip correctly (camelCase TS -> snake_case SQLite -> camelCase TS)", () => {
		const session = makeSession({
			id: "session-full-roundtrip",
			agentName: "roundtrip-agent",
			capability: "scout",
			worktreePath: "/tmp/worktrees/roundtrip",
			branchName: "overstory/roundtrip-agent/task-42",
			beadId: "task-42",
			tmuxSession: "overstory-roundtrip-agent",
			state: "working",
			pid: 99999,
			parentAgent: "lead-agent",
			depth: 2,
			runId: "run-abc-123",
			startedAt: "2026-02-01T08:30:00.000Z",
			lastActivity: "2026-02-01T09:00:00.000Z",
			escalationLevel: 2,
			stalledSince: "2026-02-01T08:50:00.000Z",
		});

		store.upsert(session);
		const result = store.getByName("roundtrip-agent");
		expect(result).toEqual(session);
	});

	test("handles null pid", () => {
		const session = makeSession({ pid: null });
		store.upsert(session);

		const result = store.getByName("test-agent");
		expect(result?.pid).toBeNull();
	});

	test("handles null parentAgent", () => {
		const session = makeSession({ parentAgent: null });
		store.upsert(session);

		const result = store.getByName("test-agent");
		expect(result?.parentAgent).toBeNull();
	});

	test("handles null runId", () => {
		const session = makeSession({ runId: null });
		store.upsert(session);

		const result = store.getByName("test-agent");
		expect(result?.runId).toBeNull();
	});

	test("handles null stalledSince", () => {
		const session = makeSession({ stalledSince: null });
		store.upsert(session);

		const result = store.getByName("test-agent");
		expect(result?.stalledSince).toBeNull();
	});

	test("rejects invalid state values via CHECK constraint", () => {
		const session = makeSession();
		// Force an invalid state to test the CHECK constraint
		const badSession = { ...session, state: "invalid" as AgentState };
		expect(() => store.upsert(badSession)).toThrow();
	});
});

// === getByName ===

describe("getByName", () => {
	test("returns null for nonexistent agent", () => {
		const result = store.getByName("nonexistent");
		expect(result).toBeNull();
	});

	test("returns the correct session when multiple exist", () => {
		store.upsert(makeSession({ agentName: "agent-a", id: "s-a" }));
		store.upsert(makeSession({ agentName: "agent-b", id: "s-b" }));
		store.upsert(makeSession({ agentName: "agent-c", id: "s-c" }));

		const result = store.getByName("agent-b");
		expect(result?.id).toBe("s-b");
		expect(result?.agentName).toBe("agent-b");
	});
});

// === getActive ===

describe("getActive", () => {
	test("returns empty array when no sessions exist", () => {
		const result = store.getActive();
		expect(result).toEqual([]);
	});

	test("returns booting, working, and stalled sessions", () => {
		store.upsert(makeSession({ agentName: "booting-1", id: "s-1", state: "booting" }));
		store.upsert(makeSession({ agentName: "working-1", id: "s-2", state: "working" }));
		store.upsert(makeSession({ agentName: "stalled-1", id: "s-3", state: "stalled" }));

		const result = store.getActive();
		expect(result).toHaveLength(3);

		const states = result.map((s) => s.state);
		expect(states).toContain("booting");
		expect(states).toContain("working");
		expect(states).toContain("stalled");
	});

	test("excludes completed and zombie sessions", () => {
		store.upsert(makeSession({ agentName: "working-1", id: "s-1", state: "working" }));
		store.upsert(makeSession({ agentName: "completed-1", id: "s-2", state: "completed" }));
		store.upsert(makeSession({ agentName: "zombie-1", id: "s-3", state: "zombie" }));

		const result = store.getActive();
		expect(result).toHaveLength(1);
		expect(result[0]?.agentName).toBe("working-1");
	});

	test("results are ordered by started_at ascending", () => {
		store.upsert(
			makeSession({
				agentName: "late",
				id: "s-2",
				state: "working",
				startedAt: "2026-01-15T12:00:00.000Z",
			}),
		);
		store.upsert(
			makeSession({
				agentName: "early",
				id: "s-1",
				state: "working",
				startedAt: "2026-01-15T10:00:00.000Z",
			}),
		);

		const result = store.getActive();
		expect(result[0]?.agentName).toBe("early");
		expect(result[1]?.agentName).toBe("late");
	});
});

// === getAll ===

describe("getAll", () => {
	test("returns empty array when no sessions exist", () => {
		expect(store.getAll()).toEqual([]);
	});

	test("returns all sessions regardless of state", () => {
		store.upsert(makeSession({ agentName: "a1", id: "s-1", state: "booting" }));
		store.upsert(makeSession({ agentName: "a2", id: "s-2", state: "completed" }));
		store.upsert(makeSession({ agentName: "a3", id: "s-3", state: "zombie" }));

		const result = store.getAll();
		expect(result).toHaveLength(3);
	});
});

// === getByRun ===

describe("getByRun", () => {
	test("returns empty array for unknown run", () => {
		expect(store.getByRun("nonexistent-run")).toEqual([]);
	});

	test("returns only sessions with matching runId", () => {
		store.upsert(makeSession({ agentName: "a1", id: "s-1", runId: "run-1" }));
		store.upsert(makeSession({ agentName: "a2", id: "s-2", runId: "run-1" }));
		store.upsert(makeSession({ agentName: "a3", id: "s-3", runId: "run-2" }));
		store.upsert(makeSession({ agentName: "a4", id: "s-4", runId: null }));

		const result = store.getByRun("run-1");
		expect(result).toHaveLength(2);
		expect(result.map((s) => s.agentName).sort()).toEqual(["a1", "a2"]);
	});
});

// === updateState ===

describe("updateState", () => {
	test("updates state of an existing session", () => {
		store.upsert(makeSession({ state: "booting" }));

		store.updateState("test-agent", "working");

		const result = store.getByName("test-agent");
		expect(result?.state).toBe("working");
	});

	test("is a no-op for nonexistent agent (does not throw)", () => {
		// Should not throw
		store.updateState("nonexistent", "completed");
	});

	test("rejects invalid state via CHECK constraint", () => {
		store.upsert(makeSession());
		expect(() => store.updateState("test-agent", "invalid" as AgentState)).toThrow();
	});
});

// === updateLastActivity ===

describe("updateLastActivity", () => {
	test("updates lastActivity to a recent ISO timestamp", () => {
		const oldTime = "2026-01-01T00:00:00.000Z";
		store.upsert(makeSession({ lastActivity: oldTime }));

		const before = new Date().toISOString();
		store.updateLastActivity("test-agent");
		const after = new Date().toISOString();

		const result = store.getByName("test-agent");
		expect(result).not.toBeNull();
		const updatedActivity = result?.lastActivity ?? "";
		// The updated timestamp should be between before and after
		expect(updatedActivity >= before).toBe(true);
		expect(updatedActivity <= after).toBe(true);
	});

	test("does not modify other fields", () => {
		const original = makeSession({ state: "working", escalationLevel: 2 });
		store.upsert(original);

		store.updateLastActivity("test-agent");

		const result = store.getByName("test-agent");
		expect(result?.state).toBe("working");
		expect(result?.escalationLevel).toBe(2);
		expect(result?.id).toBe(original.id);
	});
});

// === updateEscalation ===

describe("updateEscalation", () => {
	test("updates escalation level and stalled timestamp", () => {
		store.upsert(makeSession({ escalationLevel: 0, stalledSince: null }));

		const stalledTime = "2026-01-15T10:30:00.000Z";
		store.updateEscalation("test-agent", 2, stalledTime);

		const result = store.getByName("test-agent");
		expect(result?.escalationLevel).toBe(2);
		expect(result?.stalledSince).toBe(stalledTime);
	});

	test("can clear stalledSince by passing null", () => {
		const stalledTime = "2026-01-15T10:30:00.000Z";
		store.upsert(makeSession({ escalationLevel: 2, stalledSince: stalledTime }));

		store.updateEscalation("test-agent", 0, null);

		const result = store.getByName("test-agent");
		expect(result?.escalationLevel).toBe(0);
		expect(result?.stalledSince).toBeNull();
	});
});

// === remove ===

describe("remove", () => {
	test("removes an existing session", () => {
		store.upsert(makeSession());

		store.remove("test-agent");

		const result = store.getByName("test-agent");
		expect(result).toBeNull();
	});

	test("is a no-op for nonexistent agent", () => {
		// Should not throw
		store.remove("nonexistent");
		expect(store.getAll()).toEqual([]);
	});

	test("does not affect other sessions", () => {
		store.upsert(makeSession({ agentName: "keep-me", id: "s-1" }));
		store.upsert(makeSession({ agentName: "remove-me", id: "s-2" }));

		store.remove("remove-me");

		expect(store.getAll()).toHaveLength(1);
		expect(store.getByName("keep-me")).not.toBeNull();
	});
});

// === purge ===

describe("purge", () => {
	test("purge({ all: true }) removes all sessions and returns count", () => {
		store.upsert(makeSession({ agentName: "a1", id: "s-1" }));
		store.upsert(makeSession({ agentName: "a2", id: "s-2" }));
		store.upsert(makeSession({ agentName: "a3", id: "s-3" }));

		const count = store.purge({ all: true });
		expect(count).toBe(3);
		expect(store.getAll()).toEqual([]);
	});

	test("purge({ state }) removes only sessions with that state", () => {
		store.upsert(makeSession({ agentName: "a1", id: "s-1", state: "completed" }));
		store.upsert(makeSession({ agentName: "a2", id: "s-2", state: "working" }));
		store.upsert(makeSession({ agentName: "a3", id: "s-3", state: "completed" }));

		const count = store.purge({ state: "completed" });
		expect(count).toBe(2);
		expect(store.getAll()).toHaveLength(1);
		expect(store.getByName("a2")?.state).toBe("working");
	});

	test("purge({ agent }) removes only the specified agent", () => {
		store.upsert(makeSession({ agentName: "target", id: "s-1" }));
		store.upsert(makeSession({ agentName: "bystander", id: "s-2" }));

		const count = store.purge({ agent: "target" });
		expect(count).toBe(1);
		expect(store.getByName("target")).toBeNull();
		expect(store.getByName("bystander")).not.toBeNull();
	});

	test("purge({ state, agent }) combines filters with AND", () => {
		store.upsert(makeSession({ agentName: "a1", id: "s-1", state: "completed" }));
		store.upsert(makeSession({ agentName: "a2", id: "s-2", state: "working" }));

		// Only purge if agent is "a1" AND state is "completed"
		const count = store.purge({ state: "completed", agent: "a1" });
		expect(count).toBe(1);
		expect(store.getAll()).toHaveLength(1);
	});

	test("purge with no matching criteria returns 0", () => {
		store.upsert(makeSession());
		const count = store.purge({});
		expect(count).toBe(0);
		expect(store.getAll()).toHaveLength(1);
	});

	test("purge({ all: true }) returns 0 on empty database", () => {
		const count = store.purge({ all: true });
		expect(count).toBe(0);
	});
});

// === close ===

describe("close", () => {
	test("close does not throw when called on open store", () => {
		store.upsert(makeSession());
		// Should not throw
		expect(() => store.close()).not.toThrow();
	});
});

// === concurrent access / file-based behavior ===

describe("file-based database", () => {
	test("data persists across separate store instances", () => {
		const session = makeSession();
		store.upsert(session);
		store.close();

		// Open a new store on the same file
		const store2 = createSessionStore(dbPath);
		const result = store2.getByName("test-agent");
		expect(result).toEqual(session);
		store2.close();

		// Re-assign store so afterEach cleanup does not double-close
		store = createSessionStore(join(tempDir, "unused.db"));
	});

	test("schema is created idempotently (opening same db twice is safe)", () => {
		store.upsert(makeSession());
		store.close();

		// Re-open -- should not fail even though table/indexes already exist
		const store2 = createSessionStore(dbPath);
		const result = store2.getAll();
		expect(result).toHaveLength(1);
		store2.close();

		store = createSessionStore(join(tempDir, "unused.db"));
	});
});

// === agent_name UNIQUE constraint ===

describe("agent_name uniqueness", () => {
	test("UNIQUE constraint on agent_name allows upsert to work correctly", () => {
		store.upsert(makeSession({ agentName: "unique-agent", id: "s-1", state: "booting" }));
		store.upsert(makeSession({ agentName: "unique-agent", id: "s-2", state: "working" }));

		const all = store.getAll();
		expect(all).toHaveLength(1);
		expect(all[0]?.id).toBe("s-2");
		expect(all[0]?.state).toBe("working");
	});
});

// === edge cases ===

describe("edge cases", () => {
	test("handles many sessions efficiently", () => {
		for (let i = 0; i < 100; i++) {
			store.upsert(
				makeSession({
					agentName: `agent-${i}`,
					id: `session-${i}`,
					state: i % 3 === 0 ? "completed" : "working",
				}),
			);
		}

		const all = store.getAll();
		expect(all).toHaveLength(100);

		const active = store.getActive();
		// 34 completed (0,3,6,...,99) + 66 working. Active = working only since no booting/stalled
		expect(active.length).toBeGreaterThan(0);
		expect(active.every((s) => s.state !== "completed" && s.state !== "zombie")).toBe(true);
	});

	test("special characters in agent name and worktree path", () => {
		const session = makeSession({
			agentName: "agent-with-special_chars.v2",
			worktreePath: "/tmp/path with spaces/worktree",
			branchName: "overstory/agent-with-special_chars.v2/task-1",
		});

		store.upsert(session);

		const result = store.getByName("agent-with-special_chars.v2");
		expect(result?.worktreePath).toBe("/tmp/path with spaces/worktree");
	});

	test("empty string fields are stored correctly", () => {
		const session = makeSession({ beadId: "", capability: "builder" });
		store.upsert(session);

		const result = store.getByName("test-agent");
		expect(result?.beadId).toBe("");
	});
});
