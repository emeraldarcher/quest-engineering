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

export interface AntigravityInitialInputReadiness {
  kind: typeof ANTIGRAVITY_INITIAL_INPUT_READINESS_KIND;
  version: 1;
  ready: boolean;
  conversationState: "none" | "active_or_ambiguous";
  model: string;
  /** One-based native-log line number for every required ordered signal. */
  signals: Partial<Record<AntigravityInitialInputSignal, number>>;
  missingSignals: AntigravityInitialInputSignal[];
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
 * Antigravity 1.2.7 emits these native signals as its authentication, account
 * metadata, model, experiment/customization and fresh input managers settle.
 * This is an ordered evidence parser, not a timing heuristic.
 */
export function inspectAntigravityInitialInputReadiness(
  log: string,
  model: string,
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
  return {
    kind: ANTIGRAVITY_INITIAL_INPUT_READINESS_KIND,
    version: 1,
    ready: missingSignals.length === 0 && !conversationObserved,
    conversationState: conversationObserved ? "active_or_ambiguous" : "none",
    model,
    signals,
    missingSignals,
  };
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
