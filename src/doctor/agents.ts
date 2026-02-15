import type { DoctorCheck, DoctorCheckFn } from "./types.ts";

/**
 * Agent state checks.
 * Validates agent definitions, tmux sessions, and agent identity files.
 */
export const checkAgents: DoctorCheckFn = (_config, _overstoryDir): DoctorCheck[] => {
	// Stub: checks will be implemented by a dedicated builder
	return [];
};
