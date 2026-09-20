import { getSupportedThinkingLevels } from "/opt/qe/pi/node_modules/@earendil-works/pi-ai/dist/index.js";
import {
  ModelRuntime,
  SettingsManager,
  resolveModelScopeWithDiagnostics,
} from "/opt/qe/pi/node_modules/@earendil-works/pi-coding-agent/dist/index.js";

const agentDir = process.env.PI_CODING_AGENT_DIR || "/home/agent/.pi/agent";
const cwd = process.cwd();
const settings = SettingsManager.create(cwd, agentDir, {
  projectTrusted: false,
});
const runtime = await ModelRuntime.create({
  allowModelNetwork: false,
  refreshOnCreate: true,
});
const patterns = settings.getEnabledModels();
let available;
let diagnostics = [];
if (patterns?.length) {
  const scoped = await resolveModelScopeWithDiagnostics(patterns, runtime);
  available = scoped.scopedModels.map((item) => item.model);
  diagnostics = scoped.diagnostics.map((item) => item.message);
} else {
  available = await runtime.getAvailable();
}
const models = available
  .filter((model) => model.provider === "openai-codex")
  .map((model) => ({
    provider: String(model.provider),
    model: String(model.id),
    displayName: model.name || `${model.provider}/${model.id}`,
    reasoning: [...getSupportedThinkingLevels(model)].map(String),
  }))
  .sort((left, right) =>
    `${left.provider}/${left.model}`.localeCompare(
      `${right.provider}/${right.model}`,
    ),
  );
process.stdout.write(
  `${JSON.stringify({
    schemaVersion: 1,
    authenticated: models.length > 0,
    models,
    diagnostics,
  })}\n`,
);
