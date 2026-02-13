/**
 * Tests for the `overstory clean` command.
 *
 * Uses real filesystem (temp dirs), real git repos, real SQLite.
 * No mocks. tmux operations are tested indirectly — when no tmux
 * server is running, the command handles it gracefully.
 *
 * Philosophy: "never mock what you can use for real" (mx-252b16).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
import { createMailStore } from "../mail/store.ts";
import { createMetricsStore } from "../metrics/store.ts";
import type { AgentSession } from "../types.ts";
import { cleanCommand } from "./clean.ts";

let tempDir: string;
let overstoryDir: string;
let originalCwd: string;
let stdoutOutput: string;
let stderrOutput: string;
let originalStdoutWrite: typeof process.stdout.write;
let originalStderrWrite: typeof process.stderr.write;

beforeEach(async () => {
	tempDir = await createTempGitRepo();
	overstoryDir = join(tempDir, ".overstory");
	await mkdir(overstoryDir, { recursive: true });

	// Write minimal config.yaml so loadConfig succeeds
	await Bun.write(
		join(overstoryDir, "config.yaml"),
		`project:\n  name: test-project\n  root: ${tempDir}\n  canonicalBranch: main\n`,
	);

	// Create the standard directories
	await mkdir(join(overstoryDir, "logs"), { recursive: true });
	await mkdir(join(overstoryDir, "agents"), { recursive: true });
	await mkdir(join(overstoryDir, "specs"), { recursive: true });
	await mkdir(join(overstoryDir, "worktrees"), { recursive: true });

	originalCwd = process.cwd();
	process.chdir(tempDir);

	// Capture stdout/stderr
	stdoutOutput = "";
	stderrOutput = "";
	originalStdoutWrite = process.stdout.write;
	originalStderrWrite = process.stderr.write;
	process.stdout.write = ((chunk: string) => {
		stdoutOutput += chunk;
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string) => {
		stderrOutput += chunk;
		return true;
	}) as typeof process.stderr.write;
});

afterEach(async () => {
	process.chdir(originalCwd);
	process.stdout.write = originalStdoutWrite;
	process.stderr.write = originalStderrWrite;
	await cleanupTempDir(tempDir);
});

// === help ===

describe("help", () => {
	test("--help shows usage", async () => {
		await cleanCommand(["--help"]);
		expect(stdoutOutput).toContain("overstory clean");
		expect(stdoutOutput).toContain("--all");
	});

	test("-h shows usage", async () => {
		await cleanCommand(["-h"]);
		expect(stdoutOutput).toContain("overstory clean");
	});
});

// === validation ===

describe("validation", () => {
	test("no flags throws ValidationError", async () => {
		await expect(cleanCommand([])).rejects.toThrow("No cleanup targets specified");
	});
});

// === --all ===

describe("--all", () => {
	test("wipes mail.db and WAL files", async () => {
		// Create a mail DB with messages
		const mailDbPath = join(overstoryDir, "mail.db");
		const store = createMailStore(mailDbPath);
		store.insert({
			id: "msg-1",
			from: "agent-a",
			to: "agent-b",
			subject: "test",
			body: "hello",
			type: "status",
			priority: "normal",
			threadId: null,
		});
		store.close();

		// Verify DB exists
		expect(await Bun.file(mailDbPath).exists()).toBe(true);

		await cleanCommand(["--all"]);

		// DB should be gone
		expect(await Bun.file(mailDbPath).exists()).toBe(false);
		expect(stdoutOutput).toContain("Wiped mail.db");
	});

	test("wipes metrics.db", async () => {
		const metricsDbPath = join(overstoryDir, "metrics.db");
		const store = createMetricsStore(metricsDbPath);
		store.recordSession({
			agentName: "test-agent",
			beadId: "task-1",
			capability: "builder",
			startedAt: new Date().toISOString(),
			completedAt: null,
			durationMs: 0,
			exitCode: null,
			mergeResult: null,
			parentAgent: null,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			estimatedCostUsd: null,
			modelUsed: null,
		});
		store.close();

		expect(await Bun.file(metricsDbPath).exists()).toBe(true);

		await cleanCommand(["--all"]);

		expect(await Bun.file(metricsDbPath).exists()).toBe(false);
		expect(stdoutOutput).toContain("Wiped metrics.db");
	});

	test("resets sessions.json to empty array", async () => {
		const sessionsPath = join(overstoryDir, "sessions.json");
		const sessions: AgentSession[] = [
			{
				id: "s1",
				agentName: "test-agent",
				capability: "builder",
				worktreePath: "/tmp/wt",
				branchName: "overstory/test/task",
				beadId: "task-1",
				tmuxSession: "overstory-test-agent",
				state: "completed",
				pid: 12345,
				parentAgent: null,
				depth: 1,
				runId: null,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
			},
		];
		await Bun.write(sessionsPath, `${JSON.stringify(sessions, null, "\t")}\n`);

		await cleanCommand(["--all"]);

		const content = await Bun.file(sessionsPath).text();
		expect(JSON.parse(content)).toEqual([]);
		expect(stdoutOutput).toContain("Reset sessions.json");
	});

	test("resets merge-queue.json to empty array", async () => {
		const queuePath = join(overstoryDir, "merge-queue.json");
		await Bun.write(queuePath, '[{"branchName":"test"}]\n');

		await cleanCommand(["--all"]);

		const content = await Bun.file(queuePath).text();
		expect(JSON.parse(content)).toEqual([]);
		expect(stdoutOutput).toContain("Reset merge-queue.json");
	});

	test("clears logs directory contents", async () => {
		const logsDir = join(overstoryDir, "logs");
		await mkdir(join(logsDir, "agent-a", "2026-01-01"), { recursive: true });
		await writeFile(join(logsDir, "agent-a", "2026-01-01", "session.log"), "log data");

		await cleanCommand(["--all"]);

		const entries = await readdir(logsDir);
		expect(entries).toHaveLength(0);
		expect(stdoutOutput).toContain("Cleared logs/");
	});

	test("clears agents directory contents", async () => {
		const agentsDir = join(overstoryDir, "agents");
		await mkdir(join(agentsDir, "test-agent"), { recursive: true });
		await writeFile(join(agentsDir, "test-agent", "identity.yaml"), "name: test-agent");

		await cleanCommand(["--all"]);

		const entries = await readdir(agentsDir);
		expect(entries).toHaveLength(0);
		expect(stdoutOutput).toContain("Cleared agents/");
	});

	test("clears specs directory contents", async () => {
		const specsDir = join(overstoryDir, "specs");
		await writeFile(join(specsDir, "task-123.md"), "# Spec");

		await cleanCommand(["--all"]);

		const entries = await readdir(specsDir);
		expect(entries).toHaveLength(0);
		expect(stdoutOutput).toContain("Cleared specs/");
	});

	test("deletes nudge-state.json", async () => {
		const nudgePath = join(overstoryDir, "nudge-state.json");
		await Bun.write(nudgePath, "{}");

		await cleanCommand(["--all"]);

		expect(await Bun.file(nudgePath).exists()).toBe(false);
		expect(stdoutOutput).toContain("Cleared nudge-state.json");
	});
});

// === individual flags ===

describe("individual flags", () => {
	test("--mail only wipes mail.db, leaves other state intact", async () => {
		// Create mail and sessions
		const mailDbPath = join(overstoryDir, "mail.db");
		const store = createMailStore(mailDbPath);
		store.insert({
			id: "msg-1",
			from: "a",
			to: "b",
			subject: "test",
			body: "hi",
			type: "status",
			priority: "normal",
			threadId: null,
		});
		store.close();

		const sessionsPath = join(overstoryDir, "sessions.json");
		await Bun.write(sessionsPath, '[{"id":"s1"}]\n');

		await cleanCommand(["--mail"]);

		// Mail gone
		expect(await Bun.file(mailDbPath).exists()).toBe(false);
		// Sessions untouched
		const sessionsContent = await Bun.file(sessionsPath).text();
		expect(JSON.parse(sessionsContent)).toEqual([{ id: "s1" }]);
	});

	test("--sessions only resets sessions.json", async () => {
		const sessionsPath = join(overstoryDir, "sessions.json");
		await Bun.write(sessionsPath, '[{"id":"s1"}]\n');

		// Create a spec file that should survive
		await writeFile(join(overstoryDir, "specs", "task.md"), "spec");

		await cleanCommand(["--sessions"]);

		const content = await Bun.file(sessionsPath).text();
		expect(JSON.parse(content)).toEqual([]);

		// Specs untouched
		const specEntries = await readdir(join(overstoryDir, "specs"));
		expect(specEntries).toHaveLength(1);
	});

	test("--logs clears logs but nothing else", async () => {
		const logsDir = join(overstoryDir, "logs");
		await mkdir(join(logsDir, "agent-x"), { recursive: true });
		await writeFile(join(logsDir, "agent-x", "session.log"), "data");

		await writeFile(join(overstoryDir, "specs", "task.md"), "spec");

		await cleanCommand(["--logs"]);

		const logEntries = await readdir(logsDir);
		expect(logEntries).toHaveLength(0);

		// Specs untouched
		const specEntries = await readdir(join(overstoryDir, "specs"));
		expect(specEntries).toHaveLength(1);
	});
});

// === idempotent ===

describe("idempotent", () => {
	test("running --all when nothing exists does not error", async () => {
		await cleanCommand(["--all"]);
		expect(stdoutOutput).toContain("Nothing to clean");
	});

	test("running --all twice does not error", async () => {
		// Create some state
		const mailDbPath = join(overstoryDir, "mail.db");
		const store = createMailStore(mailDbPath);
		store.close();

		await cleanCommand(["--all"]);
		stdoutOutput = "";
		await cleanCommand(["--all"]);
		expect(stdoutOutput).toContain("Nothing to clean");
	});
});

// === JSON output ===

describe("JSON output", () => {
	test("--json flag produces valid JSON", async () => {
		const mailDbPath = join(overstoryDir, "mail.db");
		const store = createMailStore(mailDbPath);
		store.insert({
			id: "msg-1",
			from: "a",
			to: "b",
			subject: "test",
			body: "hi",
			type: "status",
			priority: "normal",
			threadId: null,
		});
		store.close();

		await cleanCommand(["--all", "--json"]);

		const result = JSON.parse(stdoutOutput);
		expect(result).toHaveProperty("tmuxKilled");
		expect(result).toHaveProperty("mailWiped");
		expect(result).toHaveProperty("sessionsCleared");
		expect(result).toHaveProperty("metricsWiped");
		expect(result.mailWiped).toBe(true);
	});
});
