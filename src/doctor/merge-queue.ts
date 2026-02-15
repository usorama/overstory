import type { DoctorCheck, DoctorCheckFn } from "./types.ts";

/**
 * Merge queue health checks.
 * Validates merge-queue.json format and detects stale entries.
 */
export const checkMergeQueue: DoctorCheckFn = (_config, _overstoryDir): DoctorCheck[] => {
	// Stub: checks will be implemented by a dedicated builder
	return [];
};
