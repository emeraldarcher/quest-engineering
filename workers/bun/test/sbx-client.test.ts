import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CliSbxClient } from "../src/execution-environment/sbx-client.ts";

const roots: string[] = [];
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
