import type {
  EngineInterface,
  Register,
  TurnStepChunk,
  TurnStepInput,
} from "claude-code";

const PROTOCOL = "qe_claude_mod_spike_v1";
const COMPLETE_TOOL = "mcp__qe-control-spike__qe_complete_step";
const ATTENTION_TOOL =
  "mcp__qe-control-spike__qe_request_human_assistance";
const MAX_BRIDGE_OUTPUT = 65_536;

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected an object from the QE control bridge.");
  return value as Record<string, unknown>;
}

function parseBridgeOutput(text: string): Record<string, unknown> {
  if (text.length > MAX_BRIDGE_OUTPUT)
    throw new Error("QE control bridge output exceeded the spike limit.");
  return object(JSON.parse(text));
}

function parseEffort(value: string): NonNullable<TurnStepInput["effort"]> {
  switch (value) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return value;
    default: {
      const numeric = Number(value);
      if (Number.isFinite(numeric) && numeric >= 0) return numeric;
      throw new Error("QE_CLAUDE_EFFORT is invalid.");
    }
  }
}

function parseAllowedTools(value: string): Set<string> {
  const parsed = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every(
      (entry) =>
        typeof entry === "string" && entry.length > 0 && entry.length < 256,
    )
  )
    throw new Error("QE_CLAUDE_ALLOWED_TOOLS_JSON is invalid.");
  return new Set(parsed);
}

async function runControl(
  $: EngineInterface,
  bridge: string,
  operation: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const execution = await $.process.run([bridge, "local-control"], {
    stdin: JSON.stringify(operation),
    timeoutMs: 30_000,
  });
  if (
    execution.exitCode !== 0 ||
    execution.isStdoutTruncated ||
    execution.isStderrTruncated
  )
    throw new Error(
      `QE control bridge failed (${execution.exitCode}): ${execution.stderr}`,
    );
  return parseBridgeOutput(execution.stdout);
}

async function waitForHuman(
  $: EngineInterface,
  bridge: string,
  operation: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const stream = $.process.spawn({
    argv: [bridge, "local-control-wait"],
    input: JSON.stringify(operation),
  });
  let stdout = "";
  let stderr = "";
  let item = await stream.next();
  while (item.done !== true) {
    if (item.value.stream === "stdout") stdout += item.value.text;
    else stderr += item.value.text;
    if (stdout.length + stderr.length > MAX_BRIDGE_OUTPUT) {
      await stream.return({ code: null, signal: "SIGTERM" });
      throw new Error("QE control bridge output exceeded the spike limit.");
    }
    item = await stream.next();
  }
  if (item.value.code !== 0 || item.value.signal !== null)
    throw new Error(
      `QE control bridge wait failed (${item.value.code ?? item.value.signal}): ${stderr}`,
    );
  return parseBridgeOutput(stdout);
}

function invalidConfigurationReason(): string {
  return "QE Claude Mod control configuration was not initialized; refusing the model turn.";
}

