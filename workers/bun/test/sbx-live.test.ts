import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { SbxExecutionEnvironmentBackend } from "../src/execution-environment/sbx-backend.ts";
import { sbxSpec } from "./sbx-support.ts";

const live = process.env.QE_LIVE_SBX === "1";

test.skipIf(!live)(
  "live disposable SBX proves lifecycle, isolation, private Docker, exec, and PTY launcher",
  async () => {
    const parent = join(process.cwd(), ".pi", "tmp");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "sbx-live-"));
    const backend = new SbxExecutionEnvironmentBackend({
      workerId: "worker-sbx-test",
      dataRoot: root,
      reconciliationPollMs: 500,
      reconciliationAttempts: 120,
    });
    let ref: Awaited<ReturnType<typeof backend.ensure>>["ref"] | null = null;
    try {
      const readiness = await backend.readiness();
      expect(readiness).toMatchObject({ status: "ready", ready: true });
      const spec = sbxSpec(`live-${Date.now()}`);
      const lease = await backend.ensure(spec);
      ref = lease.ref;
      expect(await backend.inspect(ref)).toMatchObject({
        state: "running",
        usable: true,
        capabilities: expect.arrayContaining([
          { kind: "filesystem_namespace", mode: "isolated" },
          { kind: "home", mode: "private" },
          { kind: "container_runtime", mode: "isolated" },
          { kind: "network_policy", mode: "deny_all" },
        ]),
      });
      const exec = await lease.exec({
        executable: "/usr/bin/python3",
        args: [
          "-c",
          "import json,os,pathlib; print(json.dumps({'cwd':str(pathlib.Path.cwd()),'home':os.environ['HOME']}))",
        ],
        cwd: lease.paths.workspace,
        timeoutMs: 30_000,
      });
      expect(exec.exitCode).toBe(0);
      expect(JSON.parse(exec.stdout)).toEqual({
        cwd: lease.paths.workspace,
        home: lease.paths.home,
      });

      const descriptor = await lease.launcher({
        executable: "/bin/sh",
        args: [
          "-lc",
          "stty size; test -t 0; echo qe-tty-in=$?; test -t 1; echo qe-tty-out=$?; true",
        ],
        cwd: lease.paths.workspace,
      });
      const pty = Bun.spawn(
        [
          "/usr/bin/script",
          "-q",
          "/dev/null",
          descriptor.executable,
          ...descriptor.args,
        ],
        {
          cwd: descriptor.cwd,
          env: { ...process.env, ...descriptor.environment },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(pty.stdout).text(),
        new Response(pty.stderr).text(),
        pty.exited,
      ]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(stdout).toMatch(/(?:24 80|[1-9]\d* [1-9]\d*)/);
      expect(stdout).toContain("qe-tty-in=0");
      expect(stdout).toContain("qe-tty-out=0");

      await backend.stop(ref);
      expect(await backend.inspect(ref)).toMatchObject({
        state: "stopped",
        usable: false,
      });
      expect((await backend.recover(ref, spec)).ref).toEqual(ref);
    } finally {
      if (ref) await backend.remove(ref).catch(() => undefined);
      backend.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  12 * 60_000,
);
