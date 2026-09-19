import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { DispatchRegistry } from "../src/dispatch/registry.ts";
import {
  controlDescriptorPath,
  HarnessControlAuthority,
} from "../src/harnesses/control/authority.ts";
import { HarnessControlClient } from "../src/harnesses/control/client.ts";
import { collectStepResult } from "../src/harnesses/control/result-envelope.ts";
import { HarnessControlServer } from "../src/harnesses/control/server.ts";
import { action } from "./support.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function createFixture(maxStopEnforcements = 2) {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "harness-control-"));
  const registry = new DispatchRegistry(
    join(root, "dispatches.sqlite"),
    root,
    "fake",
  );
  const authority = new HarnessControlAuthority(registry, maxStopEnforcements);
  const server = new HarnessControlServer(authority);
  await server.start();
  cleanups.push(async () => {
    await server.stop();
    registry.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, registry, authority, server };
}

async function bind(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  input = action(),
) {
  const accepted = fixture.registry.accept(input).dispatch;
  if (!accepted.lineageId) throw new Error("fixture has no lineage");
  fixture.registry.occupy(accepted.lineageId, input.action_id);
  const lineage = fixture.registry.getLineage(accepted.lineageId);
  await fixture.authority.bind(accepted, lineage);
  return {
    dispatch: accepted,
    lineage,
    client: new HarnessControlClient(controlDescriptorPath(lineage)),
  };
}

test("one generic bridge validates and records a structured Step result", async () => {
  const value = await createFixture();
  const { client, dispatch } = await bind(value);
  expect(
    await client.completeStep({ change_set: { files: 2 } }, "result-1"),
  ).toMatchObject({
    accepted: true,
    completed: true,
  });
  expect((await collectStepResult(dispatch)).envelope.outputs).toEqual({
    change_set: { files: 2 },
  });
  await expect(
    client.completeStep({ change_set: {} }, "result-2"),
  ).rejects.toMatchObject({
    code: "replayed_request",
  });
});

test("invalid output sets never become successful completion", async () => {
  const value = await createFixture();
  const { client, dispatch } = await bind(value);
  let code: unknown = null;
  try {
    await client.completeStep({ wrong: true });
  } catch (error) {
    code = (error as { code?: unknown }).code;
  }
  expect(code).toBe("invalid_step_result");
  await expect(collectStepResult(dispatch)).rejects.toThrow(
    "without a structured",
  );
});

test("same request is idempotent while a new completion request is rejected", async () => {
  const value = await createFixture();
  const { client } = await bind(value);
  await client.completeStep({ change_set: true }, "same-request");
  expect(
    await client.completeStep({ change_set: true }, "same-request"),
  ).toMatchObject({
    duplicate: true,
    completed: true,
  });
  await expect(
    client.completeStep({ change_set: true }, "replay"),
  ).rejects.toMatchObject({
    code: "replayed_request",
  });
});

test("new Attempt binding invalidates the old context on a retained lineage", async () => {
  const value = await createFixture();
  const first = await bind(value);
  const stalePath = join(value.root, "stale-control.json");
  await writeFile(
    stalePath,
    await Bun.file(controlDescriptorPath(first.lineage)).text(),
  );
  value.registry.fail(first.dispatch.action.action_id, { reason: "test" });
  const nextAction = action({
    action_id: "action-2",
    attempt_id: "attempt-2",
    occurrence_id: "occurrence-1",
    operational_recovery: {
      epoch_number: 1,
      attempt_in_epoch: 1,
      attempt_allowance: 1,
      authorization_kind: "human",
      continuation_mode: "retained",
      retained_lineage_id: first.lineage.lineageId,
      source_attempt_id: "attempt-1",
      request_id: "request-1",
    },
  });
  nextAction.execution.context.logical_lineage_id =
    first.lineage.logicalLineageId;
  const second = await bind(value, nextAction);
  await expect(
    new HarnessControlClient(stalePath).completeStep({ change_set: true }),
  ).rejects.toMatchObject({
    code: "unknown_control_context",
  });
  expect(await second.client.completeStep({ change_set: true })).toMatchObject({
    completed: true,
  });
});

