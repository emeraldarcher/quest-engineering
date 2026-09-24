#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { JsonValue } from "../../protocol/types.ts";
import { HarnessControlClient } from "./client.ts";
import { HARNESS_CONTROL_PATH_ENV } from "./descriptor.ts";
import { HarnessCompletionError, HarnessControlError } from "./types.ts";

export const QE_COMPLETE_STEP_TOOL = "qe_complete_step";
export const QE_MCP_STARTUP_EVIDENCE_ENV =
  "QE_HARNESS_MCP_STARTUP_EVIDENCE_PATH";

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

/**
 * Thin, harness-native MCP transport into the generic Worker control bridge.
 * Attempt identity never appears in the tool schema or model arguments.
 */
export function createQeHarnessBridgeMcpServer(
  client = HarnessControlClient.fromEnvironment(),
): McpServer {
  const server = new McpServer({
    name: "quest-engineering-harness-bridge",
    version: "1.0.0",
  });

  server.registerTool(
    QE_COMPLETE_STEP_TOOL,
    {
      title: "Complete Quest Engineering Step",
      description:
        "Submit the semantic outputs for the current Quest Engineering Step. Call exactly once after the assigned work is complete. The Worker supplies and validates all execution identity; provide only the declared output values.",
      inputSchema: {
        outputs: z
          .record(jsonValueSchema)
          .describe(
            "Object containing exactly the output names declared in the Quest Engineering instruction.",
          ),
      },
      outputSchema: {
        accepted: z.literal(true),
        completed: z.boolean(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ outputs }) => {
      try {
        const result = await client.completeStep(outputs);
        const response = {
          accepted: true as const,
          completed: result.completed === true,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(response) }],
          structuredContent: response,
        };
      } catch (error) {
        if (error instanceof HarnessCompletionError) {
          try {
            await client.reportCompletionFailure({
              kind: error.kind,
              code: error.code,
              message: error.message,
            });
          } catch {
            // The typed tool error still tells Stop to preserve work while the
            // bridge is unavailable; a later successful report is additive.
          }
        }
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: toolError(error),
            },
          ],
        };
      }
    },
  );

  return server;
}

export async function runQeHarnessBridgeMcpServer(): Promise<void> {
  // Fail before MCP initialization when Antigravity did not pass a live,
  // session-specific descriptor to this child. Each later tool call rereads the
  // descriptor so Worker-generation and retained-Attempt rotation take effect.
  const descriptorPath = process.env[HARNESS_CONTROL_PATH_ENV]?.trim();
  const client = HarnessControlClient.fromEnvironment();
  const status = await client.completionStatus();
  if (descriptorPath)
    await writeStartupEvidence(descriptorPath, status.completed);
  const server = createQeHarnessBridgeMcpServer(client);
  await server.connect(new StdioServerTransport());
}

async function writeStartupEvidence(
  descriptorPath: string,
  completed: boolean | undefined,
): Promise<void> {
  const path = process.env[QE_MCP_STARTUP_EVIDENCE_ENV]?.trim();
  if (!path) return;
  const descriptorPathHash = createHash("sha256")
    .update(descriptorPath)
    .digest("hex");
  await appendFile(
    path,
    `${JSON.stringify({
      kind: "qe_harness_mcp_startup",
      pid: process.pid,
      descriptorPathHash,
      bridgeAcceptedContext: true,
      completed: completed === true,
      recordedAt: new Date().toISOString(),
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function toolError(error: unknown): string {
  if (error instanceof HarnessCompletionError)
    return JSON.stringify({
      accepted: false,
      completed: false,
      error: {
        kind: error.kind,
        code: error.code,
        message: error.message,
        retryable: true,
        requiresCorrection: error.kind === "semantic_validation",
      },
    });
  if (error instanceof HarnessControlError)
    return JSON.stringify({
      accepted: false,
      completed: false,
      error: {
        kind: "infrastructure",
        code: error.code,
        message: error.message,
        retryable: true,
      },
    });
  return JSON.stringify({
    accepted: false,
    completed: false,
    error: {
      kind: "infrastructure",
      code: "bridge_unavailable",
      message: "Quest Engineering local completion infrastructure failed.",
      retryable: true,
    },
  });
}

if (import.meta.main) {
  runQeHarnessBridgeMcpServer().catch((error: unknown) => {
    const message =
      error instanceof HarnessControlError
        ? `Quest Engineering MCP bridge unavailable (${error.code}): ${error.message}`
        : "Quest Engineering MCP bridge failed to start.";
    console.error(message);
    process.exitCode = 1;
  });
}
