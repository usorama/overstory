/**
 * Tiered conflict resolution for merging agent branches.
 *
 * Implements a 4-tier escalation strategy:
 *   1. Clean merge — git merge with no conflicts
 *   2. Auto-resolve — parse conflict markers, keep incoming (agent) changes
 *   3. AI-resolve — use Claude to resolve remaining conflicts
 *   4. Re-imagine — abort merge and reimplement changes from scratch
 *
 * Each tier is attempted in order. If a tier fails, the next is tried.
 * Disabled tiers are skipped. Uses Bun.spawn for all subprocess calls.
 */

import { MergeError } from "../errors.ts";
import type { MergeEntry, MergeResult, ResolutionTier } from "../types.ts";

export interface MergeResolver {
	/** Attempt to merge the entry's branch into the canonical branch with tiered resolution. */
	resolve(entry: MergeEntry, canonicalBranch: string, repoRoot: string): Promise<MergeResult>;
}

/**
 * Run a git command in the given repo root. Returns stdout, stderr, and exit code.
 */
async function runGit(
	repoRoot: string,
	args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["git", ...args], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	return { stdout, stderr, exitCode };
}

/**
 * Get the list of conflicted files from `git diff --name-only --diff-filter=U`.
 */
async function getConflictedFiles(repoRoot: string): Promise<string[]> {
	const { stdout } = await runGit(repoRoot, ["diff", "--name-only", "--diff-filter=U"]);
	return stdout
		.trim()
		.split("\n")
		.filter((line) => line.length > 0);
}

/**
 * Parse conflict markers in file content and keep the incoming (agent) changes.
 *
 * A conflict block looks like:
 * ```
 * <<<<<<< HEAD
 * canonical content
 * =======
 * incoming content
 * >>>>>>> branch
 * ```
 *
 * This function replaces each conflict block with only the incoming content.
 * Returns the resolved content, or null if no conflict markers were found.
 */
function resolveConflictsKeepIncoming(content: string): string | null {
	const conflictPattern = /^<{7} .+\n([\s\S]*?)^={7}\n([\s\S]*?)^>{7} .+\n?/gm;

	if (!conflictPattern.test(content)) {
		return null;
	}

	// Reset regex lastIndex after test()
	conflictPattern.lastIndex = 0;

	return content.replace(conflictPattern, (_match, _canonical: string, incoming: string) => {
		return incoming;
	});
}

/**
 * Read a file's content using Bun.file().
 */
async function readFile(filePath: string): Promise<string> {
	const file = Bun.file(filePath);
	return file.text();
}

/**
 * Write content to a file using Bun.write().
 */
async function writeFile(filePath: string, content: string): Promise<void> {
	await Bun.write(filePath, content);
}

/**
 * Tier 1: Attempt a clean merge (git merge --no-edit).
 * Returns true if the merge succeeds with no conflicts.
 */
async function tryCleanMerge(
	entry: MergeEntry,
	repoRoot: string,
): Promise<{ success: boolean; conflictFiles: string[] }> {
	const { exitCode } = await runGit(repoRoot, ["merge", "--no-edit", entry.branchName]);

	if (exitCode === 0) {
		return { success: true, conflictFiles: [] };
	}

	// Merge failed — get the list of conflicted files
	const conflictFiles = await getConflictedFiles(repoRoot);
	return { success: false, conflictFiles };
}

/**
 * Tier 2: Auto-resolve conflicts by keeping incoming (agent) changes.
 * Parses conflict markers and keeps the content between ======= and >>>>>>>.
 */
async function tryAutoResolve(
	conflictFiles: string[],
	repoRoot: string,
): Promise<{ success: boolean; remainingConflicts: string[] }> {
	const remainingConflicts: string[] = [];

	for (const file of conflictFiles) {
		const filePath = `${repoRoot}/${file}`;

		try {
			const content = await readFile(filePath);
			const resolved = resolveConflictsKeepIncoming(content);

			if (resolved === null) {
				// No conflict markers found (shouldn't happen but be defensive)
				remainingConflicts.push(file);
				continue;
			}

			await writeFile(filePath, resolved);
			const { exitCode } = await runGit(repoRoot, ["add", file]);
			if (exitCode !== 0) {
				remainingConflicts.push(file);
			}
		} catch {
			remainingConflicts.push(file);
		}
	}

	if (remainingConflicts.length > 0) {
		return { success: false, remainingConflicts };
	}

	// All files resolved — commit
	const { exitCode } = await runGit(repoRoot, ["commit", "--no-edit"]);
	return { success: exitCode === 0, remainingConflicts };
}