test("concurrent lineages are isolated and cannot use guessed or cross-generation credentials", async () => {
  const value = await createFixture();
  const first = await bind(
    value,
    action({
      action_id: "action-a",
      occurrence_id: "occ-a",
      attempt_id: "attempt-a",
    }),
  );
  const second = await bind(
    value,
    action({
      action_id: "action-b",
      occurrence_id: "occ-b",
      attempt_id: "attempt-b",
    }),
  );
  await first.client.completeStep({ change_set: "a" });
  await second.client.completeStep({ change_set: "b" });
  expect((await collectStepResult(first.dispatch)).envelope.outputs).toEqual({
    change_set: "a",
  });
  expect((await collectStepResult(second.dispatch)).envelope.outputs).toEqual({
    change_set: "b",
  });

  const descriptor = JSON.parse(
    await Bun.file(controlDescriptorPath(first.lineage)).text(),
  );
  descriptor.contextToken = `${"0".repeat(64)}`;
  const wrongToken = join(value.root, "wrong-token.json");
  await writeFile(wrongToken, JSON.stringify(descriptor));
  await expect(
    new HarnessControlClient(wrongToken).completionStatus(),
  ).rejects.toMatchObject({ code: "unknown_control_context" });

  descriptor.contextToken = JSON.parse(
    await Bun.file(controlDescriptorPath(first.lineage)).text(),
  ).contextToken;
  descriptor.bridgeGeneration = crypto.randomUUID();
  const wrongGeneration = join(value.root, "wrong-generation.json");
  await writeFile(wrongGeneration, JSON.stringify(descriptor));
  await expect(
    new HarnessControlClient(wrongGeneration).completionStatus(),
  ).rejects.toMatchObject({ code: "bridge_generation_mismatch" });
});

test("semantic completion rejection is correctable and does not consume omission enforcement", async () => {
  const value = await createFixture(1);
  const { client } = await bind(value);

  let completionError: unknown;
  try {
    await client.completeStep({ wrong: true });
  } catch (error) {
    completionError = error;
  }
  expect(completionError).toMatchObject({
    kind: "semantic_validation",
    code: "invalid_step_result",
  });
  const firstStop = (await client.nativeStop("model_stop", true)).nativeStop;
  expect(firstStop).toMatchObject({
    decision: "continue",
    cause: "completion_semantic_validation",
  });
  expect(firstStop && "enforcementAttempt" in firstStop).toBe(false);
  const secondStop = (await client.nativeStop("model_stop", true)).nativeStop;
  expect(secondStop).toMatchObject({
    decision: "continue",
    cause: "completion_semantic_validation",
  });
  expect(secondStop && "enforcementAttempt" in secondStop).toBe(false);
  await expect(
    client.completeStep({ change_set: true }),
  ).resolves.toMatchObject({
    completed: true,
  });
});

test("reported completion infrastructure failure preserves work without consuming omission enforcement", async () => {
  const value = await createFixture(0);
  const { client } = await bind(value);
  await client.reportCompletionFailure({
    kind: "infrastructure",
    code: "bridge_timeout",
    message: "The completion response was not observable.",
  });

  const stop = (await client.nativeStop("model_stop", true)).nativeStop;
  expect(stop).toMatchObject({
    decision: "continue",
    cause: "completion_infrastructure",
  });
  expect(stop && "enforcementAttempt" in stop).toBe(false);
});

