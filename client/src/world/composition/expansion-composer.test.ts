import { expect, test } from "bun:test";
import { evaluateExpansionHysteresis } from "./expansion-composer";

test("expansion hysteresis requires sustained high and low demand", () => {
  const config = { attachAbove: 8, retireBelow: 4, sustainForMs: 1_000 };
  let state = { attached: false, candidateSince: null as number | null };
  state = evaluateExpansionHysteresis(state, 9, 100, config);
  expect(state).toEqual({ attached: false, candidateSince: 100 });
  state = evaluateExpansionHysteresis(state, 9, 1_099, config);
  expect(state.attached).toBe(false);
  state = evaluateExpansionHysteresis(state, 9, 1_100, config);
  expect(state).toEqual({ attached: true, candidateSince: null });
  state = evaluateExpansionHysteresis(state, 6, 2_000, config);
  expect(state).toEqual({ attached: true, candidateSince: null });
  state = evaluateExpansionHysteresis(state, 3, 3_000, config);
  state = evaluateExpansionHysteresis(state, 3, 4_000, config);
  expect(state).toEqual({ attached: false, candidateSince: null });
});
