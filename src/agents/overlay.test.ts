import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentError } from "../errors.ts";
import type { OverlayConfig } from "../types.ts";
import {
	formatCurrentDate,
	formatExistingPlan,
	formatLeadMode,
	generateOverlay,
	isCanonicalRoot,
	writeOverlay,
} from "./overlay.ts";

const SAMPLE_BASE_DEFINITION = `# Builder Agent

You are a **builder agent** in the overstory swarm system.

## Role
Implement changes according to a spec.

## Propulsion Principle
Read your assignment. Execute immediately.

## Failure Modes
- FILE_SCOPE_VIOLATION
- SILENT_FAILURE
`;

/** Build a complete OverlayConfig with sensible defaults, overrideable by partial. */
function makeConfig(overrides?: Partial<OverlayConfig>): OverlayConfig {
	return {
		agentName: "test-builder",
		beadId: "overstory-abc",
		specPath: ".overstory/specs/overstory-abc.md",
		branchName: "agent/test-builder/overstory-abc",
		worktreePath: "/tmp/test-project/.overstory/worktrees/test-builder",
		fileScope: ["src/agents/manifest.ts", "src/agents/overlay.ts"],
		mulchDomains: ["typescript", "testing"],
		parentAgent: "lead-alpha",
		depth: 1,
		canSpawn: false,
		capability: "builder",
		baseDefinition: SAMPLE_BASE_DEFINITION,
		...overrides,
	};
}

