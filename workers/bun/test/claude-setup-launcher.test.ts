import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import { SBX_CODING_EXECUTION_PROFILE_V3 } from "../src/execution-environment/sbx-profile.ts";
import { WORKER_PROTOCOL_VERSION } from "../src/protocol/types.ts";
import { CLAUDE_FORBIDDEN_AUTH_SELECTOR_NAMES } from "../src/provider-auth.ts";

const fixture = resolve(
  import.meta.dir,
  "fixtures/exercise-claude-setup-launch.ts",
);

test("production Claude setup caller acknowledges one fake guest login process before HumanAttention", async () => {
  const workerId = "worker-claude-setup-launch";
  const payload = {
    type: "prepare_harness_setup",
    protocol_version: WORKER_PROTOCOL_VERSION,
    worker_id: workerId,
    connection_generation: 1,
    setup: {
      setup_id: "setup-claude-launch",
      setup_generation: 1,
      authorization_id: "authorization-claude-launch",
      authorization_kind: "human_harness_setup",
      authorized_at: new Date().toISOString(),
      action_id: "action-claude-launch",
      run_id: "run-claude-launch",
      occurrence_id: "occurrence-claude-launch",
      member_key: "operator",
      harness_kind: "claude_agent_sdk",
      physical_lineage_id: "physical-claude-launch",
      logical_lineage_id: "logical-claude-launch",
      workspace_id: "workspace-claude-launch",
      worktree_id: "worktree-claude-launch",
      workspace_binding_id: "binding-claude-launch",
      canonical_root: "/host/worktrees/claude-launch",
      workspace_access: "read_write",
      profile: SBX_CODING_EXECUTION_PROFILE_V3,
      configuration: {
        model: { provider: "anthropic", model: "claude-sonnet-5" },
        reasoning: "high",
        reasoning_capability: { kind: "enumerated", values: ["high"] },
        tool_policy: {
          kind: "exact",
          tools: ["workspace.filesystem", "workspace.search", "terminal.shell"],
        },
        tool_enforcement: "exact",
        resolved_tool_profile: {
          tools: ["workspace.filesystem", "workspace.search", "terminal.shell"],
        },
      },
    },
  };
  const child = Bun.spawn(
    [
      process.execPath,
      fixture,
      Buffer.from(JSON.stringify(payload)).toString("base64"),
      workerId,
      "1",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  const result = JSON.parse(stdout);
  expect(result.decoded).toEqual(payload);
  expect(result.beforeCleanup).toMatchObject({
    state: "human_interaction_required",
    invocationState: "acknowledged",
    physicalLaunchCount: 1,
    launchedCommand: {
      executable:
        "/opt/qe/pi/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude",
      args: ["auth", "login"],
      cwd: "/qe/workspaces/default",
    },
    privateWorkspace: "/qe/workspaces/fake-product-boundary",
    setupWorkingDirectory: "/qe/workspaces/default",
    forbiddenEnvironmentNames: [],
    reportStates: [
      "preparing",
      "invocation_requested",
      "invocation_acknowledged",
      "human_interaction_required",
      "human_interaction_required",
    ],
    ephemeralOutputObserved: true,
    durableContainsFixtureOutput: false,
    processIdentity: {
      backendProcessId: "fixture-pid-1",
      processStartIdentity: "fixture-start-1",
    },
  });
  for (const name of CLAUDE_FORBIDDEN_AUTH_SELECTOR_NAMES)
    expect(result.beforeCleanup.launchedCommand.environmentNames).not.toContain(
      name,
    );
  expect(result.afterCleanup).toEqual({
    state: "invalidated",
    cancelCount: 1,
    processRunning: false,
  });
});
