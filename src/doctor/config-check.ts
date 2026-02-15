import type { DoctorCheck, DoctorCheckFn } from "./types.ts";

/**
 * Configuration validation checks.
 * Validates config.yaml schema, required fields, and value constraints.
 */
export const checkConfig: DoctorCheckFn = (_config, _overstoryDir): DoctorCheck[] => {
	// Stub: checks will be implemented by a dedicated builder
	return [];
};
