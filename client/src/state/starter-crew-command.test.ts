import { expect, mock, test } from "bun:test";
import { executeStarterCrewCommand } from "./starter-crew-command";

test("a lost response is recovered when refreshed status is complete despite unavailable execution", async () => {
  const createStarterCrew = mock(async () => {
    throw new Error("response lost");
  });
  const getStarterCrewStatus = mock(async () => ({
    state: "complete" as const,
    conflict: null,
  }));

  const outcome = await executeStarterCrewCommand(
    { createStarterCrew, getStarterCrewStatus },
    "workspace-1",
  );

  expect(outcome).toEqual({
    state: "ready",
    result: null,
    recovered: true,
  });
  expect(createStarterCrew).toHaveBeenCalledTimes(1);
  expect(getStarterCrewStatus).toHaveBeenCalledTimes(1);
});

test("an atomic failure preserves the refreshed non-complete status", async () => {
  const failure = new Error("transaction failed");
  const outcome = await executeStarterCrewCommand(
    {
      createStarterCrew: async () => {
        throw failure;
      },
      getStarterCrewStatus: async () => ({ state: "empty", conflict: null }),
    },
    "workspace-1",
  );

  expect(outcome).toEqual({
    state: "failed",
    cause: failure,
    status: { state: "empty", conflict: null },
  });
});
