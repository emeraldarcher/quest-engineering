export type EnvironmentBackendOperation =
  | "readiness"
  | "ensure"
  | "recover"
  | "inspect"
  | "stop"
  | "remove"
  | "launcher"
  | "exec"
  | "transfer";

export interface EnvironmentProfileIdentity {
  /** Stable, versioned profile name, for example qe-execution-v1. */
  id: string;
  /** Immutable digest of the resolved profile definition. */
  digest: string;
}

export interface EnvironmentCapability {
  /** Backend-neutral capability name. */
  kind: string;
  /** Capability-specific mode, for example isolated or unavailable. */
  mode: string;
  detail?: string;
}

export interface EnvironmentCapabilityRequirement {
  kind: string;
  mode: string;
}

export interface EnvironmentNetworkRequirement {
  /** Purpose rather than a blanket network-enabled flag. */
  capability:
    | "qe_control"
    | "model_provider"
    | "dependency_registry"
    | "git_remote"
    | "project_service"
    | (string & {});
  /** Policy identities or destinations resolved by the Worker/backend. */
  targets: readonly string[];
}

export interface CredentialGrantDescriptor {
  /** Opaque grant identity. Secret material is never part of this descriptor. */
  grantId: string;
  kind: string;
  scope?: string;
}

export interface EnvironmentControlChannelRequirement {
  kind: string;
  required: boolean;
}

export interface EnvironmentSpec {
  /** Authoritative Worker and Run ownership; never model supplied. */
  workerId: string;
  runId: string;
  workspace: {
    workspaceId: string;
    projectId?: string;
    access: "none" | "read_only" | "read_write";
    materialization: {
      kind: "existing_workspace" | "frozen_import" | "disposable_fixture";
      sourceIdentity: string;
      frozenBase: {
        kind: string;
        value: string;
      };
    };
  };
  profile: EnvironmentProfileIdentity;
  /** Versioned policy identity; concrete limits are resolved outside model input. */
  resourcePolicy: {
    id: string;
    digest: string;
  };
  networkRequirements: readonly EnvironmentNetworkRequirement[];
  credentialGrants: readonly CredentialGrantDescriptor[];
  controlChannels: readonly EnvironmentControlChannelRequirement[];
  requiredCapabilities: readonly EnvironmentCapabilityRequirement[];
}

/** Opaque physical identity. Run identity and physical incarnation stay distinct. */
export interface EnvironmentRef {
  backendKind: string;
  environmentId: string;
  incarnation: string;
  workerId: string;
  runId: string;
  profile: EnvironmentProfileIdentity;
}

/** Paths in the environment namespace. They are not necessarily host paths. */
export interface EnvironmentPathMap {
  workspace: string;
  state: string;
  control: string;
  home: string;
  cache: string;
  temp: string;
}

export interface EnvironmentCommand {
  executable: string;
  args: readonly string[];
  /** Path in the environment namespace; defaults to paths.workspace. */
  cwd?: string;
  environment?: Readonly<Record<string, string>>;
  /** Backend operation timeout; expiration fails without changing command meaning. */
  timeoutMs?: number;
}

export interface EnvironmentCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export const MAX_ENVIRONMENT_FILE_BYTES = 512 * 1024 * 1024;

export interface EnvironmentFileWrite {
  /** Absolute path in the environment namespace. */
  path: string;
  data: Uint8Array;
  /** POSIX permission bits applied after an atomic write when supported. */
  mode?: number;
}

export interface EnvironmentFileRead {
  /** Absolute path in the environment namespace. */
  path: string;
  /** Mandatory bound enforced before returning bytes to the Worker. */
  maxBytes: number;
}

export interface EnvironmentFileReceipt {
  path: string;
  byteLength: number;
  sha256: string;
}

export interface HostLaunchDescriptor {
  /** Host-visible launcher. It may be the command itself or a backend wrapper. */
  executable: string;
  args: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
  io: "pty";
  provenance: {
    kind: "execution_environment";
    ref: EnvironmentRef;
    profile: EnvironmentProfileIdentity;
  };
}

