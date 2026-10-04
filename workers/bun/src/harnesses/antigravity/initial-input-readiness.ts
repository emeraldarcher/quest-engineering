export const ANTIGRAVITY_INITIAL_INPUT_READINESS_KIND =
  "antigravity_initial_input_readiness" as const;

export type AntigravityInitialInputSignal =
  | "cli_input_loop"
  | "empty_conversation_render"
  | "authentication"
  | "cli_startup"
  | "code_assist"
  | "model_catalog"
  | "model_resolution"
  | "post_login_experiments"
  | "post_login_code_assist"
  | "post_login_model_resolution"
  | "post_model_experiments"
  | "customization_reload";

export type AntigravityFreshConversationRequirement =
  | "native_project_resolution"
  | "native_project_cache_writable"
  | "native_project_config"
  | "native_project_config_writable"
  | "native_conversation_store_writable"
  | "native_workspace_resolution"
  | "prompt_focus"
  | "default_editor_mode"
  | "enter_prompt_submit_binding";

export interface AntigravityNativeFreshConversationState {
  project: {
    ready: boolean;
    resolvedProjectId: string | null;
    defaultProject: boolean;
    cacheWritable: boolean;
    configPresent: boolean;
    configWritable: boolean;
    conversationStoreWritable: boolean;
    workspaceResolved: boolean;
  };
  prompt: {
    focusReady: boolean;
    editorMode: "default" | "vim" | "unknown";
    enterBinding: "prompt.submit" | "vim.insert.submit" | "unknown";
    customKeybindingsPresent: boolean;
  };
}

export interface AntigravityInitialInputReadiness {
  kind: typeof ANTIGRAVITY_INITIAL_INPUT_READINESS_KIND;
  version: 2;
  /** The visible TUI/input loop has completed its ordered native startup. */
  tuiInputReady: boolean;
  /** A fresh first prompt can enter Antigravity's native new-conversation path. */
  freshConversationReady: boolean;
  ready: boolean;
  nativeConversationBootstrap:
    | "not_ready"
    | "ready_without_conversation"
    | "active_or_ambiguous";
  conversationState: "none" | "active_or_ambiguous";
  model: string;
  /** One-based native-log line number for every required ordered TUI signal. */
  signals: Partial<Record<AntigravityInitialInputSignal, number>>;
  missingSignals: AntigravityInitialInputSignal[];
  missingFreshConversationRequirements: AntigravityFreshConversationRequirement[];
  nativeState: AntigravityNativeFreshConversationState;
}

const ORDER: AntigravityInitialInputSignal[] = [
  "cli_input_loop",
  "authentication",
  "cli_startup",
  "empty_conversation_render",
  "code_assist",
  "model_catalog",
  "model_resolution",
  "post_login_experiments",
  "post_login_code_assist",
  "post_login_model_resolution",
  "post_model_experiments",
  "customization_reload",
];

/**
 * Antigravity 1.2.7's visible input loop settles independently from its native
 * project/conversation manager. Ordered log evidence proves TUI readiness;
 * native project and prompt-mode evidence separately proves that the same fresh
 * process can enter the first-conversation path without creating a conversation
 * or contacting the provider during preauthorization.
 */
