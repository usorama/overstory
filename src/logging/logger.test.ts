import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogEvent } from "../types.ts";
import { createLogger } from "./logger.ts";

describe("createLogger", () => {
	let tempDir: string;
	let logDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-logger-test-"));
		logDir = join(tempDir, "logs");
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	async function readLogFile(filename: string): Promise<string> {
		return readFile(join(logDir, filename), "utf-8");
	}

	async function readJsonLines(filename: string): Promise<LogEvent[]> {
		const content = await readLogFile(filename);
		return content
			.trim()
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as LogEvent);
	}

	test("creates log directory on first write", async () => {
		const logger = createLogger({ logDir, agentName: "test-agent" });

		logger.info("test.event");

		// Give time for async mkdir + append to complete
		await Bun.sleep(50);

		const files = await readdir(logDir);
		expect(files.length).toBeGreaterThan(0);

		logger.close();
	});

	describe("info", () => {
		test("writes to session.log and events.ndjson", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.info("test.event", { key: "value" });

			await Bun.sleep(50);

			const sessionLog = await readLogFile("session.log");
			expect(sessionLog).toContain("INFO test.event");
			expect(sessionLog).toContain("key=value");

			const events = await readJsonLines("events.ndjson");
			expect(events).toHaveLength(1);
			expect(events[0]?.level).toBe("info");
			expect(events[0]?.event).toBe("test.event");
			expect(events[0]?.data.key).toBe("value");

			logger.close();
		});

		test("works with empty data", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.info("simple.event");

			await Bun.sleep(50);

			const sessionLog = await readLogFile("session.log");
			expect(sessionLog).toContain("INFO simple.event");

			const events = await readJsonLines("events.ndjson");
			expect(events[0]?.data).toEqual({});

			logger.close();
		});
	});

	describe("warn", () => {
		test("writes to session.log and events.ndjson", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.warn("rate.limit", { remaining: 10 });

			await Bun.sleep(50);

			const sessionLog = await readLogFile("session.log");
			expect(sessionLog).toContain("WARN rate.limit");
			expect(sessionLog).toContain("remaining=10");

			const events = await readJsonLines("events.ndjson");
			expect(events[0]?.level).toBe("warn");
			expect(events[0]?.event).toBe("rate.limit");

			logger.close();
		});
	});

	describe("error", () => {
		test("writes to session.log, events.ndjson, and errors.log", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			const error = new Error("Something went wrong");
			logger.error("request.failed", error, { statusCode: 500 });

			await Bun.sleep(50);

			const sessionLog = await readLogFile("session.log");
			expect(sessionLog).toContain("ERROR request.failed");

			const events = await readJsonLines("events.ndjson");
			expect(events[0]?.level).toBe("error");
			expect(events[0]?.event).toBe("request.failed");
			expect(events[0]?.data.errorMessage).toBe("Something went wrong");
			expect(events[0]?.data.errorName).toBe("Error");
			expect(events[0]?.data.statusCode).toBe(500);

			const errorsLog = await readLogFile("errors.log");
			expect(errorsLog).toContain("Error: Something went wrong");
			expect(errorsLog).toContain("request.failed");
			expect(errorsLog).toContain("Stack Trace:");

			logger.close();
		});

		test("includes error cause if present", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			const cause = new Error("Root cause");
			const error = new Error("Wrapper error", { cause });
			logger.error("nested.error", error);

			await Bun.sleep(50);

			const errorsLog = await readLogFile("errors.log");
			expect(errorsLog).toContain("Caused by: Error: Root cause");

			logger.close();
		});
	});

	describe("debug", () => {
		test("writes to session.log and events.ndjson", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.debug("config.detail", { verbose: true });

			await Bun.sleep(50);

			const sessionLog = await readLogFile("session.log");
			expect(sessionLog).toContain("DEBUG config.detail");

			const events = await readJsonLines("events.ndjson");
			expect(events[0]?.level).toBe("debug");

			logger.close();
		});
	});

	describe("toolStart and toolEnd", () => {
		test("writes to session.log, events.ndjson, and tools.ndjson", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.toolStart("Read", { path: "/path/to/file" });
			logger.toolEnd("Read", 150, "file contents");

			await Bun.sleep(50);

			const sessionLog = await readLogFile("session.log");
			expect(sessionLog).toContain("tool.start");
			expect(sessionLog).toContain("tool.end");

			const events = await readJsonLines("events.ndjson");
			expect(events).toHaveLength(2);
			expect(events[0]?.event).toBe("tool.start");
			expect(events[1]?.event).toBe("tool.end");

			const tools = await readJsonLines("tools.ndjson");
			expect(tools).toHaveLength(2);
			expect(tools[0]?.event).toBe("tool.start");
			expect(tools[0]?.data.toolName).toBe("Read");
			expect(tools[1]?.event).toBe("tool.end");
			expect(tools[1]?.data.toolName).toBe("Read");
			expect(tools[1]?.data.durationMs).toBe(150);
			expect(tools[1]?.data.result).toBe("file contents");

			logger.close();
		});

		test("toolEnd works without result", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.toolEnd("Write", 50);

			await Bun.sleep(50);

			const tools = await readJsonLines("tools.ndjson");
			expect(tools[0]?.data.result).toBeUndefined();

			logger.close();
		});
	});

	describe("redaction", () => {
		test("redacts secrets when redactSecrets is true (default)", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.info("api.call", { apiKey: "sk-ant-secret123" });

			await Bun.sleep(50);

			const events = await readJsonLines("events.ndjson");
			expect(events[0]?.data.apiKey).toBe("[REDACTED]");

			logger.close();
		});

		test("redacts secrets in error messages", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			const error = new Error("Failed with key sk-ant-secret123");
			logger.error("error.occurred", error);

			await Bun.sleep(50);

			const events = await readJsonLines("events.ndjson");
			expect(events[0]?.data.errorMessage).toBe("Failed with key [REDACTED]");

			logger.close();
		});

		test("redacts secrets in tool results", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.toolEnd("Bash", 100, "export ANTHROPIC_API_KEY=sk-ant-secret");

			await Bun.sleep(50);

			const tools = await readJsonLines("tools.ndjson");
			expect(tools[0]?.data.result).toBe("export [REDACTED]");

			logger.close();
		});

		test("does not redact secrets when redactSecrets is false", async () => {
			const logger = createLogger({
				logDir,
				agentName: "test-agent",
				redactSecrets: false,
			});

			logger.info("api.call", { apiKey: "sk-ant-secret123" });

			await Bun.sleep(50);

			const events = await readJsonLines("events.ndjson");
			expect(events[0]?.data.apiKey).toBe("sk-ant-secret123");

			logger.close();
		});
	});

	describe("verbose mode", () => {
		let consoleLogSpy: ReturnType<typeof mock>;

		beforeEach(() => {
			consoleLogSpy = mock(() => {});
			console.log = consoleLogSpy;
		});

		afterEach(() => {
			consoleLogSpy.mockRestore();
		});

		test("suppresses debug console output when verbose is false", () => {
			const logger = createLogger({
				logDir,
				agentName: "test-agent",
				verbose: false,
			});

			logger.debug("debug.event");

			// Console should not be called
			expect(consoleLogSpy).toHaveBeenCalledTimes(0);

			logger.close();
		});

		test("prints debug console output when verbose is true", () => {
			const logger = createLogger({
				logDir,
				agentName: "test-agent",
				verbose: true,
			});

			logger.debug("debug.event");

			// Console should be called
			expect(consoleLogSpy).toHaveBeenCalledTimes(1);

			logger.close();
		});

		test("always prints non-debug events regardless of verbose", () => {
			const logger = createLogger({
				logDir,
				agentName: "test-agent",
				verbose: false,
			});

			logger.info("info.event");

			// Console should be called even with verbose=false
			expect(consoleLogSpy).toHaveBeenCalledTimes(1);

			logger.close();
		});
	});

	describe("close", () => {
		test("prevents further writes after close", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.info("before.close");
			await Bun.sleep(50);

			logger.close();

			logger.info("after.close");
			await Bun.sleep(50);

			const events = await readJsonLines("events.ndjson");
			// Should only have the event before close
			expect(events).toHaveLength(1);
			expect(events[0]?.event).toBe("before.close");

			logger.close();
		});
	});

	describe("agentName", () => {
		test("includes agentName in all logged events", async () => {
			const logger = createLogger({ logDir, agentName: "scout-1" });

			logger.info("test.event");

			await Bun.sleep(50);

			const events = await readJsonLines("events.ndjson");
			expect(events[0]?.agentName).toBe("scout-1");

			logger.close();
		});
	});

	describe("error isolation", () => {
		test("continues logging after write errors (no crash)", async () => {
			// Create logger with an invalid path to trigger write errors
			const invalidLogDir = join(tempDir, "nonexistent", "very", "deep", "path");
			const logger = createLogger({ logDir: invalidLogDir, agentName: "test-agent" });

			// These should not throw even if writes fail
			expect(() => logger.info("test1")).not.toThrow();
			expect(() => logger.error("test2", new Error("test"))).not.toThrow();
			expect(() => logger.debug("test3")).not.toThrow();

			logger.close();
		});
	});

	describe("file format", () => {
		test("session.log uses human-readable format", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.info("task.completed", { taskId: "task-123", duration: 5000 });

			await Bun.sleep(50);

			const sessionLog = await readLogFile("session.log");
			// Format: [TIMESTAMP] LEVEL EVENT key=value key=value
			expect(sessionLog).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/);
			expect(sessionLog).toContain("INFO task.completed");
			expect(sessionLog).toContain("taskId=task-123");
			expect(sessionLog).toContain("duration=5000");

			logger.close();
		});

		test("events.ndjson uses valid NDJSON format", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.info("event1");
			logger.info("event2");
			logger.info("event3");

			await Bun.sleep(50);

			const content = await readLogFile("events.ndjson");
			const lines = content.trim().split("\n");

			expect(lines).toHaveLength(3);

			// Each line should be valid JSON
			for (const line of lines) {
				expect(() => JSON.parse(line)).not.toThrow();
			}

			logger.close();
		});

		test("errors.log includes full stack traces", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			const error = new Error("Test error");
			logger.error("test.error", error);

			await Bun.sleep(50);

			const errorsLog = await readLogFile("errors.log");

			// Should have separator lines
			expect(errorsLog).toContain("========");
			expect(errorsLog).toContain("Timestamp:");
			expect(errorsLog).toContain("Event:");
			expect(errorsLog).toContain("Agent:");
			expect(errorsLog).toContain("Error:");
			expect(errorsLog).toContain("Stack Trace:");

			logger.close();
		});
	});

	describe("multiple events", () => {
		test("logs multiple events", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.info("event1");
			logger.warn("event2");
			logger.error("event3", new Error("test"));

			await Bun.sleep(50);

			const events = await readJsonLines("events.ndjson");
			expect(events).toHaveLength(3);

			// Check that all events are present (order not guaranteed due to async writes)
			const eventNames = events.map((e) => e.event);
			expect(eventNames).toContain("event1");
			expect(eventNames).toContain("event2");
			expect(eventNames).toContain("event3");

			logger.close();
		});
	});
});