export type EnvironmentLifecycleState =
  | "running"
  | "stopped"
  | "removed"
  | "missing"
  | "incompatible"
  | "degraded";

export interface EnvironmentInspection {
  ref: EnvironmentRef;
  state: EnvironmentLifecycleState;
  usable: boolean;
  specDigest: string;
  paths: EnvironmentPathMap;
  capabilities: readonly EnvironmentCapability[];
  specMatches?: boolean;
  profileMatches?: boolean;
  diagnostics?: readonly EnvironmentReadinessDiagnostic[];
  provenance?: {
    implementationVersion?: string;
    nativeVersion?: string;
    nativeRevision?: string;
    nativeApiVersion?: string;
    profile?: EnvironmentProfileIdentity;
  };
}

export type EnvironmentReadinessStatus =
  | "ready"
  | "unavailable"
  | "incompatible";

export interface EnvironmentReadinessDiagnostic {
  code: string;
  message: string;
}

export interface EnvironmentReadiness {
  backendKind: string;
  status: EnvironmentReadinessStatus;
  ready: boolean;
  capabilities: readonly EnvironmentCapability[];
  diagnostics: readonly EnvironmentReadinessDiagnostic[];
  provenance: {
    contractVersion: number;
    implementationVersion?: string;
    nativeVersion?: string;
    nativeRevision?: string;
    nativeApiVersion?: string;
    testedNativeVersion?: string;
    testedNativeApiVersion?: string;
  };
}

/** Verified, currently usable binding to one exact physical incarnation. */
export interface EnvironmentLease {
  readonly ref: EnvironmentRef;
  readonly paths: EnvironmentPathMap;
  readonly capabilities: readonly EnvironmentCapability[];
  /** Environment-level variables intended for a terminal pane/process. */
  readonly paneEnvironment: Readonly<Record<string, string>>;
  /** Describe a host PTY launch into this environment. */
  launcher(command: EnvironmentCommand): Promise<HostLaunchDescriptor>;
  /** Worker-controlled noninteractive execution as the environment user. */
  exec(command: EnvironmentCommand): Promise<EnvironmentCommandResult>;
  /** Privileged control-plane execution. Never exposed as an agent tool. */
  workerExec(command: EnvironmentCommand): Promise<EnvironmentCommandResult>;
  /** Bounded, incarnation-fenced Worker-to-environment transfer. */
  writeFile(input: EnvironmentFileWrite): Promise<EnvironmentFileReceipt>;
  /** Bounded, incarnation-fenced environment-to-Worker transfer. */
  readFile(input: EnvironmentFileRead): Promise<Uint8Array>;
}

/**
 * Physical environment lifecycle only. Recovery authorization and harness/model
 * semantics remain outside this contract.
 */
export interface ExecutionEnvironmentBackend {
  readonly kind: string;
  readiness(): Promise<EnvironmentReadiness>;
  ensure(spec: EnvironmentSpec): Promise<EnvironmentLease>;
  recover(
    ref: EnvironmentRef,
    spec: EnvironmentSpec,
  ): Promise<EnvironmentLease>;
  inspect(ref: EnvironmentRef): Promise<EnvironmentInspection>;
  stop(ref: EnvironmentRef): Promise<void>;
  remove(ref: EnvironmentRef): Promise<void>;
}

export type EnvironmentBackendErrorCode =
  | "invalid_environment_spec"
  | "invalid_environment_ref"
  | "environment_not_found"
  | "stale_environment_ref"
  | "incompatible_environment_spec"
  | "environment_requirements_unmet"
  | "backend_unavailable"
  | "backend_incompatible"
  | "environment_identity_mismatch"
  | "environment_spec_mismatch"
  | "environment_unhealthy"
  | "environment_creation_ambiguous"
  | "operation_timeout"
  | "operation_failed"
  | "environment_not_usable"
  | "environment_removed"
  | "environment_operation_failed"
  | "injected_failure";

export class EnvironmentBackendError extends Error {
  constructor(
    readonly code: EnvironmentBackendErrorCode,
    message: string,
    readonly operation?: EnvironmentBackendOperation,
  ) {
    super(message);
  }
}
