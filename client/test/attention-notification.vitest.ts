import { beforeEach, expect, test, vi } from "vitest";

const core = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));
const notification = vi.hoisted(() => ({
  isPermissionGranted: vi.fn(async () => true),
  onAction: vi.fn(async () => () => undefined),
  registerActionTypes: vi.fn(async () => undefined),
  requestPermission: vi.fn(async () => "granted"),
  sendNotification: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => core);
vi.mock("@tauri-apps/plugin-notification", () => notification);

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  core.isTauri.mockReturnValue(true);
  core.invoke.mockResolvedValue(false);
  notification.isPermissionGranted.mockResolvedValue(true);
  notification.onAction.mockResolvedValue(() => undefined);
  notification.registerActionTypes.mockResolvedValue(undefined);
  notification.requestPermission.mockResolvedValue("granted");
});

function attention() {
  return {
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
  };
}

test("desktop skips unsupported notification actions and still sends notifications", async () => {
  const { initializeAttentionNotifications, notifyHumanAttention } =
    await import("../src/platform/attention-notification");

  await initializeAttentionNotifications(() => undefined);
  await notifyHumanAttention(attention());

  expect(core.invoke).toHaveBeenCalledWith(
    "notification_action_types_supported",
  );
  expect(notification.registerActionTypes).not.toHaveBeenCalled();
  expect(notification.onAction).not.toHaveBeenCalled();
  expect(notification.sendNotification).toHaveBeenCalledTimes(1);
  expect(notification.sendNotification).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Alice needs your help",
      body: "Ship migration\nPi is waiting: Pi is waiting for input",
      actionTypeId: "qe-live-session-attention",
    }),
  );
});

test("supported mobile targets register notification actions and their listener", async () => {
  core.invoke.mockResolvedValue(true);
  const { initializeAttentionNotifications } = await import(
    "../src/platform/attention-notification"
  );
  const route = vi.fn();

  await initializeAttentionNotifications(route);

  expect(notification.registerActionTypes).toHaveBeenCalledTimes(1);
  expect(notification.registerActionTypes).toHaveBeenCalledWith([
    {
      id: "qe-live-session-attention",
      actions: [
        {
          id: "open-session",
          title: "Open Session",
          foreground: true,
        },
      ],
    },
  ]);
  expect(notification.onAction).toHaveBeenCalledTimes(1);
});

test("unexpected supported-platform registration failures retain the operation and native error", async () => {
  core.invoke.mockResolvedValue(true);
  notification.registerActionTypes.mockRejectedValue(
    "native registration failed",
  );
  const { initializeAttentionNotifications, NotificationInitializationError } =
    await import("../src/platform/attention-notification");

  const failure = await initializeAttentionNotifications(() => undefined).catch(
    (cause) => cause,
  );

  expect(failure).toBeInstanceOf(NotificationInitializationError);
  expect(failure).toMatchObject({
    operation: "register_notification_action_types",
    nativeError: "native registration failed",
    message: "Native attention notifications could not be initialized.",
  });
});

test("desktop startup emits no unhandled notification initialization rejection", async () => {
  const unhandled = vi.fn();
  window.addEventListener("unhandledrejection", unhandled);
  try {
    const { initializeAttentionNotifications } = await import(
      "../src/platform/attention-notification"
    );

    void initializeAttentionNotifications(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(unhandled).not.toHaveBeenCalled();
    expect(notification.registerActionTypes).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("unhandledrejection", unhandled);
  }
});
