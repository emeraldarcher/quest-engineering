import { expect, test } from "bun:test";
import {
  type Phase5AntigravityPreflightManifest,
  runPhase5AntigravityProductPreflight,
} from "../scripts/phase5-antigravity-product-preflight.ts";
import { SBX_CODING_EXECUTION_PROFILE_V1 } from "../src/execution-environment/sbx-profile.ts";

const manifest: Phase5AntigravityPreflightManifest = {
  schemaVersion: 1,
  product: {
    baseUrl: "http://127.0.0.1:4000",
    workspaceId: "workspace-1",
    runId: "run-1",
    attemptId: "attempt-1",
    sessionId: "session-1",
  },
  worker: {
    workerId: "worker-1",
    registered: true,
    dispatchAvailability: "maintenance",
    schedulable: false,
    profileId: "qe-coding-execution-v1",
    profileDigest: SBX_CODING_EXECUTION_PROFILE_V1.digest,
    antigravityVersion: "1.2.7",
    provider: "antigravity",
    model: "gemini-3.8-flash-high",
    reasoning: "high",
    modelReady: true,
  },
  herdr: {
    explicitLaunch: true,
    attested: true,
    sessionName: "herdr-1",
    paneId: "pane-1",
    terminalId: "terminal-1",
    nativeState: "idle",
  },
  environment: {
    sbxAttested: true,
    privateGit: true,
    privateHome: true,
    privateDocker: true,
    hostCredentialProxy: true,
    guestRefreshDisabled: true,
    controlMailboxReady: true,
    mcpChildReady: true,
    stopHookReady: true,
  },
  counters: { prompts: 0, providerCycles: 0 },
};

test("Phase-5 Product preflight fails before requests unless attachment is explicit", async () => {
  let calls = 0;
  await expect(
    runPhase5AntigravityProductPreflight(manifest, {
      env: {},
      fetch: async () => {
        calls += 1;
        return new Response();
      },
    }),
  ).rejects.toThrow("QE_LOCAL_SESSION_ATTACH_ENABLED");
  expect(calls).toBe(0);
});

test("Phase-5 Product preflight proves maintenance scheduling and exact Work Yard attachment", async () => {
  const calls: Array<{ path: string; method: string }> = [];
  const response = await runPhase5AntigravityProductPreflight(manifest, {
    env: { QE_LOCAL_SESSION_ATTACH_ENABLED: "true" },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push({ path: url.pathname, method: init?.method ?? "GET" });
      if (url.pathname === "/api/v1/health")
        return Response.json({
          status: "ok",
          capabilities: { local_session_attachment: true },
        });
      if (url.pathname === "/api/v1/execution-options")
        return Response.json({
          execution_options: [
            {
              available: false,
              harness: "antigravity",
              model: {
                provider: "antigravity",
                model: "gemini-3.8-flash-high",
              },
              reasoning_capability: {
                kind: "enumerated",
                values: ["high"],
              },
              workspaces: [
                {
                  workspace_id: "workspace-1",
                  workspace_access: ["read_write"],
                },
              ],
            },
          ],
        });
      return Response.json({
        attachment: {
          mode: "local_native_terminal",
          worker_id: "worker-1",
          session_id: "session-1",
          terminal: {
            backend_kind: "herdr",
            terminal_session_id: "herdr-1",
            terminal_target_id: "pane-1",
            terminal_id: "terminal-1",
            supports_observation: true,
            supports_takeover: true,
          },
        },
      });
    },
  });
  expect(response).toMatchObject({
    accepted: true,
    dispatchAvailability: "maintenance",
    prompts: 0,
    providerCycles: 0,
  });
  expect(calls).toEqual([
    { path: "/api/v1/health", method: "GET" },
    { path: "/api/v1/execution-options", method: "GET" },
    {
      path: "/api/v1/runs/run-1/attempts/attempt-1/sessions/session-1/attachment",
      method: "POST",
    },
  ]);
});
