import type { EnvironmentCommand, EnvironmentCommandResult } from "./types.ts";

export interface SbxNativeVersion {
  clientVersion: string;
  clientRevision: string;
  serverState: "running" | "unavailable" | (string & {});
  serverVersion?: string;
  serverRevision?: string;
  apiVersion?: string;
  serverError?: string;
}

export interface SbxSandboxSummary {
  name: string;
  id: string;
  agent: string;
  status: string;
  lastUsedAt?: string;
}

export interface SbxPolicyRule {
  id: string;
  policyId?: string;
  scope: string;
  appliesTo: string;
  resourceType: string;
  decision: string;
  resources: readonly string[];
  status: string;
  sandboxId?: string;
}

export interface SbxSetting {
  key: string;
  type: string;
  source: string;
  value: unknown;
}

export interface SbxCreateRequest {
  name: string;
  /** Built-in agent name or repository-owned absolute kit path. */
  agentReference?: string;
  denyAllNetwork?: boolean;
  cpus: number;
  memory: string;
  privateDockerDisk: string;
  environment: Readonly<Record<string, string>>;
}

export interface SbxExecOptions {
  user?: string;
  interactive?: boolean;
  tty?: boolean;
  /** Generic lease exec returns non-zero status; lifecycle probes fail on it. */
  allowNonZero?: boolean;
}

export interface SbxDynamicSecretRequest {
  sandboxName: string;
  placeholder: string;
  /** Exact outbound hosts where SBX may replace this placeholder. */
  hosts: readonly string[];
  resolverCommand: string;
  refreshInterval: string;
}

export interface SbxRequestOptions {
  timeoutMs?: number;
}

export interface SbxStopOptions extends SbxRequestOptions {
  /** Called durably immediately before the CLI subprocess may be spawned. */
  onInvocation?: () => void | Promise<void>;
}

export interface SbxClient {
  readonly executable: string;
  version(): Promise<SbxNativeVersion>;
  list(options?: SbxRequestOptions): Promise<SbxSandboxSummary[]>;
  policies(sandboxName?: string): Promise<SbxPolicyRule[]>;
  setting(key: string): Promise<SbxSetting>;
  registeredMcpServerCount(): Promise<number>;
  create(request: SbxCreateRequest): Promise<void>;
  setDynamicSecret(request: SbxDynamicSecretRequest): Promise<void>;
  removeDynamicSecret(sandboxName: string, placeholder: string): Promise<void>;
  denyNetwork(sandboxName: string, resources: readonly string[]): Promise<void>;
  exec(
    sandboxName: string,
    command: EnvironmentCommand,
    options?: SbxExecOptions,
  ): Promise<EnvironmentCommandResult>;
  copyTo(
    sandboxName: string,
    hostPath: string,
    guestPath: string,
  ): Promise<void>;
  copyFrom(
    sandboxName: string,
    guestPath: string,
    hostPath: string,
  ): Promise<void>;
  stop(sandboxName: string, options?: SbxStopOptions): Promise<void>;
  remove(sandboxName: string): Promise<void>;
  launcherArgs(
    sandboxName: string,
    command: EnvironmentCommand,
  ): readonly string[];
  /** Non-PTY attached exec with stdin kept open for the generic stream relay. */
  streamLauncherArgs(
    sandboxName: string,
    command: EnvironmentCommand,
  ): readonly string[];
}

export interface SbxSubprocessRequest {
  args: readonly string[];
  environment?: Readonly<Record<string, string>>;
  timeoutMs: number;
}

export interface SbxSubprocessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type SbxSubprocessRunner = (
  request: SbxSubprocessRequest,
) => Promise<SbxSubprocessResult>;

export type SbxClientErrorCode =
  | "backend_unavailable"
  | "backend_incompatible"
  | "malformed_backend_response"
  | "operation_timeout"
  | "operation_failed";

export class SbxClientError extends Error {
  constructor(
    readonly code: SbxClientErrorCode,
    message: string,
    readonly args: readonly string[],
  ) {
    super(message);
  }
}

export class CliSbxClient implements SbxClient {
  constructor(
    readonly executable = "sbx",
    private readonly runner: SbxSubprocessRunner = runSbxSubprocess(executable),
    private readonly defaultTimeoutMs = 120_000,
  ) {}

