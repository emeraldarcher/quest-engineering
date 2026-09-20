import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  SbxClient,
  SbxCreateRequest,
  SbxExecOptions,
  SbxNativeVersion,
  SbxPolicyRule,
  SbxSandboxSummary,
  SbxSetting,
} from "../src/execution-environment/sbx-client.ts";
import { SbxClientError } from "../src/execution-environment/sbx-client.ts";
import {
  SBX_DISPOSABLE_RESOURCE_POLICY,
  SBX_EXECUTION_PROFILE_V1,
  SBX_GUEST_PATHS,
  SBX_TESTED_REVISION,
  SBX_TESTED_VERSION,
} from "../src/execution-environment/sbx-profile.ts";
import type {
  SbxEnvironmentVerifier,
  SbxVerifiedEnvironment,
} from "../src/execution-environment/sbx-verifier.ts";
import type { DurableEnvironmentRecord } from "../src/execution-environment/store.ts";
import type {
  EnvironmentCommand,
  EnvironmentCommandResult,
  EnvironmentSpec,
} from "../src/execution-environment/types.ts";

export interface FakeSbxState {
  sandboxes: Map<string, SbxSandboxSummary>;
  verified: Set<string>;
  createCalls: number;
  createRequests: SbxCreateRequest[];
  nextId: number;
  createDelayMs: number;
  loseCreateResponse: boolean;
  version: SbxNativeVersion;
  rules: SbxPolicyRule[];
  sshForwarding: boolean;
  mcpServerCount: number;
  files: Map<string, Uint8Array>;
}

export function fakeSbxState(): FakeSbxState {
  return {
    sandboxes: new Map(),
    verified: new Set(),
    createCalls: 0,
    createRequests: [],
    nextId: 1,
    createDelayMs: 0,
    loseCreateResponse: false,
    version: {
      clientVersion: SBX_TESTED_VERSION,
      clientRevision: SBX_TESTED_REVISION,
      serverState: "running",
      serverVersion: SBX_TESTED_VERSION,
      serverRevision: SBX_TESTED_REVISION,
      apiVersion: "0.31.0",
    },
    rules: [
      {
        id: "deny-all",
        scope: "global",
        appliesTo: "all",
        resourceType: "network",
        decision: "deny",
        resources: ["**"],
        status: "active",
      },
    ],
    sshForwarding: false,
    mcpServerCount: 0,
    files: new Map(),
  };
}

export class FakeSbxClient implements SbxClient {
  readonly executable = "/fake/sbx";

  constructor(readonly state: FakeSbxState = fakeSbxState()) {}

  async version(): Promise<SbxNativeVersion> {
    return structuredClone(this.state.version);
  }

  async list(): Promise<SbxSandboxSummary[]> {
    return [...this.state.sandboxes.values()].map((item) => ({ ...item }));
  }

  async policies(sandboxName?: string): Promise<SbxPolicyRule[]> {
    const base = this.state.rules.map((item) => ({
      ...item,
      resources: [...item.resources],
    }));
    return sandboxName
      ? [
          ...base,
          {
            id: `scoped-${sandboxName}`,
            scope: `sandbox:${sandboxName}`,
            appliesTo: `sandbox:${sandboxName}`,
            resourceType: "network",
            decision: "deny",
            resources: ["**"],
            status: "active",
            sandboxId: sandboxName,
          },
        ]
      : base;
  }

  async setting(key: string): Promise<SbxSetting> {
    return {
      key,
      type: "bool",
      source: "test",
      value:
        key === "ssh.agentForwardingEnabled" ? this.state.sshForwarding : null,
    };
  }

  async registeredMcpServerCount(): Promise<number> {
    return this.state.mcpServerCount;
  }

  async create(request: SbxCreateRequest): Promise<void> {
    this.state.createCalls += 1;
    this.state.createRequests.push(structuredClone(request));
    if (this.state.createDelayMs) await Bun.sleep(this.state.createDelayMs);
    if (this.state.sandboxes.has(request.name))
      throw new SbxClientError(
        "operation_failed",
        "sandbox name already exists",
        ["create"],
      );
    const id = `00000000-0000-4000-8000-${String(this.state.nextId).padStart(12, "0")}`;
    this.state.nextId += 1;
    this.state.sandboxes.set(request.name, {
      name: request.name,
      id,
      agent:
        request.agentReference && request.agentReference !== "shell"
          ? request.agentReference.split("/").at(-1) || "shell"
          : "shell",
      status: "running",
    });
    if (this.state.loseCreateResponse) {
      this.state.loseCreateResponse = false;
      throw new SbxClientError(
        "operation_timeout",
        "synthetic create response loss",
        ["create"],
      );
    }
  }

  async denyNetwork(
    sandboxName: string,
    resources: readonly string[],
  ): Promise<void> {
    this.state.rules.push({
      id: `scoped-deny-${sandboxName}-${this.state.rules.length}`,
      scope: `sandbox:${sandboxName}`,
      appliesTo: `sandbox:${sandboxName}`,
      resourceType: "network",
      decision: "deny",
      resources: [...resources],
      status: "active",
      sandboxId: sandboxName,
    });
  }

