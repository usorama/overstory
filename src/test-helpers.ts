import { rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Create a temporary directory with a real git repo initialized.
 * Includes an initial commit so branches can be created immediately.
 *
 * @returns The absolute path to the temp git repo.
 */
export async function createTempGitRepo(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "overstory-test-"));

	// Initialize git repo
	await runGitInDir(dir, ["init"]);
	await runGitInDir(dir, ["config", "user.email", "test@overstory.dev"]);
	await runGitInDir(dir, ["config", "user.name", "Overstory Test"]);

	// Create initial commit (git worktree requires at least one commit)
	await Bun.write(join(dir, ".gitkeep"), "");
	await runGitInDir(dir, ["add", ".gitkeep"]);
	await runGitInDir(dir, ["commit", "-m", "initial commit"]);

	return dir;
}

/**
 * Add and commit a file to a git repo.
 *
 * @param repoDir - Absolute path to the git repo
 * @param filePath - Relative path within the repo (e.g. "src/foo.ts")
 * @param content - File content to write
 * @param message - Commit message (defaults to "add {filePath}")
 */
export async function commitFile(
	repoDir: string,
	filePath: string,
	content: string,
	message?: string,
): Promise<void> {
	const fullPath = join(repoDir, filePath);

	// Ensure parent directories exist
	const parentDir = join(fullPath, "..");
	const { mkdir } = await import("node:fs/promises");
	await mkdir(parentDir, { recursive: true });

	await Bun.write(fullPath, content);
	await runGitInDir(repoDir, ["add", filePath]);
	await runGitInDir(repoDir, ["commit", "-m", message ?? `add ${filePath}`]);
}

/**
 * Remove a temp directory. Safe to call even if the directory doesn't exist.
 */
export async function cleanupTempDir(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true });
}

/**
 * Run a git command in the given directory. Throws on non-zero exit.
 */
async function runGitInDir(cwd: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	if (exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`);
	}

	return stdout;
}
