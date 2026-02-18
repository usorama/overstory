/**
 * CLI command: overstory web [--port N] [--host 0.0.0.0] [--json]
 *
 * Read-only web dashboard for monitoring agent fleet status.
 * Uses Bun.serve() (built-in, zero deps) with inline HTML/CSS/JS.
 * SSE streams real-time status, events, mail, merge, and cost updates.
 * Config is fetched via REST API only (no live updates).
 */

import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { createMailStore } from "../mail/store.ts";
import { createMergeQueue } from "../merge/queue.ts";
import { createMetricsStore } from "../metrics/store.ts";
import type {
	MailMessage,
	MergeEntry,
	OverstoryConfig,
	SessionMetrics,
	StoredEvent,
} from "../types.ts";
import { gatherStatus, type StatusData } from "./status.ts";

const DEFAULT_PORT = 8420;
const DEFAULT_HOST = "127.0.0.1";
const SSE_POLL_INTERVAL_MS = 2000;

function getFlag(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx === -1 || idx + 1 >= args.length) {
		return undefined;
	}
	return args[idx + 1];
}

function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

// ─── Data Loading ────────────────────────────────────────────────────────────

interface SanitizedConfig {
	projectName: string;
	canonicalBranch: string;
	maxConcurrent: number;
	maxDepth: number;
	beadsEnabled: boolean;
	mulchEnabled: boolean;
	mergeAiResolve: boolean;
	watchdogTier0: boolean;
	watchdogTier1: boolean;
	watchdogTier2: boolean;
}

interface WebDashboardData {
	status: StatusData;
	events: StoredEvent[];
	mail: MailMessage[];
	mergeQueue: MergeEntry[];
	costs: SessionMetrics[];
	config: SanitizedConfig | null;
}

function sanitizeConfig(loaded: OverstoryConfig): SanitizedConfig {
	return {
		projectName: loaded.project.name,
		canonicalBranch: loaded.project.canonicalBranch,
		maxConcurrent: loaded.agents.maxConcurrent,
		maxDepth: loaded.agents.maxDepth,
		beadsEnabled: loaded.beads.enabled,
		mulchEnabled: loaded.mulch.enabled,
		mergeAiResolve: loaded.merge.aiResolveEnabled,
		watchdogTier0: loaded.watchdog.tier0Enabled,
		watchdogTier1: loaded.watchdog.tier1Enabled,
		watchdogTier2: loaded.watchdog.tier2Enabled,
	};
}

async function loadWebDashboardData(
	root: string,
	eventLimit = 50,
	mailLimit = 10,
	costLimit = 20,
): Promise<WebDashboardData> {
	const overstoryDir = join(root, ".overstory");

	let status: StatusData = {
		agents: [],
		worktrees: [],
		tmuxSessions: [],
		unreadMailCount: 0,
		mergeQueueCount: 0,
		recentMetricsCount: 0,
	};
	try {
		status = await gatherStatus(root, "orchestrator", false);
	} catch (err: unknown) {
		console.error(
			`[web-dashboard] Failed to load status: ${err instanceof Error ? err.message : err}`,
		);
	}

	let events: StoredEvent[] = [];
	try {
		const eventsDbPath = join(overstoryDir, "events.db");
		if (await Bun.file(eventsDbPath).exists()) {
			const store = createEventStore(eventsDbPath);
			try {
				const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
				events = store.getTimeline({ since, limit: eventLimit });
			} finally {
				store.close();
			}
		}
	} catch (err: unknown) {
		console.error(
			`[web-dashboard] Failed to load events: ${err instanceof Error ? err.message : err}`,
		);
	}

	let mail: MailMessage[] = [];
	try {
		const mailDbPath = join(overstoryDir, "mail.db");
		if (await Bun.file(mailDbPath).exists()) {
			const mailStore = createMailStore(mailDbPath);
			try {
				mail = mailStore.getAll().slice(0, mailLimit);
			} finally {
				mailStore.close();
			}
		}
	} catch (err: unknown) {
		console.error(
			`[web-dashboard] Failed to load mail: ${err instanceof Error ? err.message : err}`,
		);
	}

	let mergeQueue: MergeEntry[] = [];
	try {
		const queuePath = join(overstoryDir, "merge-queue.db");
		if (await Bun.file(queuePath).exists()) {
			const queue = createMergeQueue(queuePath);
			try {
				mergeQueue = queue.list();
			} finally {
				queue.close();
			}
		}
	} catch (err: unknown) {
		console.error(
			`[web-dashboard] Failed to load merge queue: ${err instanceof Error ? err.message : err}`,
		);
	}

	let costs: SessionMetrics[] = [];
	try {
		const metricsDbPath = join(overstoryDir, "metrics.db");
		if (await Bun.file(metricsDbPath).exists()) {
			const metricsStore = createMetricsStore(metricsDbPath);
			try {
				costs = metricsStore.getRecentSessions(costLimit);
			} finally {
				metricsStore.close();
			}
		}
	} catch (err: unknown) {
		console.error(
			`[web-dashboard] Failed to load metrics: ${err instanceof Error ? err.message : err}`,
		);
	}

	let config: SanitizedConfig | null = null;
	try {
		const loaded = await loadConfig(root);
		config = sanitizeConfig(loaded);
	} catch (err: unknown) {
		console.error(
			`[web-dashboard] Failed to load config: ${err instanceof Error ? err.message : err}`,
		);
	}

	return { status, events, mail, mergeQueue, costs, config };
}

