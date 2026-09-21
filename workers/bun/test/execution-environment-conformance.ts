import { expect, test } from "bun:test";
import type {
  EnvironmentCommand,
  EnvironmentCommandResult,
  EnvironmentLease,
  EnvironmentSpec,
  ExecutionEnvironmentBackend,
  HostLaunchDescriptor,
} from "../src/execution-environment/types.ts";

export interface ExecutionEnvironmentConformanceFixture {
  backend: ExecutionEnvironmentBackend;
  primarySpec: EnvironmentSpec;
  secondarySpec: EnvironmentSpec;
  command(label: string): EnvironmentCommand;
  expectedResult(label: string): EnvironmentCommandResult;
  containerRuntimeMode?: string | null;
  recoverStartsStopped?: boolean;
  pathsAreNamespaceLocal?: boolean;
  specMismatchCode?: string;
  assertLauncher?(
    descriptor: HostLaunchDescriptor,
    lease: EnvironmentLease,
    requested: EnvironmentCommand,
  ): void;
}

export interface ExecutionEnvironmentConformanceContext {
  fixture: ExecutionEnvironmentConformanceFixture;
  primary: EnvironmentLease;
  secondary: EnvironmentLease;
}

export interface ExecutionEnvironmentConformanceExtensions {
  filesystemIsolation?: EnvironmentConformanceExtension;
  privateHome?: EnvironmentConformanceExtension;
  privateGit?: EnvironmentConformanceExtension;
  pty?: EnvironmentConformanceExtension;
  networkPolicy?: EnvironmentConformanceExtension;
  credentials?: EnvironmentConformanceExtension;
  isolatedContainerRuntime?: EnvironmentConformanceExtension;
  workerRestartAdoption?: EnvironmentConformanceExtension;
}

type EnvironmentConformanceExtension = (
  context: ExecutionEnvironmentConformanceContext,
) => Promise<void>;

