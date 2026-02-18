---
title: Web Dashboard for Agent Fleet Monitoring
issue: "#3"
date: 2026-02-18
status: brainstormed
version: 1.0
---

# Web Dashboard for Agent Fleet Monitoring

## What We're Building

A web-based dashboard served by `overstory web` command using Bun's built-in `Bun.serve()`. Provides remote monitoring and richer visualization of agent fleet status, complementing the existing CLI TUI tools.

## Why This Approach

- **Zero runtime deps**: `Bun.serve()` is a built-in API, no HTTP framework needed
- **SSE for real-time**: Server-Sent Events work in all browsers without WebSocket libraries
- **Single-page inline HTML**: No build step, no bundler, no framework — one HTML string with inline CSS/JS
- **Read-only from existing DBs**: All 6 SQLite databases already have query APIs in the codebase

## Key Decisions

1. **Approach**: Bun.serve() + static HTML with inline CSS/JS + SSE for real-time updates
2. **Command**: `overstory web [--port N] [--host 0.0.0.0]`
3. **Scope**: Read-only monitoring MVP. No interactive control (that's Issue #9)
4. **Data sources**: sessions.db, mail.db, events.db, metrics.db, merge-queue.db, config.yaml
5. **Views**: Fleet overview, per-agent detail, event timeline, cost breakdown, merge queue status

## Use Cases Addressed

- **Remote monitoring**: View agent status from browser/phone when not in terminal
- **Richer visualization**: Graphs for costs over time, timeline views, merge queue status

## Open Questions

- Authentication for remote access? (if exposed on network)
- Should the web server auto-start with coordinator, or be a separate command?
- Chart rendering: inline SVG vs canvas vs ASCII-art-in-HTML?

## Related

- Issue #9: Remote chat interface for orchestrator agents (extends this into interactive control)
