import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type ProviderAccountEnvironmentCommand,
  ProviderAccountEnvironmentManager,
} from "../src/execution-environment/provider-account.ts";
import type { ProviderAccountSetupCommand } from "../src/protocol/types.ts";
import {
  ProviderAccountSetupCoordinator,
  type ProviderAccountSetupReport,
} from "../src/provider-account-setup.ts";
import { ProviderAccountSetupStore } from "../src/provider-account-setup-store.ts";

const live = process.env.QE_LIVE_SBX === "1";

// Bounded physical proof: only the deterministic Python fake-login process is
// launched. No Claude binary, provider endpoint, model, Run, or inference path exists.
test.skipIf(!live)(
  "real SBX retains one zero-Run account cell across fake setup and validation",
  async () => {
    const parent = join(process.cwd(), ".pi", "tmp");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "provider-account-setup-live-"));
    const interactionPublicKey = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    }).publicKey.export({ format: "pem", type: "pkcs1" }) as string;
    const workerId = `setup-live-worker-${Date.now()}`;
    const accountId = `setup-live-account-${Date.now()}`;
    const manager = new ProviderAccountEnvironmentManager({
      workerId,
      dataRoot: root,
      provider: "pi",
    });
    const environmentCommand: ProviderAccountEnvironmentCommand = {
      providerAccountId: accountId,
      providerKey: "deterministic-fake-provider",
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
    );
    let physical:
      | { backendKind: string; environmentId: string; incarnation: string }
      | undefined;
    try {
      const available = await manager.apply(environmentCommand);
      expect(available.physicalState).toBe("available");
      expect(available.backendKind).toBe("sbx");
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
          provider_account_id: environmentCommand.providerAccountId,
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
          provider_key: environmentCommand.providerKey,
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
      const waiting = reports.at(-1);
      expect(waiting).toMatchObject({
        state: "human_interaction_required",
        backend_kind: physical.backendKind,
        environment_id: physical.environmentId,
        environment_incarnation: physical.incarnation,
      });
      expect(waiting?.ephemeral_output).toMatchObject({
        version: "rsa-oaep-sha256-aes-256-gcm-v1",
      });
      expect(JSON.stringify(waiting?.ephemeral_output)).not.toContain(
        "fake-provider.invalid",
      );

      const sensitiveInput = "deterministic-fake-approval";
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
        value: sensitiveInput,
      });
      await eventually(() =>
        reports.some((report) => report.state === "succeeded"),
      );
      expect(deliveries.map((delivery) => delivery.state)).toEqual([
        "delivery_acknowledged",
      ]);
      const retained = manager.reportsFor([environmentCommand])[0];
      expect(retained).toMatchObject({
        physicalState: "available",
        environmentId: physical.environmentId,
        incarnation: physical.incarnation,
        canaryPersisted: true,
      });
      const durableBytes = await readDurableFiles(root);
      expect(durableBytes).not.toContain(sensitiveInput);
      expect(durableBytes).not.toContain("fake-provider.invalid");
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
  120_000,
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

async function eventually(check: () => boolean, attempts = 400): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (check()) return;
    await Bun.sleep(25);
  }
  throw new Error("Live ProviderAccount setup did not converge.");
}