  async version(): Promise<SbxNativeVersion> {
    const result = await this.invoke(["version", "--json"]);
    const value = object(parseJson(result.stdout, ["version", "--json"]));
    const client = object(value.client);
    const server = object(value.server);
    const clientVersion = text(client.version, "client.version");
    const clientRevision = text(client.revision, "client.revision");
    const serverState = text(server.state, "server.state");
    if (serverState !== "running")
      return {
        clientVersion,
        clientRevision,
        serverState,
        ...(typeof server.error === "string"
          ? { serverError: server.error }
          : {}),
      };
    return {
      clientVersion,
      clientRevision,
      serverState,
      serverVersion: text(server.version, "server.version"),
      serverRevision: text(server.revision, "server.revision"),
      apiVersion: text(server.api_version, "server.api_version"),
    };
  }

  async list(options: SbxRequestOptions = {}): Promise<SbxSandboxSummary[]> {
    const result = await this.invoke(["ls", "--json"], options);
    const value = object(parseJson(result.stdout, ["ls", "--json"]));
    if (!Array.isArray(value.sandboxes))
      throw malformed("sandboxes must be an array", ["ls", "--json"]);
    return value.sandboxes.map((item, index) => {
      const sandbox = object(item);
      return {
        name: text(sandbox.name, `sandboxes[${index}].name`),
        id: text(sandbox.id, `sandboxes[${index}].id`),
        agent: text(sandbox.agent, `sandboxes[${index}].agent`),
        status: text(sandbox.status, `sandboxes[${index}].status`),
        ...(typeof sandbox.last_used_at === "string"
          ? { lastUsedAt: sandbox.last_used_at }
          : {}),
      };
    });
  }

  async policies(sandboxName?: string): Promise<SbxPolicyRule[]> {
    const args = [
      "policy",
      "ls",
      ...(sandboxName ? [sandboxName] : []),
      "--json",
    ];
    const result = await this.invoke(args);
    const value = object(parseJson(result.stdout, args));
    if (!Array.isArray(value.rules))
      throw malformed("policy rules must be an array", args);
    return value.rules.map((item, index) => {
      const rule = object(item);
      if (!Array.isArray(rule.resources))
        throw malformed(`rules[${index}].resources must be an array`, args);
      return {
        id: text(rule.id, `rules[${index}].id`),
        ...(typeof rule.policy_id === "string"
          ? { policyId: rule.policy_id }
          : {}),
        scope: text(rule.scope, `rules[${index}].scope`),
        appliesTo: text(rule.applies_to, `rules[${index}].applies_to`),
        resourceType: text(rule.resource_type, `rules[${index}].resource_type`),
        decision: text(rule.decision, `rules[${index}].decision`),
        resources: rule.resources.map((resource, resourceIndex) =>
          text(resource, `rules[${index}].resources[${resourceIndex}]`),
        ),
        status: text(rule.status, `rules[${index}].status`),
        ...(typeof rule.sandbox_id === "string"
          ? { sandboxId: rule.sandbox_id }
          : {}),
      };
    });
  }

  async setting(key: string): Promise<SbxSetting> {
    const args = ["settings", "get", "--json", key];
    const result = await this.invoke(args);
    const value = object(parseJson(result.stdout, args));
    return {
      key: text(value.key, "setting.key"),
      type: text(value.type, "setting.type"),
      source: text(value.source, "setting.source"),
      value: value.value,
    };
  }

  async registeredMcpServerCount(): Promise<number> {
    const args = ["mcp", "ls", "--json"];
    const result = await this.invoke(args);
    const value = object(parseJson(result.stdout, args));
    if (!Array.isArray(value.servers))
      throw malformed("MCP servers must be an array", args);
    return value.servers.length;
  }

  async create(request: SbxCreateRequest): Promise<void> {
    const args = [
      "create",
      request.agentReference ?? "shell",
      "--name",
      request.name,
      "--skills=off",
      "--static-mcp=",
      ...(request.denyAllNetwork === false ? [] : ["--deny-network=**"]),
      "--cpus",
      String(request.cpus),
      "--memory",
      request.memory,
      ...environmentArgs(request.environment),
      "--quiet",
    ];
    await this.invoke(args, {
      environment: {
        DOCKER_SANDBOXES_DOCKER_SIZE: request.privateDockerDisk,
      },
      timeoutMs: 10 * 60_000,
    });
  }

