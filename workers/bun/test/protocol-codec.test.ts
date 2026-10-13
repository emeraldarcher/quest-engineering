import { describe, expect, test } from "bun:test";
import {
  decodeCancelDispatch,
  decodeExecuteAction,
  decodeHumanAttentionResponse,
  decodePrepareHarnessSetup,
  ProtocolDecodeError,
} from "../src/protocol/codec.ts";
import {
  type CancelDispatch,
  type HumanAttentionResponseCommand,
  type PrepareHarnessSetupCommand,
  WORKER_PROTOCOL_VERSION,
} from "../src/protocol/types.ts";
import { action } from "./support.ts";

describe("Worker Protocol v15 ResolvedExecution codec", () => {
  test("decodes only an exact Worker-generation cancellation command", () => {
    const command = {
      type: "cancel_dispatch",
      protocol_version: WORKER_PROTOCOL_VERSION,
      worker_id: "worker-test",
      connection_generation: 7,
      action_id: "action-1",
      run_id: "run-1",
      occurrence_id: "occurrence-1",
      attempt_id: "attempt-1",
      cancellation: {
        request_id: "cancel-1",
        origin: "product_operator",
        reason: null,
        requested_at: "2026-09-17T12:00:00Z",
      },
    } satisfies CancelDispatch;

    expect(decodeCancelDispatch(command, "worker-test", 7)).toEqual(command);
    expect(() =>
      decodeCancelDispatch(
        { ...command, connection_generation: 6 },
        "worker-test",
        7,
      ),
    ).toThrow(ProtocolDecodeError);
    expect(() =>
      decodeCancelDispatch({ ...command, attempt_id: "" }, "worker-test", 7),
    ).toThrow(ProtocolDecodeError);
  });

  test("decodes an exact generation-fenced structured HumanAttention response", () => {
    const command = {
      type: "respond_human_attention",
      protocol_version: WORKER_PROTOCOL_VERSION,
      worker_id: "worker-test",
      connection_generation: 7,
      action_id: "action-1",
      run_id: "run-1",
      occurrence_id: "occurrence-1",
      attempt_id: "attempt-1",
      response: {
        request_id: "response-1",
        attention_id: "attention-1",
        request_generation: 2,
        session_id: "session-1",
        native_session_id: "native-1",
        delivery_attempt_id: "delivery-1",
        approved: true,
        value: { answers: { Choice: "A" } },
        responded_at: "2026-09-17T12:00:00Z",
        response_committed_at: "2026-09-17T12:00:00Z",
      },
    } satisfies HumanAttentionResponseCommand;
    expect(decodeHumanAttentionResponse(command, "worker-test", 7)).toEqual(
      command,
    );
    expect(() =>
      decodeHumanAttentionResponse(
        { ...command, connection_generation: 6 },
        "worker-test",
        7,
      ),
    ).toThrow(ProtocolDecodeError);
    expect(() =>
      decodeHumanAttentionResponse(
        { ...command, response: { ...command.response, value: undefined } },
        "worker-test",
        7,
      ),
    ).toThrow(ProtocolDecodeError);
  });

  test("requires and preserves separated semantic instructions", () => {
    const input = action({
      instruction: "Inspect inputs.\nProduce the result.",
    });
    expect(decodeExecuteAction(input, "worker-test").instruction).toBe(
      input.execution.work.step_instruction,
    );
    expect(() =>
      decodeExecuteAction(
        {
          ...input,
          execution: {
            ...input.execution,
            work: { ...input.execution.work, step_instruction: "" },
          },
        },
        "worker-test",
      ),
    ).toThrow(ProtocolDecodeError);
  });

  test("decodes normalized operational retry attribution without changing semantic context", () => {
    const input = action();
    const decoded = decodeExecuteAction(
      {
        ...input,
        operational_recovery: {
          epoch_number: 1,
          attempt_in_epoch: 1,
          attempt_allowance: 2,
          authorization_kind: "human",
          continuation_mode: "retained",
          retained_lineage_id: "lineage-retained",
          source_attempt_id: "attempt-1",
          request_id: "request-1",
        },
      },
      input.worker_id,
    );
    expect(decoded.operational_recovery).toMatchObject({
      epoch_number: 1,
      attempt_in_epoch: 1,
      continuation_mode: "retained",
    });
    expect(decoded.execution.context).toEqual(input.execution.context);
  });

  test("preserves document provenance and exact acceptance contract", () => {
    const input = action();
    const decoded = decodeExecuteAction(
      {
        ...input,
        execution: {
          ...input.execution,
          work: {
            ...input.execution.work,
            inputs: {
              quest_plan: {
                id: "plan-v2",
                kind: "quest_plan",
                output_name: "input",
                producer_occurrence_id: "revise-plan-1",
                value: { kind: "document", content: "# Plan" },
                version: 2,
                supersedes_artifact_id: "plan-v1",
                content_hash: "sha256:abc",
                media_type: "text/markdown",
                filename: "quest-plan.md",
                title: "Quest Plan",
              },
            },
            declared_outputs: [{ name: "verdict", kind: "review_verdict" }],
            acceptance_contract: {
              output: "verdict",
              gate_key: "plan_acceptance",
              subject_kind: "quest_plan",
              subject_artifact_id: "plan-v2",
            },
          },
        },
      },
      input.worker_id,
    );

    expect(decoded.execution.work.inputs.quest_plan?.version).toBe(2);
    expect(decoded.execution.work.acceptance_contract).toEqual({
      output: "verdict",
      gate_key: "plan_acceptance",
      subject_kind: "quest_plan",
      subject_artifact_id: "plan-v2",
    });
  });

  test("preserves unsupported reasoning and explicit tool enforcement", () => {
    const input = action();
    input.execution.configuration.reasoning = null;
    input.execution.configuration.reasoning_capability = {
      kind: "unsupported",
    };
    input.execution.configuration.tool_policy = { kind: "native_permissions" };
    input.execution.configuration.tool_enforcement = "native_permissions";
    const decoded = decodeExecuteAction(input, input.worker_id);

    expect(decoded.execution.configuration.reasoning).toBeNull();
    expect(decoded.execution.configuration.tool_policy).toEqual({
      kind: "native_permissions",
    });
    expect(decoded.execution.configuration.tool_enforcement).toBe(
      "native_permissions",
    );
  });

  test("rejects null without unsupported evidence and malformed capability evidence", () => {
    const enumeratedNull = action();
    enumeratedNull.execution.configuration.reasoning = null;
    expect(() =>
      decodeExecuteAction(enumeratedNull, enumeratedNull.worker_id),
    ).toThrow("must exactly match");

    const unsupportedValue = action();
    unsupportedValue.execution.configuration.reasoning_capability = {
      kind: "unsupported",
    };
    expect(() =>
      decodeExecuteAction(unsupportedValue, unsupportedValue.worker_id),
    ).toThrow("must exactly match");

    const unknown = action() as unknown as Record<string, unknown>;
    const execution = unknown.execution as Record<string, unknown>;
    const configuration = execution.configuration as Record<string, unknown>;
    configuration.reasoning = null;
    configuration.reasoning_capability = { kind: "unknown" };
    expect(() => decodeExecuteAction(unknown, "worker-test")).toThrow(
      "invalid reasoning capability",
    );
  });

  test("rejects protocol v2", () => {
    expect(() =>
      decodeExecuteAction({ ...action(), protocol_version: 2 }, "worker-test"),
    ).toThrow("protocol_version");
  });

  test("validates artifact values and unique declared outputs", () => {
    const input = action();
    expect(() =>
      decodeExecuteAction(
        {
          ...input,
          execution: {
            ...input.execution,
            work: {
              ...input.execution.work,
              declared_outputs: [
                { name: "x", kind: "result" },
                { name: "x", kind: "result" },
              ],
            },
          },
        },
        "worker-test",
      ),
    ).toThrow("unique output names");
    expect(() =>
      decodeExecuteAction(
        {
          ...input,
          execution: {
            ...input.execution,
            work: {
              ...input.execution.work,
              inputs: {
                bad: {
                  id: "a",
                  kind: "bad",
                  output_name: "input",
                  producer_occurrence_id: "o",
                  value: Number.NaN,
                },
              },
            },
          },
        },
        "worker-test",
      ),
    ).toThrow("JSON-compatible");
  });
});

