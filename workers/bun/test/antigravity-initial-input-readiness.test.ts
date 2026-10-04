import { expect, test } from "bun:test";
import {
  type AntigravityNativeFreshConversationState,
  inspectAntigravityInitialInputReadiness,
  isAntigravityInputReadyForMode,
} from "../src/harnesses/antigravity/initial-input-readiness.ts";

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

const freshState: AntigravityNativeFreshConversationState = {
  project: {
    ready: true,
    resolvedProjectId: "default-cli-project",
    defaultProject: true,
    cacheWritable: true,
    configPresent: true,
    configWritable: true,
    conversationStoreWritable: true,
    workspaceResolved: true,
  },
  prompt: {
    focusReady: true,
    editorMode: "default",
    enterBinding: "prompt.submit",
    customKeybindingsPresent: false,
  },
};

function inspect(
  log = complete,
  state: AntigravityNativeFreshConversationState = freshState,
) {
  return inspectAntigravityInitialInputReadiness(log, model, state);
}

test("Antigravity initial input readiness requires ordered post-login native initialization and fresh-conversation capability", () => {
  const readiness = inspect();
  expect(readiness).toMatchObject({
    version: 2,
    ready: true,
    tuiInputReady: true,
    freshConversationReady: true,
    nativeConversationBootstrap: "ready_without_conversation",
    conversationState: "none",
    missingSignals: [],
    missingFreshConversationRequirements: [],
    model,
  });
  expect(Object.keys(readiness.signals)).toHaveLength(12);
});

test("a rendered prompt box alone is not initial input readiness", () => {
  const readiness = inspect(
    [
      "CLI ready for user input",
      "Full redraw completed (rerenderAll) for conversation  (epoch 0, items 1)",
    ].join("\n"),
  );
  expect(readiness.ready).toBe(false);
  expect(readiness.missingSignals).toContain("authentication");
  expect(readiness.missingSignals).toContain("post_login_model_resolution");
});

test("the complete 12-signal input loop fails closed without a resolved native project", () => {
  const readiness = inspect(complete, {
    ...freshState,
    project: {
      ...freshState.project,
      ready: false,
      resolvedProjectId: null,
      defaultProject: false,
      cacheWritable: false,
      configPresent: false,
      configWritable: false,
      conversationStoreWritable: false,
      workspaceResolved: false,
    },
  });
  expect(readiness).toMatchObject({
    ready: false,
    tuiInputReady: true,
    freshConversationReady: false,
    nativeConversationBootstrap: "not_ready",
  });
  expect(readiness.missingFreshConversationRequirements).toEqual([
    "native_project_resolution",
    "native_project_cache_writable",
    "native_project_config",
    "native_project_config_writable",
    "native_conversation_store_writable",
    "native_workspace_resolution",
  ]);
});

test("invalid project state fails closed even when the default marker exists", () => {
  const readiness = inspect(complete, {
    ...freshState,
    project: {
      ...freshState.project,
      ready: false,
      configPresent: false,
    },
  });
  expect(readiness.ready).toBe(false);
  expect(readiness.missingFreshConversationRequirements).toContain(
    "native_project_resolution",
  );
  expect(readiness.missingFreshConversationRequirements).toContain(
    "native_project_config",
  );
});

test("wrong prompt focus or editor mode fails before authorization", () => {
  const unfocused = inspect(complete, {
    ...freshState,
    prompt: { ...freshState.prompt, focusReady: false },
  });
  expect(unfocused.ready).toBe(false);
  expect(unfocused.missingFreshConversationRequirements).toContain(
    "prompt_focus",
  );

  const vim = inspect(complete, {
    ...freshState,
    prompt: {
      ...freshState.prompt,
      editorMode: "vim",
      enterBinding: "vim.insert.submit",
    },
  });
  expect(vim.ready).toBe(false);
  expect(vim.missingFreshConversationRequirements).toContain(
    "default_editor_mode",
  );
  expect(vim.missingFreshConversationRequirements).toContain(
    "enter_prompt_submit_binding",
  );
});

test("default editor mode accepts Enter only through prompt.submit", () => {
  expect(inspect().ready).toBe(true);
  const remapped = inspect(complete, {
    ...freshState,
    prompt: {
      ...freshState.prompt,
      enterBinding: "unknown",
      customKeybindingsPresent: true,
    },
  });
  expect(remapped.ready).toBe(false);
  expect(remapped.missingFreshConversationRequirements).toContain(
    "enter_prompt_submit_binding",
  );
});

test("readiness rejects wrong-model resolution and any preauthorization conversation or provider activity", () => {
  expect(
    inspect(complete.replaceAll(model, "gemini-another-model")).ready,
  ).toBe(false);
  for (const event of [
    "Starting new conversation (agent=false)",
    "Sending user message to conversation conversation-id",
    "SendUserMessage failed: no active conversation",
  ]) {
    const active = inspect(`${complete}\n${event}`);
    expect(active).toMatchObject({
      ready: false,
      tuiInputReady: true,
      freshConversationReady: false,
      conversationState: "active_or_ambiguous",
      nativeConversationBootstrap: "active_or_ambiguous",
    });
    expect(isAntigravityInputReadyForMode(active, true)).toBe(false);
    expect(isAntigravityInputReadyForMode(active, false)).toBe(true);
  }
});
