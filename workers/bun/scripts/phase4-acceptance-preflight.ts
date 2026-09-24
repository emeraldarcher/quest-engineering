#!/usr/bin/env bun
import { access, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

interface LocalAttachment {
  mode: string;
  worker_id: string;
  session_id: string;
  terminal?: {
    backend_kind?: string;
    terminal_session_id?: string;
    terminal_target_id?: string;
    terminal_id?: string | null;
    supports_observation?: boolean;
  };
}

export interface Phase4PreflightManifest {
  schemaVersion: 1;
  source: {
    repositoryRoot: string;
    repositoryIdentity: string;
    expectedHead: string;
    expectedRefs: string[];
    sourceSnapshotBefore: string;
    sourceSnapshotAfter: string;
  };
  product: { workspaceId: string; workspaceBindingId: string; fresh: boolean };
  controlPlane: {
    baseUrl: string;
    runId: string;
    attemptId: string;
    actionId: string;
    sessionId: string;
    diagnosticWorkerId: string;
  };
  worker: {
    registered: boolean;
    workerId: string;
    dispatchAvailability: "maintenance";
    profileId: string;
    profileDigest: string;
    piVersion: string;
    provider: string;
    model: string;
    reasoning: string;
    modelReady: boolean;
    schedulable: false;
  };
  herdr: {
    executable: string;
    explicitLaunch: boolean;
    attested: boolean;
    sessionName: string;
    paneId: string;
    terminalId: string;
    nativeState: "idle";
  };
  environment: {
    sbxAttested: boolean;
    privateGit: boolean;
    privateDocker: boolean;
    oauthReady: boolean;
    controlMailboxReady: boolean;
  };
  lifecycle: {
    delayedResultRegression: boolean;
    responseLossReconciled: boolean;
    exportSuccess: boolean;
    exportFailureCovered: boolean;
    workingToIdle: boolean;
    retainedRestartIdle: boolean;
  };
  counters: { prompts: 0; providerCycles: 0 };
}

export async function runPhase4AcceptancePreflight(
  manifest: Phase4PreflightManifest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown>> {
  requireCondition(
    env.QE_LOCAL_SESSION_ATTACH_ENABLED === "true",
    "QE_LOCAL_SESSION_ATTACH_ENABLED must equal true in the Phoenix acceptance launcher.",
  );
  requireCondition(
    process.platform === "darwin",
    "Local attachment requires macOS.",
  );
  await access("/usr/bin/osascript");
  requireCondition(
    manifest.schemaVersion === 1,
    "Unsupported preflight manifest.",
  );
  const repositoryRoot = resolve(manifest.source.repositoryRoot);
  requireCondition(
    isAbsolute(manifest.source.repositoryRoot),
    "Fresh fixture repository path must be absolute.",
  );
  const head = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  const refs = splitLines(
    await git(repositoryRoot, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/heads",
      "refs/tags",
      "refs/qe",
    ]),
  ).sort();
  const qeRefs = splitLines(
    await git(repositoryRoot, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/heads/qe/run",
      "refs/qe",
    ]),
  );
  const status = await git(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  requireCondition(
    head === manifest.source.expectedHead,
    "Fixture HEAD changed.",
  );
  requireCondition(
    qeRefs.length === 0,
    "Fresh fixture contains historical QE refs.",
  );
  requireCondition(status === "", "Fresh fixture is not clean.");
  requireCondition(
    JSON.stringify(refs) ===
      JSON.stringify([...manifest.source.expectedRefs].sort()),
    "Fresh fixture refs differ from the exact baseline.",
  );
  requireCondition(
    manifest.source.sourceSnapshotBefore ===
      manifest.source.sourceSnapshotAfter,
    "Source repository changed during dry-run materialization.",
  );
  requireCondition(manifest.product.fresh, "Workspace/binding is not fresh.");
  requireCondition(manifest.worker.registered, "Worker is not registered.");
  requireCondition(
    manifest.worker.profileId === "qe-pi-execution-v2" &&
      manifest.worker.piVersion === "0.85.1",
    "The immutable Pi 0.85.1 execution profile is not selected.",
  );
  requireCondition(
    manifest.worker.provider === "openai-codex" &&
      manifest.worker.model === "gpt-5.6-sol" &&
      manifest.worker.reasoning === "medium" &&
      manifest.worker.modelReady &&
      manifest.worker.dispatchAvailability === "maintenance" &&
      manifest.worker.schedulable === false,
    "The exact Sol/medium model must be ready behind a maintenance dispatch barrier.",
  );
  requireCondition(
    manifest.herdr.explicitLaunch && manifest.herdr.attested,
    "Patched Herdr explicit launch is not attested.",
  );
  requireCondition(
    manifest.herdr.nativeState === "idle",
    "Pre-prompt Pi/Herdr native state is not idle.",
  );
  requireCondition(
    Object.values(manifest.environment).every(Boolean),
    "SBX/private-Git/private-Docker/OAuth/mailbox readiness is incomplete.",
  );
  requireCondition(
    Object.values(manifest.lifecycle).every(Boolean),
    "Structured-completion or retained-idle lifecycle gates are incomplete.",
  );
  requireCondition(
    manifest.counters.prompts === 0 && manifest.counters.providerCycles === 0,
    "No-inference counters are nonzero.",
  );
  requireCondition(
    isAbsolute(manifest.herdr.executable),
    "The patched Herdr executable must be absolute.",
  );
  await access(manifest.herdr.executable);

  await validateEffectiveControlPlane(manifest);
  const attachment = await requestAttachment(manifest.controlPlane);
  requireCondition(
    attachment.mode === "local_native_terminal" &&
      attachment.worker_id === manifest.controlPlane.diagnosticWorkerId &&
      attachment.session_id === manifest.controlPlane.sessionId &&
      attachment.terminal?.backend_kind === "herdr" &&
      attachment.terminal?.terminal_session_id === manifest.herdr.sessionName &&
      attachment.terminal?.terminal_target_id === manifest.herdr.paneId &&
      attachment.terminal?.terminal_id === manifest.herdr.terminalId &&
      attachment.terminal?.supports_observation === true,
    "Control-plane attachment descriptor does not match the pre-prompt pane.",
  );
  await validateHerdrTarget(
    manifest.herdr.executable,
    manifest.herdr.sessionName,
    manifest.herdr.paneId,
    manifest.worker,
    manifest.controlPlane.runId,
    manifest.controlPlane.actionId,
    manifest.controlPlane.sessionId,
  );

  return {
    accepted: true,
    checkedAt: new Date().toISOString(),
    repositoryIdentity: manifest.source.repositoryIdentity,
    workspaceId: manifest.product.workspaceId,
    workspaceBindingId: manifest.product.workspaceBindingId,
    profileId: manifest.worker.profileId,
    profileDigest: manifest.worker.profileDigest,
    model: `${manifest.worker.provider}/${manifest.worker.model}`,
    reasoning: manifest.worker.reasoning,
    localSessionAttachEnabled: true,
    dispatchAvailability: "maintenance",
    openSessionInputlessProbe: true,
    prompts: 0,
    providerCycles: 0,
  };
}

async function validateEffectiveControlPlane(
  manifest: Phase4PreflightManifest,
): Promise<void> {
  const base = new URL(manifest.controlPlane.baseUrl);
  requireCondition(
    ["127.0.0.1", "localhost", "::1"].includes(base.hostname),
    "Acceptance control plane must be loopback-local.",
  );
  const healthResponse = await fetch(new URL("/api/v1/health", base));
  const health = (await healthResponse.json()) as {
    status?: string;
    capabilities?: { local_session_attachment?: boolean };
  };
  requireCondition(
    healthResponse.ok &&
      health.status === "ok" &&
      health.capabilities?.local_session_attachment === true,
    "Phoenix does not report effective local-session attachment capability.",
  );

  const optionsResponse = await fetch(
    new URL("/api/v1/execution-options", base),
  );
  const optionsBody = (await optionsResponse.json()) as {
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
  const exact = optionsBody.execution_options?.find(
    (option) =>
      option.harness === "pi" &&
      option.model?.provider === manifest.worker.provider &&
      option.model?.model === manifest.worker.model &&
      option.reasoning_capability?.kind === "enumerated" &&
      option.reasoning_capability.values?.includes(manifest.worker.reasoning) &&
      option.workspaces?.some(
        (workspace) =>
          workspace.workspace_id === manifest.product.workspaceId &&
          workspace.workspace_access?.includes("read_write"),
      ),
  );
  requireCondition(
    optionsResponse.ok && exact && exact.available === false,
    "The exact preflight Worker/model is absent or dispatch-eligible instead of maintenance-gated.",
  );
}

async function requestAttachment(
  control: Phase4PreflightManifest["controlPlane"],
): Promise<LocalAttachment> {
  const base = new URL(control.baseUrl);
  requireCondition(
    ["127.0.0.1", "localhost", "::1"].includes(base.hostname),
    "Acceptance control plane must be loopback-local.",
  );
  const path = `/api/v1/runs/${encodeURIComponent(control.runId)}/attempts/${encodeURIComponent(control.attemptId)}/sessions/${encodeURIComponent(control.sessionId)}/attachment`;
  const response = await fetch(new URL(path, base), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-quest-engineering-local-client": "tauri",
    },
    body: "{}",
  });
  const body = (await response.json()) as {
    attachment?: LocalAttachment;
    error?: unknown;
  };
  requireCondition(
    response.ok && body.attachment,
    `Open Session preflight failed (${response.status}): ${JSON.stringify(body.error ?? body)}`,
  );
  return body.attachment;
}