describe("generateOverlay", () => {
	test("output contains agent name", async () => {
		const config = makeConfig({ agentName: "my-scout" });
		const output = await generateOverlay(config);

		expect(output).toContain("my-scout");
	});

	test("output contains bead ID", async () => {
		const config = makeConfig({ beadId: "overstory-xyz" });
		const output = await generateOverlay(config);

		expect(output).toContain("overstory-xyz");
	});

	test("output contains branch name", async () => {
		const config = makeConfig({ branchName: "agent/scout/overstory-xyz" });
		const output = await generateOverlay(config);

		expect(output).toContain("agent/scout/overstory-xyz");
	});

	test("output contains parent agent name", async () => {
		const config = makeConfig({ parentAgent: "lead-bravo" });
		const output = await generateOverlay(config);

		expect(output).toContain("lead-bravo");
	});

	test("output contains depth", async () => {
		const config = makeConfig({ depth: 2 });
		const output = await generateOverlay(config);

		expect(output).toContain("2");
	});

	test("output contains spec path when provided", async () => {
		const config = makeConfig({ specPath: ".overstory/specs/my-task.md" });
		const output = await generateOverlay(config);

		expect(output).toContain(".overstory/specs/my-task.md");
	});

	test("shows fallback text when specPath is null", async () => {
		const config = makeConfig({ specPath: null });
		const output = await generateOverlay(config);

		expect(output).toContain("No spec file provided");
		expect(output).not.toContain("{{SPEC_PATH}}");
	});

	test("includes 'Read your task spec' instruction when spec provided", async () => {
		const config = makeConfig({ specPath: ".overstory/specs/my-task.md" });
		const output = await generateOverlay(config);

		expect(output).toContain("Read your task spec at the path above");
	});

	test("does not include 'Read your task spec' instruction when specPath is null", async () => {
		const config = makeConfig({ specPath: null });
		const output = await generateOverlay(config);

		expect(output).not.toContain("Read your task spec at the path above");
		expect(output).toContain("No task spec was provided");
	});

	test("shows 'orchestrator' when parentAgent is null", async () => {
		const config = makeConfig({ parentAgent: null });
		const output = await generateOverlay(config);

		expect(output).toContain("orchestrator");
	});

	test("file scope is formatted as markdown bullets", async () => {
		const config = makeConfig({
			fileScope: ["src/foo.ts", "src/bar.ts"],
		});
		const output = await generateOverlay(config);

		expect(output).toContain("- `src/foo.ts`");
		expect(output).toContain("- `src/bar.ts`");
	});

	test("empty file scope shows fallback text", async () => {
		const config = makeConfig({ fileScope: [] });
		const output = await generateOverlay(config);

		expect(output).toContain("No file scope restrictions");
	});

	test("mulch domains formatted as prime command", async () => {
		const config = makeConfig({ mulchDomains: ["typescript", "testing"] });
		const output = await generateOverlay(config);

		expect(output).toContain("mulch prime typescript testing");
	});

	test("empty mulch domains shows fallback text", async () => {
		const config = makeConfig({ mulchDomains: [] });
		const output = await generateOverlay(config);

		expect(output).toContain("No specific expertise domains configured");
	});

	test("canSpawn false says 'You may NOT spawn sub-workers'", async () => {
		const config = makeConfig({ canSpawn: false });
		const output = await generateOverlay(config);

		expect(output).toContain("You may NOT spawn sub-workers");
	});

	test("canSpawn true includes sling example", async () => {
		const config = makeConfig({
			canSpawn: true,
			agentName: "lead-alpha",
			depth: 1,
		});
		const output = await generateOverlay(config);

		expect(output).toContain("overstory sling");
		expect(output).toContain("--parent lead-alpha");
		expect(output).toContain("--depth 2");
	});

	test("no unreplaced placeholders remain in output", async () => {
		const config = makeConfig();
		const output = await generateOverlay(config);

		expect(output).not.toContain("{{");
		expect(output).not.toContain("}}");
	});

	test("includes pre-loaded expertise when mulchExpertise is provided", async () => {
		const config = makeConfig({
			mulchExpertise: "## architecture\n- Pattern: use singleton for config loader",
		});
		const output = await generateOverlay(config);

		expect(output).toContain("### Pre-loaded Expertise");
		expect(output).toContain("automatically loaded at spawn time");
		expect(output).toContain("## architecture");
		expect(output).toContain("Pattern: use singleton for config loader");
	});

	test("omits expertise section when mulchExpertise is undefined", async () => {
		const config = makeConfig({ mulchExpertise: undefined });
		const output = await generateOverlay(config);

		expect(output).not.toContain("### Pre-loaded Expertise");
		expect(output).not.toContain("automatically loaded at spawn time");
	});

	test("omits expertise section when mulchExpertise is empty string", async () => {
		const config = makeConfig({ mulchExpertise: "" });
		const output = await generateOverlay(config);

		expect(output).not.toContain("### Pre-loaded Expertise");
	});

	test("omits expertise section when mulchExpertise is whitespace only", async () => {
		const config = makeConfig({ mulchExpertise: "   \n\t  \n  " });
		const output = await generateOverlay(config);

		expect(output).not.toContain("### Pre-loaded Expertise");
	});

	test("builder capability includes full quality gates section", async () => {
		const config = makeConfig({ capability: "builder" });
		const output = await generateOverlay(config);

		expect(output).toContain("Quality Gates");
		expect(output).toContain("bun test");
		expect(output).toContain("bun run lint");
		expect(output).toContain("Commit");
	});

	test("lead capability includes full quality gates section", async () => {
		const config = makeConfig({ capability: "lead" });
		const output = await generateOverlay(config);

		expect(output).toContain("Quality Gates");
		expect(output).toContain("bun test");
		expect(output).toContain("bun run lint");
	});

	test("merger capability includes full quality gates section", async () => {
		const config = makeConfig({ capability: "merger" });
		const output = await generateOverlay(config);

		expect(output).toContain("Quality Gates");
		expect(output).toContain("bun test");
	});

	test("scout capability gets read-only completion section instead of quality gates", async () => {
		const config = makeConfig({ capability: "scout", agentName: "my-scout" });
		const output = await generateOverlay(config);

		expect(output).toContain("Completion");
		expect(output).toContain("read-only agent");
		expect(output).toContain("Do NOT commit");
		expect(output).not.toContain("Quality Gates");
		expect(output).not.toContain("bun test");
		expect(output).not.toContain("bun run lint");
	});

	test("reviewer capability gets read-only completion section instead of quality gates", async () => {
		const config = makeConfig({ capability: "reviewer", agentName: "my-reviewer" });
		const output = await generateOverlay(config);

		expect(output).toContain("Completion");
		expect(output).toContain("read-only agent");
		expect(output).toContain("Do NOT commit");
		expect(output).not.toContain("Quality Gates");
		expect(output).not.toContain("bun test");
		expect(output).not.toContain("bun run lint");
	});

	test("scout completion section includes bd close and mail send", async () => {
		const config = makeConfig({
			capability: "scout",
			agentName: "recon-1",
			beadId: "overstory-task1",
			parentAgent: "lead-alpha",
		});
		const output = await generateOverlay(config);

		expect(output).toContain("bd close overstory-task1");
		expect(output).toContain("overstory mail send --to lead-alpha");
	});

	test("reviewer completion section uses orchestrator when no parent", async () => {
		const config = makeConfig({
			capability: "reviewer",
			parentAgent: null,
		});
		const output = await generateOverlay(config);

		expect(output).toContain("--to orchestrator");
	});

	test("output includes communication section with agent address", async () => {
		const config = makeConfig({ agentName: "worker-42" });
		const output = await generateOverlay(config);

		expect(output).toContain("overstory mail check --agent worker-42");
		expect(output).toContain("overstory mail send --to");
	});

	test("output includes base agent definition content (Layer 1)", async () => {
		const config = makeConfig();
		const output = await generateOverlay(config);

		expect(output).toContain("# Builder Agent");
		expect(output).toContain("Propulsion Principle");
		expect(output).toContain("FILE_SCOPE_VIOLATION");
	});

	test("base definition appears before task assignment section", async () => {
		const config = makeConfig();
		const output = await generateOverlay(config);

		const baseDefIndex = output.indexOf("# Builder Agent");
		const assignmentIndex = output.indexOf("## Your Assignment");
		expect(baseDefIndex).toBeGreaterThan(-1);
		expect(assignmentIndex).toBeGreaterThan(-1);
		expect(baseDefIndex).toBeLessThan(assignmentIndex);
	});

	test("output contains worktree path in assignment section", async () => {
		const config = makeConfig({
			worktreePath: "/project/.overstory/worktrees/my-builder",
		});
		const output = await generateOverlay(config);

		expect(output).toContain("/project/.overstory/worktrees/my-builder");
		expect(output).toContain("**Worktree:**");
	});

	test("output contains Working Directory section with worktree path", async () => {
		const config = makeConfig({
			worktreePath: "/tmp/worktrees/builder-1",
		});
		const output = await generateOverlay(config);

		expect(output).toContain("## Working Directory");
		expect(output).toContain("Your worktree root is: `/tmp/worktrees/builder-1`");
		expect(output).toContain("PATH_BOUNDARY_VIOLATION");
	});

	test("file scope section references worktree root", async () => {
		const config = makeConfig({
			worktreePath: "/tmp/worktrees/builder-scope",
		});
		const output = await generateOverlay(config);

		expect(output).toContain(
			"These paths are relative to your worktree root: `/tmp/worktrees/builder-scope`",
		);
	});

	test("builder constraints include worktree isolation", async () => {
		const config = makeConfig({
			capability: "builder",
			worktreePath: "/tmp/worktrees/builder-constraints",
		});
		const output = await generateOverlay(config);

		expect(output).toContain("WORKTREE ISOLATION");
		expect(output).toContain("/tmp/worktrees/builder-constraints");
		expect(output).toContain("NEVER write to the canonical repo root");
	});

	test("no unreplaced WORKTREE_PATH placeholders", async () => {
		const config = makeConfig();
		const output = await generateOverlay(config);

		expect(output).not.toContain("{{WORKTREE_PATH}}");
	});
});

