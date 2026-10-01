import { expect, test } from "bun:test";
import { inspectAntigravityInitialInputReadiness } from "../src/harnesses/antigravity/initial-input-readiness.ts";

const model = "gemini-3.8-flash-high";
const complete = [
  "CLI ready for user input",
  "Authenticated successfully",
  "CLI startup completed (took 150ms)",
  "Full redraw completed (rerenderAll) for conversation  (epoch 0, items 1)",
  "URL: https://example.invalid/v1internal:loadCodeAssist Trace: redacted",
  "URL: https://example.invalid/v1internal:fetchAvailableModels Trace: redacted",
  `Resolving model ${model}`,
  'Propagating selected model override to backend: label="Gemini 3.8 Flash (High)"',
  "Experiments refreshed after login",
  "Reloading system slash commands",
  "URL: https://example.invalid/v1internal:loadCodeAssist Trace: redacted",
  `Resolving model ${model}`,
  'Propagating selected model override to backend: label="Gemini 3.8 Flash (High)"',
  "Experiments refreshed after login",
  "Reloading system slash commands",
].join("\n");

test("Antigravity initial input readiness requires ordered post-login native initialization", () => {
  const readiness = inspectAntigravityInitialInputReadiness(complete, model);
  expect(readiness).toMatchObject({
    ready: true,
    conversationState: "none",
    missingSignals: [],
    model,
  });
  expect(Object.keys(readiness.signals)).toHaveLength(12);
});

test("a rendered prompt box alone is not initial input readiness", () => {
  const readiness = inspectAntigravityInitialInputReadiness(
    [
      "CLI ready for user input",
      "Full redraw completed (rerenderAll) for conversation  (epoch 0, items 1)",
    ].join("\n"),
    model,
  );
  expect(readiness.ready).toBe(false);
  expect(readiness.missingSignals).toContain("authentication");
  expect(readiness.missingSignals).toContain("post_login_model_resolution");
});

test("readiness rejects wrong-model resolution and any preauthorization conversation activity", () => {
  expect(
    inspectAntigravityInitialInputReadiness(
      complete.replaceAll(model, "gemini-another-model"),
      model,
    ).ready,
  ).toBe(false);
  const active = inspectAntigravityInitialInputReadiness(
    `${complete}\nStarting new conversation (agent=false)`,
    model,
  );
  expect(active).toMatchObject({
    ready: false,
    conversationState: "active_or_ambiguous",
  });
});
