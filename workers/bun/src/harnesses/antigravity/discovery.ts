import type { HarnessModelCapability } from "../types.ts";

/** Human-operated runtime probes were last completed against this provenance. */
export const ANTIGRAVITY_TESTED_VERSION = "1.2.2";
export const ANTIGRAVITY_MODEL_PROVIDER = "antigravity";

const REQUIRED_HELP_CAPABILITIES = {
  "native.conversation_resume": "--conversation",
  "native.effort_selection": "--effort",
  "native.interactive_launch": "--prompt-interactive",
  "native.log_evidence": "--log-file",
  "native.model_selection": "--model",
} as const;

export interface AntigravityDiscoveryResult {
  installed: boolean;
  authenticated: boolean;
  compatible: boolean;
  version: string | null;
  models: HarnessModelCapability[];
  capabilities: string[];
  missingCapabilities: string[];
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

/** Native authenticated discovery; deterministic and zero-inference. */
export async function discoverAntigravityModels(
  run: NativeCommandRunner = runAgy,
): Promise<AntigravityDiscoveryResult> {
  const versionResult = await run(["--version"]);
  if (versionResult.exitCode !== 0)
    return unavailable(
      false,
      null,
      "native.cli",
      message(versionResult, "Antigravity CLI is unavailable."),
    );
  const version = versionResult.stdout.trim();
  if (!numericVersion(version))
    return unavailable(
      true,
      version || null,
      "native.version_provenance",
      "Antigravity returned malformed version provenance.",
    );

  const capabilities = new Set<string>(["native.cli"]);
  const missing = new Set<string>();
  const diagnostics: string[] = [];
  const helpResult = await run(["--help"]);
  const help =
    helpResult.exitCode === 0
      ? `${helpResult.stdout}\n${helpResult.stderr}`
      : "";
  for (const [capability, flag] of Object.entries(REQUIRED_HELP_CAPABILITIES)) {
    if (help.includes(flag)) capabilities.add(capability);
    else {
      missing.add(capability);
      diagnostics.push(
        `Antigravity capability '${capability}' is unavailable; native help metadata omits '${flag}'.`,
      );
    }
  }

  const modelsResult = await run(["models"]);
  const parsed =
    modelsResult.exitCode === 0
      ? parseAntigravityModelCatalog(modelsResult.stdout)
      : { models: [], omitted: [] };
  if (modelsResult.exitCode === 0 && parsed.models.length > 0)
    capabilities.add("native.model_catalog");
  else {
    missing.add("native.model_catalog");
    diagnostics.push(
      modelsResult.exitCode === 0
        ? "Antigravity returned malformed or empty native model metadata."
        : message(
            modelsResult,
            "Antigravity's authenticated model catalog is unavailable.",
          ),
    );
  }

  if (missing.size === 0 && newerVersion(version, ANTIGRAVITY_TESTED_VERSION))
    diagnostics.push(
      `Antigravity ${version} is newer than QE's human-tested ${ANTIGRAVITY_TESTED_VERSION} provenance; the deterministic native capability contract passed.`,
    );
  if (parsed.models.length > 0)
    diagnostics.push(
      `Discovered ${parsed.models.length} native Antigravity model variants.`,
    );
  if (parsed.omitted.length > 0)
    diagnostics.push(
      `Models remain visible but unschedulable because native discovery reported conflicting effort metadata: ${parsed.omitted.join(", ")}.`,
    );

  return {
    installed: true,
    authenticated: parsed.models.length > 0,
    compatible: missing.size === 0,
    version,
    models: parsed.models,
    capabilities: [...capabilities].sort(),
    missingCapabilities: [...missing].sort(),
    diagnostics,
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
    const match = /^(\S+)\t([^\t]+)$/.exec(line);
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

function unavailable(
  installed: boolean,
  version: string | null,
  capability: string,
  diagnostic: string,
): AntigravityDiscoveryResult {
  return {
    installed,
    authenticated: false,
    compatible: false,
    version,
    models: [],
    capabilities: installed ? ["native.cli"] : [],
    missingCapabilities: [capability],
    diagnostics: [diagnostic],
  };
}

function newerVersion(version: string, tested: string): boolean {
  const left = numericVersion(version);
  const right = numericVersion(tested);
  if (!left || !right) return false;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

function numericVersion(value: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  return match ? match.slice(1).map(Number) : null;
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