describe("writeOverlay", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-overlay-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("creates .claude/CLAUDE.md in worktree directory", async () => {
		const worktreePath = join(tempDir, "worktree");
		const config = makeConfig();

		await writeOverlay(worktreePath, config, "/nonexistent-canonical-root");

		const outputPath = join(worktreePath, ".claude", "CLAUDE.md");
		const file = Bun.file(outputPath);
		const exists = await file.exists();
		expect(exists).toBe(true);
	});

	test("written file contains the overlay content", async () => {
		const worktreePath = join(tempDir, "worktree");
		const config = makeConfig({ agentName: "file-writer-test" });

		await writeOverlay(worktreePath, config, "/nonexistent-canonical-root");

		const outputPath = join(worktreePath, ".claude", "CLAUDE.md");
		const content = await Bun.file(outputPath).text();
		expect(content).toContain("file-writer-test");
		expect(content).toContain(config.beadId);
		expect(content).toContain(config.branchName);
	});

	test("creates .claude directory even if worktree already exists", async () => {
		const worktreePath = join(tempDir, "existing-worktree");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(worktreePath, { recursive: true });

		const config = makeConfig();
		await writeOverlay(worktreePath, config, "/nonexistent-canonical-root");

		const outputPath = join(worktreePath, ".claude", "CLAUDE.md");
		const exists = await Bun.file(outputPath).exists();
		expect(exists).toBe(true);
	});

	test("overwrites existing CLAUDE.md if it already exists", async () => {
		const worktreePath = join(tempDir, "worktree");
		const claudeDir = join(worktreePath, ".claude");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(claudeDir, { recursive: true });
		await Bun.write(join(claudeDir, "CLAUDE.md"), "old content");

		const config = makeConfig({ agentName: "new-agent" });
		await writeOverlay(worktreePath, config, "/nonexistent-canonical-root");

		const content = await Bun.file(join(claudeDir, "CLAUDE.md")).text();
		expect(content).toContain("new-agent");
		expect(content).not.toContain("old content");
	});

	test("writeOverlay content matches generateOverlay output", async () => {
		const worktreePath = join(tempDir, "worktree");
		const config = makeConfig();

		const generated = await generateOverlay(config);
		await writeOverlay(worktreePath, config, "/nonexistent-canonical-root");

		const written = await Bun.file(join(worktreePath, ".claude", "CLAUDE.md")).text();
		expect(written).toBe(generated);
	});

	test("throws AgentError when worktreePath is the canonical project root", async () => {
		const fakeProjectRoot = join(tempDir, "project-root");
		await mkdir(fakeProjectRoot, { recursive: true });

		const config = makeConfig({ agentName: "rogue-agent" });

		expect(async () => {
			await writeOverlay(fakeProjectRoot, config, fakeProjectRoot);
		}).toThrow(AgentError);
	});

	test("error message mentions canonical project root when guard triggers", async () => {
		const fakeProjectRoot = join(tempDir, "project-root-msg");
		await mkdir(fakeProjectRoot, { recursive: true });

		const config = makeConfig({ agentName: "rogue-agent" });

		try {
			await writeOverlay(fakeProjectRoot, config, fakeProjectRoot);
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(AgentError);
			const agentErr = err as AgentError;
			expect(agentErr.message).toContain("canonical project root");
			expect(agentErr.message).toContain(fakeProjectRoot);
			expect(agentErr.agentName).toBe("rogue-agent");
		}
	});

	test("does NOT throw when worktreePath is a proper worktree subdirectory", async () => {
		const fakeProjectRoot = join(tempDir, "project-with-worktrees");
		await mkdir(join(fakeProjectRoot, ".overstory", "worktrees", "my-agent"), { recursive: true });

		const worktreePath = join(fakeProjectRoot, ".overstory", "worktrees", "my-agent");
		const config = makeConfig();

		// This should succeed — the worktree is not the canonical root
		await writeOverlay(worktreePath, config, fakeProjectRoot);

		const outputPath = join(worktreePath, ".claude", "CLAUDE.md");
		const exists = await Bun.file(outputPath).exists();
		expect(exists).toBe(true);
	});

	test("does not write CLAUDE.md when guard rejects the path", async () => {
		const fakeProjectRoot = join(tempDir, "project-no-write");
		await mkdir(fakeProjectRoot, { recursive: true });

		const config = makeConfig();

		try {
			await writeOverlay(fakeProjectRoot, config, fakeProjectRoot);
		} catch {
			// Expected
		}

		// Verify CLAUDE.md was NOT written
		const claudeMdPath = join(fakeProjectRoot, ".claude", "CLAUDE.md");
		const exists = await Bun.file(claudeMdPath).exists();
		expect(exists).toBe(false);
	});

	test("succeeds for worktree with .overstory/config.yaml (dogfooding scenario)", async () => {
		// When dogfooding on overstory's own repo, .overstory/config.yaml is tracked
		// in git. Every worktree checkout includes it. The old file-existence heuristic
		// would incorrectly reject these worktrees. The path-comparison guard must allow
		// writes because the worktree path differs from the canonical root (overstory-p4st).
		const fakeProjectRoot = join(tempDir, "overstory-dogfood");
		const worktreePath = join(fakeProjectRoot, ".overstory", "worktrees", "dogfood-agent");
		await mkdir(join(worktreePath, ".overstory"), { recursive: true });
		// Simulate tracked .overstory/config.yaml appearing in the worktree checkout
		await Bun.write(
			join(worktreePath, ".overstory", "config.yaml"),
			"project:\n  name: overstory\n",
		);

		const config = makeConfig({ agentName: "dogfood-agent" });

		// Must succeed — worktreePath !== fakeProjectRoot even though config.yaml exists
		await writeOverlay(worktreePath, config, fakeProjectRoot);

		const outputPath = join(worktreePath, ".claude", "CLAUDE.md");
		const exists = await Bun.file(outputPath).exists();
		expect(exists).toBe(true);
	});
});

