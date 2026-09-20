import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const requiredExports = [
  "ModelRuntime",
  "SettingsManager",
  "resolveModelScopeWithDiagnostics",
];
const pi = await import(
  "/opt/qe/pi/node_modules/@earendil-works/pi-coding-agent/dist/index.js"
);
const missingExports = requiredExports.filter(
  (name) => typeof pi[name] !== "function",
);
const nodeMajor = Number(process.versions.node.split(".")[0]);
const gitVersion = execFileSync("/usr/bin/git", ["--version"], {
  encoding: "utf8",
}).trim();
const packageJson = JSON.parse(
  readFileSync(
    "/opt/qe/pi/node_modules/@earendil-works/pi-coding-agent/package.json",
    "utf8",
  ),
);
const cli = "/opt/qe/pi/node_modules/.bin/pi";
const help = execFileSync(cli, ["--help"], { encoding: "utf8" });
const requiredFlags = [
  "--model",
  "--thinking",
  "--no-extensions",
  "--extension",
  "--no-skills",
  "--no-prompt-templates",
  "--no-context-files",
  "--tools",
];
const missingFlags = requiredFlags.filter((flag) => !help.includes(flag));
const capabilities = {
  nodeRuntime: Number.isInteger(nodeMajor) && nodeMajor >= 22,
  git: /^git version 2\./.test(gitVersion),
  modelRuntime: missingExports.length === 0,
  interactiveCli: missingFlags.length === 0,
  nativeExtensions: help.includes("--extension"),
  structuredTools: help.includes("--tools"),
};
const compatible = Object.values(capabilities).every(Boolean);
process.stdout.write(
  `${JSON.stringify({
    schemaVersion: 1,
    compatible,
    capabilities,
    provenance: {
      piPackage: packageJson.version,
      node: process.versions.node,
      git: gitVersion,
    },
    missingExports,
    missingFlags,
  })}\n`,
);
if (!compatible) process.exitCode = 1;
