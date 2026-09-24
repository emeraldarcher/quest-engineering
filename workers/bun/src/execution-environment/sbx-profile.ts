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
export const SBX_ANTIGRAVITY_RUNTIME_NETWORK_TARGETS = Object.freeze([
  "daily-cloudcode-pa.googleapis.com",
]);
export const SBX_PI_INSTALL_NETWORK_TARGET = "registry.npmjs.org";
export const SBX_ANTIGRAVITY_INSTALL_NETWORK_TARGETS = Object.freeze([
  "github.com",
  "release-assets.githubusercontent.com",
]);
export const SBX_MIXED_RUNTIME_NETWORK_TARGETS = Object.freeze([
  ...SBX_PI_RUNTIME_NETWORK_TARGETS,
  ...SBX_ANTIGRAVITY_RUNTIME_NETWORK_TARGETS,
]);
export const SBX_MIXED_INSTALL_NETWORK_TARGETS = Object.freeze([
  SBX_PI_INSTALL_NETWORK_TARGET,
  ...SBX_ANTIGRAVITY_INSTALL_NETWORK_TARGETS,
]);
export const SBX_PI_EXECUTABLE = "/opt/qe/pi/node_modules/.bin/pi";
export const SBX_ANTIGRAVITY_EXECUTABLE = "/opt/qe/antigravity/agy";
export const SBX_PI_DISCOVERY_SCRIPT =
  "/home/agent/.qe-profile/discover-models.mjs";
export const SBX_PI_RUNTIME_PROBE = "/home/agent/.qe-profile/probe-runtime.mjs";
export const SBX_PI_RESOURCE_PROBE =
  "/home/agent/.qe-profile/probe-resource.mjs";
export const SBX_PI_METADATA_SNAPSHOT =
  "/qe/state/openai-codex-model-metadata.json";
export const SBX_ANTIGRAVITY_RUNTIME_PROBE =
  "/home/agent/.qe-profile/probe-antigravity-runtime.mjs";
export const SBX_ANTIGRAVITY_VERSION = "1.2.7";
export const SBX_ANTIGRAVITY_LINUX_ARM64_ARCHIVE_SHA256 =
  "8ddbb669158de1d1bc4c1fe5c130dca8f51da80d62569a54a4133f06768a723b";
export const SBX_ANTIGRAVITY_LINUX_ARM64_BINARY_SHA256 =
  "ac6a97924c7f0ac5065d0facf8c9e771975ef996069f3e9e50f9c7e27ba45fc4";

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

const SBX_CODING_PROFILE_ASSETS = Object.freeze({
  "spec.yaml":
    "ee4b1be7d3fd309c60378de434b67e1c6b0ecc67298c36211fde6fe3078ff1d1",
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
  "files/home/.qe-profile/probe-antigravity-runtime.mjs":
    "c4a7b19cc87509e3ca2f11782fdc80ca68b0b40d3b00a1da7aca85ea5fe3d43a",
  "files/home/.gemini/config/mcp_config.json":
    "29f1bd0a818cc1824d34953d1dafb97831be0ae6ea477b88c9298a2cdbd45b79",
});

