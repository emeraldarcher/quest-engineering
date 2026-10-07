import type { SbxClient, SbxNativeVersion } from "./sbx-client.ts";
import { SbxClientError } from "./sbx-client.ts";
import { SBX_TESTED_API_VERSION, SBX_TESTED_VERSION } from "./sbx-profile.ts";
import type {
  EnvironmentCapability,
  EnvironmentReadiness,
  EnvironmentReadinessDiagnostic,
} from "./types.ts";

export interface SbxVersionPolicy {
  testedVersion: string;
  testedApiVersion: string;
  knownBadVersions: Readonly<Record<string, string>>;
}

export const DEFAULT_SBX_VERSION_POLICY: SbxVersionPolicy = Object.freeze({
  testedVersion: SBX_TESTED_VERSION,
  testedApiVersion: SBX_TESTED_API_VERSION,
  knownBadVersions: Object.freeze({}),
});

export async function inspectSbxReadiness(
  client: SbxClient,
  versionPolicy: SbxVersionPolicy = DEFAULT_SBX_VERSION_POLICY,
): Promise<EnvironmentReadiness> {
  let native: SbxNativeVersion;
  try {
    native = await client.version();
  } catch (error) {
    return preVersionFailure(error);
  }

  const provenance = {
    contractVersion: 1,
    implementationVersion: "sbx-environment-backend-v1",
    nativeVersion: native.clientVersion,
    nativeRevision: native.clientRevision,
    ...(native.apiVersion ? { nativeApiVersion: native.apiVersion } : {}),
    testedNativeVersion: versionPolicy.testedVersion,
    testedNativeApiVersion: versionPolicy.testedApiVersion,
  };
  if (native.serverState !== "running")
    return {
      backendKind: "sbx",
      status: "unavailable",
      ready: false,
      capabilities: [],
      diagnostics: [
        {
          code: "backend_unavailable",
          message:
            "Docker Sandboxes daemon is not running; start it explicitly before QE readiness.",
        },
      ],
      provenance,
    };

  const badReason =
    versionPolicy.knownBadVersions[
      `${native.clientVersion}@${native.clientRevision}`
    ] ??
    versionPolicy.knownBadVersions[native.clientVersion] ??
    (native.serverVersion && native.serverRevision
      ? (versionPolicy.knownBadVersions[
          `${native.serverVersion}@${native.serverRevision}`
        ] ?? versionPolicy.knownBadVersions[native.serverVersion])
      : undefined);
  if (badReason)
    return {
      backendKind: "sbx",
      status: "incompatible",
      ready: false,
      capabilities: [],
      diagnostics: [
        {
          code: "known_bad_native_version",
          message: `Installed Docker Sandboxes version is rejected by security policy: ${badReason}`,
        },
      ],
      provenance,
    };

  const installed = semanticVersion(native.clientVersion);
  const tested = semanticVersion(versionPolicy.testedVersion);
  const installedApi = native.apiVersion
    ? semanticVersion(native.apiVersion)
    : null;
  const testedApi = semanticVersion(versionPolicy.testedApiVersion);
  if (!installed || !tested || !installedApi || !testedApi)
    return incompatible(
      provenance,
      "malformed_native_version",
      "Docker Sandboxes reported a malformed semantic version or API version.",
    );
  if (
    native.serverVersion !== native.clientVersion ||
    native.serverRevision !== native.clientRevision
  )
    return incompatible(
      provenance,
      "client_server_version_mismatch",
      "Docker Sandboxes client and daemon provenance do not match.",
    );
  if (compareVersions(installed, tested) < 0)
    return incompatible(
      provenance,
      "older_than_tested",
      `Docker Sandboxes ${native.clientVersion} is older than the tested security baseline ${versionPolicy.testedVersion}.`,
    );
  if (compareVersions(installedApi, testedApi) < 0)
    return incompatible(
      provenance,
      "api_older_than_tested",
      `Docker Sandboxes API ${native.apiVersion} is older than the tested API baseline ${versionPolicy.testedApiVersion}.`,
    );

  try {
    await client.list();
    const [, ssh, mcpServers] = await Promise.all([
      // Structured policy inventory proves the policy API is available. Exact
      // deny/allow rules are Run-scoped and verified only after VM creation.
      client.policies(),
      client.setting("ssh.agentForwardingEnabled"),
      client.registeredMcpServerCount(),
    ]);
    const diagnostics: EnvironmentReadinessDiagnostic[] = [];
    if (ssh.value !== false)
      diagnostics.push({
        code: "ssh_agent_forwarding_enabled",
        message:
          "SSH-agent forwarding must be explicitly disabled before QE creates environments.",
      });
    if (mcpServers !== 0)
      diagnostics.push({
        code: "ambient_mcp_registered",
        message:
          "Phase-2 QE environments require an empty ambient MCP registry.",
      });
    if (diagnostics.length > 0)
      return {
        backendKind: "sbx",
        status: "unavailable",
        ready: false,
        capabilities: [],
        diagnostics,
        provenance,
      };

    const capabilities: EnvironmentCapability[] = [
      { kind: "environment_lifecycle", mode: "durable" },
      { kind: "environment_inventory", mode: "structured" },
      { kind: "network_policy", mode: "sandbox_scoped" },
      { kind: "ssh_agent_forwarding", mode: "disabled" },
      { kind: "ambient_mcp", mode: "unavailable" },
      { kind: "shared_skills", mode: "controllable" },
      {
        kind: "process.streamed",
        mode: "attached_only",
        detail:
          "SBX exec supports attached non-PTY streams; stdio cannot be reattached after Worker loss.",
      },
    ];
    if (compareVersions(installed, tested) > 0)
      diagnostics.push({
        code: "newer_than_tested_but_compatible",
        message: `Docker Sandboxes ${native.clientVersion} is newer than tested ${versionPolicy.testedVersion}; the complete capability contract passed.`,
      });
    return {
      backendKind: "sbx",
      status: "ready",
      ready: true,
      capabilities,
      diagnostics,
      provenance,
    };
  } catch (error) {
    const failure = classifyReadinessError(error);
    return {
      backendKind: "sbx",
      status: failure.status,
      ready: false,
      capabilities: [],
      diagnostics: [{ code: failure.code, message: message(error) }],
      provenance,
    };
  }
}

