// Validation tripwire, loaded only by the explicit review allowlist command.
// A test may spy on Bun.spawn with an in-memory child; restoring that spy
// restores this denial, never the real launcher.
import childProcess from "node:child_process";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

const denied = (): never => {
  throw new Error("Preprobe review forbids native process/network execution.");
};
Bun.spawn = denied as typeof Bun.spawn;
Bun.spawnSync = denied as typeof Bun.spawnSync;
for (const name of [
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
] as const)
  Object.defineProperty(childProcess, name, {
    value: denied,
    configurable: true,
    writable: true,
  });
for (const [module, names] of [
  [net, ["connect", "createConnection"]],
  [tls, ["connect"]],
  [http, ["request", "get"]],
  [https, ["request", "get"]],
] as const)
  for (const name of names)
    Object.defineProperty(module, name, {
      value: denied,
      configurable: true,
      writable: true,
    });
Bun.connect = denied as typeof Bun.connect;
Bun.listen = denied as typeof Bun.listen;
syncBuiltinESMExports();
globalThis.fetch = denied as unknown as typeof fetch;
