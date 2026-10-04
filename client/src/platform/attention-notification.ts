import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  isPermissionGranted,
  onAction,
  registerActionTypes,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

export interface AttentionTarget {
  attentionId: string;
  runId: string;
  occurrenceId: string;
  attemptId: string;
  sessionId: string;
  questTitle: string;
  memberName: string;
  stepName: string;
  harnessName: string;
  message: string;
}

type NotificationInitializationOperation =
  | "detect_notification_action_capability"
  | "register_notification_action_types"
  | "register_notification_action_listener";

export class NotificationInitializationError extends Error {
  readonly operation: NotificationInitializationOperation;
  readonly nativeError: string;

  constructor(operation: NotificationInitializationOperation, cause: unknown) {
    super("Native attention notifications could not be initialized.", {
      cause,
    });
    this.name = "NotificationInitializationError";
    this.operation = operation;
    this.nativeError = nativeErrorMessage(cause);
  }
}

let initialized: Promise<void> | null = null;
let route: ((target: AttentionTarget) => void) | null = null;

export function initializeAttentionNotifications(
  onOpen: (target: AttentionTarget) => void,
): Promise<void> {
  route = onOpen;
  if (!isTauri()) return Promise.resolve();
  initialized ??= initializeNativeAttentionNotifications();
  return initialized;
}

async function initializeNativeAttentionNotifications(): Promise<void> {
  let actionTypesSupported: boolean;
  try {
    actionTypesSupported = await invoke<boolean>(
      "notification_action_types_supported",
    );
  } catch (cause) {
    throw new NotificationInitializationError(
      "detect_notification_action_capability",
      cause,
    );
  }
  if (!actionTypesSupported) return;

  try {
    await registerActionTypes([
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
  } catch (cause) {
    throw new NotificationInitializationError(
      "register_notification_action_types",
      cause,
    );
  }
  try {
    await onAction((notification) => {
      const target = notification.extra?.target;
      if (isAttentionTarget(target)) route?.(target);
    });
  } catch (cause) {
    throw new NotificationInitializationError(
      "register_notification_action_listener",
      cause,
    );
  }
}

export async function notifyHumanAttention(
  target: AttentionTarget,
): Promise<void> {
  if (!isTauri()) return;
  if (!initialized) return;
  await initialized;
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === "granted";
  if (!granted) return;
  sendNotification({
    id: stableNotificationId(target.attentionId),
    title: `${target.memberName} needs your help`,
    body: `${target.questTitle}\n${target.harnessName} is waiting: ${target.message}`,
    actionTypeId: "qe-live-session-attention",
    autoCancel: true,
    extra: { target },
  });
}

function nativeErrorMessage(cause: unknown): string {
  if (typeof cause === "string") return cause;
  if (cause instanceof Error) return cause.message;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

function stableNotificationId(value: string): number {
  let hash = 0;
  for (const character of value)
    hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  return hash & 0x7fffffff;
}

function isAttentionTarget(value: unknown): value is AttentionTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  return [
    "attentionId",
    "runId",
    "occurrenceId",
    "attemptId",
    "sessionId",
    "questTitle",
    "memberName",
    "stepName",
    "harnessName",
    "message",
  ].every((key) => typeof target[key] === "string" && target[key] !== "");
}