test("ambiguous response loss reconciles status without replaying completion", async () => {
  const value = await createFixture();
  const bound = await bind(value);
  const goodDescriptor = JSON.parse(
    await Bun.file(controlDescriptorPath(bound.lineage)).text(),
  );
  const stablePath = join(value.root, "rotating-control.json");
  let received = 0;
  const responseLossServer = createServer((socket) => {
    socket.once("data", async () => {
      received += 1;
      await writeFile(stablePath, JSON.stringify(goodDescriptor));
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    responseLossServer.once("error", reject);
    responseLossServer.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) =>
        responseLossServer.close((error) =>
          error ? reject(error) : resolve(),
        ),
      ),
  );
  const address = responseLossServer.address();
  if (!address || typeof address === "string")
    throw new Error("response-loss server has no port");
  await writeFile(
    stablePath,
    JSON.stringify({
      ...goodDescriptor,
      endpoint: { ...goodDescriptor.endpoint, port: address.port },
    }),
  );

  let failure: unknown;
  try {
    await new HarnessControlClient(stablePath).completeStep({
      change_set: true,
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    kind: "infrastructure",
    code: "invalid_bridge_response",
  });
  expect(received).toBe(1);
  expect(await bound.client.completionStatus()).toMatchObject({
    completed: false,
  });
});

test("a retained client follows atomic descriptor rotation while copied credentials stay fenced", async () => {
  const value = await createFixture();
  const bound = await bind(value);
  const stalePath = join(value.root, "copied-control.json");
  await writeFile(
    stalePath,
    await Bun.file(controlDescriptorPath(bound.lineage)).text(),
  );

  await value.authority.bind(
    bound.dispatch,
    value.registry.getLineage(bound.lineage.lineageId),
  );

  await expect(bound.client.completionStatus()).resolves.toMatchObject({
    completed: false,
  });
  await expect(
    new HarnessControlClient(stalePath).completionStatus(),
  ).rejects.toMatchObject({ code: "unknown_control_context" });
});

test("attention and native Stop enforcement share the same bound authority", async () => {
  const value = await createFixture(2);
  const { client } = await bind(value);
  const requested = await client.requestHumanAssistance({
    category: "needs_input",
    message: "Choose the required deployment region.",
    interaction: "confirmation",
  });
  expect(requested.attention).toMatchObject({ category: "needs_input" });
  await client.resolveHumanAssistance(
    requested.attention?.attentionId as string,
    "completed",
  );

  expect(
    (await client.nativeStop("model_stop", true)).nativeStop,
  ).toMatchObject({
    decision: "continue",
    cause: "completion_omitted",
    enforcementAttempt: 1,
  });
  expect(
    (await client.nativeStop("model_stop", true)).nativeStop,
  ).toMatchObject({
    decision: "continue",
    cause: "completion_omitted",
    enforcementAttempt: 2,
  });
  expect(
    (await client.nativeStop("model_stop", true)).nativeStop,
  ).toMatchObject({ decision: "contract_violation", enforcementAttempt: 3 });
  await client.completeStep({ change_set: true });
  expect((await client.nativeStop("model_stop", true)).nativeStop).toEqual({
    decision: "allow",
  });
});

test("native Stop preserves a legitimately pending HumanAttention Attempt", async () => {
  const value = await createFixture(0);
  const { client, lineage, dispatch } = await bind(value);
  const requested = await client.requestHumanAssistance({
    category: "needs_permission",
    message: "Approve the native permission prompt.",
  });
  expect((await client.nativeStop("NO_TOOL_CALL", true)).nativeStop).toEqual({
    decision: "allow",
  });
  expect(value.registry.getLineage(lineage.lineageId)).toMatchObject({
    sessionState: "waiting_for_human",
    attention: { attentionId: requested.attention?.attentionId },
    activeActionId: dispatch.action.action_id,
  });
});

test("Stop preserves work when completion infrastructure is unavailable", async () => {
  const value = await createFixture();
  const bound = await bind(value);
  await value.server.stop();
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(
        import.meta.dir,
        "..",
        "src",
        "harnesses",
        "control",
        "bridge-cli.ts",
      ),
      "hook",
      "stop",
    ],
    {
      env: {
        ...process.env,
        QE_HARNESS_CONTROL_PATH: controlDescriptorPath(bound.lineage),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  child.stdin.write(
    JSON.stringify({ terminationReason: "model_stop", fullyIdle: true }),
  );
  child.stdin.end();
  const [stdout, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  expect(exitCode).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({
    decision: "continue",
    reason: expect.stringContaining("infrastructure"),
  });
});

test("bridge restart rejects the old controller generation and rebinds active work", async () => {
  const value = await createFixture();
  const bound = await bind(value);
  const stalePath = join(value.root, "pre-restart-control.json");
  await writeFile(
    stalePath,
    await Bun.file(controlDescriptorPath(bound.lineage)).text(),
  );
  await value.server.stop();

  const restartedAuthority = new HarnessControlAuthority(value.registry);
  const restartedServer = new HarnessControlServer(restartedAuthority);
  await restartedServer.start();
  cleanups.push(() => restartedServer.stop());
  await restartedAuthority.bind(
    bound.dispatch,
    value.registry.getLineage(bound.lineage.lineageId),
  );

  await expect(
    new HarnessControlClient(stalePath).completionStatus(),
  ).rejects.toMatchObject({ code: "bridge_unavailable" });
  expect(
    await new HarnessControlClient(
      controlDescriptorPath(bound.lineage),
    ).completionStatus(),
  ).toMatchObject({ completed: false });
});
