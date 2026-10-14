import { createHash, randomUUID } from "node:crypto";
import type { EnvironmentLease } from "../../execution-environment/types.ts";
import type { JsonValue } from "../../protocol/types.ts";
import type { BoundWorkspaceToolClient } from "../../workspace-tool-broker.ts";
import {
  WORKSPACE_TOOL_BROKER_PROTOCOL,
  type WorkspaceToolRequest,
} from "../../workspace-tool-broker-protocol.ts";
import type { HarnessControlClient } from "../control/client.ts";

const BRIDGE_PROTOCOL = "qe_claude_account_cell_bridge_v1";
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_ACTIVE = 8;

interface BridgeEnvelope {
  protocol: typeof BRIDGE_PROTOCOL;
  token: string;
  requestId: string;
  operation: Record<string, unknown>;
}

export class ClaudeAccountCellRelay {
  private readonly inflight = new Set<string>();
  private readonly completed = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private scanActive = false;

  constructor(
    private readonly lease: EnvironmentLease,
    readonly mailboxRoot: string,
    readonly bridgeToken: string,
    private broker: BoundWorkspaceToolClient,
    private readonly control: HarnessControlClient,
    private assertCurrent: () => void,
    private readonly onFatal: (error: Error) => void,
    private readonly pollMs = 50,
  ) {}

  async start(): Promise<void> {
    if (!/^\/qe\/control\/claude\/[a-f0-9]{32}$/.test(this.mailboxRoot))
      throw new Error("Claude account relay mailbox identity is invalid.");
    if (!/^[a-f0-9]{64}$/.test(this.bridgeToken))
      throw new Error("Claude account relay token is invalid.");
    await this.lease.workerExec({
      executable: "/bin/rm",
      args: ["-rf", this.mailboxRoot],
    });
    await this.lease.workerExec({
      executable: "/usr/bin/install",
      args: [
        "-d",
        "-m",
        "0700",
        "-o",
        "1000",
        "-g",
        "1000",
        this.mailboxRoot,
        `${this.mailboxRoot}/requests`,
        `${this.mailboxRoot}/responses`,
      ],
    });
    this.schedule();
  }

  rebind(broker: BoundWorkspaceToolClient, assertCurrent: () => void): void {
    if (this.inflight.size > 0)
      throw new Error(
        "Claude account relay cannot rebind with active requests.",
      );
    this.broker = broker;
    this.assertCurrent = assertCurrent;
    this.completed.clear();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.lease
      .workerExec({
        executable: "/bin/rm",
        args: ["-rf", this.mailboxRoot],
      })
      .catch(() => undefined);
  }

