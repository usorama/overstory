/**
 * Integration tests for the watchdog daemon tick loop.
 *
 * Uses real filesystem (temp directories via mkdtemp) for sessions.json
 * read/write, real JSON serialization, and real health evaluation logic.
 *
 * Only tmux operations (isSessionAlive, killSession), triage, and nudge are
 * mocked via dependency injection (_tmux, _triage, _nudge params) because:
 * - Real tmux interferes with developer sessions and is fragile in CI.
 * - Real triage spawns Claude CLI which has cost and latency.
 * - Real nudge requires active tmux sessions.
 *
 * Does NOT use mock.module() — it leaks across test files. See mulch record
 * mx-56558b for background.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, HealthCheck } from "../types.ts";
import { runDaemonTick } from "./daemon.ts";

// === Test constants ===

const THRESHOLDS = {
	staleThresholdMs: 30_000,
	zombieThresholdMs: 120_000,
};

// === Helpers ===

/** Create a temp directory with .overstory/ subdirectory, ready for sessions.json. */
async function createTempRoot(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "overstory-daemon-test-"));
	await mkdir(join(dir, ".overstory"), { recursive: true });
	return dir;
}

/** Write sessions to the sessions.json file at the given root. */
async function writeSessions(root: string, sessions: AgentSession[]): Promise<void> {
	const path = join(root, ".overstory", "sessions.json");
	await Bun.write(path, `${JSON.stringify(sessions, null, "\t")}\n`);
}

/** Read sessions from the sessions.json file at the given root. */
async function readSessions(root: string): Promise<AgentSession[]> {
	const path = join(root, ".overstory", "sessions.json");
	const file = Bun.file(path);
	const exists = await file.exists();
	if (!exists) return [];
	const text = await file.text();
	const parsed: unknown = JSON.parse(text);
	if (!Array.isArray(parsed)) return [];
	return parsed as AgentSession[];
}

/** Build a test AgentSession with sensible defaults. */
function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		id: "session-test",
		agentName: "test-agent",
		capability: "builder",
		worktreePath: "/tmp/test",
		branchName: "overstory/test-agent/test-task",
		beadId: "test-task",
		tmuxSession: "overstory-test-agent",
		state: "working",
		pid: process.pid, // Use our own PID so isProcessRunning returns true
		parentAgent: null,
		depth: 0,
		runId: null,
		escalationLevel: 0,
		stalledSince: null,
		startedAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
		...overrides,
	};
}

/** Create a fake _tmux dependency where all sessions are alive. */
function tmuxAllAlive(): {
	isSessionAlive: (name: string) => Promise<boolean>;
	killSession: (name: string) => Promise<void>;
} {
	return {
		isSessionAlive: async () => true,
		killSession: async () => {},
	};
}

/** Create a fake _tmux dependency where all sessions are dead. */
function tmuxAllDead(): {
	isSessionAlive: (name: string) => Promise<boolean>;
	killSession: (name: string) => Promise<void>;
} {
	return {
		isSessionAlive: async () => false,
		killSession: async () => {},
	};
}

/**
 * Create a fake _tmux dependency with per-session liveness control.
 * Also tracks killSession calls for assertions.
 */
function tmuxWithLiveness(aliveMap: Record<string, boolean>): {
	isSessionAlive: (name: string) => Promise<boolean>;
	killSession: (name: string) => Promise<void>;
	killed: string[];
} {
	const killed: string[] = [];
	return {
		isSessionAlive: async (name: string) => aliveMap[name] ?? false,
		killSession: async (name: string) => {
			killed.push(name);
		},
		killed,
	};
}

/** Create a fake _triage that always returns the given verdict. */
function triageAlways(verdict: "retry" | "terminate" | "extend"): (options: {
	agentName: string;
	root: string;
	lastActivity: string;
}) => Promise<"retry" | "terminate" | "extend"> {
	return async () => verdict;
}

/** Create a fake _nudge that tracks calls and always succeeds. */
function nudgeTracker(): {
	nudge: (
		projectRoot: string,
		agentName: string,
		message: string,
		force: boolean,
	) => Promise<{ delivered: boolean; reason?: string }>;
	calls: Array<{ agentName: string; message: string }>;
} {
	const calls: Array<{ agentName: string; message: string }> = [];
	return {
		nudge: async (_projectRoot: string, agentName: string, message: string, _force: boolean) => {
			calls.push({ agentName, message });
			return { delivered: true };
		},
		calls,
	};
}

