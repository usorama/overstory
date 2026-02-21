#!/usr/bin/env bash
# sync-upstream.sh — Pull upstream/main into our fork without losing local work
#
# Usage:
#   ./scripts/sync-upstream.sh          # Interactive (pauses on conflicts)
#   ./scripts/sync-upstream.sh --dry    # Show what would change, don't merge
#
# What it does:
#   1. Stashes any uncommitted local changes
#   2. Fetches upstream/main
#   3. Shows new commits since last sync
#   4. Merges upstream/main into current branch
#   5. Runs bun install if package.json changed
#   6. Runs quality gates (typecheck + test)
#   7. Pops the stash back
#
# On merge conflicts:
#   The script pauses and tells you which files conflict.
#   Fix them manually, then run: git add <files> && git commit --no-edit
#   Then re-run the script to pop the stash and verify.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[sync]${NC} $*"; }
ok()    { echo -e "${GREEN}[sync]${NC} $*"; }
warn()  { echo -e "${YELLOW}[sync]${NC} $*"; }
err()   { echo -e "${RED}[sync]${NC} $*"; }

DRY_RUN=false
if [[ "${1:-}" == "--dry" ]]; then
    DRY_RUN=true
fi

# ─── Preflight ───────────────────────────────────────────────────────
info "Checking remotes..."
if ! git remote get-url upstream &>/dev/null; then
    err "No 'upstream' remote. Add it:"
    err "  git remote add upstream https://github.com/jayminwest/overstory.git"
    exit 1
fi

CURRENT_BRANCH=$(git branch --show-current)
info "Current branch: $CURRENT_BRANCH"

# ─── Fetch ───────────────────────────────────────────────────────────
info "Fetching upstream..."
git fetch upstream --tags 2>&1 | sed 's/^/  /'

# ─── Diff report ─────────────────────────────────────────────────────
LOCAL_HEAD=$(git rev-parse HEAD)
UPSTREAM_HEAD=$(git rev-parse upstream/main)
MERGE_BASE=$(git merge-base HEAD upstream/main)

if [[ "$MERGE_BASE" == "$UPSTREAM_HEAD" ]]; then
    ok "Already up to date with upstream/main."
    exit 0
fi

NEW_COMMITS=$(git log --oneline "$MERGE_BASE..upstream/main" | wc -l | tr -d ' ')
info "$NEW_COMMITS new upstream commits since last sync"

echo ""
info "New upstream commits:"
git log --oneline "$MERGE_BASE..upstream/main" | head -20
if (( NEW_COMMITS > 20 )); then
    warn "  ... and $((NEW_COMMITS - 20)) more"
fi

echo ""
info "Files changed upstream:"
UPSTREAM_FILES=$(git diff --name-only "$MERGE_BASE..upstream/main")
echo "$UPSTREAM_FILES" | head -30
UPSTREAM_COUNT=$(echo "$UPSTREAM_FILES" | wc -l | tr -d ' ')
if (( UPSTREAM_COUNT > 30 )); then
    warn "  ... and $((UPSTREAM_COUNT - 30)) more files"
fi

# Check for potential conflicts
LOCAL_MODIFIED=$(git diff --name-only HEAD 2>/dev/null || true)
if [[ -n "$LOCAL_MODIFIED" ]]; then
    CONFLICTS=$(comm -12 <(echo "$UPSTREAM_FILES" | sort) <(echo "$LOCAL_MODIFIED" | sort))
    if [[ -n "$CONFLICTS" ]]; then
        echo ""
        warn "Potential conflict files (modified both upstream and locally):"
        echo "$CONFLICTS" | sed 's/^/  ⚠ /'
    fi
fi

# Check for new tags
NEW_TAGS=$(git log --oneline --decorate "$MERGE_BASE..upstream/main" | grep -o 'tag: [^,)]*' | sed 's/tag: //' || true)
if [[ -n "$NEW_TAGS" ]]; then
    echo ""
    info "New tags: $NEW_TAGS"
fi

if $DRY_RUN; then
    echo ""
    ok "Dry run complete. Run without --dry to merge."
    exit 0
fi

# ─── Stash ───────────────────────────────────────────────────────────
STASHED=false
if [[ -n "$(git status --porcelain)" ]]; then
    info "Stashing local changes..."
    git stash push -m "sync-upstream-$(date +%Y%m%d-%H%M%S)" --include-untracked
    STASHED=true
    ok "Local changes stashed."
fi

# ─── Merge ───────────────────────────────────────────────────────────
info "Merging upstream/main..."
if ! git merge upstream/main --no-edit 2>&1; then
    echo ""
    err "Merge conflicts detected!"
    err "Conflicted files:"
    git diff --name-only --diff-filter=U | sed 's/^/  ✗ /'
    echo ""
    warn "Fix conflicts, then run:"
    warn "  git add <resolved-files>"
    warn "  git commit --no-edit"
    if $STASHED; then
        warn "  git stash pop   # to restore your local changes"
    fi
    warn "  ./scripts/sync-upstream.sh  # re-run to verify"
    exit 1
fi

ok "Merge complete."

# ─── Install ─────────────────────────────────────────────────────────
if git diff --name-only "$MERGE_BASE..upstream/main" | grep -q "package.json"; then
    info "package.json changed — running bun install..."
    bun install 2>&1 | sed 's/^/  /'
else
    info "No package.json changes — skipping install."
fi

# ─── Pop stash ───────────────────────────────────────────────────────
if $STASHED; then
    info "Restoring stashed changes..."
    if ! git stash pop 2>&1; then
        echo ""
        err "Stash pop had conflicts!"
        err "Conflicted files:"
        git diff --name-only --diff-filter=U | sed 's/^/  ✗ /'
        echo ""
        warn "Fix conflicts in the files above, then:"
        warn "  git add <resolved-files>"
        warn "  git stash drop  # clean up the stash entry"
        exit 1
    fi
    ok "Local changes restored."
fi

# ─── Quality gates ───────────────────────────────────────────────────
echo ""
info "Running quality gates..."

info "  typecheck..."
if ! bun run typecheck 2>&1 | tail -3; then
    err "TypeScript errors! Fix before proceeding."
    exit 1
fi
ok "  typecheck passed."

info "  tests..."
TEST_OUTPUT=$(bun test 2>&1)
TEST_SUMMARY=$(echo "$TEST_OUTPUT" | tail -3)
echo "$TEST_SUMMARY"
if echo "$TEST_SUMMARY" | grep -q "0 fail"; then
    ok "  all tests passed."
elif echo "$TEST_SUMMARY" | grep -qE "[0-9]+ fail"; then
    FAIL_COUNT=$(echo "$TEST_SUMMARY" | grep -oE "[0-9]+ fail" | head -1)
    warn "  $FAIL_COUNT — check if these are pre-existing upstream issues."
fi

# ─── Summary ─────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════"
ok "Upstream sync complete!"
info "  Merged: $NEW_COMMITS commits from upstream/main"
info "  Branch: $CURRENT_BRANCH"
info "  Tags: ${NEW_TAGS:-none}"
echo "════════════════════════════════════════════════════"
