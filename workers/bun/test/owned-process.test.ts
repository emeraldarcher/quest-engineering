import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { OwnedProcess, processSnapshot } from "../scripts/lib/owned-process.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("direct acceptance launch owns the exact process and tears down its process tree", async () => {
  const root = await fixtureRoot();
  const parentReady = join(root, "parent.json");
  const childReady = join(root, "child.pid");
  const owned = await OwnedProcess.start({
    argv: [
      process.execPath,
      join(import.meta.dir, "fixtures", "owned-process-parent.ts"),
      parentReady,
      childReady,
    ],
    cwd: process.cwd(),
  });
  await waitForFile(parentReady);
  await waitForFile(childReady);
  const recorded = JSON.parse(await readFile(parentReady, "utf8")) as {
    parentPid: number;
    childPid: number;
  };

  expect(owned.pid).toBe(recorded.parentPid);
  expect(owned.processGroupId).toBe(recorded.parentPid);
  expect(owned.started.parentPid).toBe(process.pid);
  expect(owned.metadata).toMatchObject({
    pid: recorded.parentPid,
    processGroupId: recorded.parentPid,
    sessionId: recorded.parentPid,
    executable: process.execPath,
    cwd: process.cwd(),
  });
  expect(owned.metadata.argv[1]?.endsWith("owned-process-parent.ts")).toBe(
    true,
  );
  expect(owned.metadata.startedAt).not.toBe("");
  expect((await owned.groupMembers()).map((entry) => entry.pid).sort()).toEqual(
    [recorded.parentPid, recorded.childPid].sort(),
  );

  let authoritativeDisconnect = false;
  setTimeout(() => {
    authoritativeDisconnect = true;
  }, 25);
  const stopped = await owned.stopAndConfirm(() => authoritativeDisconnect);
  expect(stopped.forced).toBe(false);
  expect(await processSnapshot(recorded.parentPid)).toBeNull();
  expect(await processSnapshot(recorded.childPid)).toBeNull();
  expect(await owned.groupMembers()).toEqual([]);
});

test("bounded teardown escalates an uncooperative owned group to SIGKILL", async () => {
  const owned = await OwnedProcess.start({
    argv: ["/bin/sh", "-c", "trap '' TERM; while :; do sleep 1; done"],
    cwd: process.cwd(),
  });
  const stopped = await owned.stop(1_000);
  expect(stopped.forced).toBe(true);
  expect(await owned.groupMembers()).toEqual([]);
});

test("an unexpectedly exited wrapper cannot orphan a process outside the owned group", async () => {
  const root = await fixtureRoot();
  const childReady = join(root, "child.pid");
  const childPidPath = join(root, "wrapper-child.pid");
  const fixture = join(import.meta.dir, "fixtures", "owned-process-child.ts");
  const owned = await OwnedProcess.start({
    argv: [
      "/bin/sh",
      "-c",
      '"$1" "$2" "$3" & echo $! > "$4"; sleep 0.2',
      "owned-wrapper",
      process.execPath,
      fixture,
      childReady,
      childPidPath,
    ],
    cwd: process.cwd(),
  });
  await waitForFile(childReady);
  await waitForFile(childPidPath);
  const childPid = Number((await readFile(childPidPath, "utf8")).trim());
  await waitFor(async () => (await owned.snapshot()) === null);

  expect((await owned.groupMembers()).map((entry) => entry.pid)).toContain(
    childPid,
  );
  const stopped = await owned.stop();
  expect(stopped.exitCode).toBe(0);
  expect(await processSnapshot(childPid)).toBeNull();
  expect(await owned.groupMembers()).toEqual([]);
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(
    join(process.cwd(), ".pi", "tmp", "owned-process-"),
  );
  roots.push(root);
  return root;
}

async function waitForFile(path: string): Promise<void> {
  await waitFor(() => Bun.file(path).exists());
}

async function waitFor(probe: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await probe()) return;
    await Bun.sleep(25);
  }
  throw new Error("Timed out waiting for owned-process fixture state.");
}