// ─── API Route Handlers ──────────────────────────────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

async function handleApiStatus(root: string): Promise<Response> {
	try {
		const status = await gatherStatus(root, "orchestrator", true);
		return jsonResponse(status);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[web-dashboard] /api/status failed: ${msg}`);
		return jsonResponse({ error: "Failed to load status", detail: msg }, 500);
	}
}

async function handleApiEvents(root: string, url: URL): Promise<Response> {
	const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
	const limit = Number.isNaN(rawLimit) || rawLimit < 1 ? 50 : Math.min(rawLimit, 1000);
	const since = url.searchParams.get("since") ?? undefined;
	const agent = url.searchParams.get("agent") ?? undefined;

	const overstoryDir = join(root, ".overstory");
	const eventsDbPath = join(overstoryDir, "events.db");

	if (!(await Bun.file(eventsDbPath).exists())) {
		return jsonResponse([]);
	}

	try {
		const store = createEventStore(eventsDbPath);
		try {
			let events: StoredEvent[];
			if (agent) {
				events = store.getByAgent(agent, { limit, since });
			} else {
				const sinceTs = since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
				events = store.getTimeline({ since: sinceTs, limit });
			}
			return jsonResponse(events);
		} finally {
			store.close();
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[web-dashboard] /api/events failed: ${msg}`);
		return jsonResponse({ error: "Failed to load events", detail: msg }, 500);
	}
}

async function handleApiMail(root: string, url: URL): Promise<Response> {
	const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
	const limit = Number.isNaN(rawLimit) || rawLimit < 1 ? 20 : Math.min(rawLimit, 1000);
	const from = url.searchParams.get("from") ?? undefined;
	const to = url.searchParams.get("to") ?? undefined;

	const overstoryDir = join(root, ".overstory");
	const mailDbPath = join(overstoryDir, "mail.db");

	if (!(await Bun.file(mailDbPath).exists())) {
		return jsonResponse([]);
	}

	try {
		const mailStore = createMailStore(mailDbPath);
		try {
			const messages = mailStore.getAll({ from, to }).slice(0, limit);
			return jsonResponse(messages);
		} finally {
			mailStore.close();
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[web-dashboard] /api/mail failed: ${msg}`);
		return jsonResponse({ error: "Failed to load mail", detail: msg }, 500);
	}
}

async function handleApiMerge(root: string): Promise<Response> {
	const overstoryDir = join(root, ".overstory");
	const queuePath = join(overstoryDir, "merge-queue.db");

	if (!(await Bun.file(queuePath).exists())) {
		return jsonResponse([]);
	}

	try {
		const queue = createMergeQueue(queuePath);
		try {
			const entries = queue.list();
			return jsonResponse(entries);
		} finally {
			queue.close();
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[web-dashboard] /api/merge failed: ${msg}`);
		return jsonResponse({ error: "Failed to load merge queue", detail: msg }, 500);
	}
}

