#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PROTOCOL_VERSION = 2;
const WRAPPER_VERSION = "1.1.0";
const SDK_VERSION = "0.3.292";
const CLAUDE_CODE_VERSION = "2.1.292";
const MAX_FRAME_BYTES = 512 * 1024;
const encoder = new TextEncoder();
const seenRequests = new Set();
const pendingCompletion = new Map();
const pendingAttention = new Map();
let initialized = false;
let shuttingDown = false;
let generation = null;
let configuration = null;
let nativeSessionId = null;
let activeTurn = null;
let sdk = null;
let sdkOptionsPrepared = null;
let sdkQuery = null;
let sdkInput = null;
let sdkReader = null;
let queryInvocationState = "not_invoked";
let queryInvocationCount = 0;
let completionAcknowledged = false;
let fatal = false;

let inputBuffer = "";
let inputStopped = false;
let receiveQueue = Promise.resolve();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (inputStopped) return;
  inputBuffer += chunk;
  for (;;) {
    const newline = inputBuffer.indexOf("\n");
    if (newline < 0) break;
    const line = inputBuffer.slice(0, newline);
    inputBuffer = inputBuffer.slice(newline + 1);
    if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
      stopInput();
      receiveQueue = receiveQueue.then(() => fail("oversized_frame", "Wrapper input exceeded the protocol frame bound."));
      return;
    }
    if (line.trim()) receiveQueue = receiveQueue.then(() => receiveLine(line));
  }
  if (Buffer.byteLength(inputBuffer, "utf8") > MAX_FRAME_BYTES) {
    stopInput();
    receiveQueue = receiveQueue.then(() => fail("oversized_frame", "Wrapper input exceeded the protocol frame bound."));
  }
});
process.stdin.on("end", () => {
  if (inputStopped) return;
  if (inputBuffer.trim()) {
    const line = inputBuffer;
    inputBuffer = "";
    receiveQueue = receiveQueue.then(() => receiveLine(line));
  }
  receiveQueue = receiveQueue.then(() => shutdown(0));
});
process.on("SIGTERM", () => void shutdown(143));
process.on("SIGINT", () => void shutdown(130));

function emit(frame) {
  const value = { protocol_version: PROTOCOL_VERSION, generation, ...frame };
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > MAX_FRAME_BYTES) {
    const fallback = JSON.stringify({
      protocol_version: PROTOCOL_VERSION,
      generation,
      type: "fatal_error",
      request_id: frame.request_id ?? randomUUID(),
      code: "oversized_frame",
      message: "Wrapper output exceeded the protocol frame bound.",
      side_effect_certainty: querySideEffectCertainty(),
      query_state: queryInvocationState,
      query_invocation_count: queryInvocationCount,
    });
    process.stdout.write(`${fallback}\n`);
    fatal = true;
    return;
  }
  process.stdout.write(`${encoded}\n`);
}

async function receiveLine(line) {
  if (fatal || shuttingDown) return;
  if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES)
    return fail("oversized_frame", "Wrapper input exceeded the protocol frame bound.");
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return fail("malformed_frame", "Wrapper input was not valid JSON.");
  }
  try {
    validateEnvelope(frame);
    if (generation === null && frame.type === "initialize") generation = frame.generation;
    validateCommand(frame);
    if (seenRequests.has(frame.request_id))
      throw protocolError("duplicate_request", "A request ID was replayed.");
    seenRequests.add(frame.request_id);
    if (seenRequests.size > 4096)
      throw protocolError("request_ledger_exhausted", "The bounded request ledger is exhausted.");
    if (frame.type !== "initialize" && frame.generation !== generation)
      throw protocolError("stale_generation", "The request belongs to another wrapper generation.");
    switch (frame.type) {
      case "initialize":
        await initialize(frame);
        break;
      case "execute_turn":
        await executeTurn(frame);
        break;
      case "human_attention_response":
        humanAttentionResponse(frame);
        break;
      case "qe_complete_step_result":
        completeStepResult(frame);
        break;
      case "cancel_turn":
        await cancelTurn(frame);
        break;
      case "shutdown":
        emit({ type: "shutdown", request_id: frame.request_id, accepted: true });
        await shutdown(0);
        break;
      default:
        throw protocolError("unknown_frame", "The wrapper command type is unsupported.");
    }
  } catch (error) {
    fail(error.code ?? "protocol_error", safeMessage(error), frame?.request_id);
  }
}

function validateEnvelope(value) {
  if (!record(value) || value.protocol_version !== PROTOCOL_VERSION)
    throw protocolError("protocol_version_mismatch", "The wrapper protocol version is unsupported.");
  if (!token(value.type, 64) || !token(value.request_id, 128) || !token(value.generation, 128))
    throw protocolError("malformed_frame", "The wrapper command envelope is invalid.");
}

function validateCommand(value) {
  const common = ["protocol_version", "generation", "type", "request_id"];
  const fields =
    value.type === "initialize" ? [...common, "configuration"] :
    value.type === "execute_turn" ? [...common, "turn_id", "prompt", "continuation"] :
    value.type === "human_attention_response" ? [...common, "native_request_id", "attention_id", "response"] :
    value.type === "qe_complete_step_result" ? [...common, "tool_call_id", "accepted", "error_code"] :
    value.type === "cancel_turn" ? [...common, "turn_id"] :
    value.type === "shutdown" ? common : null;
  if (!fields || !exactKeys(value, fields))
    throw protocolError("malformed_frame", "The wrapper command failed strict schema validation.");
  if (value.type === "human_attention_response" && (!record(value.response) || !exactKeys(value.response, ["approved", "value"]) || !jsonValue(value.response.value)))
    throw protocolError("malformed_frame", "The HumanAttention response failed strict schema validation.");
}

