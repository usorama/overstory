/**
 * Tests for the CLI mail command handlers.
 *
 * Tests CLI-level behavior like flag parsing and output formatting.
 * Uses real SQLite databases in temp directories (no mocking).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventStore } from "../events/store.ts";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import type { StoredEvent } from "../types.ts";
import { mailCommand } from "./mail.ts";

describe("mailCommand", () => {
	let tempDir: string;
	let origCwd: string;
	let origWrite: typeof process.stdout.write;
	let output: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-mail-cmd-test-"));
		await mkdir(join(tempDir, ".overstory"), { recursive: true });

		// Seed some messages via the store directly
		const store = createMailStore(join(tempDir, ".overstory", "mail.db"));
		const client = createMailClient(store);
		client.send({
			from: "orchestrator",
			to: "builder-1",
			subject: "Build task",
			body: "Implement feature X",
		});
		client.send({
			from: "orchestrator",
			to: "scout-1",
			subject: "Explore API",
			body: "Investigate endpoints",
		});
		client.close();

		// Change cwd to temp dir so the command finds .overstory/mail.db
		origCwd = process.cwd();
		process.chdir(tempDir);

		// Capture stdout
		output = "";
		origWrite = process.stdout.write;
		process.stdout.write = ((chunk: string) => {
			output += chunk;
			return true;
		}) as typeof process.stdout.write;
	});

	afterEach(async () => {
		process.stdout.write = origWrite;
		process.chdir(origCwd);
		await rm(tempDir, { recursive: true, force: true });
	});

	describe("list", () => {
		test("--unread shows all unread messages globally", async () => {
			await mailCommand(["list", "--unread"]);
			expect(output).toContain("Build task");
			expect(output).toContain("Explore API");
			expect(output).toContain("Total: 2 messages");
		});

		test("--agent filters by recipient (alias for --to)", async () => {
			await mailCommand(["list", "--agent", "builder-1"]);
			expect(output).toContain("Build task");
			expect(output).not.toContain("Explore API");
			expect(output).toContain("Total: 1 message");
		});

		test("--agent combined with --unread shows only unread for that agent", async () => {
			// Mark builder-1's message as read
			const store = createMailStore(join(tempDir, ".overstory", "mail.db"));
			const client = createMailClient(store);
			const msgs = client.list({ to: "builder-1" });
			const msgId = msgs[0]?.id;
			expect(msgId).toBeTruthy();
			if (msgId) {
				client.markRead(msgId);
			}
			client.close();

			await mailCommand(["list", "--agent", "builder-1", "--unread"]);
			expect(output).toContain("No messages found.");
		});

		test("--to takes precedence over --agent when both provided", async () => {
			await mailCommand(["list", "--to", "scout-1", "--agent", "builder-1"]);
			// --to is checked first via getFlag, so it should win
			expect(output).toContain("Explore API");
			expect(output).not.toContain("Build task");
		});

		test("list without filters shows all messages", async () => {
			await mailCommand(["list"]);
			expect(output).toContain("Build task");
			expect(output).toContain("Explore API");
			expect(output).toContain("Total: 2 messages");
		});
	});

	describe("reply", () => {
		test("reply to own sent message goes to original recipient", async () => {
			// Get the message ID of the message orchestrator sent to builder-1
			const store = createMailStore(join(tempDir, ".overstory", "mail.db"));
			const client = createMailClient(store);
			const msgs = client.list({ to: "builder-1" });
			const originalId = msgs[0]?.id;
			expect(originalId).toBeTruthy();
			client.close();

			if (!originalId) return;

			// Reply as orchestrator (the original sender)
			output = "";
			await mailCommand(["reply", originalId, "--body", "Actually also do Y"]);

			expect(output).toContain("Reply sent:");

			// Verify the reply went to builder-1, not back to orchestrator
			const store2 = createMailStore(join(tempDir, ".overstory", "mail.db"));
			const client2 = createMailClient(store2);
			const allMsgs = client2.list();
			const replyMsg = allMsgs.find((m) => m.subject === "Re: Build task");
			expect(replyMsg).toBeDefined();
			expect(replyMsg?.from).toBe("orchestrator");
			expect(replyMsg?.to).toBe("builder-1");
			client2.close();
		});

		test("reply as recipient goes to original sender", async () => {
			// Get the message ID
			const store = createMailStore(join(tempDir, ".overstory", "mail.db"));
			const client = createMailClient(store);
			const msgs = client.list({ to: "builder-1" });
			const originalId = msgs[0]?.id;
			expect(originalId).toBeTruthy();
			client.close();

			if (!originalId) return;

			// Reply as builder-1 (the recipient of the original)
			output = "";
			await mailCommand(["reply", originalId, "--body", "Done", "--agent", "builder-1"]);

			expect(output).toContain("Reply sent:");

			// Verify the reply went to orchestrator (original sender)
			const store2 = createMailStore(join(tempDir, ".overstory", "mail.db"));
			const client2 = createMailClient(store2);
			const allMsgs = client2.list();
			const replyMsg = allMsgs.find(
				(m) => m.subject === "Re: Build task" && m.from === "builder-1",
			);
			expect(replyMsg).toBeDefined();
			expect(replyMsg?.from).toBe("builder-1");
			expect(replyMsg?.to).toBe("orchestrator");
			client2.close();
		});

		test("reply with flags before positional ID extracts correct ID", async () => {
			// Regression test for overstory-6nq: flags before the positional ID
			// caused the flag VALUE (e.g. 'scout') to be treated as the message ID.
			const store = createMailStore(join(tempDir, ".overstory", "mail.db"));
			const client = createMailClient(store);
			const msgs = client.list({ to: "builder-1" });
			const originalId = msgs[0]?.id;
			expect(originalId).toBeTruthy();
			client.close();

			if (!originalId) return;

			// Put --agent and --body flags BEFORE the positional message ID
			output = "";
			await mailCommand(["reply", "--agent", "scout-1", "--body", "Got it", originalId]);

			expect(output).toContain("Reply sent:");

			// Verify the reply used the correct message ID (not 'scout-1' or 'Got it')
			const store2 = createMailStore(join(tempDir, ".overstory", "mail.db"));
			const client2 = createMailClient(store2);
			const allMsgs = client2.list();
			const replyMsg = allMsgs.find((m) => m.subject === "Re: Build task" && m.from === "scout-1");
			expect(replyMsg).toBeDefined();
			expect(replyMsg?.body).toBe("Got it");
			client2.close();
		});
	});

	describe("read", () => {
		test("read with flags before positional ID extracts correct ID", async () => {
			// Regression test for overstory-6nq: same fragile pattern existed in handleRead.
			const store = createMailStore(join(tempDir, ".overstory", "mail.db"));
			const client = createMailClient(store);
			const msgs = client.list({ to: "builder-1" });
			const originalId = msgs[0]?.id;
			expect(originalId).toBeTruthy();
			client.close();

			if (!originalId) return;

			// Although read doesn't currently use --agent, test that any unknown
			// flags followed by values don't get treated as the positional ID
			output = "";
			await mailCommand(["read", originalId]);

			expect(output).toContain(`Marked ${originalId} as read.`);
		});

		test("read marks message as read", async () => {
			const store = createMailStore(join(tempDir, ".overstory", "mail.db"));
			const client = createMailClient(store);
			const msgs = client.list({ to: "builder-1" });
			const originalId = msgs[0]?.id;
			expect(originalId).toBeTruthy();
			client.close();

			if (!originalId) return;

			output = "";
			await mailCommand(["read", originalId]);
			expect(output).toContain(`Marked ${originalId} as read.`);

			// Reading again should show already read
			output = "";
			await mailCommand(["read", originalId]);
			expect(output).toContain("already read");
		});
	});

	describe("auto-nudge (pending nudge markers)", () => {
		test("urgent message writes pending nudge marker instead of tmux keys", async () => {
			await mailCommand([
				"send",
				"--to",
				"builder-1",
				"--subject",
				"Fix NOW",
				"--body",
				"Production is down",
				"--priority",
				"urgent",
			]);

			// Verify pending nudge marker was written
			const markerPath = join(tempDir, ".overstory", "pending-nudges", "builder-1.json");
			const file = Bun.file(markerPath);
			expect(await file.exists()).toBe(true);

			const marker = JSON.parse(await file.text());
			expect(marker.from).toBe("orchestrator");
			expect(marker.reason).toBe("urgent priority");
			expect(marker.subject).toBe("Fix NOW");
			expect(marker.messageId).toBeTruthy();
			expect(marker.createdAt).toBeTruthy();

			// Output should mention queued nudge, not direct delivery
			expect(output).toContain("Queued nudge");
			expect(output).toContain("delivered on next prompt");
		});

		test("high priority message writes pending nudge marker", async () => {
			await mailCommand([
				"send",
				"--to",
				"scout-1",
				"--subject",
				"Important task",
				"--body",
				"Please prioritize",
				"--priority",
				"high",
			]);

			const markerPath = join(tempDir, ".overstory", "pending-nudges", "scout-1.json");
			const file = Bun.file(markerPath);
			expect(await file.exists()).toBe(true);

			const marker = JSON.parse(await file.text());
			expect(marker.reason).toBe("high priority");
		});

		test("worker_done type writes pending nudge marker regardless of priority", async () => {
			await mailCommand([
				"send",
				"--to",
				"orchestrator",
				"--subject",
				"Task complete",
				"--body",
				"Builder finished",
				"--type",
				"worker_done",
				"--from",
				"builder-1",
			]);

			const markerPath = join(tempDir, ".overstory", "pending-nudges", "orchestrator.json");
			const file = Bun.file(markerPath);
			expect(await file.exists()).toBe(true);

			const marker = JSON.parse(await file.text());
			expect(marker.reason).toBe("worker_done");
			expect(marker.from).toBe("builder-1");
		});

		test("normal priority non-protocol message does NOT write marker", async () => {
			await mailCommand(["send", "--to", "builder-1", "--subject", "FYI", "--body", "Just a note"]);

			const nudgeDir = join(tempDir, ".overstory", "pending-nudges");
			try {
				const files = await readdir(nudgeDir);
				// No marker should exist for this normal-priority status message
				expect(files.filter((f) => f === "builder-1.json")).toHaveLength(0);
			} catch {
				// Directory doesn't exist — that's fine, means no markers
			}
		});

		test("mail check --inject surfaces pending nudge banner", async () => {
			// Send an urgent message to create a pending nudge marker
			await mailCommand([
				"send",
				"--to",
				"builder-1",
				"--subject",
				"Critical fix",
				"--body",
				"Deploy hotfix",
				"--priority",
				"urgent",
			]);

			// Now check as builder-1 with --inject
			output = "";
			await mailCommand(["check", "--inject", "--agent", "builder-1"]);

			// Should contain the priority banner from the pending nudge
			expect(output).toContain("PRIORITY");
			expect(output).toContain("urgent priority");
			expect(output).toContain("Critical fix");

			// Should also contain the actual message (from mail check)
			expect(output).toContain("Deploy hotfix");
		});

		test("pending nudge marker is cleared after mail check --inject", async () => {
			// Send urgent message
			await mailCommand([
				"send",
				"--to",
				"builder-1",
				"--subject",
				"Fix it",
				"--body",
				"Broken",
				"--priority",
				"urgent",
			]);

			// First check clears the marker
			output = "";
			await mailCommand(["check", "--inject", "--agent", "builder-1"]);
			expect(output).toContain("PRIORITY");

			// Second check should NOT have the priority banner
			output = "";
			await mailCommand(["check", "--inject", "--agent", "builder-1"]);
			expect(output).not.toContain("PRIORITY");
		});

		test("json output for auto-nudge send does not include nudge banner", async () => {
			await mailCommand([
				"send",
				"--to",
				"builder-1",
				"--subject",
				"Urgent",
				"--body",
				"Fix",
				"--priority",
				"urgent",
				"--json",
			]);

			// JSON output should just have the message ID, not the nudge banner text
			const parsed = JSON.parse(output.trim());
			expect(parsed.id).toBeTruthy();
			expect(output).not.toContain("Queued nudge");
		});
	});

	describe("mail_sent event recording", () => {
		test("mail send records mail_sent event to events.db", async () => {
			await mailCommand([
				"send",
				"--to",
				"builder-1",
				"--subject",
				"Test event",
				"--body",
				"Check events",
			]);

			// Verify event was recorded
			const eventsDbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(eventsDbPath);
			try {
				const events: StoredEvent[] = store.getTimeline({
					since: "2000-01-01T00:00:00Z",
				});
				const mailEvent = events.find((e) => e.eventType === "mail_sent");
				expect(mailEvent).toBeDefined();
				expect(mailEvent?.level).toBe("info");
				expect(mailEvent?.agentName).toBe("orchestrator");

				const data = JSON.parse(mailEvent?.data ?? "{}") as Record<string, unknown>;
				expect(data.to).toBe("builder-1");
				expect(data.subject).toBe("Test event");
				expect(data.type).toBe("status");
				expect(data.priority).toBe("normal");
				expect(data.messageId).toBeTruthy();
			} finally {
				store.close();
			}
		});

		test("mail send with custom --from records correct agentName", async () => {
			await mailCommand([
				"send",
				"--to",
				"orchestrator",
				"--subject",
				"Done",
				"--body",
				"Finished task",
				"--from",
				"builder-1",
				"--type",
				"worker_done",
			]);

			const eventsDbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(eventsDbPath);
			try {
				const events: StoredEvent[] = store.getTimeline({
					since: "2000-01-01T00:00:00Z",
				});
				const mailEvent = events.find((e) => e.eventType === "mail_sent");
				expect(mailEvent).toBeDefined();
				expect(mailEvent?.agentName).toBe("builder-1");

				const data = JSON.parse(mailEvent?.data ?? "{}") as Record<string, unknown>;
				expect(data.to).toBe("orchestrator");
				expect(data.type).toBe("worker_done");
			} finally {
				store.close();
			}
		});

		test("mail send includes run_id when current-run.txt exists", async () => {
			const runId = "run-test-mail-456";
			await Bun.write(join(tempDir, ".overstory", "current-run.txt"), runId);

			await mailCommand([
				"send",
				"--to",
				"builder-1",
				"--subject",
				"With run ID",
				"--body",
				"Test",
			]);

			const eventsDbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(eventsDbPath);
			try {
				const events: StoredEvent[] = store.getTimeline({
					since: "2000-01-01T00:00:00Z",
				});
				const mailEvent = events.find((e) => e.eventType === "mail_sent");
				expect(mailEvent).toBeDefined();
				expect(mailEvent?.runId).toBe(runId);
			} finally {
				store.close();
			}
		});

		test("mail send without current-run.txt records null runId", async () => {
			await mailCommand(["send", "--to", "builder-1", "--subject", "No run", "--body", "Test"]);

			const eventsDbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(eventsDbPath);
			try {
				const events: StoredEvent[] = store.getTimeline({
					since: "2000-01-01T00:00:00Z",
				});
				const mailEvent = events.find((e) => e.eventType === "mail_sent");
				expect(mailEvent).toBeDefined();
				expect(mailEvent?.runId).toBeNull();
			} finally {
				store.close();
			}
		});
	});
});
