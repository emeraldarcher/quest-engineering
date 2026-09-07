import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  InMemoryCredentialStore,
  type Model,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import humanAssistanceExtension from "../src/providers/pi/human-assistance-extension.ts";
import { writeControlAtomic } from "../src/providers/pi/result-envelope.ts";
import { action } from "./support.ts";

const roots: string[] = [];
const originalResultPath = process.env.QE_RESULT_CONTROL_PATH;
const originalAttentionPath = process.env.QE_ATTENTION_CONTROL_PATH;
const originalRecoveryPath = process.env.QE_RECOVERY_CONTROL_PATH;

afterEach(async () => {
  if (originalResultPath === undefined)
    delete process.env.QE_RESULT_CONTROL_PATH;
  else process.env.QE_RESULT_CONTROL_PATH = originalResultPath;
  if (originalAttentionPath === undefined)
    delete process.env.QE_ATTENTION_CONTROL_PATH;
  else process.env.QE_ATTENTION_CONTROL_PATH = originalAttentionPath;
  if (originalRecoveryPath === undefined)
    delete process.env.QE_RECOVERY_CONTROL_PATH;
  else process.env.QE_RECOVERY_CONTROL_PATH = originalRecoveryPath;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test.serial(
  "Pi yields one automated run, exposes ordinary multi-turn chat, and resumes the same session",
  async () => {
    const parent = join(process.cwd(), ".pi", "tmp");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "pi-yield-runtime-"));
    roots.push(root);
    const resultControlPath = join(root, "result-control.json");
    const attentionControlPath = join(root, "attention-control.json");
    const resultDirectory = join(root, "results");
    const executeAction = action();
    await writeControlAtomic(resultControlPath, {
      protocolVersion: 1,
      workerId: executeAction.worker_id,
      lineageId: "lineage-same",
      action: executeAction,
      nonce: "result-nonce",
      resultDirectory,
    });
    process.env.QE_RESULT_CONTROL_PATH = resultControlPath;
    process.env.QE_ATTENTION_CONTROL_PATH = attentionControlPath;
    process.env.QE_RECOVERY_CONTROL_PATH = join(root, "recovery-control.json");

    const faux = fauxProvider({
      api: `qe-yield-${crypto.randomUUID()}`,
      provider: `qe-yield-${crypto.randomUUID()}`,
    });
    const modelRuntime = await ModelRuntime.create({
      allowModelNetwork: false,
      refreshOnCreate: false,
      credentials: new InMemoryCredentialStore(),
    });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.setRuntimeApiKey(faux.provider.id, "faux-key");
    const contexts: string[][] = [];
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("qe_request_human_assistance", {
          category: "needs_input",
          message: "Choose the filename and discuss the task.",
          interaction: "conversational_intervention",
        }),
        { stopReason: "toolUse" },
      ),
      (context) => {
        contexts.push(context.messages.map(messageText));
        return fauxAssistantMessage(
          fauxText("I stopped because you need to choose the filename."),
        );
      },
      (context) => {
        contexts.push(context.messages.map(messageText));
        return fauxAssistantMessage(
          fauxText("Yes. The public API remains unchanged."),
        );
      },
      (context) => {
        contexts.push(context.messages.map(messageText));
        return fauxAssistantMessage(fauxText("Automation resumed."));
      },
    ]);

    const first = await sessionFixture(root, modelRuntime, faux.getModel());
    const sessionId = first.session.sessionId;
    const events: string[] = [];
    first.session.subscribe((event) => {
      if (["agent_start", "agent_end", "agent_settled"].includes(event.type))
        events.push(event.type);
    });

    await first.session.prompt("Begin QE automation.");
    const yielded = await attentionRecord(attentionControlPath);
    expect(yielded).toMatchObject({
      version: 2,
      state: "requested",
      interaction: "conversational_intervention",
      piSessionId: sessionId,
      identity: {
        lineageId: "lineage-same",
        actionId: executeAction.action_id,
        attemptId: executeAction.attempt_id,
      },
    });
    expect(first.session.isStreaming).toBe(false);
    expect(events).toEqual(["agent_start", "agent_end", "agent_settled"]);

    // A different Pi session sees the same file but cannot hand this checkpoint back.
    const wrong = await sessionFixture(root, modelRuntime, faux.getModel());
    await wrong.session.prompt("/qe-resume");
    expect((await attentionRecord(attentionControlPath)).state).toBe(
      "requested",
    );
    wrong.session.dispose();

    const staleAction = action({
      action_id: "action-stale",
      attempt_id: "attempt-stale",
    });
    await writeControlAtomic(resultControlPath, {
      protocolVersion: 1,
      workerId: staleAction.worker_id,
      lineageId: "lineage-same",
      action: staleAction,
      nonce: "stale-nonce",
      resultDirectory,
    });
    await first.session.prompt("/qe-resume");
    expect((await attentionRecord(attentionControlPath)).state).toBe(
      "requested",
    );
    await writeControlAtomic(resultControlPath, {
      protocolVersion: 1,
      workerId: executeAction.worker_id,
      lineageId: "lineage-same",
      action: executeAction,
      nonce: "result-nonce",
      resultDirectory,
    });

    // These are ordinary user prompts, not extension input/editor dialogs.
    await first.session.prompt("Why did you stop?");
    await first.session.prompt(
      "Use human-picked.txt. Does that preserve the public API?",
    );
    expect((await attentionRecord(attentionControlPath)).state).toBe(
      "requested",
    );
    expect(first.session.sessionId).toBe(sessionId);
    expect(first.session.isStreaming).toBe(false);

    await first.session.prompt("/qe-resume");
    await first.session.waitForIdle();
    const resumed = await attentionRecord(attentionControlPath);
    expect(resumed).toMatchObject({
      state: "resolved",
      handedBackAt: expect.any(String),
      automationResumedAt: expect.any(String),
    });
    expect(JSON.stringify(resumed)).not.toContain("human-picked.txt");
    expect(JSON.stringify(resumed)).not.toContain("Why did you stop?");
    expect(first.session.sessionId).toBe(sessionId);
    expect(contexts.at(-1)?.join("\n")).toContain("human-picked.txt");
    expect(contexts.at(-1)?.join("\n")).toContain(
      "Resume the Quest Engineering task from the current session state.",
    );
    expect(faux.getPendingResponseCount()).toBe(0);
    first.session.dispose();
    modelRuntime.unregisterProvider(faux.provider.id);
  },
);

