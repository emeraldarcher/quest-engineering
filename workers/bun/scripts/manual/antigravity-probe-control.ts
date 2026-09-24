import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type DispatchRecord,
  DispatchRegistry,
  type HarnessLineage,
} from "../../src/dispatch/registry.ts";
import {
  controlDescriptorPath,
  HarnessControlAuthority,
} from "../../src/harnesses/control/authority.ts";
import { HarnessControlServer } from "../../src/harnesses/control/server.ts";
import type { ExecuteAction } from "../../src/protocol/types.ts";

export interface ProbeControl {
  authority: HarnessControlAuthority;
  descriptorPath: string;
  dispatch: DispatchRecord;
  lineage: HarnessLineage;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function createProbeControl(
  root: string,
  maxStopEnforcements: number,
): Promise<ProbeControl> {
  await mkdir(root, { recursive: true });
  const registry = new DispatchRegistry(
    join(root, "control.sqlite"),
    join(root, "worker-data"),
    "antigravity",
  );
  const action = probeAction(root);
  const dispatch = registry.accept(action).dispatch;
  if (!dispatch.lineageId) throw new Error("Probe dispatch has no lineage.");
  registry.occupy(dispatch.lineageId, action.action_id);
  const lineage = registry.getLineage(dispatch.lineageId);
  const authority = new HarnessControlAuthority(registry, maxStopEnforcements);
  const server = new HarnessControlServer(authority);
  await server.start();
  await authority.bind(dispatch, lineage);
  return {
    authority,
    descriptorPath: controlDescriptorPath(lineage),
    dispatch,
    lineage,
    reset: async () => {
      await authority.bind(dispatch, registry.getLineage(lineage.lineageId));
    },
    close: async () => {
      await server.stop();
      registry.close();
    },
  };
}

export function requireHumanProbeApproval(expectedTurns: number): void {
  if (process.env.QE_RUN_SUBSCRIPTION_PROBE !== "1")
    throw new Error(
      `Refusing to start subscription-backed inference. This human-run probe expects at most ${expectedTurns} model turns. Re-run with QE_RUN_SUBSCRIPTION_PROBE=1 after reviewing the command.`,
    );
}

export function assertInstalledAgyVersion(expected = "1.2.2"): void {
  const result = Bun.spawnSync(["agy", "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const version = result.stdout.toString().trim();
  if (result.exitCode !== 0)
    throw new Error(`agy --version failed: ${result.stderr.toString().trim()}`);
  if (version !== expected)
    throw new Error(
      `This evidence procedure was prepared for agy ${expected}; found ${version}. Re-inspect the installed CLI before running inference.`,
    );
}

export function newProbeRoot(kind: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(
    process.cwd(),
    ".pi",
    "tmp",
    "antigravity-human-probes",
    `${kind}-${timestamp}-${crypto.randomUUID().slice(0, 8)}`,
  );
}

function probeAction(root: string): ExecuteAction {
  const actionId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const occurrenceId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const worktreeId = crypto.randomUUID();
  const bindingId = crypto.randomUUID();
  return {
    type: "execute_action",
    protocol_version: 9,
    worker_id: "manual-antigravity-probe",
    execution: {
      identity: {
        launch_id: crypto.randomUUID(),
        action_id: actionId,
        run_id: runId,
        occurrence_id: occurrenceId,
        attempt_id: attemptId,
        semantic_step_key: "manual_probe",
      },
      performer: {
        member_key: "manual_probe",
        member_name: "Manual Probe",
        class_key: "probe",
        class_name: "Probe",
      },
      work: {
        quest_objective: "Verify the installed Antigravity lifecycle contract.",
        class_instructions:
          "Do not inspect or modify files and do not call tools.",
        step_instruction: "Return only the requested harmless marker.",
        inputs: {},
        declared_outputs: [{ name: "probe_result", kind: "probe_result" }],
        acceptance_contract: null,
      },
      configuration: {
        harness_kind: "antigravity",
        model: {
          provider: "antigravity",
          model: "gemini-3.8-flash-low",
        },
        reasoning: "low",
        reasoning_capability: { kind: "enumerated", values: ["low"] },
        tool_policy: { kind: "native_permissions" },
        tool_enforcement: "native_permissions",
        resolved_tool_profile: { tools: [] },
      },
      logical_workspace: { workspace_id: workspaceId, workspace_key: "probe" },
      execution_workspace: {
        worktree_id: worktreeId,
        workspace_binding_id: bindingId,
        canonical_root: root,
        access: "none",
      },
      context: {
        mode: "fresh",
        source_occurrence_id: null,
        logical_lineage_id: crypto.randomUUID(),
      },
    },
    action_id: actionId,
    run_id: runId,
    occurrence_id: occurrenceId,
    attempt_id: attemptId,
    semantic_step_key: "manual_probe",
    instruction: "Return only the requested harmless marker.",
    inputs: {},
    declared_outputs: ["probe_result"],
    context_requirement: { selector: "fresh", value: null },
    context_lineage_occurrence_id: null,
  };
}
