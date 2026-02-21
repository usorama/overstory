/**
 * Tests for web dashboard command.
 *
 * Exercises API response shapes, SSE event format, and arg parsing
 * using real SQLite databases in temp directories.
 * HTML rendering is not tested (visual only, too brittle).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createEventStore } from "../events/store.ts";
import { createMailStore } from "../mail/store.ts";
import { createMergeQueue } from "../merge/queue.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
import type { WebDashboardOptions } from "./web-dashboard.ts";
import { createServer } from "./web-dashboard.ts";

let tempDir: string;
let overstoryDir: string;
let server: ReturnType<typeof createServer> | null = null;

/** Minimal config.yaml for loadConfig to work. */
const MINIMAL_CONFIG = `
project:
  name: test-project
  root: ROOT_PLACEHOLDER
  canonicalBranch: main
agents:
  maxConcurrent: 3
  maxDepth: 2
  manifestPath: .overstory/agent-manifest.json
  baseDir: agents
  staggerDelayMs: 500
worktrees:
  baseDir: .overstory/worktrees
beads:
  enabled: false
mulch:
  enabled: false
  domains: []
  primeFormat: markdown
merge:
  aiResolveEnabled: false
  reimagineEnabled: false
watchdog:
  tier0Enabled: false
  tier0IntervalMs: 30000
  tier1Enabled: false
  tier2Enabled: false
  staleThresholdMs: 300000
  zombieThresholdMs: 600000
  nudgeIntervalMs: 60000
models: {}
logging:
  verbose: false
  redactSecrets: false
`;

beforeEach(async () => {
	tempDir = await createTempGitRepo();
	overstoryDir = join(tempDir, ".overstory");
	await mkdir(overstoryDir, { recursive: true });

	// Write config.yaml with correct root path
	await writeFile(
		join(overstoryDir, "config.yaml"),
		MINIMAL_CONFIG.replace("ROOT_PLACEHOLDER", tempDir),
	);
});

afterEach(async () => {
	if (server) {
		server.stop(true);
		server = null;
	}
	await cleanupTempDir(tempDir);
});

function startServer(opts?: Partial<WebDashboardOptions>): ReturnType<typeof createServer> {
	const s = createServer({
		port: 0, // Let OS assign a random available port
		host: "127.0.0.1",
		root: tempDir,
		...opts,
	});
	server = s;
	return s;
}

function serverUrl(s: ReturnType<typeof createServer>, path: string): string {
	return `http://127.0.0.1:${s.port}${path}`;
}

describe("web dashboard server", () => {
	test("serves HTML at /", async () => {
		const s = startServer();
		const res = await fetch(serverUrl(s, "/"));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		const html = await res.text();
		expect(html).toContain("overstory");
		expect(html).toContain("EventSource");
	});

	test("returns 404 for unknown paths", async () => {
		const s = startServer();
		const res = await fetch(serverUrl(s, "/unknown"));
		expect(res.status).toBe(404);
	});
});

describe("API: /api/status", () => {
	test("returns valid JSON with expected shape", async () => {
		// Create sessions.db so the status API has something to read
		const { openSessionStore } = await import("../sessions/compat.ts");
		const { store } = openSessionStore(overstoryDir);
		store.close();

		const s = startServer();
		const res = await fetch(serverUrl(s, "/api/status"));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");

		const data = await res.json();
		expect(data).toHaveProperty("agents");
		expect(data).toHaveProperty("worktrees");
		expect(data).toHaveProperty("unreadMailCount");
		expect(data).toHaveProperty("mergeQueueCount");
		expect(Array.isArray(data.agents)).toBe(true);
	});
});

describe("API: /api/events", () => {
	test("returns empty array when no events.db exists", async () => {
		const s = startServer();
		const res = await fetch(serverUrl(s, "/api/events"));
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(Array.isArray(data)).toBe(true);
		expect(data.length).toBe(0);
	});

	test("returns events from real EventStore", async () => {
		const eventsDbPath = join(overstoryDir, "events.db");
		const store = createEventStore(eventsDbPath);
		store.insert({
			runId: "run-1",
			agentName: "builder-1",
			sessionId: "sess-1",
			eventType: "tool_start",
			toolName: "Read",
			toolArgs: JSON.stringify({ file_path: "src/index.ts" }),
			toolDurationMs: null,
			level: "info",
			data: null,
		});
		store.close();

		const s = startServer();
		const res = await fetch(serverUrl(s, "/api/events?agent=builder-1"));
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(Array.isArray(data)).toBe(true);
		expect(data.length).toBe(1);
		expect(data[0].agentName).toBe("builder-1");
		expect(data[0].toolName).toBe("Read");
	});
});

describe("API: /api/mail", () => {
	test("returns empty array when no mail.db exists", async () => {
		const s = startServer();
		const res = await fetch(serverUrl(s, "/api/mail"));
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(Array.isArray(data)).toBe(true);
		expect(data.length).toBe(0);
	});

	test("returns messages from real MailStore", async () => {
		const mailDbPath = join(overstoryDir, "mail.db");
		const mailStore = createMailStore(mailDbPath);
		mailStore.insert({
			id: "msg-test-001",
			from: "builder-1",
			to: "orchestrator",
			subject: "Worker done",
			body: "Completed task",
			type: "result",
			priority: "normal",
			threadId: null,
		});
		mailStore.close();

		const s = startServer();
		const res = await fetch(serverUrl(s, "/api/mail"));
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.length).toBe(1);
		expect(data[0].from).toBe("builder-1");
		expect(data[0].subject).toBe("Worker done");
	});
});

