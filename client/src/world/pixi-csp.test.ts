import { expect, test } from "bun:test";
import { AbstractRenderer } from "pixi.js";
import "pixi.js/unsafe-eval";

test("Pixi installs its static synchronizers for strict-CSP runtimes", () => {
  const unsafeEvalCheck = (
    AbstractRenderer.prototype as unknown as {
      _unsafeEvalCheck: () => void;
    }
  )._unsafeEvalCheck;

  expect(() => unsafeEvalCheck()).not.toThrow();
});
