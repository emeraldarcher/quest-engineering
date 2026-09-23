import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  EnvironmentPathMap,
  EnvironmentProfileIdentity,
} from "./types.ts";

export const SBX_TESTED_VERSION = "v0.43.0";
export const SBX_TESTED_API_VERSION = "0.31.0";
export const SBX_TESTED_REVISION = "79805a6e3c6667520dc2da4f6bdeddae9b700969";

export const SBX_GUEST_PATHS: EnvironmentPathMap = Object.freeze({
  workspace: "/qe/workspaces/default",
  state: "/qe/state",
  control: "/qe/control",
  home: "/home/agent",
  cache: "/home/agent/.cache",
  temp: "/tmp/qe",
});

export const SBX_DISABLED_CREDENTIAL_ENVIRONMENT = Object.freeze({
  ANTHROPIC_API_KEY: "none",
  GH_TOKEN: "none",
  GITHUB_TOKEN: "none",
  GOOGLE_API_KEY: "none",
  MISTRAL_API_KEY: "none",
  NEBIUS_API_KEY: "none",
  OPENAI_API_KEY: "none",
  OPENROUTER_API_KEY: "none",
  XAI_API_KEY: "none",
});

const SBX_AGENT_SOURCE = Object.freeze({
  kind: "sbx_builtin_compatible_floor",
  testedVersion: SBX_TESTED_VERSION,
  testedApiVersion: SBX_TESTED_API_VERSION,
  testedRevision: SBX_TESTED_REVISION,
});

export const SBX_EXECUTION_PROFILE_V1_DEFINITION = Object.freeze({
  schemaVersion: 1,
  id: "qe-execution-v1",
  backend: "docker-sandboxes",
  agent: "shell",
  agentSource: SBX_AGENT_SOURCE,
  mounts: Object.freeze([]),
  skills: "off",
  staticMcpServers: Object.freeze([]),
  credentials: "none",
  credentialEnvironment: SBX_DISABLED_CREDENTIAL_ENVIRONMENT,
  network: "sandbox_scoped_deny_all",
  sshAgentForwarding: "required_disabled",
  paths: SBX_GUEST_PATHS,
});

export const SBX_EXECUTION_PROFILE_V1: EnvironmentProfileIdentity =
  Object.freeze({
    id: SBX_EXECUTION_PROFILE_V1_DEFINITION.id,
    digest: digest(SBX_EXECUTION_PROFILE_V1_DEFINITION),
  });

export const SBX_PI_RUNTIME_NETWORK_TARGETS = Object.freeze(["chatgpt.com"]);
export const SBX_PI_INSTALL_NETWORK_TARGET = "registry.npmjs.org";
export const SBX_PI_EXECUTABLE = "/opt/qe/pi/node_modules/.bin/pi";
export const SBX_PI_DISCOVERY_SCRIPT =
  "/home/agent/.qe-profile/discover-models.mjs";
export const SBX_PI_RUNTIME_PROBE = "/home/agent/.qe-profile/probe-runtime.mjs";
export const SBX_PI_RESOURCE_PROBE =
  "/home/agent/.qe-profile/probe-resource.mjs";
export const SBX_PI_METADATA_SNAPSHOT =
  "/qe/state/openai-codex-model-metadata.json";

const SBX_PI_PROFILE_ASSETS = Object.freeze({
  "spec.yaml":
    "6b3d1bef0ba8584d9a1327d078487f0c1ec8235e16efdc9b9dfc46ea2df7f724",
  "files/home/.qe-profile/package.json":
    "212bd50e14991cd48cb6202e9708175458f17c3c4bf37cb6c81c3911c74611e3",
  "files/home/.qe-profile/package-lock.json":
    "e277d2df9fa8c58e2c9be763f9102e8204e7a8e92d50777d2b61091fc36ee032",
  "files/home/.qe-profile/codex-model-eligibility.mjs":
    "e8fbc8b2ed437ebaec0214a5c7ab1b61a6562438b9cc863235b8a2a1a0016972",
  "files/home/.qe-profile/discover-models.mjs":
    "bac7e4929fc881e76539c3220be632938ce418ff865297d656fe0164cc270e93",
  "files/home/.qe-profile/probe-runtime.mjs":
    "3ffa1e4c1034f7ffd1a0a75aaa96d7cd917b958adb5824af361bad3f0c1e122b",
  "files/home/.qe-profile/probe-resource.mjs":
    "514354d2aef1334886578e8e9733af7dbdfdd030495000977b88c9d049e1e41c",
});

