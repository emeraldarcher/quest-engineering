import { Buffer } from "node:buffer";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { DispatchRegistry } from "../../src/dispatch/registry.ts";
import {
  SBX_CLAUDE_AGENT_SDK_VERSION,
  SBX_CLAUDE_CODE_VERSION,
  SBX_CLAUDE_LINUX_ARM64_SHA256,
  SBX_CLAUDE_WRAPPER_VERSION,
} from "../../src/execution-environment/sbx-profile.ts";
import type { PreparedSbxHarnessSetup } from "../../src/execution-environment/sbx-run.ts";
import type {
  EnvironmentCommandResult,
  EnvironmentLease,
  EnvironmentRef,
  StreamedProcess,
  StreamedProcessCommand,
  StreamedProcessExit,
  StreamedProcessStreamEvent,
} from "../../src/execution-environment/types.ts";
import { HarnessSetupCoordinator } from "../../src/harness-setup.ts";
import { HarnessSetupStore } from "../../src/harness-setup-store.ts";
import { ClaudeAgentSdkAdapter } from "../../src/harnesses/claude-agent-sdk/adapter.ts";
import { HarnessRegistry } from "../../src/harnesses/registry.ts";
import { decodePrepareHarnessSetup } from "../../src/protocol/codec.ts";
import { CLAUDE_FORBIDDEN_AUTH_SELECTOR_NAMES } from "../../src/provider-auth.ts";

const [encoded, workerId, rawGeneration] = process.argv.slice(2);
if (!encoded || !workerId || !rawGeneration)
  throw new Error("encoded payload, Worker ID, and generation are required");
const generation = Number(rawGeneration);
if (!Number.isInteger(generation) || generation <= 0)
  throw new Error("generation must be a positive integer");

const payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
const command = decodePrepareHarnessSetup(payload, workerId, generation);
if (command.setup.harness_kind !== "claude_agent_sdk")
  throw new Error("Claude setup command required");

const root = await mkdtemp(
  join(process.cwd(), ".pi/tmp/product-claude-setup-launch-"),
);
const store = new HarnessSetupStore(root);
const registry = new DispatchRegistry(
  join(root, "dispatches.sqlite"),
  root,
  "claude_agent_sdk",
);
const configDirectory =
  "/qe/state/claude-lineages/fake-product-boundary/config";
const setupWorkingDirectory = "/qe/workspaces/default";
const privateWorkspace = "/qe/workspaces/fake-product-boundary";
const runtimeExecutable =
  "/opt/qe/pi/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude";
const environment: EnvironmentRef = {
  backendKind: "sbx",
  environmentId: "fake-setup-environment",
  incarnation: "fake-setup-incarnation",
  workerId,
  owner: { kind: "run", runId: command.setup.run_id },
  profile: { ...command.setup.profile },
};
const processFixture = createFakeGuestProcess(environment, runtimeExecutable);
let physicalLaunchCount = 0;
const launchCapture: { command: StreamedProcessCommand | null } = {
  command: null,
};

const lease = {
  ref: environment,
  paths: {
    workspace: setupWorkingDirectory,
    state: "/qe/state",
    control: "/qe/control",
    home: "/home/agent",
    cache: "/home/agent/.cache",
    temp: "/tmp/qe",
  },
  capabilities: [{ kind: "process.streamed", mode: "attached_only" }],
  exec: async (): Promise<EnvironmentCommandResult> => ({
    exitCode: 1,
    stdout: JSON.stringify({
      loggedIn: false,
      authMethod: "none",
      apiProvider: "firstParty",
      analyticsDisabled: true,
      projectsDirectory: `${configDirectory}/projects`,
      configDirectory,
    }),
    stderr: "",
  }),
  spawnStreamed: async (candidate: StreamedProcessCommand) => {
    physicalLaunchCount += 1;
    launchCapture.command = structuredClone(candidate);
    return processFixture.process;
  },
} as unknown as EnvironmentLease;
const prepared: PreparedSbxHarnessSetup = {
  lease,
  workspace: {
    paths: { workspace: privateWorkspace },
  } as PreparedSbxHarnessSetup["workspace"],
  setupWorkingDirectory,
  claude: {
    runtimeExecutable,
    runtimeSha256: SBX_CLAUDE_LINUX_ARM64_SHA256,
    sdkModule: "/opt/qe/pi/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
    sdkPackageJson:
      "/opt/qe/pi/node_modules/@anthropic-ai/claude-agent-sdk/package.json",
    zodModule: "/opt/qe/pi/node_modules/zod/index.js",
    sdkVersion: SBX_CLAUDE_AGENT_SDK_VERSION,
    claudeCodeVersion: SBX_CLAUDE_CODE_VERSION,
    wrapperVersion: SBX_CLAUDE_WRAPPER_VERSION,
    configDirectory,
    controlDescriptor: "/qe/control/fake/descriptor.json",
  },
  configIdentity: "fake-product-boundary-config-identity",
};
const manager = {
  prepareHarnessSetup: async () => prepared,
  discoverClaude: async () => ({
    installed: true,
    authenticated: false,
    setupAvailable: true,
    models: [],
    diagnostics: ["fake setup boundary"],
  }),
  retireStreamedProcesses: async () => undefined,
};
const adapter = new ClaudeAgentSdkAdapter(
  {
    workerId,
    dataRoot: root,
    executorModels: [{ provider: "anthropic", model: "claude-sonnet-5" }],
    reasoningLevels: ["high"],
  } as never,
  manager as never,
);
const reports: Array<{
  state: string;
  invocationState: string;
  ephemeral?: string;
}> = [];
const coordinator = new HarnessSetupCoordinator(
  store,
  registry,
  new HarnessRegistry([adapter]),
  async (record, ephemeral) => {
    reports.push({
      state: record.state,
      invocationState: record.invocationState,
      ...(ephemeral ? { ephemeral } : {}),
    });
  },
);