// === Tests ===

let tempRoot: string;

beforeEach(async () => {
	tempRoot = await createTempRoot();
});

afterEach(async () => {
	await rm(tempRoot, { recursive: true, force: true });
});

describe("daemon tick", () => {
	// --- Test 1: tick with no sessions file ---

	test("tick with no sessions file is a graceful no-op", async () => {
		// sessions.json does not exist — daemon should not crash
		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
		});

		// No health checks should have been produced (no sessions to check)
		expect(checks).toHaveLength(0);

		// sessions.json should still not exist (no updates = no write)
		const file = Bun.file(join(tempRoot, ".overstory", "sessions.json"));
		expect(await file.exists()).toBe(false);
	});

	// --- Test 2: tick with healthy sessions ---

	test("tick with healthy sessions produces no state changes", async () => {
		const session = makeSession({
			state: "working",
			lastActivity: new Date().toISOString(),
		});

		await writeSessions(tempRoot, [session]);

		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
		});

		expect(checks).toHaveLength(1);
		const check = checks[0];
		expect(check).toBeDefined();
		expect(check?.state).toBe("working");
		expect(check?.action).toBe("none");

		// sessions.json should be unchanged because state didn't change.
		// The daemon only writes when `updated` is true.
		const reloaded = await readSessions(tempRoot);
		expect(reloaded).toHaveLength(1);
		expect(reloaded[0]?.state).toBe("working");
	});

	// --- Test 3: tick with dead tmux -> zombie transition ---

	test("tick with dead tmux transitions session to zombie and fires terminate", async () => {
		const session = makeSession({
			agentName: "dead-agent",
			tmuxSession: "overstory-dead-agent",
			state: "working",
			lastActivity: new Date().toISOString(),
		});

		await writeSessions(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "overstory-dead-agent": false });
		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
		});

		// Health check should detect zombie with terminate action
		expect(checks).toHaveLength(1);
		expect(checks[0]?.state).toBe("zombie");
		expect(checks[0]?.action).toBe("terminate");

		// tmux is dead so killSession should NOT be called (only kills if tmuxAlive)
		expect(tmuxMock.killed).toHaveLength(0);

		// Session state should be persisted as zombie
		const reloaded = await readSessions(tempRoot);
		expect(reloaded).toHaveLength(1);
		expect(reloaded[0]?.state).toBe("zombie");
	});

	test("tick with alive tmux but zombie-old activity calls killSession", async () => {
		// tmux IS alive but time-based zombie threshold is exceeded,
		// causing a terminate action — killSession SHOULD be called.
		const oldActivity = new Date(Date.now() - 200_000).toISOString();
		const session = makeSession({
			agentName: "zombie-agent",
			tmuxSession: "overstory-zombie-agent",
			state: "working",
			lastActivity: oldActivity,
		});

		await writeSessions(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "overstory-zombie-agent": true });
		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
		});

		expect(checks).toHaveLength(1);
		expect(checks[0]?.action).toBe("terminate");

		// tmux was alive, so killSession SHOULD have been called
		expect(tmuxMock.killed).toContain("overstory-zombie-agent");

		// Session persisted as zombie
		const reloaded = await readSessions(tempRoot);
		expect(reloaded[0]?.state).toBe("zombie");
	});

	// --- Test 4: progressive nudging for stalled agents ---

	test("first tick with stalled agent sets stalledSince and stays at level 0 (warn)", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const session = makeSession({
			agentName: "stalled-agent",
			tmuxSession: "overstory-stalled-agent",
			state: "working",
			lastActivity: staleActivity,
		});

		await writeSessions(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "overstory-stalled-agent": true });
		const checks: HealthCheck[] = [];
		const nudgeMock = nudgeTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			nudgeIntervalMs: 60_000,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
			_nudge: nudgeMock.nudge,
		});

		expect(checks).toHaveLength(1);
		expect(checks[0]?.action).toBe("escalate");

		// No kill at level 0
		expect(tmuxMock.killed).toHaveLength(0);

		// No nudge at level 0 (warn only)
		expect(nudgeMock.calls).toHaveLength(0);

		// Session should be stalled with stalledSince set and escalationLevel 0
		const reloaded = await readSessions(tempRoot);
		expect(reloaded[0]?.state).toBe("stalled");
		expect(reloaded[0]?.escalationLevel).toBe(0);
		expect(reloaded[0]?.stalledSince).not.toBeNull();
	});

	test("stalled agent at level 1 sends nudge", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		// Pre-set stalledSince to > nudgeIntervalMs ago so level advances to 1
		const stalledSince = new Date(Date.now() - 70_000).toISOString();
		const session = makeSession({
			agentName: "stalled-agent",
			tmuxSession: "overstory-stalled-agent",
			state: "stalled",
			lastActivity: staleActivity,
			escalationLevel: 0,
			stalledSince,
		});

		await writeSessions(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "overstory-stalled-agent": true });
		const nudgeMock = nudgeTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			nudgeIntervalMs: 60_000,
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
			_nudge: nudgeMock.nudge,
		});

		// Level should advance to 1 and nudge should be sent
		const reloaded = await readSessions(tempRoot);
		expect(reloaded[0]?.escalationLevel).toBe(1);
		expect(nudgeMock.calls).toHaveLength(1);
		expect(nudgeMock.calls[0]?.agentName).toBe("stalled-agent");
		expect(nudgeMock.calls[0]?.message).toContain("WATCHDOG");

		// No kill
		expect(tmuxMock.killed).toHaveLength(0);
	});

	test("stalled agent at level 2 calls triage when tier1Enabled", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		// Pre-set stalledSince to > 2*nudgeIntervalMs ago so level advances to 2
		const stalledSince = new Date(Date.now() - 130_000).toISOString();
		const session = makeSession({
			agentName: "stalled-agent",
			tmuxSession: "overstory-stalled-agent",
			state: "stalled",
			lastActivity: staleActivity,
			escalationLevel: 1,
			stalledSince,
		});

		await writeSessions(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "overstory-stalled-agent": true });
		let triageCalled = false;

		const triageMock = async (opts: {
			agentName: string;
			root: string;
			lastActivity: string;
		}): Promise<"retry" | "terminate" | "extend"> => {
			triageCalled = true;
			expect(opts.agentName).toBe("stalled-agent");
			return "terminate";
		};

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			nudgeIntervalMs: 60_000,
			tier1Enabled: true,
			_tmux: tmuxMock,
			_triage: triageMock,
			_nudge: nudgeTracker().nudge,
		});

		expect(triageCalled).toBe(true);

		// Triage returned terminate — session should be zombie
		expect(tmuxMock.killed).toContain("overstory-stalled-agent");
		const reloaded = await readSessions(tempRoot);
		expect(reloaded[0]?.state).toBe("zombie");
	});

	test("stalled agent at level 2 skips triage when tier1Enabled is false", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const stalledSince = new Date(Date.now() - 130_000).toISOString();
		const session = makeSession({
			agentName: "stalled-agent",
			tmuxSession: "overstory-stalled-agent",
			state: "stalled",
			lastActivity: staleActivity,
			escalationLevel: 1,
			stalledSince,
		});

		await writeSessions(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "overstory-stalled-agent": true });
		let triageCalled = false;

		const triageMock = async (): Promise<"retry" | "terminate" | "extend"> => {
			triageCalled = true;
			return "terminate";
		};

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			nudgeIntervalMs: 60_000,
			tier1Enabled: false, // Triage disabled
			_tmux: tmuxMock,
			_triage: triageMock,
			_nudge: nudgeTracker().nudge,
		});

		// Triage should NOT have been called
		expect(triageCalled).toBe(false);

		// No kill — level 2 with tier1 disabled just skips
		expect(tmuxMock.killed).toHaveLength(0);

		// Session stays stalled at level 2
		const reloaded = await readSessions(tempRoot);
		expect(reloaded[0]?.state).toBe("stalled");
		expect(reloaded[0]?.escalationLevel).toBe(2);
	});

	test("stalled agent at level 3 is terminated", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		// Pre-set stalledSince to > 3*nudgeIntervalMs ago so level advances to 3
		const stalledSince = new Date(Date.now() - 200_000).toISOString();
		const session = makeSession({
			agentName: "doomed-agent",
			tmuxSession: "overstory-doomed-agent",
			state: "stalled",
			lastActivity: staleActivity,
			escalationLevel: 2,
			stalledSince,
		});

		await writeSessions(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "overstory-doomed-agent": true });

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			nudgeIntervalMs: 60_000,
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
			_nudge: nudgeTracker().nudge,
		});

		// Level 3 = terminate
		expect(tmuxMock.killed).toContain("overstory-doomed-agent");

		const reloaded = await readSessions(tempRoot);
		expect(reloaded[0]?.state).toBe("zombie");
		// Escalation is reset after termination
		expect(reloaded[0]?.escalationLevel).toBe(0);
		expect(reloaded[0]?.stalledSince).toBeNull();
	});

	test("triage retry sends nudge with recovery message", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const stalledSince = new Date(Date.now() - 130_000).toISOString();
		const session = makeSession({
			agentName: "retry-agent",
			tmuxSession: "overstory-retry-agent",
			state: "stalled",
			lastActivity: staleActivity,
			escalationLevel: 1,
			stalledSince,
		});

		await writeSessions(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "overstory-retry-agent": true });
		const nudgeMock = nudgeTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			nudgeIntervalMs: 60_000,
			tier1Enabled: true,
			_tmux: tmuxMock,
			_triage: triageAlways("retry"),
			_nudge: nudgeMock.nudge,
		});

		// Triage returned "retry" — nudge should be sent with recovery message
		expect(nudgeMock.calls).toHaveLength(1);
		expect(nudgeMock.calls[0]?.message).toContain("recovery");

		// No kill
		expect(tmuxMock.killed).toHaveLength(0);

		// Session stays stalled
		const reloaded = await readSessions(tempRoot);
		expect(reloaded[0]?.state).toBe("stalled");
	});

	test("agent recovery resets escalation tracking", async () => {
		// Agent was stalled but now has recent activity
		const session = makeSession({
			agentName: "recovered-agent",
			tmuxSession: "overstory-recovered-agent",
			state: "working",
			lastActivity: new Date().toISOString(), // Recent activity
			escalationLevel: 2,
			stalledSince: new Date(Date.now() - 130_000).toISOString(),
		});

		await writeSessions(tempRoot, [session]);

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
			_nudge: nudgeTracker().nudge,
		});

		// Health check should return action: "none" for recovered agent
		// Escalation tracking should be reset
		const reloaded = await readSessions(tempRoot);
		expect(reloaded[0]?.state).toBe("working");
		expect(reloaded[0]?.escalationLevel).toBe(0);
		expect(reloaded[0]?.stalledSince).toBeNull();
	});

	// --- Test 5: session persistence round-trip ---

	test("session persistence round-trip: load, modify, save, reload", async () => {
		const sessions: AgentSession[] = [
			makeSession({
				id: "session-1",
				agentName: "agent-alpha",
				tmuxSession: "overstory-agent-alpha",
				state: "working",
				lastActivity: new Date().toISOString(),
			}),
			makeSession({
				id: "session-2",
				agentName: "agent-beta",
				tmuxSession: "overstory-agent-beta",
				state: "working",
				// Make beta's tmux dead so it transitions to zombie
				lastActivity: new Date().toISOString(),
			}),
			makeSession({
				id: "session-3",
				agentName: "agent-gamma",
				tmuxSession: "overstory-agent-gamma",
				state: "completed",
				lastActivity: new Date().toISOString(),
			}),
		];

		await writeSessions(tempRoot, sessions);

		const tmuxMock = tmuxWithLiveness({
			"overstory-agent-alpha": true,
			"overstory-agent-beta": false, // Dead — should become zombie
			"overstory-agent-gamma": true, // Doesn't matter — completed is skipped
		});

		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
		});

		// Completed sessions are skipped — only 2 health checks
		expect(checks).toHaveLength(2);

		// Reload and verify persistence
		const reloaded = await readSessions(tempRoot);
		expect(reloaded).toHaveLength(3);

		const alpha = reloaded.find((s) => s.agentName === "agent-alpha");
		const beta = reloaded.find((s) => s.agentName === "agent-beta");
		const gamma = reloaded.find((s) => s.agentName === "agent-gamma");

		expect(alpha).toBeDefined();
		expect(beta).toBeDefined();
		expect(gamma).toBeDefined();

		// Alpha: tmux alive + recent activity — stays working
		expect(alpha?.state).toBe("working");

		// Beta: tmux dead — zombie (ZFC rule 1)
		expect(beta?.state).toBe("zombie");

		// Gamma: completed — unchanged (skipped by daemon)
		expect(gamma?.state).toBe("completed");
	});

	test("session persistence: no write when nothing changes", async () => {
		const session = makeSession({
			state: "working",
			lastActivity: new Date().toISOString(),
		});

		await writeSessions(tempRoot, [session]);

		// Record the file modification time before the tick
		const pathStr = join(tempRoot, ".overstory", "sessions.json");
		const statBefore = await Bun.file(pathStr).lastModified;

		// Small delay to ensure mtime would differ if file is rewritten
		await Bun.sleep(50);

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
		});

		const statAfter = await Bun.file(pathStr).lastModified;

		// File should NOT have been rewritten since no state changed
		expect(statAfter).toBe(statBefore);
	});

	// --- Edge cases ---

	test("completed sessions are skipped entirely", async () => {
		const session = makeSession({ state: "completed" });

		await writeSessions(tempRoot, [session]);

		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxAllDead(), // Would be zombie if not skipped
			_triage: triageAlways("extend"),
		});

		// No health checks emitted for completed sessions
		expect(checks).toHaveLength(0);

		// State unchanged
		const reloaded = await readSessions(tempRoot);
		expect(reloaded[0]?.state).toBe("completed");
	});

	test("multiple sessions with mixed states are all processed", async () => {
		const now = Date.now();
		const sessions: AgentSession[] = [
			makeSession({
				id: "s1",
				agentName: "healthy",
				tmuxSession: "overstory-healthy",
				state: "working",
				lastActivity: new Date(now).toISOString(),
			}),
			makeSession({
				id: "s2",
				agentName: "dying",
				tmuxSession: "overstory-dying",
				state: "working",
				lastActivity: new Date(now).toISOString(),
			}),
			makeSession({
				id: "s3",
				agentName: "stale",
				tmuxSession: "overstory-stale",
				state: "working",
				lastActivity: new Date(now - 60_000).toISOString(),
			}),
			makeSession({
				id: "s4",
				agentName: "done",
				tmuxSession: "overstory-done",
				state: "completed",
			}),
		];

		await writeSessions(tempRoot, sessions);

		const tmuxMock = tmuxWithLiveness({
			"overstory-healthy": true,
			"overstory-dying": false,
			"overstory-stale": true,
			"overstory-done": false,
		});

		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
			_nudge: nudgeTracker().nudge,
		});

		// 3 non-completed sessions processed
		expect(checks).toHaveLength(3);

		const reloaded = await readSessions(tempRoot);

		const healthy = reloaded.find((s) => s.agentName === "healthy");
		const dying = reloaded.find((s) => s.agentName === "dying");
		const stale = reloaded.find((s) => s.agentName === "stale");
		const done = reloaded.find((s) => s.agentName === "done");

		expect(healthy?.state).toBe("working");
		expect(dying?.state).toBe("zombie");
		expect(stale?.state).toBe("stalled");
		expect(done?.state).toBe("completed");
	});

	test("empty sessions array is a no-op", async () => {
		await writeSessions(tempRoot, []);

		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
		});

		expect(checks).toHaveLength(0);
	});

	test("booting session with recent activity transitions to working", async () => {
		const session = makeSession({
			state: "booting",
			lastActivity: new Date().toISOString(),
		});

		await writeSessions(tempRoot, [session]);

		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
		});

		expect(checks).toHaveLength(1);
		expect(checks[0]?.state).toBe("working");

		const reloaded = await readSessions(tempRoot);
		expect(reloaded[0]?.state).toBe("working");
	});

	// --- Backward compatibility ---

	test("sessions without escalation fields get backfilled", async () => {
		// Write sessions.json without the new fields (simulates pre-upgrade data)
		const rawSession = {
			id: "session-old",
			agentName: "old-agent",
			capability: "builder",
			worktreePath: "/tmp/test",
			branchName: "overstory/old-agent/task",
			beadId: "task",
			tmuxSession: "overstory-old-agent",
			state: "working",
			pid: process.pid,
			parentAgent: null,
			depth: 0,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			// No escalationLevel or stalledSince
		};

		const path = join(tempRoot, ".overstory", "sessions.json");
		await Bun.write(path, `${JSON.stringify([rawSession], null, "\t")}\n`);

		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
		});

		// Should process without errors
		expect(checks).toHaveLength(1);
		expect(checks[0]?.state).toBe("working");
	});
});
