---
title: "Planning Tier: HIL Gates, Research Phase, and Complexity Classification"
version: 1.0.0
date: 2026-02-18
status: approved
scope: brownfield
related:
  - "usorama/overstory#11 (greenfield — scoped out, tracked separately)"
---

# Planning Tier Design

## Problem Statement

Overstory's implementation pipeline (build → review → merge) is solid, but the **planning and research phase is missing**. Three gaps:

1. **No human-in-the-loop gates** — human fires and forgets. No approval checkpoints for plans, specs, or merges. For complex tasks, this means 20+ agents can spin up executing a bad plan.
2. **No external knowledge lookup** — agents have mulch (internal expertise) and codebase grep, but no instructions to use context7, web search, or framework docs when stuck or when specs require current information.
3. **No pre-launch planning stage** — the coordinator decomposes on the fly with no plan artifact, no review, and no way to iterate on the approach before committing agent resources.

## Scope

**In scope (brownfield):** Complexity classification, research-enhanced scouts, plan-mode leads, HIL approval gates, plan artifacts, revision loops — all for tasks on existing codebases.

**Out of scope (greenfield):** PRD generation, master plan templates, multi-phase planning for new projects from scratch. Tracked in usorama/overstory#11.

## Design

### Complexity Classification

The coordinator classifies every objective before dispatching, using an LLM rubric in `coordinator.md`:

```
COMPLEX (requires planning phase) if ANY:
- Touches 3+ modules or subsystems
- Involves APIs/libraries not in mulch
- Keywords: refactor, migrate, redesign, new feature, architecture, integrate
- Cross-cutting: auth, DB schema, API contracts, config format changes
- Human flagged with [COMPLEX] prefix in objective

SIMPLE (direct dispatch) if ALL:
- Touches 1-2 files in one module
- Uses only known patterns (in mulch)
- Keywords: fix, bump, typo, update, add
- No external API/library research needed
- Human did NOT flag [COMPLEX]

When uncertain, default to COMPLEX.
```

Human override: prefix objective with `[COMPLEX]` or `[SIMPLE]`.

### Enhanced Scouts (Research Capabilities)

Scouts gain external research tools while remaining read-only:

- **context7**: `resolve-library-id` → `query-docs` for library documentation
- **WebSearch**: Best practices, migration guides, API docs
- **WebFetch**: Read specific documentation pages
- **CURRENT_DATE**: Injected in overlay so web searches use current year

New workflow step between "load expertise" and "explore":

> 3.5. **Research external dependencies** — when the task references external APIs, libraries, or frameworks not covered by mulch, query context7 and web search with CURRENT_DATE for current information. Prefix external findings with `RESEARCH:` in result mail (distinct from `INSIGHT:` for codebase findings). Include version numbers and doc URLs for traceability.

### Lead Plan Mode

Leads gain a modal workflow controlled by `--mode plan|execute` on sling:

**Plan mode:**

1. Phase 1 — Scout: spawn scouts with research capabilities
2. Phase 2 — Plan: synthesize scout findings into a plan file at `.overstory/plans/<task-id>.md`
3. Phase 3 — Stop: send `plan_ready` mail to coordinator. Do NOT spawn builders.

**Execute mode:** (existing flow, with one addition)

- If a plan file exists at `.overstory/plans/<task-id>.md`, read it as the basis for decomposition. The plan was human-approved.
- Scout phase can be skipped if the plan already contains sufficient codebase analysis.

**Plan revision loop:**

When the coordinator sends a revision dispatch (human feedback), the lead:
1. Reads the existing plan file
2. Reads the feedback from coordinator mail
3. Updates the plan **in place** (same file, not a new artifact)
4. Adds entry to the revision log section at the bottom of the plan
5. Sends `plan_ready` again

This ensures the plan file is always the single source of truth for what was approved.

**Spec context cascade:**

When writing specs for builders/reviewers in execute mode, leads must include relevant strategic context discovered during planning: codebase conventions, architectural patterns, key constraints, design rationale. This ensures builders make tradeoff decisions informed by the plan, not just technical correctness.

### HIL Gate (Coordinator)

The coordinator's own Claude Code session IS the approval interface. No extra CLI commands needed.

Flow:
1. Coordinator receives `plan_ready` mail from lead(s)
2. Coordinator reads plan file(s) from `.overstory/plans/`
3. Coordinator presents plan summary in-session:
   - Plan file path
   - Key decisions and tradeoffs
   - Risk areas
   - Estimated builder count
4. Coordinator waits for human response (normal conversation turn)
5. Human responds:
   - **"approve"** → coordinator dispatches execute-mode leads
   - **"reject: reason"** → coordinator reports, stops
   - **Specific feedback** → coordinator sends revision dispatch to lead, loop back to step 1

### Plan Artifacts

```
.overstory/plans/
  <task-id>.md         # One plan per task, updated in place on revisions
```

- Created by plan-mode leads (not the coordinator — coordinator has no write access)
- Git-committed, not gitignored — they're decision documentation
- Include a revision log section tracking what changed and why
- `.overstory/plans/` directory created by `overstory init` with `.gitkeep`

