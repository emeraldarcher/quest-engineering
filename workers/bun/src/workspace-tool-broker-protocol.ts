export const WORKSPACE_TOOL_BROKER_PROTOCOL =
  "workspace_tool_broker_v1" as const;
export const MAX_BROKER_FRAME_BYTES = 320 * 1024;
export const MAX_BROKER_PATH_BYTES = 1_024;
export const MAX_BROKER_FILE_BYTES = 256 * 1024;
export const MAX_BROKER_QUERY_BYTES = 4 * 1024;
export const MAX_BROKER_COMMAND_BYTES = 32 * 1024;
export const MAX_BROKER_STDIO_BYTES = 64 * 1024;
export const MAX_BROKER_METADATA_BYTES = 64 * 1024;
export const MAX_BROKER_SEARCH_RESULTS = 100;
export const MIN_BROKER_TIMEOUT_MS = 100;
export const MAX_BROKER_TIMEOUT_MS = 30_000;

export type WorkspaceToolOperation =
  | "filesystem.read"
  | "filesystem.list"
  | "filesystem.stat"
  | "filesystem.write"
  | "filesystem.edit"
  | "search.grep"
  | "terminal.shell";

export type WorkspaceToolRequest =
  | BrokerRequest<"filesystem.read", { path: string }>
  | BrokerRequest<"filesystem.list", { path: string }>
  | BrokerRequest<"filesystem.stat", { path: string }>
  | BrokerRequest<"filesystem.write", { path: string; content: string }>
  | BrokerRequest<
      "filesystem.edit",
      {
        path: string;
        old_text: string;
        new_text: string;
        expected_replacements: number;
      }
    >
  | BrokerRequest<"search.grep", { path: string; query: string }>
  | BrokerRequest<
      "terminal.shell",
      { command: string; cwd: string; timeout_ms: number }
    >;

interface BrokerRequest<
  Operation extends WorkspaceToolOperation,
  Arguments extends Record<string, unknown>,
> {
  version: typeof WORKSPACE_TOOL_BROKER_PROTOCOL;
  type: "request";
  request_id: string;
  operation: Operation;
  arguments: Arguments;
}

export type WorkspaceToolCertainty =
  | "not_submitted"
  | "acknowledged"
  | "completed"
  | "uncertain";

export interface WorkspaceToolResponse {
  version: typeof WORKSPACE_TOOL_BROKER_PROTOCOL;
  type: "response";
  request_id: string;
  status: "completed" | "rejected" | "uncertain" | "cancelled";
  certainty: WorkspaceToolCertainty;
  result: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
}

const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function decodeWorkspaceToolRequest(
  value: unknown,
): WorkspaceToolRequest {
  const frame = record(value, "broker request");
  exactKeys(frame, ["version", "type", "request_id", "operation", "arguments"]);
  if (
    frame.version !== WORKSPACE_TOOL_BROKER_PROTOCOL ||
    frame.type !== "request" ||
    typeof frame.request_id !== "string" ||
    !requestIdPattern.test(frame.request_id)
  )
    throw new Error("Workspace tool broker request identity is invalid.");
  const operation = operationName(frame.operation);
  const args = record(frame.arguments, "broker arguments");
  const base = {
    version: WORKSPACE_TOOL_BROKER_PROTOCOL,
    type: "request" as const,
    request_id: frame.request_id,
  };
  let decoded: WorkspaceToolRequest;
  switch (operation) {
    case "filesystem.read":
    case "filesystem.list":
    case "filesystem.stat":
      exactKeys(args, ["path"]);
      decoded = {
        ...base,
        operation,
        arguments: { path: relativePath(args.path) },
      };
      break;
    case "filesystem.write":
      exactKeys(args, ["path", "content"]);
      decoded = {
        ...base,
        operation,
        arguments: {
          path: relativePath(args.path),
          content: boundedString(
            args.content,
            "content",
            MAX_BROKER_FILE_BYTES,
            true,
          ),
        },
      };
      break;
    case "filesystem.edit":
      exactKeys(args, [
        "path",
        "old_text",
        "new_text",
        "expected_replacements",
      ]);
      if (
        !Number.isSafeInteger(args.expected_replacements) ||
        (args.expected_replacements as number) < 1 ||
        (args.expected_replacements as number) > 1_000
      )
        throw new Error("Workspace edit replacement count is invalid.");
      decoded = {
        ...base,
        operation,
        arguments: {
          path: relativePath(args.path),
          old_text: boundedString(
            args.old_text,
            "old_text",
            MAX_BROKER_FILE_BYTES,
            false,
          ),
          new_text: boundedString(
            args.new_text,
            "new_text",
            MAX_BROKER_FILE_BYTES,
            true,
          ),
          expected_replacements: args.expected_replacements as number,
        },
      };
      break;
    case "search.grep":
      exactKeys(args, ["path", "query"]);
      decoded = {
        ...base,
        operation,
        arguments: {
          path: relativePath(args.path),
          query: boundedString(
            args.query,
            "query",
            MAX_BROKER_QUERY_BYTES,
            false,
          ),
        },
      };
      break;
    case "terminal.shell":
      exactKeys(args, ["command", "cwd", "timeout_ms"]);
      if (
        !Number.isSafeInteger(args.timeout_ms) ||
        (args.timeout_ms as number) < MIN_BROKER_TIMEOUT_MS ||
        (args.timeout_ms as number) > MAX_BROKER_TIMEOUT_MS
      )
        throw new Error("Workspace shell timeout is invalid.");
      decoded = {
        ...base,
        operation,
        arguments: {
          command: boundedString(
            args.command,
            "command",
            MAX_BROKER_COMMAND_BYTES,
            false,
          ),
          cwd: relativePath(args.cwd),
          timeout_ms: args.timeout_ms as number,
        },
      };
  }
  if (
    Buffer.byteLength(JSON.stringify(decoded), "utf8") > MAX_BROKER_FRAME_BYTES
  )
    throw new Error("Workspace tool broker request exceeds its frame bound.");
  return decoded;
}

