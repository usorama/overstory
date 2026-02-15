import type { DoctorCheck, DoctorCheckFn } from "./types.ts";

/**
 * External dependency checks.
 * Validates that required CLI tools (git, bun, tmux, bd, mulch) are available.
 */
export const checkDependencies: DoctorCheckFn = async (
	_config,
	_overstoryDir,
): Promise<DoctorCheck[]> => {
	const requiredTools = [
		{ name: "git", versionFlag: "--version", required: true },
		{ name: "bun", versionFlag: "--version", required: true },
		{ name: "tmux", versionFlag: "-V", required: true },
		{ name: "bd", versionFlag: "--version", required: true },
		{ name: "mulch", versionFlag: "--version", required: true },
	];

	const checks: DoctorCheck[] = [];

	for (const tool of requiredTools) {
		const check = await checkTool(tool.name, tool.versionFlag, tool.required);
		checks.push(check);
	}

	return checks;
};

/**
 * Check if a CLI tool is available by attempting to run it with a version flag.
 */
async function checkTool(
	name: string,
	versionFlag: string,
	required: boolean,
): Promise<DoctorCheck> {
	try {
		const proc = Bun.spawn([name, versionFlag], {
			stdout: "pipe",
			stderr: "pipe",
		});

		const exitCode = await proc.exited;

		if (exitCode === 0) {
			const stdout = await new Response(proc.stdout).text();
			const version = stdout.split("\n")[0]?.trim() || "version unknown";

			return {
				name: `${name} availability`,
				category: "dependencies",
				status: "pass",
				message: `${name} is available`,
				details: [version],
			};
		}

		// Non-zero exit code
		const stderr = await new Response(proc.stderr).text();
		return {
			name: `${name} availability`,
			category: "dependencies",
			status: required ? "fail" : "warn",
			message: `${name} command failed (exit code ${exitCode})`,
			details: stderr ? [stderr.trim()] : undefined,
			fixable: true,
		};
	} catch (error) {
		// Command not found or spawn failed
		return {
			name: `${name} availability`,
			category: "dependencies",
			status: required ? "fail" : "warn",
			message: `${name} is not installed or not in PATH`,
			details: [
				`Install ${name} or ensure it is in your PATH`,
				error instanceof Error ? error.message : String(error),
			],
			fixable: true,
		};
	}
}