async function initialize(frame) {
  if (initialized) throw protocolError("already_initialized", "The wrapper is already initialized.");
  const config = validateConfiguration(frame.configuration);
  generation = frame.generation;
  configuration = config;
  await mkdir(config.config_dir, { recursive: true, mode: 0o700 });
  await assertDirectory(config.workspace);
  await assertDirectory(config.config_dir);
  if (containsPath(config.workspace, config.config_dir) || containsPath(config.config_dir, config.workspace))
    throw protocolError("configuration_invalid", "Claude state and the Git workspace must be disjoint.");
  assertCredentialEnvironment();
  const provenance = await verifyRuntimeProvenance(config);
  initialized = true;

  if (config.backend === "fake") {
    const authenticated = config.fake.authenticated;
    emitReady(
      frame.request_id,
      provenance.runtimeSha256,
      authenticated ? "authenticated" : "authentication_required",
      config.fake.models.map((model) => ({
        id: model.id,
        account_availability: authenticated ? "verified_available" : "unknown",
        effort: [...model.effort],
      })),
    );
    return;
  }

  const auth = await localAuthenticationState(config);
  if (!auth.authenticated) {
    emitReady(
      frame.request_id,
      provenance.runtimeSha256,
      "authentication_required",
      config.runtime_models.map((model) => ({
        id: model.id,
        account_availability: "unknown",
        effort: [...model.effort],
      })),
    );
    return;
  }
  if (auth.authMethod !== "claude.ai")
    throw protocolError("authentication_required", "The configured Claude authentication is not a user-owned Claude subscription.");

  // Import and configure only local SDK/tool objects. sdk.query() is the
  // authorized execution boundary and is deliberately absent from initialize.
  sdk = await loadSdk(config);
  const qeTool = await completionTool(sdk, config);
  sdkOptionsPrepared = sdkOptions(sdk, config, qeTool);
  emitReady(
    frame.request_id,
    provenance.runtimeSha256,
    "authenticated",
    config.runtime_models.map((model) => ({
      id: model.id,
      account_availability: "unknown",
      effort: [...model.effort],
    })),
  );
}

function emitReady(requestId, runtimeSha256, authentication, models) {
  emit({
    type: "ready",
    request_id: requestId,
    wrapper_version: WRAPPER_VERSION,
    sdk_version: SDK_VERSION,
    claude_code_version: CLAUDE_CODE_VERSION,
    runtime_sha256: runtimeSha256,
    authentication,
    setup_available: true,
    streamed_process: "attached_only",
    query_state: "not_invoked",
    query_invocation_count: 0,
    models,
  });
}

async function executeTurn(frame) {
  requireInitialized();
  if (activeTurn) throw protocolError("turn_active", "Only one Claude turn may be active.");
  if (typeof frame.prompt !== "string" || encoder.encode(frame.prompt).byteLength > 384 * 1024)
    throw protocolError("malformed_frame", "The turn prompt is invalid or oversized.");
  if (!token(frame.turn_id, 128) || typeof frame.continuation !== "boolean")
    throw protocolError("malformed_frame", "The turn identity is invalid.");
  if (configuration.backend === "fake" && !configuration.fake.authenticated)
    throw protocolError("authentication_required", "Claude authentication is required before a model turn can execute.");
  if (queryInvocationState === "acknowledged" && !frame.continuation)
    throw protocolError("duplicate_query_start", "The Claude SDK query was already started for this wrapper generation.");
  if (
    queryInvocationState !== "acknowledged" &&
    frame.continuation &&
    !configuration.native_session_id
  )
    throw protocolError("query_not_started", "A corrective continuation requires an acknowledged query or an exact retained native session.");

  activeTurn = { requestId: frame.request_id, turnId: frame.turn_id, accepted: false, cancelled: false };
  completionAcknowledged = false;

  if (queryInvocationState === "not_invoked") {
    queryInvocationState = "requested";
    try {
      if (configuration.backend === "fake") {
        queryInvocationCount += 1;
        queryInvocationState = "acknowledged";
        emit({ type: "query_started", request_id: frame.request_id, turn_id: frame.turn_id, query_invocation_count: queryInvocationCount });
      } else {
        if (!sdk || !sdkOptionsPrepared)
          throw protocolError("runtime_incompatible", "The authenticated SDK configuration was not prepared locally.");
        sdkInput = asyncQueue();
        queryInvocationCount += 1;
        sdkQuery = sdk.query({ prompt: sdkInput.iterable, options: sdkOptionsPrepared });
        queryInvocationState = "acknowledged";
        emit({ type: "query_started", request_id: frame.request_id, turn_id: frame.turn_id, query_invocation_count: queryInvocationCount });
        sdkReader = consumeSdkMessages(sdkQuery).catch((error) => {
          fail("stream_lost", safeMessage(error));
        });
        const init = await sdkQuery.initializationResult();
        const models = normalizeModels(init.models);
        const exact = models.find((model) => model.id === configuration.model);
        if (!exact) throw protocolError("model_unavailable", "The exact scheduled Claude model is not supported by this authenticated runtime.");
        if (!exact.effort.includes(configuration.effort))
          throw protocolError("effort_unavailable", "The exact scheduled Claude effort is not supported by this model.");
      }
    } catch (error) {
      if (queryInvocationState === "requested") queryInvocationState = "uncertain";
      throw error;
    }
  }

  emit({ type: "native_activity", request_id: frame.request_id, turn_id: frame.turn_id, state: "working", activity: "submitting" });
  if (configuration.backend === "fake") {
    void runFakeTurn(frame, configuration.fake.turns.shift() ?? [{ type: "settle" }]).catch((error) =>
      fail(error.code ?? "wrapper_failure", safeMessage(error), frame.request_id),
    );
    return;
  }
  if (!sdkInput || !sdkQuery) throw protocolError("runtime_incompatible", "The authenticated SDK query is unavailable after acknowledgement.");
  activeTurn.accepted = true;
  sdkInput.push({
    type: "user",
    message: { role: "user", content: frame.prompt },
    parent_tool_use_id: null,
    uuid: frame.turn_id,
    client_composed: true,
  });
  emit({ type: "native_activity", request_id: frame.request_id, turn_id: frame.turn_id, state: "working", activity: "native_accepted" });
}

