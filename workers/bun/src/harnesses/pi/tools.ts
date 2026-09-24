import type { DispatchRecord } from "../../dispatch/registry.ts";

export function mappedPiTools(
  dispatch: Pick<DispatchRecord, "action">,
): string[] {
  const policy = dispatch.action.execution.configuration.tool_policy;
  if (policy.kind !== "exact")
    throw new Error("Pi requires an exact tool policy.");
  const { tools } = policy;
  const workspace = dispatch.action.execution.execution_workspace;
  const mapped = new Set<string>([
    "qe_step_result",
    "qe_request_human_assistance",
  ]);
  if (workspace.access !== "none") {
    if (tools.includes("workspace.filesystem")) {
      mapped.add("read");
      if (workspace.access === "read_write") {
        mapped.add("edit");
        mapped.add("write");
      }
    }
    if (tools.includes("workspace.search")) {
      mapped.add("grep");
      mapped.add("find");
      mapped.add("ls");
    }
    if (tools.includes("terminal.shell") && workspace.access === "read_write")
      mapped.add("bash");
  }
  return [...mapped];
}
