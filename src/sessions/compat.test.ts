/**
 * Tests for the session compat shim (JSON -> SQLite migration).
 *
 * Uses real filesystem and bun:sqlite. No mocks.
 * Tests file-based migration behavior, so temp files are required (not :memory:).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSessionStore } from "./compat.ts";

let tempDir: string;
let overstoryDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "overstory-compat-test-"));
	overstoryDir = join(tempDir, ".overstory");
	const { mkdir } = await import("node:fs/promises");
	await mkdir(overstoryDir, { recursive: true });
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

/** Create a sessions.json with the given entries. */
async function writeSessionsJson(sessions: Record<string, unknown>[]): Promise<void> {
	const jsonPath = join(overstoryDir, "sessions.json");
	await writeFile(jsonPath, `${JSON.stringify(sessions, null, "\t")}\n`, "utf-8");
}

/** A valid session object as it would appear in sessions.json. */
function makeJsonSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "session-001-test-agent",
		agentName: "test-agent",
		capability: "builder",
		worktreePath: "/tmp/worktrees/test-agent",
		branchName: "overstory/test-agent/task-1",
		beadId: "task-1",
		tmuxSession: "overstory-test-agent",
		state: "working",
		pid: 12345,
		parentAgent: null,
		depth: 0,
		startedAt: "2026-01-15T10:00:00.000Z",
		lastActivity: "2026-01-15T10:05:00.000Z",
		escalationLevel: 0,
		stalledSince: null,
		...overrides,
	};
}

// === Migration from sessions.json ===

describe("openSessionStore", () => {
	test("creates empty DB when neither sessions.json nor sessions.db exist", () => {
		const { store, migrated } = openSessionStore(overstoryDir);

		expect(migrated).toBe(false);
		expect(store.getAll()).toEqual([]);
		store.close();
	});

	test("imports sessions from sessions.json when sessions.db does not exist", async () => {
		await writeSessionsJson([
			makeJsonSession({ agentName: "agent-a", id: "s-a" }),
			makeJsonSession({ agentName: "agent-b", id: "s-b", state: "completed" }),
		]);

		const { store, migrated } = openSessionStore(overstoryDir);

		expect(migrated).toBe(true);
		const all = store.getAll();
		expect(all).toHaveLength(2);

		const agentA = store.getByName("agent-a");
		expect(agentA).not.toBeNull();
		expect(agentA?.id).toBe("s-a");
		expect(agentA?.state).toBe("working");

		const agentB = store.getByName("agent-b");
		expect(agentB).not.toBeNull();
		expect(agentB?.state).toBe("completed");

		store.close();
	});

	test("migration adds runId=null when sessions.json entries lack runId", async () => {
		// Write a session WITHOUT runId (old format)
		const oldFormatSession = makeJsonSession();
		(oldFormatSession as Record<string, unknown>).runId = undefined;

		await writeSessionsJson([oldFormatSession]);

		const { store, migrated } = openSessionStore(overstoryDir);

		expect(migrated).toBe(true);
		const session = store.getByName("test-agent");
		expect(session).not.toBeNull();
		expect(session?.runId).toBeNull();

		store.close();
	});

	test("does not re-migrate when sessions.db already exists", async () => {
		// First call: create the DB with migration
		await writeSessionsJson([makeJsonSession({ agentName: "original", id: "s-1" })]);

		const { store: store1, migrated: migrated1 } = openSessionStore(overstoryDir);
		expect(migrated1).toBe(true);
		store1.close();

		// Modify sessions.json to add a new entry
		await writeSessionsJson([
			makeJsonSession({ agentName: "original", id: "s-1" }),
			makeJsonSession({ agentName: "new-agent", id: "s-2" }),
		]);

		// Second call: DB exists, so no migration
		const { store: store2, migrated: migrated2 } = openSessionStore(overstoryDir);
		expect(migrated2).toBe(false);

		// Should still have only the original session from the first migration
		const all = store2.getAll();
		expect(all).toHaveLength(1);
		expect(all[0]?.agentName).toBe("original");

		store2.close();
	});

	test("handles empty sessions.json (no migration needed)", async () => {
		await writeSessionsJson([]);

		const { store, migrated } = openSessionStore(overstoryDir);

		expect(migrated).toBe(false);
		expect(store.getAll()).toEqual([]);
		store.close();
	});

	test("handles malformed sessions.json gracefully", async () => {
		const jsonPath = join(overstoryDir, "sessions.json");
		await writeFile(jsonPath, "this is not json", "utf-8");

		const { store, migrated } = openSessionStore(overstoryDir);

		expect(migrated).toBe(false);
		expect(store.getAll()).toEqual([]);
		store.close();
	});

	test("handles sessions.json with non-array content gracefully", async () => {
		const jsonPath = join(overstoryDir, "sessions.json");
		await writeFile(jsonPath, '{"not": "an array"}', "utf-8");

		const { store, migrated } = openSessionStore(overstoryDir);

		expect(migrated).toBe(false);
		expect(store.getAll()).toEqual([]);
		store.close();
	});
});

