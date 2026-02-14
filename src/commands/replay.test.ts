/**
 * Tests for `overstory replay` command.
 *
 * Uses real bun:sqlite (temp files) to test the replay command end-to-end.
 * Captures process.stdout.write to verify output formatting.
 *
 * Real implementations used for: filesystem (temp dirs), SQLite (EventStore).
 * No mocks needed -- all dependencies are cheap and local.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import type { InsertEvent } from "../types.ts";
import { replayCommand } from "./replay.ts";

/** Helper to create an InsertEvent with sensible defaults. */
function makeEvent(overrides: Partial<InsertEvent> = {}): InsertEvent {
	return {
		runId: "run-001",
		agentName: "builder-1",
		sessionId: "sess-abc",
		eventType: "tool_start",
		toolName: "Read",
		toolArgs: '{"file": "src/index.ts"}',
		toolDurationMs: null,
		level: "info",
		data: null,
		...overrides,
	};
}

describe("replayCommand", () => {
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
		tempDir = await mkdtemp(join(tmpdir(), "replay-test-"));
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
			await replayCommand(["--help"]);
			const out = output();

			expect(out).toContain("overstory replay");
			expect(out).toContain("--run");
			expect(out).toContain("--agent");
			expect(out).toContain("--json");
			expect(out).toContain("--since");
			expect(out).toContain("--until");
			expect(out).toContain("--limit");
		});

		test("-h shows help text", async () => {
			await replayCommand(["-h"]);
			const out = output();

			expect(out).toContain("overstory replay");
		});
	});

	// === Argument parsing ===

	describe("argument parsing", () => {
		test("--limit with non-numeric value throws ValidationError", async () => {
			await expect(replayCommand(["--limit", "abc"])).rejects.toThrow(ValidationError);
		});

		test("--limit with zero throws ValidationError", async () => {
			await expect(replayCommand(["--limit", "0"])).rejects.toThrow(ValidationError);
		});

		test("--limit with negative value throws ValidationError", async () => {
			await expect(replayCommand(["--limit", "-5"])).rejects.toThrow(ValidationError);
		});

		test("--since with invalid timestamp throws ValidationError", async () => {
			await expect(replayCommand(["--since", "not-a-date"])).rejects.toThrow(ValidationError);
		});

		test("--until with invalid timestamp throws ValidationError", async () => {
			await expect(replayCommand(["--until", "not-a-date"])).rejects.toThrow(ValidationError);
		});
	});

	// === Missing events.db (graceful handling) ===

	describe("missing events.db", () => {
		test("text mode outputs friendly message when no events.db exists", async () => {
			await replayCommand([]);
			const out = output();

			expect(out).toBe("No events data yet.\n");
		});

		test("JSON mode outputs empty array when no events.db exists", async () => {
			await replayCommand(["--json"]);
			const out = output();

			expect(out).toBe("[]\n");
		});
	});

	// === JSON output mode ===

	describe("JSON output mode", () => {
		test("outputs valid JSON array with events", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1", eventType: "session_start" }));
			store.insert(makeEvent({ agentName: "scout-1", eventType: "tool_start" }));
			store.insert(makeEvent({ agentName: "builder-1", eventType: "session_end" }));
			store.close();

			await replayCommand(["--run", "run-001", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as unknown[];
			expect(parsed).toHaveLength(3);
			expect(Array.isArray(parsed)).toBe(true);
		});

		test("JSON output includes expected fields", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(
				makeEvent({
					agentName: "builder-1",
					eventType: "tool_start",
					toolName: "Bash",
					level: "info",
				}),
			);
			store.close();

			await replayCommand(["--run", "run-001", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as Record<string, unknown>[];
			expect(parsed).toHaveLength(1);
			const event = parsed[0];
			expect(event).toBeDefined();
			expect(event?.agentName).toBe("builder-1");
			expect(event?.eventType).toBe("tool_start");
			expect(event?.toolName).toBe("Bash");
			expect(event?.level).toBe("info");
			expect(event?.createdAt).toBeTruthy();
		});

		test("JSON output returns empty array when no events match run", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ runId: "run-other" }));
			store.close();

			await replayCommand(["--run", "run-001", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as unknown[];
			expect(parsed).toEqual([]);
		});
	});

	// === Human output format ===

	describe("human output format", () => {
		test("shows Replay header", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent());
			store.close();

			await replayCommand(["--run", "run-001"]);
			const out = output();

			expect(out).toContain("Replay");
		});

		test("shows separator line", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent());
			store.close();

			await replayCommand(["--run", "run-001"]);
			const out = output();

			expect(out).toContain("=".repeat(70));
		});

		test("shows event count", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1", eventType: "session_start" }));
			store.insert(makeEvent({ agentName: "scout-1", eventType: "tool_start" }));
			store.insert(makeEvent({ agentName: "builder-1", eventType: "session_end" }));
			store.close();

			await replayCommand(["--run", "run-001"]);
			const out = output();

			expect(out).toContain("3 events");
		});

		test("shows singular event count", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent());
			store.close();

			await replayCommand(["--run", "run-001"]);
			const out = output();

			expect(out).toContain("1 event");
			expect(out).not.toMatch(/1 events/);
		});

		test("no events shows 'No events found' message", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ runId: "run-other" }));
			store.close();

			await replayCommand(["--run", "run-001"]);
			const out = output();

			expect(out).toContain("No events found");
		});

		test("agent name is shown in brackets for every event", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.insert(makeEvent({ agentName: "scout-1" }));
			store.close();

			await replayCommand(["--run", "run-001"]);
			const out = output();

			expect(out).toContain("[builder-1]");
			expect(out).toContain("[scout-1]");
		});

		test("event type labels are shown", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ eventType: "session_start" }));
			store.insert(makeEvent({ eventType: "tool_start" }));
			store.insert(makeEvent({ eventType: "error", level: "error" }));
			store.close();

			await replayCommand(["--run", "run-001"]);
			const out = output();

			expect(out).toContain("SESSION  +");
			expect(out).toContain("TOOL START");
			expect(out).toContain("ERROR");
		});

		test("tool name is shown in detail", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ eventType: "tool_start", toolName: "Bash" }));
			store.close();

			await replayCommand(["--run", "run-001"]);
			const out = output();

			expect(out).toContain("tool=Bash");
		});

		test("date separator appears in timeline", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent());
			store.close();

			await replayCommand(["--run", "run-001"]);
			const out = output();

			expect(out).toMatch(/---\s+\d{4}-\d{2}-\d{2}\s+---/);
		});
	});

	// === --run filter ===

	describe("--run filter", () => {
		test("filters events by run ID", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ runId: "run-001", agentName: "builder-1" }));
			store.insert(makeEvent({ runId: "run-002", agentName: "scout-1" }));
			store.insert(makeEvent({ runId: "run-001", agentName: "builder-2" }));
			store.close();

			await replayCommand(["--run", "run-001", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as Record<string, unknown>[];
			expect(parsed).toHaveLength(2);
			for (const event of parsed) {
				expect(event.runId).toBe("run-001");
			}
		});

		test("--run with --since filters both", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ runId: "run-001" }));
			store.close();

			// Future since should return no events
			await replayCommand(["--run", "run-001", "--json", "--since", "2099-01-01T00:00:00Z"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as unknown[];
			expect(parsed).toEqual([]);
		});
	});

	// === --agent filter ===

	describe("--agent filter", () => {
		test("single --agent filters to one agent", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.insert(makeEvent({ agentName: "scout-1" }));
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.close();

			await replayCommand(["--agent", "builder-1", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as Record<string, unknown>[];
			expect(parsed).toHaveLength(2);
			for (const event of parsed) {
				expect(event.agentName).toBe("builder-1");
			}
		});

		test("multiple --agent flags merge events from all agents", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.insert(makeEvent({ agentName: "scout-1" }));
			store.insert(makeEvent({ agentName: "reviewer-1" }));
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.close();

			await replayCommand(["--agent", "builder-1", "--agent", "scout-1", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as Record<string, unknown>[];
			expect(parsed).toHaveLength(3);
			const agents = new Set(parsed.map((e) => e.agentName));
			expect(agents.has("builder-1")).toBe(true);
			expect(agents.has("scout-1")).toBe(true);
			expect(agents.has("reviewer-1")).toBe(false);
		});

		test("--agent events are sorted chronologically", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			// Insert in order; they get sequential timestamps from SQLite
			store.insert(makeEvent({ agentName: "builder-1", eventType: "session_start" }));
			store.insert(makeEvent({ agentName: "scout-1", eventType: "tool_start" }));
			store.insert(makeEvent({ agentName: "builder-1", eventType: "tool_end" }));
			store.close();

			await replayCommand(["--agent", "builder-1", "--agent", "scout-1", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as Record<string, unknown>[];
			expect(parsed).toHaveLength(3);
			// They should be in chronological order
			for (let i = 1; i < parsed.length; i++) {
				const prev = parsed[i - 1];
				const curr = parsed[i];
				if (prev && curr) {
					expect(
						(prev.createdAt as string).localeCompare(curr.createdAt as string),
					).toBeLessThanOrEqual(0);
				}
			}
		});

		test("--agent with no matching events returns empty", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "other-agent" }));
			store.close();

			await replayCommand(["--agent", "nonexistent", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as unknown[];
			expect(parsed).toEqual([]);
		});
	});

	// === Default behavior (no --run or --agent) ===

	describe("default behavior", () => {
		test("uses current-run.txt when it exists", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ runId: "run-from-file", agentName: "builder-1" }));
			store.insert(makeEvent({ runId: "run-other", agentName: "scout-1" }));
			store.close();

			// Write current-run.txt
			await Bun.write(join(tempDir, ".overstory", "current-run.txt"), "run-from-file\n");

			await replayCommand(["--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as Record<string, unknown>[];
			expect(parsed).toHaveLength(1);
			expect(parsed[0]?.runId).toBe("run-from-file");
		});

		test("falls back to 24h timeline when no current-run.txt", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			// These events were just inserted, so they're within the last 24h
			store.insert(makeEvent({ agentName: "builder-1", runId: null }));
			store.insert(makeEvent({ agentName: "scout-1", runId: null }));
			store.close();

			await replayCommand(["--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as unknown[];
			expect(parsed).toHaveLength(2);
		});

		test("falls back to timeline when current-run.txt is empty", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1", runId: null }));
			store.close();

			await Bun.write(join(tempDir, ".overstory", "current-run.txt"), "");

			await replayCommand(["--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as unknown[];
			expect(parsed).toHaveLength(1);
		});
	});

	// === --limit flag ===

	describe("--limit flag", () => {
		test("limits the number of events returned", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			for (let i = 0; i < 10; i++) {
				store.insert(makeEvent());
			}
			store.close();

			await replayCommand(["--run", "run-001", "--json", "--limit", "3"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as unknown[];
			expect(parsed).toHaveLength(3);
		});

		test("default limit is 200", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			for (let i = 0; i < 220; i++) {
				store.insert(makeEvent());
			}
			store.close();

			await replayCommand(["--run", "run-001", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as unknown[];
			expect(parsed).toHaveLength(200);
		});

		test("--limit applies to merged --agent queries", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			for (let i = 0; i < 5; i++) {
				store.insert(makeEvent({ agentName: "builder-1" }));
				store.insert(makeEvent({ agentName: "scout-1" }));
			}
			store.close();

			await replayCommand(["--agent", "builder-1", "--agent", "scout-1", "--json", "--limit", "4"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as unknown[];
			expect(parsed).toHaveLength(4);
		});
	});

	// === --since and --until flags ===

	describe("--since and --until flags", () => {
		test("--since filters events after a timestamp", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent());
			store.close();

			// A future timestamp should return no events
			await replayCommand(["--run", "run-001", "--json", "--since", "2099-01-01T00:00:00Z"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as unknown[];
			expect(parsed).toEqual([]);
		});

		test("--since with past timestamp returns all events", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent());
			store.insert(makeEvent({ agentName: "scout-1" }));
			store.close();

			await replayCommand(["--run", "run-001", "--json", "--since", "2020-01-01T00:00:00Z"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as unknown[];
			expect(parsed).toHaveLength(2);
		});

		test("--until with past timestamp returns no events", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent());
			store.close();

			await replayCommand(["--run", "run-001", "--json", "--until", "2000-01-01T00:00:00Z"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as unknown[];
			expect(parsed).toEqual([]);
		});

		test("--since causes absolute timestamps in text mode", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent());
			store.close();

			await replayCommand(["--run", "run-001", "--since", "2020-01-01T00:00:00Z"]);
			const out = output();

			// Absolute timestamps show HH:MM:SS format
			expect(out).toMatch(/\d{2}:\d{2}:\d{2}/);
		});
	});

	// === Interleaving order ===

	describe("interleaving order", () => {
		test("events from different agents are interleaved chronologically", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			// Insert in alternating order; SQLite timestamps are sequential
			store.insert(makeEvent({ agentName: "builder-1", eventType: "session_start" }));
			store.insert(makeEvent({ agentName: "scout-1", eventType: "session_start" }));
			store.insert(makeEvent({ agentName: "builder-1", eventType: "tool_start" }));
			store.insert(makeEvent({ agentName: "scout-1", eventType: "tool_end" }));
			store.close();

			await replayCommand(["--run", "run-001", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as Record<string, unknown>[];
			expect(parsed).toHaveLength(4);
			// Verify chronological order
			for (let i = 1; i < parsed.length; i++) {
				const prev = parsed[i - 1];
				const curr = parsed[i];
				if (prev && curr) {
					expect(
						(prev.createdAt as string).localeCompare(curr.createdAt as string),
					).toBeLessThanOrEqual(0);
				}
			}
			// Verify interleaving: agents should alternate
			expect(parsed[0]?.agentName).toBe("builder-1");
			expect(parsed[1]?.agentName).toBe("scout-1");
			expect(parsed[2]?.agentName).toBe("builder-1");
			expect(parsed[3]?.agentName).toBe("scout-1");
		});
	});

	// === Agent color assignment ===

	describe("agent color assignment", () => {
		test("different agents get color-labeled brackets in human output", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.insert(makeEvent({ agentName: "scout-1" }));
			store.insert(makeEvent({ agentName: "reviewer-1" }));
			store.close();

			await replayCommand(["--run", "run-001"]);
			const out = output();

			// All three agents should appear in brackets
			expect(out).toContain("[builder-1]");
			expect(out).toContain("[scout-1]");
			expect(out).toContain("[reviewer-1]");
		});
	});

	// === Edge cases ===

	describe("edge cases", () => {
		test("handles event with all null optional fields", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(
				makeEvent({
					agentName: "builder-1",
					eventType: "session_start",
					runId: "run-001",
					sessionId: null,
					toolName: null,
					toolArgs: null,
					toolDurationMs: null,
					data: null,
				}),
			);
			store.close();

			// Should not throw
			await replayCommand(["--run", "run-001"]);
			const out = output();

			expect(out).toContain("Replay");
			expect(out).toContain("1 event");
		});

		test("all event types have labeled output", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			const eventTypes = [
				"tool_start",
				"tool_end",
				"session_start",
				"session_end",
				"mail_sent",
				"mail_received",
				"spawn",
				"error",
				"custom",
			] as const;
			for (const eventType of eventTypes) {
				store.insert(
					makeEvent({
						eventType,
						level: eventType === "error" ? "error" : "info",
					}),
				);
			}
			store.close();

			await replayCommand(["--run", "run-001"]);
			const out = output();

			expect(out).toContain("TOOL START");
			expect(out).toContain("TOOL END");
			expect(out).toContain("SESSION  +");
			expect(out).toContain("SESSION  -");
			expect(out).toContain("MAIL SENT");
			expect(out).toContain("MAIL RECV");
			expect(out).toContain("SPAWN");
			expect(out).toContain("ERROR");
			expect(out).toContain("CUSTOM");
		});

		test("long data values are truncated", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			const longValue = "x".repeat(200);
			store.insert(
				makeEvent({
					eventType: "custom",
					toolName: null,
					data: JSON.stringify({ message: longValue }),
				}),
			);
			store.close();

			await replayCommand(["--run", "run-001"]);
			const out = output();

			expect(out).not.toContain(longValue);
			expect(out).toContain("...");
		});
	});
});
