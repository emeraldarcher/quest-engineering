import { describe, expect, test } from "bun:test";
import {
  decodeAdmitWorkspaceToolBroker,
  decodePrepareWorkspaceToolBroker,
  decodeRetireWorkspaceToolBroker,
} from "../src/protocol/codec.ts";
import {
  decodeWorkspaceToolRequest,
  decodeWorkspaceToolResponse,
  MAX_BROKER_COMMAND_BYTES,
  MAX_BROKER_FILE_BYTES,
  MAX_BROKER_PATH_BYTES,
  MAX_BROKER_QUERY_BYTES,
  WORKSPACE_TOOL_BROKER_PROTOCOL,
} from "../src/workspace-tool-broker-protocol.ts";

const workerId = "worker-broker";
const generation = 4;

describe("workspace tool broker protocol", () => {
  test("strictly decodes exact Product preparation authority", () => {
    expect(
      decodePrepareWorkspaceToolBroker(prepareCommand(), workerId, generation),
    ).toMatchObject({
      broker: {
        provider_account_id: "account-1",
        run_id: "run-1",
        action_id: "action-1",
        workspace_access: "read_write",
      },
    });
    expect(() =>
      decodePrepareWorkspaceToolBroker(
        { ...prepareCommand(), model_authority: "forged" },
        workerId,
        generation,
      ),
    ).toThrow("unexpected or missing fields");
    expect(() =>
      decodePrepareWorkspaceToolBroker(
        { ...prepareCommand(), connection_generation: generation + 1 },
        workerId,
        generation,
      ),
    ).toThrow("connection_generation");
  });

  test("strictly decodes admission and retirement fences", () => {
    expect(
      decodeAdmitWorkspaceToolBroker(
        {
          type: "admit_workspace_tool_broker",
          protocol_version: 18,
          worker_id: workerId,
          connection_generation: generation,
          authorization_id: "authorization-1",
        },
        workerId,
        generation,
      ),
    ).toMatchObject({ authorization_id: "authorization-1" });
    expect(
      decodeRetireWorkspaceToolBroker(
        {
          type: "retire_workspace_tool_broker",
          protocol_version: 18,
          worker_id: workerId,
          connection_generation: generation,
          authorization_id: "authorization-1",
          reason: "execution_cancelled",
        },
        workerId,
        generation,
      ),
    ).toMatchObject({ reason: "execution_cancelled" });
  });

  test("account-cell requests cannot supply execution, policy, workspace, or environment authority", () => {
    const request = {
      version: "workspace_tool_broker_v1",
      type: "request",
      request_id: "request-1",
      operation: "filesystem.read",
      arguments: { path: "README.md" },
    } as const;
    expect(decodeWorkspaceToolRequest(request)).toEqual(request);
    for (const field of [
      "run_id",
      "action_id",
      "attempt_id",
      "workspace_id",
      "workspace_root",
      "physical_lineage_id",
      "provider_account_id",
      "credential_generation",
      "resolved_tool_profile",
      "environment_id",
      "incarnation",
      "worker_id",
      "worker_generation",
      "broker_generation",
      "capability",
    ]) {
      expect(() =>
        decodeWorkspaceToolRequest({ ...request, [field]: "forged" }),
      ).toThrow("unexpected or missing fields");
      expect(() =>
        decodeWorkspaceToolRequest({
          ...request,
          arguments: { ...request.arguments, [field]: "forged" },
        }),
      ).toThrow("unexpected or missing fields");
    }
  });

  test("bounds every operation and enforces exact response lifecycle", () => {
    const base = {
      version: WORKSPACE_TOOL_BROKER_PROTOCOL,
      type: "request" as const,
      request_id: "bounded-request",
    };
    expect(() =>
      decodeWorkspaceToolRequest({
        ...base,
        operation: "filesystem.read",
        arguments: { path: "x".repeat(MAX_BROKER_PATH_BYTES + 1) },
      }),
    ).toThrow("path");
    expect(() =>
      decodeWorkspaceToolRequest({
        ...base,
        operation: "filesystem.write",
        arguments: {
          path: "x",
          content: "x".repeat(MAX_BROKER_FILE_BYTES + 1),
        },
      }),
    ).toThrow("content");
    expect(() =>
      decodeWorkspaceToolRequest({
        ...base,
        operation: "search.grep",
        arguments: {
          path: ".",
          query: "x".repeat(MAX_BROKER_QUERY_BYTES + 1),
        },
      }),
    ).toThrow("query");
    expect(() =>
      decodeWorkspaceToolRequest({
        ...base,
        operation: "terminal.shell",
        arguments: {
          command: "x".repeat(MAX_BROKER_COMMAND_BYTES + 1),
          cwd: ".",
          timeout_ms: 5_000,
        },
      }),
    ).toThrow("command");

    const completed = {
      version: WORKSPACE_TOOL_BROKER_PROTOCOL,
      type: "response",
      request_id: "bounded-request",
      status: "completed",
      certainty: "completed",
      result: { path: "README.md" },
      error: null,
    } as const;
    expect(decodeWorkspaceToolResponse(completed)).toEqual(completed);
    expect(() =>
      decodeWorkspaceToolResponse({
        ...completed,
        certainty: "uncertain",
      }),
    ).toThrow("lifecycle");
    expect(() =>
      decodeWorkspaceToolResponse({ ...completed, credential: "forged" }),
    ).toThrow("unexpected or missing fields");
  });
});

function prepareCommand() {
  return {
    type: "prepare_workspace_tool_broker",
    protocol_version: 18,
    worker_id: workerId,
    connection_generation: generation,
    broker: {
      authorization_id: "authorization-1",
      provider_account_id: "account-1",
      credential_generation: 2,
      account_environment_generation: 1,
      account_environment: {
        backend_kind: "fake",
        environment_id: "account-environment",
        incarnation: "account-incarnation",
      },
      run_id: "run-1",
      action_id: "action-1",
      occurrence_id: "occurrence-1",
      attempt_id: "attempt-1",
      operational_epoch: 0,
      operational_attempt: 1,
      workspace_id: "workspace-1",
      worktree_id: "worktree-1",
      workspace_binding_id: "binding-1",
      workspace_access: "read_write",
      resolved_tool_profile: {
        tools: ["workspace.filesystem", "workspace.search", "terminal.shell"],
      },
    },
  };
}
