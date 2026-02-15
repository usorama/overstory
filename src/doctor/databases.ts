import type { DoctorCheck, DoctorCheckFn } from "./types.ts";

/**
 * Database integrity checks.
 * Validates SQLite databases (mail.db, metrics.db, sessions.db) exist and have correct schema.
 */
export const checkDatabases: DoctorCheckFn = (_config, _overstoryDir): DoctorCheck[] => {
	// Stub: checks will be implemented by a dedicated builder
	return [];
};
