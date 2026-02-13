/**
 * Smart tool argument filter for observability events.
 *
 * Reduces tool invocation payloads from ~20KB to ~200 bytes by keeping only
 * the fields useful for post-mortem analysis. Each tool type has a custom
 * filter that preserves identifying information while dropping bulky content.
 */

export interface FilteredToolArgs {
	args: Record<string, unknown>;
	summary: string;
}

/**
 * Filter tool arguments down to what matters for observability.
 *
 * Keeps identifying fields (paths, patterns, commands) and drops bulk content
 * (file bodies, old/new strings, timeouts). Returns a compact summary string
 * suitable for log lines.
 */
export function filterToolArgs(
	toolName: string,
	toolInput: Record<string, unknown>,
): FilteredToolArgs {
	const handler = TOOL_FILTERS[toolName];
	if (handler) {
		return handler(toolInput);
	}
	return { args: {}, summary: toolName };
}

type ToolFilter = (input: Record<string, unknown>) => FilteredToolArgs;

function pickDefined(input: Record<string, unknown>, keys: string[]): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const key of keys) {
		if (key in input && input[key] !== undefined) {
			result[key] = input[key];
		}
	}
	return result;
}

function truncate(value: unknown, maxLen: number): string {
	const str = typeof value === "string" ? value : String(value ?? "");
	if (str.length <= maxLen) {
		return str;
	}
	return `${str.slice(0, maxLen)}...`;
}

const TOOL_FILTERS: Record<string, ToolFilter> = {
	Bash: (input) => {
		const args = pickDefined(input, ["command", "description"]);
		const cmd = typeof input.command === "string" ? input.command : "";
		return { args, summary: `bash: ${truncate(cmd, 80)}` };
	},

	Read: (input) => {
		const args = pickDefined(input, ["file_path", "offset", "limit"]);
		const filePath = typeof input.file_path === "string" ? input.file_path : "";
		const offset = typeof input.offset === "number" ? input.offset : undefined;
		const limit = typeof input.limit === "number" ? input.limit : undefined;
		let summary: string;
		if (offset !== undefined && limit !== undefined) {
			summary = `read: ${filePath} (lines ${offset}-${offset + limit})`;
		} else if (offset !== undefined) {
			summary = `read: ${filePath} (from line ${offset})`;
		} else if (limit !== undefined) {
			summary = `read: ${filePath} (first ${limit} lines)`;
		} else {
			summary = `read: ${filePath}`;
		}
		return { args, summary };
	},

	Write: (input) => {
		const args = pickDefined(input, ["file_path"]);
		const filePath = typeof input.file_path === "string" ? input.file_path : "";
		return { args, summary: `write: ${filePath}` };
	},

	Edit: (input) => {
		const args = pickDefined(input, ["file_path"]);
		const filePath = typeof input.file_path === "string" ? input.file_path : "";
		return { args, summary: `edit: ${filePath}` };
	},

	Glob: (input) => {
		const args = pickDefined(input, ["pattern", "path"]);
		const pattern = typeof input.pattern === "string" ? input.pattern : "";
		const path = typeof input.path === "string" ? input.path : "";
		const summary = path ? `glob: ${pattern} in ${path}` : `glob: ${pattern}`;
		return { args, summary };
	},

	Grep: (input) => {
		const args = pickDefined(input, ["pattern", "path", "glob", "output_mode"]);
		const pattern = typeof input.pattern === "string" ? input.pattern : "";
		const path = typeof input.path === "string" ? input.path : "";
		const summary = path ? `grep: "${pattern}" in ${path}` : `grep: "${pattern}"`;
		return { args, summary };
	},

	WebFetch: (input) => {
		const args = pickDefined(input, ["url"]);
		const url = typeof input.url === "string" ? input.url : "";
		return { args, summary: `fetch: ${url}` };
	},

	WebSearch: (input) => {
		const args = pickDefined(input, ["query"]);
		const query = typeof input.query === "string" ? input.query : "";
		return { args, summary: `search: ${query}` };
	},

	Task: (input) => {
		const args = pickDefined(input, ["description", "subagent_type"]);
		const description = typeof input.description === "string" ? input.description : "";
		const subagentType = typeof input.subagent_type === "string" ? input.subagent_type : "";
		const summary = subagentType
			? `task: ${description} (${subagentType})`
			: `task: ${description}`;
		return { args, summary };
	},
};
