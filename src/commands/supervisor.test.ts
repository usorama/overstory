import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "../types.ts";
import {
	buildSupervisorBeacon,
	loadSessions,
	saveSessions,
	supervisorCommand,
} from "./supervisor.ts";

/**
 * Tests for supervisor command functions.
 *
 * We test file-based functions (loadSessions, saveSessions) and beacon generation
 * directly. Full supervisorCommand integration (tmux, bead validation) is tested via E2E.
 */

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "supervisor-test-"));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

/**
 * Helper to create a full AgentSession object with sensible defaults.
 */
function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		id: "session-123-test-supervisor",
		agentName: "test-supervisor",
		capability: "supervisor",
		worktreePath: "/tmp/project",
		branchName: "main",
		beadId: "task-1",
		tmuxSession: "overstory-supervisor-test-supervisor",
		state: "working",
		pid: 12345,
		parentAgent: "coordinator",
		depth: 1,
		runId: null,
		startedAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
		escalationLevel: 0,
		stalledSince: null,
		...overrides,
	};
}

describe("loadSessions", () => {
	test("returns empty array when file does not exist", async () => {
		const sessionsPath = join(tempDir, "sessions.json");
		const sessions = await loadSessions(sessionsPath);
		expect(sessions).toEqual([]);
	});

	test("returns empty array for malformed JSON", async () => {
		const sessionsPath = join(tempDir, "sessions.json");
		await Bun.write(sessionsPath, "{ malformed json ]");
		const sessions = await loadSessions(sessionsPath);
		expect(sessions).toEqual([]);
	});

	test("returns sessions from valid JSON file", async () => {
		const sessionsPath = join(tempDir, "sessions.json");
		const expected = [makeSession(), makeSession({ agentName: "supervisor-2" })];
		await Bun.write(sessionsPath, JSON.stringify(expected));
		const sessions = await loadSessions(sessionsPath);
		expect(sessions).toEqual(expected);
	});

	test("returns empty array for empty file", async () => {
		const sessionsPath = join(tempDir, "sessions.json");
		await Bun.write(sessionsPath, "");
		const sessions = await loadSessions(sessionsPath);
		expect(sessions).toEqual([]);
	});
});

describe("saveSessions", () => {
	test("writes valid JSON with trailing newline", async () => {
		const sessionsPath = join(tempDir, "sessions.json");
		const sessions = [makeSession()];
		await saveSessions(sessionsPath, sessions);

		const file = Bun.file(sessionsPath);
		const content = await file.text();

		// Should be valid JSON
		const parsed = JSON.parse(content);
		expect(parsed).toEqual(sessions);

		// Should have trailing newline
		expect(content.endsWith("\n")).toBe(true);

		// Should be tab-indented (check for tab character)
		expect(content).toContain("\t");
	});

	test("overwrites existing file", async () => {
		const sessionsPath = join(tempDir, "sessions.json");

		// Write initial data
		await saveSessions(sessionsPath, [makeSession()]);

		// Overwrite with new data
		const newSessions = [makeSession({ agentName: "supervisor-2" })];
		await saveSessions(sessionsPath, newSessions);

		// Verify overwrite
		const sessions = await loadSessions(sessionsPath);
		expect(sessions).toEqual(newSessions);
		expect(sessions.length).toBe(1);
		expect(sessions[0]?.agentName).toBe("supervisor-2");
	});

	test("writes empty array correctly", async () => {
		const sessionsPath = join(tempDir, "sessions.json");
		await saveSessions(sessionsPath, []);

		const file = Bun.file(sessionsPath);
		const content = await file.text();

		expect(JSON.parse(content)).toEqual([]);
		expect(content.endsWith("\n")).toBe(true);
	});

	test("round-trips with loadSessions", async () => {
		const sessionsPath = join(tempDir, "sessions.json");
		const original = [
			makeSession(),
			makeSession({ agentName: "supervisor-2", depth: 2, parentAgent: "lead-1" }),
		];

		// Write then read back
		await saveSessions(sessionsPath, original);
		const loaded = await loadSessions(sessionsPath);

		expect(loaded).toEqual(original);
	});
});

