import { expect, test } from "bun:test";
import type { SbxExecOptions } from "../src/execution-environment/sbx-client.ts";
import { SBX_DISPOSABLE_RESOURCE_POLICY } from "../src/execution-environment/sbx-profile.ts";
import { LiveSbxEnvironmentVerifier } from "../src/execution-environment/sbx-verifier.ts";
import type { DurableEnvironmentRecord } from "../src/execution-environment/store.ts";
import type {
  EnvironmentCommand,
  EnvironmentCommandResult,
} from "../src/execution-environment/types.ts";
import { FakeSbxClient, fakeSbxState } from "./sbx-support.ts";

const sandbox = {
  name: "qe-verifier-test",
  id: "00000000-0000-4000-8000-000000000777",
  agent: "shell",
  status: "running",
};

test("live verifier proves isolated paths, private HOME, deny-all, and private Docker", async () => {
  const client = new ProbeClient();
  const verified = await new LiveSbxEnvironmentVerifier(
    client,
    SBX_DISPOSABLE_RESOURCE_POLICY,
  ).initialize(record(), sandbox);
  expect(verified.dockerDaemonId).toBe("private-docker-id");
  expect(verified.capabilities).toEqual(
    expect.arrayContaining([
      { kind: "filesystem_namespace", mode: "isolated" },
      { kind: "home", mode: "private" },
      { kind: "container_runtime", mode: "isolated" },
      { kind: "network_policy", mode: "deny_all" },
    ]),
  );
  expect(verified.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        message: expect.stringContaining("root_disk"),
      }),
      expect.objectContaining({
        message: expect.stringContaining("pid_limit"),
      }),
    ]),
  );
  expect(client.builtChild).toBe(true);
  expect(client.removedChild).toBe(true);
});

test("live verifier fails closed when scratch child cleanup cannot be proven", async () => {
  const client = new ProbeClient();
  client.failCleanup = true;
  await expect(
    new LiveSbxEnvironmentVerifier(
      client,
      SBX_DISPOSABLE_RESOURCE_POLICY,
    ).initialize(record(), sandbox),
  ).rejects.toMatchObject({ code: "environment_unhealthy" });
});

test("live verifier fails closed on host mount leakage", async () => {
  const client = new ProbeClient();
  client.hostMountLeak = true;
  await expect(
    new LiveSbxEnvironmentVerifier(
      client,
      SBX_DISPOSABLE_RESOURCE_POLICY,
    ).initialize(record(), sandbox),
  ).rejects.toMatchObject({ code: "environment_unhealthy" });
});

test("live verifier fails closed on inherited credential material", async () => {
  const client = new ProbeClient();
  client.credentialLeak = true;
  await expect(
    new LiveSbxEnvironmentVerifier(
      client,
      SBX_DISPOSABLE_RESOURCE_POLICY,
    ).initialize(record(), sandbox),
  ).rejects.toMatchObject({ code: "environment_unhealthy" });
});

class ProbeClient extends FakeSbxClient {
  hostMountLeak = false;
  credentialLeak = false;
  builtChild = false;
  removedChild = false;
  markerWritten = false;
  proofWritten = false;
  failCleanup = false;

  constructor() {
    super(fakeSbxState());
    this.state.sandboxes.set(sandbox.name, { ...sandbox });
  }