async function handleApiCosts(root: string, url: URL): Promise<Response> {
	const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
	const limit = Number.isNaN(rawLimit) || rawLimit < 1 ? 20 : Math.min(rawLimit, 1000);

	const overstoryDir = join(root, ".overstory");
	const metricsDbPath = join(overstoryDir, "metrics.db");

	if (!(await Bun.file(metricsDbPath).exists())) {
		return jsonResponse({ sessions: [], totals: { tokens: 0, cost: 0 } });
	}

	try {
		const metricsStore = createMetricsStore(metricsDbPath);
		try {
			const sessions = metricsStore.getRecentSessions(limit);

			let totalTokens = 0;
			let totalCost = 0;
			for (const s of sessions) {
				totalTokens += s.inputTokens + s.outputTokens;
				totalCost += s.estimatedCostUsd ?? 0;
			}

			return jsonResponse({ sessions, totals: { tokens: totalTokens, cost: totalCost } });
		} finally {
			metricsStore.close();
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[web-dashboard] /api/costs failed: ${msg}`);
		return jsonResponse({ error: "Failed to load costs", detail: msg }, 500);
	}
}

async function handleApiConfig(root: string): Promise<Response> {
	try {
		const loaded = await loadConfig(root);
		return jsonResponse(sanitizeConfig(loaded));
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[web-dashboard] /api/config failed: ${msg}`);
		return jsonResponse({ error: "Failed to load config", detail: msg }, 500);
	}
}

// ─── SSE Stream (status, events, mail, merge, costs) ────────────────────────

function handleSSE(root: string): Response {
	let interval: ReturnType<typeof setInterval> | null = null;
	let cancelled = false;

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();

			const sendEvent = (eventType: string, data: unknown) => {
				try {
					const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
					controller.enqueue(encoder.encode(payload));
				} catch (err: unknown) {
					// Stream closed or enqueue failed — stop polling
					if (interval) {
						clearInterval(interval);
						interval = null;
					}
					if (!cancelled) {
						const msg = err instanceof Error ? err.message : String(err);
						console.error(`[web-dashboard] SSE write failed: ${msg}`);
					}
				}
			};

			const poll = async () => {
				try {
					const data = await loadWebDashboardData(root);
					sendEvent("status", data.status);
					sendEvent("events", data.events);
					sendEvent("mail", data.mail);
					sendEvent("merge", data.mergeQueue);
					sendEvent("costs", data.costs);
				} catch (err: unknown) {
					const msg = err instanceof Error ? err.message : String(err);
					console.error(`[web-dashboard] SSE poll failed: ${msg}`);
					sendEvent("error", {
						message: msg,
						timestamp: new Date().toISOString(),
					});
				}
			};

			// Initial push — errors handled inside poll(), catch guards unhandled rejection
			poll().catch((err: unknown) => {
				console.error(
					`[web-dashboard] SSE initial poll failed: ${err instanceof Error ? err.message : err}`,
				);
			});

			interval = setInterval(() => {
				poll().catch((err: unknown) => {
					console.error(
						`[web-dashboard] SSE poll tick failed: ${err instanceof Error ? err.message : err}`,
					);
				});
			}, SSE_POLL_INTERVAL_MS);
		},
		cancel() {
			cancelled = true;
			if (interval) {
				clearInterval(interval);
				interval = null;
			}
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
}

// ─── HTML Frontend ───────────────────────────────────────────────────────────