  async exec(
    sandboxName: string,
    command: EnvironmentCommand,
    options: SbxExecOptions = {},
  ): Promise<EnvironmentCommandResult> {
    const sandbox = this.state.sandboxes.get(sandboxName);
    if (!sandbox)
      throw new SbxClientError("operation_failed", "sandbox not found", [
        "exec",
      ]);
    sandbox.status = "running";
    const transferPath = command.environment?.QE_PATH;
    const transferStaging = command.environment?.QE_STAGING;
    if (transferPath && transferStaging) {
      const staged = this.state.files.get(`${sandboxName}\0${transferStaging}`);
      if (staged) {
        this.state.files.set(`${sandboxName}\0${transferPath}`, staged);
        this.state.files.delete(`${sandboxName}\0${transferStaging}`);
      }
    }
    const transferData = transferPath
      ? this.state.files.get(`${sandboxName}\0${transferPath}`)
      : undefined;
    const transferProof = transferData
      ? JSON.stringify({
          regular: true,
          size: transferData.byteLength,
          sha256: createHash("sha256").update(transferData).digest("hex"),
        })
      : null;
    const exitCode = command.executable.includes("false") ? 1 : 0;
    const result = {
      exitCode,
      stdout:
        transferProof ??
        (command.executable.includes("echo") && command.args.length > 0
          ? `${command.args.join(" ")}\n`
          : ""),
      stderr: exitCode === 0 ? "" : "synthetic failure\n",
    };
    if (exitCode !== 0 && !options.allowNonZero)
      throw new SbxClientError(
        "operation_failed",
        "synthetic command failure",
        ["exec"],
      );
    return result;
  }

  async copyTo(
    sandboxName: string,
    hostPath: string,
    guestPath: string,
  ): Promise<void> {
    if (!this.state.sandboxes.has(sandboxName))
      throw new SbxClientError("operation_failed", "sandbox not found", ["cp"]);
    this.state.files.set(
      `${sandboxName}\0${guestPath}`,
      new Uint8Array(await readFile(hostPath)),
    );
  }

  async copyFrom(
    sandboxName: string,
    guestPath: string,
    hostPath: string,
  ): Promise<void> {
    const data = this.state.files.get(`${sandboxName}\0${guestPath}`);
    if (!data)
      throw new SbxClientError("operation_failed", "sandbox file not found", [
        "cp",
      ]);
    await mkdir(dirname(hostPath), { recursive: true });
    await writeFile(hostPath, data);
  }

  async stop(sandboxName: string): Promise<void> {
    const sandbox = this.state.sandboxes.get(sandboxName);
    if (!sandbox)
      throw new SbxClientError("operation_failed", "sandbox not found", [
        "stop",
      ]);
    sandbox.status = "stopped";
  }

  async remove(sandboxName: string): Promise<void> {
    this.state.sandboxes.delete(sandboxName);
  }

  launcherArgs(
    sandboxName: string,
    command: EnvironmentCommand,
  ): readonly string[] {
    return [
      "exec",
      "-it",
      sandboxName,
      "--",
      command.executable,
      ...command.args,
    ];
  }
}

export class FakeSbxVerifier implements SbxEnvironmentVerifier {
  constructor(private readonly state: FakeSbxState) {}

  async initialize(
    record: DurableEnvironmentRecord,
    sandbox: SbxSandboxSummary,
  ): Promise<SbxVerifiedEnvironment> {
    this.state.verified.add(sandbox.id);
    return verified(record);
  }

  async verify(
    record: DurableEnvironmentRecord,
    sandbox: SbxSandboxSummary,
  ): Promise<SbxVerifiedEnvironment> {
    if (!this.state.verified.has(sandbox.id))
      throw new Error("environment was not initialized");
    return verified(record);
  }
}

export function sbxSpec(
  runId: string,
  workerId = "worker-sbx-test",
): EnvironmentSpec {
  return {
    workerId,
    runId,
    workspace: {
      workspaceId: `workspace-${runId}`,
      projectId: "project-sbx-fixture",
      access: "read_write",
      materialization: {
        kind: "disposable_fixture",
        sourceIdentity: `fixture:${runId}`,
        frozenBase: { kind: "fixture", value: "phase2-v1" },
      },
    },
    profile: { ...SBX_EXECUTION_PROFILE_V1 },
    resourcePolicy: { ...SBX_DISPOSABLE_RESOURCE_POLICY.identity },
    networkRequirements: [],
    credentialGrants: [],
    controlChannels: [],
    requiredCapabilities: [{ kind: "container_runtime", mode: "isolated" }],
  };
}

function verified(record: DurableEnvironmentRecord): SbxVerifiedEnvironment {
  return {
    markerDigest: `marker-${record.incarnation}`,
    dockerDaemonId: `docker-${record.incarnation}`,
    capabilities: [
      { kind: "filesystem_namespace", mode: "isolated" },
      { kind: "home", mode: "private" },
      { kind: "container_runtime", mode: "isolated" },
      { kind: "environment_exec", mode: "available" },
      { kind: "environment_persistence", mode: "verified" },
      { kind: "network_policy", mode: "deny_all" },
      { kind: "pty_launcher", mode: "available" },
    ],
    diagnostics: [],
  };
}

export const sbxCommand = (label: string): EnvironmentCommand => ({
  executable: "/bin/echo",
  args: [label],
  cwd: SBX_GUEST_PATHS.workspace,
});