  async setDynamicSecret(request: SbxDynamicSecretRequest): Promise<void> {
    const args = [
      "secret",
      "set-custom",
      "--placeholder",
      request.placeholder,
      ...request.hosts.flatMap((host) => ["--host", host]),
      "--command",
      request.resolverCommand,
      "--refresh",
      request.refreshInterval,
      "--sandbox",
      request.sandboxName,
    ];
    const result = await this.runner({
      args,
      timeoutMs: 2 * 60_000,
    });
    if (result.exitCode !== 0)
      throw new SbxClientError(
        "operation_failed",
        `SBX rejected the sandbox-scoped Pi credential resolver (exit ${result.exitCode}).`,
        redactArgs(args),
      );
  }

  async removeDynamicSecret(
    sandboxName: string,
    placeholder: string,
  ): Promise<void> {
    const args = [
      "secret",
      "rm",
      "--force",
      "--sandbox",
      sandboxName,
      "--placeholder",
      placeholder,
    ];
    const result = await this.runner({
      args,
      timeoutMs: this.defaultTimeoutMs,
    });
    if (result.exitCode !== 0)
      throw new SbxClientError(
        "operation_failed",
        `SBX could not revoke the sandbox-scoped Pi credential resolver (exit ${result.exitCode}).`,
        redactArgs(args),
      );
  }

  async denyNetwork(
    sandboxName: string,
    resources: readonly string[],
  ): Promise<void> {
    if (resources.length === 0) return;
    await this.invoke([
      "policy",
      "deny",
      "network",
      "--sandbox",
      sandboxName,
      resources.join(","),
    ]);
  }

  async exec(
    sandboxName: string,
    command: EnvironmentCommand,
    options: SbxExecOptions = {},
  ): Promise<EnvironmentCommandResult> {
    const args = execArgs(sandboxName, command, options);
    const result = await this.runner({
      args,
      timeoutMs: command.timeoutMs ?? this.defaultTimeoutMs,
    });
    if (result.exitCode !== 0 && !options.allowNonZero)
      throw new SbxClientError(
        "operation_failed",
        sanitizedError(result.stderr, result.stdout, result.exitCode, args),
        redactArgs(args),
      );
    return result;
  }

  async copyTo(
    sandboxName: string,
    hostPath: string,
    guestPath: string,
  ): Promise<void> {
    await this.invoke(["cp", hostPath, `${sandboxName}:${guestPath}`], {
      timeoutMs: 5 * 60_000,
    });
  }

  async copyFrom(
    sandboxName: string,
    guestPath: string,
    hostPath: string,
  ): Promise<void> {
    await this.invoke(["cp", `${sandboxName}:${guestPath}`, hostPath], {
      timeoutMs: 5 * 60_000,
    });
  }

  async stop(sandboxName: string, options: SbxStopOptions = {}): Promise<void> {
    await this.invoke(["stop", sandboxName], options);
  }

  async remove(sandboxName: string): Promise<void> {
    await this.invoke(["rm", "--force", sandboxName], {
      timeoutMs: 5 * 60_000,
    });
  }

  launcherArgs(
    sandboxName: string,
    command: EnvironmentCommand,
  ): readonly string[] {
    return execArgs(sandboxName, command, { interactive: true, tty: true });
  }

  streamLauncherArgs(
    sandboxName: string,
    command: EnvironmentCommand,
  ): readonly string[] {
    return execArgs(sandboxName, command, { interactive: true, tty: false });
  }

  private async invoke(
    args: readonly string[],
    options: {
      environment?: Readonly<Record<string, string>>;
      timeoutMs?: number;
      onInvocation?: () => void | Promise<void>;
    } = {},
  ): Promise<SbxSubprocessResult> {
    await options.onInvocation?.();
    const result = await this.runner({
      args,
      ...(options.environment ? { environment: options.environment } : {}),
      timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
    });
    if (result.exitCode !== 0)
      throw new SbxClientError(
        "operation_failed",
        sanitizedError(result.stderr, result.stdout, result.exitCode, args),
        redactArgs(args),
      );
    return result;
  }
}

export function runSbxSubprocess(executable: string): SbxSubprocessRunner {
  return async (request) => {
    let timedOut = false;
    const child = Bun.spawn([executable, ...request.args], {
      env: { ...definedProcessEnvironment(), ...request.environment },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let forceTimer: ReturnType<typeof setTimeout> | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    }, request.timeoutMs);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (timedOut)
        throw new SbxClientError(
          "operation_timeout",
          `sbx operation timed out after ${request.timeoutMs}ms.`,
          redactArgs(request.args),
        );
      return { exitCode, stdout, stderr };
    } finally {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
    }
  };
}