async function runFakeTurn(frame, script) {
  activeTurn.accepted = true;
  emit({ type: "native_activity", request_id: frame.request_id, turn_id: frame.turn_id, state: "working", activity: "native_accepted" });
  for (const action of script) {
    if (!activeTurn || activeTurn.cancelled) return;
    if (!record(action) || !token(action.type, 64))
      throw protocolError("fake_fixture_invalid", "The deterministic fake script is invalid.");
    if (action.type === "native_session") {
      nativeSessionId = token(action.session_id, 128) ? action.session_id : `fake-${randomUUID()}`;
      emit({ type: "native_session", request_id: frame.request_id, turn_id: frame.turn_id, session_id: nativeSessionId });
    } else if (action.type === "activity") {
      emit({ type: "native_activity", request_id: frame.request_id, turn_id: frame.turn_id, state: "working", activity: token(action.activity, 64) ? action.activity : "provider_activity" });
    } else if (action.type === "model") {
      assertExactModel(action.model);
    } else if (action.type === "effort") {
      assertExactEffort(action.effort);
    } else if (action.type === "tool") {
      const decision = enforceTool(action.name, action.input ?? {});
      emit({ type: "native_activity", request_id: frame.request_id, turn_id: frame.turn_id, state: "working", activity: "tool_invocation", tool: { capability: decision.capability, decision: decision.allowed ? "allow" : "deny" } });
      if (!decision.allowed)
        throw protocolError("tool_policy_violation", "Claude requested a tool outside the resolved QE policy.");
    } else if (action.type === "attention") {
      await requestAttention({
        nativeRequestId: token(action.native_request_id, 128) ? action.native_request_id : randomUUID(),
        category: allowedAttentionCategory(action.category) ? action.category : "needs_input",
        interaction: allowedInteraction(action.interaction) ? action.interaction : "text",
        message: safeAttentionMessage(action.message),
        responseSchema: jsonValue(action.response_schema) ? action.response_schema : undefined,
        toolUseId: token(action.tool_use_id, 128) ? action.tool_use_id : undefined,
      });
    } else if (action.type === "complete") {
      await requestCompletion(action.outputs);
    } else if (action.type === "usage") {
      emitUsage(frame, action);
    } else if (action.type === "fatal") {
      throw protocolError(token(action.code, 64) ? action.code : "provider_unavailable", safeMessage(action.message));
    } else if (action.type === "loss") {
      void shutdown(70);
      return;
    } else if (action.type === "settle") {
      settleTurn(frame, action.reason === "cancelled" ? "cancelled" : "completed", action.model ?? configuration.model, action.effort ?? configuration.effort);
      return;
    } else {
      throw protocolError("fake_fixture_invalid", "The deterministic fake action is unsupported.");
    }
  }
  settleTurn(frame, "completed", configuration.model, configuration.effort);
}

async function consumeSdkMessages(queryHandle) {
  for await (const message of queryHandle) {
    if (!activeTurn && message?.type !== "system") continue;
    const requestId = activeTurn?.requestId ?? randomUUID();
    const turnId = activeTurn?.turnId ?? "initialization";
    if (token(message?.session_id, 128) && message.session_id !== nativeSessionId) {
      nativeSessionId = message.session_id;
      emit({ type: "native_session", request_id: requestId, turn_id: turnId, session_id: nativeSessionId });
    }
    if (message?.type === "system" && message.subtype === "init") {
      if (message.claude_code_version !== CLAUDE_CODE_VERSION || message.cwd !== configuration.workspace)
        throw protocolError("runtime_incompatible", "Claude initialization provenance does not match the immutable execution configuration.");
      assertExactModel(message.model);
      assertExactEffort(message.effort);
      if (message.apiKeySource !== "none")
        throw protocolError("permission_denied", "Claude selected an API-key credential instead of the Run-private user subscription.");
      const expectedTools = new Set([...nativeTools(configuration.tools, configuration.workspace_access), "mcp__qe__qe_complete_step"]);
      const observedTools = Array.isArray(message.tools) ? new Set(message.tools) : null;
      if (!observedTools || observedTools.size !== expectedTools.size || [...observedTools].some((tool) => !expectedTools.has(tool)) || [...expectedTools].some((tool) => !observedTools.has(tool)))
        throw protocolError("tool_policy_violation", "Claude initialized a tool surface different from the exact QE policy.");
      if (!Array.isArray(message.mcp_servers) || !message.mcp_servers.some((server) => server?.name === "qe" && server?.status === "connected"))
        throw protocolError("runtime_incompatible", "The QE completion MCP server is not connected.");
      continue;
    }
    if (message?.type === "assistant") {
      assertExactModel(message.message?.model);
      emit({ type: "native_activity", request_id: requestId, turn_id: turnId, state: "working", activity: "provider_activity" });
      continue;
    }
    if (message?.type === "result") {
      for (const model of Object.keys(message.modelUsage ?? {})) assertExactModel(model);
      emitUsage({ request_id: requestId, turn_id: turnId }, { model_usage: message.modelUsage ?? {}, total_cost_usd: message.total_cost_usd ?? null, result_count: message.num_turns ?? 0 });
      settleTurn({ request_id: requestId, turn_id: turnId }, message.terminal_reason?.startsWith("aborted") ? "cancelled" : "completed", configuration.model, configuration.effort, message.terminal_reason ?? message.subtype);
    }
  }
  if (activeTurn) throw protocolError("stream_lost", "Claude SDK output ended before the active turn settled.");
}