/**
 * Check if text looks like conversational prose rather than code.
 * Returns true if the output is likely prose from the LLM rather than resolved code.
 */
export function looksLikeProse(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length === 0) return true;

	// Common conversational opening patterns from LLMs
	const prosePatterns = [
		/^(I |I'[a-z]+ |Here |Here's |The |This |Let me |Sure|Unfortunately|Apologies|Sorry)/i,
		/^(To resolve|Looking at|Based on|After reviewing|The conflict)/i,
		/^```/m, // Markdown fencing — the model wrapped the code
		/I need permission/i,
		/I cannot/i,
		/I don't have/i,
	];

	for (const pattern of prosePatterns) {
		if (pattern.test(trimmed)) return true;
	}

	return false;
}

/**
 * Tier 3: AI-assisted conflict resolution using Claude.
 * Spawns `claude --print` for each conflicted file with the conflict content.
 * Validates that output looks like code, not conversational prose.
 */
async function tryAiResolve(
	conflictFiles: string[],
	repoRoot: string,
): Promise<{ success: boolean; remainingConflicts: string[] }> {
	const remainingConflicts: string[] = [];

	for (const file of conflictFiles) {
		const filePath = `${repoRoot}/${file}`;

		try {
			const content = await readFile(filePath);
			const prompt = [
				"You are a merge conflict resolver. Output ONLY the resolved file content.",
				"Rules: NO explanation, NO markdown fencing, NO conversation, NO preamble.",
				"Output the raw file content as it should appear on disk.",
				"Choose the best combination of both sides of this conflict:\n\n",
				content,
			].join(" ");

			const proc = Bun.spawn(["claude", "--print", "-p", prompt], {
				cwd: repoRoot,
				stdout: "pipe",
				stderr: "pipe",
			});

			const [resolved, , exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);

			if (exitCode !== 0 || resolved.trim() === "") {
				remainingConflicts.push(file);
				continue;
			}

			// Validate output is code, not prose — fall back to next tier if not
			if (looksLikeProse(resolved)) {
				remainingConflicts.push(file);
				continue;
			}

			await writeFile(filePath, resolved);
			const { exitCode: addExitCode } = await runGit(repoRoot, ["add", file]);
			if (addExitCode !== 0) {
				remainingConflicts.push(file);
			}
		} catch {
			remainingConflicts.push(file);
		}
	}

	if (remainingConflicts.length > 0) {
		return { success: false, remainingConflicts };
	}

	// All files resolved — commit
	const { exitCode } = await runGit(repoRoot, ["commit", "--no-edit"]);
	return { success: exitCode === 0, remainingConflicts };
}

/**
 * Tier 4: Re-imagine — abort the merge and reimplement changes from scratch.
 * Uses Claude to reimplement the agent's changes on top of the canonical version.
 */
async function tryReimagine(
	entry: MergeEntry,
	canonicalBranch: string,
	repoRoot: string,
): Promise<{ success: boolean }> {
	// Abort the current merge
	await runGit(repoRoot, ["merge", "--abort"]);

	for (const file of entry.filesModified) {
		try {
			// Get the canonical version
			const { stdout: canonicalContent, exitCode: catCanonicalCode } = await runGit(repoRoot, [
				"show",
				`${canonicalBranch}:${file}`,
			]);

			// Get the branch version
			const { stdout: branchContent, exitCode: catBranchCode } = await runGit(repoRoot, [
				"show",
				`${entry.branchName}:${file}`,
			]);

			if (catCanonicalCode !== 0 || catBranchCode !== 0) {
				return { success: false };
			}

			const prompt = [
				"You are a merge conflict resolver. Output ONLY the final file content.",
				"Rules: NO explanation, NO markdown fencing, NO conversation, NO preamble.",
				"Output the raw file content as it should appear on disk.",
				"Reimplement the changes from the branch version onto the canonical version.",
				`\n\n=== CANONICAL VERSION (${canonicalBranch}) ===\n`,
				canonicalContent,
				`\n\n=== BRANCH VERSION (${entry.branchName}) ===\n`,
				branchContent,
			].join("");

			const proc = Bun.spawn(["claude", "--print", "-p", prompt], {
				cwd: repoRoot,
				stdout: "pipe",
				stderr: "pipe",
			});

			const [reimagined, , exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);

			if (exitCode !== 0 || reimagined.trim() === "") {
				return { success: false };
			}

			// Validate output is code, not prose
			if (looksLikeProse(reimagined)) {
				return { success: false };
			}

			const filePath = `${repoRoot}/${file}`;
			await writeFile(filePath, reimagined);
			const { exitCode: addExitCode } = await runGit(repoRoot, ["add", file]);
			if (addExitCode !== 0) {
				return { success: false };
			}
		} catch {
			return { success: false };
		}
	}

	// Commit the reimagined changes
	const { exitCode } = await runGit(repoRoot, [
		"commit",
		"-m",
		`Reimagine merge: ${entry.branchName} onto ${canonicalBranch}`,
	]);

	return { success: exitCode === 0 };
}

/**
 * Create a MergeResolver with configurable tier enablement.
 *
 * @param options.aiResolveEnabled - Enable tier 3 (AI-assisted resolution)
 * @param options.reimagineEnabled - Enable tier 4 (full reimagine)
 */
export function createMergeResolver(options: {
	aiResolveEnabled: boolean;
	reimagineEnabled: boolean;
}): MergeResolver {
	return {
		async resolve(
			entry: MergeEntry,
			canonicalBranch: string,
			repoRoot: string,
		): Promise<MergeResult> {
			// Check current branch — skip checkout if already on canonical.
			// Avoids "already checked out" error when worktrees exist.
			const { stdout: currentRef, exitCode: refCode } = await runGit(repoRoot, [
				"symbolic-ref",
				"--short",
				"HEAD",
			]);
			const needsCheckout = refCode !== 0 || currentRef.trim() !== canonicalBranch;

			if (needsCheckout) {
				const { exitCode: checkoutCode, stderr: checkoutErr } = await runGit(repoRoot, [
					"checkout",
					canonicalBranch,
				]);
				if (checkoutCode !== 0) {
					throw new MergeError(`Failed to checkout ${canonicalBranch}: ${checkoutErr.trim()}`, {
						branchName: canonicalBranch,
					});
				}
			}

			let lastTier: ResolutionTier = "clean-merge";
			let conflictFiles: string[] = [];

			// Tier 1: Clean merge
			const cleanResult = await tryCleanMerge(entry, repoRoot);
			if (cleanResult.success) {
				return {
					entry: { ...entry, status: "merged", resolvedTier: "clean-merge" },
					success: true,
					tier: "clean-merge",
					conflictFiles: [],
					errorMessage: null,
				};
			}
			conflictFiles = cleanResult.conflictFiles;

			// Tier 2: Auto-resolve (keep incoming)
			lastTier = "auto-resolve";
			const autoResult = await tryAutoResolve(conflictFiles, repoRoot);
			if (autoResult.success) {
				return {
					entry: { ...entry, status: "merged", resolvedTier: "auto-resolve" },
					success: true,
					tier: "auto-resolve",
					conflictFiles,
					errorMessage: null,
				};
			}
			conflictFiles = autoResult.remainingConflicts;

			// Tier 3: AI-resolve
			if (options.aiResolveEnabled) {
				lastTier = "ai-resolve";
				const aiResult = await tryAiResolve(conflictFiles, repoRoot);
				if (aiResult.success) {
					return {
						entry: { ...entry, status: "merged", resolvedTier: "ai-resolve" },
						success: true,
						tier: "ai-resolve",
						conflictFiles,
						errorMessage: null,
					};
				}
				conflictFiles = aiResult.remainingConflicts;
			}

			// Tier 4: Re-imagine
			if (options.reimagineEnabled) {
				lastTier = "reimagine";
				const reimagineResult = await tryReimagine(entry, canonicalBranch, repoRoot);
				if (reimagineResult.success) {
					return {
						entry: { ...entry, status: "merged", resolvedTier: "reimagine" },
						success: true,
						tier: "reimagine",
						conflictFiles: [],
						errorMessage: null,
					};
				}
			}

			// All enabled tiers failed — abort any in-progress merge
			try {
				await runGit(repoRoot, ["merge", "--abort"]);
			} catch {
				// merge --abort may fail if there's no merge in progress (e.g., after reimagine)
			}

			return {
				entry: { ...entry, status: "failed", resolvedTier: null },
				success: false,
				tier: lastTier,
				conflictFiles,
				errorMessage: `All enabled resolution tiers failed (last attempted: ${lastTier})`,
			};
		},
	};
}
