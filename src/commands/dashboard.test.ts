/**
 * Tests for overstory dashboard command.
 *
 * We only test help output and validation since the dashboard runs an infinite
 * polling loop. The actual rendering cannot be tested without complex mocking
 * of terminal state and multiple data sources.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../errors.ts";
import { dashboardCommand, filterAgentsByRun, horizontalLine, pad, truncate } from "./dashboard.ts";

describe("dashboardCommand", () => {
	let chunks: string[];
	let originalWrite: typeof process.stdout.write;
	let tempDir: string;

	beforeEach(async () => {
		chunks = [];
		originalWrite = process.stdout.write;
		process.stdout.write = ((chunk: string) => {
			chunks.push(chunk);
			return true;
		}) as typeof process.stdout.write;

		tempDir = await mkdtemp(join(tmpdir(), "dashboard-test-"));
	});

	afterEach(async () => {
		process.stdout.write = originalWrite;
		await rm(tempDir, { recursive: true, force: true });
	});

	function output(): string {
		return chunks.join("");
	}

	test("--help flag prints help text", async () => {
		await dashboardCommand(["--help"]);
		const out = output();

		expect(out).toContain("overstory dashboard");
		expect(out).toContain("--interval");
		expect(out).toContain("Ctrl+C");
	});

	test("-h flag prints help text", async () => {
		await dashboardCommand(["-h"]);
		const out = output();

		expect(out).toContain("overstory dashboard");
		expect(out).toContain("--interval");
		expect(out).toContain("Ctrl+C");
	});

	test("--interval with non-numeric value throws ValidationError", async () => {
		await expect(dashboardCommand(["--interval", "abc"])).rejects.toThrow(ValidationError);
	});

	test("--interval below 500 throws ValidationError", async () => {
		await expect(dashboardCommand(["--interval", "499"])).rejects.toThrow(ValidationError);
	});

	test("--interval with NaN throws ValidationError", async () => {
		await expect(dashboardCommand(["--interval", "not-a-number"])).rejects.toThrow(ValidationError);
	});

	test("--interval at exactly 500 passes validation", async () => {
		// This test verifies that interval validation passes for the value 500.
		// We chdir to a temp dir WITHOUT .overstory/config.yaml so that loadConfig()
		// throws BEFORE the infinite while loop starts. This proves validation passed
		// (no ValidationError about interval) while preventing the loop from leaking.

		const originalCwd = process.cwd();

		try {
			process.chdir(tempDir);
			await dashboardCommand(["--interval", "500"]);
		} catch (err) {
			// If it's a ValidationError about interval, the test should fail
			if (err instanceof ValidationError && err.field === "interval") {
				throw new Error("Interval validation should have passed for value 500");
			}
			// Other errors (like from loadConfig) are expected - they occur after validation passed
		} finally {
			process.chdir(originalCwd);
		}

		// If we reach here without throwing a ValidationError about interval, validation passed
	});

	test("help text includes --all flag", async () => {
		await dashboardCommand(["--help"]);
		const out = output();

		expect(out).toContain("--all");
	});

	test("help text describes current run scoping", async () => {
		await dashboardCommand(["--help"]);
		const out = output();

		expect(out).toContain("current run");
	});
});

describe("pad", () => {
	test("zero width returns empty string", () => {
		expect(pad("hello", 0)).toBe("");
	});

	test("negative width returns empty string", () => {
		expect(pad("hello", -1)).toBe("");
	});

	test("truncates string longer than width", () => {
		expect(pad("hello", 3)).toBe("hel");
	});

	test("pads string shorter than width with spaces", () => {
		expect(pad("hi", 5)).toBe("hi   ");
	});
});

describe("truncate", () => {
	test("zero maxLen returns empty string", () => {
		expect(truncate("hello world", 0)).toBe("");
	});

	test("negative maxLen returns empty string", () => {
		expect(truncate("hello world", -1)).toBe("");
	});

	test("truncates with ellipsis", () => {
		expect(truncate("hello world", 5)).toBe("hell…");
	});

	test("string shorter than maxLen returned as-is", () => {
		expect(truncate("hi", 10)).toBe("hi");
	});
});

describe("horizontalLine", () => {
	test("width 0 does not throw", () => {
		expect(() => horizontalLine(0, "┌", "─", "┐")).not.toThrow();
	});

	test("width 1 does not throw", () => {
		expect(() => horizontalLine(1, "┌", "─", "┐")).not.toThrow();
	});

	test("width 2 returns just connectors", () => {
		expect(horizontalLine(2, "┌", "─", "┐")).toBe("┌┐");
	});

	test("width 4 returns connectors with fill", () => {
		expect(horizontalLine(4, "┌", "─", "┐")).toBe("┌──┐");
	});
});

describe("filterAgentsByRun", () => {
	type Stub = { runId: string | null; name: string };

	const coordinator: Stub = { runId: null, name: "coordinator" };
	const builder1: Stub = { runId: "run-001", name: "builder-1" };
	const builder2: Stub = { runId: "run-002", name: "builder-2" };
	const agents = [coordinator, builder1, builder2];

	test("no runId returns all agents", () => {
		expect(filterAgentsByRun(agents, null)).toEqual(agents);
		expect(filterAgentsByRun(agents, undefined)).toEqual(agents);
	});

	test("run-scoped includes matching runId agents", () => {
		const result = filterAgentsByRun(agents, "run-001");
		expect(result.map((a) => a.name)).toContain("builder-1");
	});

	test("run-scoped includes null-runId agents (coordinator)", () => {
		const result = filterAgentsByRun(agents, "run-001");
		expect(result.map((a) => a.name)).toContain("coordinator");
	});

	test("run-scoped excludes agents from other runs", () => {
		const result = filterAgentsByRun(agents, "run-001");
		expect(result.map((a) => a.name)).not.toContain("builder-2");
	});

	test("empty agents list returns empty", () => {
		expect(filterAgentsByRun([], "run-001")).toEqual([]);
	});
});