  override async exec(
    _sandboxName: string,
    command: EnvironmentCommand,
    _options: SbxExecOptions = {},
  ): Promise<EnvironmentCommandResult> {
    const ok = (stdout = ""): EnvironmentCommandResult => ({
      exitCode: 0,
      stdout,
      stderr: "",
    });
    if (command.executable === "/usr/bin/python3") {
      const source = command.args[1] ?? "";
      if (source.includes("keys=['QE_ENVIRONMENT_INCARNATION'"))
        return ok(
          `${JSON.stringify({
            QE_ENVIRONMENT_INCARNATION: "incarnation-verifier",
            QE_ENVIRONMENT_PROFILE_DIGEST: "sha256:profile",
            QE_ENVIRONMENT_SPEC_DIGEST: "spec-verifier",
            QE_RUN_ID: "run-verifier",
            QE_WORKER_ID: "worker-verifier",
          })}\n`,
        );
      if (command.environment?.QE_MARKER_JSON) {
        this.markerWritten = true;
        return ok();
      }
      if (command.environment?.QE_MARKER_PATH && source.includes("'exists'"))
        return ok(
          `${JSON.stringify({
            exists: this.markerWritten,
            marker: this.markerWritten ? marker() : null,
          })}\n`,
        );
      if (command.environment?.QE_PATHS)
        return ok(
          `${JSON.stringify({
            marker: marker(),
            directories: {
              workspace: true,
              home: true,
              state: true,
              control: true,
              cache: true,
              temp: true,
            },
            home: "/home/agent",
            homeSentinel: "incarnation-verifier",
            unexpectedVirtiofsMounts: this.hostMountLeak
              ? ["/qe/workspace"]
              : [],
            hostUsersMountVisible: this.hostMountLeak,
            dockerSocketMounted: false,
            sshAgentSocketUsable: false,
            nonProxyCredentialValuePresent: this.credentialLeak,
          })}\n`,
        );
      if (command.environment?.QE_PROOF_PATH && source.includes("'exists'"))
        return ok(
          `${JSON.stringify({
            exists: this.proofWritten,
            proof: this.proofWritten
              ? {
                  schemaVersion: 1,
                  daemonId: "private-docker-id",
                  incarnation: "incarnation-verifier",
                }
              : null,
          })}\n`,
        );
      if (command.environment?.QE_PROOF) {
        this.proofWritten = true;
        return ok();
      }
      return ok();
    }
    if (command.executable === "/usr/bin/docker") {
      if (command.args[0] === "info")
        return ok(
          `${JSON.stringify({
            DockerRootDir: "/var/lib/docker",
            NCPU: 1,
            MemTotal: 1_073_741_824,
            ID: "private-docker-id",
            Name: sandbox.name,
          })}\n`,
        );
      if (command.args[0] === "build") {
        this.builtChild = true;
        return ok();
      }
      if (command.args[0] === "run") {
        const proof = command.args
          .find((arg) => arg.startsWith("QE_CONTAINER_PROOF="))
          ?.slice("QE_CONTAINER_PROOF=".length);
        return ok(proof ?? "");
      }
      if (command.args[0] === "inspect")
        return ok(`${JSON.stringify("container-id")}\n`);
      if (command.args[0] === "image") return ok();
      if (command.args[0] === "rm") {
        if (this.failCleanup && this.builtChild)
          throw new Error("synthetic cleanup failure");
        this.removedChild = true;
        return ok();
      }
    }
    if (command.executable === "/bin/df") return ok("1B-blocks\n1073741824\n");
    if (command.executable === "/usr/bin/curl")
      return { exitCode: 6, stdout: "", stderr: "network denied" };
    if (command.executable === "/usr/bin/go") return ok("go version go1.25\n");
    return ok();
  }
}

function record(): DurableEnvironmentRecord {
  return {
    recordId: "record-verifier",
    backendKind: "sbx",
    workerId: "worker-verifier",
    runId: "run-verifier",
    displayName: sandbox.name,
    environmentId: sandbox.id,
    incarnation: "incarnation-verifier",
    profileId: "qe-execution-v1",
    profileDigest: "sha256:profile",
    specDigest: "spec-verifier",
    state: "creating",
    creationToken: "token-verifier",
    creatorPid: 123,
    nativeAgent: "shell",
    nativeVersion: "v0.43.0",
    nativeRevision: "revision",
    nativeApiVersion: "0.31.0",
    markerDigest: null,
    capabilities: [],
    diagnostics: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastVerifiedAt: null,
    retiredAt: null,
  };
}

function marker() {
  return {
    schemaVersion: 1,
    backendKind: "sbx",
    environmentId: sandbox.id,
    displayName: sandbox.name,
    incarnation: "incarnation-verifier",
    workerId: "worker-verifier",
    runId: "run-verifier",
    profileId: "qe-execution-v1",
    profileDigest: "sha256:profile",
    specDigest: "spec-verifier",
  };
}
