import { get } from "svelte/store";
import { beforeEach, expect, test, vi } from "vitest";

const notificationInitialization = vi.hoisted(() => vi.fn());

vi.mock("../src/platform/attention-notification", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/platform/attention-notification")
    >();
  return {
    ...actual,
    initializeAttentionNotifications: notificationInitialization,
  };
});

import type { ApiClient } from "../src/api/client";
import { NotificationInitializationError } from "../src/platform/attention-notification";
import {
  createAppStore,
  productBootstrapStateFor,
} from "../src/state/app-store";

beforeEach(() => {
  vi.clearAllMocks();
  notificationInitialization.mockResolvedValue(undefined);
});

test("the authoritative empty starter result is an explicit onboarding state", () => {
  expect(productBootstrapStateFor({ state: "empty", conflict: null })).toBe(
    "needs_product_onboarding",
  );
  expect(
    productBootstrapStateFor({ state: "recoverable_partial", conflict: null }),
  ).toBe("needs_product_onboarding");
  expect(productBootstrapStateFor({ state: "complete", conflict: null })).toBe(
    "ready",
  );
  expect(
    productBootstrapStateFor({ state: "manual_configuration", conflict: null }),
  ).toBe("ready");
});

test("unexpected native notification failures become actionable store diagnostics", async () => {
  notificationInitialization.mockRejectedValue(
    new NotificationInitializationError(
      "register_notification_action_types",
      "native registration failed",
    ),
  );
  const store = createAppStore({} as ApiClient, "ws://example.invalid/client");

  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(get(store.error)).toMatchObject({
    code: "attention_notification_initialization_failed",
    message: "Native attention notifications could not be initialized.",
    meta: {
      operation: "register_notification_action_types",
      native_error: "native registration failed",
    },
  });
  store.dispose();
});
