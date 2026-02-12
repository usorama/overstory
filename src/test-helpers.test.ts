import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, commitFile, createTempGitRepo } from "./test-helpers.ts";

describe("createTempGitRepo", () => {
	let repoDir: string | undefined;

	afterEach(async () => {
		if (repoDir) {
			await cleanupTempDir(repoDir);
			repoDir = undefined;
		}
	});

	test("creates a directory with an initialized git repo", async () => {
		repoDir = await createTempGitRepo();

		expect(existsSync(join(repoDir, ".git"))).toBe(true);
	});

	test("repo has at least one commit (HEAD exists)", async () => {
		repoDir = await createTempGitRepo();

		const proc = Bun.spawn(["git", "rev-parse", "HEAD"], {
			cwd: repoDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;

		expect(exitCode).toBe(0);
	});

	test("repo is on a branch (not detached HEAD)", async () => {
		repoDir = await createTempGitRepo();

		const proc = Bun.spawn(["git", "symbolic-ref", "HEAD"], {
			cwd: repoDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		const exitCode = await proc.exited;

		expect(exitCode).toBe(0);
		expect(stdout.trim()).toMatch(/^refs\/heads\//);
	});
});

describe("commitFile", () => {
	let repoDir: string | undefined;

	afterEach(async () => {
		if (repoDir) {
			await cleanupTempDir(repoDir);
			repoDir = undefined;
		}
	});

	test("creates file and commits it", async () => {
		repoDir = await createTempGitRepo();

		await commitFile(repoDir, "hello.txt", "world");

		// File exists with correct content
		const content = await readFile(join(repoDir, "hello.txt"), "utf-8");
		expect(content).toBe("world");

		// Git log shows the commit
		const proc = Bun.spawn(["git", "log", "--oneline"], {
			cwd: repoDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;

		expect(stdout).toContain("add hello.txt");
	});

	test("creates nested directories as needed", async () => {
		repoDir = await createTempGitRepo();

		await commitFile(repoDir, "src/deep/nested/file.ts", "export const x = 1;");

		expect(existsSync(join(repoDir, "src/deep/nested/file.ts"))).toBe(true);
	});

	test("uses custom commit message when provided", async () => {
		repoDir = await createTempGitRepo();

		await commitFile(repoDir, "readme.md", "# Hi", "docs: add readme");

		const proc = Bun.spawn(["git", "log", "--oneline", "-1"], {
			cwd: repoDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;

		expect(stdout).toContain("docs: add readme");
	});
});

describe("cleanupTempDir", () => {
	test("removes directory and all contents", async () => {
		const repoDir = await createTempGitRepo();
		await commitFile(repoDir, "file.txt", "data");

		expect(existsSync(repoDir)).toBe(true);

		await cleanupTempDir(repoDir);

		expect(existsSync(repoDir)).toBe(false);
	});

	test("does not throw when directory does not exist", async () => {
		await cleanupTempDir("/tmp/overstory-nonexistent-test-dir-12345");
		// No error thrown = pass
	});
});
