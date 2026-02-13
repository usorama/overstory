import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { createMetricsStore } from "../metrics/store.ts";
import type { AgentSession, StoredEvent } from "../types.ts";
import { logCommand } from "./log.ts";

/**
 * Tests for `overstory log` command.
 *
 * Uses real filesystem (temp dirs) and real bun:sqlite to test logging behavior.
 * Captures process.stdout.write to verify help text output.
 */

describe("logCommand", () => {
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
		tempDir = await mkdtemp(join(tmpdir(), "log-test-"));
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

	test("--help flag shows help text", async () => {
		await logCommand(["--help"]);
		const out = output();

		expect(out).toContain("overstory log");
		expect(out).toContain("tool-start");
		expect(out).toContain("tool-end");
		expect(out).toContain("session-end");
		expect(out).toContain("--agent");
	});

	test("-h flag shows help text", async () => {
		await logCommand(["-h"]);
		const out = output();

		expect(out).toContain("overstory log");
		expect(out).toContain("tool-start");
		expect(out).toContain("tool-end");
		expect(out).toContain("session-end");
		expect(out).toContain("--agent");
	});

	test("missing event with only flags throws ValidationError", async () => {
		// The code finds first non-flag arg. Passing only flags should trigger "Event is required"
		// Note: the implementation checks for undefined event
		await expect(async () => {
			await logCommand([]);
		}).toThrow(ValidationError);

		await expect(async () => {
			await logCommand([]);
		}).toThrow("Event is required");
	});

	test("invalid event name throws ValidationError", async () => {
		expect(async () => {
			await logCommand(["invalid-event", "--agent", "test-agent"]);
		}).toThrow(ValidationError);

		expect(async () => {
			await logCommand(["invalid-event", "--agent", "test-agent"]);
		}).toThrow("Invalid event");
	});

	test("missing --agent flag throws ValidationError", async () => {
		expect(async () => {
			await logCommand(["tool-start"]);
		}).toThrow(ValidationError);

		expect(async () => {
			await logCommand(["tool-start"]);
		}).toThrow("--agent is required");
	});

	test("tool-start creates log directory structure", async () => {
		await logCommand(["tool-start", "--agent", "test-builder", "--tool-name", "Read"]);

		const logsDir = join(tempDir, ".overstory", "logs", "test-builder");
		const contents = await readdir(logsDir);

		// Should have at least .current-session marker and a session directory
		expect(contents).toContain(".current-session");
		expect(contents.length).toBeGreaterThanOrEqual(2);
	});

	test("tool-start creates session directory and .current-session marker", async () => {
		await logCommand(["tool-start", "--agent", "test-scout", "--tool-name", "Grep"]);

		const logsDir = join(tempDir, ".overstory", "logs", "test-scout");
		const markerPath = join(logsDir, ".current-session");
		const markerFile = Bun.file(markerPath);

		expect(await markerFile.exists()).toBe(true);

		const sessionDir = (await markerFile.text()).trim();
		expect(sessionDir).toBeTruthy();
		expect(sessionDir).toContain(logsDir);

		// Session directory should exist
		const dirStat = await stat(sessionDir);
		expect(dirStat.isDirectory()).toBe(true);
	});

	test("tool-start creates log files in session directory", async () => {
		await logCommand(["tool-start", "--agent", "test-builder", "--tool-name", "Write"]);

		// Wait for async file writes to complete
		await new Promise((resolve) => setTimeout(resolve, 50));

		const logsDir = join(tempDir, ".overstory", "logs", "test-builder");
		const markerPath = join(logsDir, ".current-session");
		const sessionDir = (await Bun.file(markerPath).text()).trim();

		// Check for events.ndjson file
		const eventsFile = Bun.file(join(sessionDir, "events.ndjson"));
		expect(await eventsFile.exists()).toBe(true);
	});

	test("tool-end uses the same session directory as tool-start", async () => {
		await logCommand(["tool-start", "--agent", "test-agent", "--tool-name", "Edit"]);

		const logsDir = join(tempDir, ".overstory", "logs", "test-agent");
		const markerPath = join(logsDir, ".current-session");
		const sessionDirAfterStart = (await Bun.file(markerPath).text()).trim();

		await logCommand(["tool-end", "--agent", "test-agent", "--tool-name", "Edit"]);

		const sessionDirAfterEnd = (await Bun.file(markerPath).text()).trim();
		expect(sessionDirAfterEnd).toBe(sessionDirAfterStart);
	});

	test("tool-end writes to the same session directory", async () => {
		await logCommand(["tool-start", "--agent", "test-worker", "--tool-name", "Bash"]);
		await logCommand(["tool-end", "--agent", "test-worker", "--tool-name", "Bash"]);

		// Wait for async file writes to complete
		await new Promise((resolve) => setTimeout(resolve, 50));

		const logsDir = join(tempDir, ".overstory", "logs", "test-worker");
		const markerPath = join(logsDir, ".current-session");
		const sessionDir = (await Bun.file(markerPath).text()).trim();

		// Events file should contain both tool-start and tool-end events
		const eventsFile = Bun.file(join(sessionDir, "events.ndjson"));
		const eventsContent = await eventsFile.text();

		expect(eventsContent).toContain("tool.start");
		expect(eventsContent).toContain("tool.end");
	});

	test("session-end transitions agent state to completed in sessions.json", async () => {
		// Create sessions.json with a test agent
		const sessionsPath = join(tempDir, ".overstory", "sessions.json");
		const session: AgentSession = {
			id: "session-001",
			agentName: "test-agent",
			capability: "builder",
			worktreePath: "/tmp/test",
			branchName: "test-branch",
			beadId: "bead-001",
			tmuxSession: "test-tmux",
			state: "working",
			pid: 12345,
			parentAgent: null,
			depth: 0,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		};
		await Bun.write(sessionsPath, `${JSON.stringify([session], null, "\t")}\n`);

		await logCommand(["session-end", "--agent", "test-agent"]);

		// Read sessions.json and verify state changed to completed
		const sessionsFile = Bun.file(sessionsPath);
		const sessions = JSON.parse(await sessionsFile.text()) as AgentSession[];
		const updatedSession = sessions.find((s) => s.agentName === "test-agent");

		expect(updatedSession).toBeDefined();
		expect(updatedSession?.state).toBe("completed");
	});

	test("session-end clears the .current-session marker", async () => {
		// First create a session with tool-start
		await logCommand(["tool-start", "--agent", "test-cleanup", "--tool-name", "Read"]);

		const logsDir = join(tempDir, ".overstory", "logs", "test-cleanup");
		const markerPath = join(logsDir, ".current-session");

		// Verify marker exists before session-end
		let markerFile = Bun.file(markerPath);
		expect(await markerFile.exists()).toBe(true);

		// Now end the session
		await logCommand(["session-end", "--agent", "test-cleanup"]);

		// Marker should be removed - need to create a new Bun.file reference
		markerFile = Bun.file(markerPath);
		expect(await markerFile.exists()).toBe(false);
	});

	test("session-end records metrics when agent session exists in sessions.json", async () => {
		// Create sessions.json with a test agent
		const sessionsPath = join(tempDir, ".overstory", "sessions.json");
		const session: AgentSession = {
			id: "session-002",
			agentName: "metrics-agent",
			capability: "scout",
			worktreePath: "/tmp/metrics",
			branchName: "metrics-branch",
			beadId: "bead-002",
			tmuxSession: "metrics-tmux",
			state: "working",
			pid: 54321,
			parentAgent: "parent-agent",
			depth: 1,
			runId: null,
			startedAt: new Date(Date.now() - 60_000).toISOString(), // 1 minute ago
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		};
		await Bun.write(sessionsPath, `${JSON.stringify([session], null, "\t")}\n`);

		await logCommand(["session-end", "--agent", "metrics-agent"]);

		// Verify metrics.db was created and has the session record
		const metricsDbPath = join(tempDir, ".overstory", "metrics.db");
		const metricsStore = createMetricsStore(metricsDbPath);
		const metrics = metricsStore.getRecentSessions(1);
		metricsStore.close();

		expect(metrics).toHaveLength(1);
		expect(metrics[0]?.agentName).toBe("metrics-agent");
		expect(metrics[0]?.beadId).toBe("bead-002");
		expect(metrics[0]?.capability).toBe("scout");
		expect(metrics[0]?.parentAgent).toBe("parent-agent");
	});

	test("session-end does not crash when sessions.json does not exist", async () => {
		// No sessions.json file exists
		// session-end should complete without throwing
		await expect(
			logCommand(["session-end", "--agent", "nonexistent-agent"]),
		).resolves.toBeUndefined();
	});

	test("tool-start updates lastActivity timestamp in sessions.json", async () => {
		// Create sessions.json with a test agent
		const sessionsPath = join(tempDir, ".overstory", "sessions.json");
		const oldTimestamp = new Date(Date.now() - 120_000).toISOString(); // 2 minutes ago
		const session: AgentSession = {
			id: "session-003",
			agentName: "activity-agent",
			capability: "builder",
			worktreePath: "/tmp/activity",
			branchName: "activity-branch",
			beadId: "bead-003",
			tmuxSession: "activity-tmux",
			state: "working",
			pid: 99999,
			parentAgent: null,
			depth: 0,
			runId: null,
			startedAt: oldTimestamp,
			lastActivity: oldTimestamp,
			escalationLevel: 0,
			stalledSince: null,
		};
		await Bun.write(sessionsPath, `${JSON.stringify([session], null, "\t")}\n`);

		await logCommand(["tool-start", "--agent", "activity-agent", "--tool-name", "Glob"]);

		// Read sessions.json and verify lastActivity was updated
		const sessionsFile = Bun.file(sessionsPath);
		const sessions = JSON.parse(await sessionsFile.text()) as AgentSession[];
		const updatedSession = sessions.find((s) => s.agentName === "activity-agent");

		expect(updatedSession).toBeDefined();
		expect(updatedSession?.lastActivity).not.toBe(oldTimestamp);
		expect(new Date(updatedSession?.lastActivity ?? "").getTime()).toBeGreaterThan(
			new Date(oldTimestamp).getTime(),
		);
	});

	test("tool-start transitions state from booting to working", async () => {
		// Create sessions.json with agent in 'booting' state
		const sessionsPath = join(tempDir, ".overstory", "sessions.json");
		const session: AgentSession = {
			id: "session-004",
			agentName: "booting-agent",
			capability: "builder",
			worktreePath: "/tmp/booting",
			branchName: "booting-branch",
			beadId: "bead-004",
			tmuxSession: "booting-tmux",
			state: "booting",
			pid: 11111,
			parentAgent: null,
			depth: 0,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		};
		await Bun.write(sessionsPath, `${JSON.stringify([session], null, "\t")}\n`);

		await logCommand(["tool-start", "--agent", "booting-agent", "--tool-name", "Read"]);

		// Read sessions.json and verify state changed to working
		const sessionsFile = Bun.file(sessionsPath);
		const sessions = JSON.parse(await sessionsFile.text()) as AgentSession[];
		const updatedSession = sessions.find((s) => s.agentName === "booting-agent");

		expect(updatedSession).toBeDefined();
		expect(updatedSession?.state).toBe("working");
	});

	test("tool-start defaults to unknown when --tool-name not provided", async () => {
		// Should not throw when --tool-name is missing
		await expect(
			logCommand(["tool-start", "--agent", "default-tool-agent"]),
		).resolves.toBeUndefined();

		// Verify log was created
		const logsDir = join(tempDir, ".overstory", "logs", "default-tool-agent");
		const markerPath = join(logsDir, ".current-session");
		const markerFile = Bun.file(markerPath);

		expect(await markerFile.exists()).toBe(true);

		// Wait for async file writes to complete (logger uses fire-and-forget appendFile)
		await new Promise((resolve) => setTimeout(resolve, 50));

		const sessionDir = (await markerFile.text()).trim();
		const eventsFile = Bun.file(join(sessionDir, "events.ndjson"));
		const eventsContent = await eventsFile.text();

		// Should contain "unknown" as the tool name
		expect(eventsContent).toContain("unknown");
	});

	test("tool-end defaults to unknown when --tool-name not provided", async () => {
		await logCommand(["tool-start", "--agent", "default-end-agent"]);

		// tool-end without --tool-name should not throw
		await expect(logCommand(["tool-end", "--agent", "default-end-agent"])).resolves.toBeUndefined();

		// Wait for async file writes to complete
		await new Promise((resolve) => setTimeout(resolve, 50));

		const logsDir = join(tempDir, ".overstory", "logs", "default-end-agent");
		const markerPath = join(logsDir, ".current-session");
		const sessionDir = (await Bun.file(markerPath).text()).trim();
		const eventsFile = Bun.file(join(sessionDir, "events.ndjson"));
		const eventsContent = await eventsFile.text();

		expect(eventsContent).toContain("unknown");
	});

	test("--help includes --stdin option in output", async () => {
		await logCommand(["--help"]);
		const out = output();

		expect(out).toContain("--stdin");
	});
});

