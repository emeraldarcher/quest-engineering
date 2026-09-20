import { expect, test } from "bun:test";
import type { SbxExecOptions } from "../src/execution-environment/sbx-client.ts";
import {
  SBX_DISPOSABLE_RESOURCE_POLICY,
  SBX_PI_PROFILE,
} from "../src/execution-environment/sbx-profile.ts";
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

test("Pi verifier requires a host-Pi dynamic credential, narrow egress, and disabled guest refresh", async () => {
  const client = new PiProbeClient();
  const verified = await new LiveSbxEnvironmentVerifier(
    client,
    SBX_DISPOSABLE_RESOURCE_POLICY,
    { ...SBX_PI_PROFILE, identity: piProfileIdentity },
  ).initialize(piRecord(), piSandbox);
  expect(verified.capabilities).toEqual(
    expect.arrayContaining([
      { kind: "credentials", mode: "host_pi_oauth_dynamic_proxy" },
      { kind: "network_policy", mode: "openai_subscription_only" },
      { kind: "control_channel", mode: "worker_file_mailbox_v1" },
    ]),
  );

  client.oauthValid = false;
  await expect(
    new LiveSbxEnvironmentVerifier(client, SBX_DISPOSABLE_RESOURCE_POLICY, {
      ...SBX_PI_PROFILE,
      identity: piProfileIdentity,
    }).verify(piRecord(), piSandbox),
  ).rejects.toMatchObject({ code: "environment_requirements_unmet" });
});

const piProfileIdentity = {
  id: "qe-pi-execution-v1",
  digest: "sha256:profile",
};
const piSandbox = {
  ...sandbox,
  name: "qe-pi-verifier-test",
  agent: "qe-pi-execution-v1",
};

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

class PiProbeClient extends ProbeClient {
  oauthValid = true;

  constructor() {
    super();
    this.state.sandboxes.set(piSandbox.name, { ...piSandbox });
  }

  override async policies() {
    return [
      ...["chatgpt.com", "registry.npmjs.org"].map((resource, index) => ({
        id: `allow-${index}`,
        scope: "global",
        appliesTo: "all",
        resourceType: "network" as const,
        decision: "allow" as const,
        resources: [resource],
        status: "active" as const,
      })),
      {
        id: "deny-registry",
        scope: `sandbox:${piSandbox.name}`,
        appliesTo: `sandbox:${piSandbox.name}`,
        resourceType: "network" as const,
        decision: "deny" as const,
        resources: ["registry.npmjs.org"],
        status: "active" as const,
        sandboxId: piSandbox.name,
      },
    ];
  }

  override async exec(
    sandboxName: string,
    command: EnvironmentCommand,
    options: SbxExecOptions = {},
  ): Promise<EnvironmentCommandResult> {
    const ok = (stdout = ""): EnvironmentCommandResult => ({
      exitCode: 0,
      stdout,
      stderr: "",
    });
    const source = command.args[1] ?? "";
    if (
      command.executable === "/usr/bin/python3" &&
      command.environment?.QE_MARKER_PATH &&
      source.includes("'exists'")
    )
      return ok(`${JSON.stringify({ exists: true, marker: piMarker() })}\n`);
    if (
      command.executable === "/usr/bin/python3" &&
      command.environment?.QE_PATHS
    )
      return ok(
        `${JSON.stringify({
          marker: piMarker(),
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
          unexpectedVirtiofsMounts: [],
          hostUsersMountVisible: false,
          dockerSocketMounted: false,
          sshAgentSocketUsable: false,
          nonProxyCredentialValuePresent: false,
          openaiCredentialMode: "host_pi_oauth_dynamic_proxy",
          piOAuthCredentialValid: this.oauthValid,
        })}\n`,
      );
    if (command.executable === "/usr/bin/docker" && command.args[0] === "info")
      return ok(
        `${JSON.stringify({
          DockerRootDir: "/var/lib/docker",
          NCPU: 1,
          MemTotal: 1_073_741_824,
          ID: "private-docker-id",
          Name: piSandbox.name,
        })}\n`,
      );
    if (
      command.executable === "/usr/bin/node" &&
      command.args[0]?.includes("probe-resource")
    )
      return ok(
        `${JSON.stringify({ authenticated: true, status: 200, hasModels: true })}\n`,
      );
    if (command.executable === "/usr/bin/node")
      return ok(
        `${JSON.stringify({
          schemaVersion: 1,
          compatible: true,
          capabilities: {
            nodeRuntime: true,
            git: true,
            modelRuntime: true,
            interactiveCli: true,
            nativeExtensions: true,
            structuredTools: true,
            externallyManagedCredential: true,
            jwtAccountClaim: true,
            syntheticExpiry: true,
            guestRefreshDisabled: true,
            nodeProxyConfigured: true,
          },
          provenance: { piPackage: "0.84.2", node: "22.22.1", git: "2.53.0" },
        })}\n`,
      );
    if (command.executable === "/usr/bin/curl")
      return { exitCode: 6, stdout: "", stderr: "denied" };
    return super.exec(sandboxName, command, options);
  }
}

function piRecord(): DurableEnvironmentRecord {
  return {
    ...record(),
    displayName: piSandbox.name,
    environmentId: piSandbox.id,
    profileId: piProfileIdentity.id,
    profileDigest: piProfileIdentity.digest,
    nativeAgent: piSandbox.agent,
  };
}

function piMarker() {
  return {
    ...marker(),
    environmentId: piSandbox.id,
    displayName: piSandbox.name,
    profileId: piProfileIdentity.id,
    profileDigest: piProfileIdentity.digest,
  };
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
