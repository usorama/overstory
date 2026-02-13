import { describe, expect, test } from "bun:test";
import { sanitize, sanitizeObject } from "./sanitizer.ts";

describe("sanitize", () => {
	test("redacts Anthropic API keys (sk-ant-*)", () => {
		const input = "Using API key sk-ant-abc123xyz456 for requests";
		const result = sanitize(input);
		expect(result).toBe("Using API key [REDACTED] for requests");
	});

	test("redacts GitHub personal access tokens (github_pat_*)", () => {
		const input = "Token: github_pat_11ABCDEFGHIJKLMNOP";
		const result = sanitize(input);
		expect(result).toBe("Token: [REDACTED]");
	});

	test("redacts Bearer tokens", () => {
		const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
		const result = sanitize(input);
		expect(result).toBe("Authorization: [REDACTED]");
	});

	test("redacts GitHub classic tokens (ghp_*)", () => {
		const input = "Token ghp_1234567890abcdefghijklmnopqrstuvwxyz found in env";
		const result = sanitize(input);
		expect(result).toBe("Token [REDACTED] found in env");
	});

	test("redacts ANTHROPIC_API_KEY environment variable", () => {
		const input = "export ANTHROPIC_API_KEY=sk-ant-secret123";
		const result = sanitize(input);
		expect(result).toBe("export [REDACTED]");
	});

	test("redacts multiple secrets in the same string", () => {
		const input = "Config: ANTHROPIC_API_KEY=sk-ant-key1 and github_pat_token2 and Bearer abc123";
		const result = sanitize(input);
		expect(result).toBe("Config: [REDACTED] and [REDACTED] and [REDACTED]");
	});

	test("preserves non-secret text", () => {
		const input = "This is a normal message with no secrets";
		const result = sanitize(input);
		expect(result).toBe(input);
	});

	test("handles empty string", () => {
		const result = sanitize("");
		expect(result).toBe("");
	});

	test("redacts secrets at the beginning of the string", () => {
		const input = "sk-ant-secret123 is the API key";
		const result = sanitize(input);
		expect(result).toBe("[REDACTED] is the API key");
	});

	test("redacts secrets at the end of the string", () => {
		const input = "The API key is sk-ant-secret123";
		const result = sanitize(input);
		expect(result).toBe("The API key is [REDACTED]");
	});
});

describe("sanitizeObject", () => {
	test("sanitizes string values in a flat object", () => {
		const input = {
			apiKey: "sk-ant-secret123",
			username: "alice",
			token: "github_pat_abcdef",
		};
		const result = sanitizeObject(input);

		expect(result.apiKey).toBe("[REDACTED]");
		expect(result.username).toBe("alice");
		expect(result.token).toBe("[REDACTED]");
	});

	test("sanitizes nested objects", () => {
		const input = {
			config: {
				auth: {
					key: "sk-ant-secret123",
					user: "bob",
				},
			},
		};
		const result = sanitizeObject(input);

		const config = result.config as Record<string, unknown>;
		const auth = config.auth as Record<string, unknown>;
		expect(auth.key).toBe("[REDACTED]");
		expect(auth.user).toBe("bob");
	});

	test("sanitizes arrays of strings", () => {
		const input = {
			tokens: ["sk-ant-secret1", "safe-value", "github_pat_secret2"],
		};
		const result = sanitizeObject(input);

		const tokens = result.tokens as string[];
		expect(tokens[0]).toBe("[REDACTED]");
		expect(tokens[1]).toBe("safe-value");
		expect(tokens[2]).toBe("[REDACTED]");
	});

	test("sanitizes arrays of objects", () => {
		const input = {
			credentials: [
				{ key: "sk-ant-secret1", name: "alice" },
				{ key: "safe-key", name: "bob" },
			],
		};
		const result = sanitizeObject(input);

		const credentials = result.credentials as Array<Record<string, unknown>>;
		expect(credentials[0]?.key).toBe("[REDACTED]");
		expect(credentials[0]?.name).toBe("alice");
		expect(credentials[1]?.key).toBe("safe-key");
		expect(credentials[1]?.name).toBe("bob");
	});

	test("preserves non-string primitives", () => {
		const input = {
			count: 42,
			enabled: true,
			ratio: 3.14,
			missing: null,
		};
		const result = sanitizeObject(input);

		expect(result.count).toBe(42);
		expect(result.enabled).toBe(true);
		expect(result.ratio).toBe(3.14);
		expect(result.missing).toBeNull();
	});

	test("handles deeply nested structures", () => {
		const input = {
			level1: {
				level2: {
					level3: {
						secret: "sk-ant-deep-secret",
						safe: "value",
					},
				},
			},
		};
		const result = sanitizeObject(input);

		const level1 = result.level1 as Record<string, unknown>;
		const level2 = level1.level2 as Record<string, unknown>;
		const level3 = level2.level3 as Record<string, unknown>;
		expect(level3.secret).toBe("[REDACTED]");
		expect(level3.safe).toBe("value");
	});

	test("handles mixed arrays and objects", () => {
		const input = {
			items: [{ key: "sk-ant-secret1" }, ["github_pat_secret2", "safe-value"], "Bearer token123"],
		};
		const result = sanitizeObject(input);

		const items = result.items as Array<unknown>;
		expect((items[0] as Record<string, unknown>).key).toBe("[REDACTED]");
		expect((items[1] as string[])[0]).toBe("[REDACTED]");
		expect((items[1] as string[])[1]).toBe("safe-value");
		expect(items[2]).toBe("[REDACTED]");
	});

	test("returns a new object (does not mutate input)", () => {
		const input = {
			key: "sk-ant-secret123",
			value: "safe",
		};
		const result = sanitizeObject(input);

		// Original should be unchanged
		expect(input.key).toBe("sk-ant-secret123");
		// Result should be redacted
		expect(result.key).toBe("[REDACTED]");
	});

	test("handles empty object", () => {
		const input = {};
		const result = sanitizeObject(input);
		expect(result).toEqual({});
	});
});