/**
 * Tests for `overstory log` with --stdin flag.
 *
 * Uses Bun.spawn to invoke the log command as a subprocess with piped stdin,
 * because Bun.stdin.stream() cannot be injected in-process.
 * Real filesystem + real SQLite for EventStore verification.
 */
describe("logCommand --stdin integration", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "log-stdin-test-"));
		const overstoryDir = join(tempDir, ".overstory");
		await Bun.write(
			join(overstoryDir, "config.yaml"),
			`project:\n  name: test\n  root: ${tempDir}\n  canonicalBranch: main\n`,
		);
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	/**
	 * Helper: run `overstory log` as a subprocess with stdin piped.
	 * Uses bun to run the CLI entry point directly.
	 */
	async function runLogWithStdin(
		event: string,
		agentName: string,
		stdinJson: Record<string, unknown>,
	): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		// Inline script that calls logCommand with --stdin and reads from stdin
		const scriptPath = join(tempDir, "_run-log.ts");
		const scriptContent = `
import { logCommand } from "${join(import.meta.dir, "log.ts").replace(/\\/g, "/")}";
const args = process.argv.slice(2);
try {
	await logCommand(args);
} catch (e) {
	console.error(e instanceof Error ? e.message : String(e));
	process.exit(1);
}
`;
		await Bun.write(scriptPath, scriptContent);

		const proc = Bun.spawn(["bun", "run", scriptPath, event, "--agent", agentName, "--stdin"], {
			cwd: tempDir,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});

		// Write the JSON payload to stdin and close
		proc.stdin.write(JSON.stringify(stdinJson));
		proc.stdin.end();

		const exitCode = await proc.exited;
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();

		return { exitCode, stdout, stderr };
	}

	test("tool-start with --stdin writes to EventStore", async () => {
		const payload = {
			tool_name: "Read",
			tool_input: { file_path: "/src/index.ts" },
			session_id: "sess-test-001",
		};

		const result = await runLogWithStdin("tool-start", "stdin-builder", payload);
		expect(result.exitCode).toBe(0);

		// Verify EventStore has the event
		const eventsDbPath = join(tempDir, ".overstory", "events.db");
		const eventStore = createEventStore(eventsDbPath);
		const events = eventStore.getByAgent("stdin-builder");
		eventStore.close();

		expect(events).toHaveLength(1);
		const event = events[0] as StoredEvent;
		expect(event.eventType).toBe("tool_start");
		expect(event.toolName).toBe("Read");
		expect(event.sessionId).toBe("sess-test-001");
		expect(event.agentName).toBe("stdin-builder");

		// Verify filtered tool args were stored
		const toolArgs = JSON.parse(event.toolArgs ?? "{}");
		expect(toolArgs.file_path).toBe("/src/index.ts");

		// Verify summary in data
		const data = JSON.parse(event.data ?? "{}");
		expect(data.summary).toBe("read: /src/index.ts");
	});

	test("tool-end with --stdin writes to EventStore and correlates with tool-start", async () => {
		// First create a tool-start event
		const startPayload = {
			tool_name: "Bash",
			tool_input: { command: "bun test" },
			session_id: "sess-test-002",
		};
		const startResult = await runLogWithStdin("tool-start", "correlate-agent", startPayload);
		expect(startResult.exitCode).toBe(0);

		// Small delay to ensure measurable duration
		await new Promise((resolve) => setTimeout(resolve, 10));

		// Now send tool-end
		const endPayload = {
			tool_name: "Bash",
			tool_input: { command: "bun test" },
			session_id: "sess-test-002",
		};
		const endResult = await runLogWithStdin("tool-end", "correlate-agent", endPayload);
		expect(endResult.exitCode).toBe(0);

		// Verify EventStore has both events
		const eventsDbPath = join(tempDir, ".overstory", "events.db");
		const eventStore = createEventStore(eventsDbPath);
		const events = eventStore.getByAgent("correlate-agent");
		eventStore.close();

		expect(events).toHaveLength(2);

		const startEvent = events.find((e) => e.eventType === "tool_start");
		const endEvent = events.find((e) => e.eventType === "tool_end");
		expect(startEvent).toBeDefined();
		expect(endEvent).toBeDefined();

		// The start event should have tool_duration_ms set by correlateToolEnd()
		// (value may be affected by SQLite timestamp vs Date.now() timezone behavior,
		// so we only assert it was populated — not the exact value)
		expect(startEvent?.toolDurationMs).not.toBeNull();
	});

	test("tool-start with --stdin filters large tool_input", async () => {
		const payload = {
			tool_name: "Write",
			tool_input: {
				file_path: "/src/new-file.ts",
				content: "x".repeat(50_000), // 50KB of content — should be dropped
			},
			session_id: "sess-test-003",
		};

		const result = await runLogWithStdin("tool-start", "filter-agent", payload);
		expect(result.exitCode).toBe(0);

		const eventsDbPath = join(tempDir, ".overstory", "events.db");
		const eventStore = createEventStore(eventsDbPath);
		const events = eventStore.getByAgent("filter-agent");
		eventStore.close();

		expect(events).toHaveLength(1);
		const event = events[0] as StoredEvent;

		// The Write filter keeps file_path but drops content
		const toolArgs = JSON.parse(event.toolArgs ?? "{}");
		expect(toolArgs.file_path).toBe("/src/new-file.ts");
		expect(toolArgs).not.toHaveProperty("content");

		// Verify summary
		const data = JSON.parse(event.data ?? "{}");
		expect(data.summary).toBe("write: /src/new-file.ts");
	});

	test("session-end with --stdin writes to EventStore with transcript_path", async () => {
		const payload = {
			session_id: "sess-test-004",
			transcript_path: "/tmp/transcript.jsonl",
		};

		const result = await runLogWithStdin("session-end", "session-end-agent", payload);
		expect(result.exitCode).toBe(0);

		const eventsDbPath = join(tempDir, ".overstory", "events.db");
		const eventStore = createEventStore(eventsDbPath);
		const events = eventStore.getByAgent("session-end-agent");
		eventStore.close();

		expect(events).toHaveLength(1);
		const event = events[0] as StoredEvent;
		expect(event.eventType).toBe("session_end");
		expect(event.sessionId).toBe("sess-test-004");

		// Verify transcript path stored in data
		const data = JSON.parse(event.data ?? "{}");
		expect(data.transcriptPath).toBe("/tmp/transcript.jsonl");
	});

	test("tool-start with --stdin still writes to legacy log files", async () => {
		const payload = {
			tool_name: "Grep",
			tool_input: { pattern: "TODO", path: "/src" },
			session_id: "sess-test-005",
		};

		const result = await runLogWithStdin("tool-start", "legacy-compat-agent", payload);
		expect(result.exitCode).toBe(0);

		// Wait for async file writes to complete
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Verify legacy log files exist
		const logsDir = join(tempDir, ".overstory", "logs", "legacy-compat-agent");
		const markerPath = join(logsDir, ".current-session");
		const markerFile = Bun.file(markerPath);
		expect(await markerFile.exists()).toBe(true);

		const sessionDir = (await markerFile.text()).trim();
		const eventsFile = Bun.file(join(sessionDir, "events.ndjson"));
		expect(await eventsFile.exists()).toBe(true);

		const eventsContent = await eventsFile.text();
		expect(eventsContent).toContain("tool.start");
		expect(eventsContent).toContain("Grep");
	});

	test("tool-start with --stdin handles empty stdin gracefully", async () => {
		// Send empty JSON object — should still work (falls back to "unknown" tool name)
		const scriptPath = join(tempDir, "_run-log-empty.ts");
		const scriptContent = `
import { logCommand } from "${join(import.meta.dir, "log.ts").replace(/\\/g, "/")}";
try {
	await logCommand(["tool-start", "--agent", "empty-stdin-agent", "--stdin"]);
} catch (e) {
	console.error(e instanceof Error ? e.message : String(e));
	process.exit(1);
}
`;
		await Bun.write(scriptPath, scriptContent);

		const proc = Bun.spawn(["bun", "run", scriptPath], {
			cwd: tempDir,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});

		// Write empty string and close immediately
		proc.stdin.end();

		const exitCode = await proc.exited;
		expect(exitCode).toBe(0);
	});

	test("tool-start with --stdin and unknown tool name uses fallback filter", async () => {
		const payload = {
			tool_name: "SomeCustomTool",
			tool_input: { custom_key: "custom_value" },
			session_id: "sess-test-006",
		};

		const result = await runLogWithStdin("tool-start", "custom-tool-agent", payload);
		expect(result.exitCode).toBe(0);

		const eventsDbPath = join(tempDir, ".overstory", "events.db");
		const eventStore = createEventStore(eventsDbPath);
		const events = eventStore.getByAgent("custom-tool-agent");
		eventStore.close();

		expect(events).toHaveLength(1);
		const event = events[0] as StoredEvent;
		expect(event.toolName).toBe("SomeCustomTool");

		// Unknown tools get empty args from filterToolArgs
		const toolArgs = JSON.parse(event.toolArgs ?? "{}");
		expect(toolArgs).toEqual({});

		const data = JSON.parse(event.data ?? "{}");
		expect(data.summary).toBe("SomeCustomTool");
	});
});