export const SBX_CODING_EXECUTION_PROFILE_V1_DEFINITION = Object.freeze({
  schemaVersion: 1,
  id: "qe-coding-execution-v1",
  backend: "docker-sandboxes",
  kitSchemaVersion: "2",
  kitName: "qe-coding-execution-v1",
  baseImage:
    "docker.io/docker/sandbox-templates:shell-docker@sha256:5fc81bc7a127e59d81b244a06831ae3212a0310b2e5a0349c54e29249e45e919",
  harnesses: Object.freeze({
    pi: "@earendil-works/pi-coding-agent@0.85.1",
    antigravity: Object.freeze({
      version: SBX_ANTIGRAVITY_VERSION,
      artifact:
        "github.com/google-antigravity/antigravity-cli/releases/download/1.2.7/agy_cli_linux_arm64.tar.gz",
      archiveSha256: SBX_ANTIGRAVITY_LINUX_ARM64_ARCHIVE_SHA256,
      binarySha256: SBX_ANTIGRAVITY_LINUX_ARM64_BINARY_SHA256,
    }),
  }),
  assets: SBX_CODING_PROFILE_ASSETS,
  mounts: Object.freeze([]),
  skills: "off",
  staticMcpServers: Object.freeze(["qe"]),
  credentials: Object.freeze([
    "host_pi_oauth_dynamic_proxy",
    "host_antigravity_oauth_dynamic_proxy",
  ]),
  network: Object.freeze({
    runtimeAllow: SBX_MIXED_RUNTIME_NETWORK_TARGETS,
    postInstallDeny: SBX_MIXED_INSTALL_NETWORK_TARGETS,
  }),
  sshAgentForwarding: "required_disabled",
  paths: SBX_GUEST_PATHS,
  compatibility: Object.freeze({
    mode: "capabilities",
    piProbe: SBX_PI_RUNTIME_PROBE,
    piResourceProbe: SBX_PI_RESOURCE_PROBE,
    antigravityProbe: SBX_ANTIGRAVITY_RUNTIME_PROBE,
  }),
});

export const SBX_CODING_EXECUTION_PROFILE_V1: EnvironmentProfileIdentity =
  Object.freeze({
    id: SBX_CODING_EXECUTION_PROFILE_V1_DEFINITION.id,
    digest: digest(SBX_CODING_EXECUTION_PROFILE_V1_DEFINITION),
  });

export interface SbxExecutionProfile {
  identity: EnvironmentProfileIdentity;
  agentReference: string;
  nativeAgent: string;
  networkMode: "deny_all" | "openai_subscription" | "mixed_subscriptions";
  credentialMode:
    | "none"
    | "host_pi_oauth_dynamic_proxy"
    | "host_mixed_oauth_dynamic_proxies";
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

export const SBX_CODING_PROFILE_ROOT = resolve(
  import.meta.dir,
  "../../profiles/qe-coding-execution-v1",
);

export const SBX_CODING_PROFILE: SbxExecutionProfile = Object.freeze({
  identity: SBX_CODING_EXECUTION_PROFILE_V1,
  agentReference: SBX_CODING_PROFILE_ROOT,
  nativeAgent: "qe-coding-execution-v1",
  networkMode: "mixed_subscriptions",
  credentialMode: "host_mixed_oauth_dynamic_proxies",
  postCreateNetworkDenies: SBX_MIXED_INSTALL_NETWORK_TARGETS,
});

export async function verifySbxProfileAssets(
  profile: SbxExecutionProfile,
): Promise<void> {
  const expected =
    profile.identity.id === SBX_PI_EXECUTION_PROFILE_V2.id &&
    profile.identity.digest === SBX_PI_EXECUTION_PROFILE_V2.digest
      ? {
          root: SBX_PI_PROFILE_ROOT,
          assets: SBX_PI_PROFILE_ASSETS,
          label: "Pi",
        }
      : profile.identity.id === SBX_CODING_EXECUTION_PROFILE_V1.id &&
          profile.identity.digest === SBX_CODING_EXECUTION_PROFILE_V1.digest
        ? {
            root: SBX_CODING_PROFILE_ROOT,
            assets: SBX_CODING_PROFILE_ASSETS,
            label: "mixed coding",
          }
        : null;
  if (!expected) return;
  if (resolve(profile.agentReference) !== expected.root)
    throw new Error(
      `The ${expected.label} SBX profile does not use the repository-owned kit.`,
    );
  for (const [relativePath, expectedDigest] of Object.entries(
    expected.assets,
  )) {
    const path = resolve(expected.root, relativePath);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error(
        `Repository-owned ${expected.label} SBX profile asset is not a regular file: ${relativePath}.`,
      );
    const actual = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    if (actual !== expectedDigest)
      throw new Error(
        `Repository-owned ${expected.label} SBX profile asset failed integrity verification: ${relativePath}.`,
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
