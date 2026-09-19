import { createHash } from "node:crypto";
import type { SbxClient, SbxSandboxSummary } from "./sbx-client.ts";
import type { SbxResourcePolicy } from "./sbx-profile.ts";
import { SBX_GUEST_PATHS } from "./sbx-profile.ts";
import type { DurableEnvironmentRecord } from "./store.ts";
import type {
  EnvironmentCapability,
  EnvironmentReadinessDiagnostic,
} from "./types.ts";
import { EnvironmentBackendError } from "./types.ts";

export interface SbxVerifiedEnvironment {
  markerDigest: string;
  capabilities: readonly EnvironmentCapability[];
  diagnostics: readonly EnvironmentReadinessDiagnostic[];
  dockerDaemonId: string;
}

export interface SbxEnvironmentVerifier {
  initialize(
    record: DurableEnvironmentRecord,
    sandbox: SbxSandboxSummary,
  ): Promise<SbxVerifiedEnvironment>;
  verify(
    record: DurableEnvironmentRecord,
    sandbox: SbxSandboxSummary,
  ): Promise<SbxVerifiedEnvironment>;
}

interface OwnershipMarker {
  schemaVersion: 1;
  backendKind: "sbx";
  workerId: string;
  runId: string;
  environmentId: string;
  displayName: string;
  incarnation: string;
  profileId: string;
  profileDigest: string;
  specDigest: string;
}

interface GuestProbe {
  marker: OwnershipMarker | null;
  directories: Record<string, boolean>;
  home: string;
  homeSentinel: string | null;
  unexpectedVirtiofsMounts: string[];
  hostUsersMountVisible: boolean;
  dockerSocketMounted: boolean;
  sshAgentSocketUsable: boolean;
  nonProxyCredentialValuePresent: boolean;
}

interface DockerInfo {
  ID: string;
  DockerRootDir: string;
  Name: string;
  NCPU: number;
  MemTotal: number;
  StorageBytes: number;
}

interface DockerProof {
  schemaVersion: 1;
  daemonId: string;
  incarnation: string;
}

const MARKER_PATH = `${SBX_GUEST_PATHS.state}/environment-ownership.json`;
const HOME_SENTINEL_PATH = `${SBX_GUEST_PATHS.home}/.qe-environment-home`;
const DOCKER_PROOF_PATH = `${SBX_GUEST_PATHS.state}/container-runtime-proof.json`;

export class LiveSbxEnvironmentVerifier implements SbxEnvironmentVerifier {
  constructor(
    private readonly client: SbxClient,
    private readonly resourcePolicy: SbxResourcePolicy,
  ) {}

  async initialize(
    record: DurableEnvironmentRecord,
    sandbox: SbxSandboxSummary,
  ): Promise<SbxVerifiedEnvironment> {
    await this.verifyCreationIdentity(record, sandbox);
    const marker = ownershipMarker(record, sandbox);
    const existing = await this.readMarker(sandbox.name);
    if (existing && !sameMarker(existing, marker))
      throw identityMismatch(
        "Guest ownership marker conflicts with the durable Worker record.",
      );

    await this.client.exec(
      sandbox.name,
      {
        executable: "/usr/bin/install",
        args: [
          "-d",
          "-m",
          "0700",
          "-o",
          "1000",
          "-g",
          "1000",
          SBX_GUEST_PATHS.workspace,
          SBX_GUEST_PATHS.state,
          SBX_GUEST_PATHS.control,
          SBX_GUEST_PATHS.cache,
          SBX_GUEST_PATHS.temp,
        ],
      },
      { user: "root" },
    );
    await this.client.exec(
      sandbox.name,
      {
        executable: "/usr/bin/python3",
        args: [
          "-c",
          "import json,os,pathlib; marker=json.loads(os.environ['QE_MARKER_JSON']); p=pathlib.Path(os.environ['QE_MARKER_PATH']); p.write_text(json.dumps(marker,separators=(',',':'))); os.chmod(p,0o600); os.chown(p,1000,1000); h=pathlib.Path(os.environ['QE_HOME_SENTINEL']); h.write_text(marker['incarnation']); os.chmod(h,0o600); os.chown(h,1000,1000)",
        ],
        environment: {
          QE_MARKER_JSON: JSON.stringify(marker),
          QE_MARKER_PATH: MARKER_PATH,
          QE_HOME_SENTINEL: HOME_SENTINEL_PATH,
        },
      },
      { user: "root" },
    );

    const docker = await this.dockerInfo(sandbox.name);
    const proof = await this.readDockerProof(sandbox.name);
    if (
      !proof ||
      proof.daemonId !== docker.ID ||
      proof.incarnation !== record.incarnation
    ) {
      await this.proveChildContainer(record, sandbox, docker.ID);
    }
    return this.verify(record, sandbox);
  }

