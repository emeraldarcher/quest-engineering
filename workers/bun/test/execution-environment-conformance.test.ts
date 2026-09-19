import { expect, test } from "bun:test";
import { join } from "node:path";
import { FakeExecutionEnvironmentBackend } from "../src/execution-environment/fake.ts";
import { HostNativeExecutionEnvironmentBackend } from "../src/execution-environment/host-native.ts";
import type {
  EnvironmentBackendOperation,
  EnvironmentCommand,
  EnvironmentCommandResult,
  EnvironmentPathMap,
  EnvironmentSpec,
} from "../src/execution-environment/types.ts";
import { executionEnvironmentConformance } from "./execution-environment-conformance.ts";

executionEnvironmentConformance("Fake", () => ({
  backend: new FakeExecutionEnvironmentBackend(),
  primarySpec: spec("run-primary"),
  secondarySpec: spec("run-secondary"),
  command,
  expectedResult,
}));

executionEnvironmentConformance("HostNative", () => ({
  backend: hostNative(),
  primarySpec: spec("run-primary"),
  secondarySpec: spec("run-secondary"),
  command,
  expectedResult,
}));

test("Fake environment backend never fabricates continuity across instances", async () => {
  const first = await new FakeExecutionEnvironmentBackend().ensure(
    spec("run-backend-restart"),
  );
  const second = await new FakeExecutionEnvironmentBackend().ensure(
    spec("run-backend-restart"),
  );
  expect(second.ref.environmentId).not.toBe(first.ref.environmentId);
  expect(second.ref.incarnation).not.toBe(first.ref.incarnation);
});

test("Fake environment backend rejects unavailable required capabilities", async () => {
  const backend = new FakeExecutionEnvironmentBackend();
  const required = spec("run-requirement");
  required.requiredCapabilities = [
    { kind: "container_runtime", mode: "isolated" },
  ];
  await expect(backend.ensure(required)).rejects.toMatchObject({
    code: "environment_requirements_unmet",
    operation: "ensure",
  });
});

test("Fake environment backend injects each operation failure once", async () => {
  const backend = new FakeExecutionEnvironmentBackend();
  backend.failNext("readiness");
  await expect(backend.readiness()).rejects.toMatchObject({
    code: "injected_failure",
    operation: "readiness",
  });
  expect((await backend.readiness()).ready).toBe(true);

  backend.failNext("ensure");
  await expect(backend.ensure(spec("run-failures"))).rejects.toMatchObject({
    code: "injected_failure",
    operation: "ensure",
  });
  const lease = await backend.ensure(spec("run-failures"));

  for (const operation of ["recover", "inspect"] as const) {
    backend.failNext(operation);
    await expect(
      operation === "recover"
        ? backend.recover(lease.ref, spec("run-failures"))
        : backend.inspect(lease.ref),
    ).rejects.toMatchObject({ code: "injected_failure", operation });
  }
  expect((await backend.inspect(lease.ref)).state).toBe("running");

  for (const operation of ["launcher", "exec"] as const) {
    backend.failNext(operation);
    await expect(
      operation === "launcher"
        ? lease.launcher(command(operation))
        : lease.exec(command(operation)),
    ).rejects.toMatchObject({ code: "injected_failure", operation });
  }
  expect(await lease.exec(command("after-failure"))).toEqual(
    expectedResult("after-failure"),
  );

  await injectedLifecycleFailure(backend, lease.ref, "stop");
  expect((await backend.inspect(lease.ref)).state).toBe("running");
  await backend.stop(lease.ref);
  await backend.ensure(spec("run-failures"));
  await injectedLifecycleFailure(backend, lease.ref, "remove");
  expect((await backend.inspect(lease.ref)).state).toBe("running");
});

test("Fake environment backend keeps exec history per incarnation", async () => {
  const backend = new FakeExecutionEnvironmentBackend();
  const first = await backend.ensure(spec("run-history-1"));
  const second = await backend.ensure(spec("run-history-2"));
  await Promise.all([
    first.exec(command("first")),
    second.exec(command("second")),
  ]);
  expect(backend.executions(first.ref)).toEqual([command("first")]);
  expect(backend.executions(second.ref)).toEqual([command("second")]);
});

