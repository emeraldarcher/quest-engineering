#!/usr/bin/env bun
import type { HostLaunchDescriptor } from "../../execution-environment/types.ts";

process.title = "pi";
const encoded = process.env.QE_PI_ENVIRONMENT_LAUNCH?.trim();
if (!encoded) {
  console.error(
    "Quest Engineering Pi environment launch descriptor is missing.",
  );
  process.exit(74);
}
let descriptor: HostLaunchDescriptor;
try {
  descriptor = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
} catch {
  console.error(
    "Quest Engineering Pi environment launch descriptor is invalid.",
  );
  process.exit(74);
}
if (
  !descriptor ||
  descriptor.io !== "pty" ||
  typeof descriptor.executable !== "string" ||
  !Array.isArray(descriptor.args) ||
  descriptor.args.some((value) => typeof value !== "string") ||
  descriptor.provenance?.kind !== "execution_environment"
) {
  console.error(
    "Quest Engineering Pi environment launch provenance is invalid.",
  );
  process.exit(74);
}
const child = Bun.spawn(
  [descriptor.executable, ...descriptor.args, "--", ...process.argv.slice(2)],
  {
    cwd: descriptor.cwd,
    env: { ...process.env, ...descriptor.environment },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);
for (const signal of ["SIGWINCH", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => child.kill(signal));
process.exitCode = await child.exited;
