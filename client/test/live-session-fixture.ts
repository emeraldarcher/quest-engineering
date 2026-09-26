import type { RunStep } from "../src/api/contracts";

export function attachTestLiveSession(
  step: RunStep,
  {
    canObserve,
    canTakeover,
    id = "session-pre-prompt",
  }: { canObserve: boolean; canTakeover: boolean; id?: string },
) {
  if (!step.attempt) throw new Error("Expected current Attempt");
  step.session = {
    id,
    harness: { kind: "antigravity", display_name: "Antigravity" },
    worker: {
      id: "local-worker",
      display_name: "local-worker",
      state: "connected",
    },
    state: "waiting_for_human",
    native_identity: {
      conversation_id: null,
      terminal_id: "terminal-1",
    },
    capabilities: {
      can_attach_terminal: true,
      can_send_input: true,
      can_interrupt: true,
      can_detect_attention: true,
      can_resume: true,
      can_observe_structured_events: true,
      structured_confirmation: false,
      structured_text_response: false,
      structured_choice_response: false,
      structured_multiline_response: false,
      native_prompt_control: true,
      conversational_takeover: true,
      automation_resume: true,
    },
    attachment: {
      mode: "local_native_terminal",
      available: true,
      reason: null,
      can_observe: canObserve,
      can_takeover: canTakeover,
      can_recover: false,
    },
    attention: {
      attention_id: `qe-prompt-authorization-${step.attempt.id}`,
      category: "needs_confirmation",
      interaction: {
        kind: "confirmation",
        control_state: "intervention_pending",
      },
      message: "Explicit authorization is required.",
      requested_at: "2026-09-26T00:00:00Z",
    },
    started_at: "2026-09-26T00:00:00Z",
    last_activity_at: "2026-09-26T00:00:01Z",
    events: [],
  };
  return step.session;
}
