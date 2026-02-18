/**
 * Integration test: End-to-end coordination protocol.
 *
 * Exercises the full agent coordination pipeline WITHOUT tmux:
 *   1. Session registration (SessionStore)
 *   2. Mail coordination (worker_done → merge_ready → merged)
 *   3. Merge queue (enqueue → dequeue → resolve)
 *   4. Merge resolution (real git operations)
 *   5. Session lifecycle (booting → working → completed)
 *
 * Uses real git repos, real SQLite databases, and real mail stores.
 * Only tmux and external AI are mocked (per testing philosophy).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createEventStore } from "../events/store.ts";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import { createMergeQueue } from "../merge/queue.ts";
import { createMergeResolver } from "../merge/resolver.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { createRunStore } from "../sessions/store.ts";
import {
	cleanupTempDir,
	commitFile,
	createTempGitRepo,
	getDefaultBranch,
	runGitInDir,
} from "../test-helpers.ts";
import type { AgentSession, MergeEntry } from "../types.ts";

let tempDir: string;
let overstoryDir: string;
let baseBranch: string;

beforeEach(async () => {
	tempDir = await createTempGitRepo();
	baseBranch = await getDefaultBranch(tempDir);
	overstoryDir = join(tempDir, ".overstory");
	await mkdir(overstoryDir, { recursive: true });
});

afterEach(async () => {
	await cleanupTempDir(tempDir);
});

/**
 * Helper: create a real worktree branch with a committed change.
 * Simulates what sling does (steps 7-8) without tmux.
 */
async function createAgentBranch(
	repoRoot: string,
	branchName: string,
	canonical: string,
	fileName: string,
	content: string,
): Promise<void> {
	// Create branch from canonical
	await runGitInDir(repoRoot, ["checkout", "-b", branchName, canonical]);
	await commitFile(repoRoot, fileName, content, `implement ${fileName}`);
	// Return to canonical
	await runGitInDir(repoRoot, ["checkout", canonical]);
}

/**
 * Helper: register an agent session in the SessionStore.
 */
function registerAgent(
	sessionsDbPath: string,
	agentName: string,
	capability: string,
	branchName: string,
	beadId: string,
	runId: string,
	parentAgent: string | null = null,
): AgentSession {
	const { store } = openSessionStore(join(sessionsDbPath, ".."));
	const session: AgentSession = {
		id: `session-${Date.now()}-${agentName}`,
		agentName,
		capability,
		worktreePath: `/tmp/fake-worktree-${agentName}`,
		branchName,
		beadId,
		tmuxSession: `overstory-test-${agentName}`,
		state: "booting",
		pid: null,
		parentAgent,
		depth: parentAgent ? 2 : 1,
		runId,
		startedAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
		escalationLevel: 0,
		stalledSince: null,
	};
	store.upsert(session);
	store.close();
	return session;
}