test.serial(
  "/qe-retry writes one stable recovery request without mutating the failed Action",
  async () => {
    const parent = join(process.cwd(), ".pi", "tmp");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "pi-retry-runtime-"));
    roots.push(root);
    const resultControlPath = join(root, "result-control.json");
    const recoveryControlPath = join(root, "recovery-control.json");
    const executeAction = action();
    await writeControlAtomic(resultControlPath, {
      protocolVersion: 1,
      workerId: executeAction.worker_id,
      lineageId: "retained-lineage",
      action: executeAction,
      nonce: "failed-result-nonce",
      resultDirectory: join(root, "results"),
    });
    process.env.QE_RESULT_CONTROL_PATH = resultControlPath;
    process.env.QE_ATTENTION_CONTROL_PATH = join(
      root,
      "attention-control.json",
    );
    process.env.QE_RECOVERY_CONTROL_PATH = recoveryControlPath;

    const faux = fauxProvider({
      api: `qe-retry-${crypto.randomUUID()}`,
      provider: `qe-retry-${crypto.randomUUID()}`,
    });
    const modelRuntime = await ModelRuntime.create({
      allowModelNetwork: false,
      refreshOnCreate: false,
      credentials: new InMemoryCredentialStore(),
    });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.setRuntimeApiKey(faux.provider.id, "faux-key");
    const fixture = await sessionFixture(root, modelRuntime, faux.getModel());

    await fixture.session.prompt("/qe-resume");
    await fixture.session.prompt("/qe-retry");
    const first = await attentionRecord(recoveryControlPath);
    expect(first).toMatchObject({
      version: 1,
      state: "requested",
      identity: {
        actionId: executeAction.action_id,
        occurrenceId: executeAction.occurrence_id,
        attemptId: executeAction.attempt_id,
      },
      lineageId: "retained-lineage",
      piSessionId: fixture.session.sessionId,
    });
    await fixture.session.prompt("/qe-retry");
    const repeated = await attentionRecord(recoveryControlPath);
    expect(repeated.requestId).toBe(first.requestId);
    expect(repeated.identity).toEqual(first.identity);

    fixture.session.dispose();
    modelRuntime.unregisterProvider(faux.provider.id);
  },
);

async function sessionFixture(
  root: string,
  modelRuntime: ModelRuntime,
  model: Model<string>,
) {
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    settingsManager: settings,
    extensionFactories: [humanAssistanceExtension],
    systemPromptOverride: () => "Deterministic QE intervention test.",
  });
  await loader.reload();
  return createAgentSession({
    cwd: root,
    agentDir: join(root, "agent"),
    model,
    modelRuntime,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(root),
    settingsManager: settings,
    tools: ["qe_request_human_assistance"],
    noTools: "builtin",
  });
}

async function attentionRecord(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

function messageText(message: { content: unknown }): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter(
      (item): item is { type: "text"; text: string } =>
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        item.type === "text" &&
        "text" in item &&
        typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}
