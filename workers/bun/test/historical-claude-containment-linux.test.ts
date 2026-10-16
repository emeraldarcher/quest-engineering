import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { DETACHED_PROCESS_CANCELLATION_PROGRAM } from "../src/execution-environment/sbx-detached-process.ts";

// This is a provider-free physical proof. It runs only on Linux, launches a
// disposable local Python sleeper, and exercises the same pidfd helper used by
// the one-time SBX controller. It never opens Worker/Product state.
test.skipIf(process.platform !== "linux")(
  "disposable process is identity-fenced, signalled once by pidfd, and settles",
  async () => {
    const parent = join(process.cwd(), ".pi", "tmp");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "containment-pidfd-live-"));
    const marker = join(root, "ownership-marker.json");
    await writeFile(marker, '{"owner":"synthetic-containment-test"}', {
      mode: 0o600,
    });
    const markerDigest = createHash("sha256")
      .update(await readFile(marker))
      .digest("hex");
    const child = Bun.spawn({
      cmd: ["/usr/bin/python3", "-c", "import time; time.sleep(120)"],
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const pid = String(child.pid);
      const identity = await processIdentity(pid);
      const program = DETACHED_PROCESS_CANCELLATION_PROGRAM.replace(
        "marker=pathlib.Path('/qe/state/environment-ownership.json')",
        `marker=pathlib.Path(${JSON.stringify(marker)})`,
      );
      const result = Bun.spawn({
        cmd: [
          "/usr/bin/python3",
          "-I",
          "-c",
          program,
          markerDigest,
          identity.startIdentity,
          identity.executable,
        ],
        env: { QE_PID: pid, QE_CANCELLATION_ID: randomUUID() },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout] = await Promise.all([
        result.exited,
        new Response(result.stdout).text(),
      ]);
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ status: "signalled" });
      expect(program.match(/pidfd_send_signal/g)?.length).toBe(1);
      await child.exited;
      expect(await processExists(pid)).toBe(false);
    } finally {
      child.kill("SIGKILL");
      await child.exited.catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  },
);

async function processIdentity(
  pid: string,
): Promise<{ startIdentity: string; executable: string }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const executable = await readlink(`/proc/${pid}/exe`);
      if (fields[19] && executable)
        return { startIdentity: fields[19], executable };
    } catch {
      // The child may not have materialized procfs state yet.
    }
    await Bun.sleep(5);
  }
  throw new Error("Disposable process identity did not become observable.");
}

async function processExists(pid: string): Promise<boolean> {
  return Bun.file(`/proc/${pid}/stat`).exists();
}