describe("formatLeadMode", () => {
	test("returns plan-mode instructions when mode is plan", () => {
		const config = makeConfig({ mode: "plan" });
		const result = formatLeadMode(config);

		expect(result).toContain("Lead Mode: Plan");
		expect(result).toContain("plan mode");
		expect(result).toContain("must NOT spawn builders");
		expect(result).toContain("plan_ready");
	});

	test("returns execute-mode instructions when mode is execute", () => {
		const config = makeConfig({ mode: "execute" });
		const result = formatLeadMode(config);

		expect(result).toContain("Lead Mode: Execute");
		expect(result).toContain("execute mode");
	});

	test("references existing plan in execute mode when set", () => {
		const config = makeConfig({
			mode: "execute",
			existingPlan: "/project/.overstory/plans/task-123.md",
		});
		const result = formatLeadMode(config);

		expect(result).toContain("/project/.overstory/plans/task-123.md");
		expect(result).toContain("approved plan exists");
	});

	test("says no plan found in execute mode when existingPlan is undefined", () => {
		const config = makeConfig({ mode: "execute", existingPlan: undefined });
		const result = formatLeadMode(config);

		expect(result).toContain("No existing plan was found");
	});

	test("returns empty string when mode is undefined", () => {
		const config = makeConfig({ mode: undefined });
		const result = formatLeadMode(config);

		expect(result).toBe("");
	});
});

