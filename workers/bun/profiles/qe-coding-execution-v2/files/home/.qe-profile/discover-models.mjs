import { getSupportedThinkingLevels } from "/opt/qe/pi/node_modules/@earendil-works/pi-ai/dist/index.js";
import { ModelRuntime } from "/opt/qe/pi/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import {
  describeCodexModelMetadata,
  getCodexModelMetadata,
} from "./codex-model-eligibility.mjs";

const runtime = await ModelRuntime.create({
  allowModelNetwork: false,
  refreshOnCreate: true,
});
const models = (await runtime.getAvailable())
  .filter((model) => model.provider === "openai-codex")
  .map((model) => ({
    provider: String(model.provider),
    model: String(model.id),
    displayName: model.name || `${model.provider}/${model.id}`,
    reasoning: [...getSupportedThinkingLevels(model)].map(String),
    accountAvailability: "unknown",
  }))
  .sort((left, right) =>
    `${left.provider}/${left.model}`.localeCompare(
      `${right.provider}/${right.model}`,
    ),
  );
const metadata = await getCodexModelMetadata();

process.stdout.write(
  `${JSON.stringify({
    schemaVersion: 3,
    authenticated: metadata.authenticated,
    accountScope: metadata.accountScope,
    authGeneration: metadata.authGeneration,
    models,
    metadata: {
      authority: metadata.authority,
      conclusive: metadata.conclusive,
      status: metadata.status,
      observedAt: metadata.observedAt,
      modelCount: metadata.modelCount,
    },
    diagnostics: [
      `Pi runtime supports ${models.length} openai-codex model(s); host enabledModels/defaultModel/defaultThinkingLevel are not scheduling inputs.`,
      ...describeCodexModelMetadata(metadata),
    ],
  })}\n`,
);
