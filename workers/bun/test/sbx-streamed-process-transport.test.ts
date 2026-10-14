import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SbxClient } from "../src/execution-environment/sbx-client.ts";
import { SbxStreamedProcessTransport } from "../src/execution-environment/sbx-streamed-process.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("missing SBX relay launcher is known not submitted", async () => {
  await expect(open("/does/not/exist", 25)).rejects.toMatchObject({
    code: "streamed_process_spawn_failed",
    operation: "spawn_streamed",
    sideEffectCertainty: "not_submitted",
  });
});

test("guest target spawn rejection is known not submitted", async () => {
  const launcher = await script(
    `const payload = Buffer.from(JSON.stringify({code:"spawn_not_started"}));\n` +
      `const header = Buffer.alloc(5); header.writeUInt8(12,0); header.writeUInt32BE(payload.length,1);\n` +
      `process.stdout.write(Buffer.concat([header,payload]));`,
  );
  await expect(open(launcher, 2_000)).rejects.toMatchObject({
    code: "streamed_process_spawn_failed",
    operation: "spawn_streamed",
    sideEffectCertainty: "not_submitted",
  });
});

test("lost relay response after physical launcher start is ambiguous", async () => {
  const launcher = await script("await Bun.sleep(100);");
  await expect(open(launcher, 10)).rejects.toMatchObject({
    code: "streamed_process_spawn_failed",
    operation: "spawn_streamed",
    sideEffectCertainty: "ambiguous",
  });
});

test("exact EOF and exit frames remain complete despite trailing native diagnostics", async () => {
  const launcher = await script(`
const frame=(type,value)=>{const payload=Buffer.from(typeof value==='string'?value:JSON.stringify(value));const header=Buffer.alloc(5);header.writeUInt8(type,0);header.writeUInt32BE(payload.length,1);process.stdout.write(Buffer.concat([header,payload]));};
frame(1,{pid:'41',startIdentity:'start-41',observedExecutable:'/fixture/provider',environmentMarkerSha256:'fixture-marker'});
frame(2,'complete-output');frame(4,'');frame(5,'');frame(11,{kind:'exited',exitCode:0});
process.stderr.write('native wrapper diagnostic after exact relay settlement\\n');
process.exitCode=7;`);
  const transport = await open(launcher, 2_000);
  const events: Array<{ kind: string }> = [];
  await transport.run(async (event) => {
    events.push(event);
  });
  expect(events).toEqual([
    expect.objectContaining({ kind: "data" }),
    expect.objectContaining({ kind: "eof" }),
    expect.objectContaining({ kind: "eof" }),
    expect.objectContaining({ kind: "exit" }),
  ]);
});

async function open(executable: string, acknowledgementTimeoutMs: number) {
  const client = {
    executable,
    streamLauncherArgs: () => [],
  } as unknown as SbxClient;
  return SbxStreamedProcessTransport.open({
    client,
    sandboxName: "fixture",
    command: {
      executable: "/fixture/provider",
      args: ["auth", "login"],
      cwd: "/qe/workspaces/default",
      environment: {},
    },
    relaySource: "fixture relay",
    markerPath: "/qe/state/environment-ownership.json",
    expectedMarkerSha256: "fixture-marker",
    acknowledgementTimeoutMs,
  });
}

async function script(body: string): Promise<string> {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "sbx-stream-transport-"));
  roots.push(root);
  const path = join(root, "launcher");
  await writeFile(path, `#!/usr/bin/env bun\n${body}\n`, "utf8");
  await chmod(path, 0o755);
  return path;
}
