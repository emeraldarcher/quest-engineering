import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CliSbxClient,
  runSbxSubprocess,
} from "../src/execution-environment/sbx-client.ts";

const roots: string[] = [];
const versionJson = JSON.stringify({
  client: { version: "v0.43.0", revision: "client-rev" },
  server: {
    state: "running",
    version: "v0.43.0",
    revision: "server-rev",
    api_version: "0.31.0",
  },
});
const updateNotice = "update available: v0.46.0 (running v0.43.0)";
const expectedVersion = {
  clientVersion: "v0.43.0",
  clientRevision: "client-rev",
  serverState: "running",
  serverVersion: "v0.43.0",
  serverRevision: "server-rev",
  apiVersion: "0.31.0",
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("CLI client decodes structured SBX version and inventory output", async () => {
  const executable = await script(`
const args = process.argv.slice(2);
if (args[0] === "version") console.log(JSON.stringify({client:{version:"v0.43.0",revision:"client-rev"},server:{state:"running",version:"v0.43.0",revision:"server-rev",api_version:"0.31.0"}}));
else if (args[0] === "ls") console.log(JSON.stringify({sandboxes:[{name:"qe-test",id:"00000000-0000-4000-8000-000000000001",agent:"shell",status:"running"}]}));
else process.exit(2);
`);
  const client = new CliSbxClient(executable);
  expect(await client.version()).toEqual({
    clientVersion: "v0.43.0",
    clientRevision: "client-rev",
    serverState: "running",
    serverVersion: "v0.43.0",
    serverRevision: "server-rev",
    apiVersion: "0.31.0",
  });
  expect(await client.list()).toEqual([
    {
      name: "qe-test",
      id: "00000000-0000-4000-8000-000000000001",
      agent: "shell",
      status: "running",
    },
  ]);
});

for (const [name, stdout] of [
  ["plain JSON", versionJson],
  ["a leading update warning", `${updateNotice}\n${versionJson}`],
  ["a trailing update warning", `${versionJson}\n${updateNotice}`],
  [
    "an ANSI-colored update warning",
    `\u001b[33m${updateNotice}\u001b[0m\n${versionJson}`,
  ],
] as const) {
  test(`CLI client accepts exactly one version document with ${name}`, async () => {
    expect(await versionClient(stdout).version()).toEqual(expectedVersion);
  });
}

test("CLI client keeps an update warning on stderr separate from JSON stdout", async () => {
  const client = new CliSbxClient("/fake/sbx", async () => ({
    exitCode: 0,
    stdout: versionJson,
    stderr: `${updateNotice}\n`,
  }));
  expect(await client.version()).toEqual(expectedVersion);
});

test("CLI client rejects unsupported non-JSON framing", async () => {
  for (const stdout of [
    `daemon returned an arbitrary notice\n${versionJson}`,
    `\u001b[2K${updateNotice}\n${versionJson}`,
  ])
    await expect(versionClient(stdout).version()).rejects.toMatchObject({
      code: "malformed_backend_response",
    });
});

test("CLI client rejects multiple JSON documents in stdout", async () => {
  await expect(
    versionClient(
      `${versionJson}\n\u001b[33m${versionJson}\u001b[0m`,
    ).version(),
  ).rejects.toMatchObject({ code: "malformed_backend_response" });
});

test("CLI client rejects a truncated JSON document in stdout", async () => {
  await expect(
    versionClient(versionJson.slice(0, -1)).version(),
  ).rejects.toMatchObject({ code: "malformed_backend_response" });
  await expect(
    versionClient(`${versionJson}\n{"truncated":`).version(),
  ).rejects.toMatchObject({ code: "malformed_backend_response" });
});

test("CLI client rejects malformed JSON string escaping", async () => {
  await expect(
    versionClient(`${updateNotice}\n{"client":"bad\\q"}`).version(),
  ).rejects.toMatchObject({ code: "malformed_backend_response" });
});

test("CLI client preserves nonzero exit classification before JSON parsing", async () => {
  const client = new CliSbxClient("/fake/sbx", async () => ({
    exitCode: 7,
    stdout: versionJson,
    stderr: "sbx failed",
  }));
  await expect(client.version()).rejects.toMatchObject({
    code: "operation_failed",
  });
});

test("SBX subprocess runner drains delayed large stdout and stderr without merging streams", async () => {
  const executable = await script(`
const stdout = "stdout-start\\n" + "o".repeat(512 * 1024) + "\\nstdout-end\\n";
const stderr = "stderr-start\\n" + "e".repeat(512 * 1024) + "\\nstderr-end\\n";
const write = (stream, value) => new Promise((resolve) => stream.write(value, resolve));
await Promise.all([
  write(process.stdout, stdout.slice(0, 19)),
  write(process.stderr, stderr.slice(0, 19)),
]);
await Bun.sleep(20);
await Promise.all([
  write(process.stdout, stdout.slice(19)),
  write(process.stderr, stderr.slice(19)),
]);
`);
  const result = await runSbxSubprocess(executable)({
    args: [],
    timeoutMs: 5_000,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe(
    `stdout-start\n${"o".repeat(512 * 1024)}\nstdout-end\n`,
  );
  expect(result.stderr).toBe(
    `stderr-start\n${"e".repeat(512 * 1024)}\nstderr-end\n`,
  );
  expect(result.stdout).not.toContain("stderr-start");
  expect(result.stderr).not.toContain("stdout-start");
});

test("CLI client rejects malformed structured output", async () => {
  const executable = await script(
    `console.log(JSON.stringify({sandboxes:[{name:"missing-fields"}]}))`,
  );
  const client = new CliSbxClient(executable);
  await expect(client.list()).rejects.toMatchObject({
    code: "malformed_backend_response",
  });
});

test("CLI client terminates timed-out commands and classifies the error", async () => {
  const executable = await script(`await Bun.sleep(10_000)`);
  const client = new CliSbxClient(executable, undefined, 10);
  await expect(client.list()).rejects.toMatchObject({
    code: "operation_timeout",
  });
});

test("CLI client durably announces invocation before literal stop and keeps inventory separate", async () => {
  const calls: Array<{ args: readonly string[]; timeoutMs: number }> = [];
  const order: string[] = [];
  const client = new CliSbxClient("/fake/sbx", async (request) => {
    order.push(`runner:${request.args[0]}`);
    calls.push({ args: [...request.args], timeoutMs: request.timeoutMs });
    return request.args[0] === "ls"
      ? { exitCode: 0, stdout: '{"sandboxes":[]}', stderr: "" }
      : { exitCode: 0, stdout: "", stderr: "" };
  });

  await client.stop("qe-exact-sandbox", {
    timeoutMs: 1_234,
    onInvocation: () => {
      order.push("invocation");
    },
  });
  await client.list({ timeoutMs: 567 });

  expect(order).toEqual(["invocation", "runner:stop", "runner:ls"]);
  expect(calls).toEqual([
    { args: ["stop", "qe-exact-sandbox"], timeoutMs: 1_234 },
    { args: ["ls", "--json"], timeoutMs: 567 },
  ]);
});

test("CLI errors redact environment values from retained command arguments", async () => {
  const client = new CliSbxClient("/fake/sbx", async () => ({
    exitCode: 1,
    stdout: "",
    stderr: "failed with must-not-escape",
  }));
  const error = await client
    .exec("qe-test", {
      executable: "/bin/false",
      args: [],
      environment: { SECRET_TOKEN: "must-not-escape" },
    })
    .catch((value: unknown) => value);
  expect(error).toMatchObject({
    args: expect.arrayContaining(["SECRET_TOKEN=<redacted>"]),
  });
  expect(JSON.stringify(error)).not.toContain("must-not-escape");
});

test("CLI client registers a sandbox-scoped command secret without retaining resolver output", async () => {
  const calls: string[][] = [];
  const client = new CliSbxClient("/fake/sbx", async (request) => {
    calls.push([...request.args]);
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  await client.setDynamicSecret({
    sandboxName: "qe-test",
    placeholder: "nonsecret-placeholder",
    hosts: ["chatgpt.com", "www.googleapis.com"],
    resolverCommand: "/trusted/credential-helper",
    refreshInterval: "5m",
  });
  expect(calls).toEqual([
    [
      "secret",
      "set-custom",
      "--placeholder",
      "nonsecret-placeholder",
      "--host",
      "chatgpt.com",
      "--host",
      "www.googleapis.com",
      "--command",
      "/trusted/credential-helper",
      "--refresh",
      "5m",
      "--sandbox",
      "qe-test",
    ],
  ]);

  const failing = new CliSbxClient("/fake/sbx", async () => ({
    exitCode: 1,
    stdout: "actual-access-token",
    stderr: "provider error with actual-access-token",
  }));
  const error = await failing
    .setDynamicSecret({
      sandboxName: "qe-test",
      placeholder: "nonsecret-placeholder",
      hosts: ["chatgpt.com"],
      resolverCommand: "/trusted/credential-helper",
      refreshInterval: "5m",
    })
    .catch((value: unknown) => value);
  expect(JSON.stringify(error)).not.toContain("actual-access-token");
  expect(error).toMatchObject({
    args: expect.arrayContaining(["<redacted>"]),
  });
});

test("CLI client constructs exact host-to-guest and guest-to-host copy operations", async () => {
  const calls: string[][] = [];
  const client = new CliSbxClient("/fake/sbx", async (request) => {
    calls.push([...request.args]);
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  await client.copyTo(
    "qe-test",
    "/worker/source.bundle",
    "/qe/state/import.bundle",
  );
  await client.copyFrom(
    "qe-test",
    "/qe/state/export.bundle",
    "/worker/export.bundle",
  );
  expect(calls).toEqual([
    ["cp", "/worker/source.bundle", "qe-test:/qe/state/import.bundle"],
    ["cp", "qe-test:/qe/state/export.bundle", "/worker/export.bundle"],
  ]);
});

test("CLI launcher arguments preserve structured guest cwd and environment", () => {
  const client = new CliSbxClient("/fake/sbx");
  expect(
    client.launcherArgs("qe-test", {
      executable: "/bin/sh",
      args: ["-c", "printf ok"],
      cwd: "/qe/workspace",
      environment: { HOME: "/qe/home", TOKEN: "not-a-secret-test-value" },
    }),
  ).toEqual([
    "exec",
    "--interactive",
    "--tty",
    "--workdir",
    "/qe/workspace",
    "--env",
    "HOME=/qe/home",
    "--env",
    "TOKEN=not-a-secret-test-value",
    "qe-test",
    "--",
    "/bin/sh",
    "-c",
    "printf ok",
  ]);
});

test("CLI streamed arguments use attached non-PTY exec and preserve literal argv", () => {
  const client = new CliSbxClient("/fake/sbx");
  expect(
    client.streamLauncherArgs("qe-test", {
      executable: "/usr/bin/python3",
      args: ["-c", "; echo never-interpreted"],
      cwd: "/qe/workspace",
      environment: { VALUE: "explicit" },
    }),
  ).toEqual([
    "exec",
    "--interactive",
    "--workdir",
    "/qe/workspace",
    "--env",
    "VALUE=explicit",
    "qe-test",
    "--",
    "/usr/bin/python3",
    "-c",
    "; echo never-interpreted",
  ]);
});

function versionClient(stdout: string): CliSbxClient {
  return new CliSbxClient("/fake/sbx", async () => ({
    exitCode: 0,
    stdout,
    stderr: "",
  }));
}

async function script(body: string): Promise<string> {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "sbx-client-"));
  roots.push(root);
  const path = join(root, "fake-sbx");
  await writeFile(path, `#!/usr/bin/env bun\n${body}\n`, "utf8");
  await chmod(path, 0o755);
  return path;
}