export function decodeWorkspaceToolResponse(
  value: unknown,
): WorkspaceToolResponse {
  const frame = record(value, "broker response");
  exactKeys(frame, [
    "version",
    "type",
    "request_id",
    "status",
    "certainty",
    "result",
    "error",
  ]);
  if (
    frame.version !== WORKSPACE_TOOL_BROKER_PROTOCOL ||
    frame.type !== "response" ||
    typeof frame.request_id !== "string" ||
    !requestIdPattern.test(frame.request_id) ||
    !["completed", "rejected", "uncertain", "cancelled"].includes(
      frame.status as string,
    ) ||
    !["not_submitted", "acknowledged", "completed", "uncertain"].includes(
      frame.certainty as string,
    )
  )
    throw new Error("Workspace tool broker response identity is invalid.");
  const result =
    frame.result === null ? null : record(frame.result, "broker result");
  let error: WorkspaceToolResponse["error"] = null;
  if (frame.error !== null) {
    const candidate = record(frame.error, "broker error");
    exactKeys(candidate, ["code", "message"]);
    error = {
      code: boundedString(candidate.code, "error.code", 128, false),
      message: boundedString(candidate.message, "error.message", 1_024, false),
    };
  }
  const status = frame.status as WorkspaceToolResponse["status"];
  const certainty = frame.certainty as WorkspaceToolCertainty;
  const validLifecycle =
    (status === "completed" &&
      certainty === "completed" &&
      result !== null &&
      error === null) ||
    (status === "rejected" &&
      (certainty === "not_submitted" || certainty === "acknowledged") &&
      result === null &&
      error !== null) ||
    (status === "uncertain" &&
      certainty === "uncertain" &&
      result === null &&
      error !== null) ||
    (status === "cancelled" &&
      certainty === "acknowledged" &&
      result === null &&
      error !== null);
  if (!validLifecycle)
    throw new Error("Workspace tool broker response lifecycle is invalid.");
  const response: WorkspaceToolResponse = {
    version: WORKSPACE_TOOL_BROKER_PROTOCOL,
    type: "response",
    request_id: frame.request_id,
    status,
    certainty,
    result,
    error,
  };
  if (
    Buffer.byteLength(JSON.stringify(response), "utf8") > MAX_BROKER_FRAME_BYTES
  )
    throw new Error("Workspace tool broker response exceeds its frame bound.");
  return response;
}

export function isMutatingWorkspaceTool(
  operation: WorkspaceToolOperation,
): boolean {
  return ["filesystem.write", "filesystem.edit", "terminal.shell"].includes(
    operation,
  );
}

export function requiredSemanticTool(
  operation: WorkspaceToolOperation,
): string {
  if (operation.startsWith("filesystem.")) return "workspace.filesystem";
  if (operation === "search.grep") return "workspace.search";
  return "terminal.shell";
}

function operationName(value: unknown): WorkspaceToolOperation {
  if (
    value === "filesystem.read" ||
    value === "filesystem.list" ||
    value === "filesystem.stat" ||
    value === "filesystem.write" ||
    value === "filesystem.edit" ||
    value === "search.grep" ||
    value === "terminal.shell"
  )
    return value;
  throw new Error("Unknown workspace tool broker operation.");
}

function relativePath(value: unknown): string {
  const path = boundedString(value, "path", MAX_BROKER_PATH_BYTES, true);
  if (
    path.includes("\0") ||
    path.startsWith("/") ||
    path.split("/").some((segment) => segment === "..") ||
    path.includes("\\")
  )
    throw new Error("Workspace path must be contained and relative.");
  return path === "" || path === "." ? "." : path.replace(/^\.\//, "");
}

function boundedString(
  value: unknown,
  field: string,
  maximumBytes: number,
  allowEmpty: boolean,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  )
    throw new Error(`Workspace tool broker ${field} is invalid.`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Workspace tool ${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  )
    throw new Error(
      "Workspace tool broker frame has unexpected or missing fields.",
    );
}
