import type { DoctorCheck, DoctorCheckFn } from "./types.ts";

/**
 * External dependency checks.
 * Validates that required CLI tools (git, bun, tmux, bd, mulch) are available.
 */
export const checkDependencies: DoctorCheckFn = (_config, _overstoryDir): DoctorCheck[] => {
	// Stub: checks will be implemented by a dedicated builder
	return [];
};
