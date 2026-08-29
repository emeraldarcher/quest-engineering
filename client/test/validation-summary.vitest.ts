import { render, screen } from "@testing-library/svelte";
import { expect, test } from "vitest";
import ValidationSummary from "../src/components/ValidationSummary.svelte";

test("renders structured server validation paths instead of a generic error", () => {
  render(ValidationSummary, {
    props: {
      details: [
        {
          code: "invalid_value",
          path: ["members", 0, "class_id"],
          details: {},
        },
      ],
    },
  });
  expect(screen.getByRole("alert").textContent).toContain(
    "members.0.class_id: invalid_value",
  );
});