function generateHTML(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Overstory Dashboard</title>
<style>
:root {
  --bg: #0d1117;
  --surface: #161b22;
  --border: #30363d;
  --text: #c9d1d9;
  --text-dim: #8b949e;
  --accent: #58a6ff;
  --green: #3fb950;
  --yellow: #d29922;
  --red: #f85149;
  --cyan: #79c0ff;
  --purple: #bc8cff;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.5;
}
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
.header h1 { font-size: 16px; font-weight: 600; }
.header h1 span { color: var(--accent); }
.header .status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-dim);
}
.header .dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: var(--green);
}
.header .dot.disconnected { background: var(--red); }
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: auto auto auto;
  gap: 1px;
  background: var(--border);
  min-height: calc(100vh - 45px);
}
.panel {
  background: var(--surface);
  padding: 12px 16px;
}
.panel-title {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-dim);
  margin-bottom: 8px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.panel-title .badge {
  background: var(--border);
  border-radius: 10px;
  padding: 1px 8px;
  font-size: 11px;
  color: var(--text);
}
.fleet-overview { grid-column: 1 / -1; }
.fleet-stats {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
}
.stat {
  text-align: center;
}
.stat .value {
  font-size: 28px;
  font-weight: 700;
  line-height: 1;
}
.stat .label {
  font-size: 11px;
  color: var(--text-dim);
  margin-top: 2px;
}
.stat .value.green { color: var(--green); }
.stat .value.yellow { color: var(--yellow); }
.stat .value.red { color: var(--red); }
.stat .value.cyan { color: var(--cyan); }
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
th {
  text-align: left;
  font-weight: 500;
  color: var(--text-dim);
  padding: 4px 8px 4px 0;
  border-bottom: 1px solid var(--border);
  font-size: 11px;
  text-transform: uppercase;
}
td {
  padding: 4px 8px 4px 0;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
}
tr:last-child td { border-bottom: none; }
.state-badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: 500;
}
.state-working { background: rgba(63,185,80,0.15); color: var(--green); }
.state-booting { background: rgba(210,153,34,0.15); color: var(--yellow); }
.state-stalled { background: rgba(248,81,73,0.15); color: var(--red); }
.state-completed { background: rgba(121,192,255,0.15); color: var(--cyan); }
.state-zombie { background: rgba(139,148,158,0.15); color: var(--text-dim); }
.state-pending { background: rgba(210,153,34,0.15); color: var(--yellow); }
.state-merging { background: rgba(88,166,255,0.15); color: var(--accent); }
.state-merged { background: rgba(63,185,80,0.15); color: var(--green); }
.state-conflict { background: rgba(248,81,73,0.15); color: var(--red); }
.state-failed { background: rgba(248,81,73,0.15); color: var(--red); }
.priority-urgent { color: var(--red); font-weight: 600; }
.priority-high { color: var(--yellow); font-weight: 500; }
.priority-normal { color: var(--text); }
.priority-low { color: var(--text-dim); }
.event-list {
  max-height: 300px;
  overflow-y: auto;
}
.event-item {
  padding: 4px 0;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
  display: flex;
  gap: 8px;
}
.event-item:last-child { border-bottom: none; }
.event-time {
  color: var(--text-dim);
  font-size: 11px;
  white-space: nowrap;
  min-width: 65px;
}
.event-agent {
  color: var(--purple);
  font-weight: 500;
  min-width: 80px;
}
.event-type {
  color: var(--accent);
}
.cost-total {
  font-size: 20px;
  font-weight: 700;
  margin-bottom: 8px;
}
.cost-total span { color: var(--green); }
.empty {
  color: var(--text-dim);
  font-style: italic;
  padding: 8px 0;
  font-size: 13px;
}
@media (max-width: 768px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
</head>
<body>
<div class="header">
  <h1><span>overstory</span> dashboard</h1>
  <div class="status">
    <div class="dot" id="sse-dot"></div>
    <span id="sse-status">connecting...</span>
    <span id="last-update"></span>
  </div>
</div>

<div class="grid">
  <div class="panel fleet-overview" id="fleet-overview">
    <div class="panel-title">Fleet Overview</div>
    <div class="fleet-stats" id="fleet-stats">
      <div class="stat"><div class="value" id="total-agents">0</div><div class="label">Total</div></div>
      <div class="stat"><div class="value green" id="working-count">0</div><div class="label">Working</div></div>
      <div class="stat"><div class="value yellow" id="booting-count">0</div><div class="label">Booting</div></div>
      <div class="stat"><div class="value red" id="stalled-count">0</div><div class="label">Stalled</div></div>
      <div class="stat"><div class="value cyan" id="completed-count">0</div><div class="label">Completed</div></div>
      <div class="stat"><div class="value" id="unread-mail">0</div><div class="label">Unread Mail</div></div>
      <div class="stat"><div class="value" id="merge-pending">0</div><div class="label">Merge Queue</div></div>
    </div>
  </div>

  <div class="panel" id="agent-grid">
    <div class="panel-title">Agents <span class="badge" id="agent-count">0</span></div>
    <div id="agent-table-container"><p class="empty">No agents</p></div>
  </div>

  <div class="panel" id="event-timeline">
    <div class="panel-title">Event Timeline <span class="badge" id="event-count">0</span></div>
    <div class="event-list" id="event-list"><p class="empty">No events</p></div>
  </div>

  <div class="panel" id="merge-queue-panel">
    <div class="panel-title">Merge Queue <span class="badge" id="merge-count">0</span></div>
    <div id="merge-table-container"><p class="empty">No entries</p></div>
  </div>

  <div class="panel" id="cost-panel">
    <div class="panel-title">Cost Summary</div>
    <div id="cost-container"><p class="empty">No metrics</p></div>
  </div>

  <div class="panel" id="mail-panel">
    <div class="panel-title">Recent Mail <span class="badge" id="mail-count">0</span></div>
    <div id="mail-table-container"><p class="empty">No messages</p></div>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);