### Config

```yaml
planning:
  enabled: true          # false = skip planning phase entirely
  defaultMode: auto      # auto = use rubric | simple = always skip | complex = always plan
  plansTracked: true     # true = plans are git-committed, not gitignored
```

Three knobs. The complexity rubric lives in the coordinator prompt, not in config.

## Changes by File

### Agent definitions (prompt-only changes)

| File | Change |
|------|--------|
| `agents/scout.md` | Add context7, WebSearch, WebFetch to capabilities. Add step 3.5 for external research. Add `RESEARCH:` prefix. Add `CURRENT_DATE` awareness. |
| `agents/lead.md` | Add plan mode vs execute mode workflow. Add revision support. Add spec context cascade instructions. New failure modes: `PLAN_MODE_BUILD`, `EXECUTE_WITHOUT_PLAN`. |
| `agents/coordinator.md` | Add Complexity Classification rubric. Add planning phase workflow (steps 2.5-2.7). Add HIL gate instructions. New failure modes: `SKIP_CLASSIFICATION`, `COMPLEX_WITHOUT_PLAN`, `PLAN_WITHOUT_WAIT`. New mail type: `plan_ready`. |

### Code changes

| File | Change |
|------|--------|
| `src/types.ts` | Add `mode: "plan" \| "execute"` to `OverlayConfig`. Add `currentDate: string` and `existingPlan: string \| undefined` to `OverlayConfig`. Add `plan_ready` to `ProtocolMessageType`. |
| `src/agents/overlay.ts` | Generate `{{LEAD_MODE}}`, `{{CURRENT_DATE}}`, `{{EXISTING_PLAN}}` replacements. Format plan-mode instructions vs execute-mode. |
| `templates/overlay.md.tmpl` | Add `{{LEAD_MODE}}`, `{{CURRENT_DATE}}`, `{{EXISTING_PLAN}}` placeholder sections. |
| `src/commands/sling.ts` | Parse `--mode plan\|execute` flag (default: `execute`). Pass to overlay config. |
| `src/commands/init.ts` | Create `.overstory/plans/` directory with `.gitkeep`. Add `planning:` section to generated `config.yaml`. |
| `src/config.ts` | Add `planning` to config schema: `{ enabled: boolean, defaultMode: "auto" \| "simple" \| "complex", plansTracked: boolean }`. Defaults: `{ enabled: true, defaultMode: "auto", plansTracked: true }`. |

### What does NOT change

- Builder, reviewer, merger, monitor, supervisor agent definitions
- Build → review → merge pipeline
- Mail system (one new protocol type only)
- Session/event/metrics stores
- Watchdog/monitor
- All simple tasks (zero overhead added)

## Flow Diagram

```
Human: "Refactor the auth module to use JWT"
  │
  Coordinator: classifies COMPLEX (cross-cutting, external API)
  │
  ├─ PLAN PHASE
  │   Coordinator spawns lead --mode plan --depth 1
  │   │
  │   Lead spawns research-capable scout(s)
  │   │  Scout explores codebase (existing auth patterns)
  │   │  Scout researches JWT best practices (context7 + web)
  │   │  Scout reports: INSIGHT: + RESEARCH: lines
  │   │
  │   Lead writes .overstory/plans/<task-id>.md
  │   Lead sends plan_ready → coordinator
  │   │
  │   Coordinator presents plan summary to human
  │   Human: "Approve, but use RS256 not HS256"
  │   │
  │   Coordinator sends revision dispatch to lead
  │   Lead updates plan in place → plan_ready
  │   Coordinator presents updated plan
  │   Human: "Approve"
  │
  ├─ EXECUTE PHASE (existing flow, unchanged)
  │   Coordinator spawns lead --mode execute --depth 1
  │   Lead reads approved plan from .overstory/plans/
  │   Lead writes specs with strategic context from plan
  │   Lead spawns scouts → builders → reviewers
  │   Build → review → merge (as today)
  │
  └─ Done
```

## Risks

- **Plan-mode leads add latency** — one full scout → lead round-trip before any building starts. Mitigated: only for COMPLEX tasks. Simple tasks have zero overhead.
- **Two lead spawns per complex task** — plan-mode lead + execute-mode lead. Plan-mode leads are cheaper (read-only + one file write). Could optimize by keeping the same lead across modes in a future iteration.
- **Coordinator context window** — reading multiple plan files for presentation. Mitigated: plan files should be concise (target <2000 words).
- **Revision loops could stall** — human doesn't respond. Mitigated by design: coordinator blocks (no auto-approve). This is intentional for complex tasks — better to wait than to build the wrong thing.

## Testing Strategy

- Unit tests for new overlay variables (`overlay.ts`)
- Unit tests for `--mode` flag parsing (`sling.ts`)
- Unit tests for `planning` config parsing (`config.ts`)
- Integration test: plan-mode lead produces plan file and sends `plan_ready`
- Integration test: coordinator classifies complexity from objective text
- Manual test: full complex-task flow with HIL gate
