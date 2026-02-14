/**
 * Tests for `overstory errors` command.
 *
 * Uses real bun:sqlite (temp files) to test the errors command end-to-end.
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
import { errorsCommand } from "./errors.ts";

/** Helper to create an InsertEvent with sensible defaults. */
function makeEvent(overrides: Partial<InsertEvent> = {}): InsertEvent {
	return {
		runId: "run-001",
		agentName: "builder-1",
		sessionId: "sess-abc",
		eventType: "error",
		toolName: null,
		toolArgs: null,
		toolDurationMs: null,
		level: "error",
		data: null,
		...overrides,
	};
}

describe("errorsCommand", () => {
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
		tempDir = await mkdtemp(join(tmpdir(), "errors-test-"));
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
			await errorsCommand(["--help"]);
			const out = output();

			expect(out).toContain("overstory errors");
			expect(out).toContain("--agent");
			expect(out).toContain("--run");
			expect(out).toContain("--json");
			expect(out).toContain("--since");
			expect(out).toContain("--until");
			expect(out).toContain("--limit");
		});

		test("-h shows help text", async () => {
			await errorsCommand(["-h"]);
			const out = output();

			expect(out).toContain("overstory errors");
		});
	});

	// === Argument parsing ===

	describe("argument parsing", () => {
		test("--limit with non-numeric value throws ValidationError", async () => {
			await expect(errorsCommand(["--limit", "abc"])).rejects.toThrow(ValidationError);
		});

		test("--limit with zero throws ValidationError", async () => {
			await expect(errorsCommand(["--limit", "0"])).rejects.toThrow(ValidationError);
		});

		test("--limit with negative value throws ValidationError", async () => {
			await expect(errorsCommand(["--limit", "-5"])).rejects.toThrow(ValidationError);
		});

		test("--since with invalid timestamp throws ValidationError", async () => {
			await expect(errorsCommand(["--since", "not-a-date"])).rejects.toThrow(ValidationError);
		});

		test("--until with invalid timestamp throws ValidationError", async () => {
			await expect(errorsCommand(["--until", "not-a-date"])).rejects.toThrow(ValidationError);
		});
	});

	// === Missing events.db (graceful handling) ===

	describe("missing events.db", () => {
		test("text mode outputs friendly message when no events.db exists", async () => {
			await errorsCommand([]);
			const out = output();

			expect(out).toBe("No events data yet.\n");
		});

		test("JSON mode outputs empty array when no events.db exists", async () => {
			await errorsCommand(["--json"]);
			const out = output();

			expect(out).toBe("[]\n");
		});
	});

	// === JSON output mode ===

	describe("JSON output mode", () => {
		test("outputs valid JSON array with error events", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.insert(makeEvent({ agentName: "builder-2" }));
			store.insert(
				makeEvent({
					agentName: "builder-1",
					eventType: "tool_start",
					level: "info",
				}),
			);
			store.close();

			await errorsCommand(["--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as unknown[];
			expect(parsed).toHaveLength(2);
			expect(Array.isArray(parsed)).toBe(true);
		});

		test("JSON output includes expected fields", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(
				makeEvent({
					agentName: "builder-1",
					data: '{"message":"something broke"}',
				}),
			);
			store.close();

			await errorsCommand(["--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as Record<string, unknown>[];
			expect(parsed).toHaveLength(1);
			const event = parsed[0];
			expect(event).toBeDefined();
			expect(event?.agentName).toBe("builder-1");
			expect(event?.eventType).toBe("error");
			expect(event?.level).toBe("error");
			expect(event?.createdAt).toBeTruthy();
		});

		test("JSON output returns empty array when no errors exist", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(
				makeEvent({
					agentName: "builder-1",
					eventType: "tool_start",
					level: "info",
				}),
			);
			store.close();

			await errorsCommand(["--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as unknown[];
			expect(parsed).toEqual([]);
		});
	});

	// === Human output format ===

	describe("human output", () => {
		test("shows header", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent());
			store.close();

			await errorsCommand([]);
			const out = output();

			expect(out).toContain("Errors");
			expect(out).toContain("=".repeat(70));
		});

		test("shows error count", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.insert(makeEvent({ agentName: "builder-2" }));
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.close();

			await errorsCommand([]);
			const out = output();

			expect(out).toContain("3 errors");
		});

		test("shows singular error count", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent());
			store.close();

			await errorsCommand([]);
			const out = output();

			expect(out).toContain("1 error");
			// Should NOT say "1 errors"
			expect(out).not.toMatch(/1 errors/);
		});

		test("no errors shows 'No errors found' message", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			// Insert a non-error event so the DB exists but has no errors
			store.insert(
				makeEvent({
					eventType: "tool_start",
					level: "info",
				}),
			);
			store.close();

			await errorsCommand([]);
			const out = output();

			expect(out).toContain("No errors found");
		});

		test("groups errors by agent name", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.insert(makeEvent({ agentName: "scout-1" }));
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.close();

			await errorsCommand([]);
			const out = output();

			// Both agent names should appear as group headers
			expect(out).toContain("builder-1");
			expect(out).toContain("scout-1");
			// Per-agent counts should appear
			expect(out).toContain("2 errors");
			expect(out).toContain("1 error");
		});

		test("shows ERROR label for each event", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent());
			store.close();

			await errorsCommand([]);
			const out = output();

			expect(out).toContain("ERROR");
		});

		test("shows timestamp for each error", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent());
			store.close();

			await errorsCommand([]);
			const out = output();

			// Should contain a timestamp in HH:MM:SS format
			expect(out).toMatch(/\d{2}:\d{2}:\d{2}/);
		});

		test("shows tool name in detail", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ toolName: "Bash" }));
			store.close();

			await errorsCommand([]);
			const out = output();

			expect(out).toContain("tool=Bash");
		});

		test("shows custom data fields in detail", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(
				makeEvent({
					data: '{"reason":"disk full","code":500}',
				}),
			);
			store.close();

			await errorsCommand([]);
			const out = output();

			expect(out).toContain("reason=disk full");
			expect(out).toContain("code=500");
		});

		test("long data values are truncated", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			const longValue = "x".repeat(200);
			store.insert(
				makeEvent({
					data: JSON.stringify({ message: longValue }),
				}),
			);
			store.close();

			await errorsCommand([]);
			const out = output();

			// The full 200-char value should not appear
			expect(out).not.toContain(longValue);
			// But a truncated version with "..." should
			expect(out).toContain("...");
		});

		test("non-JSON data is shown raw if short", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ data: "simple error text" }));
			store.close();

			await errorsCommand([]);
			const out = output();

			expect(out).toContain("simple error text");
		});
	});

	// === --agent filter ===

	describe("--agent filter", () => {
		test("filters errors to a specific agent", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.insert(makeEvent({ agentName: "builder-2" }));
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.close();

			await errorsCommand(["--agent", "builder-1", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as Record<string, unknown>[];
			expect(parsed).toHaveLength(2);
			for (const event of parsed) {
				expect(event.agentName).toBe("builder-1");
			}
		});

		test("returns empty when agent has no errors", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.close();

			await errorsCommand(["--agent", "nonexistent", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as unknown[];
			expect(parsed).toEqual([]);
		});

		test("only returns error-level events for the agent", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1", level: "error" }));
			store.insert(
				makeEvent({
					agentName: "builder-1",
					eventType: "tool_start",
					level: "info",
				}),
			);
			store.insert(
				makeEvent({
					agentName: "builder-1",
					eventType: "tool_end",
					level: "warn",
				}),
			);
			store.close();

			await errorsCommand(["--agent", "builder-1", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as Record<string, unknown>[];
			expect(parsed).toHaveLength(1);
			expect(parsed[0]?.level).toBe("error");
		});
	});

	// === --run filter ===

	describe("--run filter", () => {
		test("filters errors to a specific run", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ runId: "run-001" }));
			store.insert(makeEvent({ runId: "run-002" }));
			store.insert(makeEvent({ runId: "run-001" }));
			store.close();

			await errorsCommand(["--run", "run-001", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as Record<string, unknown>[];
			expect(parsed).toHaveLength(2);
			for (const event of parsed) {
				expect(event.runId).toBe("run-001");
			}
		});

		test("returns empty when run has no errors", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ runId: "run-001" }));
			store.close();

			await errorsCommand(["--run", "run-999", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as unknown[];
			expect(parsed).toEqual([]);
		});

		test("only returns error-level events for the run", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ runId: "run-001", level: "error" }));
			store.insert(
				makeEvent({
					runId: "run-001",
					eventType: "tool_start",
					level: "info",
				}),
			);
			store.close();

			await errorsCommand(["--run", "run-001", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as Record<string, unknown>[];
			expect(parsed).toHaveLength(1);
			expect(parsed[0]?.level).toBe("error");
		});
	});

	// === --limit flag ===

	describe("--limit flag", () => {
		test("limits the number of errors returned", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			for (let i = 0; i < 10; i++) {
				store.insert(makeEvent());
			}
			store.close();

			await errorsCommand(["--json", "--limit", "3"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as unknown[];
			expect(parsed).toHaveLength(3);
		});

		test("default limit is 100", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			for (let i = 0; i < 120; i++) {
				store.insert(makeEvent());
			}
			store.close();

			await errorsCommand(["--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as unknown[];
			expect(parsed).toHaveLength(100);
		});
	});

	// === --since and --until flags ===

	describe("--since and --until flags", () => {
		test("--since with future timestamp returns no errors", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent());
			store.close();

			await errorsCommand(["--json", "--since", "2099-01-01T00:00:00Z"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as unknown[];
			expect(parsed).toEqual([]);
		});

		test("--since with past timestamp returns all errors", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent());
			store.insert(makeEvent());
			store.close();

			await errorsCommand(["--json", "--since", "2020-01-01T00:00:00Z"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as unknown[];
			expect(parsed).toHaveLength(2);
		});

		test("--until with past timestamp returns no errors", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent());
			store.close();

			await errorsCommand(["--json", "--until", "2000-01-01T00:00:00Z"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as unknown[];
			expect(parsed).toEqual([]);
		});
	});

	// === Edge cases ===

	describe("edge cases", () => {
		test("handles event with all null optional fields", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(
				makeEvent({
					runId: null,
					sessionId: null,
					toolName: null,
					toolArgs: null,
					toolDurationMs: null,
					data: null,
				}),
			);
			store.close();

			// Should not throw
			await errorsCommand([]);
			const out = output();

			expect(out).toContain("Errors");
			expect(out).toContain("1 error");
		});

		test("no arguments shows all errors (global view)", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.insert(makeEvent({ agentName: "scout-1" }));
			store.insert(makeEvent({ agentName: "builder-2" }));
			store.close();

			await errorsCommand(["--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as unknown[];
			expect(parsed).toHaveLength(3);
		});

		test("excludes non-error events from global view", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ level: "error" }));
			store.insert(
				makeEvent({
					eventType: "tool_start",
					level: "info",
				}),
			);
			store.insert(
				makeEvent({
					eventType: "session_start",
					level: "info",
				}),
			);
			store.insert(
				makeEvent({
					eventType: "tool_end",
					level: "warn",
				}),
			);
			store.close();

			await errorsCommand(["--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as Record<string, unknown>[];
			expect(parsed).toHaveLength(1);
			expect(parsed[0]?.level).toBe("error");
		});
	});
});