function esc(s) {
  if (s == null) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return m + "m " + rs + "s";
  const h = Math.floor(m / 60);
  return h + "h " + (m % 60) + "m";
}

function timeAgo(ts) {
  const diff = Date.now() - new Date(ts).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}

function renderStatus(data) {
  const agents = data.agents || [];
  const counts = { working: 0, booting: 0, stalled: 0, completed: 0, zombie: 0 };
  for (const a of agents) counts[a.state] = (counts[a.state] || 0) + 1;

  $("total-agents").textContent = agents.length;
  $("working-count").textContent = counts.working;
  $("booting-count").textContent = counts.booting;
  $("stalled-count").textContent = counts.stalled;
  $("completed-count").textContent = counts.completed;
  $("unread-mail").textContent = data.unreadMailCount || 0;
  $("merge-pending").textContent = data.mergeQueueCount || 0;
  $("agent-count").textContent = agents.length;

  if (agents.length === 0) {
    $("agent-table-container").innerHTML = '<p class="empty">No agents</p>';
    return;
  }

  const now = Date.now();
  let html = '<table><tr><th>Name</th><th>Capability</th><th>State</th><th>Task</th><th>Duration</th></tr>';
  for (const a of agents) {
    const end = (a.state === "completed" || a.state === "zombie") ? new Date(a.lastActivity).getTime() : now;
    const dur = formatDuration(end - new Date(a.startedAt).getTime());
    html += '<tr>';
    html += '<td>' + esc(a.agentName) + '</td>';
    html += '<td>' + esc(a.capability) + '</td>';
    html += '<td><span class="state-badge state-' + esc(a.state) + '">' + esc(a.state) + '</span></td>';
    html += '<td>' + esc(a.beadId || '-') + '</td>';
    html += '<td>' + dur + '</td>';
    html += '</tr>';
  }
  html += '</table>';
  $("agent-table-container").innerHTML = html;
}

function renderEvents(events) {
  $("event-count").textContent = events.length;
  if (!events || events.length === 0) {
    $("event-list").innerHTML = '<p class="empty">No events</p>';
    return;
  }
  let html = '';
  for (const ev of events.slice(0, 50)) {
    html += '<div class="event-item">';
    html += '<span class="event-time">' + timeAgo(ev.createdAt) + '</span>';
    html += '<span class="event-agent">' + esc(ev.agentName) + '</span>';
    html += '<span class="event-type">' + esc(ev.eventType) + '</span>';
    if (ev.toolName) html += '<span>' + esc(ev.toolName) + '</span>';
    html += '</div>';
  }
  $("event-list").innerHTML = html;
}

function renderMail(messages) {
  $("mail-count").textContent = messages.length;
  if (messages.length === 0) {
    $("mail-table-container").innerHTML = '<p class="empty">No messages</p>';
    return;
  }
  let html = '<table><tr><th>From</th><th>To</th><th>Subject</th><th>Type</th><th>Time</th></tr>';
  for (const m of messages) {
    html += '<tr>';
    html += '<td>' + esc(m.from) + '</td>';
    html += '<td>' + esc(m.to) + '</td>';
    html += '<td class="priority-' + esc(m.priority) + '">' + esc(m.subject) + '</td>';
    html += '<td><span class="state-badge state-' + (m.type === "error" ? "stalled" : "working") + '">' + esc(m.type) + '</span></td>';
    html += '<td>' + timeAgo(m.createdAt) + '</td>';
    html += '</tr>';
  }
  html += '</table>';
  $("mail-table-container").innerHTML = html;
}