  async verify(
    record: DurableEnvironmentRecord,
    sandbox: SbxSandboxSummary,
  ): Promise<SbxVerifiedEnvironment> {
    const expectedMarker = ownershipMarker(record, sandbox);
    const [probe, docker, policies, proof, networkDenied] = await Promise.all([
      this.guestProbe(sandbox.name),
      this.dockerInfo(sandbox.name),
      this.client.policies(sandbox.name),
      this.readDockerProof(sandbox.name),
      this.networkDenied(sandbox.name),
    ]);
    if (!probe.marker || !sameMarker(probe.marker, expectedMarker))
      throw identityMismatch(
        "Guest ownership marker does not match durable Worker ownership.",
      );
    if (
      probe.home !== SBX_GUEST_PATHS.home ||
      probe.homeSentinel !== record.incarnation
    )
      throw unhealthy("Private HOME identity or persistence proof failed.");
    if (Object.values(probe.directories).some((present) => !present))
      throw unhealthy("Canonical guest filesystem layout is incomplete.");
    if (
      probe.unexpectedVirtiofsMounts.length > 0 ||
      probe.hostUsersMountVisible
    )
      throw unhealthy("Unexpected host filesystem exposure was detected.");
    if (probe.dockerSocketMounted)
      throw unhealthy("The Docker socket is backed by a host mount.");
    if (probe.sshAgentSocketUsable)
      throw unhealthy("An SSH agent socket is usable inside the environment.");
    if (probe.nonProxyCredentialValuePresent)
      throw unhealthy("A non-proxy credential value is exposed in the guest.");
    const scopedDenyAll = policies.some(
      (rule) =>
        rule.scope === `sandbox:${sandbox.name}` &&
        rule.resourceType === "network" &&
        rule.decision === "deny" &&
        rule.status === "active" &&
        rule.resources.includes("**"),
    );
    if (!scopedDenyAll)
      throw unhealthy("Sandbox-scoped deny-all network policy is missing.");
    if (!networkDenied)
      throw unhealthy("Sandbox-scoped network deny behavior was not enforced.");
    if (
      docker.ID.length === 0 ||
      docker.DockerRootDir !== "/var/lib/docker" ||
      docker.Name !== sandbox.name
    )
      throw unhealthy("Sandbox-private Docker daemon identity is invalid.");
    if (
      !proof ||
      proof.daemonId !== docker.ID ||
      proof.incarnation !== record.incarnation
    )
      throw unhealthy(
        "Private Docker child-container proof is absent or stale.",
      );
    if (docker.NCPU !== this.resourcePolicy.cpus)
      throw unhealthy("SBX CPU allocation does not match the resource policy.");
    const expectedMemory = binaryBytes(this.resourcePolicy.memory);
    if (
      docker.MemTotal < expectedMemory * 0.85 ||
      docker.MemTotal > expectedMemory * 1.05
    )
      throw unhealthy(
        "SBX memory allocation does not match the resource policy.",
      );
    const expectedDockerDisk = binaryBytes(
      this.resourcePolicy.privateDockerDisk,
    );
    if (
      docker.StorageBytes < expectedDockerDisk * 0.85 ||
      docker.StorageBytes > expectedDockerDisk * 1.05
    )
      throw unhealthy(
        "SBX private Docker storage does not match the resource policy.",
      );

    return {
      markerDigest: digestMarker(expectedMarker),
      dockerDaemonId: docker.ID,
      capabilities: [
        { kind: "filesystem_namespace", mode: "isolated" },
        { kind: "home", mode: "private" },
        { kind: "host_filesystem", mode: "unexposed" },
        { kind: "container_runtime", mode: "isolated" },
        { kind: "environment_exec", mode: "available" },
        { kind: "environment_persistence", mode: "verified" },
        { kind: "network_policy", mode: "deny_all" },
        { kind: "credentials", mode: "none" },
        { kind: "shared_skills", mode: "off" },
        { kind: "ambient_mcp", mode: "unavailable" },
        { kind: "pty_launcher", mode: "available" },
        {
          kind: "resource_limits",
          mode: "cpu_memory_private_docker_disk",
        },
      ],
      diagnostics: this.resourcePolicy.unsupportedControls.map((control) => ({
        code: "resource_control_unsupported",
        message: `SBX does not expose Phase-2 enforcement for ${control}.`,
      })),
    };
  }

