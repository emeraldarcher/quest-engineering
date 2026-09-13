export interface InteractiveStateSample {
  at: string;
  state: string;
  nativeConversationId?: string | null;
  detail?: string;
}

export type InteractiveTeardownKind =
  | "detached_then_orderly_exit"
  | "expected_terminal_disappearance"
  | "unexpected_attach_failure";

export interface InteractivePhaseAssessment {
  identityObserved: boolean;
  identityChanged: boolean;
  workingObserved: boolean;
  settledAfterWorking: boolean;
  teardownKind: InteractiveTeardownKind;
  canAttemptFinalHeadlessResume: boolean;
}

export function assessInteractivePhase(input: {
  expectedConversationId: string;
  states: InteractiveStateSample[];
  attachExitCode: number;
  attachStderr: string;
}): InteractivePhaseAssessment {
  const nativeIds = input.states
    .map((sample) => sample.nativeConversationId)
    .filter((value): value is string => Boolean(value));
  const identityObserved = nativeIds.includes(input.expectedConversationId);
  const identityChanged = nativeIds.some(
    (value) => value !== input.expectedConversationId,
  );
  let workingIndex = -1;
  let settledAfterWorking = false;
  for (const [index, sample] of input.states.entries()) {
    if (
      sample.state === "working" &&
      sample.nativeConversationId === input.expectedConversationId
    )
      workingIndex = index;
    if (
      workingIndex >= 0 &&
      index > workingIndex &&
      (sample.state === "idle" || sample.state === "done") &&
      sample.nativeConversationId === input.expectedConversationId
    )
      settledAfterWorking = true;
  }
  const workingObserved = workingIndex >= 0;
  const terminalDisappeared =
    /terminal attach ended:/i.test(input.attachStderr) &&
    /terminal\s+\S+\s+not found|terminal(?: was)? closed/i.test(
      input.attachStderr,
    );
  const teardownKind: InteractiveTeardownKind =
    input.attachExitCode === 0
      ? "detached_then_orderly_exit"
      : terminalDisappeared &&
          identityObserved &&
          !identityChanged &&
          settledAfterWorking
        ? "expected_terminal_disappearance"
        : "unexpected_attach_failure";
  return {
    identityObserved,
    identityChanged,
    workingObserved,
    settledAfterWorking,
    teardownKind,
    canAttemptFinalHeadlessResume:
      identityObserved &&
      !identityChanged &&
      settledAfterWorking &&
      teardownKind !== "unexpected_attach_failure",
  };
}