async function completionTool(sdk, config) {
  const { z } = await import(config.zod_module);
  const definition = sdk.tool(
    "qe_complete_step",
    "Submit the declared Quest Engineering semantic Step outputs exactly once after the work is complete.",
    { outputs: z.record(z.string(), z.json()) },
    async ({ outputs }) => {
      const result = await requestCompletion(outputs);
      return { content: [{ type: "text", text: result.accepted ? "Quest Engineering accepted the semantic Step result." : "Quest Engineering rejected the semantic Step result." }], isError: !result.accepted };
    },
    { alwaysLoad: true },
  );
  return sdk.createSdkMcpServer({ name: "qe", version: WRAPPER_VERSION, tools: [definition], alwaysLoad: true });
}

function sdkOptions(_sdk, config, qeTool) {
  const builtins = nativeTools(config.tools, config.workspace_access);
  const deniedPaths = [
    config.config_dir,
    dirname(config.control_descriptor),
    "/home/agent/.pi",
    "/home/agent/.gemini",
    "/home/agent/.ssh",
    "/root",
    "/proc",
  ];
  return {
    cwd: config.workspace,
    pathToClaudeCodeExecutable: config.claude_executable,
    env: {
      HOME: config.config_dir,
      CLAUDE_CONFIG_DIR: config.config_dir,
      TMPDIR: config.temp_dir,
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      CLAUDE_AGENT_SDK_CLIENT_APP: `quest-engineering/${WRAPPER_VERSION}`,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
      CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_FEEDBACK_COMMAND: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
    },
    model: config.model,
    effort: config.effort,
    thinking: { type: "adaptive", display: "omitted" },
    tools: builtins,
    allowedTools: ["mcp__qe__qe_complete_step"],
    disallowedTools: ["Agent", "WebFetch", "WebSearch", "Skill", "NotebookEdit"],
    mcpServers: { qe: qeTool },
    strictMcpConfig: true,
    settingSources: [],
    skills: [],
    plugins: [],
    permissionMode: "default",
    permissionPrompts: "host",
    canUseTool: async (name, input, options) => {
      const decision = enforceTool(name, input);
      if (!decision.allowed) return { behavior: "deny", message: "QE resolved tool policy denied this invocation.", toolUseID: options.toolUseID };
      if (name === "AskUserQuestion") {
        const response = await requestAttention({ nativeRequestId: options.requestId, category: "needs_input", interaction: "choice", message: attentionMessageForQuestions(input), responseSchema: responseSchemaForQuestions(input), toolUseId: options.toolUseID });
        if (!response.approved || !record(response.value))
          return { behavior: "deny", message: "The exact QE HumanAttention request was declined or returned no structured answer.", toolUseID: options.toolUseID };
        return { behavior: "allow", updatedInput: { ...input, ...response.value }, toolUseID: options.toolUseID };
      }
      if (!options.requiresUserInteraction)
        return { behavior: "allow", toolUseID: options.toolUseID };
      const response = await requestAttention({ nativeRequestId: options.requestId, category: "needs_permission", interaction: "confirmation", message: "Claude requests permission for a coding action that requires human confirmation.", toolUseId: options.toolUseID });
      return response.approved
        ? { behavior: "allow", toolUseID: options.toolUseID }
        : { behavior: "deny", message: "The exact QE HumanAttention request was declined.", toolUseID: options.toolUseID };
    },
    hooks: {
      PreToolUse: [{ hooks: [async (input) => {
        assertHookEffort(input);
        const decision = enforceTool(input.tool_name, input.tool_input);
        emit({ type: "native_activity", request_id: activeTurn?.requestId ?? randomUUID(), turn_id: activeTurn?.turnId ?? "initialization", state: "working", activity: "tool_invocation", tool: { capability: decision.capability, decision: decision.allowed ? "allow" : "deny" } });
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision.allowed ? "allow" : "deny", permissionDecisionReason: decision.allowed ? "QE resolved tool policy allows this invocation." : "QE resolved tool policy denied this invocation." } };
      }] }],
      Stop: [{ hooks: [async (input) => { assertHookEffort(input); return {}; }] }],
      StopFailure: [{ hooks: [async (input) => { assertHookEffort(input); return {}; }] }],
      PreModelSwitch: [{ hooks: [async () => ({ hookSpecificOutput: { hookEventName: "PreModelSwitch", permissionDecision: "deny", permissionDecisionReason: "QE requires the exact scheduled model." } })] }],
      PostModelSwitch: [{ hooks: [async (input) => { assertExactModel(input.to_model); return {}; }] }],
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [], deniedDomains: ["*"], strictAllowlist: true, allowAllUnixSockets: false, allowLocalBinding: false },
      filesystem: { allowWrite: config.workspace_access === "read_write" ? [config.workspace] : [], denyWrite: deniedPaths, denyRead: deniedPaths },
      credentials: { files: deniedPaths.map((path) => ({ path, mode: "deny" })) },
    },
    settings: {
      disableClaudeAiConnectors: true,
      disableBundledSkills: true,
      permissions: {
        blockReadsOutsideWorkingDirectories: true,
        disableBypassPermissionsMode: "disable",
        deny: deniedPaths.flatMap((path) => [`Read(${path}/**)`, `Edit(${path}/**)`]),
      },
      includeGitInstructions: false,
      attribution: { commit: "", pr: "", sessionUrl: false },
    },
    resume: config.native_session_id ?? undefined,
    persistSession: true,
    promptSuggestions: false,
    agentProgressSummaries: false,
    includeHookEvents: true,
    includePartialMessages: false,
    verbatimPrompts: true,
  };
}