describe("formatCurrentDate", () => {
	test("returns date string when currentDate is set", () => {
		const config = makeConfig({ currentDate: "2026-02-18" });
		const result = formatCurrentDate(config);

		expect(result).toContain("2026-02-18");
		expect(result).toContain("Current Date");
	});

	test("returns empty string when currentDate is undefined", () => {
		const config = makeConfig({ currentDate: undefined });
		const result = formatCurrentDate(config);

		expect(result).toBe("");
	});
});

describe("formatExistingPlan", () => {
	test("returns plan path when existingPlan is set", () => {
		const config = makeConfig({ existingPlan: "/plans/task-abc.md" });
		const result = formatExistingPlan(config);

		expect(result).toContain("/plans/task-abc.md");
		expect(result).toContain("Approved Plan");
	});

	test("returns empty string when existingPlan is undefined", () => {
		const config = makeConfig({ existingPlan: undefined });
		const result = formatExistingPlan(config);

		expect(result).toBe("");
	});
});

describe("generateOverlay with planning fields", () => {
	test("plan-mode lead overlay contains plan mode instructions", async () => {
		const config = makeConfig({
			capability: "lead",
			mode: "plan",
			canSpawn: true,
		});
		const output = await generateOverlay(config);

		expect(output).toContain("Lead Mode: Plan");
		expect(output).toContain("must NOT spawn builders");
	});

	test("execute-mode lead overlay contains execute mode instructions", async () => {
		const config = makeConfig({
			capability: "lead",
			mode: "execute",
			canSpawn: true,
		});
		const output = await generateOverlay(config);

		expect(output).toContain("Lead Mode: Execute");
	});

	test("overlay includes current date when set", async () => {
		const config = makeConfig({ currentDate: "2026-02-18" });
		const output = await generateOverlay(config);

		expect(output).toContain("2026-02-18");
	});

	test("overlay includes existing plan path when set", async () => {
		const config = makeConfig({ existingPlan: "/plans/task-xyz.md" });
		const output = await generateOverlay(config);

		expect(output).toContain("/plans/task-xyz.md");
		expect(output).toContain("Approved Plan");
	});

	test("non-lead agent has no lead mode section", async () => {
		const config = makeConfig({ capability: "builder", mode: undefined });
		const output = await generateOverlay(config);

		expect(output).not.toContain("Lead Mode");
	});

	test("no unreplaced planning placeholders remain", async () => {
		const config = makeConfig({
			mode: "plan",
			currentDate: "2026-02-18",
			existingPlan: "/plans/test.md",
		});
		const output = await generateOverlay(config);

		expect(output).not.toContain("{{LEAD_MODE}}");
		expect(output).not.toContain("{{CURRENT_DATE}}");
		expect(output).not.toContain("{{EXISTING_PLAN}}");
	});
});

describe("isCanonicalRoot", () => {
	test("returns true when dir matches canonicalRoot", () => {
		expect(isCanonicalRoot("/projects/my-app", "/projects/my-app")).toBe(true);
	});

	test("returns true when paths resolve to the same location", () => {
		expect(isCanonicalRoot("/projects/my-app/./", "/projects/my-app")).toBe(true);
	});

	test("returns false when dir differs from canonicalRoot", () => {
		expect(
			isCanonicalRoot("/projects/my-app/.overstory/worktrees/agent-1", "/projects/my-app"),
		).toBe(false);
	});

	test("returns false for worktree even when it contains .overstory/config.yaml (dogfooding)", () => {
		// This is the core dogfooding scenario: the worktree has .overstory/config.yaml
		// because it's tracked in git, but the path is different from the canonical root.
		const canonicalRoot = "/projects/overstory";
		const worktreePath = "/projects/overstory/.overstory/worktrees/dogfood-agent";
		expect(isCanonicalRoot(worktreePath, canonicalRoot)).toBe(false);
	});
});
