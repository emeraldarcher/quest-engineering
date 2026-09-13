import type { HarnessModelCapability } from "../types.ts";

export const SUPPORTED_ANTIGRAVITY_VERSION = "1.2.2";
export const ANTIGRAVITY_MODEL_PROVIDER = "antigravity";

export interface AntigravityDiscoveryResult {
  installed: boolean;
  authenticated: boolean;
  version: string | null;
  models: HarnessModelCapability[];
  diagnostics: string[];
}

export interface NativeCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type NativeCommandRunner = (
  args: string[],
) => NativeCommandResult | Promise<NativeCommandResult>;

/** Native authenticated discovery; no model inference and no maintained model enum. */
export async function discoverAntigravityModels(
  run: NativeCommandRunner = runAgy,
): Promise<AntigravityDiscoveryResult> {
  const versionResult = await run(["--version"]);
  if (versionResult.exitCode !== 0)
    return {
      installed: false,
      authenticated: false,
      version: null,
      models: [],
      diagnostics: [message(versionResult, "Antigravity CLI is unavailable.")],
    };
  const version = versionResult.stdout.trim();
  if (version !== SUPPORTED_ANTIGRAVITY_VERSION)
    return {
      installed: true,
      authenticated: false,
      version,
      models: [],
      diagnostics: [
        `Antigravity ${version || "unknown"} is incompatible; ${SUPPORTED_ANTIGRAVITY_VERSION} is required.`,
      ],
    };

  const modelsResult = await run(["models"]);
  if (modelsResult.exitCode !== 0)
    return {
      installed: true,
      authenticated: false,
      version,
      models: [],
      diagnostics: [
        message(
          modelsResult,
          "Antigravity's authenticated model catalog is unavailable.",
        ),
      ],
    };
  const { models, omitted } = parseAntigravityModelCatalog(modelsResult.stdout);
  return {
    installed: true,
    authenticated: models.length > 0,
    version,
    models,
    diagnostics: [
      ...(models.length > 0
        ? [`Discovered ${models.length} native Antigravity model variants.`]
        : ["Antigravity returned no native models."]),
      ...(omitted.length > 0
        ? [
            `Models remain visible but unschedulable because native discovery reported conflicting effort metadata: ${omitted.join(", ")}.`,
          ]
        : []),
    ],
  };
}

export function parseAntigravityModelCatalog(output: string): {
  models: HarnessModelCapability[];
  omitted: string[];
} {
  const models: HarnessModelCapability[] = [];
  const omitted: string[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line || line === "Fetching available models...") continue;
    const match = /^(\S+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const model = match[1] as string;
    const displayName = (match[2] as string).trim();
    const reasoningCapability = nativeReasoningCapability(model, displayName);
    if (reasoningCapability.kind === "unknown") omitted.push(model);
    models.push({
      provider: ANTIGRAVITY_MODEL_PROVIDER,
      model,
      displayName,
      reasoningCapability,
    });
  }
  models.sort((left, right) => left.model.localeCompare(right.model));
  return { models, omitted: omitted.sort() };
}

function nativeReasoningCapability(
  model: string,
  displayName: string,
): HarnessModelCapability["reasoningCapability"] {
  const id = /-(low|medium|high)$/.exec(model)?.[1];
  const label = /\((Low|Medium|High)\)$/.exec(displayName)?.[1]?.toLowerCase();
  if (id && label && id !== label)
    return { kind: "unknown", detail: "conflicting native effort metadata" };
  const value = id ?? label;
  if (value === "low" || value === "medium" || value === "high")
    return { kind: "enumerated", values: [value] };
  return { kind: "unsupported" };
}

function runAgy(args: string[]): NativeCommandResult {
  const result = Bun.spawnSync(["agy", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function message(result: NativeCommandResult, fallback: string): string {
  return result.stderr.trim() || result.stdout.trim() || fallback;
}
