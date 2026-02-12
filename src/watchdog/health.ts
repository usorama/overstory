/**
 * Health check state machine and evaluation logic for agent monitoring.
 *
 * ZFC Principle (Zero Failure Crash)
 * ==================================
 * Observable state is the source of truth, not recorded state.
 *
 * Signal priority (highest to lowest):
 *   1. tmux session liveness  — Is the tmux session actually running?
 *   2. Process liveness (pid) — Is the Claude Code process still alive?
 *   3. Recorded state         — What does sessions.json claim?
 *
 * When signals conflict, always trust what you can observe:
 *   - tmux dead + sessions.json says "working" → mark zombie immediately.
 *     The recorded state is stale; the process is gone.
 *   - tmux alive + sessions.json says "zombie" → investigate, don't auto-kill.
 *     Something marked it zombie but the process recovered or was misclassified.
 *   - pid dead + tmux alive → the pane's shell survived but the agent process
 *     exited. Treat as zombie (the agent is not doing work).
 *   - pid alive + tmux dead → should not happen (tmux owns the pid), but if it
 *     does, trust tmux (the session is gone).
 *
 * The rationale: sessions.json is updated asynchronously by hooks and can become
 * stale if the agent crashes between hook invocations. tmux and the OS process
 * table are always up-to-date because they reflect real kernel state.
 */

import type { AgentSession, AgentState, HealthCheck } from "../types.ts";

/** Numeric ordering for forward-only state transitions. */
const STATE_ORDER: Record<AgentState, number> = {
	booting: 0,
	working: 1,
	completed: 2,
	stalled: 3,
	zombie: 4,
};

/**
 * Check whether a process with the given PID is still running.
 *
 * Uses signal 0 which does not kill the process — it only checks
 * whether it exists and we have permission to signal it.
 *
 * @param pid - The process ID to check
 * @returns true if the process exists, false otherwise
 */
export function isProcessRunning(pid: number): boolean {
	try {
		// Signal 0 doesn't kill the process — just checks if it exists
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Evaluate the health of an agent session.
 *
 * Implements the ZFC principle: observable state (tmux liveness, pid liveness)
 * takes priority over recorded state (sessions.json fields).
 *
 * Decision logic (in priority order):
 *
 * 1. Completed agents skip monitoring entirely.
 * 2. tmux dead → zombie, terminate (regardless of what sessions.json says).
 * 3. tmux alive + sessions.json says zombie → investigate (don't auto-kill).
 *    Something external marked this zombie, but the process is still running.
 * 4. pid dead + tmux alive → zombie, terminate. The agent process exited but
 *    the tmux pane shell survived. The agent is not doing work.
 * 5. lastActivity older than zombieMs → zombie, terminate.
 * 6. lastActivity older than staleMs → stalled, escalate.
 * 7. booting with recent activity → working.
 * 8. Otherwise → working, healthy.
 *
 * @param session - The agent session to evaluate
 * @param tmuxAlive - Whether the agent's tmux session is still running
 * @param thresholds - Staleness and zombie time thresholds in milliseconds
 * @returns A HealthCheck describing the agent's current state and recommended action
 */
export function evaluateHealth(
	session: AgentSession,
	tmuxAlive: boolean,
	thresholds: { staleMs: number; zombieMs: number },
): HealthCheck {
	const now = new Date();
	const lastActivityTime = new Date(session.lastActivity).getTime();
	const elapsedMs = now.getTime() - lastActivityTime;

	// Check pid liveness as secondary signal (null if pid unavailable)
	const pidAlive = session.pid !== null ? isProcessRunning(session.pid) : null;

	const base: Pick<
		HealthCheck,
		"agentName" | "timestamp" | "tmuxAlive" | "pidAlive" | "lastActivity"
	> = {
		agentName: session.agentName,
		timestamp: now.toISOString(),
		tmuxAlive,
		pidAlive,
		lastActivity: session.lastActivity,
	};

	// Completed agents don't need health monitoring
	if (session.state === "completed") {
		return {
			...base,
			processAlive: tmuxAlive,
			state: "completed",
			action: "none",
			reconciliationNote: null,
		};
	}

	// ZFC Rule 1: tmux dead → zombie immediately, regardless of recorded state.
	// Observable state says the process is gone.
	if (!tmuxAlive) {
		const note =
			session.state === "working" || session.state === "booting"
				? `ZFC: tmux dead but sessions.json says "${session.state}" — marking zombie (observable state wins)`
				: null;

		return {
			...base,
			processAlive: false,
			state: "zombie",
			action: "terminate",
			reconciliationNote: note,
		};
	}

	// ZFC Rule 2: tmux alive but sessions.json says zombie → investigate.
	// Something marked it zombie but the process is still running. Don't auto-kill;
	// a human or higher-tier agent should decide.
	if (session.state === "zombie") {
		return {
			...base,
			processAlive: true,
			state: "zombie",
			action: "investigate",
			reconciliationNote:
				"ZFC: tmux alive but sessions.json says zombie — investigation needed (don't auto-kill)",
		};
	}

	// ZFC Rule 3: pid dead but tmux alive → the agent process exited but the
	// tmux pane shell survived. The agent is not doing work.
	if (pidAlive === false) {
		return {
			...base,
			processAlive: false,
			state: "zombie",
			action: "terminate",
			reconciliationNote: `ZFC: pid ${session.pid} dead but tmux alive — agent process exited, shell survived`,
		};
	}

	// Time-based checks (both tmux and pid confirmed alive, or pid unavailable)

	// lastActivity older than zombieMs → zombie
	if (elapsedMs > thresholds.zombieMs) {
		return {
			...base,
			processAlive: true,
			state: "zombie",
			action: "terminate",
			reconciliationNote: null,
		};
	}

	// lastActivity older than staleMs → stalled
	if (elapsedMs > thresholds.staleMs) {
		return {
			...base,
			processAlive: true,
			state: "stalled",
			action: "escalate",
			reconciliationNote: null,
		};
	}

	// booting → transition to working once there's recent activity
	if (session.state === "booting") {
		return {
			...base,
			processAlive: true,
			state: "working",
			action: "none",
			reconciliationNote: null,
		};
	}

	// Default: healthy and working
	return {
		...base,
		processAlive: true,
		state: "working",
		action: "none",
		reconciliationNote: null,
	};
}

/**
 * Compute the next agent state based on a health check.
 *
 * State transitions are strictly forward-only using the ordering:
 *   booting(0) → working(1) → stalled(2) → zombie(3)
 *
 * A state can only advance forward, never move backwards.
 * For example, a zombie can never become working again.
 *
 * Exception (ZFC): When the health check action is "investigate", the state
 * is NOT advanced. This allows a human or higher-tier agent to review the
 * conflicting signals before making a state change.
 *
 * @param currentState - The agent's current state
 * @param check - The latest health check result
 * @returns The new state (always >= currentState in ordering)
 */
export function transitionState(currentState: AgentState, check: HealthCheck): AgentState {
	// ZFC: investigate means signals conflict — hold state until reviewed
	if (check.action === "investigate") {
		return currentState;
	}

	const currentOrder = STATE_ORDER[currentState];
	const checkOrder = STATE_ORDER[check.state];

	// Only move forward — never regress
	if (checkOrder > currentOrder) {
		return check.state;
	}

	return currentState;
}
