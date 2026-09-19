import { createHash } from "node:crypto";
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