  private async verifyCreationIdentity(
    record: DurableEnvironmentRecord,
    sandbox: SbxSandboxSummary,
  ): Promise<void> {
    const result = await this.client.exec(sandbox.name, {
      executable: "/usr/bin/python3",
      args: [
        "-c",
        "import json,os; keys=['QE_ENVIRONMENT_INCARNATION','QE_ENVIRONMENT_PROFILE_DIGEST','QE_ENVIRONMENT_SPEC_DIGEST','QE_RUN_ID','QE_WORKER_ID']; print(json.dumps({k:os.environ.get(k) for k in keys},separators=(',',':')))",
      ],
    });
    const value = parseObject(result.stdout, "creation identity");
    const expected: Record<string, string> = {
      QE_ENVIRONMENT_INCARNATION: record.incarnation,
      QE_ENVIRONMENT_PROFILE_DIGEST: record.profileDigest,
      QE_ENVIRONMENT_SPEC_DIGEST: record.specDigest,
      QE_RUN_ID: record.runId,
      QE_WORKER_ID: record.workerId,
    };
    if (
      Object.entries(expected).some(
        ([key, expectedValue]) => value[key] !== expectedValue,
      )
    )
      throw identityMismatch(
        "Sandbox creation identity does not match the durable creation intent.",
      );
  }

  private async readMarker(
    sandboxName: string,
  ): Promise<OwnershipMarker | null> {
    const result = await this.client.exec(sandboxName, {
      executable: "/usr/bin/python3",
      args: [
        "-c",
        "import json,os,pathlib; p=pathlib.Path(os.environ['QE_MARKER_PATH']); print(json.dumps({'exists':p.is_file(),'marker':json.loads(p.read_text()) if p.is_file() else None},separators=(',',':')))",
      ],
      environment: { QE_MARKER_PATH: MARKER_PATH },
    });
    const value = parseObject(result.stdout, "ownership marker");
    if (value.exists === false) return null;
    return decodeMarker(value.marker);
  }