function renderMerge(entries) {
  $("merge-count").textContent = entries.length;
  if (entries.length === 0) {
    $("merge-table-container").innerHTML = '<p class="empty">No entries</p>';
    return;
  }
  let html = '<table><tr><th>Branch</th><th>Agent</th><th>Status</th><th>Tier</th></tr>';
  for (const e of entries) {
    html += '<tr>';
    html += '<td>' + esc(e.branchName) + '</td>';
    html += '<td>' + esc(e.agentName) + '</td>';
    html += '<td><span class="state-badge state-' + esc(e.status) + '">' + esc(e.status) + '</span></td>';
    html += '<td>' + esc(e.resolvedTier || '-') + '</td>';
    html += '</tr>';
  }
  html += '</table>';
  $("merge-table-container").innerHTML = html;
}

function renderCosts(data) {
  if (!data || !data.sessions || data.sessions.length === 0) {
    $("cost-container").innerHTML = '<p class="empty">No metrics</p>';
    return;
  }
  const totals = data.totals || { tokens: 0, cost: 0 };
  let html = '<div class="cost-total">$<span>' + totals.cost.toFixed(4) + '</span> (' + totals.tokens.toLocaleString() + ' tokens)</div>';
  html += '<table><tr><th>Agent</th><th>Capability</th><th>Tokens</th><th>Cost</th><th>Duration</th></tr>';
  for (const s of data.sessions.slice(0, 10)) {
    const tokens = s.inputTokens + s.outputTokens;
    html += '<tr>';
    html += '<td>' + esc(s.agentName) + '</td>';
    html += '<td>' + esc(s.capability) + '</td>';
    html += '<td>' + tokens.toLocaleString() + '</td>';
    html += '<td>$' + (s.estimatedCostUsd || 0).toFixed(4) + '</td>';
    html += '<td>' + formatDuration(s.durationMs) + '</td>';
    html += '</tr>';
  }
  html += '</table>';
  $("cost-container").innerHTML = html;
}

// SSE connection with auto-reconnect
let es = null;
let reconnectTimer = null;
let reconnectDelay = 1000;

function connectSSE() {
  if (es) { es.close(); }
  es = new EventSource("/events");

  es.onopen = () => {
    $("sse-dot").className = "dot";
    $("sse-status").textContent = "connected";
    reconnectDelay = 1000;
  };

  es.addEventListener("status", (e) => {
    try {
      renderStatus(JSON.parse(e.data));
      $("last-update").textContent = new Date().toLocaleTimeString();
    } catch (err) { console.error("[dashboard] status SSE parse error:", err); }
  });

  es.addEventListener("mail", (e) => {
    try { renderMail(JSON.parse(e.data)); }
    catch (err) { console.error("[dashboard] mail SSE parse error:", err); }
  });

  es.addEventListener("merge", (e) => {
    try { renderMerge(JSON.parse(e.data)); }
    catch (err) { console.error("[dashboard] merge SSE parse error:", err); }
  });

  es.addEventListener("events", (e) => {
    try { renderEvents(JSON.parse(e.data)); }
    catch (err) { console.error("[dashboard] events SSE parse error:", err); }
  });

  es.addEventListener("costs", (e) => {
    try { renderCosts(JSON.parse(e.data)); }
    catch (err) { console.error("[dashboard] costs SSE parse error:", err); }
  });

  es.onerror = () => {
    $("sse-dot").className = "dot disconnected";
    $("sse-status").textContent = "reconnecting...";
    es.close();
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      connectSSE();
    }, reconnectDelay);
  };
}