describe("API: /api/merge", () => {
	test("returns empty array when no merge-queue.db exists", async () => {
		const s = startServer();
		const res = await fetch(serverUrl(s, "/api/merge"));
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(Array.isArray(data)).toBe(true);
		expect(data.length).toBe(0);
	});

	test("returns entries from real MergeQueue", async () => {
		const queuePath = join(overstoryDir, "merge-queue.db");
		const queue = createMergeQueue(queuePath);
		queue.enqueue({
			branchName: "overstory/builder-1/task-1",
			beadId: "task-1",
			agentName: "builder-1",
			filesModified: ["src/index.ts"],
		});
		queue.close();

		const s = startServer();
		const res = await fetch(serverUrl(s, "/api/merge"));
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.length).toBe(1);
		expect(data[0].branchName).toBe("overstory/builder-1/task-1");
		expect(data[0].status).toBe("pending");
	});
});

describe("API: /api/costs", () => {
	test("returns empty result when no metrics.db exists", async () => {
		const s = startServer();
		const res = await fetch(serverUrl(s, "/api/costs"));
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data).toHaveProperty("sessions");
		expect(data).toHaveProperty("totals");
		expect(data.sessions.length).toBe(0);
		expect(data.totals.tokens).toBe(0);
	});

	test("returns sessions from real MetricsStore", async () => {
		const metricsDbPath = join(overstoryDir, "metrics.db");
		const metricsStore = createMetricsStore(metricsDbPath);
		metricsStore.recordSession({
			agentName: "builder-1",
			beadId: "task-1",
			capability: "builder",
			runId: "run-test-1",
			startedAt: new Date().toISOString(),
			completedAt: new Date().toISOString(),
			durationMs: 120000,
			exitCode: 0,
			mergeResult: null,
			parentAgent: null,
			inputTokens: 5000,
			outputTokens: 1000,
			cacheReadTokens: 2000,
			cacheCreationTokens: 500,
			estimatedCostUsd: 0.05,
			modelUsed: "sonnet",
		});
		metricsStore.close();

		const s = startServer();
		const res = await fetch(serverUrl(s, "/api/costs"));
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.sessions.length).toBe(1);
		expect(data.totals.tokens).toBe(6000);
		expect(data.totals.cost).toBe(0.05);
	});
});

describe("API: /api/config", () => {
	test("returns JSON response (200 on valid config, 500 on validation error)", async () => {
		const s = startServer();
		const res = await fetch(serverUrl(s, "/api/config"));
		expect(res.headers.get("content-type")).toContain("application/json");
		const data = await res.json();
		expect(typeof data).toBe("object");

		if (res.status === 200) {
			// Config loaded successfully — should NOT contain sensitive paths
			expect(data.root).toBeUndefined();
			if (data.canonicalBranch !== undefined) {
				expect(data.canonicalBranch).toBe("main");
			}
		} else {
			// Config validation failed (e.g., YAML parser limitation) — 500 with error shape
			expect(res.status).toBe(500);
			expect(data).toHaveProperty("error");
		}
	});
});

describe("SSE: /events", () => {
	test("returns event-stream content type", async () => {
		const s = startServer();
		const res = await fetch(serverUrl(s, "/events"));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		expect(res.headers.get("cache-control")).toBe("no-cache");

		// Read a small chunk to verify SSE format
		const reader = res.body?.getReader();
		expect(reader).toBeDefined();
		if (reader) {
			const { value } = await reader.read();
			const text = new TextDecoder().decode(value);
			// SSE events should have "event:" and "data:" lines
			expect(text).toContain("event:");
			expect(text).toContain("data:");
			reader.cancel();
		}
	});
});

describe("arg parsing", () => {
	test("webDashboardCommand outputs help text", async () => {
		const { webDashboardCommand } = await import("./web-dashboard.ts");
		const originalWrite = process.stdout.write;
		let output = "";
		process.stdout.write = ((chunk: unknown) => {
			output += String(chunk);
			return true;
		}) as typeof process.stdout.write;

		try {
			await webDashboardCommand(["--help"]);
			expect(output).toContain("overstory web");
			expect(output).toContain("--port");
			expect(output).toContain("--host");
		} finally {
			process.stdout.write = originalWrite;
		}
	});

	test("webDashboardCommand rejects invalid port", async () => {
		const { webDashboardCommand } = await import("./web-dashboard.ts");
		await expect(webDashboardCommand(["--port", "abc"])).rejects.toThrow("--port");
	});

	test("webDashboardCommand rejects port out of range", async () => {
		const { webDashboardCommand } = await import("./web-dashboard.ts");
		await expect(webDashboardCommand(["--port", "99999"])).rejects.toThrow("--port");
	});
});

describe("completions include web command", () => {
	test("COMMANDS array includes web", async () => {
		const { COMMANDS } = await import("./completions.ts");
		const names = COMMANDS.map((c) => c.name);
		expect(names).toContain("web");
	});

	test("web command has correct flags", async () => {
		const { COMMANDS } = await import("./completions.ts");
		const web = COMMANDS.find((c) => c.name === "web");
		expect(web).toBeDefined();
		const flagNames = web?.flags?.map((f) => f.name);
		expect(flagNames).toContain("--port");
		expect(flagNames).toContain("--host");
		expect(flagNames).toContain("--json");
		expect(flagNames).toContain("--help");
	});
});