  private async guestProbe(sandboxName: string): Promise<GuestProbe> {
    const result = await this.client.exec(sandboxName, {
      executable: "/usr/bin/python3",
      args: [
        "-c",
        "import json,os,pathlib,stat; paths=json.loads(os.environ['QE_PATHS']); marker=pathlib.Path(os.environ['QE_MARKER_PATH']); home=pathlib.Path(os.environ['QE_HOME_SENTINEL']); mounts=[]; host_users=False; docker_socket=False;\nfor line in pathlib.Path('/proc/self/mountinfo').read_text().splitlines():\n parts=line.split(); sep=parts.index('-'); mountpoint=parts[4].replace('\\040',' '); fstype=parts[sep+1]; mounts.append((mountpoint,fstype)); host_users=host_users or mountpoint.startswith('/Users/'); docker_socket=docker_socket or mountpoint=='/var/run/docker.sock'\ncred_keys=[k for k in os.environ if k.endswith('_API_KEY') or k.endswith('_TOKEN')]; bad_cred=any(os.environ[k] not in ('proxy-managed','none','') for k in cred_keys); ssh=os.environ.get('SSH_AUTH_SOCK',''); result={'marker':json.loads(marker.read_text()) if marker.is_file() else None,'directories':{k:pathlib.Path(v).is_dir() for k,v in paths.items()},'home':os.environ.get('HOME',''),'homeSentinel':home.read_text() if home.is_file() else None,'unexpectedVirtiofsMounts':[p for p,t in mounts if t=='virtiofs' and p not in ('/etc/hosts','/etc/resolv.conf')],'hostUsersMountVisible':host_users,'dockerSocketMounted':docker_socket,'sshAgentSocketUsable':bool(ssh and pathlib.Path(ssh).exists() and stat.S_ISSOCK(pathlib.Path(ssh).stat().st_mode)),'nonProxyCredentialValuePresent':bad_cred}; print(json.dumps(result,separators=(',',':')))",
      ],
      environment: {
        QE_PATHS: JSON.stringify(SBX_GUEST_PATHS),
        QE_MARKER_PATH: MARKER_PATH,
        QE_HOME_SENTINEL: HOME_SENTINEL_PATH,
      },
    });
    const value = parseObject(result.stdout, "guest probe");
    return {
      marker: value.marker === null ? null : decodeMarker(value.marker),
      directories: booleanRecord(value.directories, "directories"),
      home: text(value.home, "home"),
      homeSentinel:
        value.homeSentinel === null
          ? null
          : text(value.homeSentinel, "homeSentinel"),
      unexpectedVirtiofsMounts: textArray(
        value.unexpectedVirtiofsMounts,
        "unexpectedVirtiofsMounts",
      ),
      hostUsersMountVisible: boolean(
        value.hostUsersMountVisible,
        "hostUsersMountVisible",
      ),
      dockerSocketMounted: boolean(
        value.dockerSocketMounted,
        "dockerSocketMounted",
      ),
      sshAgentSocketUsable: boolean(
        value.sshAgentSocketUsable,
        "sshAgentSocketUsable",
      ),
      nonProxyCredentialValuePresent: boolean(
        value.nonProxyCredentialValuePresent,
        "nonProxyCredentialValuePresent",
      ),
    };
  }

  private async networkDenied(sandboxName: string): Promise<boolean> {
    const result = await this.client.exec(
      sandboxName,
      {
        executable: "/usr/bin/curl",
        args: [
          "--fail",
          "--silent",
          "--show-error",
          "--noproxy",
          "*",
          "--connect-timeout",
          "3",
          "--max-time",
          "5",
          "https://example.com/",
        ],
        timeoutMs: 30_000,
      },
      { allowNonZero: true },
    );
    return result.exitCode !== 0;
  }

  private async dockerInfo(sandboxName: string): Promise<DockerInfo> {
    const [result, storage] = await Promise.all([
      this.client.exec(sandboxName, {
        executable: "/usr/bin/docker",
        args: ["info", "--format", "{{json .}}"],
        timeoutMs: 60_000,
      }),
      this.client.exec(sandboxName, {
        executable: "/bin/df",
        args: ["-B1", "--output=size", "/var/lib/docker"],
        timeoutMs: 30_000,
      }),
    ]);
    const value = parseObject(result.stdout, "docker info");
    const storageBytes = Number(storage.stdout.trim().split(/\s+/).at(-1));
    if (!Number.isSafeInteger(storageBytes) || storageBytes < 1)
      throw unhealthy("SBX private Docker storage size is malformed.");
    return {
      ID: text(value.ID, "docker.ID"),
      DockerRootDir: text(value.DockerRootDir, "docker.DockerRootDir"),
      Name: text(value.Name, "docker.Name"),
      NCPU: number(value.NCPU, "docker.NCPU"),
      MemTotal: number(value.MemTotal, "docker.MemTotal"),
      StorageBytes: storageBytes,
    };
  }

  private async readDockerProof(
    sandboxName: string,
  ): Promise<DockerProof | null> {
    const result = await this.client.exec(sandboxName, {
      executable: "/usr/bin/python3",
      args: [
        "-c",
        "import json,os,pathlib; p=pathlib.Path(os.environ['QE_PROOF_PATH']); print(json.dumps({'exists':p.is_file(),'proof':json.loads(p.read_text()) if p.is_file() else None},separators=(',',':')))",
      ],
      environment: { QE_PROOF_PATH: DOCKER_PROOF_PATH },
    });
    const value = parseObject(result.stdout, "Docker proof");
    if (value.exists === false) return null;
    const proof = parseObject(value.proof, "Docker proof value");
    if (proof.schemaVersion !== 1)
      throw unhealthy("Docker proof schema is incompatible.");
    return {
      schemaVersion: 1,
      daemonId: text(proof.daemonId, "proof.daemonId"),
      incarnation: text(proof.incarnation, "proof.incarnation"),
    };
  }