async function validateHerdrTarget(
  executable: string,
  sessionName: string,
  paneId: string,
  worker: Phase4PreflightManifest["worker"],
  runId: string,
  actionId: string,
  lineageId: string,
): Promise<void> {
  const sessions = JSON.parse(
    await command(executable, ["session", "list", "--json"]),
  ) as { sessions?: Array<{ name?: string; running?: boolean }> };
  requireCondition(
    sessions.sessions?.some(
      (session) => session.name === sessionName && session.running === true,
    ) === true,
    "The exact Herdr session is not running.",
  );
  const agent = JSON.parse(
    await command(executable, [
      "--session",
      sessionName,
      "agent",
      "get",
      paneId,
    ]),
  );
  const encoded = JSON.stringify(agent);
  requireCondition(
    encoded.includes('"qe_owner":"quest-engineering-worker/v1"'),
    "Herdr target lacks QE ownership.",
  );
  requireCondition(
    encoded.includes(`"qe_worker_id":"${worker.workerId}"`),
    "Herdr target Worker differs.",
  );
  requireCondition(
    encoded.includes(`"qe_run_id":"${runId}"`),
    "Herdr target Run differs.",
  );
  requireCondition(
    encoded.includes(`"qe_active_action_id":"${actionId}"`),
    "Herdr target Action differs.",
  );
  requireCondition(
    encoded.includes(`"qe_lineage_id":"${lineageId}"`),
    "Herdr target lineage differs.",
  );
  requireCondition(
    encoded.includes('"status":"idle"') ||
      encoded.includes('"agent_status":"idle"'),
    "Herdr target is not natively idle.",
  );
}

async function git(root: string, args: string[]): Promise<string> {
  return command("/usr/bin/git", ["-C", root, ...args]);
}

async function command(executable: string, args: string[]): Promise<string> {
  const child = Bun.spawn([executable, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(`${executable} ${args.join(" ")} failed: ${stderr.trim()}`);
  return stdout.trim();
}

function splitLines(value: string): string[] {
  return value ? value.split("\n").filter(Boolean) : [];
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
    throw new Error("Usage: phase4-acceptance-preflight.ts MANIFEST.json");
  const manifest = JSON.parse(
    await readFile(resolve(path), "utf8"),
  ) as Phase4PreflightManifest;
  console.log(
    JSON.stringify(await runPhase4AcceptancePreflight(manifest), null, 2),
  );
}
