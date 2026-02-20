---
title: "Meta-Coordinator: OpenClaw + Overstory Multi-Product Fleet Management"
version: 1.0.0
status: approved
created: 2026-02-20
authors: [umasankr, claude]
github_issue: "usorama/overstory#12"
prototype: true
---

# Meta-Coordinator: OpenClaw + Overstory Multi-Product Fleet Management

## Problem

Overstory operates within a single project boundary. A coordinator at depth 0 orchestrates leads and specialists within one repository. There is no mechanism for coordinating work across multiple products — each with different work types (code, marketing, support) and resource requirements.

Real-world needs:
- **Product A**: Feature development lifecycle (plan → build → QA → integrate)
- **Product B**: Architecture refactoring
- **Product C**: Daily marketing operations (emails, social media content)
- **Product D**: Customer feedback triage, support request handling

These products need a single point of control that can reason about priorities, schedule work within resource constraints, and report progress to humans on their preferred channel.

## Solution

Use **OpenClaw** as the meta-coordination layer (depth -1) that wraps **overstory** as its execution engine.

### Role Separation

| System | Role |
|--------|------|
| **OpenClaw** | Human interface (Slack/Discord), resource-aware scheduler, thinking agent with full reasoning/self-evolution capabilities |
| **Overstory** | Execution engine for ALL work types — code, marketing, support — via configurable agent definitions and capability routing |

### Critical Design Principle

The meta-coordinator is **not a dumb dispatcher**. It is a full OpenClaw Pi agent with complete reasoning, planning, and self-improvement capabilities. It:

- Reads product codebases, docs, and history before deciding how to act
- Reasons about complexity, dependencies, risks, and phasing
- Monitors execution and intervenes when things go wrong
- Learns from outcomes and adjusts strategies over time
- Can propose improvements to overstory's own workflows

OpenClaw's built-in abilities to think, reason, and self-evolve are preserved. These abilities enable it to enhance overstory and think through actual project execution work.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  HUMAN (Slack / Discord / WhatsApp)                      │
└──────────────────────┬───────────────────────────────────┘
                       │ messages
                       ▼
┌──────────────────────────────────────────────────────────┐
│  OPENCLAW GATEWAY (always-on Node.js daemon)             │
│  ws://localhost:41789 | UI: http://localhost:41790        │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Meta-Coordinator Agent (Pi runtime)               │  │
│  │                                                    │  │
│  │  THINKS:   Full Claude reasoning, planning,        │  │
│  │            analysis, self-correction, learning      │  │
│  │                                                    │  │
│  │  KNOWS:    Product registry, priorities, resource   │  │
│  │            state, historical outcomes               │  │
│  │                                                    │  │
│  │  ACTS VIA: overstory CLI, OpenClaw skills,         │  │
│  │            channel messaging, direct file I/O       │  │
│  │                                                    │  │
│  │  EVOLVES:  Records patterns via mulch/memory,      │  │
│  │            adjusts scheduling, proposes workflow    │  │
│  │            improvements to overstory               │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  Communication: subprocess calls to overstory CLI        │
│  via docker exec into overstory-runtime container        │
└───────┬──────────┬──────────┬──────────┬─────────────────┘
        │          │          │          │
        ▼          ▼          ▼          ▼
   ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐
   │Product A│ │Product B│ │Product C│ │Product D│
   │(code)   │ │(refactor)│ │(mktg)  │ │(support)│
   │.overstory│ │.overstory│ │.overstory│ │.overstory│
   └─────────┘ └─────────┘ └─────────┘ └─────────┘
   Each: own coordinator, agents, DBs, worktrees
```

### Hierarchy

```
Meta-Coordinator (depth -1, OpenClaw Pi agent)
  ├── Overstory Coordinator (depth 0, per product)
  │     ├── Lead (depth 1)
  │     │     ├── Builder (depth 2)
  │     │     ├── Scout (depth 2)
  │     │     └── Reviewer (depth 2)
  │     └── Lead (depth 1)
  │           └── Marketing Agent (depth 2)  ← new capability
  ├── Overstory Coordinator (depth 0, another product)
  │     └── ...
  └── Direct OpenClaw actions (no overstory, for simple tasks)
```

### Why Overstory Handles Non-Code Work

Overstory's agent architecture is capability-agnostic:

1. **Agent definitions are `.md` files** — nothing restricts them to code. A `marketing.md` or `support.md` definition is valid.
2. **The overlay system is task-generic** — assigns task ID, spec, file scope, capability string. Adding `marketing` as a capability is config + definition.
3. **Agents have Bash access** — can invoke any CLI tool, MCP server, or API.
4. **Quality gates are per-definition** — a marketing agent's gates differ from a builder's (spell check vs type check).
5. **File scope isn't limited to code** — can be `content/blog/`, `marketing/emails/`, etc.

## Product Registry

```yaml
# products.yaml (OpenClaw workspace config)
products:
  - name: product-a
    path: /projects/product-a
    type: code
    overstory: true
    priority: high
    resource_weight: 3
    channels:
      - slack:#product-a-dev

  - name: product-b
    path: /projects/product-b
    type: code
    overstory: true
    priority: medium
    resource_weight: 3
    channels:
      - slack:#product-b-dev

  - name: product-c
    path: /projects/product-c
    type: marketing
    overstory: true
    priority: medium
    resource_weight: 1
    channels:
      - slack:#marketing

  - name: product-d
    path: /projects/product-d
    type: support
    overstory: true
    priority: medium
    resource_weight: 1
    channels:
      - slack:#support

scheduling:
  max_concurrent_sessions: 2
  strategy: priority-weighted
  resource_budget:
    max_cpu_percent: 60
    max_memory_gb: 12