export function inspectAntigravityInitialInputReadiness(
  log: string,
  model: string,
  nativeState: AntigravityNativeFreshConversationState,
): AntigravityInitialInputReadiness {
  const lines = log.split("\n");
  const signals: Partial<Record<AntigravityInitialInputSignal, number>> = {};
  const locate = (
    signal: AntigravityInitialInputSignal,
    pattern: RegExp,
    after = -1,
  ): number => {
    const index = lines.findIndex((line, candidate) =>
      candidate > after ? pattern.test(line) : false,
    );
    if (index >= 0) signals[signal] = index + 1;
    return index;
  };

  const input = locate("cli_input_loop", /CLI ready for user input/);
  const authentication = locate(
    "authentication",
    /authenticated successfully/i,
    input,
  );
  const startup = locate(
    "cli_startup",
    /CLI startup completed/,
    authentication,
  );
  const redraw = locate(
    "empty_conversation_render",
    /Full redraw completed .* for conversation\s+\(epoch 0, items \d+\)/,
    startup,
  );
  const codeAssist = locate(
    "code_assist",
    /\/v1internal:loadCodeAssist\b/,
    redraw,
  );
  const modelCatalog = locate(
    "model_catalog",
    /\/v1internal:fetchAvailableModels\b/,
    codeAssist,
  );
  const exactModelResolution = findExactModelResolution(
    lines,
    model,
    modelCatalog,
  );
  const modelResolution =
    exactModelResolution < 0
      ? -1
      : locate(
          "model_resolution",
          /Propagating selected model override to backend/,
          exactModelResolution,
        );
  const experiments = locate(
    "post_login_experiments",
    /Experiments refreshed after login/,
    modelResolution,
  );
  const postLoginCodeAssist = locate(
    "post_login_code_assist",
    /\/v1internal:loadCodeAssist\b/,
    experiments,
  );
  const exactPostLoginModelResolution = findExactModelResolution(
    lines,
    model,
    postLoginCodeAssist,
  );
  const postLoginModelResolution =
    exactPostLoginModelResolution < 0
      ? -1
      : locate(
          "post_login_model_resolution",
          /Propagating selected model override to backend/,
          exactPostLoginModelResolution,
        );
  const postModelExperiments = locate(
    "post_model_experiments",
    /Experiments refreshed after login/,
    postLoginModelResolution,
  );
  locate(
    "customization_reload",
    /Reloading system slash commands/,
    postModelExperiments,
  );

  const conversationObserved = lines.some((line) =>
    /Starting new conversation|Sending user message to conversation|SendUserMessage failed:/.test(
      line,
    ),
  );
  const missingSignals = ORDER.filter(
    (signal) => signals[signal] === undefined,
  );
  const missingFreshConversationRequirements: AntigravityFreshConversationRequirement[] =
    [];
  if (
    !nativeState.project.ready ||
    !nativeState.project.defaultProject ||
    nativeState.project.resolvedProjectId !== "default-cli-project"
  )
    missingFreshConversationRequirements.push("native_project_resolution");
  if (!nativeState.project.cacheWritable)
    missingFreshConversationRequirements.push("native_project_cache_writable");
  if (!nativeState.project.configPresent)
    missingFreshConversationRequirements.push("native_project_config");
  if (!nativeState.project.configWritable)
    missingFreshConversationRequirements.push("native_project_config_writable");
  if (!nativeState.project.conversationStoreWritable)
    missingFreshConversationRequirements.push(
      "native_conversation_store_writable",
    );
  if (!nativeState.project.workspaceResolved)
    missingFreshConversationRequirements.push("native_workspace_resolution");
  if (!nativeState.prompt.focusReady)
    missingFreshConversationRequirements.push("prompt_focus");
  if (nativeState.prompt.editorMode !== "default")
    missingFreshConversationRequirements.push("default_editor_mode");
  if (
    nativeState.prompt.enterBinding !== "prompt.submit" ||
    nativeState.prompt.customKeybindingsPresent
  )
    missingFreshConversationRequirements.push("enter_prompt_submit_binding");

  const tuiInputReady = missingSignals.length === 0;
  const freshConversationReady =
    tuiInputReady &&
    !conversationObserved &&
    missingFreshConversationRequirements.length === 0;
  return {
    kind: ANTIGRAVITY_INITIAL_INPUT_READINESS_KIND,
    version: 2,
    tuiInputReady,
    freshConversationReady,
    ready: freshConversationReady,
    nativeConversationBootstrap: conversationObserved
      ? "active_or_ambiguous"
      : freshConversationReady
        ? "ready_without_conversation"
        : "not_ready",
    conversationState: conversationObserved ? "active_or_ambiguous" : "none",
    model,
    signals,
    missingSignals,
    missingFreshConversationRequirements,
    nativeState,
  };
}

export function isAntigravityInputReadyForMode(
  readiness: AntigravityInitialInputReadiness,
  requireConversationFree: boolean,
): boolean {
  return (
    readiness.tuiInputReady &&
    readiness.missingFreshConversationRequirements.length === 0 &&
    (!requireConversationFree || readiness.freshConversationReady)
  );
}

function findExactModelResolution(
  lines: string[],
  model: string,
  after: number,
): number {
  const exact = new RegExp(`Resolving model ${escapeRegExp(model)}(?:\\s|$)`);
  return lines.findIndex((line, candidate) =>
    candidate > after ? exact.test(line) : false,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