function humanAttentionResponse(frame) {
  const pending = pendingAttention.get(frame.native_request_id);
  if (!pending || pending.attentionId !== frame.attention_id)
    throw protocolError("stale_human_attention", "The HumanAttention response is stale or belongs to another native request.");
  if (!record(frame.response) || typeof frame.response.approved !== "boolean")
    throw protocolError("malformed_frame", "The HumanAttention response is invalid.");
  if (pending.responseSchema && frame.response.approved && !validChoiceResponse(frame.response.value, pending.responseSchema))
    throw protocolError("malformed_frame", "The HumanAttention choice response does not match the pending form.");
  pendingAttention.delete(frame.native_request_id);
  emit({
    type: "human_attention_resolved",
    request_id: activeTurn?.requestId ?? frame.request_id,
    turn_id: activeTurn?.turnId ?? "initialization",
    native_request_id: frame.native_request_id,
    attention_id: frame.attention_id,
  });
  pending.resolve({ approved: frame.response.approved, value: frame.response.value });
}

function completeStepResult(frame) {
  const pending = pendingCompletion.get(frame.tool_call_id);
  if (!pending) throw protocolError("stale_completion", "The completion acknowledgement is stale.");
  if (typeof frame.accepted !== "boolean")
    throw protocolError("malformed_frame", "The completion acknowledgement is invalid.");
  pendingCompletion.delete(frame.tool_call_id);
  if (frame.accepted) completionAcknowledged = true;
  pending.resolve({ accepted: frame.accepted, errorCode: token(frame.error_code, 64) ? frame.error_code : null });
}

async function requestAttention(input) {
  if (pendingAttention.has(input.nativeRequestId))
    return pendingAttention.get(input.nativeRequestId).promise;
  const attentionId = randomUUID();
  const pending = deferred();
  pending.attentionId = attentionId;
  pending.responseSchema = input.responseSchema;
  pendingAttention.set(input.nativeRequestId, pending);
  emit({
    type: "human_attention_request",
    request_id: activeTurn?.requestId ?? randomUUID(),
    turn_id: activeTurn?.turnId ?? "initialization",
    native_request_id: input.nativeRequestId,
    attention_id: attentionId,
    category: input.category,
    interaction: input.interaction,
    message: input.message,
    ...(input.responseSchema ? { response_schema: input.responseSchema } : {}),
    ...(input.toolUseId ? { tool_use_id: input.toolUseId } : {}),
  });
  return pending.promise;
}

async function requestCompletion(outputs) {
  if (!record(outputs) || !jsonValue(outputs))
    throw protocolError("invalid_step_result", "Completion outputs must be a JSON object.");
  const toolCallId = randomUUID();
  const pending = deferred();
  pendingCompletion.set(toolCallId, pending);
  emit({ type: "qe_complete_step", request_id: activeTurn?.requestId ?? randomUUID(), turn_id: activeTurn?.turnId ?? "initialization", tool_call_id: toolCallId, outputs });
  return pending.promise;
}

async function cancelTurn(frame) {
  requireInitialized();
  if (!activeTurn) {
    emit({ type: "turn_settled", request_id: frame.request_id, turn_id: frame.turn_id, outcome: "cancelled", completion_acknowledged: false, observed_model: configuration.model, effort_attestation: configuration.effort, cancellation: "already_settled" });
    return;
  }
  if (frame.turn_id !== activeTurn.turnId)
    throw protocolError("stale_turn", "Cancellation belongs to another native turn.");
  const activeRequestId = activeTurn.requestId;
  activeTurn.cancelled = true;
  if (sdkQuery) await sdkQuery.interrupt();
  for (const pending of pendingAttention.values()) pending.resolve({ approved: false, value: null });
  pendingAttention.clear();
  for (const pending of pendingCompletion.values()) pending.resolve({ accepted: false, errorCode: "execution_cancelled" });
  pendingCompletion.clear();
  settleTurn({ request_id: activeRequestId, turn_id: frame.turn_id }, "cancelled", configuration.model, configuration.effort);
}

function settleTurn(frame, outcome, model, effort, terminalReason = outcome) {
  assertExactModel(model);
  assertExactEffort(effort);
  emit({
    type: "turn_settled",
    request_id: frame.request_id,
    turn_id: frame.turn_id,
    outcome,
    terminal_reason: String(terminalReason).slice(0, 128),
    completion_acknowledged: completionAcknowledged,
    observed_model: model,
    effort_attestation: effort,
  });
  activeTurn = null;
}

function emitUsage(frame, value) {
  const usage = normalizeUsage(value.model_usage ?? value.modelUsage ?? {});
  emit({ type: "usage", request_id: frame.request_id, turn_id: frame.turn_id, models: usage, result_count: integer(value.result_count) ? value.result_count : 0, estimated_cost_usd: finite(value.total_cost_usd) ? value.total_cost_usd : null });
}

