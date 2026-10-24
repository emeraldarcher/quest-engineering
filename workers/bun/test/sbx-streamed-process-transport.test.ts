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
  expect(await transport.observeIo()).toEqual({
    status: "unavailable",
    reason: "unsupported",
  });
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

for (const scenario of [
  "healthy",
  "closed_pipe",
  "wrong_generation",
  "wrong_pid",
  "wrong_start",
  "wrong_executable",
  "wrong_inode",
  "wrong_marker",
  "wrong_version",
  "negative_count",
  "overflow_count",
  "malformed",
  "oversized",
  "unknown_reason",
  "foreign_then_valid",
  "timeout",
]) {
  test(`content-free relay snapshot ${scenario} cannot change real write/cancel/exit settlement`, async () => {
    const transport = await open(await ioLauncher(scenario), 2_000);
    const events: string[] = [];
    const running = transport.run(async (event) => {
      events.push(event.kind);
    });
    const observation = transport.observeIo();
    expect(await transport.observeIo()).toEqual({
      status: "unavailable",
      reason: "busy",
    });
    const result = await observation;
    if (["healthy", "closed_pipe", "foreign_then_valid"].includes(scenario)) {
      expect(result).toMatchObject({
        status: "available",
        sample: { stdoutBytes: 17, stderrBytes: 11 },
      });
      if (scenario === "closed_pipe")
        expect(result).toMatchObject({
          sample: { stdin: { status: "unavailable", reason: "closed" } },
        });
    } else expect(result.status).toBe("unavailable");
    expect(
      await transport.write(crypto.randomUUID(), Uint8Array.of(1)),
    ).toEqual({ certainty: "acknowledged" });
    expect(await transport.cancel(crypto.randomUUID())).toEqual({
      certainty: "acknowledged",
    });
    await running;
    expect(events).toEqual(["eof", "eof", "exit"]);
  });
}

async function ioLauncher(scenario: string) {
  return script(`
const scenario=${JSON.stringify(scenario)};
const frame=(type,value)=>{const payload=Buffer.from(typeof value==='string'?value:JSON.stringify(value));const header=Buffer.alloc(5);header.writeUInt8(type,0);header.writeUInt32BE(payload.length,1);process.stdout.write(Buffer.concat([header,payload]));};
const identity={pid:'41',startIdentity:'start-41',observedExecutable:'/fixture/provider',observedExecutableIdentity:'1:222',environmentMarkerSha256:'fixture-marker',processGeneration:'11111111-1111-4111-8111-111111111111'};
frame(1,{protocolVersion:2,...identity});
let buffered=Buffer.alloc(0);
process.stdin.on('data',chunk=>{
 buffered=Buffer.concat([buffered,chunk]);
 while(buffered.length>=5){const size=buffered.readUInt32BE(1);if(buffered.length<size+5)break;const type=buffered[0],payload=buffered.subarray(5,size+5);buffered=buffered.subarray(size+5);
 if(type===23){
  if(scenario==='timeout')continue;
  const request=JSON.parse(payload.toString());
  const sample={observedAt:1792800000000,elapsedMs:8,stdin:{status:'observed',unreadBytes:37},stdoutBytes:17,stderrBytes:11,terminal:'not_observed'};
  const observation={status:'available',identity:{...identity},sample,beforeCancellation:null};
  const value={protocolVersion:2,requestId:request.requestId,observation};
  if(scenario==='closed_pipe')sample.stdin={status:'unavailable',reason:'closed'};
  const fields={wrong_generation:'processGeneration',wrong_pid:'pid',wrong_start:'startIdentity',wrong_executable:'observedExecutable',wrong_inode:'observedExecutableIdentity',wrong_marker:'environmentMarkerSha256'};
  if(fields[scenario])observation.identity[fields[scenario]]='wrong';
  if(scenario==='wrong_version')value.protocolVersion=999;
  if(scenario==='negative_count')sample.stdoutBytes=-1;
  if(scenario==='overflow_count')sample.stderrBytes=Number.MAX_SAFE_INTEGER+1;
  if(scenario==='unknown_reason')value.observation={status:'unavailable',reason:'private-error'};
  if(scenario==='malformed')frame(14,'not-json');
  else if(scenario==='oversized')frame(14,'x'.repeat(8193));
  else {if(scenario==='foreign_then_valid')frame(14,{...value,requestId:'foreign'});frame(14,value);}
 }
 if(type===20)frame(6,payload.subarray(0,36).toString());
 if(type===22){frame(9,payload.toString());frame(4,'');frame(5,'');frame(11,{kind:'exited',exitCode:0});process.exit(0);}
 }
});`);
}

async function open(executable: string, acknowledgementTimeoutMs: number) {
  const client = {
    executable,
    streamLauncherArgs: () => [],
  } as unknown as SbxClient;
  return SbxStreamedProcessTransport.open({
    client,
    sandboxName: "fixture",
    processGeneration: "11111111-1111-4111-8111-111111111111",
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
