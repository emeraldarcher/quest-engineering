import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  resolveModelScopeWithDiagnostics,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { HarnessModelCapability } from "../types.ts";

export interface PiDiscoveryResult {
  models: HarnessModelCapability[];
  diagnostics: string[];
  authenticated: boolean;
}

/** Uses Pi's own configured scope, model registry and credential-aware runtime. */
export async function discoverPiModels(
  input: {
    cwd?: string;
    agentDir?: string;
    createRuntime?: () => Promise<ModelRuntime>;
    settings?: SettingsManager;
  } = {},
): Promise<PiDiscoveryResult> {
  const cwd = input.cwd ?? process.cwd();
  const agentDir =
    input.agentDir ??
    process.env.PI_CODING_AGENT_DIR?.trim() ??
    `${process.env.HOME ?? ""}/.pi/agent`;
  const settings =
    input.settings ??
    SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const runtime = await (input.createRuntime?.() ??
    ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: true }));
  const patterns = settings.getEnabledModels();
  let models: readonly Model<string>[];
  let diagnostics: string[] = [];
  if (patterns && patterns.length > 0) {
    const scoped = await resolveModelScopeWithDiagnostics(patterns, runtime);
    models = scoped.scopedModels.map(
      (item) => item.model,
    ) as readonly Model<string>[];
    diagnostics = scoped.diagnostics.map((item) => item.message);
  } else {
    models = (await runtime.getAvailable()) as readonly Model<string>[];
  }
  const normalized = models
    .map((model) => {
      const values = [...getSupportedThinkingLevels(model)].map(String);
      return {
        provider: String(model.provider),
        model: model.id,
        displayName: model.name || `${model.provider}/${model.id}`,
        reasoningCapability:
          values.length > 0
            ? ({ kind: "enumerated", values } as const)
            : ({ kind: "unsupported" } as const),
      };
    })
    .sort((left, right) =>
      `${left.provider}/${left.model}`.localeCompare(
        `${right.provider}/${right.model}`,
      ),
    );
  return {
    models: normalized,
    diagnostics,
    authenticated: normalized.length > 0,
  };
}
