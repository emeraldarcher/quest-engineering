import { beforeEach, expect, test, vi } from "vitest";

const notification = vi.hoisted(() => ({
  isPermissionGranted: vi.fn(async () => true),
  onAction: vi.fn(async () => () => undefined),
  registerActionTypes: vi.fn(async () => undefined),
  requestPermission: vi.fn(async () => "granted"),
  sendNotification: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/plugin-notification", () => notification);

import {
  initializeAttentionNotifications,
  notifyHumanAttention,
} from "../src/platform/attention-notification";

beforeEach(() => notification.sendNotification.mockClear());

test("a Herdr-only blocked attention produces the normal native notification", async () => {
  await initializeAttentionNotifications(() => undefined);
  await notifyHumanAttention({
    attentionId: "herdr-blocked-episode",
    runId: "run-1",
    occurrenceId: "occurrence-1",
    attemptId: "attempt-1",
    sessionId: "session-1",
    questTitle: "Ship migration",
    memberName: "Alice",
    stepName: "Implement",
    harnessName: "Pi",
    message: "Pi is waiting for input",
  });

  expect(notification.sendNotification).toHaveBeenCalledTimes(1);
  expect(notification.sendNotification).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Alice needs your help",
      body: "Ship migration\nPi is waiting: Pi is waiting for input",
      actionTypeId: "qe-live-session-attention",
    }),
  );
});
