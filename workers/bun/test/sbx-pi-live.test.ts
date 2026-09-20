import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { SbxExecutionEnvironmentBackend } from "../src/execution-environment/sbx-backend.ts";
import {
  SBX_DISPOSABLE_RESOURCE_POLICY,
  SBX_PI_DISCOVERY_SCRIPT,
  SBX_PI_EXECUTION_PROFILE_V1,
  SBX_PI_PROFILE,
  SBX_PI_RUNTIME_NETWORK_TARGETS,
} from "../src/execution-environment/sbx-profile.ts";
import type { EnvironmentSpec } from "../src/execution-environment/types.ts";

const enabled = process.env.QE_RUN_SBX_PI_LIVE === "1";

test.skipIf(!enabled)(
  "live repository-owned Pi profile proves host OAuth discovery without inference",
  async () => {
    const parent = join(process.cwd(), ".pi", "tmp");
    await mkdir(parent, { recursive: true });
    const dataRoot = await mkdtemp(join(parent, "sbx-pi-live-"));
    const runId = `pi-live-${randomUUID()}`;
    const workerId = `pi-live-worker-${randomUUID()}`;
    const backend = new SbxExecutionEnvironmentBackend({
      workerId,
      dataRoot,
      executionProfile: SBX_PI_PROFILE,
    });
    const spec: EnvironmentSpec = {
      workerId,
      runId,
      workspace: {
        workspaceId: `workspace-${runId}`,
        access: "none",
        materialization: {
          kind: "disposable_fixture",
          sourceIdentity: "qe-pi-live-no-inference",
          frozenBase: { kind: "fixture", value: "none" },
        },
      },
      profile: SBX_PI_EXECUTION_PROFILE_V1,
      resourcePolicy: SBX_DISPOSABLE_RESOURCE_POLICY.identity,
      networkRequirements: [
        {
          capability: "model_provider",
          targets: SBX_PI_RUNTIME_NETWORK_TARGETS,
        },
      ],
      credentialGrants: [
        {
          grantId: "host-openai-oauth",
          kind: "openai-codex-oauth",
          scope: "subscription",
        },
      ],
      controlChannels: [{ kind: "worker_file_mailbox_v1", required: true }],
      requiredCapabilities: [
        { kind: "credentials", mode: "host_proxy_openai_oauth" },
        { kind: "network_policy", mode: "openai_subscription_only" },
        { kind: "harness_runtime", mode: "pi_native_extensions" },
        { kind: "control_channel", mode: "worker_file_mailbox_v1" },
      ],
    };
    let ref: Awaited<ReturnType<typeof backend.ensure>>["ref"] | null = null;
    try {
      const lease = await backend.ensure(spec);
      ref = lease.ref;
      const discovery = await lease.exec({
        executable: "/usr/bin/node",
        args: [SBX_PI_DISCOVERY_SCRIPT],
        cwd: lease.paths.workspace,
        timeoutMs: 60_000,
      });
      expect(discovery.exitCode).toBe(0);
      const value = JSON.parse(discovery.stdout) as {
        authenticated: boolean;
        models: Array<{ provider: string }>;
      };
      expect(value.authenticated).toBe(true);
      expect(value.models.length).toBeGreaterThan(0);
      expect(
        value.models.every((model) => model.provider === "openai-codex"),
      ).toBe(true);
    } finally {
      if (ref) await backend.remove(ref);
      backend.close();
    }
  },
  180_000,
);