function normalizeUsage(value) {
  if (!record(value)) return [];
  return Object.entries(value).slice(0, 32).map(([model, item]) => {
    assertExactModel(model);
    const usage = record(item) ? item : {};
    return {
      model,
      input_tokens: natural(usage.inputTokens),
      output_tokens: natural(usage.outputTokens),
      cache_read_tokens: natural(usage.cacheReadInputTokens),
      cache_write_tokens: natural(usage.cacheCreationInputTokens),
      reasoning_tokens: natural(usage.thinkingTokens),
    };
  });
}

function enforceTool(name, input) {
  const capability = semanticCapability(name);
  const allowed =
    capability === "qe.completion" ||
    capability === "human_attention" ||
    (capability && configuration.tools.includes(capability));
  if (!allowed) return { allowed: false, capability: capability ?? "unknown" };
  if (["Read", "Edit", "Write", "Glob", "Grep"].includes(name) && !toolPathsInsideWorkspace(input))
    return { allowed: false, capability };
  if (["Edit", "Write"].includes(name) && configuration.workspace_access !== "read_write")
    return { allowed: false, capability };
  return { allowed: true, capability };
}

function semanticCapability(name) {
  if (name === "Bash") return "terminal.shell";
  if (["Read", "Edit", "Write"].includes(name)) return "workspace.filesystem";
  if (["Glob", "Grep"].includes(name)) return "workspace.search";
  if (name === "mcp__qe__qe_complete_step") return "qe.completion";
  if (name === "AskUserQuestion") return "human_attention";
  return null;
}

function nativeTools(tools, access) {
  const result = ["AskUserQuestion"];
  if (tools.includes("workspace.filesystem")) result.push("Read", ...(access === "read_write" ? ["Edit", "Write"] : []));
  if (tools.includes("workspace.search")) result.push("Glob", "Grep");
  if (tools.includes("terminal.shell")) result.push("Bash");
  return result;
}

function toolPathsInsideWorkspace(input) {
  if (!record(input)) return false;
  const paths = [input.file_path, input.path].filter((value) => typeof value === "string");
  return paths.every((path) => {
    const candidate = resolve(configuration.workspace, path);
    return containsPath(configuration.workspace, candidate);
  });
}

function assertHookEffort(input) {
  if (input?.effort?.level == null)
    throw protocolError("effort_unavailable", "Claude did not attest the exact scheduled effort.");
  assertExactEffort(input.effort.level);
}

function assertExactModel(value) {
  if (value !== configuration.model)
    throw protocolError("model_unavailable", "Claude observed a model different from the exact scheduled model.");
}

function assertExactEffort(value) {
  if (value !== configuration.effort)
    throw protocolError("effort_unavailable", "Claude observed an effort different from the exact scheduled effort.");
}

async function localAuthenticationState(config) {
  const credentialPath = resolve(config.config_dir, ".credentials.json");
  try {
    const metadata = await stat(credentialPath);
    if (!metadata.isFile()) return { authenticated: false, authMethod: "none" };
  } catch (error) {
    if (error.code === "ENOENT") return { authenticated: false, authMethod: "none" };
    throw error;
  }
  const result = await execFile(config.claude_executable, ["auth", "status"], {
    cwd: config.workspace,
    env: safeClaudeEnvironment(config),
    timeoutMs: 30000,
    maxBytes: 64 * 1024,
  });
  if (result.exitCode !== 0) return { authenticated: false, authMethod: "none" };
  let status;
  try { status = JSON.parse(result.stdout); } catch { throw protocolError("runtime_incompatible", "Claude auth status returned malformed JSON."); }
  if (!record(status) || typeof status.authMethod !== "string")
    throw protocolError("runtime_incompatible", "Claude auth status omitted its authentication method.");
  if (status.configDirectory && resolve(status.configDirectory) !== resolve(config.config_dir))
    throw protocolError("runtime_incompatible", "Claude auth status used a different configuration directory.");
  return { authenticated: status.authMethod !== "none", authMethod: status.authMethod };
}

function safeClaudeEnvironment(config) {
  return {
    HOME: config.config_dir,
    CLAUDE_CONFIG_DIR: config.config_dir,
    TMPDIR: config.temp_dir,
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    BROWSER: "/bin/false",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
  };
}

async function verifyRuntimeProvenance(config) {
  if (config.sdk_version !== SDK_VERSION || config.claude_code_version !== CLAUDE_CODE_VERSION || config.wrapper_version !== WRAPPER_VERSION)
    throw protocolError("runtime_incompatible", "The requested Claude artifacts do not match the pinned wrapper.");
  if (config.backend === "fake") return { runtimeSha256: config.runtime_sha256 };
  await access(config.claude_executable);
  const bytes = await readFile(config.claude_executable);
  const runtimeSha256 = createHash("sha256").update(bytes).digest("hex");
  if (runtimeSha256 !== config.runtime_sha256)
    throw protocolError("runtime_incompatible", "The Claude Code runtime digest does not match the immutable profile.");
  const sdkPackage = JSON.parse(await readFile(config.sdk_package_json, "utf8"));
  if (sdkPackage.version !== SDK_VERSION || sdkPackage.claudeCodeVersion !== CLAUDE_CODE_VERSION)
    throw protocolError("runtime_incompatible", "The Claude SDK package/runtime relationship is incompatible.");
  return { runtimeSha256 };
}

async function loadSdk(config) {
  const module = await import(pathToFileURL(config.sdk_module).href);
  if (typeof module.query !== "function" || typeof module.tool !== "function" || typeof module.createSdkMcpServer !== "function")
    throw protocolError("runtime_incompatible", "The pinned Claude SDK exports are incompatible with the QE wrapper.");
  return module;
}