function preVersionFailure(error: unknown): EnvironmentReadiness {
  const failure = classifyReadinessError(error);
  return {
    backendKind: "sbx",
    status: failure.status,
    ready: false,
    capabilities: [],
    diagnostics: [{ code: failure.code, message: message(error) }],
    provenance: {
      contractVersion: 1,
      implementationVersion: "sbx-environment-backend-v1",
      testedNativeVersion: SBX_TESTED_VERSION,
      testedNativeApiVersion: SBX_TESTED_API_VERSION,
    },
  };
}

function classifyReadinessError(error: unknown): {
  status: "incompatible" | "unavailable";
  code: string;
} {
  if (!(error instanceof SbxClientError))
    return { status: "unavailable", code: "backend_unavailable" };
  switch (error.code) {
    case "backend_incompatible":
    case "malformed_backend_response":
      return { status: "incompatible", code: "backend_incompatible" };
    case "operation_timeout":
      return { status: "unavailable", code: "operation_timeout" };
    case "operation_failed":
      return { status: "unavailable", code: "operation_failed" };
    case "backend_unavailable":
      return { status: "unavailable", code: "backend_unavailable" };
  }
}

function incompatible(
  provenance: EnvironmentReadiness["provenance"],
  code: string,
  detail: string,
): EnvironmentReadiness {
  return {
    backendKind: "sbx",
    status: "incompatible",
    ready: false,
    capabilities: [],
    diagnostics: [{ code, message: detail }],
    provenance,
  };
}

function semanticVersion(value: string): [number, number, number] | null {
  const match = value.match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(
  left: [number, number, number],
  right: [number, number, number],
): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] as number) - (right[index] as number);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
