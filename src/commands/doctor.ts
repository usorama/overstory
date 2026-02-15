/**
 * CLI command: overstory doctor [options]
 *
 * Runs health checks on overstory subsystems and reports problems.
 */

import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { checkAgents } from "../doctor/agents.ts";
import { checkConfig } from "../doctor/config-check.ts";
import { checkConsistency } from "../doctor/consistency.ts";
import { checkDatabases } from "../doctor/databases.ts";
import { checkDependencies } from "../doctor/dependencies.ts";
import { checkLogs } from "../doctor/logs.ts";
import { checkMergeQueue } from "../doctor/merge-queue.ts";
import { checkStructure } from "../doctor/structure.ts";
import type { DoctorCategory, DoctorCheck, DoctorCheckFn } from "../doctor/types.ts";
import { checkVersion } from "../doctor/version.ts";
import { ValidationError } from "../errors.ts";

// ANSI escape codes consistent with src/commands/trace.ts
const ANSI = {
	reset: "\x1b[0m",
	gray: "\x1b[90m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
} as const;

/** Registry of all check modules in execution order. */
const ALL_CHECKS: Array<{ category: DoctorCategory; fn: DoctorCheckFn }> = [
	{ category: "dependencies", fn: checkDependencies },
	{ category: "config", fn: checkConfig },
	{ category: "structure", fn: checkStructure },
	{ category: "databases", fn: checkDatabases },
	{ category: "consistency", fn: checkConsistency },
	{ category: "agents", fn: checkAgents },
	{ category: "merge", fn: checkMergeQueue },
	{ category: "logs", fn: checkLogs },
	{ category: "version", fn: checkVersion },
];

function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

function getFlag(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx === -1 || idx + 1 >= args.length) {
		return undefined;
	}
	return args[idx + 1];
}

/**
 * Format human-readable output for doctor checks.
 */
function printHumanReadable(checks: DoctorCheck[], verbose: boolean): void {
	const w = process.stdout.write.bind(process.stdout);

	w(`${ANSI.bold}Overstory Doctor${ANSI.reset}\n`);
	w("================\n\n");

	// Group checks by category
	const byCategory = new Map<DoctorCategory, DoctorCheck[]>();
	for (const check of checks) {
		const existing = byCategory.get(check.category);
		if (existing) {
			existing.push(check);
		} else {
			byCategory.set(check.category, [check]);
		}
	}

	// Print each category
	for (const { category } of ALL_CHECKS) {
		const categoryChecks = byCategory.get(category) ?? [];
		if (categoryChecks.length === 0 && !verbose) {
			continue; // Skip empty categories unless verbose
		}

		w(`${ANSI.bold}[${category}]${ANSI.reset}\n`);

		if (categoryChecks.length === 0) {
			w(`  ${ANSI.dim}No checks${ANSI.reset}\n`);
		} else {
			for (const check of categoryChecks) {
				// Skip passing checks unless verbose
				if (check.status === "pass" && !verbose) {
					continue;
				}

				const icon =
					check.status === "pass"
						? `${ANSI.green}✔${ANSI.reset}`
						: check.status === "warn"
							? `${ANSI.yellow}⚠${ANSI.reset}`
							: `${ANSI.red}✘${ANSI.reset}`;

				w(`  ${icon} ${check.message}\n`);

				// Print details if present
				if (check.details && check.details.length > 0) {
					for (const detail of check.details) {
						w(`    ${ANSI.dim}→ ${detail}${ANSI.reset}\n`);
					}
				}
			}
		}

		w("\n");
	}

	// Summary
	const pass = checks.filter((c) => c.status === "pass").length;
	const warn = checks.filter((c) => c.status === "warn").length;
	const fail = checks.filter((c) => c.status === "fail").length;

	w(
		`${ANSI.bold}Summary:${ANSI.reset} ${ANSI.green}${pass} passed${ANSI.reset}, ${ANSI.yellow}${warn} warning${warn === 1 ? "" : "s"}${ANSI.reset}, ${ANSI.red}${fail} failure${fail === 1 ? "" : "s"}${ANSI.reset}\n`,
	);
}

/**
 * Format JSON output for doctor checks.
 */
function printJSON(checks: DoctorCheck[]): void {
	const pass = checks.filter((c) => c.status === "pass").length;
	const warn = checks.filter((c) => c.status === "warn").length;
	const fail = checks.filter((c) => c.status === "fail").length;

	const output = {
		checks,
		summary: { pass, warn, fail },
	};

	process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

const DOCTOR_HELP = `overstory doctor -- Run health checks on overstory subsystems

Usage: overstory doctor [options]

Options:
  --json                 Output as JSON
  --verbose              Show passing checks (default: only problems)
  --category <name>      Run only one category
  --help, -h             Show this help

Categories: dependencies, structure, config, databases, consistency, agents, merge, logs, version`;

/**
 * Entry point for `overstory doctor [--json] [--verbose] [--category <name>]`.
 */
export async function doctorCommand(args: string[]): Promise<void> {
	if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
		process.stdout.write(`${DOCTOR_HELP}\n`);
		return;
	}

	const json = hasFlag(args, "--json");
	const verbose = hasFlag(args, "--verbose");
	const categoryFilter = getFlag(args, "--category");

	// Validate category filter if provided
	if (categoryFilter !== undefined) {
		const validCategories = ALL_CHECKS.map((c) => c.category);
		if (!validCategories.includes(categoryFilter as DoctorCategory)) {
			throw new ValidationError(
				`Invalid category: ${categoryFilter}. Valid categories: ${validCategories.join(", ")}`,
				{
					field: "category",
					value: categoryFilter,
				},
			);
		}
	}

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const overstoryDir = join(config.project.root, ".overstory");

	// Filter checks by category if specified
	const checksToRun = categoryFilter
		? ALL_CHECKS.filter((c) => c.category === categoryFilter)
		: ALL_CHECKS;

	// Run all checks sequentially
	const results: DoctorCheck[] = [];
	for (const { fn } of checksToRun) {
		const checkResults = await fn(config, overstoryDir);
		results.push(...checkResults);
	}

	// Output results
	if (json) {
		printJSON(results);
	} else {
		printHumanReadable(results, verbose);
	}

	// Set exit code to 1 if any check failed
	const hasFailures = results.some((c) => c.status === "fail");
	if (hasFailures) {
		process.exitCode = 1;
	}
}