function execArgs(
  sandboxName: string,
  command: EnvironmentCommand,
  options: SbxExecOptions,
): string[] {
  return [
    "exec",
    ...(options.interactive ? ["--interactive"] : []),
    ...(options.tty ? ["--tty"] : []),
    ...(options.user ? ["--user", options.user] : []),
    ...(command.cwd ? ["--workdir", command.cwd] : []),
    ...environmentArgs(command.environment ?? {}),
    sandboxName,
    "--",
    command.executable,
    ...command.args,
  ];
}

function redactArgs(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index] as string;
    result.push(value);
    if (value === "--env" && args[index + 1]?.includes("=")) {
      const assignment = args[index + 1] as string;
      result.push(`${assignment.split("=", 1)[0]}=<redacted>`);
      index += 1;
    } else if (
      (value === "--placeholder" || value === "--command") &&
      args[index + 1] !== undefined
    ) {
      result.push("<redacted>");
      index += 1;
    }
  }
  return result;
}

function environmentArgs(
  environment: Readonly<Record<string, string>>,
): string[] {
  return Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, value]) => ["--env", `${key}=${value}`]);
}

interface ParsedJson {
  ok: true;
  value: unknown;
}

const INVALID_JSON = Object.freeze({ ok: false as const });
const SBX_UPDATE_BOX_WIDTH = 82;
const SBX_UPDATE_SEMVER = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const SBX_LEGACY_UPDATE_NOTICE =
  /^(?:warning:\s*)?update available:\s*v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\s+\(running\s+v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\)$/i;

function parseJson(value: string, args: readonly string[]): unknown {
  const strict = tryParseJson(value);
  if (strict.ok) return strict.value;

  // SBX v0.43's periodic update check violates --json by appending a text
  // notice to stdout. Only version --json may discard one fully recognized,
  // outer diagnostic. Other commands and every unrecognized byte fail closed.
  if (!isVersionJsonCommand(args))
    throw malformed("response contained unsupported non-JSON framing", args);

  for (const candidate of legacyUpdateNoticeCandidates(value)) {
    const parsed = tryParseJson(candidate);
    if (parsed.ok) return parsed.value;
  }

  const boxed = boxedUpdateNoticeCandidate(value);
  if (boxed) {
    const parsed = tryParseJson(boxed.json);
    if (
      parsed.ok &&
      reportedVersionMatchesUpdateNotice(parsed.value, boxed.runningVersion)
    )
      return parsed.value;
  }

  throw malformed("response contained unsupported non-JSON framing", args);
}

function tryParseJson(value: string): ParsedJson | typeof INVALID_JSON {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return INVALID_JSON;
  }
}

function isVersionJsonCommand(args: readonly string[]): boolean {
  return args.length === 2 && args[0] === "version" && args[1] === "--json";
}

function legacyUpdateNoticeCandidates(value: string): string[] {
  const normalized = normalizeLineEndings(value);
  if (normalized === null) return [];
  const lines = normalized.split("\n");
  const significant = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.trim().length > 0);
  if (significant.length < 2) return [];

  const candidates: string[] = [];
  const first = significant[0];
  if (first && isLegacyUpdateNotice(first.line))
    candidates.push(lines.slice(first.index + 1).join("\n"));
  const last = significant.at(-1);
  if (last && isLegacyUpdateNotice(last.line))
    candidates.push(lines.slice(0, last.index).join("\n"));
  return candidates;
}

function isLegacyUpdateNotice(line: string): boolean {
  const trimmed = line.trim();
  const notice =
    trimmed.startsWith("\u001b[33m") && trimmed.endsWith("\u001b[0m")
      ? trimmed.slice("\u001b[33m".length, -"\u001b[0m".length)
      : trimmed;
  return SBX_LEGACY_UPDATE_NOTICE.test(notice);
}

