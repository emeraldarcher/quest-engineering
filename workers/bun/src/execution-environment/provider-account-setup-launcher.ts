import { createHash } from "node:crypto";
import { claudeSubscriptionEnvironment } from "../provider-auth.ts";
import { SBX_CLAUDE_EXECUTABLE } from "./sbx-profile.ts";
import type {
  EnvironmentLease,
  EnvironmentPathMap,
  StreamedProcessCommand,
  StreamedProcessOptions,
} from "./types.ts";
import { EnvironmentBackendError } from "./types.ts";

export const CLAUDE_LOGIN_INTERACTION_IDENTITY =
  "claude-code-2.1.292-auth-login-stdout-v1";
export const CLAUDE_SUBSCRIPTION_SETUP_LAUNCHER_IDENTITY =
  "claude-code-2.1.292-subscription-login-v1";

export interface ProviderAccountSetupLaunchContext {
  providerKey: string;
  paths: EnvironmentPathMap;
}

export interface ProviderAccountSetupLaunchSpec {
  contractVersion: 1;
  launcherIdentity: string;
  providerKey: string;
  interactionRecognizerIdentity: string;
  command: StreamedProcessCommand;
  options: StreamedProcessOptions;
}

/** Safe durable authority. The executable is trusted only after matching the current launcher. */
export interface ProviderAccountSetupLaunchAuthority {
  contractVersion: 1;
  launcherIdentity: string;
  interactionRecognizerIdentity: string;
  expectedExecutable: string;
  launchSpecDigest: string;
}

/** Trusted in-process policy for constructing one exact physical setup launch. */
export interface ProviderAccountSetupLauncher {
  readonly identity: string;
  readonly providerKey: string;
  readonly executable: string;
  readonly interactionRecognizerIdentity: string;
  specification(
    context: ProviderAccountSetupLaunchContext,
  ): ProviderAccountSetupLaunchSpec;
  prepare(
    lease: EnvironmentLease,
    spec: ProviderAccountSetupLaunchSpec,
  ): Promise<void>;
}

export class ClaudeSubscriptionSetupLauncher
  implements ProviderAccountSetupLauncher
{
  readonly identity = CLAUDE_SUBSCRIPTION_SETUP_LAUNCHER_IDENTITY;
  readonly providerKey = "anthropic";
  readonly executable = SBX_CLAUDE_EXECUTABLE;
  readonly interactionRecognizerIdentity = CLAUDE_LOGIN_INTERACTION_IDENTITY;

  specification(
    context: ProviderAccountSetupLaunchContext,
  ): ProviderAccountSetupLaunchSpec {
    if (context.providerKey !== this.providerKey)
      throw new EnvironmentBackendError(
        "backend_incompatible",
        "The production ProviderAccount setup launcher supports Anthropic accounts only.",
      );
    const configRoot = `${context.paths.state}/claude/config`;
    return immutableSetupLaunchSpec({
      contractVersion: 1,
      launcherIdentity: this.identity,
      providerKey: this.providerKey,
      interactionRecognizerIdentity: this.interactionRecognizerIdentity,
      command: {
        executable: this.executable,
        args: ["auth", "login"],
        cwd: `${context.paths.state}/claude/empty-cwd`,
        environment: claudeSubscriptionEnvironment(configRoot),
      },
      options: {
        bufferBytes: 64 * 1024,
        acknowledgementTimeoutMs: 30_000,
      },
    });
  }

  async prepare(
    lease: EnvironmentLease,
    spec: ProviderAccountSetupLaunchSpec,
  ): Promise<void> {
    assertLauncherOwnsSpec(this, spec, lease.paths);
    await prepareClaudeAccountDirectories(lease);
  }
}

export function immutableSetupLaunchSpec(
  value: ProviderAccountSetupLaunchSpec,
): ProviderAccountSetupLaunchSpec {
  validateSetupLaunchSpec(value);
  return Object.freeze({
    ...value,
    command: Object.freeze({
      ...value.command,
      args: Object.freeze([...value.command.args]),
      environment: Object.freeze({ ...value.command.environment }),
    }),
    options: Object.freeze({ ...value.options }),
  });
}

export function setupLaunchAuthority(
  launcher: ProviderAccountSetupLauncher,
  spec: ProviderAccountSetupLaunchSpec,
  paths: EnvironmentPathMap,
): ProviderAccountSetupLaunchAuthority {
  assertLauncherOwnsSpec(launcher, spec, paths);
  return Object.freeze({
    contractVersion: 1,
    launcherIdentity: spec.launcherIdentity,
    interactionRecognizerIdentity: spec.interactionRecognizerIdentity,
    expectedExecutable: spec.command.executable,
    launchSpecDigest: launchSpecDigest(spec),
  });
}

export function assertTrustedSetupLaunchAuthority(
  persisted: ProviderAccountSetupLaunchAuthority | null,
  trusted: ProviderAccountSetupLaunchAuthority,
): void {
  validateSetupLaunchAuthority(persisted);
  validateSetupLaunchAuthority(trusted);
  if (
    persisted.contractVersion !== trusted.contractVersion ||
    persisted.launcherIdentity !== trusted.launcherIdentity ||
    persisted.interactionRecognizerIdentity !==
      trusted.interactionRecognizerIdentity ||
    persisted.expectedExecutable !== trusted.expectedExecutable ||
    persisted.launchSpecDigest !== trusted.launchSpecDigest
  )
    throw new EnvironmentBackendError(
      "streamed_process_identity_mismatch",
      "The durable ProviderAccount setup invocation does not match the current trusted launcher policy.",
    );
}

