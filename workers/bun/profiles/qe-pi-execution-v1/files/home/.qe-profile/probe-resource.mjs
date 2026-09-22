import { fetchCodexModelEligibility } from "./codex-model-eligibility.mjs";

const catalog = await fetchCodexModelEligibility();
console.log(
  JSON.stringify({
    schemaVersion: 2,
    authenticated: catalog.authenticated,
    eligibilityKnown: true,
    status: catalog.status,
    eligibleModelCount: catalog.models.length,
  }),
);