// === Data integrity after migration ===

describe("data integrity", () => {
	test("all fields from sessions.json are preserved in SQLite", async () => {
		const fullSession = makeJsonSession({
			id: "session-full",
			agentName: "full-agent",
			capability: "scout",
			worktreePath: "/tmp/worktrees/full-agent",
			branchName: "overstory/full-agent/task-42",
			beadId: "task-42",
			tmuxSession: "overstory-full-agent",
			state: "stalled",
			pid: 99999,
			parentAgent: "lead-agent",
			depth: 2,
			startedAt: "2026-02-01T08:00:00.000Z",
			lastActivity: "2026-02-01T09:00:00.000Z",
			escalationLevel: 3,
			stalledSince: "2026-02-01T08:50:00.000Z",
		});

		await writeSessionsJson([fullSession]);

		const { store } = openSessionStore(overstoryDir);
		const result = store.getByName("full-agent");

		expect(result).not.toBeNull();
		expect(result?.id).toBe("session-full");
		expect(result?.agentName).toBe("full-agent");
		expect(result?.capability).toBe("scout");
		expect(result?.worktreePath).toBe("/tmp/worktrees/full-agent");
		expect(result?.branchName).toBe("overstory/full-agent/task-42");
		expect(result?.beadId).toBe("task-42");
		expect(result?.tmuxSession).toBe("overstory-full-agent");
		expect(result?.state).toBe("stalled");
		expect(result?.pid).toBe(99999);
		expect(result?.parentAgent).toBe("lead-agent");
		expect(result?.depth).toBe(2);
		expect(result?.runId).toBeNull(); // Not in old JSON format
		expect(result?.startedAt).toBe("2026-02-01T08:00:00.000Z");
		expect(result?.lastActivity).toBe("2026-02-01T09:00:00.000Z");
		expect(result?.escalationLevel).toBe(3);
		expect(result?.stalledSince).toBe("2026-02-01T08:50:00.000Z");

		store.close();
	});

	test("migrated store supports all SessionStore operations", async () => {
		await writeSessionsJson([
			makeJsonSession({ agentName: "agent-a", id: "s-a", state: "working" }),
			makeJsonSession({ agentName: "agent-b", id: "s-b", state: "completed" }),
		]);

		const { store } = openSessionStore(overstoryDir);

		// getActive should return only "working" sessions
		const active = store.getActive();
		expect(active).toHaveLength(1);
		expect(active[0]?.agentName).toBe("agent-a");

		// updateState should work on migrated data
		store.updateState("agent-a", "completed");
		expect(store.getByName("agent-a")?.state).toBe("completed");

		// remove should work on migrated data
		store.remove("agent-b");
		expect(store.getByName("agent-b")).toBeNull();

		store.close();
	});

	test("multiple sessions with same agent name in JSON: last one wins", async () => {
		// This edge case shouldn't happen in practice, but test defensive behavior
		await writeSessionsJson([
			makeJsonSession({ agentName: "dupe", id: "s-1", state: "booting" }),
			makeJsonSession({ agentName: "dupe", id: "s-2", state: "working" }),
		]);

		const { store } = openSessionStore(overstoryDir);

		const all = store.getAll();
		expect(all).toHaveLength(1);
		// Last upsert wins (s-2)
		expect(all[0]?.id).toBe("s-2");
		expect(all[0]?.state).toBe("working");

		store.close();
	});
});