  private schedule(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.scan().finally(() => this.schedule());
    }, this.pollMs);
  }

  private async scan(): Promise<void> {
    if (this.stopped || this.scanActive) return;
    this.scanActive = true;
    try {
      this.assertCurrent();
      const listing = await this.lease.exec({
        executable: "/usr/bin/python3",
        args: [
          "-c",
          "import json,os,pathlib; p=pathlib.Path(os.environ['P']); print(json.dumps(sorted(x.name for x in p.iterdir() if x.is_file() and x.name.endswith('.json'))))",
        ],
        environment: { P: `${this.mailboxRoot}/requests` },
        timeoutMs: 5_000,
      });
      if (listing.exitCode !== 0)
        throw new Error("Claude account relay could not inspect its mailbox.");
      const names = JSON.parse(listing.stdout) as unknown;
      if (
        !Array.isArray(names) ||
        names.some((name) => typeof name !== "string")
      )
        throw new Error("Claude account relay mailbox listing is invalid.");
      for (const name of names) {
        if (this.inflight.size >= MAX_ACTIVE) break;
        if (!/^[a-f0-9]{64}\.json$/.test(name as string))
          throw new Error(
            "Claude account relay observed an invalid request name.",
          );
        if (
          this.inflight.has(name as string) ||
          this.completed.has(name as string)
        )
          continue;
        this.inflight.add(name as string);
        void this.handle(name as string).finally(() =>
          this.inflight.delete(name as string),
        );
      }
    } catch (error) {
      if (!this.stopped)
        this.onFatal(
          error instanceof Error
            ? error
            : new Error("Claude account relay failed."),
        );
    } finally {
      this.scanActive = false;
    }
  }

  private async handle(name: string): Promise<void> {
    let envelope: BridgeEnvelope | null = null;
    try {
      this.assertCurrent();
      const path = `${this.mailboxRoot}/requests/${name}`;
      const bytes = await this.lease.readFile({
        path,
        maxBytes: MAX_REQUEST_BYTES,
      });
      envelope = decodeEnvelope(bytes, name, this.bridgeToken);
      const result = await this.execute(envelope.operation, envelope.requestId);
      await this.respond(name, envelope.requestId, true, result, null);
      this.completed.add(name);
    } catch (error) {
      const requestId = envelope?.requestId ?? "invalid";
      await this.respond(name, requestId, false, null, {
        code: errorCode(error),
        message:
          error instanceof Error
            ? error.message.slice(0, 1024)
            : "Claude account relay rejected the request.",
      }).catch(() => undefined);
      if (errorCode(error) === "broker_request_outcome_uncertain")
        this.onFatal(
          error instanceof Error
            ? error
            : new Error("Workspace broker outcome is uncertain."),
        );
    }
  }

  private async execute(
    operation: Record<string, unknown>,
    requestId: string,
  ): Promise<Record<string, JsonValue>> {
    if (operation.type === "request_human_assistance_and_wait")
      return this.humanAttention(operation, requestId);
    if (operation.type === "complete_step") {
      const outputs = jsonObject(operation.outputs, "outputs");
      const result = await this.control.completeStep(
        outputs,
        `mod:${requestId}`,
      );
      return {
        accepted: result.accepted,
        semanticAccepted: result.semanticAccepted ?? false,
      };
    }
    const brokerRequest = brokerRequestFor(operation, requestId);
    const response = await this.broker.request(brokerRequest);
    if (response.status !== "completed" || !response.result) {
      const error = new Error(
        response.error?.message ?? "Workspace broker rejected the request.",
      ) as Error & { code?: string };
      error.code =
        response.status === "uncertain"
          ? "broker_request_outcome_uncertain"
          : (response.error?.code ?? "broker_request_rejected");
      throw error;
    }
    const result = structuredClone(response.result) as Record<
      string,
      JsonValue
    >;
    if (operation.type === "workspace_read") {
      const content = result.content;
      if (typeof content !== "string")
        throw new Error("Workspace read response is malformed.");
      const offset = integer(operation.offset, 0, 10_000_000, 0);
      const limit = integer(operation.limit, 1, 100_000, 100_000);
      const lines = content.split("\n");
      result.content = lines.slice(offset, offset + limit).join("\n");
      result.totalLines = lines.length;
      result.offset = offset;
      result.truncated = offset + limit < lines.length;
    }
    if (operation.type === "workspace_search") {
      const maximum = integer(operation.maxResults, 1, 100, 100);
      if (Array.isArray(result.matches))
        result.matches = result.matches.slice(0, maximum) as JsonValue[];
    }
    return result;
  }

  private async humanAttention(
    operation: Record<string, unknown>,
    requestId: string,
  ): Promise<Record<string, JsonValue>> {
    const category = text(operation.category, "category", 64);
    if (
      ![
        "needs_input",
        "needs_permission",
        "needs_authentication",
        "needs_confirmation",
        "blocked_external",
        "interactive_prompt",
        "unknown_interactive_block",
      ].includes(category)
    )
      throw new Error("HumanAttention category is invalid.");
    const interaction =
      operation.interaction === undefined
        ? undefined
        : text(operation.interaction, "interaction", 64);
    const registered = await this.control.requestHumanAssistance(
      {
        category: category as Parameters<
          HarnessControlClient["requestHumanAssistance"]
        >[0]["category"],
        message: text(operation.message, "message", 16_384),
        ...(interaction
          ? {
              interaction: interaction as NonNullable<
                Parameters<
                  HarnessControlClient["requestHumanAssistance"]
                >[0]["interaction"]
              >,
            }
          : {}),
        ...(operation.responseSchema === undefined
          ? {}
          : {
              responseSchema: jsonValue(
                operation.responseSchema,
                "responseSchema",
              ),
            }),
        origin: { kind: "main_agent" },
      },
      `mod-attention:${requestId}`,
    );
    const handle = registered.attentionWaitHandle;
    if (!handle)
      throw new Error("HumanAttention authority returned no wait handle.");
    const waited = await this.control.waitForHumanAssistanceResponse(
      handle,
      `mod-wait:${requestId}`,
    );
    const value = waited.humanAttentionWait;
    if (!value || value.outcome !== "responded")
      throw new Error(
        value?.outcome === "cancelled"
          ? value.reason
          : "HumanAttention response was unavailable.",
      );
    await this.control.acknowledgeHumanAssistanceResponse(
      handle,
      value.deliveryAttemptId,
      `mod-ack:${requestId}`,
    );
    await this.control.resolveHumanAssistance(
      handle.attentionId,
      value.response.approved ? "completed" : "cannot_complete",
      `mod-resolve:${requestId}`,
    );
    return {
      approved: value.response.approved,
      value: value.response.value,
      respondedAt: value.response.respondedAt,
    };
  }

  private async respond(
    name: string,
    requestId: string,
    ok: boolean,
    result: Record<string, JsonValue> | null,
    error: { code: string; message: string } | null,
  ): Promise<void> {
    this.assertCurrent();
    await this.lease.writeFile({
      path: `${this.mailboxRoot}/responses/${name}`,
      data: new TextEncoder().encode(
        `${JSON.stringify({
          protocol: BRIDGE_PROTOCOL,
          requestId,
          ok,
          result,
          error,
        })}\n`,
      ),
      mode: 0o600,
    });
  }
}

