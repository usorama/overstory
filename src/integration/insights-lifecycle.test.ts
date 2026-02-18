/**
 * Integration test: Insights analyzer with real EventStore.
 *
 * Exercises analyzeSessionInsights() and inferDomain() against real SQLite
 * EventStore data. Verifies tool profile generation, hot file detection,
 * error pattern analysis, and domain inference.
 *
 * Uses real SQLite databases and EventStore. Mulch CLI calls and the
 * autoRecordExpertise() lifecycle hook are not tested here (they require
 * the external mulch binary and produce side effects).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createEventStore } from "../events/store.ts";
import { analyzeSessionInsights, inferDomain } from "../insights/analyzer.ts";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";

let tempDir: string;
let overstoryDir: string;

beforeEach(async () => {
	tempDir = await createTempGitRepo();
	overstoryDir = join(tempDir, ".overstory");
	await mkdir(overstoryDir, { recursive: true });
});

afterEach(async () => {
	await cleanupTempDir(tempDir);
});

describe("inferDomain", () => {
	test("maps src/mail/ to messaging", () => {
		expect(inferDomain("src/mail/store.ts")).toBe("messaging");
	});

	test("maps src/commands/ to cli", () => {
		expect(inferDomain("src/commands/sling.ts")).toBe("cli");
	});

	test("maps src/agents/ to agents", () => {
		expect(inferDomain("src/agents/manifest.ts")).toBe("agents");
	});

	test("maps agents/ root to agents", () => {
		expect(inferDomain("agents/builder.md")).toBe("agents");
	});

	test("maps src/merge/ to architecture", () => {
		expect(inferDomain("src/merge/resolver.ts")).toBe("architecture");
	});

	test("maps src/worktree/ to architecture", () => {
		expect(inferDomain("src/worktree/manager.ts")).toBe("architecture");
	});

	test("maps .test.ts files to typescript", () => {
		expect(inferDomain("src/config.test.ts")).toBe("typescript");
	});

	test("maps generic src/ files to typescript", () => {
		expect(inferDomain("src/types.ts")).toBe("typescript");
	});

	test("returns null for unrecognized paths", () => {
		expect(inferDomain("README.md")).toBeNull();
		expect(inferDomain("package.json")).toBeNull();
	});
});

describe("analyzeSessionInsights with real EventStore", () => {
	test("produces tool workflow insight when >= 10 tool calls", () => {
		const eventsDbPath = join(overstoryDir, "events.db");
		const eventStore = createEventStore(eventsDbPath);

		// Insert 12 events: 8 Read + 2 Edit + 2 Bash
		for (let i = 0; i < 8; i++) {
			eventStore.insert({
				runId: "run-1",
				agentName: "builder-test",
				sessionId: "sess-1",
				eventType: "tool_start",
				toolName: "Read",
				toolArgs: JSON.stringify({ file_path: `src/file-${i}.ts` }),
				toolDurationMs: null,
				level: "info",
				data: null,
			});
		}
		for (let i = 0; i < 2; i++) {
			eventStore.insert({
				runId: "run-1",
				agentName: "builder-test",
				sessionId: "sess-1",
				eventType: "tool_start",
				toolName: "Edit",
				toolArgs: JSON.stringify({ file_path: "src/main.ts" }),
				toolDurationMs: null,
				level: "info",
				data: null,
			});
		}
		for (let i = 0; i < 2; i++) {
			eventStore.insert({
				runId: "run-1",
				agentName: "builder-test",
				sessionId: "sess-1",
				eventType: "tool_start",
				toolName: "Bash",
				toolArgs: JSON.stringify({ command: "bun test" }),
				toolDurationMs: null,
				level: "info",
				data: null,
			});
		}

		const events = eventStore.getByAgent("builder-test");
		const toolStats = eventStore.getToolStats({ agentName: "builder-test" });
		eventStore.close();

		const analysis = analyzeSessionInsights({
			events,
			toolStats,
			agentName: "builder-test",
			capability: "builder",
			domains: ["cli"],
		});

		// Should produce exactly 1 insight (tool workflow — no hot files, no errors)
		expect(analysis.insights.length).toBe(1);
		const workflowInsight = analysis.insights.find((i) => i.description.includes("tool profile"));
		expect(workflowInsight).toBeDefined();
		expect(workflowInsight?.description).toContain("read-heavy");
		expect(workflowInsight?.tags).toContain("auto-insight");
		expect(workflowInsight?.tags).toContain("tool-profile");
		expect(workflowInsight?.tags).toContain("builder");

		// Tool profile
		expect(analysis.toolProfile.totalToolCalls).toBe(12);
		expect(analysis.toolProfile.topTools[0]?.name).toBe("Read");
		expect(analysis.toolProfile.topTools[0]?.count).toBe(8);
	});

	test("detects hot files (3+ edits)", () => {
		const eventsDbPath = join(overstoryDir, "events.db");
		const eventStore = createEventStore(eventsDbPath);

		// Edit the same file 4 times
		for (let i = 0; i < 4; i++) {
			eventStore.insert({
				runId: "run-1",
				agentName: "builder-hot",
				sessionId: "sess-1",
				eventType: "tool_start",
				toolName: "Edit",
				toolArgs: JSON.stringify({ file_path: "src/commands/sling.ts" }),
				toolDurationMs: null,
				level: "info",
				data: null,
			});
		}

		const events = eventStore.getByAgent("builder-hot");
		const toolStats = eventStore.getToolStats({ agentName: "builder-hot" });
		eventStore.close();

		const analysis = analyzeSessionInsights({
			events,
			toolStats,
			agentName: "builder-hot",
			capability: "builder",
			domains: ["cli"],
		});

		// Should detect hot file
		expect(analysis.fileProfile.hotFiles.length).toBe(1);
		expect(analysis.fileProfile.hotFiles[0]?.path).toBe("src/commands/sling.ts");
		expect(analysis.fileProfile.hotFiles[0]?.editCount).toBe(4);
		expect(analysis.fileProfile.totalEdits).toBe(4);

		// Should produce hot-file insight
		const hotInsight = analysis.insights.find((i) => i.tags.includes("hot-file"));
		expect(hotInsight).toBeDefined();
		expect(hotInsight?.description).toContain("sling.ts");
		expect(hotInsight?.description).toContain("4 edits");
		// Domain should be inferred from path
		expect(hotInsight?.domain).toBe("cli");
	});

	test("detects error patterns", () => {
		const eventsDbPath = join(overstoryDir, "events.db");
		const eventStore = createEventStore(eventsDbPath);

		// Insert normal events + errors
		eventStore.insert({
			runId: "run-1",
			agentName: "builder-err",
			sessionId: "sess-1",
			eventType: "tool_start",
			toolName: "Bash",
			toolArgs: JSON.stringify({ command: "bun test" }),
			toolDurationMs: null,
			level: "info",
			data: null,
		});
		eventStore.insert({
			runId: "run-1",
			agentName: "builder-err",
			sessionId: "sess-1",
			eventType: "error",
			toolName: "Bash",
			toolArgs: null,
			toolDurationMs: null,
			level: "error",
			data: JSON.stringify({ message: "test failed" }),
		});
		eventStore.insert({
			runId: "run-1",
			agentName: "builder-err",
			sessionId: "sess-1",
			eventType: "error",
			toolName: "Edit",
			toolArgs: null,
			toolDurationMs: null,
			level: "error",
			data: JSON.stringify({ message: "file not found" }),
		});

		const events = eventStore.getByAgent("builder-err");
		const toolStats = eventStore.getToolStats({ agentName: "builder-err" });
		eventStore.close();

		const analysis = analyzeSessionInsights({
			events,
			toolStats,
			agentName: "builder-err",
			capability: "builder",
			domains: ["typescript"],
		});

		expect(analysis.toolProfile.errorCount).toBe(2);

		const errorInsight = analysis.insights.find((i) => i.tags.includes("error-pattern"));
		expect(errorInsight).toBeDefined();
		expect(errorInsight?.type).toBe("failure");
		expect(errorInsight?.description).toContain("2 error");
		expect(errorInsight?.description).toContain("Bash");
		expect(errorInsight?.description).toContain("Edit");
	});

	test("returns empty insights for sessions with < 10 tool calls and no errors", () => {
		const analysis = analyzeSessionInsights({
			events: [],
			toolStats: [],
			agentName: "builder-quiet",
			capability: "builder",
			domains: ["cli"],
		});

		expect(analysis.insights).toEqual([]);
		expect(analysis.toolProfile.totalToolCalls).toBe(0);
		expect(analysis.toolProfile.errorCount).toBe(0);
		expect(analysis.fileProfile.hotFiles).toEqual([]);
		expect(analysis.fileProfile.totalEdits).toBe(0);
	});
});