describe("buildSupervisorBeacon", () => {
	test("contains agent name and beadId from opts", () => {
		const beacon = buildSupervisorBeacon({
			name: "supervisor-1",
			beadId: "task-abc123",
			depth: 1,
			parent: "coordinator",
		});

		expect(beacon).toContain("supervisor-1");
		expect(beacon).toContain("task-abc123");
	});

	test("contains [OVERSTORY] prefix", () => {
		const beacon = buildSupervisorBeacon({
			name: "supervisor-1",
			beadId: "task-1",
			depth: 1,
			parent: "coordinator",
		});

		expect(beacon).toContain("[OVERSTORY]");
	});

	test("contains (supervisor) designation", () => {
		const beacon = buildSupervisorBeacon({
			name: "supervisor-1",
			beadId: "task-1",
			depth: 1,
			parent: "coordinator",
		});

		expect(beacon).toContain("(supervisor)");
	});

	test("contains depth and parent info from opts", () => {
		const beacon = buildSupervisorBeacon({
			name: "supervisor-1",
			beadId: "task-1",
			depth: 2,
			parent: "lead-cli",
		});

		expect(beacon).toContain("Depth: 2");
		expect(beacon).toContain("Parent: lead-cli");
	});

	test("contains startup instructions", () => {
		const beacon = buildSupervisorBeacon({
			name: "supervisor-1",
			beadId: "task-1",
			depth: 1,
			parent: "coordinator",
		});

		// Should include mulch prime
		expect(beacon).toContain("mulch prime");

		// Should include mail check with agent name
		expect(beacon).toContain("overstory mail check --agent supervisor-1");

		// Should include bd show with beadId
		expect(beacon).toContain("bd show task-1");
	});

	test("contains ISO timestamp", () => {
		const before = new Date();
		const beacon = buildSupervisorBeacon({
			name: "supervisor-1",
			beadId: "task-1",
			depth: 1,
			parent: "coordinator",
		});
		const after = new Date();

		// Extract timestamp from beacon (format: [OVERSTORY] {name} (supervisor) {timestamp} task:{beadId})
		const timestampMatch = beacon.match(/\(supervisor\)\s+(\S+)\s+task:/);
		expect(timestampMatch).toBeTruthy();

		if (timestampMatch?.[1]) {
			const timestamp = new Date(timestampMatch[1]);
			expect(timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
			expect(timestamp.getTime()).toBeLessThanOrEqual(after.getTime());

			// Verify ISO format (should parse correctly)
			expect(timestamp.toISOString()).toBeTruthy();
		}
	});
});

describe("supervisorCommand", () => {
	test("--help prints help containing required keywords", async () => {
		const originalWrite = process.stdout.write;
		let output = "";
		process.stdout.write = ((chunk: string) => {
			output += chunk;
			return true;
		}) as typeof process.stdout.write;

		try {
			await supervisorCommand(["--help"]);
			expect(output).toContain("overstory supervisor");
			expect(output).toContain("start");
			expect(output).toContain("stop");
			expect(output).toContain("status");
			expect(output).toContain("--task");
			expect(output).toContain("--name");
		} finally {
			process.stdout.write = originalWrite;
		}
	});

	test("-h prints help", async () => {
		const originalWrite = process.stdout.write;
		let output = "";
		process.stdout.write = ((chunk: string) => {
			output += chunk;
			return true;
		}) as typeof process.stdout.write;

		try {
			await supervisorCommand(["-h"]);
			expect(output).toContain("overstory supervisor");
		} finally {
			process.stdout.write = originalWrite;
		}
	});

	test("empty args [] shows help", async () => {
		const originalWrite = process.stdout.write;
		let output = "";
		process.stdout.write = ((chunk: string) => {
			output += chunk;
			return true;
		}) as typeof process.stdout.write;

		try {
			await supervisorCommand([]);
			expect(output).toContain("overstory supervisor");
		} finally {
			process.stdout.write = originalWrite;
		}
	});

	test("unknown subcommand throws ValidationError with bad value in message", async () => {
		expect(async () => {
			await supervisorCommand(["invalid-subcommand"]);
		}).toThrow(/invalid-subcommand/);
	});

	test("start without --task throws ValidationError", async () => {
		expect(async () => {
			await supervisorCommand(["start", "--name", "supervisor-1"]);
		}).toThrow(/--task/);
	});

	test("start without --name throws ValidationError", async () => {
		expect(async () => {
			await supervisorCommand(["start", "--task", "task-1"]);
		}).toThrow(/--name/);
	});

	test("stop without --name throws ValidationError", async () => {
		expect(async () => {
			await supervisorCommand(["stop"]);
		}).toThrow(/--name/);
	});
});
