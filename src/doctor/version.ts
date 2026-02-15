import type { DoctorCheck, DoctorCheckFn } from "./types.ts";

/**
 * Version compatibility checks.
 * Validates overstory CLI version, config schema version, database schema versions.
 */
export const checkVersion: DoctorCheckFn = (_config, _overstoryDir): DoctorCheck[] => {
	// Stub: checks will be implemented by a dedicated builder
	return [];
};