function validateConfiguration(value) {
  if (!record(value)) throw protocolError("configuration_invalid", "Wrapper configuration is required.");
  const exact = [
    "backend", "wrapper_version", "sdk_version", "claude_code_version", "runtime_sha256",
    "claude_executable", "sdk_module", "sdk_package_json", "zod_module", "workspace", "workspace_access",
    "config_dir", "control_descriptor", "temp_dir", "model", "effort", "tools", "native_session_id",
    "runtime_models", "fake",
  ];
  if (!exactKeys(value, exact)) throw protocolError("configuration_invalid", "Wrapper configuration has unexpected fields.");
  if (!['sdk', 'fake'].includes(value.backend) || !token(value.wrapper_version, 32) || !token(value.sdk_version, 32) || !token(value.claude_code_version, 32))
    throw protocolError("configuration_invalid", "Wrapper artifact configuration is invalid.");
  for (const field of ["claude_executable", "sdk_module", "sdk_package_json", "zod_module", "workspace", "config_dir", "control_descriptor", "temp_dir"])
    if (typeof value[field] !== "string" || !isAbsolute(value[field])) throw protocolError("configuration_invalid", `Wrapper ${field} must be absolute.`);
  if (!/^[a-f0-9]{64}$/.test(value.runtime_sha256) || !token(value.model, 160) || !["low", "medium", "high", "xhigh", "max"].includes(value.effort))
    throw protocolError("configuration_invalid", "Wrapper model, effort, or runtime digest is invalid.");
  if (!['none', 'read_only', 'read_write'].includes(value.workspace_access) || !Array.isArray(value.tools) || !value.tools.every((tool) => ["workspace.filesystem", "workspace.search", "terminal.shell"].includes(tool)) || new Set(value.tools).size !== value.tools.length)
    throw protocolError("configuration_invalid", "Wrapper tool policy is invalid.");
  if (value.native_session_id !== null && !token(value.native_session_id, 128))
    throw protocolError("configuration_invalid", "Wrapper native session identity is invalid.");
  const runtimeModels = validateModels(value.runtime_models);
  const fake = validateFake(value.fake, value.backend);
  return { ...value, runtime_models: runtimeModels, fake };
}

function validateModels(value) {
  if (!Array.isArray(value) || value.length > 64) throw protocolError("configuration_invalid", "Runtime model evidence is invalid.");
  return value.map((model) => {
    if (!record(model) || !exactKeys(model, ["id", "effort"]) || !token(model.id, 160) || !Array.isArray(model.effort) || !model.effort.every((level) => ["low", "medium", "high", "xhigh", "max"].includes(level)))
      throw protocolError("configuration_invalid", "Runtime model evidence is invalid.");
    return { id: model.id, effort: [...new Set(model.effort)] };
  });
}

function validateFake(value, backend) {
  if (backend === "sdk") {
    if (value !== null) throw protocolError("configuration_invalid", "Fake configuration is forbidden for the SDK backend.");
    return null;
  }
  if (!record(value) || !exactKeys(value, ["authenticated", "models", "turns"]) || typeof value.authenticated !== "boolean" || !Array.isArray(value.turns) || value.turns.length > 64)
    throw protocolError("configuration_invalid", "Deterministic fake configuration is invalid.");
  return { authenticated: value.authenticated, models: validateModels(value.models), turns: structuredClone(value.turns) };
}

function normalizeModels(models) {
  if (!Array.isArray(models)) return [];
  return models.flatMap((model) => {
    const id = typeof model?.resolvedModel === "string" ? model.resolvedModel : model?.value;
    if (!token(id, 160)) return [];
    return [{ id, effort: Array.isArray(model.supportedEffortLevels) ? model.supportedEffortLevels.filter((level) => ["low", "medium", "high", "xhigh", "max"].includes(level)) : [] }];
  });
}

function assertCredentialEnvironment() {
  const forbidden = [
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "AZURE_CLIENT_SECRET", "GITHUB_TOKEN", "GH_TOKEN",
  ];
  const present = forbidden.filter((name) => typeof process.env[name] === "string" && process.env[name] !== "" && process.env[name] !== "none");
  if (present.length) throw protocolError("permission_denied", "Ambient provider or host credentials are forbidden in the Claude wrapper.");
}

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopInput();
  sdkInput?.close();
  try { sdkQuery?.close(); } catch {}
  try { await Promise.race([sdkReader ?? Promise.resolve(), new Promise((resolve) => setTimeout(resolve, 2000))]); } catch {}
  process.exitCode = process.exitCode ?? code;
  await new Promise((resolve) => process.stdout.write("", resolve));
  process.exit(process.exitCode);
}

function fail(code, message, requestId = activeTurn?.requestId ?? randomUUID()) {
  emit({
    type: "fatal_error",
    request_id: requestId,
    code: token(code, 64) ? code : "wrapper_failure",
    message: String(message).slice(0, 320),
    side_effect_certainty: querySideEffectCertainty(),
    query_state: queryInvocationState,
    query_invocation_count: queryInvocationCount,
  });
  fatal = true;
  stopInput();
  sdkInput?.close();
  try { sdkQuery?.close(); } catch {}
  process.exitCode = 70;
  process.stdout.write("", () => process.exit(70));
}

function querySideEffectCertainty() {
  if (activeTurn?.accepted) return "native_accepted";
  if (queryInvocationState === "acknowledged") return "submitted";
  if (queryInvocationState === "requested" || queryInvocationState === "uncertain") return "ambiguous";
  return "not_submitted";
}

function stopInput() {
  if (inputStopped) return;
  inputStopped = true;
  process.stdin.pause();
  process.stdin.removeAllListeners("data");
  process.stdin.removeAllListeners("end");
}

