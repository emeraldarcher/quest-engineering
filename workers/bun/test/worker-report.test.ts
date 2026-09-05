import { expect, test } from "bun:test";
import type { ReconcileDispatch } from "../src/protocol/types.ts";
import { dispatchReportMessage } from "../src/worker.ts";

const dispatch: ReconcileDispatch = {
  action_id: "action-1",
  occurrence_id: "occurrence-1",
  attempt_id: "attempt-1",
  state: "running",
};

test("running dispatch state omits terminal fields", () => {
  expect(dispatchReportMessage("worker-1", dispatch, "dispatch_state")).toEqual(
    {
      type: "dispatch_state",
      protocol_version: 4,
      worker_id: "worker-1",
      action_id: "action-1",
      occurrence_id: "occurrence-1",
      attempt_id: "attempt-1",
      state: "running",
    },
  );
});

test("uncertain dispatch state includes the structured failure required by protocol v4", () => {
  expect(
    dispatchReportMessage(
      "worker-1",
      {
        ...dispatch,
        state: "uncertain",
        failure: {
          reason: "provider_execution_failed",
          message: "Pi settled without a structured step result.",
        },
      },
      "dispatch_state",
    ),
  ).toMatchObject({
    type: "dispatch_state",
    state: "uncertain",
    failure: {
      reason: "provider_execution_failed",
      message: "Pi settled without a structured step result.",
    },
  });
});

test("uncertain dispatch state receives an object fallback failure", () => {
  expect(
    dispatchReportMessage(
      "worker-1",
      { ...dispatch, state: "uncertain" },
      "dispatch_state",
    ),
  ).toMatchObject({
    state: "uncertain",
    failure: { reason: "execution_uncertain" },
  });
});
