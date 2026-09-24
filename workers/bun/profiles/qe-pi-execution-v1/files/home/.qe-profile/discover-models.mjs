import { getSupportedThinkingLevels } from "/opt/qe/pi/node_modules/@earendil-works/pi-ai/dist/index.js";
import {
  ModelRuntime,
  SettingsManager,
  resolveModelScopeWithDiagnostics,
} from "/opt/qe/pi/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import {
  getCodexModelEligibility,
  intersectCodexModelCatalog,
} from "./codex-model-eligibility.mjs";

const agentDir = process.env.PI_CODING_AGENT_DIR || "/home/agent/.pi/agent";
const cwd = process.cwd();
const settings = SettingsManager.create(cwd, agentDir, {
  projectTrusted: false,
});
const runtime = await ModelRuntime.create({
  allowModelNetwork: false,
  refreshOnCreate: true,
});
const available = await runtime.getAvailable();
const harnessCatalog = available
  .filter((model) => model.provider === "openai-codex")
  .map((model) => ({
    provider: String(model.provider),
    model: String(model.id),
    displayName: model.name || `${model.provider}/${model.id}`,
    reasoning: [...getSupportedThinkingLevels(model)].map(String),
  }));
const eligibility = await getCodexModelEligibility();
let models = intersectCodexModelCatalog(harnessCatalog, eligibility.models);
const diagnostics = [
  `Pi harness catalog contains ${harnessCatalog.length} openai-codex model(s).`,
  `Authenticated ChatGPT account catalog contains ${eligibility.models.length} eligible model(s).`,
  `Harness/account intersection retained ${models.length} model(s).`,
];

const patterns = settings.getEnabledModels();
if (patterns?.length) {
  const scoped = await resolveModelScopeWithDiagnostics(patterns, runtime);
  const allowed = new Set(
    scoped.scopedModels.map(
      (item) => `${item.model.provider}/${item.model.id}`,
    ),
  );
  models = models.filter((model) =>
    allowed.has(`${model.provider}/${model.model}`),
  );
  diagnostics.push(...scoped.diagnostics.map((item) => item.message));
  diagnostics.push(
    `Pi configured model scope retained ${models.length} account-eligible model(s).`,
  );
}
models.sort((left, right) =>
  `${left.provider}/${left.model}`.localeCompare(
    `${right.provider}/${right.model}`,
  ),
);
process.stdout.write(
  `${JSON.stringify({
    schemaVersion: 2,
    authenticated: eligibility.authenticated,
    accountScope: eligibility.accountScope,
    providerEligibleModels: eligibility.models.map((model) => ({
      provider: model.provider,
      model: model.model,
    })),
    models,
    diagnostics,
  })}\n`,
);