function execFile(executable, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let exceeded = false;
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(protocolError("provider_unavailable", "Claude local status command timed out.")); }, options.timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); if (Buffer.byteLength(stdout) > options.maxBytes) { exceeded = true; child.kill("SIGTERM"); } });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); if (Buffer.byteLength(stderr) > options.maxBytes) { exceeded = true; child.kill("SIGTERM"); } });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (exitCode) => { clearTimeout(timer); exceeded ? reject(protocolError("runtime_incompatible", "Claude local status output exceeded its bound.")) : resolvePromise({ exitCode: exitCode ?? 1, stdout, stderr }); });
  });
}

function asyncQueue() {
  const values = [];
  const waiters = [];
  let closed = false;
  return {
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (values.length) return Promise.resolve({ value: values.shift(), done: false });
            if (closed) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolveNext) => waiters.push(resolveNext));
          },
        };
      },
    },
    push(value) {
      if (closed) throw protocolError("stream_lost", "Claude SDK input is closed.");
      const waiter = waiters.shift();
      if (waiter) waiter({ value, done: false }); else values.push(value);
    },
    close() {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
    },
  };
}

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolveValue) => { resolvePromise = resolveValue; });
  return { promise, resolve: resolvePromise };
}

function requireInitialized() {
  if (!initialized || !configuration) throw protocolError("not_initialized", "The wrapper has not been initialized.");
}
function protocolError(code, message) { return Object.assign(new Error(message), { code }); }
function safeMessage(value) { return value instanceof Error ? value.message : typeof value === "string" ? value : "Claude wrapper operation failed."; }
function safeAttentionMessage(value) { return typeof value === "string" && value.trim() ? value.trim().slice(0, 240) : "Claude requires human input."; }
function attentionMessageForQuestions(input) {
  if (!record(input) || !Array.isArray(input.questions) || input.questions.length === 0)
    return "Claude requires structured human input.";
  const summaries = input.questions.slice(0, 4).flatMap((question) =>
    record(question) && typeof question.question === "string"
      ? [question.question.trim()]
      : [],
  );
  return safeAttentionMessage(summaries.join(" ") || "Claude requires structured human input.");
}
function responseSchemaForQuestions(input) {
  if (!record(input) || !Array.isArray(input.questions))
    throw protocolError("tool_policy_violation", "Claude AskUserQuestion input is malformed.");
  const questions = input.questions.slice(0, 4).map((question, index) => {
    if (!record(question) || typeof question.question !== "string" || typeof question.header !== "string" || !Array.isArray(question.options))
      throw protocolError("tool_policy_violation", "Claude AskUserQuestion input is malformed.");
    const header = question.header.trim().slice(0, 48) || `question_${index + 1}`;
    const options = question.options.slice(0, 8).map((option) => {
      if (!record(option) || typeof option.label !== "string")
        throw protocolError("tool_policy_violation", "Claude AskUserQuestion options are malformed.");
      return {
        label: option.label.trim().slice(0, 80),
        description: typeof option.description === "string" ? option.description.trim().slice(0, 160) : "",
      };
    });
    if (!options.length || options.some((option) => !option.label))
      throw protocolError("tool_policy_violation", "Claude AskUserQuestion requires bounded labeled options.");
    return {
      id: `q${index + 1}`,
      header,
      question: question.question.trim().slice(0, 240),
      multi_select: question.multiSelect === true,
      options,
    };
  });
  if (!questions.length || new Set(questions.map((question) => question.header)).size !== questions.length)
    throw protocolError("tool_policy_violation", "Claude AskUserQuestion requires distinct bounded question headers.");
  return { kind: "choice_form_v1", questions };
}
function validChoiceResponse(value, schema) {
  if (!record(value) || !record(value.answers) || schema.kind !== "choice_form_v1" || !Array.isArray(schema.questions)) return false;
  const expected = schema.questions.map((question) => question.header);
  if (!exactKeys(value, ["answers"]) || !exactKeys(value.answers, expected)) return false;
  return schema.questions.every((question) => {
    const answer = value.answers[question.header];
    const labels = new Set(question.options.map((option) => option.label));
    return question.multi_select
      ? Array.isArray(answer) && answer.length > 0 && answer.every((item) => labels.has(item))
      : typeof answer === "string" && labels.has(answer);
  });
}
function allowedAttentionCategory(value) { return ["needs_input", "needs_permission", "needs_authentication", "needs_confirmation", "blocked_external"].includes(value); }
function allowedInteraction(value) { return ["confirmation", "text", "choice", "multiline_response"].includes(value); }
function record(value) { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function token(value, max) { return typeof value === "string" && value.length > 0 && value.length <= max && /^[a-zA-Z0-9._:@/+\-]+$/.test(value); }
function integer(value) { return Number.isSafeInteger(value) && value >= 0; }
function natural(value) { return integer(value) ? value : 0; }
function finite(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function exactKeys(value, expected) { const actual = Object.keys(value).sort(); const wanted = [...expected].sort(); return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]); }
function containsPath(root, candidate) { const rel = relative(resolve(root), resolve(candidate)); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); }
function jsonValue(value, depth = 0) { if (depth > 16) return false; if (value === null || typeof value === "string" || typeof value === "boolean") return true; if (typeof value === "number") return Number.isFinite(value); if (Array.isArray(value)) return value.length <= 512 && value.every((item) => jsonValue(item, depth + 1)); return record(value) && Object.keys(value).length <= 128 && Object.values(value).every((item) => jsonValue(item, depth + 1)); }
async function assertDirectory(path) { const metadata = await stat(path); if (!metadata.isDirectory()) throw protocolError("configuration_invalid", `${path} is not a directory.`); }