function boxedUpdateNoticeCandidate(
  value: string,
): { json: string; runningVersion: string } | null {
  const normalized = normalizeLineEndings(value);
  if (normalized === null) return null;
  const lines = normalized.split("\n");
  // One blank line separates JSON from the nine-line box; two line feeds
  // follow it. These are the exact non-TTY bytes emitted by SBX v0.43.0.
  const trailerLength = 12;
  if (lines.length <= trailerLength) return null;
  const trailer = lines.slice(-trailerLength);
  if (trailer[0] !== "" || trailer[10] !== "" || trailer[11] !== "")
    return null;

  const top = `╭${"─".repeat(SBX_UPDATE_BOX_WIDTH)}╮`;
  const separator = `├${"─".repeat(SBX_UPDATE_BOX_WIDTH)}┤`;
  const bottom = `╰${"─".repeat(SBX_UPDATE_BOX_WIDTH)}╯`;
  if (
    trailer[1] !== top ||
    trailer[2] !== updateBoxRow("Docker Sandboxes Update Available") ||
    trailer[3] !== separator ||
    trailer[5] !== separator ||
    trailer[7] !== separator ||
    trailer[8] !== updateBoxRow("To upgrade     brew upgrade docker/tap/sbx") ||
    trailer[9] !== bottom
  )
    return null;

  const versionContent = updateBoxContent(trailer[4] as string);
  const versions = versionContent?.match(/^(v\S+) {2}→ {2}(v\S+)$/);
  const runningVersion = versions?.[1];
  const availableVersion = versions?.[2];
  if (
    !runningVersion ||
    !availableVersion ||
    !SBX_UPDATE_SEMVER.test(runningVersion) ||
    !SBX_UPDATE_SEMVER.test(availableVersion) ||
    !isNewerUpdateVersion(runningVersion, availableVersion) ||
    trailer[4] !== updateBoxRow(`${runningVersion}  →  ${availableVersion}`) ||
    trailer[6] !==
      updateBoxRow(
        `Release notes  https://github.com/docker/sbx-releases/releases/tag/${availableVersion}`,
      )
  )
    return null;

  return {
    json: lines.slice(0, -trailerLength).join("\n"),
    runningVersion,
  };
}

function isNewerUpdateVersion(running: string, available: string): boolean {
  const numeric = (version: string): number[] =>
    version.slice(1).split(/[-+]/, 1)[0]?.split(".").map(Number) ?? [];
  const left = numeric(running);
  const right = numeric(available);
  for (let index = 0; index < 3; index += 1) {
    const difference = (right[index] as number) - (left[index] as number);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

function updateBoxRow(content: string): string {
  return `│${` ${content}`.padEnd(SBX_UPDATE_BOX_WIDTH, " ")}│`;
}

function updateBoxContent(line: string): string | null {
  if (!line.startsWith("│ ") || !line.endsWith("│")) return null;
  const inner = line.slice(1, -1);
  if (inner.length !== SBX_UPDATE_BOX_WIDTH) return null;
  return inner.trim();
}

function reportedVersionMatchesUpdateNotice(
  value: unknown,
  runningVersion: string,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const client = (value as Record<string, unknown>).client;
  if (!client || typeof client !== "object" || Array.isArray(client))
    return false;
  if ((client as Record<string, unknown>).version !== runningVersion)
    return false;

  const server = (value as Record<string, unknown>).server;
  if (!server || typeof server !== "object" || Array.isArray(server))
    return false;
  const serverVersion = (server as Record<string, unknown>).version;
  return serverVersion === undefined || serverVersion === runningVersion;
}

function normalizeLineEndings(value: string): string | null {
  const withoutCrLf = value.replaceAll("\r\n", "");
  if (
    withoutCrLf.includes("\r") ||
    (value.includes("\r\n") && withoutCrLf.includes("\n"))
  )
    return null;
  return value.replaceAll("\r\n", "\n");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw malformed("response value must be an object", []);
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw malformed(`${path} must be a non-empty string`, []);
  return value;
}

function malformed(message: string, args: readonly string[]): SbxClientError {
  return new SbxClientError(
    "malformed_backend_response",
    `Malformed sbx response: ${message}.`,
    args,
  );
}

function sanitizedError(
  stderr: string,
  stdout: string,
  exitCode: number,
  args: readonly string[],
): string {
  let detail = stderr.trim() || stdout.trim();
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--env") continue;
    const assignment = args[index + 1];
    const separator = assignment?.indexOf("=") ?? -1;
    const value = separator >= 0 ? assignment?.slice(separator + 1) : undefined;
    if (value) detail = detail.replaceAll(value, "<redacted>");
    index += 1;
  }
  return detail
    ? `sbx operation failed with exit ${exitCode}: ${detail}`
    : `sbx operation failed with exit ${exitCode}.`;
}

function definedProcessEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}
