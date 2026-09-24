import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { HarnessModelCapability } from "../types.ts";

export interface PiDiscoveryResult {
  models: HarnessModelCapability[];
  diagnostics: string[];
  authenticated: boolean;
}

/** Publishes Pi's complete credential-aware runtime catalog. User settings are UX preferences. */
export async function discoverPiModels(
  input: { createRuntime?: () => Promise<ModelRuntime> } = {},
): Promise<PiDiscoveryResult> {
  const runtime = await (input.createRuntime?.() ??
    ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: true }));
  const models = (await runtime.getAvailable()) as readonly Model<string>[];
  const normalized = models
    .filter((model) => model.provider === "openai-codex")
    .map((model) => {
      const values = [...getSupportedThinkingLevels(model)].map(String);
      return {
        provider: String(model.provider),
        model: model.id,
        displayName: model.name || `${model.provider}/${model.id}`,
        accountAvailability: "unknown" as const,
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
    diagnostics: [],
    authenticated: normalized.length > 0,
  };
}
