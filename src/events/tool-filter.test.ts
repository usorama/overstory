import { describe, expect, test } from "bun:test";
import { filterToolArgs } from "./tool-filter.ts";

describe("filterToolArgs", () => {
	describe("Bash", () => {
		test("keeps command and description, drops timeout/run_in_background/dangerouslyDisableSandbox", () => {
			const result = filterToolArgs("Bash", {
				command: "bun test",
				description: "Run tests",
				timeout: 60000,
				run_in_background: true,
				dangerouslyDisableSandbox: false,
			});
			expect(result.args).toEqual({
				command: "bun test",
				description: "Run tests",
			});
			expect(result.args).not.toHaveProperty("timeout");
			expect(result.args).not.toHaveProperty("run_in_background");
			expect(result.args).not.toHaveProperty("dangerouslyDisableSandbox");
		});

		test("summary shows first 80 chars of command", () => {
			const result = filterToolArgs("Bash", { command: "bun test" });
			expect(result.summary).toBe("bash: bun test");
		});

		test("summary truncates long commands at 80 chars", () => {
			const longCmd = "a".repeat(120);
			const result = filterToolArgs("Bash", { command: longCmd });
			expect(result.summary).toBe(`bash: ${"a".repeat(80)}...`);
		});

		test("handles missing command gracefully", () => {
			const result = filterToolArgs("Bash", {});
			expect(result.args).toEqual({});
			expect(result.summary).toBe("bash: ");
		});
	});

	describe("Read", () => {
		test("keeps file_path, offset, limit", () => {
			const result = filterToolArgs("Read", {
				file_path: "/src/index.ts",
				offset: 10,
				limit: 50,
			});
			expect(result.args).toEqual({
				file_path: "/src/index.ts",
				offset: 10,
				limit: 50,
			});
		});

		test("summary with offset and limit shows line range", () => {
			const result = filterToolArgs("Read", {
				file_path: "/src/index.ts",
				offset: 10,
				limit: 50,
			});
			expect(result.summary).toBe("read: /src/index.ts (lines 10-60)");
		});

		test("summary with only offset shows from line", () => {
			const result = filterToolArgs("Read", {
				file_path: "/src/index.ts",
				offset: 10,
			});
			expect(result.summary).toBe("read: /src/index.ts (from line 10)");
		});

		test("summary with only limit shows first N lines", () => {
			const result = filterToolArgs("Read", {
				file_path: "/src/index.ts",
				limit: 50,
			});
			expect(result.summary).toBe("read: /src/index.ts (first 50 lines)");
		});

		test("summary without offset or limit shows just path", () => {
			const result = filterToolArgs("Read", {
				file_path: "/src/index.ts",
			});
			expect(result.summary).toBe("read: /src/index.ts");
		});

		test("handles missing file_path", () => {
			const result = filterToolArgs("Read", {});
			expect(result.summary).toBe("read: ");
		});
	});

	describe("Write", () => {
		test("keeps file_path, drops content", () => {
			const result = filterToolArgs("Write", {
				file_path: "/src/index.ts",
				content: "const x = 1;\nconst y = 2;\n// lots of content...",
			});
			expect(result.args).toEqual({ file_path: "/src/index.ts" });
			expect(result.args).not.toHaveProperty("content");
		});

		test("summary shows file path", () => {
			const result = filterToolArgs("Write", {
				file_path: "/src/index.ts",
				content: "stuff",
			});
			expect(result.summary).toBe("write: /src/index.ts");
		});

		test("handles missing file_path", () => {
			const result = filterToolArgs("Write", { content: "data" });
			expect(result.args).toEqual({});
			expect(result.summary).toBe("write: ");
		});
	});

	describe("Edit", () => {
		test("keeps file_path, drops old_string and new_string", () => {
			const result = filterToolArgs("Edit", {
				file_path: "/src/config.ts",
				old_string: "const x = 1;",
				new_string: "const x = 2;",
			});
			expect(result.args).toEqual({ file_path: "/src/config.ts" });
			expect(result.args).not.toHaveProperty("old_string");
			expect(result.args).not.toHaveProperty("new_string");
		});

		test("summary shows file path", () => {
			const result = filterToolArgs("Edit", {
				file_path: "/src/config.ts",
				old_string: "a",
				new_string: "b",
			});
			expect(result.summary).toBe("edit: /src/config.ts");
		});
	});

	describe("Glob", () => {
		test("keeps pattern and path", () => {
			const result = filterToolArgs("Glob", {
				pattern: "**/*.ts",
				path: "/src",
			});
			expect(result.args).toEqual({ pattern: "**/*.ts", path: "/src" });
		});

		test("summary with path shows pattern in path", () => {
			const result = filterToolArgs("Glob", {
				pattern: "**/*.ts",
				path: "/src",
			});
			expect(result.summary).toBe("glob: **/*.ts in /src");
		});

		test("summary without path shows only pattern", () => {
			const result = filterToolArgs("Glob", { pattern: "**/*.ts" });
			expect(result.summary).toBe("glob: **/*.ts");
		});
	});

	describe("Grep", () => {
		test("keeps pattern, path, glob, output_mode", () => {
			const result = filterToolArgs("Grep", {
				pattern: "function\\s+\\w+",
				path: "/src",
				glob: "*.ts",
				output_mode: "content",
				"-A": 3,
				"-B": 2,
			});
			expect(result.args).toEqual({
				pattern: "function\\s+\\w+",
				path: "/src",
				glob: "*.ts",
				output_mode: "content",
			});
			expect(result.args).not.toHaveProperty("-A");
			expect(result.args).not.toHaveProperty("-B");
		});

		test("summary with path shows pattern in path", () => {
			const result = filterToolArgs("Grep", {
				pattern: "TODO",
				path: "/src",
			});
			expect(result.summary).toBe('grep: "TODO" in /src');
		});

		test("summary without path shows only pattern", () => {
			const result = filterToolArgs("Grep", { pattern: "TODO" });
			expect(result.summary).toBe('grep: "TODO"');
		});
	});

	describe("WebFetch", () => {
		test("keeps url, drops prompt", () => {
			const result = filterToolArgs("WebFetch", {
				url: "https://example.com/page",
				prompt: "Extract the main content from this page",
			});
			expect(result.args).toEqual({ url: "https://example.com/page" });
			expect(result.args).not.toHaveProperty("prompt");
		});

		test("summary shows url", () => {
			const result = filterToolArgs("WebFetch", {
				url: "https://example.com",
			});
			expect(result.summary).toBe("fetch: https://example.com");
		});
	});

	describe("WebSearch", () => {
		test("keeps query, drops domain filters", () => {
			const result = filterToolArgs("WebSearch", {
				query: "TypeScript strict mode",
				allowed_domains: ["developer.mozilla.org"],
				blocked_domains: ["w3schools.com"],
			});
			expect(result.args).toEqual({ query: "TypeScript strict mode" });
			expect(result.args).not.toHaveProperty("allowed_domains");
			expect(result.args).not.toHaveProperty("blocked_domains");
		});

		test("summary shows query", () => {
			const result = filterToolArgs("WebSearch", {
				query: "bun test runner",
			});
			expect(result.summary).toBe("search: bun test runner");
		});
	});

	describe("Task", () => {
		test("keeps description and subagent_type", () => {
			const result = filterToolArgs("Task", {
				description: "Analyze the codebase structure",
				subagent_type: "research",
				prompt: "Look at all the files and determine...",
			});
			expect(result.args).toEqual({
				description: "Analyze the codebase structure",
				subagent_type: "research",
			});
			expect(result.args).not.toHaveProperty("prompt");
		});

		test("summary with subagent_type shows description and type", () => {
			const result = filterToolArgs("Task", {
				description: "Find all config files",
				subagent_type: "research",
			});
			expect(result.summary).toBe("task: Find all config files (research)");
		});

		test("summary without subagent_type shows only description", () => {
			const result = filterToolArgs("Task", {
				description: "Find all config files",
			});
			expect(result.summary).toBe("task: Find all config files");
		});
	});

	describe("unknown tools", () => {
		test("returns empty args and tool name as summary", () => {
			const result = filterToolArgs("SomeUnknownTool", {
				foo: "bar",
				baz: 42,
			});
			expect(result.args).toEqual({});
			expect(result.summary).toBe("SomeUnknownTool");
		});

		test("handles empty input for unknown tool", () => {
			const result = filterToolArgs("Mystery", {});
			expect(result.args).toEqual({});
			expect(result.summary).toBe("Mystery");
		});
	});

	describe("edge cases", () => {
		test("handles empty input object for known tool", () => {
			const result = filterToolArgs("Bash", {});
			expect(result.args).toEqual({});
			expect(result.summary).toBe("bash: ");
		});

		test("handles null values in input", () => {
			const result = filterToolArgs("Read", {
				file_path: null as unknown as string,
				offset: null as unknown as number,
			});
			// null is not undefined, so file_path will be picked but summary treats it as non-string
			expect(result.args).toHaveProperty("file_path");
			expect(result.summary).toBe("read: ");
		});

		test("handles undefined values in input", () => {
			const result = filterToolArgs("Read", {
				file_path: undefined as unknown as string,
			});
			// undefined values should not appear in filtered args
			expect(result.args).not.toHaveProperty("file_path");
			expect(result.summary).toBe("read: ");
		});

		test("handles numeric values where strings expected", () => {
			const result = filterToolArgs("Bash", {
				command: 42 as unknown as string,
			});
			// Value is kept in args as-is, but summary treats non-strings as empty
			expect(result.args).toEqual({ command: 42 });
			expect(result.summary).toBe("bash: ");
		});

		test("preserves exact 80-char command without truncation", () => {
			const cmd = "x".repeat(80);
			const result = filterToolArgs("Bash", { command: cmd });
			expect(result.summary).toBe(`bash: ${cmd}`);
			expect(result.summary).not.toContain("...");
		});

		test("truncates 81-char command", () => {
			const cmd = "y".repeat(81);
			const result = filterToolArgs("Bash", { command: cmd });
			expect(result.summary).toBe(`bash: ${"y".repeat(80)}...`);
		});
	});
});
