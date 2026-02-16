import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DoctorCheck, DoctorCheckFn } from "./types.ts";

/**
 * Merge queue health checks.
 * Validates merge-queue.db schema and detects stale entries.
 */
export const checkMergeQueue: DoctorCheckFn = (_config, overstoryDir): DoctorCheck[] => {
	const checks: DoctorCheck[] = [];
	const dbPath = join(overstoryDir, "merge-queue.db");

	if (!existsSync(dbPath)) {
		checks.push({
			name: "merge-queue.db exists",
			category: "merge",
			status: "pass",
			message: "No merge queue database (normal for new installations or no merges yet)",
		});
		return checks;
	}

	let db: Database;
	try {
		db = new Database(dbPath, { readonly: true });
	} catch (err) {
		checks.push({
			name: "merge-queue.db readable",
			category: "merge",
			status: "fail",
			message: "Failed to open merge-queue.db",
			details: [err instanceof Error ? err.message : String(err)],
			fixable: true,
		});
		return checks;
	}

	try {
		// Check table exists
		let tableCheck: unknown;
		try {
			tableCheck = db
				.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='merge_queue'")
				.get();
		} catch (err) {
			// Database is corrupted or not a valid SQLite file
			checks.push({
				name: "merge-queue.db readable",
				category: "merge",
				status: "fail",
				message: "Failed to read merge-queue.db",
				details: [err instanceof Error ? err.message : String(err)],
				fixable: true,
			});
			db.close();
			return checks;
		}

		if (!tableCheck) {
			checks.push({
				name: "merge-queue.db schema",
				category: "merge",
				status: "fail",
				message: "merge_queue table not found in database",
				fixable: true,
			});
			db.close();
			return checks;
		}

		// Read all entries
		const rows = db.prepare("SELECT * FROM merge_queue ORDER BY id ASC").all() as Array<{
			branch_name: string;
			agent_name: string;
			status: string;
			enqueued_at: string;
			resolved_tier: string | null;
		}>;

		checks.push({
			name: "merge-queue.db schema",
			category: "merge",
			status: "pass",
			message: `Merge queue has ${rows.length} entries`,
		});

		// Check for stale entries (pending/merging older than 24h)
		const now = new Date();
		const staleThresholdMs = 24 * 60 * 60 * 1000;
		const staleEntries: string[] = [];
		for (const row of rows) {
			if (row.status === "pending" || row.status === "merging") {
				try {
					const enqueuedAt = new Date(row.enqueued_at);
					const ageMs = now.getTime() - enqueuedAt.getTime();
					if (ageMs > staleThresholdMs) {
						const ageHours = Math.floor(ageMs / (60 * 60 * 1000));
						staleEntries.push(
							`${row.branch_name} (${row.status}, ${ageHours}h old) - may be stuck`,
						);
					}
				} catch {
					/* invalid date */
				}
			}
		}

		if (staleEntries.length > 0) {
			checks.push({
				name: "merge-queue.db staleness",
				category: "merge",
				status: "warn",
				message: `Found ${staleEntries.length} potentially stale queue entries`,
				details: staleEntries,
				fixable: true,
			});
		}

		// Check for duplicate branches
		const branchCounts = new Map<string, number>();
		for (const row of rows) {
			branchCounts.set(row.branch_name, (branchCounts.get(row.branch_name) ?? 0) + 1);
		}
		const duplicates: string[] = [];
		for (const [branch, count] of branchCounts) {
			if (count > 1) duplicates.push(`${branch} (appears ${count} times)`);
		}
		if (duplicates.length > 0) {
			checks.push({
				name: "merge-queue.db duplicates",
				category: "merge",
				status: "warn",
				message: "Found duplicate branch entries in queue",
				details: duplicates,
				fixable: true,
			});
		}
	} finally {
		db.close();
	}

	return checks;
};