  private async proveChildContainer(
    record: DurableEnvironmentRecord,
    sandbox: SbxSandboxSummary,
    daemonId: string,
  ): Promise<void> {
    const suffix = createHash("sha256")
      .update(record.incarnation)
      .digest("hex")
      .slice(0, 12);
    const directory = `${SBX_GUEST_PATHS.temp}/container-proof-${suffix}`;
    const image = `qe-container-proof:${suffix}`;
    const container = `qe-container-proof-${suffix}`;
    const expected = `qe-private-docker:${suffix}`;
    const source = `package main\nimport ("fmt";"os")\nfunc main(){fmt.Print(os.Getenv("QE_CONTAINER_PROOF"))}\n`;
    const dockerfile =
      'FROM scratch\nCOPY qe-proof /qe-proof\nENTRYPOINT ["/qe-proof"]\n';
    await attemptCleanup(
      this.client.exec(sandbox.name, {
        executable: "/usr/bin/docker",
        args: ["rm", "--force", container],
      }),
    );
    await attemptCleanup(
      this.client.exec(sandbox.name, {
        executable: "/usr/bin/docker",
        args: ["image", "rm", "--force", image],
      }),
    );
    await attemptCleanup(
      this.client.exec(sandbox.name, {
        executable: "/bin/rm",
        args: ["-rf", directory],
      }),
    );
    await this.client.exec(sandbox.name, {
      executable: "/usr/bin/python3",
      args: [
        "-c",
        "import base64,os,pathlib; d=pathlib.Path(os.environ['QE_DIR']); d.mkdir(parents=True,exist_ok=True); (d/'main.go').write_bytes(base64.b64decode(os.environ['QE_SOURCE'])); (d/'Dockerfile').write_bytes(base64.b64decode(os.environ['QE_DOCKERFILE']))",
      ],
      environment: {
        QE_DIR: directory,
        QE_SOURCE: Buffer.from(source).toString("base64"),
        QE_DOCKERFILE: Buffer.from(dockerfile).toString("base64"),
      },
    });
    let proven = false;
    let cleanupFailed = false;
    try {
      await this.client.exec(sandbox.name, {
        executable: "/usr/bin/go",
        args: ["build", "-trimpath", "-o", "qe-proof", "main.go"],
        cwd: directory,
        environment: { CGO_ENABLED: "0" },
        timeoutMs: 120_000,
      });
      await this.client.exec(sandbox.name, {
        executable: "/usr/bin/docker",
        args: ["build", "--network=none", "-t", image, "."],
        cwd: directory,
        timeoutMs: 180_000,
      });
      const run = await this.client.exec(sandbox.name, {
        executable: "/usr/bin/docker",
        args: [
          "run",
          "--name",
          container,
          "--network=none",
          "--env",
          `QE_CONTAINER_PROOF=${expected}`,
          image,
        ],
        timeoutMs: 60_000,
      });
      if (run.stdout.trim() !== expected)
        throw unhealthy("Private Docker child container returned wrong proof.");
      const inspect = await this.client.exec(sandbox.name, {
        executable: "/usr/bin/docker",
        args: ["inspect", "--format", "{{json .Id}}", container],
      });
      if (typeof JSON.parse(inspect.stdout) !== "string")
        throw unhealthy("Private Docker child container inspection failed.");
      proven = true;
    } finally {
      const cleanup = [
        await attemptCleanup(
          this.client.exec(sandbox.name, {
            executable: "/usr/bin/docker",
            args: ["rm", "--force", container],
          }),
        ),
        await attemptCleanup(
          this.client.exec(sandbox.name, {
            executable: "/usr/bin/docker",
            args: ["image", "rm", "--force", image],
          }),
        ),
        await attemptCleanup(
          this.client.exec(sandbox.name, {
            executable: "/bin/rm",
            args: ["-rf", directory],
          }),
        ),
      ];
      cleanupFailed = proven && cleanup.some((removed) => !removed);
    }
    if (cleanupFailed) throw unhealthy("Private Docker proof cleanup failed.");
    const proof: DockerProof = {
      schemaVersion: 1,
      daemonId,
      incarnation: record.incarnation,
    };
    await this.client.exec(sandbox.name, {
      executable: "/usr/bin/python3",
      args: [
        "-c",
        "import json,os,pathlib; p=pathlib.Path(os.environ['QE_PROOF_PATH']); p.write_text(os.environ['QE_PROOF']); p.chmod(0o600)",
      ],
      environment: {
        QE_PROOF_PATH: DOCKER_PROOF_PATH,
        QE_PROOF: JSON.stringify(proof),
      },
    });
  }
}