export const SBX_PI_EXECUTION_PROFILE_V2_DEFINITION = Object.freeze({
  schemaVersion: 2,
  id: "qe-pi-execution-v2",
  backend: "docker-sandboxes",
  kitSchemaVersion: "2",
  kitName: "qe-pi-execution-v2",
  baseImage:
    "docker.io/docker/sandbox-templates:shell-docker@sha256:5fc81bc7a127e59d81b244a06831ae3212a0310b2e5a0349c54e29249e45e919",
  piPackage: "@earendil-works/pi-coding-agent@0.85.1",
  assets: SBX_PI_PROFILE_ASSETS,
  mounts: Object.freeze([]),
  skills: "off",
  staticMcpServers: Object.freeze([]),
  credential: "host_pi_oauth_dynamic_proxy",
  credentialEnvironment: "sandbox_scoped_nonsecret_placeholder_only",
  network: Object.freeze({
    runtimeAllow: SBX_PI_RUNTIME_NETWORK_TARGETS,
    postInstallDeny: SBX_PI_INSTALL_NETWORK_TARGET,
  }),
  sshAgentForwarding: "required_disabled",
  paths: SBX_GUEST_PATHS,
  compatibility: Object.freeze({
    mode: "capabilities",
    probe: SBX_PI_RUNTIME_PROBE,
    resourceProbe: SBX_PI_RESOURCE_PROBE,
  }),
});

export const SBX_PI_EXECUTION_PROFILE_V2: EnvironmentProfileIdentity =
  Object.freeze({
    id: SBX_PI_EXECUTION_PROFILE_V2_DEFINITION.id,
    digest: digest(SBX_PI_EXECUTION_PROFILE_V2_DEFINITION),
  });

export interface SbxExecutionProfile {
  identity: EnvironmentProfileIdentity;
  agentReference: string;
  nativeAgent: string;
  networkMode: "deny_all" | "openai_subscription";
  credentialMode: "none" | "host_pi_oauth_dynamic_proxy";
  postCreateNetworkDenies: readonly string[];
}

export const SBX_SHELL_PROFILE: SbxExecutionProfile = Object.freeze({
  identity: SBX_EXECUTION_PROFILE_V1,
  agentReference: "shell",
  nativeAgent: "shell",
  networkMode: "deny_all",
  credentialMode: "none",
  postCreateNetworkDenies: Object.freeze([]),
});

export const SBX_PI_PROFILE_ROOT = resolve(
  import.meta.dir,
  "../../profiles/qe-pi-execution-v2",
);

export const SBX_PI_PROFILE: SbxExecutionProfile = Object.freeze({
  identity: SBX_PI_EXECUTION_PROFILE_V2,
  agentReference: SBX_PI_PROFILE_ROOT,
  nativeAgent: "qe-pi-execution-v2",
  networkMode: "openai_subscription",
  credentialMode: "host_pi_oauth_dynamic_proxy",
  postCreateNetworkDenies: Object.freeze([SBX_PI_INSTALL_NETWORK_TARGET]),
});

export async function verifySbxProfileAssets(
  profile: SbxExecutionProfile,
): Promise<void> {
  if (
    profile.identity.id !== SBX_PI_EXECUTION_PROFILE_V2.id ||
    profile.identity.digest !== SBX_PI_EXECUTION_PROFILE_V2.digest
  )
    return;
  if (resolve(profile.agentReference) !== SBX_PI_PROFILE_ROOT)
    throw new Error(
      "The Pi SBX profile does not use the repository-owned kit.",
    );
  for (const [relativePath, expected] of Object.entries(
    SBX_PI_PROFILE_ASSETS,
  )) {
    const path = resolve(SBX_PI_PROFILE_ROOT, relativePath);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error(
        `Repository-owned Pi SBX profile asset is not a regular file: ${relativePath}.`,
      );
    const actual = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    if (actual !== expected)
      throw new Error(
        `Repository-owned Pi SBX profile asset failed integrity verification: ${relativePath}.`,
      );
  }
}

export interface SbxResourcePolicy {
  identity: {
    id: string;
    digest: string;
  };
  cpus: number;
  memory: string;
  privateDockerDisk: string;
  unsupportedControls: readonly string[];
}

const DISPOSABLE_RESOURCE_DEFINITION = Object.freeze({
  schemaVersion: 1,
  id: "qe-sbx-disposable-v1",
  cpus: 1,
  memory: "1g",
  privateDockerDisk: "1g",
  unsupportedControls: Object.freeze(["root_disk", "pid_limit"]),
});

export const SBX_DISPOSABLE_RESOURCE_POLICY: SbxResourcePolicy = Object.freeze({
  identity: Object.freeze({
    id: DISPOSABLE_RESOURCE_DEFINITION.id,
    digest: digest(DISPOSABLE_RESOURCE_DEFINITION),
  }),
  cpus: DISPOSABLE_RESOURCE_DEFINITION.cpus,
  memory: DISPOSABLE_RESOURCE_DEFINITION.memory,
  privateDockerDisk: DISPOSABLE_RESOURCE_DEFINITION.privateDockerDisk,
  unsupportedControls: DISPOSABLE_RESOURCE_DEFINITION.unsupportedControls,
});

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
