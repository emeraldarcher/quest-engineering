#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SBX_CODING_EXECUTION_PROFILE_V1 } from "../src/execution-environment/sbx-profile.ts";

export interface Phase5AntigravityPreflightManifest {
  schemaVersion: 1;
  product: {
    baseUrl: string;
    workspaceId: string;
    runId: string;
    attemptId: string;
    sessionId: string;
  };
  worker: {
    workerId: string;
    registered: true;
    dispatchAvailability: "maintenance";
    schedulable: false;
    profileId: "qe-coding-execution-v1";
    profileDigest: string;
    antigravityVersion: "1.2.7";
    provider: "antigravity";
    model: string;
    reasoning: string | null;
    modelReady: true;
  };
  herdr: {
    explicitLaunch: true;
    attested: true;
    sessionName: string;
    paneId: string;
    terminalId: string;
    nativeState: "idle";
  };
  environment: {
    sbxAttested: true;
    privateGit: true;
    privateHome: true;
    privateDocker: true;
    hostCredentialProxy: true;
    guestRefreshDisabled: true;
    controlMailboxReady: true;
    mcpChildReady: true;
    stopHookReady: true;
  };
  counters: { prompts: 0; providerCycles: 0 };
}

interface Attachment {
  mode?: string;
  worker_id?: string;
  session_id?: string;
  terminal?: {
    backend_kind?: string;
    terminal_session_id?: string;
    terminal_target_id?: string;
    terminal_id?: string | null;
    supports_observation?: boolean;
    supports_takeover?: boolean;
  };
}

type PreflightFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export async function runPhase5AntigravityProductPreflight(
  manifest: Phase5AntigravityPreflightManifest,
  options: {
    env?: NodeJS.ProcessEnv;
    fetch?: PreflightFetch;
  } = {},
): Promise<Record<string, unknown>> {
  const env = options.env ?? process.env;
  const request: PreflightFetch = options.fetch ?? fetch;
  requireCondition(
    env.QE_LOCAL_SESSION_ATTACH_ENABLED === "true",
    "QE_LOCAL_SESSION_ATTACH_ENABLED must equal true for Product preflight.",
  );
  requireCondition(manifest.schemaVersion === 1, "Unsupported manifest.");
  const base = new URL(manifest.product.baseUrl);
  requireCondition(
    ["127.0.0.1", "localhost", "::1"].includes(base.hostname),
    "Product preflight must target a loopback control plane.",
  );
  requireCondition(
    manifest.worker.registered &&
      manifest.worker.dispatchAvailability === "maintenance" &&
      manifest.worker.schedulable === false,
    "The diagnostic Worker is not maintenance-gated.",
  );
  requireCondition(
    manifest.worker.profileId === SBX_CODING_EXECUTION_PROFILE_V1.id &&
      manifest.worker.profileDigest ===
        SBX_CODING_EXECUTION_PROFILE_V1.digest &&
      manifest.worker.antigravityVersion === "1.2.7" &&
      manifest.worker.provider === "antigravity" &&
      manifest.worker.model.length > 0 &&
      manifest.worker.modelReady,
    "The exact mixed-profile Antigravity selection is not ready.",
  );
  requireCondition(
    manifest.herdr.explicitLaunch &&
      manifest.herdr.attested &&
      manifest.herdr.nativeState === "idle",
    "The pre-prompt Antigravity explicit launch is not idle and attested.",
  );
  requireCondition(
    Object.values(manifest.environment).every(Boolean),
    "SBX, credential, MCP, Stop-hook, or control readiness is incomplete.",
  );
  requireCondition(
    manifest.counters.prompts === 0 && manifest.counters.providerCycles === 0,
    "No-inference counters are nonzero.",
  );

  const healthResponse = await request(new URL("/api/v1/health", base));
  const health = (await healthResponse.json()) as {
    status?: string;
    capabilities?: { local_session_attachment?: boolean };
  };
  requireCondition(
    healthResponse.ok &&
      health.status === "ok" &&
      health.capabilities?.local_session_attachment === true,
    "Product does not expose effective local attachment.",
  );

  const optionResponse = await request(
    new URL("/api/v1/execution-options", base),
  );
  const optionBody = (await optionResponse.json()) as {
    execution_options?: Array<{
      available?: boolean;
      harness?: string;
      model?: { provider?: string; model?: string };
      reasoning_capability?: { kind?: string; values?: string[] };
      workspaces?: Array<{
        workspace_id?: string;
        workspace_access?: string[];
      }>;
    }>;
  };
  const exactOption = optionBody.execution_options?.find(
    (option) =>
      option.harness === "antigravity" &&
      option.model?.provider === manifest.worker.provider &&
      option.model?.model === manifest.worker.model &&
      reasoningMatches(
        option.reasoning_capability,
        manifest.worker.reasoning,
      ) &&
      option.workspaces?.some(
        (workspace) =>
          workspace.workspace_id === manifest.product.workspaceId &&
          workspace.workspace_access?.includes("read_write"),
      ),
  );
  requireCondition(
    optionResponse.ok && exactOption?.available === false,
    "The exact Antigravity option is absent or dispatch-eligible instead of maintenance-gated.",
  );

  const attachmentPath = `/api/v1/runs/${encodeURIComponent(manifest.product.runId)}/attempts/${encodeURIComponent(manifest.product.attemptId)}/sessions/${encodeURIComponent(manifest.product.sessionId)}/attachment`;
  const attachmentResponse = await request(new URL(attachmentPath, base), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-quest-engineering-local-client": "tauri",
    },
    body: "{}",
  });
  const attachmentBody = (await attachmentResponse.json()) as {
    attachment?: Attachment;
  };
  const attachment = attachmentBody.attachment;
  requireCondition(
    attachmentResponse.ok &&
      attachment?.mode === "local_native_terminal" &&
      attachment.worker_id === manifest.worker.workerId &&
      attachment.session_id === manifest.product.sessionId &&
      attachment.terminal?.backend_kind === "herdr" &&
      attachment.terminal.terminal_session_id === manifest.herdr.sessionName &&
      attachment.terminal.terminal_target_id === manifest.herdr.paneId &&
      attachment.terminal.terminal_id === manifest.herdr.terminalId &&
      attachment.terminal.supports_observation === true &&
      attachment.terminal.supports_takeover === true,
    "Open Session does not resolve the exact idle Antigravity pane.",
  );

  return {
    accepted: true,
    checkedAt: new Date().toISOString(),
    profileId: manifest.worker.profileId,
    profileDigest: manifest.worker.profileDigest,
    model: `${manifest.worker.provider}/${manifest.worker.model}`,
    reasoning: manifest.worker.reasoning,
    dispatchAvailability: "maintenance",
    prompts: 0,
    providerCycles: 0,
  };
}

function reasoningMatches(
  capability: { kind?: string; values?: string[] } | undefined,
  reasoning: string | null,
): boolean {
  return reasoning === null
    ? capability?.kind === "unsupported"
    : capability?.kind === "enumerated" &&
        capability.values?.includes(reasoning) === true;
}

function requireCondition(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path)
    throw new Error(
      "Usage: phase5-antigravity-product-preflight.ts MANIFEST.json",
    );
  const manifest = JSON.parse(
    await readFile(resolve(path), "utf8"),
  ) as Phase5AntigravityPreflightManifest;
  console.log(
    JSON.stringify(
      await runPhase5AntigravityProductPreflight(manifest),
      null,
      2,
    ),
  );
}
