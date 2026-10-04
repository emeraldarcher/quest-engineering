import { createHash } from "node:crypto";
import type { HostedPaneProcessInfo } from "./types.ts";

/** Stable digest of the exact foreground process observation Herdr returned. */
export function paneProcessIdentityDigest(
  process: HostedPaneProcessInfo,
): string {
  const foregroundProcesses = process.foregroundProcesses
    .map((value) => ({
      pid: value.pid,
      name: value.name,
      argv0: value.argv0 ?? null,
      argv: value.argv ?? null,
      cmdline: value.cmdline ?? null,
      cwd: value.cwd ?? null,
    }))
    .sort(
      (left, right) =>
        left.pid - right.pid || left.name.localeCompare(right.name),
    );
  return createHash("sha256")
    .update(
      JSON.stringify({
        paneId: process.paneId,
        shellPid: process.shellPid ?? null,
        foregroundProcessGroupId: process.foregroundProcessGroupId ?? null,
        tty: process.tty ?? null,
        foregroundProcesses,
      }),
    )
    .digest("hex");
}
