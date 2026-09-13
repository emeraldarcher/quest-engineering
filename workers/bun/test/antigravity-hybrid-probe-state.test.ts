import { describe, expect, test } from "bun:test";
import { assessInteractivePhase } from "../scripts/manual/antigravity-hybrid-probe-state.ts";

const conversationId = "07e79b89-e396-4780-99f5-f31be10240f1";

describe("Antigravity hybrid probe interactive teardown", () => {
  test("accepts terminal disappearance after a completed matching turn", () => {
    expect(
      assessInteractivePhase({
        expectedConversationId: conversationId,
        states: [
          { at: "1", state: "idle", nativeConversationId: null },
          {
            at: "2",
            state: "working",
            nativeConversationId: conversationId,
          },
          {
            at: "3",
            state: "done",
            nativeConversationId: conversationId,
          },
          { at: "4", state: "unavailable", detail: "agent not found" },
        ],
        attachExitCode: 1,
        attachStderr:
          "server shut down: terminal attach ended: terminal term_123 not found",
      }),
    ).toEqual({
      identityObserved: true,
      identityChanged: false,
      workingObserved: true,
      settledAfterWorking: true,
      teardownKind: "expected_terminal_disappearance",
      canAttemptFinalHeadlessResume: true,
    });
  });

  test("accepts supported direct-attach detach after a completed turn", () => {
    expect(
      assessInteractivePhase({
        expectedConversationId: conversationId,
        states: [
          {
            at: "1",
            state: "working",
            nativeConversationId: conversationId,
          },
          {
            at: "2",
            state: "idle",
            nativeConversationId: conversationId,
          },
        ],
        attachExitCode: 0,
        attachStderr: "",
      }).canAttemptFinalHeadlessResume,
    ).toBe(true);
  });

  test("rejects disappearance before the interactive turn settles", () => {
    const result = assessInteractivePhase({
      expectedConversationId: conversationId,
      states: [
        {
          at: "1",
          state: "working",
          nativeConversationId: conversationId,
        },
        { at: "2", state: "unavailable", detail: "agent not found" },
      ],
      attachExitCode: 1,
      attachStderr:
        "server shut down: terminal attach ended: terminal term_123 not found",
    });
    expect(result.teardownKind).toBe("unexpected_attach_failure");
    expect(result.canAttemptFinalHeadlessResume).toBe(false);
  });

  test("rejects a changed native conversation identity", () => {
    const result = assessInteractivePhase({
      expectedConversationId: conversationId,
      states: [
        {
          at: "1",
          state: "working",
          nativeConversationId: "11111111-1111-4111-8111-111111111111",
        },
        {
          at: "2",
          state: "done",
          nativeConversationId: "11111111-1111-4111-8111-111111111111",
        },
      ],
      attachExitCode: 0,
      attachStderr: "",
    });
    expect(result.identityChanged).toBe(true);
    expect(result.canAttemptFinalHeadlessResume).toBe(false);
  });
});