function ownershipMarker(
  record: DurableEnvironmentRecord,
  sandbox: SbxSandboxSummary,
): OwnershipMarker {
  if (!record.environmentId && record.state !== "creating")
    throw identityMismatch("Durable environment record has no physical ID.");
  return {
    schemaVersion: 1,
    backendKind: "sbx",
    workerId: record.workerId,
    runId: record.runId,
    environmentId: sandbox.id,
    displayName: sandbox.name,
    incarnation: record.incarnation,
    profileId: record.profileId,
    profileDigest: record.profileDigest,
    specDigest: record.specDigest,
  };
}

function decodeMarker(value: unknown): OwnershipMarker {
  const marker = parseObject(value, "ownership marker value");
  if (marker.schemaVersion !== 1 || marker.backendKind !== "sbx")
    throw identityMismatch("Guest ownership marker schema is incompatible.");
  return {
    schemaVersion: 1,
    backendKind: "sbx",
    workerId: text(marker.workerId, "marker.workerId"),
    runId: text(marker.runId, "marker.runId"),
    environmentId: text(marker.environmentId, "marker.environmentId"),
    displayName: text(marker.displayName, "marker.displayName"),
    incarnation: text(marker.incarnation, "marker.incarnation"),
    profileId: text(marker.profileId, "marker.profileId"),
    profileDigest: text(marker.profileDigest, "marker.profileDigest"),
    specDigest: text(marker.specDigest, "marker.specDigest"),
  };
}

function sameMarker(left: OwnershipMarker, right: OwnershipMarker): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function digestMarker(marker: OwnershipMarker): string {
  return createHash("sha256").update(JSON.stringify(marker)).digest("hex");
}

function parseObject(value: unknown, label: string): Record<string, unknown> {
  const parsed =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            throw unhealthy(`${label} was not valid JSON.`);
          }
        })()
      : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw unhealthy(`${label} must be an object.`);
  return parsed as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw unhealthy(`${label} must be a non-empty string.`);
  return value;
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw unhealthy(`${label} must be a finite number.`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean")
    throw unhealthy(`${label} must be a boolean.`);
  return value;
}

function booleanRecord(value: unknown, label: string): Record<string, boolean> {
  const record = parseObject(value, label);
  if (Object.values(record).some((item) => typeof item !== "boolean"))
    throw unhealthy(`${label} values must be booleans.`);
  return record as Record<string, boolean>;
}

function textArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw unhealthy(`${label} must be a string array.`);
  return value as string[];
}

function binaryBytes(value: string): number {
  const match = value.match(/^(\d+)([kmgt])$/i);
  if (!match) throw unhealthy(`Unsupported resource size ${value}.`);
  const powers: Record<string, number> = { k: 1, m: 2, g: 3, t: 4 };
  return (
    Number(match[1]) *
    1024 ** (powers[(match[2] as string).toLowerCase()] as number)
  );
}

function identityMismatch(message: string): EnvironmentBackendError {
  return new EnvironmentBackendError("environment_identity_mismatch", message);
}

function unhealthy(message: string): EnvironmentBackendError {
  return new EnvironmentBackendError("environment_unhealthy", message);
}

async function attemptCleanup(operation: Promise<unknown>): Promise<boolean> {
  try {
    await operation;
    return true;
  } catch {
    return false;
  }
}
