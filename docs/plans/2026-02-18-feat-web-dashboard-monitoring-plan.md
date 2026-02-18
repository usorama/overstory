---
title: "feat: Web Dashboard for Agent Fleet Monitoring"
type: feat
date: 2026-02-18
issue: "#3"
brainstorm: docs/brainstorms/2026-02-18-web-dashboard-brainstorm.md
version: 1.0
---

# feat: Web Dashboard for Agent Fleet Monitoring

## Overview

Add `overstory web` command that launches a read-only web dashboard for monitoring agent fleet status. Uses `Bun.serve()` (built-in, zero deps) with inline HTML/CSS/JS and Server-Sent Events (SSE) for real-time updates. Provides the same monitoring capabilities as the CLI TUI dashboard but accessible from any browser.

## Problem Statement / Motivation

The CLI TUI dashboard (`overstory dashboard`) only works in the terminal where overstory is running. Users need:
- **Remote monitoring**: View agent status from a browser/phone when away from terminal
- **Richer visualization**: Timelines, cost charts, and merge queue views that benefit from HTML/CSS rendering over ANSI art

## Proposed Solution

### Architecture

```
overstory web [--port 8420] [--host 127.0.0.1]
    │
    ├── Bun.serve() HTTP server
    │     ├── GET /              → Serves inline HTML SPA
    │     ├── GET /api/status    → Agent sessions + tmux state
    │     ├── GET /api/events    → Event timeline (paginated)
    │     ├── GET /api/mail      → Recent mail messages
    │     ├── GET /api/merge     → Merge queue entries
    │     ├── GET /api/costs     → Token/cost metrics
    │     ├── GET /api/config    → Project config (sanitized)
    │     └── GET /events        → SSE stream (real-time updates)
    │
    └── Reads from existing SQLite DBs (read-only)
          ├── sessions.db  (SessionStore)
          ├── events.db    (EventStore)
          ├── mail.db      (MailStore)
          ├── merge-queue.db (MergeQueue)
          └── metrics.db   (MetricsStore)
```

### New Files

| File | Purpose |
|------|---------|
| `src/commands/web-dashboard.ts` | Command handler: arg parsing, Bun.serve() setup, API routes |
| `src/commands/web-dashboard.test.ts` | Tests for API response shapes, SSE format, arg parsing |

### Modified Files

| File | Change |
|------|--------|
| `src/index.ts` | Add "web" to COMMANDS array, import + route to `webDashboardCommand` |
| `src/commands/completions.ts` | Add "web" to completions COMMANDS array |

### Implementation Phases

#### Phase 1: HTTP Server + JSON API (Core)

**Files:** `src/commands/web-dashboard.ts`, `src/index.ts`, `src/commands/completions.ts`

1. Create command handler with arg parsing (`--port`, `--host`, `--json`)
2. Set up `Bun.serve()` with route matching
3. Implement JSON API endpoints reusing existing store APIs:
   - `/api/status` → `gatherStatus()` from `src/commands/status.ts`
   - `/api/events` → `eventStore.getTimeline()` with query params for filtering
   - `/api/mail` → `mailStore.getAll()` with optional filters
   - `/api/merge` → `mergeQueue.list()`
   - `/api/costs` → `metricsStore.getRecentSessions()`
   - `/api/config` → Load and sanitize config (strip sensitive paths)
4. SSE endpoint at `/events` that polls stores every 2s and pushes deltas

**Data loading pattern** (from `dashboard.ts`):
```typescript
// Reuse gatherStatus() and store APIs
// All DB access wrapped in try/catch (databases are optional)
const status = await gatherStatus(root, "orchestrator", false);
const mailStore = createMailStore(mailDbPath);
const recentMail = mailStore.getAll().slice(0, limit);
```

#### Phase 2: HTML Frontend (Single Inline Page)

**Embedded in `src/commands/web-dashboard.ts`** as a template string.

Panels (matching TUI dashboard layout):
1. **Fleet Overview**: Agent count by state (booting/working/completed/stalled), active run info
2. **Agent Grid**: Card per agent with name, capability, state, last activity, duration
3. **Event Timeline**: Chronological event stream with auto-scroll
4. **Merge Queue**: Pending/merging/merged entries with tier info
5. **Cost Summary**: Total tokens, estimated cost, per-agent breakdown
6. **Recent Mail**: Last 10 messages with type badges

**Frontend approach:**
- Vanilla JS (no framework) — fetch JSON APIs, update DOM
- CSS Grid for layout, CSS variables for theming
- `EventSource` API for SSE connection
- Auto-reconnect on SSE disconnect
- Responsive: works on mobile (stacked panels)

#### Phase 3: Tests

**File:** `src/commands/web-dashboard.test.ts`

Test strategy (following project philosophy — real implementations over mocks):
- Test API response shapes using real SQLite databases in temp dirs
- Test SSE event format parsing
- Test arg parsing (port, host flags)
- Test graceful shutdown on SIGINT
- Do NOT test HTML rendering (too brittle, visual only)

## Technical Considerations

### Zero-Deps Constraint
- `Bun.serve()` is a built-in API — no HTTP framework needed
- SSE uses standard HTTP streaming — no WebSocket library needed
- HTML/CSS/JS is inline in the TypeScript file — no bundler needed

### Security
- Default bind to `127.0.0.1` (localhost only) — safe for local use
- `--host 0.0.0.0` flag for network access (user's explicit choice)
- No authentication in MVP (same trust model as CLI access)
- Config endpoint sanitizes sensitive paths

### Performance
- SQLite reads are fast (~1-5ms per query with WAL mode)
- SSE polling interval: 2000ms (same as TUI dashboard)
- No caching needed for MVP (DB reads are cheap)

### Graceful Shutdown
- SIGINT handler stops the server
- Close all DB connections
- Print "Dashboard stopped" message

## Acceptance Criteria

- [x] `overstory web` starts HTTP server on port 8420 (configurable via `--port`)
- [x] `overstory web --host 0.0.0.0` binds to all interfaces
- [x] Browser at `http://localhost:8420` shows agent fleet overview
- [x] Dashboard auto-updates via SSE (no manual refresh needed)
- [x] All 6 API endpoints return valid JSON matching store data
- [x] `Ctrl+C` cleanly stops the server
- [x] Zero new runtime dependencies (only Bun built-ins)
- [x] All tests pass, lint clean, typecheck clean
- [x] Works when some DBs don't exist yet (graceful degradation)

## Dependencies & Risks

| Risk | Mitigation |
|------|------------|
| Inline HTML gets large/unmaintainable | Keep it minimal — data tables, not fancy charts. Refactor to separate file if > 500 lines |
| SSE connection drops | Auto-reconnect in frontend JS with exponential backoff |
| Port conflict | Clear error message if port in use, suggest `--port` flag |
| DB locked by other agents | WAL mode + busy_timeout already handles concurrent access |

## References

- Brainstorm: `docs/brainstorms/2026-02-18-web-dashboard-brainstorm.md`
- TUI dashboard pattern: `src/commands/dashboard.ts` (data loading, polling loop)
- Status data model: `src/commands/status.ts` (gatherStatus, StatusData)
- Command registration: `src/index.ts` (COMMANDS array, switch routing)
- Bun.serve() API: Built-in to Bun runtime
- Issue #9: Remote chat interface (future extension of this work)
