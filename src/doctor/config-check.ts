import { existsSync } from "node:fs";
import { loadConfig } from "../config.ts";
import { ConfigError, ValidationError } from "../errors.ts";
import type { OverstoryConfig } from "../types.ts";
import type { DoctorCheck, DoctorCheckFn } from "./types.ts";

/**
 * Configuration validation checks.
 * Validates config.yaml schema, required fields, and value constraints.
 */
export const checkConfig: DoctorCheckFn = async (config, overstoryDir): Promise<DoctorCheck[]> => {
	const checks: DoctorCheck[] = [];

	// Check 1: config-parseable
	const parseableCheck = await checkConfigParseable(overstoryDir);
	checks.push(parseableCheck);

	// Check 2: config-valid
	const validCheck = await checkConfigValid(overstoryDir);
	checks.push(validCheck);

	// Check 3: project-root-exists
	const projectRootCheck = checkProjectRootExists(config);
	checks.push(projectRootCheck);

	// Check 4: canonical-branch-exists
	const branchCheck = await checkCanonicalBranchExists(config);
	checks.push(branchCheck);

	return checks;
};

/**
 * Check that config.yaml can be parsed.
 */
async function checkConfigParseable(overstoryDir: string): Promise<DoctorCheck> {
	try {
		// Try to load config - if this succeeds, config is parseable
		await loadConfig(overstoryDir);

		return {
			name: "config-parseable",
			category: "config",
			status: "pass",
			message: "Config loads without errors",
		};
	} catch (error) {
		if (error instanceof ConfigError) {
			return {
				name: "config-parseable",
				category: "config",
				status: "fail",
				message: "Config cannot be parsed",
				details: [error.message],
				fixable: true,
			};
		}

		// Other errors (including ValidationError) are not parsing errors
		return {
			name: "config-parseable",
			category: "config",
			status: "pass",
			message: "Config loads without errors",
		};
	}
}

/**
 * Check that config passes validation.
 */
async function checkConfigValid(overstoryDir: string): Promise<DoctorCheck> {
	try {
		// Try to load config - loadConfig runs validateConfig internally
		await loadConfig(overstoryDir);

		return {
			name: "config-valid",
			category: "config",
			status: "pass",
			message: "Validation passes",
		};
	} catch (error) {
		if (error instanceof ValidationError) {
			return {
				name: "config-valid",
				category: "config",
				status: "fail",
				message: "Validation fails",
				details: [error.message],
				fixable: true,
			};
		}

		// ConfigError or other errors are not validation errors
		if (error instanceof ConfigError) {
			// Config parsing failed, so we can't validate
			return {
				name: "config-valid",
				category: "config",
				status: "fail",
				message: "Cannot validate (config parsing failed)",
				details: [error.message],
			};
		}

		return {
			name: "config-valid",
			category: "config",
			status: "pass",
			message: "Validation passes",
		};
	}
}

/**
 * Check that project root directory exists.
 */
function checkProjectRootExists(config: OverstoryConfig): DoctorCheck {
	const projectRoot = config.project.root;

	if (existsSync(projectRoot)) {
		return {
			name: "project-root-exists",
			category: "config",
			status: "pass",
			message: "Project root directory exists",
			details: [projectRoot],
		};
	}

	return {
		name: "project-root-exists",
		category: "config",
		status: "fail",
		message: "Project root directory does not exist",
		details: [projectRoot],
		fixable: true,
	};
}

/**
 * Check that canonical branch exists in the repository.
 */
async function checkCanonicalBranchExists(config: OverstoryConfig): Promise<DoctorCheck> {
	const branchName = config.project.canonicalBranch;

	try {
		const proc = Bun.spawn(["git", "rev-parse", "--verify", `refs/heads/${branchName}`], {
			cwd: config.project.root,
			stdout: "pipe",
			stderr: "pipe",
		});

		const exitCode = await proc.exited;

		if (exitCode === 0) {
			return {
				name: "canonical-branch-exists",
				category: "config",
				status: "pass",
				message: `Canonical branch '${branchName}' exists`,
			};
		}

		return {
			name: "canonical-branch-exists",
			category: "config",
			status: "warn",
			message: `Canonical branch '${branchName}' does not exist`,
			details: [`Branch ${branchName} does not exist in the repository`],
			fixable: true,
		};
	} catch (error) {
		return {
			name: "canonical-branch-exists",
			category: "config",
			status: "warn",
			message: `Cannot verify canonical branch '${branchName}'`,
			details: [error instanceof Error ? error.message : String(error)],
		};
	}
}