try {
  await coordinator.prepare(command);
  const acknowledged = store.get(command.setup.setup_id);
  await processFixture.emit(
    "Open https://example.invalid/anthropic-fixture and enter TEST-ONLY-CODE\n",
  );
  await eventually(() => reports.some((report) => Boolean(report.ephemeral)));
  const durableSetupFiles = (await readdir(root)).filter((name) =>
    name.startsWith("harness-setups.sqlite"),
  );
  const durableContainsFixtureOutput = (
    await Promise.all(
      durableSetupFiles.map((name) => readFile(join(root, name))),
    )
  ).some((bytes) => bytes.includes("TEST-ONLY-CODE"));
  const launchedCommand = launchCapture.command;
  const environmentNames = Object.keys(
    launchedCommand?.environment ?? {},
  ).sort();
  const forbiddenEnvironmentNames = environmentNames.filter((name) =>
    (CLAUDE_FORBIDDEN_AUTH_SELECTOR_NAMES as readonly string[]).includes(name),
  );
  const beforeCleanup = {
    state: acknowledged.state,
    invocationState: acknowledged.invocationState,
    physicalLaunchCount,
    launchedCommand: launchedCommand
      ? {
          executable: launchedCommand.executable,
          args: [...launchedCommand.args],
          cwd: launchedCommand.cwd,
          environmentNames,
        }
      : null,
    privateWorkspace,
    setupWorkingDirectory,
    forbiddenEnvironmentNames,
    reportStates: reports.map((report) => report.state),
    humanAttentionCount: reports.filter(
      (report) => report.state === "human_interaction_required",
    ).length,
    ephemeralOutputObserved: reports.some((report) =>
      report.ephemeral?.includes("TEST-ONLY-CODE"),
    ),
    durableContainsFixtureOutput,
    processIdentity: processFixture.process.handle,
  };
  await coordinator.invalidateRun(command.setup.run_id);
  const afterCleanup = {
    state: store.get(command.setup.setup_id).state,
    cancelCount: processFixture.cancelCount,
    processRunning: processFixture.running,
  };
  process.stdout.write(
    `${JSON.stringify({ decoded: command, beforeCleanup, afterCleanup })}\n`,
  );
} finally {
  coordinator.close();
  registry.close();
  await rm(root, { recursive: true, force: true });
}

function createFakeGuestProcess(
  environment: EnvironmentRef,
  executable: string,
) {
  const stdout = createEventQueue();
  const stderr = createEventQueue();
  let running = true;
  let cancelCount = 0;
  let sequence = 0;
  let settleExit!: (exit: StreamedProcessExit) => void;
  const handle = {
    contractVersion: 1 as const,
    backendKind: environment.backendKind,
    environment: structuredClone(environment),
    backendProcessId: "fixture-pid-1",
    processStartIdentity: "fixture-start-1",
    processGeneration: crypto.randomUUID(),
    executable,
    observedExecutable: executable,
  };
  const exit = new Promise<StreamedProcessExit>((resolve) => {
    settleExit = resolve;
  });
  const process: StreamedProcess = {
    handle,
    stdout,
    stderr,
    exit,
    write: async (data) => ({
      certainty: "acknowledged",
      writeId: crypto.randomUUID(),
      byteLength: data.byteLength,
    }),
    closeStdin: async () => ({
      certainty: "acknowledged",
      writeId: crypto.randomUUID(),
      byteLength: 0,
    }),
    cancel: async () => {
      cancelCount += 1;
      if (running) {
        running = false;
        stdout.end();
        stderr.end();
        settleExit({ kind: "signaled", signal: "SIGTERM" });
      }
      return {
        certainty: "acknowledged",
        cancellationId: crypto.randomUUID(),
      };
    },
    inspect: async () => ({
      handle,
      process: running ? ("running" as const) : ("exited" as const),
      streamAttachment: "attached" as const,
      streamRecovery: "current_worker_only" as const,
    }),
    observeIo: async () => ({ status: "unavailable", reason: "unsupported" }),
    disconnect: async () => undefined,
  };
  return {
    process,
    get running() {
      return running;
    },
    get cancelCount() {
      return cancelCount;
    },
    async emit(value: string): Promise<void> {
      sequence += 1;
      stdout.push({
        kind: "data",
        sequence,
        data: new TextEncoder().encode(value),
      });
      await Promise.resolve();
    },
  };
}

function createEventQueue(): AsyncIterable<StreamedProcessStreamEvent> & {
  push(value: StreamedProcessStreamEvent): void;
  end(): void;
} {
  const values: StreamedProcessStreamEvent[] = [];
  const waiters: Array<
    (value: IteratorResult<StreamedProcessStreamEvent>) => void
  > = [];
  let ended = false;
  return {
    push(value) {
      const waiter = waiters.shift();
      if (waiter) waiter({ done: false, value });
      else values.push(value);
    },
    end() {
      if (ended) return;
      ended = true;
      for (const waiter of waiters.splice(0))
        waiter({ done: true, value: undefined });
    },
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          const value = values.shift();
          if (value) return Promise.resolve({ done: false, value });
          if (ended) return Promise.resolve({ done: true, value: undefined });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(2);
  }
  throw new Error("fake setup launch did not reach the expected state");
}