// Initial data load via fetch, then connect SSE
async function init() {
  try {
    const [statusRes, eventsRes, mailRes, mergeRes, costsRes] = await Promise.all([
      fetch("/api/status"),
      fetch("/api/events"),
      fetch("/api/mail"),
      fetch("/api/merge"),
      fetch("/api/costs"),
    ]);
    if (statusRes.ok) renderStatus(await statusRes.json());
    if (eventsRes.ok) renderEvents(await eventsRes.json());
    if (mailRes.ok) renderMail(await mailRes.json());
    if (mergeRes.ok) renderMerge(await mergeRes.json());
    if (costsRes.ok) renderCosts(await costsRes.json());
  } catch (err) {
    console.error("Initial fetch failed:", err);
  }
  connectSSE();
}

init();
</script>
</body>
</html>`;
}

// ─── Server Setup ────────────────────────────────────────────────────────────

export interface WebDashboardOptions {
	port: number;
	host: string;
	root: string;
}

export function createServer(opts: WebDashboardOptions): ReturnType<typeof Bun.serve> {
	const { port, host, root } = opts;
	const html = generateHTML();

	const server = Bun.serve({
		port,
		hostname: host,
		fetch(req) {
			const url = new URL(req.url);
			const path = url.pathname;

			if (path === "/" || path === "/index.html") {
				return new Response(html, {
					headers: { "Content-Type": "text/html; charset=utf-8" },
				});
			}

			if (path === "/api/status") return handleApiStatus(root);
			if (path === "/api/events") return handleApiEvents(root, url);
			if (path === "/api/mail") return handleApiMail(root, url);
			if (path === "/api/merge") return handleApiMerge(root);
			if (path === "/api/costs") return handleApiCosts(root, url);
			if (path === "/api/config") return handleApiConfig(root);
			if (path === "/events") return handleSSE(root);

			return new Response("Not found", { status: 404 });
		},
		error(err) {
			console.error(`[web-dashboard] Unhandled server error: ${err.message}`);
			return new Response(JSON.stringify({ error: err.message }), {
				status: 500,
				headers: { "Content-Type": "application/json" },
			});
		},
	});

	return server;
}

// ─── CLI Entry Point ─────────────────────────────────────────────────────────

const WEB_HELP = `overstory web — Web dashboard for agent fleet monitoring

Usage: overstory web [--port N] [--host HOST] [--json]

Options:
  --port <N>       Port to listen on (default: ${DEFAULT_PORT})
  --host <HOST>    Host to bind to (default: ${DEFAULT_HOST})
                   Use 0.0.0.0 for network access
  --json           Output server info as JSON (no interactive output)
  --help, -h       Show this help

The dashboard provides:
  - Fleet overview with agent counts by state
  - Per-agent status grid with duration and task info
  - Event timeline with real-time updates
  - Merge queue status
  - Token/cost summary
  - Recent mail messages

Press Ctrl+C to stop the server.`;

export async function webDashboardCommand(args: string[]): Promise<void> {
	if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
		process.stdout.write(`${WEB_HELP}\n`);
		return;
	}

	const portStr = getFlag(args, "--port");
	const port = portStr ? Number.parseInt(portStr, 10) : DEFAULT_PORT;
	const host = getFlag(args, "--host") ?? DEFAULT_HOST;
	const json = hasFlag(args, "--json");

	if (Number.isNaN(port) || port < 1 || port > 65535) {
		throw new ValidationError("--port must be a number between 1 and 65535", {
			field: "port",
			value: portStr,
		});
	}

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const root = config.project.root;

	const server = createServer({ port, host, root });

	if (json) {
		process.stdout.write(`${JSON.stringify({ url: `http://${host}:${port}`, port, host })}\n`);
	} else {
		process.stdout.write(`\noverstory web dashboard\n`);
		process.stdout.write(`${"─".repeat(40)}\n`);
		process.stdout.write(`  URL:  http://${host}:${port}\n`);
		process.stdout.write(`  Host: ${host}\n`);
		process.stdout.write(`  Port: ${port}\n`);
		process.stdout.write(`${"─".repeat(40)}\n`);
		process.stdout.write(`Press Ctrl+C to stop.\n\n`);
	}

	const shutdown = () => {
		server.stop();
		process.stdout.write("\nDashboard stopped.\n");
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	// Bun.serve() does not block; await a never-resolving promise to keep alive until SIGINT
	await new Promise(() => {});
}