describe("coordination protocol: full pipeline", () => {
	test("session lifecycle: booting → working → completed", () => {
		const { store } = openSessionStore(overstoryDir);

		// Register agent as booting
		const session: AgentSession = {
			id: "session-lifecycle-test",
			agentName: "lifecycle-builder",
			capability: "builder",
			worktreePath: "/tmp/fake",
			branchName: "overstory/lifecycle-builder/test-1",
			beadId: "test-1",
			tmuxSession: "overstory-test-lifecycle-builder",
			state: "booting",
			pid: null,
			parentAgent: "lead-1",
			depth: 2,
			runId: "run-lifecycle",
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		};
		store.upsert(session);

		// Verify booting state
		const booting = store.getByName("lifecycle-builder");
		expect(booting?.state).toBe("booting");

		// Transition to working (happens via hook on first tool call)
		store.updateState("lifecycle-builder", "working");
		store.updateLastActivity("lifecycle-builder");

		const working = store.getByName("lifecycle-builder");
		expect(working?.state).toBe("working");

		// Appears in active list
		const active = store.getActive();
		expect(active.some((s) => s.agentName === "lifecycle-builder")).toBe(true);

		// Transition to completed
		store.updateState("lifecycle-builder", "completed");

		const completed = store.getByName("lifecycle-builder");
		expect(completed?.state).toBe("completed");

		// No longer in active list
		const activeAfter = store.getActive();
		expect(activeAfter.some((s) => s.agentName === "lifecycle-builder")).toBe(false);

		store.close();
	});

	test("run tracking: create run, increment agent count, complete run", () => {
		const runStore = createRunStore(join(overstoryDir, "sessions.db"));

		const runId = `run-${Date.now()}`;
		runStore.createRun({
			id: runId,
			startedAt: new Date().toISOString(),
			coordinatorSessionId: null,
			status: "active",
		});

		// Increment for 3 agents
		runStore.incrementAgentCount(runId);
		runStore.incrementAgentCount(runId);
		runStore.incrementAgentCount(runId);

		const activeRun = runStore.getActiveRun();
		expect(activeRun).not.toBeNull();
		expect(activeRun?.id).toBe(runId);
		expect(activeRun?.agentCount).toBe(3);
		expect(activeRun?.status).toBe("active");

		// Complete run
		runStore.completeRun(runId, "completed");

		const completedRun = runStore.getRun(runId);
		expect(completedRun?.status).toBe("completed");
		expect(completedRun?.completedAt).not.toBeNull();

		// No active run anymore
		expect(runStore.getActiveRun()).toBeNull();

		runStore.close();
	});

	test("mail flow: worker_done → lead processes → merge_ready → orchestrator merges", () => {
		const mailDbPath = join(overstoryDir, "mail.db");
		const mailStore = createMailStore(mailDbPath);
		const mail = createMailClient(mailStore);

		// Step 1: Builder sends worker_done to lead
		mail.send({
			from: "builder-alpha",
			to: "lead-main",
			subject: "Worker done: task-001",
			body: "Completed implementation for task-001. Quality gates passed.",
			type: "worker_done",
			priority: "normal",
			payload: JSON.stringify({
				beadId: "task-001",
				branch: "overstory/builder-alpha/task-001",
				exitCode: 0,
				filesModified: ["src/feature.ts", "src/feature.test.ts"],
			}),
		});

		// Step 2: Lead checks inbox — sees worker_done
		const leadInbox = mail.check("lead-main");
		expect(leadInbox.length).toBe(1);
		expect(leadInbox[0]?.type).toBe("worker_done");
		expect(leadInbox[0]?.from).toBe("builder-alpha");

		// Parse the payload
		const donePayload = JSON.parse(leadInbox[0]?.payload ?? "{}");
		expect(donePayload.beadId).toBe("task-001");
		expect(donePayload.branch).toBe("overstory/builder-alpha/task-001");

		// Step 3: Lead verifies branch, sends merge_ready to orchestrator
		mail.send({
			from: "lead-main",
			to: "orchestrator",
			subject: "Merge ready: task-001",
			body: "Branch verified. Ready for merge.",
			type: "merge_ready",
			priority: "normal",
			payload: JSON.stringify({
				branch: "overstory/builder-alpha/task-001",
				beadId: "task-001",
				agentName: "builder-alpha",
				filesModified: ["src/feature.ts", "src/feature.test.ts"],
			}),
		});

		// Step 4: Orchestrator checks inbox — sees merge_ready
		const orchInbox = mail.check("orchestrator");
		expect(orchInbox.length).toBe(1);
		expect(orchInbox[0]?.type).toBe("merge_ready");

		const mergePayload = JSON.parse(orchInbox[0]?.payload ?? "{}");
		expect(mergePayload.branch).toBe("overstory/builder-alpha/task-001");

		// Step 5: After merge, orchestrator sends merged confirmation
		mail.send({
			from: "orchestrator",
			to: "lead-main",
			subject: "Merged: task-001",
			body: "Branch merged via clean-merge (Tier 1).",
			type: "merged",
			priority: "normal",
			payload: JSON.stringify({
				branch: "overstory/builder-alpha/task-001",
				beadId: "task-001",
				tier: "clean-merge",
			}),
		});

		// Verify lead receives merged confirmation
		const leadConfirm = mail.check("lead-main");
		expect(leadConfirm.length).toBe(1);
		expect(leadConfirm[0]?.type).toBe("merged");

		mail.close();
	});

	test("merge queue: enqueue → peek → resolve via real git merge", async () => {
		// Set up: commit a base file on canonical
		await commitFile(tempDir, "src/base.ts", "export const x = 1;\n", "add base file");

		// Create agent branch with new file (clean merge scenario)
		await createAgentBranch(
			tempDir,
			"overstory/builder-1/task-100",
			baseBranch,
			"src/feature-new.ts",
			'export function newFeature() { return "hello"; }\n',
		);

		// Create merge queue
		const queueDbPath = join(overstoryDir, "merge-queue.db");
		const queue = createMergeQueue(queueDbPath);

		// Enqueue the branch
		const entry = queue.enqueue({
			branchName: "overstory/builder-1/task-100",
			beadId: "task-100",
			agentName: "builder-1",
			filesModified: ["src/feature-new.ts"],
		});
		expect(entry.status).toBe("pending");

		// Peek to see what's next (non-destructive)
		const peeked = queue.peek();
		expect(peeked).not.toBeNull();
		expect(peeked?.branchName).toBe("overstory/builder-1/task-100");
		expect(peeked?.status).toBe("pending");

		// Mark as merging
		queue.updateStatus("overstory/builder-1/task-100", "merging");

		// Resolve via real git merge (Tier 1: clean merge)
		const resolver = createMergeResolver({
			aiResolveEnabled: false,
			reimagineEnabled: false,
		});

		const result = await resolver.resolve(peeked as MergeEntry, baseBranch, tempDir);
		expect(result.success).toBe(true);
		expect(result.tier).toBe("clean-merge");
		expect(result.conflictFiles).toEqual([]);

		// Update queue status to merged
		const peekedBranch = peeked?.branchName ?? "";
		queue.updateStatus(peekedBranch, "merged", "clean-merge");

		// Verify entry is now "merged" (not pending)
		const merged = queue.list("merged");
		expect(merged.length).toBe(1);
		expect(merged[0]?.resolvedTier).toBe("clean-merge");

		// No more pending
		expect(queue.peek()).toBeNull();

		// Verify the file exists on canonical branch
		const mergedContent = await Bun.file(join(tempDir, "src/feature-new.ts")).text();
		expect(mergedContent).toContain("newFeature");

		queue.close();
	});

	test("merge queue: multiple agents, FIFO ordering preserved", async () => {
		// Set up base
		await commitFile(tempDir, "src/base.ts", "export const x = 1;\n");

		// Create 3 agent branches with non-overlapping files
		await createAgentBranch(
			tempDir,
			"overstory/builder-a/task-a",
			baseBranch,
			"src/feature-a.ts",
			'export const a = "a";\n',
		);
		await createAgentBranch(
			tempDir,
			"overstory/builder-b/task-b",
			baseBranch,
			"src/feature-b.ts",
			'export const b = "b";\n',
		);
		await createAgentBranch(
			tempDir,
			"overstory/builder-c/task-c",
			baseBranch,
			"src/feature-c.ts",
			'export const c = "c";\n',
		);

		const queueDbPath = join(overstoryDir, "merge-queue.db");
		const queue = createMergeQueue(queueDbPath);

		// Enqueue in order: a, b, c
		queue.enqueue({
			branchName: "overstory/builder-a/task-a",
			beadId: "task-a",
			agentName: "builder-a",
			filesModified: ["src/feature-a.ts"],
		});
		queue.enqueue({
			branchName: "overstory/builder-b/task-b",
			beadId: "task-b",
			agentName: "builder-b",
			filesModified: ["src/feature-b.ts"],
		});
		queue.enqueue({
			branchName: "overstory/builder-c/task-c",
			beadId: "task-c",
			agentName: "builder-c",
			filesModified: ["src/feature-c.ts"],
		});

		// Verify FIFO: peek returns a first, then b, then c after processing
		const resolver = createMergeResolver({
			aiResolveEnabled: false,
			reimagineEnabled: false,
		});

		// Process first (a)
		const first = queue.peek();
		expect(first?.agentName).toBe("builder-a");
		const firstBranch = first?.branchName ?? "";
		queue.updateStatus(firstBranch, "merging");
		const resultA = await resolver.resolve(first as MergeEntry, baseBranch, tempDir);
		expect(resultA.success).toBe(true);
		queue.updateStatus(firstBranch, "merged", "clean-merge");

		// Process second (b)
		const second = queue.peek();
		expect(second?.agentName).toBe("builder-b");
		const secondBranch = second?.branchName ?? "";
		queue.updateStatus(secondBranch, "merging");
		const resultB = await resolver.resolve(second as MergeEntry, baseBranch, tempDir);
		expect(resultB.success).toBe(true);
		queue.updateStatus(secondBranch, "merged", "clean-merge");

		// Process third (c)
		const third = queue.peek();
		expect(third?.agentName).toBe("builder-c");
		const thirdBranch = third?.branchName ?? "";
		queue.updateStatus(thirdBranch, "merging");
		const resultC = await resolver.resolve(third as MergeEntry, baseBranch, tempDir);
		expect(resultC.success).toBe(true);
		queue.updateStatus(thirdBranch, "merged", "clean-merge");

		// All merged, no more pending
		expect(queue.peek()).toBeNull();
		expect(queue.list("merged").length).toBe(3);

		queue.close();
	});

	test("merge with auto-resolve (Tier 2): conflicting changes resolved by keeping incoming", async () => {
		// Both branches modify the same file
		await commitFile(tempDir, "src/shared.ts", 'export const value = "original";\n');

		// Canonical branch modifies the file
		await commitFile(tempDir, "src/shared.ts", 'export const value = "canonical-change";\n');

		// Create agent branch from BEFORE the canonical change (to produce conflict)
		// First reset to the commit before canonical change
		await runGitInDir(tempDir, ["checkout", "-b", "overstory/builder-conflict/task-c", "HEAD~1"]);
		await commitFile(tempDir, "src/shared.ts", 'export const value = "agent-change";\n');
		await runGitInDir(tempDir, ["checkout", baseBranch]);

		const resolver = createMergeResolver({
			aiResolveEnabled: false,
			reimagineEnabled: false,
		});

		const entry: MergeEntry = {
			branchName: "overstory/builder-conflict/task-c",
			beadId: "task-c",
			agentName: "builder-conflict",
			filesModified: ["src/shared.ts"],
			enqueuedAt: new Date().toISOString(),
			status: "merging",
			resolvedTier: null,
		};

		const result = await resolver.resolve(entry, baseBranch, tempDir);
		expect(result.success).toBe(true);
		expect(result.tier).toBe("auto-resolve");

		// Verify the agent's change won (keep incoming)
		const content = await Bun.file(join(tempDir, "src/shared.ts")).text();
		expect(content).toContain("agent-change");
	});

	test("event store: records events across multiple agents", () => {
		const eventsDbPath = join(overstoryDir, "events.db");
		const eventStore = createEventStore(eventsDbPath);

		// Simulate events from 2 agents
		eventStore.insert({
			runId: "run-1",
			agentName: "builder-1",
			sessionId: "sess-1",
			eventType: "tool_start",
			toolName: "Read",
			toolArgs: '{"file_path": "src/foo.ts"}',
			toolDurationMs: null,
			level: "info",
			data: null,
		});

		eventStore.insert({
			runId: "run-1",
			agentName: "builder-2",
			sessionId: "sess-2",
			eventType: "tool_start",
			toolName: "Edit",
			toolArgs: '{"file_path": "src/bar.ts"}',
			toolDurationMs: null,
			level: "info",
			data: null,
		});

		eventStore.insert({
			runId: "run-1",
			agentName: "builder-1",
			sessionId: "sess-1",
			eventType: "tool_end",
			toolName: "Read",
			toolArgs: null,
			toolDurationMs: 45,
			level: "info",
			data: null,
		});

		// Query by agent
		const b1Events = eventStore.getByAgent("builder-1");
		expect(b1Events.length).toBe(2);

		const b2Events = eventStore.getByAgent("builder-2");
		expect(b2Events.length).toBe(1);

		// Query by run
		const runEvents = eventStore.getByRun("run-1");
		expect(runEvents.length).toBe(3);

		// Tool stats
		const stats = eventStore.getToolStats({ agentName: "builder-1" });
		expect(stats.length).toBeGreaterThan(0);

		eventStore.close();
	});

	test("full pipeline: register agents → mail flow → merge → session completion", async () => {
		const sessionsDbPath = join(overstoryDir, "sessions.db");
		const mailDbPath = join(overstoryDir, "mail.db");
		const queueDbPath = join(overstoryDir, "merge-queue.db");

		// Set up repo with a base file
		await commitFile(tempDir, "src/app.ts", 'console.log("hello");\n');

		// Create agent branch
		await createAgentBranch(
			tempDir,
			"overstory/builder-x/task-x",
			baseBranch,
			"src/new-module.ts",
			'export function greet() { return "world"; }\n',
		);

		// 1. Create run
		const runId = `run-e2e-${Date.now()}`;
		const runStore = createRunStore(sessionsDbPath);
		runStore.createRun({
			id: runId,
			startedAt: new Date().toISOString(),
			coordinatorSessionId: null,
			status: "active",
		});

		// 2. Register lead + builder sessions
		registerAgent(sessionsDbPath, "lead-x", "lead", baseBranch, "task-x-lead", runId, null);
		registerAgent(
			sessionsDbPath,
			"builder-x",
			"builder",
			"overstory/builder-x/task-x",
			"task-x",
			runId,
			"lead-x",
		);
		runStore.incrementAgentCount(runId);
		runStore.incrementAgentCount(runId);

		// 3. Transition builder to working
		const { store } = openSessionStore(overstoryDir);
		store.updateState("builder-x", "working");
		store.updateState("lead-x", "working");

		// 4. Builder completes → sends worker_done
		const mailStore = createMailStore(mailDbPath);
		const mail = createMailClient(mailStore);
		mail.send({
			from: "builder-x",
			to: "lead-x",
			subject: "Worker done: task-x",
			body: "Implementation complete. Quality gates passed.",
			type: "worker_done",
			priority: "normal",
			payload: JSON.stringify({
				beadId: "task-x",
				branch: "overstory/builder-x/task-x",
				exitCode: 0,
				filesModified: ["src/new-module.ts"],
			}),
		});

		// Mark builder as completed
		store.updateState("builder-x", "completed");

		// 5. Lead processes worker_done → sends merge_ready
		const leadInbox = mail.check("lead-x");
		expect(leadInbox.length).toBeGreaterThan(0);

		mail.send({
			from: "lead-x",
			to: "orchestrator",
			subject: "Merge ready: task-x",
			body: "Branch verified for merge.",
			type: "merge_ready",
			priority: "normal",
			payload: JSON.stringify({
				branch: "overstory/builder-x/task-x",
				beadId: "task-x",
				agentName: "builder-x",
				filesModified: ["src/new-module.ts"],
			}),
		});

		// Mark lead as completed
		store.updateState("lead-x", "completed");

		// 6. Orchestrator processes merge_ready → enqueue + merge
		const orchInbox = mail.check("orchestrator");
		expect(orchInbox.some((m) => m.type === "merge_ready")).toBe(true);

		const queue = createMergeQueue(queueDbPath);
		queue.enqueue({
			branchName: "overstory/builder-x/task-x",
			beadId: "task-x",
			agentName: "builder-x",
			filesModified: ["src/new-module.ts"],
		});

		const toMerge = queue.peek();
		expect(toMerge).not.toBeNull();
		const mergeBranch = toMerge?.branchName ?? "";
		queue.updateStatus(mergeBranch, "merging");

		const resolver = createMergeResolver({
			aiResolveEnabled: false,
			reimagineEnabled: false,
		});
		const mergeResult = await resolver.resolve(toMerge as MergeEntry, baseBranch, tempDir);
		expect(mergeResult.success).toBe(true);
		expect(mergeResult.tier).toBe("clean-merge");

		queue.updateStatus(mergeBranch, "merged", "clean-merge");

		// 7. Send merged confirmation
		mail.send({
			from: "orchestrator",
			to: "lead-x",
			subject: "Merged: task-x",
			body: "Clean merge successful.",
			type: "merged",
			priority: "normal",
		});

		// 8. Complete run
		runStore.completeRun(runId, "completed");

		// Verify final state
		const finalRun = runStore.getRun(runId);
		expect(finalRun?.status).toBe("completed");
		expect(finalRun?.agentCount).toBe(2);

		const allSessions = store.getAll();
		const builderSession = allSessions.find((s) => s.agentName === "builder-x");
		const leadSession = allSessions.find((s) => s.agentName === "lead-x");
		expect(builderSession?.state).toBe("completed");
		expect(leadSession?.state).toBe("completed");

		// Verify merged file exists on canonical
		const mergedContent = await Bun.file(join(tempDir, "src/new-module.ts")).text();
		expect(mergedContent).toContain("greet");

		store.close();
		mail.close();
		queue.close();
		runStore.close();
	});
});