export const register: Register = (on) => {
  let ready = false;
  let bridge = "";
  let expectedModel = "";
  let expectedEffort: NonNullable<TurnStepInput["effort"]> | "" = "";
  let allowedTools = new Set<string>();
  let observedModel: string | undefined;
  let completionReason = "unknown";

  on("session.start", async ($, e, next) => {
    ready = false;
    const protocol = await $.env.get("QE_CLAUDE_MOD_PROTOCOL");
    bridge = (await $.env.get("QE_BRIDGE")) ?? "";
    expectedModel = (await $.env.get("QE_CLAUDE_MODEL")) ?? "";
    expectedEffort = parseEffort(
      (await $.env.get("QE_CLAUDE_EFFORT")) ?? "",
    );
    allowedTools = parseAllowedTools(
      (await $.env.get("QE_CLAUDE_ALLOWED_TOOLS_JSON")) ?? "",
    );
    if (protocol !== PROTOCOL || bridge.length === 0 || expectedModel.length === 0)
      throw new Error("QE Claude Mod control environment is incomplete.");

    await $.tool.register({
      name: "qe_complete_step",
      description:
        "Submit the declared structured outputs to Quest Engineering. Call exactly once when the step is complete.",
      inputSchema: {
        type: "object",
        properties: {
          outputs: {
            type: "object",
            additionalProperties: true,
          },
        },
        required: ["outputs"],
        additionalProperties: false,
      },
    });
    await $.tool.register({
      name: "qe_request_human_assistance",
      description:
        "Pause for a Quest Engineering human response when blocked on a decision or information.",
      inputSchema: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: [
              "needs_input",
              "needs_permission",
              "needs_authentication",
              "needs_confirmation",
              "blocked_external",
              "interactive_prompt",
              "unknown_interactive_block",
            ],
          },
          message: { type: "string" },
          interaction: {
            type: "string",
            enum: [
              "confirmation",
              "text",
              "choice",
              "multiline_response",
              "conversational_intervention",
            ],
          },
          responseSchema: {},
        },
        required: ["category", "message"],
        additionalProperties: false,
      },
    });
    await $.command.register({
      name: "qe_mod_probe",
      description: "Report QE Mod readiness without starting a model turn.",
    });
    allowedTools.add(COMPLETE_TOOL);
    allowedTools.add(ATTENTION_TOOL);
    ready = true;
    return next(e);
  });

  on("command.run", { command: "qe_mod_probe" }, async ($, e) => ({
    text: JSON.stringify({ protocol: PROTOCOL, ready, interactive: false }),
  }));

  on("prompt.submit", async ($, e, next) => {
    if (!ready) return { drop: invalidConfigurationReason() };
    return next({
      ...e,
      context: [
        ...(e.context ?? []),
        `Quest Engineering control contract: use ${COMPLETE_TOOL} exactly once with every declared output when complete. Use ${ATTENTION_TOOL} instead of AskUserQuestion when human input is required. Do not claim completion in prose before the completion tool is accepted.`,
      ],
    });
  }).catch(() => ({ drop: invalidConfigurationReason() }));

  on("agent.offer", () => ({ isOffered: false })).catch(() => ({
    isOffered: false,
  }));

  on("agent.spawn", () => ({
    deny: "QE disables Claude subagents until their authorization and accounting semantics are implemented.",
  })).catch(() => ({
    deny: "QE denied a subagent because the QE policy hook failed.",
  }));

  on("tool.call", async ($, e, next) => {
    if (!ready)
      return { deny: "QE control configuration is not initialized." };
    if (e.agentId)
      return { deny: "QE does not permit tool calls from Claude subagents." };
    if (!allowedTools.has(e.tool))
      return { deny: `QE did not authorize tool ${e.tool}.` };

    if (e.tool === COMPLETE_TOOL) {
      const input = object(e);
      const result = await runControl($, bridge, {
        type: "complete_step",
        outputs: object(input.outputs),
      });
      if (result.accepted !== true)
        throw new Error("QE rejected the structured completion.");
      return {
        result: JSON.stringify({
          accepted: true,
          duplicate: result.duplicate === true,
          semanticAccepted: result.semanticAccepted === true,
        }),
      };
    }

    if (e.tool === ATTENTION_TOOL) {
      const input = object(e);
      const result = await waitForHuman($, bridge, {
        type: "request_human_assistance_and_wait",
        category: input.category,
        message: input.message,
        ...(input.interaction === undefined
          ? {}
          : { interaction: input.interaction }),
        ...(input.responseSchema === undefined
          ? {}
          : { responseSchema: input.responseSchema }),
      });
      if (result.accepted !== true || result.humanResponse === undefined)
        throw new Error("QE did not return a human response.");
      return { result: JSON.stringify(result.humanResponse) };
    }

    return next(e);
  }).catch(($, e, next) => ({
    deny: `QE tool mediation failed closed: ${next.error.kind}.`,
  }));

  on("tool.check", async ($, e, next) => {
    if (!ready || e.agentId || !allowedTools.has(e.tool))
      return { decision: "deny", reason: "QE exact tool policy denied this call." };
    const lower = await next(e);
    if (lower.decision === "deny") return lower;
    if (e.ceiling === "ask" || e.ceiling === "deny")
      return { decision: e.ceiling, reason: "QE preserved the managed ceiling." };
    return { decision: "allow", reason: "QE exact tool policy allowed this call." };
  }).catch(() => ({
    decision: "deny",
    reason: "QE permission mediation failed closed.",
  }));

  on("turn.start", async ($, e, next) => next(e));

  on("turn.step", async function* ($, e, next) {
    if (
      !ready ||
      e.model !== expectedModel ||
      e.effort !== expectedEffort
    )
      return {
        turnId: e.turnId,
        index: e.index,
        answer: "",
        toolUses: [],
        stopReason: "refusal",
        usage: null,
      };
    const chunks: TurnStepChunk[] = [];
    const downstream = next(e);
    let item = await downstream.next();
    while (item.done !== true) {
      chunks.push(item.value);
      item = await downstream.next();
    }
    const result = item.value;
    if (result.usage !== null && result.usage.model !== expectedModel)
      return {
        turnId: e.turnId,
        index: e.index,
        answer: "",
        toolUses: [],
        stopReason: "refusal",
        usage: result.usage,
      };
    for (const chunk of chunks) yield chunk;
    return result;
  });

  on("turn.complete", async ($, e, next) => {
    observedModel = e.usage?.model;
    completionReason = e.reason;
    return next(e);
  });

  on("classic.Stop", async ($, e, next) => {
    const execution = await $.process.run([bridge, "hook", "stop"], {
      stdin: JSON.stringify({
        terminationReason: completionReason,
        fullyIdle: true,
        ...(observedModel === undefined ? {} : { modelName: observedModel }),
      }),
      timeoutMs: 30_000,
    });
    if (
      execution.exitCode !== 0 ||
      execution.isStdoutTruncated ||
      execution.isStderrTruncated
    )
      return {
        block:
          "QE completion enforcement failed. Continue without repeating finished work and retry the QE completion tool.",
      };
    const decision = parseBridgeOutput(execution.stdout);
    if (decision.decision === "continue")
      return { block: String(decision.reason ?? "Continue.") };
    return next(e);
  }).catch(() => ({
    block: "QE completion enforcement failed closed. Retry the QE completion tool.",
  }));
};
