# Meta-Coordinator Prototype Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a disposable prototype with two OrbStack containers (OpenClaw + overstory) to validate the meta-coordinator concept — OpenClaw as a thinking agent that dispatches and monitors overstory sessions across multiple products.

**Architecture:** OpenClaw Gateway (Node.js 22) runs in Container 1 with a custom "overstory" skill. It calls `docker exec` into Container 2 (Bun + overstory + git + tmux) to spawn and monitor overstory sessions. Products are pre-initialized fake repos with `.overstory/` in a shared named volume.

**Tech Stack:** Node.js 22 / pnpm (OpenClaw), Bun (overstory), OrbStack (containers), SQLite WAL (overstory DBs in bun-agent only), Docker socket mount (inter-container exec).

**Critical constraint:** SQLite WAL mode does not work safely across container boundaries. All overstory SQLite DBs live inside the bun-agent container only. The orchestrator container accesses data via `docker exec` CLI calls, never by opening `.db` files directly.

---

## Task 1: Create Prototype Worktree

**Files:**
- Create: worktree at `.overstory/worktrees/meta-prototype` (or a standalone directory)

**Step 1: Create the prototype directory**

```bash
mkdir -p /Users/umasankr/Projects/useful-repos/overstory/prototype
```

This is a standalone directory within the repo, gitignored. NOT a git worktree (we're prototyping infrastructure, not code changes to overstory itself).

**Step 2: Add prototype to .gitignore**

Append to the repo root `.gitignore`:
```
prototype/
```

**Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: gitignore prototype directory"
```

---

## Task 2: Create Bun Agent Container (Container 2)

**Files:**
- Create: `prototype/containers/overstory/Dockerfile`
- Create: `prototype/containers/overstory/entrypoint.sh`

**Step 1: Write the Dockerfile**

```dockerfile
# prototype/containers/overstory/Dockerfile
FROM oven/bun:1-debian

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      git \
      tmux \
      curl \
      procps \
      sqlite3 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Git config for agent operations
RUN git config --system init.defaultBranch main && \
    git config --system user.email "agent@overstory.local" && \
    git config --system user.name "Overstory Agent" && \
    git config --system commit.gpgsign false

WORKDIR /workspace

# Copy overstory source (built from repo root)
COPY overstory/ /opt/overstory/

# Make overstory CLI available
RUN ln -s /opt/overstory/src/index.ts /usr/local/bin/overstory-cli

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

CMD ["/entrypoint.sh"]
```

**Step 2: Write the entrypoint**

```bash
#!/bin/bash
# prototype/containers/overstory/entrypoint.sh
# Keep container alive for docker exec access
echo "overstory-runtime ready. Workspace: /workspace"
echo "Bun version: $(bun --version)"
echo "Git version: $(git --version)"
echo "Tmux version: $(tmux -V)"

# Initialize test products if they don't exist
for product in product-a product-c; do
  if [ ! -d "/workspace/$product/.overstory" ]; then
    echo "Initializing $product..."
    mkdir -p "/workspace/$product"
    cd "/workspace/$product"
    git init
    git commit --allow-empty -m "init"
    bun run /opt/overstory/src/index.ts init
    cd /workspace
  fi
done

echo "All products initialized. Waiting for commands..."
exec sleep infinity
```

**Step 3: Verify Dockerfile syntax**

```bash
cd /Users/umasankr/Projects/useful-repos/overstory/prototype
docker build -f containers/overstory/Dockerfile --check .
```

Expected: No syntax errors.

**Step 4: Commit**

```bash
git add prototype/containers/overstory/
git commit -m "proto: bun-agent container with overstory + git + tmux"
```

---

## Task 3: Create OpenClaw Container (Container 1)

**Files:**
- Create: `prototype/containers/openclaw/Dockerfile`
- Create: `prototype/containers/openclaw/openclaw.json`
- Create: `prototype/containers/openclaw/products.yaml`

**Step 1: Write the Dockerfile**

```dockerfile
# prototype/containers/openclaw/Dockerfile
FROM node:22-bookworm-slim

# Install Docker CLI (for docker exec into bun-agent)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      gnupg \
      git \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | \
       gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
       https://download.docker.com/linux/debian bookworm stable" > \
       /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Enable pnpm
RUN corepack enable

WORKDIR /app

# Clone and build OpenClaw
RUN git clone --depth 1 https://github.com/openclaw/openclaw.git /app \
    && pnpm install --frozen-lockfile \
    && pnpm build \
    && pnpm ui:build

# Copy config and skill files
COPY openclaw.json /root/.openclaw/openclaw.json
COPY products.yaml /root/.openclaw/products.yaml
COPY skills/ /root/.openclaw/workspace/skills/

EXPOSE 41789

HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD curl -f http://localhost:41789/health || exit 1

CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
```

**Step 2: Write the OpenClaw config**

```json
// prototype/containers/openclaw/openclaw.json
{
  "gateway": {
    "port": 41789,
    "bind": "lan",
    "auth": {
      "mode": "none"
    },
    "controlUi": {
      "enabled": true
    }
  },
  "agents": {
    "defaults": {
      "model": "claude-sonnet-4-6",
      "thinking": "medium"
    },
    "list": [
      {
        "id": "meta-coordinator",
        "name": "Meta-Coordinator",
        "tools": {
          "exec": {
            "allowShell": true,
            "allowedPaths": ["/workspace", "/root/.openclaw"]
          },
          "browser": {
            "mode": "off"
          }
        }
      }
    ]
  },
  "env": {
    "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}",
    "BUN_AGENT_CONTAINER": "overstory-runtime"
  }
}
```

**Step 3: Write the product registry**

```yaml
# prototype/containers/openclaw/products.yaml
products:
  - name: product-a
    path: /workspace/product-a
    type: code
    overstory: true
    priority: high
    resource_weight: 3
    description: "Sample code project for testing feature development"

  - name: product-c
    path: /workspace/product-c
    type: marketing
    overstory: true
    priority: medium
    resource_weight: 1
    description: "Sample marketing project for testing content generation"

scheduling:
  max_concurrent_sessions: 2
  strategy: priority-weighted
  resource_budget:
    max_cpu_percent: 60
    max_memory_gb: 12
```

**Step 4: Commit**

```bash
git add prototype/containers/openclaw/
git commit -m "proto: openclaw-meta container with gateway config + product registry"
```

---

## Task 4: Create Overstory Skill for OpenClaw

**Files:**
- Create: `prototype/containers/openclaw/skills/overstory/SKILL.md`

**Step 1: Write the skill manifest**

The skill tells the meta-coordinator agent HOW to use overstory. It's injected into the agent's system prompt by OpenClaw's skill loader.

```markdown
---
name: overstory
description: "Multi-agent orchestration for code and content projects. Use this skill to manage product fleets via overstory CLI."
metadata:
  openclaw:
    emoji: "🌳"
    requires:
      bins: ["docker"]
---

# Overstory Fleet Management Skill

You are a meta-coordinator managing a fleet of products. Each product has its own overstory instance running in the `overstory-runtime` container.

## How to Execute Overstory Commands

All overstory commands run inside the `overstory-runtime` container via docker exec:

\`\`\`bash
docker exec overstory-runtime bash -c "cd /workspace/<product-name> && bun run /opt/overstory/src/index.ts <command>"
\`\`\`

### Common Commands

**Check status of a product:**
\`\`\`bash
docker exec overstory-runtime bash -c "cd /workspace/product-a && bun run /opt/overstory/src/index.ts status --json"
\`\`\`

**Spawn a coordinator for a product:**
\`\`\`bash
docker exec overstory-runtime bash -c "cd /workspace/product-a && bun run /opt/overstory/src/index.ts coordinator start --no-attach"
\`\`\`

**Check mail across a product:**
\`\`\`bash
docker exec overstory-runtime bash -c "cd /workspace/product-a && bun run /opt/overstory/src/index.ts mail list --json"
\`\`\`

**Spawn a specific agent:**
\`\`\`bash
docker exec overstory-runtime bash -c "cd /workspace/product-a && bun run /opt/overstory/src/index.ts sling <task-id> --capability <type> --name <name>"
\`\`\`

**Check all active agents:**
\`\`\`bash
docker exec overstory-runtime bash -c "cd /workspace/product-a && bun run /opt/overstory/src/index.ts status --json --verbose"
\`\`\`

## Product Registry

Read the product registry at `/root/.openclaw/products.yaml` to know which products exist, their types, priorities, and paths.

## Scheduling Rules

1. Check system resources before spawning new sessions
2. Never exceed `max_concurrent_sessions` (from products.yaml)
3. Higher priority products get scheduled first
4. If a session is blocked (waiting for human approval), schedule the next product
5. Report progress to the human on the current channel

## Status Aggregation

When asked for fleet status, query ALL products and present a unified view:

1. For each product in the registry, run `overstory status --json`
2. Aggregate: active agents, pending work, completed tasks, blockers
3. Present a concise summary with per-product breakdown

## Thinking Protocol

You are a THINKING agent. Before dispatching work:
1. Read the product's codebase and recent history
2. Reason about complexity, dependencies, and risks
3. Decide on phasing (scout first? direct build? plan mode?)
4. Monitor execution and intervene if needed
5. Learn from outcomes for future sessions
```

**Step 2: Commit**

```bash
git add prototype/containers/openclaw/skills/
git commit -m "proto: overstory skill for openclaw meta-coordinator agent"
```

---

## Task 5: Write docker-compose.yaml

**Files:**
- Create: `prototype/docker-compose.yaml`

**Step 1: Write the compose file**

```yaml
# prototype/docker-compose.yaml
# Meta-Coordinator Prototype: OpenClaw + Overstory
# Usage: cd prototype && docker compose up --build

services:
  openclaw-meta:
    build:
      context: .
      dockerfile: containers/openclaw/Dockerfile
    container_name: openclaw-meta
    ports:
      - "41789:41789"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - workspace:/workspace
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - BUN_AGENT_CONTAINER=overstory-runtime
    depends_on:
      overstory-runtime:
        condition: service_started
    networks:
      - meta-net
    restart: unless-stopped

  overstory-runtime:
    build:
      context: ..
      dockerfile: prototype/containers/overstory/Dockerfile
    container_name: overstory-runtime
    volumes:
      - workspace:/workspace
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
    stdin_open: true
    tty: true
    networks:
      - meta-net
    restart: unless-stopped

volumes:
  workspace:
    driver: local

networks:
  meta-net:
    driver: bridge
```

**Step 2: Create a .env template**

```bash
# prototype/.env.example
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

**Step 3: Verify compose syntax**

```bash
cd /Users/umasankr/Projects/useful-repos/overstory/prototype
docker compose config --quiet
```

Expected: No errors.

**Step 4: Commit**

```bash
git add prototype/docker-compose.yaml prototype/.env.example
git commit -m "proto: docker-compose with two containers + shared volume"
```

---

## Task 6: Build and Boot Containers (Milestone 1)

**Step 1: Create .env file with real API key**

```bash
cd /Users/umasankr/Projects/useful-repos/overstory/prototype
cp .env.example .env
# Edit .env with real ANTHROPIC_API_KEY
```

**Step 2: Build both containers**

```bash
cd /Users/umasankr/Projects/useful-repos/overstory/prototype
docker compose build
```

Expected: Both images build successfully.

**Step 3: Start both containers**

```bash
docker compose up -d
```

Expected: Both containers start, `docker compose ps` shows both as `running`.

**Step 4: Verify OpenClaw UI is accessible**

```bash
curl -s http://localhost:41789/ | head -20
```

Expected: HTML response (Control UI page).

Also open in browser: `http://localhost:41789`

**Step 5: Verify overstory-runtime is alive**

```bash
docker exec overstory-runtime bun --version
docker exec overstory-runtime bun run /opt/overstory/src/index.ts --help
```

Expected: Bun version number, then overstory help text.

**Step 6: Verify test products initialized**

```bash
docker exec overstory-runtime ls /workspace/product-a/.overstory/
docker exec overstory-runtime ls /workspace/product-c/.overstory/
```

Expected: Both show `config.yaml`, `agent-manifest.json`, etc.

**Milestone 1 complete:** Containers boot, OpenClaw UI accessible.

---

## Task 7: Test CLI Bridge (Milestone 2)

**Step 1: Test docker exec from openclaw-meta into overstory-runtime**

```bash
docker exec openclaw-meta docker exec overstory-runtime bun --version
```

Expected: Bun version number. This proves Container 1 can exec into Container 2.

**Step 2: Test overstory status from openclaw-meta**

```bash
docker exec openclaw-meta docker exec overstory-runtime bash -c \
  "cd /workspace/product-a && bun run /opt/overstory/src/index.ts status --json"
```

Expected: JSON output showing product-a status (no active agents).

**Step 3: Test product-c status**

```bash
docker exec openclaw-meta docker exec overstory-runtime bash -c \
  "cd /workspace/product-c && bun run /opt/overstory/src/index.ts status --json"
```

Expected: JSON output showing product-c status.

**Milestone 2 complete:** Meta-coordinator can call overstory CLI in the runtime container.

---

## Task 8: Test WebChat Interaction (Milestone 3)

**Step 1: Open WebChat in browser**

Navigate to `http://localhost:41789` and open the WebChat interface.

**Step 2: Send a test message**

Type: "What products are you managing?"

Expected: The meta-coordinator agent should read `/root/.openclaw/products.yaml` and list the products.

**Step 3: Send a status query**

Type: "Check the status of all products"

Expected: The agent should run `docker exec overstory-runtime bash -c "cd /workspace/<product> && bun run /opt/overstory/src/index.ts status --json"` for each product and return an aggregated status.

**Step 4: Document results**

Create `prototype/docs/prototype-notes.md` with what worked and what didn't.

**Milestone 3 complete:** Human can query the meta-coordinator via WebChat and get aggregated responses.

---

## Task 9: Test Agent Spawning (Milestone 4)

**Step 1: Create a test task in product-a**

First, check if beads is available:
```bash
docker exec overstory-runtime which bd || echo "bd not available"
```

If `bd` is not available, create a manual spec:
```bash
docker exec overstory-runtime bash -c "mkdir -p /workspace/product-a/.overstory/specs && echo '# Test scout task\nExplore the codebase structure and report findings.' > /workspace/product-a/.overstory/specs/test-001.md"
```

**Step 2: Ask the meta-coordinator to run a scout**

In WebChat, type: "Run a scout on product-a to explore the codebase structure"

Expected: The meta-coordinator should:
1. Reason about the request
2. Execute `docker exec overstory-runtime bash -c "cd /workspace/product-a && bun run /opt/overstory/src/index.ts sling test-001 --capability scout --name test-scout"`
3. Report what happened

**Step 3: Check agent status**

In WebChat, type: "What's the status of product-a now?"

Expected: Shows the scout agent as active (or completed).

**Step 4: Document results**

Update `prototype/docs/prototype-notes.md`.

**Milestone 4 complete:** Meta-coordinator can spawn overstory agents via natural language commands.

---

## Task 10: Test Resource Scheduling (Milestone 5)

**Step 1: Ask for concurrent work**

In WebChat, type: "Start work on both product-a and product-c simultaneously"

Expected: The meta-coordinator should:
1. Read the scheduling config (`max_concurrent_sessions: 2`)
2. Reason about resource weights (product-a: 3, product-c: 1)
3. Either start both (within budget) or queue one

**Step 2: Check resource awareness**

In WebChat, type: "How many sessions are running? Are we at capacity?"

Expected: Aggregated resource view.

**Step 3: Document results**

Update `prototype/docs/prototype-notes.md` with findings.

**Milestone 5 complete:** Resource-aware scheduling works.

---

## Task 11: Go/No-Go Decision

**Step 1: Review prototype notes**

Read `prototype/docs/prototype-notes.md` and evaluate:

| Milestone | Pass/Fail | Notes |
|-----------|-----------|-------|
| 1. Containers boot, UI accessible | | |
| 2. CLI bridge works | | |
| 3. WebChat status query | | |
| 4. Agent spawning via natural language | | |
| 5. Resource scheduling | | |

**Step 2: Make decision**

- **If 4+ milestones pass:** Proceed to real implementation. Create a proper design doc and merge-worthy feature branch.
- **If 2-3 milestones pass:** Identify blockers, decide if they're fixable or fundamental.
- **If <2 milestones pass:** Discard prototype. Fall back to enhancing overstory natively with a Slack webhook.

**Step 3: Clean up or preserve**

If discarding:
```bash
cd /Users/umasankr/Projects/useful-repos/overstory/prototype
docker compose down -v
cd ..
rm -rf prototype/
```

If proceeding:
```bash
# Keep prototype running, start real implementation planning
```
