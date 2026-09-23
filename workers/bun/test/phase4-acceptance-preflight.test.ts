import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Phase4PreflightManifest,
  runPhase4AcceptancePreflight,
} from "../scripts/phase4-acceptance-preflight.ts";

test("Phase-4 acceptance preflight fails before side effects when local attachment is disabled", async () => {
  await expect(
    runPhase4AcceptancePreflight({} as Phase4PreflightManifest, {
      QE_LOCAL_SESSION_ATTACH_ENABLED: "false",
    }),
  ).rejects.toThrow(
    "QE_LOCAL_SESSION_ATTACH_ENABLED must equal true in the Phoenix acceptance launcher",
  );
});

test("Phase-4 acceptance preflight rejects launcher-only attachment configuration", async () => {
  if (process.platform !== "darwin") return;
  await mkdir(join(process.cwd(), ".pi", "tmp"), { recursive: true });
  const root = await mkdtemp(
    join(process.cwd(), ".pi", "tmp", "preflight-health-"),
  );
  try {
    await git(root, ["init", "-q", "-b", "main"]);
    await writeFile(join(root, "README.md"), "# preflight\n");
    await git(root, ["add", "README.md"]);
    await git(root, [
      "-c",
      "user.name=Quest Engineering",
      "-c",
      "user.email=quest@example.invalid",
      "commit",
      "-q",
      "-m",
      "fixture",
    ]);
    const head = await git(root, ["rev-parse", "HEAD"]);
    const manifest: Phase4PreflightManifest = {
      schemaVersion: 1,
      source: {
        repositoryRoot: root,
        repositoryIdentity: "fixture-identity",
        expectedHead: head,
        expectedRefs: ["refs/heads/main"],
        sourceSnapshotBefore: "same",
        sourceSnapshotAfter: "same",
      },
      product: {
        workspaceId: "workspace-id",
        workspaceBindingId: "binding-id",
        fresh: true,
      },
      controlPlane: {
        baseUrl: "http://127.0.0.1:4000",
        runId: "run-id",
        attemptId: "attempt-id",
        actionId: "action-id",
        sessionId: "lineage-id",
        diagnosticWorkerId: "diagnostic-worker",
      },
      worker: {
        registered: true,
        workerId: "diagnostic-worker",
        dispatchAvailability: "maintenance",
        profileId: "qe-pi-execution-v2",
        profileDigest: "sha256:profile",
        piVersion: "0.85.1",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoning: "medium",
        modelReady: true,
        schedulable: false,
      },
      herdr: {
        executable: "/usr/bin/true",
        explicitLaunch: true,
        attested: true,
        sessionName: "session",
        paneId: "w2:p1",
        terminalId: "terminal",
        nativeState: "idle",
      },
      environment: {
        sbxAttested: true,
        privateGit: true,
        privateDocker: true,
        oauthReady: true,
        controlMailboxReady: true,
      },
      lifecycle: {
        delayedResultRegression: true,
        responseLossReconciled: true,
        exportSuccess: true,
        exportFailureCovered: true,
        workingToIdle: true,
        retainedRestartIdle: true,
      },
      counters: { prompts: 0, providerCycles: 0 },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          status: "ok",
          capabilities: { local_session_attachment: false },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    try {
      await expect(
        runPhase4AcceptancePreflight(manifest, {
          QE_LOCAL_SESSION_ATTACH_ENABLED: "true",
        }),
      ).rejects.toThrow(
        "Phoenix does not report effective local-session attachment capability",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function git(root: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["/usr/bin/git", "-C", root, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(stderr);
  return stdout.trim();
}