function decodeEnvelope(
  bytes: Uint8Array,
  name: string,
  expectedToken: string,
): BridgeEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Claude account bridge request is malformed.");
  }
  const record = object(value, "bridge request");
  exactKeys(record, ["protocol", "token", "requestId", "operation"]);
  const requestId = text(record.requestId, "requestId", 128);
  if (
    record.protocol !== BRIDGE_PROTOCOL ||
    record.token !== expectedToken ||
    !/^[0-9a-f-]{36}$/.test(requestId) ||
    `${createHash("sha256").update(requestId).digest("hex")}.json` !== name
  )
    throw new Error("Claude account bridge request identity is invalid.");
  return {
    protocol: BRIDGE_PROTOCOL,
    token: expectedToken,
    requestId,
    operation: object(record.operation, "operation"),
  };
}

function brokerRequestFor(
  operation: Record<string, unknown>,
  bridgeRequestId: string,
): WorkspaceToolRequest {
  const requestId = `mod:${bridgeRequestId}`;
  const base = {
    version: WORKSPACE_TOOL_BROKER_PROTOCOL,
    type: "request" as const,
    request_id: requestId,
  };
  switch (operation.type) {
    case "workspace_read":
      return {
        ...base,
        operation: "filesystem.read",
        arguments: { path: path(operation.path) },
      };
    case "workspace_list":
      return {
        ...base,
        operation: "filesystem.list",
        arguments: { path: path(operation.path) },
      };
    case "workspace_write":
      return {
        ...base,
        operation: "filesystem.write",
        arguments: {
          path: path(operation.path),
          content: text(operation.content, "content", 262_144, true),
        },
      };
    case "workspace_edit":
      return {
        ...base,
        operation: "filesystem.edit",
        arguments: {
          path: path(operation.path),
          old_text: text(operation.oldText, "oldText", 262_144),
          new_text: text(operation.newText, "newText", 262_144, true),
          expected_replacements: integer(
            operation.expectedReplacements,
            1,
            1_000,
            1,
          ),
        },
      };
    case "workspace_search":
      return {
        ...base,
        operation: "search.grep",
        arguments: {
          path: path(operation.path),
          query: text(operation.query, "query", 4_096),
        },
      };
    case "run_shell":
      return {
        ...base,
        operation: "terminal.shell",
        arguments: {
          command: text(operation.command, "command", 32_768),
          cwd: ".",
          timeout_ms: integer(operation.timeoutMs, 100, 30_000, 30_000),
        },
      };
    default:
      throw new Error("Claude account bridge operation is not authorized.");
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function jsonObject(value: unknown, label: string): Record<string, JsonValue> {
  const result = object(value, label);
  jsonValue(result, label);
  return result as Record<string, JsonValue>;
}

function jsonValue(value: unknown, label: string): JsonValue {
  if (JSON.stringify(value).length > 262_144)
    throw new Error(`${label} is too large.`);
  return value as JsonValue;
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
    throw new Error("Claude account bridge request has unexpected fields.");
}

function text(
  value: unknown,
  label: string,
  maximum: number,
  empty = false,
): string {
  if (
    typeof value !== "string" ||
    (!empty && value.length === 0) ||
    Buffer.byteLength(value, "utf8") > maximum
  )
    throw new Error(`${label} is invalid.`);
  return value;
}

function path(value: unknown): string {
  const result = text(value, "path", 1_024);
  if (
    result.startsWith("/") ||
    result.includes("\\") ||
    result.includes("\0") ||
    result.split("/").some((part) => part === "..")
  )
    throw new Error("Workspace path is invalid.");
  return result;
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  )
    throw new Error("Integer bridge argument is invalid.");
  return Number(value);
}

function errorCode(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  )
    return error.code.slice(0, 128);
  return "account_relay_rejected";
}

export function newBridgeToken(): string {
  return createHash("sha256")
    .update(`${randomUUID()}${randomUUID()}`)
    .digest("hex");
}
