import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const READ_ONLY = new Set(["read", "grep", "find", "ls", "qe_step_result"]);
const PATH_FIELDS = ["path", "file_path", "directory", "cwd"];

export default function workspacePermissionExtension(pi: ExtensionAPI) {
  const allowed = () =>
    new Set(
      (process.env.QE_ALLOWED_PI_TOOLS ?? "qe_step_result")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    );
  const access = () => process.env.QE_WORKSPACE_ACCESS ?? "none";
  const apply = () => pi.setActiveTools([...allowed()]);

  pi.on("session_start", apply);
  pi.on("before_agent_start", apply);
  pi.on("tool_call", (event) => {
    if (!allowed().has(event.toolName))
      return {
        block: true,
        reason: `Tool ${event.toolName} is outside the resolved QE capability mapping.`,
        terminate: true,
      };
    if (access() === "none" && event.toolName !== "qe_step_result")
      return {
        block: true,
        reason: "This execution has no workspace access.",
        terminate: true,
      };
    if (access() === "read_only" && !READ_ONLY.has(event.toolName))
      return {
        block: true,
        reason: `Tool ${event.toolName} is not permitted by read-only workspace access.`,
        terminate: true,
      };
    const outside = outsideWorkspace(event.input);
    if (outside)
      return {
        block: true,
        reason: `Path ${outside} is outside the resolved workspace root.`,
        terminate: true,
      };
  });
  pi.on("user_bash", () =>
    access() !== "read_write"
      ? {
          result: {
            output: "Shell commands are disabled by resolved workspace access.",
            exitCode: 126,
            cancelled: false,
            truncated: false,
          },
        }
      : undefined,
  );
}

function outsideWorkspace(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const rootValue = process.env.QE_WORKSPACE_ROOT;
  if (!rootValue) return "<missing-workspace-root>";
  const root = realpathSync(rootValue);
  for (const field of PATH_FIELDS) {
    const value = (input as Record<string, unknown>)[field];
    if (typeof value !== "string" || value.length === 0) continue;
    const absolute = isAbsolute(value) ? resolve(value) : resolve(root, value);
    const canonical = existingCanonical(absolute);
    const rel = relative(root, canonical);
    if (
      rel === ".." ||
      rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(rel)
    )
      return value;
  }
  return null;
}

function existingCanonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(
      realpathSync(dirname(path)),
      path.split(/[\\/]/).pop() ?? "",
    );
  }
}
