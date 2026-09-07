import { expect, test } from "bun:test";
import { recordAttentionOnce } from "./attention-dedupe";

test("attention notification identity deduplicates projections and permits a later event", () => {
  const seen = new Set<string>();
  expect(recordAttentionOnce(seen, "attention-x")).toBe(true);
  expect(recordAttentionOnce(seen, "attention-x")).toBe(false);
  expect(recordAttentionOnce(seen, "attention-x")).toBe(false);
  // Resolution does not erase historical identity; a distinct later request does notify.
  expect(recordAttentionOnce(seen, "attention-y")).toBe(true);
});
