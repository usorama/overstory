import type { DoctorCheck, DoctorCheckFn } from "./types.ts";

/**
 * Directory structure checks.
 * Validates that .overstory/ and its subdirectories exist with correct permissions.
 */
export const checkStructure: DoctorCheckFn = (_config, _overstoryDir): DoctorCheck[] => {
	// Stub: checks will be implemented by a dedicated builder
	return [];
};