test("HostNative maps current host paths and direct launch without side effects", async () => {
  const backend = hostNative();
  const environmentSpec = spec("run-current-host");
  const lease = await backend.ensure(environmentSpec);
  expect(lease.paths).toEqual(paths(environmentSpec));
  expect(lease.capabilities).toContainEqual({
    kind: "container_runtime",
    mode: "unavailable",
  });

  const descriptor = await lease.launcher({
    executable: "/bin/echo",
    args: ["direct"],
    cwd: process.cwd(),
    environment: { COMMAND_VALUE: "command" },
  });
  expect(descriptor).toMatchObject({
    executable: "/bin/echo",
    args: ["direct"],
    cwd: process.cwd(),
    environment: {
      HOST_NATIVE_COMPATIBILITY: "1",
      COMMAND_VALUE: "command",
    },
    io: "pty",
  });
  expect(
    await lease.exec({
      executable: "/bin/sh",
      args: ["-c", 'printf "%s" "$HOST_NATIVE_COMPATIBILITY"'],
      cwd: process.cwd(),
    }),
  ).toEqual({ exitCode: 0, stdout: "1", stderr: "" });
});

async function injectedLifecycleFailure(
  backend: FakeExecutionEnvironmentBackend,
  ref: Parameters<FakeExecutionEnvironmentBackend["stop"]>[0],
  operation: Extract<EnvironmentBackendOperation, "stop" | "remove">,
): Promise<void> {
  backend.failNext(operation);
  await expect(
    operation === "stop" ? backend.stop(ref) : backend.remove(ref),
  ).rejects.toMatchObject({ code: "injected_failure", operation });
}

function hostNative(): HostNativeExecutionEnvironmentBackend {
  return new HostNativeExecutionEnvironmentBackend({
    workerId: "worker-conformance",
    pathsFor: paths,
    paneEnvironmentFor: () => ({ HOST_NATIVE_COMPATIBILITY: "1" }),
  });
}

function paths(environmentSpec: EnvironmentSpec): EnvironmentPathMap {
  const root = join(
    process.cwd(),
    ".pi",
    "test-environments",
    environmentSpec.runId,
  );
  const home = process.env.HOME ?? process.cwd();
  return {
    workspace: join(root, "workspace"),
    state: join(root, "state"),
    control: join(root, "control"),
    home,
    cache: join(home, ".cache"),
    temp: process.env.TMPDIR ?? "/tmp",
  };
}

function command(label: string): EnvironmentCommand {
  return {
    executable: "/bin/echo",
    args: [label],
    cwd: process.cwd(),
  };
}

function expectedResult(label: string): EnvironmentCommandResult {
  return { exitCode: 0, stdout: `${label}\n`, stderr: "" };
}

function spec(runId: string): EnvironmentSpec {
  return {
    workerId: "worker-conformance",
    runId,
    workspace: {
      workspaceId: `workspace-${runId}`,
      projectId: "project-conformance",
      access: "read_write",
      materialization: {
        kind: "existing_workspace",
        sourceIdentity: "repository:example/project",
        frozenBase: {
          kind: "git_commit",
          value: "0123456789abcdef0123456789abcdef01234567",
        },
      },
    },
    profile: {
      id: "qe-execution-v1",
      digest: "sha256:profile-v1",
    },
    resourcePolicy: {
      id: "qe-default",
      digest: "sha256:resource-policy-v1",
    },
    networkRequirements: [
      { capability: "qe_control", targets: ["worker-control"] },
      { capability: "model_provider", targets: ["configured-provider"] },
    ],
    credentialGrants: [
      { grantId: "pi-auth", kind: "model_provider", scope: "pi" },
    ],
    controlChannels: [{ kind: "harness_control", required: true }],
    requiredCapabilities: [],
  };
}