export function validateSetupLaunchAuthority(
  value: ProviderAccountSetupLaunchAuthority | null,
): asserts value is ProviderAccountSetupLaunchAuthority {
  if (
    !value ||
    !exactKeys(value, [
      "contractVersion",
      "expectedExecutable",
      "interactionRecognizerIdentity",
      "launchSpecDigest",
      "launcherIdentity",
    ]) ||
    value.contractVersion !== 1 ||
    !validIdentity(value.launcherIdentity) ||
    !validIdentity(value.interactionRecognizerIdentity) ||
    !validAbsolutePath(value.expectedExecutable) ||
    !/^[0-9a-f]{64}$/.test(value.launchSpecDigest)
  )
    throw new Error(
      "ProviderAccount setup durable launch authority is incompatible.",
    );
}

export function validateSetupLaunchSpec(
  value: ProviderAccountSetupLaunchSpec,
  paths?: EnvironmentPathMap,
): void {
  const command = value?.command;
  const options = value?.options;
  if (
    !value ||
    !exactKeys(value, [
      "command",
      "contractVersion",
      "interactionRecognizerIdentity",
      "launcherIdentity",
      "options",
      "providerKey",
    ]) ||
    value.contractVersion !== 1 ||
    !validIdentity(value.launcherIdentity) ||
    !validIdentity(value.interactionRecognizerIdentity) ||
    !validIdentity(value.providerKey) ||
    !command ||
    !exactKeys(command, ["args", "cwd", "environment", "executable"]) ||
    !validAbsolutePath(command.executable) ||
    !validAbsolutePath(command.cwd) ||
    !Array.isArray(command.args) ||
    command.args.length > 32 ||
    command.args.some(
      (argument) =>
        typeof argument !== "string" ||
        argument.length > 8_192 ||
        argument.includes("\u0000") ||
        argument.includes("\r") ||
        argument.includes("\n"),
    ) ||
    !validEnvironment(command.environment) ||
    !options ||
    !exactKeys(options, ["acknowledgementTimeoutMs", "bufferBytes"]) ||
    !positiveInteger(options.bufferBytes) ||
    !positiveInteger(options.acknowledgementTimeoutMs) ||
    (paths && !pathInsideLease(command.cwd, paths))
  )
    throw new EnvironmentBackendError(
      "backend_incompatible",
      "ProviderAccount setup launcher produced an incompatible launch specification.",
      "spawn_streamed",
      "not_submitted",
    );
}

export async function prepareClaudeAccountDirectories(
  lease: EnvironmentLease,
): Promise<void> {
  const configRoot = `${lease.paths.state}/claude/config`;
  const cwd = `${lease.paths.state}/claude/empty-cwd`;
  await lease.workerExec({
    executable: "/usr/bin/install",
    args: [
      "-d",
      "-m",
      "0700",
      "-o",
      "1000",
      "-g",
      "1000",
      configRoot,
      `${configRoot}/tmp`,
      cwd,
    ],
  });
  await lease.workerExec({
    executable: "/usr/bin/python3",
    args: [
      "-c",
      "import json,os,pathlib; p=pathlib.Path(os.environ['P']); value={}\ntry:\n value=json.loads(p.read_text())\nexcept Exception: pass\nvalue['hasCompletedOnboarding']=True; t=p.with_suffix('.tmp'); t.write_text(json.dumps(value,separators=(',',':'))); os.chmod(t,0o600); os.chown(t,1000,1000); os.replace(t,p)",
    ],
    environment: { P: `${configRoot}/.claude.json` },
  });
}

function assertLauncherOwnsSpec(
  launcher: ProviderAccountSetupLauncher,
  spec: ProviderAccountSetupLaunchSpec,
  paths: EnvironmentPathMap,
): void {
  validateSetupLaunchSpec(spec, paths);
  if (
    spec.launcherIdentity !== launcher.identity ||
    spec.providerKey !== launcher.providerKey ||
    spec.interactionRecognizerIdentity !==
      launcher.interactionRecognizerIdentity ||
    spec.command.executable !== launcher.executable
  )
    throw new EnvironmentBackendError(
      "backend_incompatible",
      "ProviderAccount setup launch specification conflicts with its trusted launcher.",
      "spawn_streamed",
      "not_submitted",
    );
}

function launchSpecDigest(spec: ProviderAccountSetupLaunchSpec): string {
  const environment = Object.fromEntries(
    Object.entries(spec.command.environment).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        contractVersion: spec.contractVersion,
        launcherIdentity: spec.launcherIdentity,
        providerKey: spec.providerKey,
        interactionRecognizerIdentity: spec.interactionRecognizerIdentity,
        command: {
          executable: spec.command.executable,
          args: [...spec.command.args],
          cwd: spec.command.cwd,
          environment,
        },
        options: {
          bufferBytes: spec.options.bufferBytes,
          acknowledgementTimeoutMs: spec.options.acknowledgementTimeoutMs,
        },
      }),
    )
    .digest("hex");
}

function validEnvironment(
  value: Readonly<Record<string, string>> | undefined,
): boolean {
  if (!value || Array.isArray(value) || Object.keys(value).length > 64)
    return false;
  return Object.entries(value).every(
    ([name, item]) =>
      /^[A-Z_][A-Z0-9_]{0,127}$/.test(name) &&
      typeof item === "string" &&
      item.length <= 16_384 &&
      !item.includes("\u0000"),
  );
}

function pathInsideLease(path: string, paths: EnvironmentPathMap): boolean {
  return Object.values(paths).some(
    (root) => path === root || path.startsWith(`${root}/`),
  );
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function validIdentity(value: unknown): value is string {
  return (
    typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{0,127}$/.test(value)
  );
}

function validAbsolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.includes("\u0000") &&
    !value.split("/").includes("..") &&
    value.length <= 1_024
  );
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
