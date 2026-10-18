import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type ProviderAccountEnvironmentCommand,
  ProviderAccountEnvironmentManager,
} from "../src/execution-environment/provider-account.ts";
import { SbxExecutionEnvironmentBackend } from "../src/execution-environment/sbx-backend.ts";
import {
  SBX_CLAUDE_ACCOUNT_PROFILE,
  SBX_DISPOSABLE_RESOURCE_POLICY,
} from "../src/execution-environment/sbx-profile.ts";
import { ExecutionEnvironmentStore } from "../src/execution-environment/store.ts";
import type { ProviderAccountSetupCommand } from "../src/protocol/types.ts";
import {
  ProviderAccountSetupCoordinator,
  type ProviderAccountSetupReport,
} from "../src/provider-account-setup.ts";
import { ProviderAccountSetupStore } from "../src/provider-account-setup-store.ts";
import {
  PHYSICAL_ACCEPTANCE_FIXTURE_EXECUTABLE,
  PhysicalAcceptanceSetupLauncher,
  physicalAcceptanceAuthentication,
} from "./support/provider-account-setup-launcher.ts";

const live = process.env.QE_LIVE_SBX === "1";

// Zero-provider physical proof. The production manager owns a real account SBX
// and invokes its generic EnvironmentLease.spawnStreamed path with only the
// directly injected test launcher and deterministic auth inspector.
test.skipIf(!live)(
  "real ProviderAccount SBX streams the Claude-shaped fixture without provider activity",
  async () => {
    const parent = join(process.cwd(), ".pi", "tmp");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "provider-account-setup-live-"));
    const interactionPublicKey = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    }).publicKey.export({ format: "pem", type: "pkcs1" }) as string;
    const workerId = `setup-live-worker-${Date.now()}`;
    const accountId = `setup-live-account-${Date.now()}`;
    const secret = `QE_FAKE_CLAUDE_LOGIN_INTERACTION_SECRET_${Date.now()}`;
    const store = new ExecutionEnvironmentStore(root);
    const backend = new SbxExecutionEnvironmentBackend({
      workerId,
      dataRoot: root,
      store,
      executionProfile: SBX_CLAUDE_ACCOUNT_PROFILE,
      resourcePolicy: SBX_DISPOSABLE_RESOURCE_POLICY,
    });
    const manager = new ProviderAccountEnvironmentManager(
      { workerId, dataRoot: root, provider: "pi" },
      {
        backend,
        store,
        fake: false,
        setupLauncher: new PhysicalAcceptanceSetupLauncher(
          "fragmented",
          secret,
        ),
        fakeAuthentication: physicalAcceptanceAuthentication(),
      },
    );
    const environmentCommand: ProviderAccountEnvironmentCommand = {
      providerAccountId: accountId,
      providerKey: "anthropic",
      credentialGeneration: 1,
      workerGeneration: 1,
      operationId: crypto.randomUUID(),
      desiredState: "available",
      expectedPhysicalIdentity: null,
    };
    const reports: ProviderAccountSetupReport[] = [];
    const deliveries: Array<{ state: string }> = [];
    const coordinator = new ProviderAccountSetupCoordinator(
      new ProviderAccountSetupStore(root),
      manager,
      async (report) => {
        reports.push(structuredClone(report));
      },
      async (delivery) => {
        deliveries.push(structuredClone(delivery));
      },
      undefined,
      { interactionDiscoveryTimeoutMs: 2_000 },
    );
    let physical:
      | { backendKind: string; environmentId: string; incarnation: string }
      | undefined;
    try {
      const available = await manager.apply(environmentCommand);
      expect(available.physicalState).toBe("available");
      expect(available.backendKind).toBe("sbx");
      expect(available.authentication).toMatchObject({
        state: "authentication_required",
        method: "none",
      });
      physical = {
        backendKind: available.backendKind as string,
        environmentId: available.environmentId as string,
        incarnation: available.incarnation as string,
      };
      const command: ProviderAccountSetupCommand = {
        type: "prepare_provider_account_setup",
        protocol_version: 19,
        worker_id: workerId,
        connection_generation: 1,
        setup: {
          setup_attempt_id: crypto.randomUUID(),
          provider_account_id: accountId,
          setup_generation: 1,
          authorization_id: crypto.randomUUID(),
          authorization_kind: "provider_account_setup",
          authorized_at: new Date().toISOString(),
          credential_generation: 1,
          environment_generation: 1,
          worker_generation: 1,
          environment_operation_id: environmentCommand.operationId,
          invocation_worker_generation: null,
          invocation_environment_operation_id: null,
          provider_key: "anthropic",
          environment: {
            backend_kind: physical.backendKind,
            environment_id: physical.environmentId,
            incarnation: physical.incarnation,
          },
          authorized_authentication: {
            state: "authentication_required",
            method: "none",
            configuration_identity: available.authentication
              ?.configurationIdentity as string,
            environment_policy: available.authentication
              ?.environmentPolicy as string,
            evidence_identity: available.authentication
              ?.evidenceIdentity as string,
            inspected_at: available.authentication?.inspectedAt as string,
          },
          interaction_public_key: interactionPublicKey,
          state: "authorized",
          invocation_state: "not_requested",
          cancellation_request_id: null,
        },
      };
      await coordinator.prepare(command);
      await eventually(() =>
        reports.some((report) => report.state === "human_interaction_required"),
      );
      const waiting = reports.find(
        (report) => report.state === "human_interaction_required",
      );
      expect(waiting).toMatchObject({
        process: { executable: PHYSICAL_ACCEPTANCE_FIXTURE_EXECUTABLE },
        backend_kind: physical.backendKind,
        environment_id: physical.environmentId,
        environment_incarnation: physical.incarnation,
      });
      expect(waiting?.ephemeral_output).toMatchObject({
        version: "rsa-oaep-sha256-aes-256-gcm-v1",
      });
      expect(JSON.stringify(waiting?.ephemeral_output)).not.toContain(secret);

      // Cross the discovery deadline after recognition; only the human deadline remains.
      await Bun.sleep(2_250);
      expect(reports.at(-1)?.state).toBe("human_interaction_required");
      await coordinator.respond({
        type: "respond_provider_account_setup",
        protocol_version: 19,
        worker_id: command.worker_id,
        connection_generation: 1,
        setup_attempt_id: command.setup.setup_attempt_id,
        setup_generation: 1,
        attention_id: waiting?.attention?.attention_id as string,
        process_generation: waiting?.process?.process_generation as string,
        request_generation: 1,
        delivery_attempt_id: crypto.randomUUID(),
        value: `fake-code#${"s".repeat(43)}`,
      });
      await eventually(() =>
        reports.some((report) => report.state === "succeeded"),
      );
      expect(deliveries.map((delivery) => delivery.state)).toEqual([
        "delivery_acknowledged",
      ]);
      const durableBytes = await readDurableFiles(root);
      expect(durableBytes).not.toContain(secret);
      expect(durableBytes).not.toContain("fake-code");
    } finally {
      await coordinator.close().catch(() => undefined);
      if (physical) {
        await manager
          .apply({
            ...environmentCommand,
            operationId: crypto.randomUUID(),
            desiredState: "removed",
            expectedPhysicalIdentity: physical,
          })
          .catch(() => undefined);
      }
      await manager.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  },
  3 * 60_000,
);

async function readDurableFiles(root: string): Promise<string> {
  const names = await readdir(root);
  const files = names.filter(
    (name) => name.endsWith(".sqlite") || name.includes(".sqlite-"),
  );
  const buffers = await Promise.all(
    files.map((name) => readFile(join(root, name))),
  );
  return Buffer.concat(buffers).toString("utf8");
}

async function eventually(check: () => boolean, attempts = 800): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (check()) return;
    await Bun.sleep(25);
  }
  throw new Error("Live ProviderAccount setup did not converge.");
}