```

Products are pre-initialized with `.overstory/` (always-on config). The meta-coordinator starts/stops coordinators in already-initialized projects.

## Scheduling

The meta-coordinator **reasons** about scheduling — it is not a fixed algorithm:

1. Check resource budget (CPU, memory, active sessions)
2. Pick highest-priority product with pending work
3. Spawn `overstory coordinator start` in that product's repo
4. Monitor via `overstory status --json` polling
5. When session completes or resources free up, schedule next

It can make judgment calls: "Product B's refactor is blocked waiting for review. Let me start Product C's marketing run while we wait."

## Communication Flow

### Inbound (human → system)

- "Ship auth feature for Product A" → meta-coordinator reasons → spawns overstory session
- "What's the status across all products?" → polls all active sessions → aggregated report to Slack
- "Pause Product B, focus on Product A" → adjusts priority, pauses B's coordinator

### Outbound (system → human)

- Overstory agents complete work → coordinator reports via mail → meta-coordinator reads mail via `overstory mail check --json` → reports to Slack
- HIL gates (plan approval) → meta-coordinator surfaces plan on Slack → human approves → meta-coordinator resumes

### Between containers

- Container 1 (OpenClaw) calls `docker exec overstory-runtime overstory <command>`
- Polling: OpenClaw periodically runs `overstory status --json` to track progress

## Prototype Strategy

### Approach

- Disposable git worktree (never merged)
- Two OrbStack containers
- Test with fake products
- Discard if it doesn't work; fall back to enhancing overstory natively with Slack webhook

### Container Setup

```
OrbStack (local)
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  Container 1: openclaw-meta                                 │
│    Node.js 22 + OpenClaw Gateway + Pi Agent Runtime         │
│    Gateway WS:  ws://localhost:41789                         │
│    WebChat UI:  http://localhost:41790                        │
│    Volume: ~/Projects/ (read access)                        │
│                                                             │
│  Container 2: overstory-runtime                             │
│    Bun + overstory CLI + git + tmux                         │
│    Volume: ~/Projects/ (read-write)                         │
│    Accessible via docker exec from Container 1              │
│                                                             │
│  Shared: ~/Projects/ mounted into both                      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Directory Structure

```
overstory-meta-prototype/              # git worktree, never merged
├── docker-compose.yaml                # Two-container setup
├── containers/
│   ├── openclaw/
│   │   ├── Dockerfile                 # Node 22 + OpenClaw + config
│   │   ├── config.yaml                # Gateway config (port 41789)
│   │   ├── products.yaml              # Product registry
│   │   └── skills/
│   │       └── overstory/             # Custom skill: overstory bridge
│   │           ├── manifest.json
│   │           └── index.ts           # Wraps overstory CLI calls
│   └── overstory/
│       ├── Dockerfile                 # Bun + overstory + git + tmux
│       └── entrypoint.sh             # Starts SSH or exec daemon
├── test-products/
│   ├── product-a/                     # Fake code project with .overstory/
│   └── product-c/                     # Fake marketing project with .overstory/
└── docs/
    └── prototype-notes.md             # What worked, what didn't
```

### Milestones

| # | Milestone | Exit Criteria |
|---|-----------|---------------|
| 1 | Containers boot | OpenClaw UI accessible at `http://localhost:41790` |
| 2 | CLI bridge works | Meta-coordinator can call `overstory status --json` in overstory container |
| 3 | Status query | Send via WebChat: "check status of all products" → aggregated response |
| 4 | Spawn session | Send: "run a scout on product-a" → overstory session spawns → result reported back |
| 5 | Resource scheduling | Start two products, observe queueing at capacity |

### Go / No-Go

- **Milestones 1-4 pass** → proceed to real design doc and merge-worthy implementation
- **Fundamental blockers** → discard worktree, enhance overstory natively with Slack webhook for notifications

## Tech Stack

| Component | Stack | Notes |
|-----------|-------|-------|
| OpenClaw Gateway | Node.js 22, TypeScript, pnpm | Upstream unchanged |
| OpenClaw Pi Agent | Node.js 22, TypeScript | Full reasoning capabilities |
| Overstory | Bun, TypeScript, zero npm deps | Upstream unchanged |
| Containers | OrbStack (Docker-compatible) | Two containers, shared volumes |
| Communication | `docker exec` + JSON polling | Simple, no custom protocol needed |
| Ports | `41789` (Gateway WS), `41790` (WebChat UI) | Uncommon, avoids conflicts |

## Open Questions (to resolve during prototype)

1. **Latency**: How fast is `docker exec` for frequent `overstory status --json` polling? Is there a better IPC mechanism?
2. **tmux in containers**: Does tmux work reliably inside OrbStack containers? (overstory agents need tmux sessions)
3. **Volume performance**: Read-write mounts from OrbStack into containers — any performance issues with SQLite WAL mode?
4. **OpenClaw skill API**: How complex is writing a custom skill that wraps overstory CLI? What's the skill manifest format?
5. **Claude API key routing**: Both OpenClaw and overstory need Claude API access. Shared key or separate?
6. **Session persistence**: If the openclaw-meta container restarts, does it recover knowledge of running overstory sessions?

## Related

- GitHub issue: [usorama/overstory#12](https://github.com/usorama/overstory/issues/12)
- Planning tier design: `docs/plans/2026-02-18-planning-tier-design.md` (HIL gates critical for cross-product work)
- Sandbox strategy: [jayminwest/overstory#3](https://github.com/jayminwest/overstory/issues/3) (container isolation aligns with this prototype)