describe("Worker Protocol v15 harness setup codec", () => {
  test("requires the explicit exact ToolPolicy discriminator", () => {
    const input = setupCommand();
    expect(decodePrepareHarnessSetup(input, "worker-test", 7)).toEqual(input);

    const missingKind = structuredClone(input) as unknown as {
      setup: { configuration: { tool_policy: Record<string, unknown> } };
    };
    delete missingKind.setup.configuration.tool_policy.kind;
    expect(() =>
      decodePrepareHarnessSetup(missingKind, "worker-test", 7),
    ).toThrow("invalid tool policy");

    const unknownKind = structuredClone(input) as unknown as {
      setup: { configuration: { tool_policy: Record<string, unknown> } };
    };
    unknownKind.setup.configuration.tool_policy.kind = "inferred_exact";
    expect(() =>
      decodePrepareHarnessSetup(unknownKind, "worker-test", 7),
    ).toThrow("invalid tool policy");

    const malformedTools = structuredClone(input) as unknown as {
      setup: { configuration: { tool_policy: Record<string, unknown> } };
    };
    malformedTools.setup.configuration.tool_policy.tools = "terminal.shell";
    expect(() =>
      decodePrepareHarnessSetup(malformedTools, "worker-test", 7),
    ).toThrow("must be an array");
  });
});

function setupCommand(): PrepareHarnessSetupCommand {
  const tools = ["workspace.filesystem", "workspace.search", "terminal.shell"];
  return {
    type: "prepare_harness_setup",
    protocol_version: WORKER_PROTOCOL_VERSION,
    worker_id: "worker-test",
    connection_generation: 7,
    setup: {
      setup_id: "setup-1",
      setup_generation: 1,
      authorization_id: "authorization-1",
      authorization_kind: "human_harness_setup",
      authorized_at: "2026-10-11T00:00:00Z",
      action_id: "action-1",
      run_id: "run-1",
      occurrence_id: "occurrence-1",
      member_key: "operator",
      harness_kind: "claude_agent_sdk",
      physical_lineage_id: "physical-lineage-1",
      logical_lineage_id: "logical-lineage-1",
      workspace_id: "workspace-1",
      worktree_id: "worktree-1",
      workspace_binding_id: "binding-1",
      canonical_root: "/workspace",
      workspace_access: "read_write",
      profile: {
        id: "qe-coding-execution-v3",
        digest: "sha256:profile-v3",
      },
      configuration: {
        model: { provider: "anthropic", model: "claude-sonnet-5" },
        reasoning: "high",
        reasoning_capability: { kind: "enumerated", values: ["high"] },
        tool_policy: { kind: "exact", tools },
        tool_enforcement: "exact",
        resolved_tool_profile: { tools },
      },
    },
  };
}
