import { isTauri } from "@tauri-apps/api/core";
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

let initialized: Promise<void> | null = null;
let route: ((target: AttentionTarget) => void) | null = null;

export function initializeAttentionNotifications(
  onOpen: (target: AttentionTarget) => void,
): Promise<void> {
  route = onOpen;
  if (!isTauri()) return Promise.resolve();
  initialized ??= (async () => {
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
    await onAction((notification) => {
      const target = notification.extra?.target;
      if (isAttentionTarget(target)) route?.(target);
    });
  })();
  return initialized;
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
