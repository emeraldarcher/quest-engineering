import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { DispatchRecord } from "../src/dispatch/registry.ts";
import {
  executionArtifactRoot,
  materializeExecutionArtifacts,
} from "../src/workspace/execution-artifacts.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("execution document artifacts", () => {
  test("cross-harness handoff preserves exact artifact ID and hash outside the Git worktree", () => {
    const dataRoot = resolve(
      ".pi/tmp",
      `worker-artifacts-${crypto.randomUUID()}`,
    );
    roots.push(dataRoot);
    const worktree = resolve(dataRoot, "not-used-as-artifact-root", "worktree");
    const content = "# Quest Plan\n\nShip safely.\n";
    const hash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    const dispatch = dispatchWithPlan(worktree, content, hash);

    const result = materializeExecutionArtifacts({ dataRoot }, dispatch);
    const plan = result.quest_plan;
    expect(plan).toBeDefined();
    expect(plan?.path.startsWith(executionArtifactRoot({ dataRoot }))).toBe(
      true,
    );
    expect(plan?.path.startsWith(worktree)).toBe(false);
    expect(plan?.artifactId).toBe("run-1/artifact/2/quest_plan");
    expect(plan?.contentHash).toBe(hash);
    expect(plan?.filename).toMatch(/^quest-plan-v2-[0-9a-f]{8}\.md$/);
    expect(readFileSync(plan?.path as string, "utf8")).toBe(content);
    expect(existsSync(`${plan?.path}.qe-artifact.json`)).toBe(true);

    expect(() =>
      materializeExecutionArtifacts({ dataRoot }, dispatch),
    ).not.toThrow();
  });

  test("rejects content whose canonical hash does not match", () => {
    const dataRoot = resolve(
      ".pi/tmp",
      `worker-artifacts-${crypto.randomUUID()}`,
    );
    roots.push(dataRoot);
    const dispatch = dispatchWithPlan(
      resolve(dataRoot, "worktree"),
      "changed",
      "sha256:nope",
    );
    expect(() => materializeExecutionArtifacts({ dataRoot }, dispatch)).toThrow(
      "content-hash verification",
    );
  });
});

function dispatchWithPlan(
  worktree: string,
  content: string,
  contentHash: string,
): Pick<DispatchRecord, "action"> {
  return {
    action: {
      action_id: "action-1",
      run_id: "run-1",
      occurrence_id: "occurrence-implement",
      attempt_id: "attempt-1",
      semantic_step_key: "implement",
      instruction: "Implement accepted plan.",
      inputs: {},
      declared_outputs: ["change_set"],
      context_requirement: { selector: "fresh", value: null },
      context_lineage_occurrence_id: null,
      worker_id: "worker-1",
      protocol_version: 7,
      type: "execute_action",
      execution: {
        identity: {
          launch_id: "launch-1",
          action_id: "action-1",
          run_id: "run-1",
          occurrence_id: "occurrence-implement",
          attempt_id: "attempt-1",
          semantic_step_key: "implement",
        },
        performer: {
          member_key: "builder",
          member_name: "Builder",
          class_key: "builder",
          class_name: "Builder",
        },
        work: {
          quest_objective: "Build.",
          class_instructions: "Build.",
          step_instruction: "Implement accepted plan.",
          inputs: {
            quest_plan: {
              id: "run-1/artifact/2/quest_plan",
              kind: "quest_plan",
              output_name: "input",
              producer_occurrence_id: "occurrence-revise",
              version: 2,
              supersedes_artifact_id: "run-1/artifact/0/quest_plan",
              content_hash: contentHash,
              media_type: "text/markdown",
              filename: "quest-plan.md",
              title: "Quest Plan",
              value: {
                kind: "document",
                semantic_kind: "quest_plan",
                media_type: "text/markdown",
                filename: "quest-plan.md",
                title: "Quest Plan",
                content,
                content_hash: contentHash,
              },
            },
          },
          declared_outputs: [{ name: "change_set", kind: "change_set" }],
          acceptance_contract: null,
        },
        configuration: {
          harness_kind: "antigravity",
          model: { provider: "fake", model: "test" },
          reasoning: "low",
          tools: ["workspace.filesystem"],
          tool_enforcement: "exact",
        },
        logical_workspace: {
          workspace_id: "workspace-1",
          workspace_key: "workspace",
        },
        execution_workspace: {
          worktree_id: "worktree-1",
          workspace_binding_id: "binding-1",
          canonical_root: worktree,
          access: "read_write",
        },
        context: {
          mode: "fresh",
          source_occurrence_id: null,
          logical_lineage_id: "lineage-1",
        },
      },
    },
  };
}