/** Reusable contract suite. Optional physical proofs run only when supplied. */
export function executionEnvironmentConformance(
  name: string,
  create: () =>
    | ExecutionEnvironmentConformanceFixture
    | Promise<ExecutionEnvironmentConformanceFixture>,
  extensions: ExecutionEnvironmentConformanceExtensions = {},
): void {
  test(`${name} environment conformance: readiness and capabilities`, async () => {
    const { backend, containerRuntimeMode = "unavailable" } = await create();
    const readiness = await backend.readiness();
    expect(readiness.backendKind).toBe(backend.kind);
    expect(readiness.status).toBe("ready");
    expect(readiness.ready).toBe(true);
    expect(readiness.provenance.contractVersion).toBe(1);
    expect(readiness.capabilities.length).toBeGreaterThan(0);
    if (containerRuntimeMode !== null)
      expect(
        readiness.capabilities.find(
          (capability) => capability.kind === "container_runtime",
        )?.mode,
      ).toBe(containerRuntimeMode);
  });

  test(`${name} environment conformance: ensure is exact and idempotent`, async () => {
    const {
      backend,
      primarySpec,
      specMismatchCode = "incompatible_environment_spec",
    } = await create();
    const [first, second] = await Promise.all([
      backend.ensure(primarySpec),
      backend.ensure(structuredClone(primarySpec)),
    ]);
    expect(second.ref).toEqual(first.ref);
    expect(second.paths).toEqual(first.paths);

    const incompatible = structuredClone(primarySpec);
    incompatible.profile.digest = "sha256:incompatible";
    await expect(backend.ensure(incompatible)).rejects.toMatchObject({
      code: specMismatchCode,
      operation: "ensure",
    });
  });

  test(`${name} environment conformance: recover requires exact ref and spec`, async () => {
    const {
      backend,
      primarySpec,
      specMismatchCode = "incompatible_environment_spec",
    } = await create();
    const lease = await backend.ensure(primarySpec);
    expect((await backend.recover(lease.ref, primarySpec)).ref).toEqual(
      lease.ref,
    );

    const incompatible = structuredClone(primarySpec);
    incompatible.resourcePolicy.digest = "sha256:other-policy";
    await expect(
      backend.recover(lease.ref, incompatible),
    ).rejects.toMatchObject({
      code: specMismatchCode,
      operation: "recover",
    });
    await expect(
      backend.recover(
        { ...lease.ref, incarnation: `${lease.ref.incarnation}-stale` },
        primarySpec,
      ),
    ).rejects.toMatchObject({
      code: "stale_environment_ref",
      operation: "recover",
    });
  });

  test(`${name} environment conformance: inspect, stop, and remove`, async () => {
    const fixture = await create();
    const { backend, primarySpec } = fixture;
    const lease = await backend.ensure(primarySpec);
    expect(await backend.inspect(lease.ref)).toMatchObject({
      ref: lease.ref,
      state: "running",
      usable: true,
      paths: lease.paths,
    });

    await backend.stop(lease.ref);
    expect(await backend.inspect(lease.ref)).toMatchObject({
      state: "stopped",
      usable: false,
    });
    if (fixture.recoverStartsStopped) {
      expect((await backend.recover(lease.ref, primarySpec)).ref).toEqual(
        lease.ref,
      );
    } else {
      await expect(
        backend.recover(lease.ref, primarySpec),
      ).rejects.toMatchObject({
        code: "environment_not_usable",
      });
    }

    const restarted = await backend.ensure(primarySpec);
    expect(restarted.ref).toEqual(lease.ref);
    await backend.remove(lease.ref);
    await backend.remove(lease.ref);
    await expect(backend.inspect(lease.ref)).rejects.toMatchObject({
      code: "stale_environment_ref",
    });
    await expect(backend.recover(lease.ref, primarySpec)).rejects.toMatchObject(
      {
        code: "stale_environment_ref",
      },
    );
  });

  test(`${name} environment conformance: replacement fences stale incarnations`, async () => {
    const { backend, primarySpec, command } = await create();
    const first = await backend.ensure(primarySpec);
    await backend.remove(first.ref);
    const replacement = await backend.ensure(primarySpec);
    expect(replacement.ref.environmentId).not.toBe(first.ref.environmentId);
    expect(replacement.ref.incarnation).not.toBe(first.ref.incarnation);
    expect(replacement.ref.runId).toBe(first.ref.runId);

    await expect(backend.inspect(first.ref)).rejects.toMatchObject({
      code: "stale_environment_ref",
    });
    await expect(backend.recover(first.ref, primarySpec)).rejects.toMatchObject(
      {
        code: "stale_environment_ref",
      },
    );
    await expect(first.exec(command("stale"))).rejects.toMatchObject({
      code: "stale_environment_ref",
    });
  });

  test(`${name} environment conformance: launcher carries exact provenance`, async () => {
    const fixture = await create();
    const { backend, primarySpec, command } = fixture;
    const lease = await backend.ensure(primarySpec);
    const requested = command("launcher");
    const descriptor = await lease.launcher(requested);
    expect(descriptor.executable.length).toBeGreaterThan(0);
    if (fixture.assertLauncher)
      fixture.assertLauncher(descriptor, lease, requested);
    else expect(descriptor.cwd).toBe(requested.cwd ?? lease.paths.workspace);
    expect(descriptor.io).toBe("pty");
    expect(descriptor.provenance).toMatchObject({
      kind: "execution_environment",
      ref: lease.ref,
      profile: primarySpec.profile,
    });
    if (descriptor.provenance.launcher)
      expect(descriptor.provenance.launcher).toMatchObject({
        contractVersion: 1,
        runtimeExecutable: descriptor.executable,
        entrypoint: expect.stringContaining("sbx-launcher.ts"),
        entrypointSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
  });

  test(`${name} environment conformance: noninteractive exec`, async () => {
    const { backend, primarySpec, command, expectedResult } = await create();
    const lease = await backend.ensure(primarySpec);
    expect(await lease.exec(command("exec"))).toEqual(expectedResult("exec"));
  });

  test(`${name} environment conformance: concurrent Run environments stay distinct`, async () => {
    const fixture = await create();
    const { backend, primarySpec, secondarySpec, command, expectedResult } =
      fixture;
    const [primary, secondary] = await Promise.all([
      backend.ensure(primarySpec),
      backend.ensure(secondarySpec),
    ]);
    expect(primary.ref.runId).not.toBe(secondary.ref.runId);
    expect(primary.ref.environmentId).not.toBe(secondary.ref.environmentId);
    if (!fixture.pathsAreNamespaceLocal)
      expect(primary.paths.workspace).not.toBe(secondary.paths.workspace);

    const [primaryResult, secondaryResult] = await Promise.all([
      primary.exec(command("primary")),
      secondary.exec(command("secondary")),
    ]);
    expect(primaryResult).toEqual(expectedResult("primary"));
    expect(secondaryResult).toEqual(expectedResult("secondary"));
  });

  registerExtension("filesystem isolation", extensions.filesystemIsolation);
  registerExtension("private HOME", extensions.privateHome);
  registerExtension("private Git", extensions.privateGit);
  registerExtension("PTY", extensions.pty);
  registerExtension("network policy", extensions.networkPolicy);
  registerExtension("credentials", extensions.credentials);
  registerExtension(
    "isolated container runtime",
    extensions.isolatedContainerRuntime,
  );
  registerExtension(
    "Worker restart adoption",
    extensions.workerRestartAdoption,
  );

  function registerExtension(
    extensionName: string,
    assertion: EnvironmentConformanceExtension | undefined,
  ): void {
    if (!assertion) return;
    test(`${name} environment conformance extension: ${extensionName}`, async () => {
      const fixture = await create();
      const [primary, secondary] = await Promise.all([
        fixture.backend.ensure(fixture.primarySpec),
        fixture.backend.ensure(fixture.secondarySpec),
      ]);
      await assertion({ fixture, primary, secondary });
    });
  }
}
