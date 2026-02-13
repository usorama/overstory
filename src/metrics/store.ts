/**
 * SQLite-backed metrics storage for agent session data.
 *
 * Uses bun:sqlite for zero-dependency, synchronous database access.
 * All operations are sync — no async/await needed.
 */

import { Database } from "bun:sqlite";
import type { SessionMetrics } from "../types.ts";

export interface MetricsStore {
	recordSession(metrics: SessionMetrics): void;
	getRecentSessions(limit?: number): SessionMetrics[];
	getSessionsByAgent(agentName: string): SessionMetrics[];
	getAverageDuration(capability?: string): number;
	/** Delete metrics matching the given criteria. Returns the number of rows deleted. */
	purge(options: { all?: boolean; agent?: string }): number;
	close(): void;
}

/** Row shape as stored in SQLite (snake_case columns). */
interface SessionRow {
	agent_name: string;
	bead_id: string;
	capability: string;
	started_at: string;
	completed_at: string | null;
	duration_ms: number;
	exit_code: number | null;
	merge_result: string | null;
	parent_agent: string | null;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_creation_tokens: number;
	estimated_cost_usd: number | null;
	model_used: string | null;
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS sessions (
  agent_name TEXT NOT NULL,
  bead_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  exit_code INTEGER,
  merge_result TEXT,
  parent_agent TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL,
  model_used TEXT,
  PRIMARY KEY (agent_name, bead_id)
)`;

/** Token columns added in the token instrumentation migration. */
const TOKEN_COLUMNS = [
	{ name: "input_tokens", ddl: "INTEGER NOT NULL DEFAULT 0" },
	{ name: "output_tokens", ddl: "INTEGER NOT NULL DEFAULT 0" },
	{ name: "cache_read_tokens", ddl: "INTEGER NOT NULL DEFAULT 0" },
	{ name: "cache_creation_tokens", ddl: "INTEGER NOT NULL DEFAULT 0" },
	{ name: "estimated_cost_usd", ddl: "REAL" },
	{ name: "model_used", ddl: "TEXT" },
] as const;

/**
 * Migrate an existing sessions table to include token columns.
 * Safe to call multiple times — only adds columns that are missing.
 */
function migrateTokenColumns(db: Database): void {
	const rows = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
	const existingColumns = new Set(rows.map((r) => r.name));

	for (const col of TOKEN_COLUMNS) {
		if (!existingColumns.has(col.name)) {
			db.exec(`ALTER TABLE sessions ADD COLUMN ${col.name} ${col.ddl}`);
		}
	}
}

/** Convert a database row (snake_case) to a SessionMetrics object (camelCase). */
function rowToMetrics(row: SessionRow): SessionMetrics {
	return {
		agentName: row.agent_name,
		beadId: row.bead_id,
		capability: row.capability,
		startedAt: row.started_at,
		completedAt: row.completed_at,
		durationMs: row.duration_ms,
		exitCode: row.exit_code,
		mergeResult: row.merge_result as SessionMetrics["mergeResult"],
		parentAgent: row.parent_agent,
		inputTokens: row.input_tokens,
		outputTokens: row.output_tokens,
		cacheReadTokens: row.cache_read_tokens,
		cacheCreationTokens: row.cache_creation_tokens,
		estimatedCostUsd: row.estimated_cost_usd,
		modelUsed: row.model_used,
	};
}

/**
 * Create a new MetricsStore backed by a SQLite database at the given path.
 *
 * Initializes the database with WAL mode and a 5-second busy timeout.
 * Creates the sessions table if it does not already exist.
 * Migrates existing tables to add token columns if missing.
 */
export function createMetricsStore(dbPath: string): MetricsStore {
	const db = new Database(dbPath);

	// Configure for concurrent access
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA busy_timeout = 5000");

	// Create schema
	db.exec(CREATE_TABLE);

	// Migrate: add token columns to existing tables that lack them
	migrateTokenColumns(db);

	// Prepare statements for all queries
	const insertStmt = db.prepare<
		void,
		{
			$agent_name: string;
			$bead_id: string;
			$capability: string;
			$started_at: string;
			$completed_at: string | null;
			$duration_ms: number;
			$exit_code: number | null;
			$merge_result: string | null;
			$parent_agent: string | null;
			$input_tokens: number;
			$output_tokens: number;
			$cache_read_tokens: number;
			$cache_creation_tokens: number;
			$estimated_cost_usd: number | null;
			$model_used: string | null;
		}
	>(`
		INSERT OR REPLACE INTO sessions
			(agent_name, bead_id, capability, started_at, completed_at, duration_ms, exit_code, merge_result, parent_agent, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, estimated_cost_usd, model_used)
		VALUES
			($agent_name, $bead_id, $capability, $started_at, $completed_at, $duration_ms, $exit_code, $merge_result, $parent_agent, $input_tokens, $output_tokens, $cache_read_tokens, $cache_creation_tokens, $estimated_cost_usd, $model_used)
	`);

	const recentStmt = db.prepare<SessionRow, { $limit: number }>(`
		SELECT * FROM sessions ORDER BY started_at DESC LIMIT $limit
	`);

	const byAgentStmt = db.prepare<SessionRow, { $agent_name: string }>(`
		SELECT * FROM sessions WHERE agent_name = $agent_name ORDER BY started_at DESC
	`);

	const avgDurationAllStmt = db.prepare<{ avg_duration: number | null }, Record<string, never>>(`
		SELECT AVG(duration_ms) AS avg_duration FROM sessions WHERE completed_at IS NOT NULL
	`);

	const avgDurationByCapStmt = db.prepare<
		{ avg_duration: number | null },
		{ $capability: string }
	>(`
		SELECT AVG(duration_ms) AS avg_duration FROM sessions
		WHERE completed_at IS NOT NULL AND capability = $capability
	`);

	return {
		recordSession(metrics: SessionMetrics): void {
			insertStmt.run({
				$agent_name: metrics.agentName,
				$bead_id: metrics.beadId,
				$capability: metrics.capability,
				$started_at: metrics.startedAt,
				$completed_at: metrics.completedAt,
				$duration_ms: metrics.durationMs,
				$exit_code: metrics.exitCode,
				$merge_result: metrics.mergeResult,
				$parent_agent: metrics.parentAgent,
				$input_tokens: metrics.inputTokens,
				$output_tokens: metrics.outputTokens,
				$cache_read_tokens: metrics.cacheReadTokens,
				$cache_creation_tokens: metrics.cacheCreationTokens,
				$estimated_cost_usd: metrics.estimatedCostUsd,
				$model_used: metrics.modelUsed,
			});
		},

		getRecentSessions(limit = 20): SessionMetrics[] {
			const rows = recentStmt.all({ $limit: limit });
			return rows.map(rowToMetrics);
		},

		getSessionsByAgent(agentName: string): SessionMetrics[] {
			const rows = byAgentStmt.all({ $agent_name: agentName });
			return rows.map(rowToMetrics);
		},

		getAverageDuration(capability?: string): number {
			if (capability !== undefined) {
				const row = avgDurationByCapStmt.get({ $capability: capability });
				return row?.avg_duration ?? 0;
			}
			const row = avgDurationAllStmt.get({});
			return row?.avg_duration ?? 0;
		},

		purge(options: { all?: boolean; agent?: string }): number {
			if (options.all) {
				const countRow = db
					.prepare<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM sessions")
					.get();
				const count = countRow?.cnt ?? 0;
				db.prepare("DELETE FROM sessions").run();
				return count;
			}

			if (options.agent !== undefined) {
				const countRow = db
					.prepare<{ cnt: number }, { $agent: string }>(
						"SELECT COUNT(*) as cnt FROM sessions WHERE agent_name = $agent",
					)
					.get({ $agent: options.agent });
				const count = countRow?.cnt ?? 0;
				db.prepare<void, { $agent: string }>("DELETE FROM sessions WHERE agent_name = $agent").run({
					$agent: options.agent,
				});
				return count;
			}

			return 0;
		},

		close(): void {
			db.close();
		},
	};
}
