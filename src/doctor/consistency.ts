import type { DoctorCheck, DoctorCheckFn } from "./types.ts";

/**
 * Cross-subsystem consistency checks.
 * Validates SessionStore vs worktrees, beads vs agent tasks, etc.
 */
export const checkConsistency: DoctorCheckFn = (_config, _overstoryDir): DoctorCheck[] => {
	// Stub: checks will be implemented by a dedicated builder
	return [];
};
