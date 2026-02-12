/**
 * Health check state machine and evaluation logic for agent monitoring.
 *
 * Evaluates agent health based on tmux session liveness and activity timestamps.
 * State transitions are strictly forward-only: booting → working → stalled → zombie.
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
 * Evaluate the health of an agent session.
 *
 * Decision logic:
 * - tmux dead → zombie, terminate
 * - lastActivity older than zombieMs → zombie, terminate
 * - lastActivity older than staleMs → stalled, escalate
 * - booting and lastActivity within staleMs → working, none
 * - otherwise → working, none
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

	const base: Pick<HealthCheck, "agentName" | "timestamp" | "tmuxAlive" | "lastActivity"> = {
		agentName: session.agentName,
		timestamp: now.toISOString(),
		tmuxAlive,
		lastActivity: session.lastActivity,
	};

	// Completed agents don't need health monitoring
	if (session.state === "completed") {
		return {
			...base,
			processAlive: tmuxAlive,
			state: "completed",
			action: "none",
		};
	}

	// tmux dead → zombie
	if (!tmuxAlive) {
		return {
			...base,
			processAlive: false,
			state: "zombie",
			action: "terminate",
		};
	}

	// lastActivity older than zombieMs → zombie
	if (elapsedMs > thresholds.zombieMs) {
		return {
			...base,
			processAlive: true,
			state: "zombie",
			action: "terminate",
		};
	}

	// lastActivity older than staleMs → stalled
	if (elapsedMs > thresholds.staleMs) {
		return {
			...base,
			processAlive: true,
			state: "stalled",
			action: "escalate",
		};
	}

	// booting → transition to working once there's recent activity
	if (session.state === "booting") {
		return {
			...base,
			processAlive: true,
			state: "working",
			action: "none",
		};
	}

	// Default: healthy and working
	return {
		...base,
		processAlive: true,
		state: "working",
		action: "none",
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
 * @param currentState - The agent's current state
 * @param check - The latest health check result
 * @returns The new state (always >= currentState in ordering)
 */
export function transitionState(currentState: AgentState, check: HealthCheck): AgentState {
	const currentOrder = STATE_ORDER[currentState];
	const checkOrder = STATE_ORDER[check.state];

	// Only move forward — never regress
	if (checkOrder > currentOrder) {
		return check.state;
	}

	return currentState;
}
