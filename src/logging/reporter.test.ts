import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { LogEvent } from "../types.ts";
import { formatLogLine, printToConsole } from "./reporter.ts";

describe("formatLogLine", () => {
	test("formats info level event with agent name", () => {
		const event: LogEvent = {
			timestamp: "2024-01-15T14:30:00.123Z",
			level: "info",
			event: "agent.started",
			agentName: "scout-1",
			data: {},
		};

		const result = formatLogLine(event);

		// Should contain: timestamp, level (INF), agent name, event
		expect(result).toContain("[14:30:00]");
		expect(result).toContain("INF");
		expect(result).toContain("scout-1");
		expect(result).toContain("agent.started");
	});

	test("formats debug level event", () => {
		const event: LogEvent = {
			timestamp: "2024-01-15T08:15:30.000Z",
			level: "debug",
			event: "config.loaded",
			agentName: "builder-1",
			data: {},
		};

		const result = formatLogLine(event);

		expect(result).toContain("[08:15:30]");
		expect(result).toContain("DBG");
		expect(result).toContain("config.loaded");
	});

	test("formats warn level event", () => {
		const event: LogEvent = {
			timestamp: "2024-01-15T16:45:00.000Z",
			level: "warn",
			event: "rate.limit.approaching",
			agentName: "monitor",
			data: {},
		};

		const result = formatLogLine(event);

		expect(result).toContain("[16:45:00]");
		expect(result).toContain("WRN");
		expect(result).toContain("rate.limit.approaching");
	});

	test("formats error level event", () => {
		const event: LogEvent = {
			timestamp: "2024-01-15T23:59:59.999Z",
			level: "error",
			event: "connection.failed",
			agentName: "lead-1",
			data: {},
		};

		const result = formatLogLine(event);

		expect(result).toContain("[23:59:59]");
		expect(result).toContain("ERR");
		expect(result).toContain("connection.failed");
	});

	test("formats event without agent name", () => {
		const event: LogEvent = {
			timestamp: "2024-01-15T12:00:00.000Z",
			level: "info",
			event: "system.init",
			agentName: null,
			data: {},
		};

		const result = formatLogLine(event);

		// Should not contain the agent separator " | "
		expect(result).toContain("system.init");
		expect(result).not.toContain(" | ");
	});

	test("includes data key=value pairs when present", () => {
		const event: LogEvent = {
			timestamp: "2024-01-15T10:00:00.000Z",
			level: "info",
			event: "task.completed",
			agentName: "builder-1",
			data: {
				taskId: "task-123",
				duration: 5000,
			},
		};

		const result = formatLogLine(event);

		expect(result).toContain("taskId=task-123");
		expect(result).toContain("duration=5000");
	});

	test("quotes string values containing spaces", () => {
		const event: LogEvent = {
			timestamp: "2024-01-15T10:00:00.000Z",
			level: "info",
			event: "message.received",
			agentName: "agent-1",
			data: {
				message: "hello world",
				status: "ok",
			},
		};

		const result = formatLogLine(event);

		expect(result).toContain('message="hello world"');
		expect(result).toContain("status=ok");
	});

	test("formats null values as key=null", () => {
		const event: LogEvent = {
			timestamp: "2024-01-15T10:00:00.000Z",
			level: "info",
			event: "value.cleared",
			agentName: "agent-1",
			data: {
				value: null,
			},
		};

		const result = formatLogLine(event);

		expect(result).toContain("value=null");
	});

	test("formats object values as JSON", () => {
		const event: LogEvent = {
			timestamp: "2024-01-15T10:00:00.000Z",
			level: "info",
			event: "data.received",
			agentName: "agent-1",
			data: {
				config: { enabled: true, timeout: 5000 },
			},
		};

		const result = formatLogLine(event);

		expect(result).toContain('config={"enabled":true,"timeout":5000}');
	});

	test("handles empty data object", () => {
		const event: LogEvent = {
			timestamp: "2024-01-15T10:00:00.000Z",
			level: "info",
			event: "simple.event",
			agentName: "agent-1",
			data: {},
		};

		const result = formatLogLine(event);

		// Should not have any key=value pairs
		expect(result).toContain("simple.event");
		expect(result).not.toMatch(/=\S+/); // No equals signs
	});

	test("handles timestamp without T separator (fallback)", () => {
		const event: LogEvent = {
			timestamp: "invalid-timestamp",
			level: "info",
			event: "test.event",
			agentName: "agent-1",
			data: {},
		};

		const result = formatLogLine(event);

		// Should use the raw timestamp as fallback
		expect(result).toContain("[invalid-timestamp]");
	});
});

describe("printToConsole", () => {
	let consoleLogSpy: ReturnType<typeof mock>;
	let consoleErrorSpy: ReturnType<typeof mock>;

	beforeEach(() => {
		consoleLogSpy = mock(() => {});
		consoleErrorSpy = mock(() => {});

		// Replace console methods
		console.log = consoleLogSpy;
		console.error = consoleErrorSpy;
	});

	afterEach(() => {
		// Restore console methods (best effort)
		consoleLogSpy.mockRestore();
		consoleErrorSpy.mockRestore();
	});

	test("prints info events to stdout when verbose is true", () => {
		const event: LogEvent = {
			timestamp: "2024-01-15T10:00:00.000Z",
			level: "info",
			event: "test.event",
			agentName: "agent-1",
			data: {},
		};

		printToConsole(event, true);

		expect(consoleLogSpy).toHaveBeenCalledTimes(1);
		expect(consoleErrorSpy).toHaveBeenCalledTimes(0);
	});

	test("prints error events to stderr", () => {
		const event: LogEvent = {
			timestamp: "2024-01-15T10:00:00.000Z",
			level: "error",
			event: "test.error",
			agentName: "agent-1",
			data: {},
		};

		printToConsole(event, false);

		expect(consoleLogSpy).toHaveBeenCalledTimes(0);
		expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
	});

	test("prints warn events to stdout", () => {
		const event: LogEvent = {
			timestamp: "2024-01-15T10:00:00.000Z",
			level: "warn",
			event: "test.warning",
			agentName: "agent-1",
			data: {},
		};

		printToConsole(event, false);

		expect(consoleLogSpy).toHaveBeenCalledTimes(1);
		expect(consoleErrorSpy).toHaveBeenCalledTimes(0);
	});

	test("suppresses debug events when verbose is false", () => {
		const event: LogEvent = {
			timestamp: "2024-01-15T10:00:00.000Z",
			level: "debug",
			event: "test.debug",
			agentName: "agent-1",
			data: {},
		};

		printToConsole(event, false);

		expect(consoleLogSpy).toHaveBeenCalledTimes(0);
		expect(consoleErrorSpy).toHaveBeenCalledTimes(0);
	});

	test("prints debug events when verbose is true", () => {
		const event: LogEvent = {
			timestamp: "2024-01-15T10:00:00.000Z",
			level: "debug",
			event: "test.debug",
			agentName: "agent-1",
			data: {},
		};

		printToConsole(event, true);

		expect(consoleLogSpy).toHaveBeenCalledTimes(1);
		expect(consoleErrorSpy).toHaveBeenCalledTimes(0);
	});
});
