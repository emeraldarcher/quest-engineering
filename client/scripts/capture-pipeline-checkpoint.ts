#!/usr/bin/env bun
import { resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const base = process.env.QE_CAPTURE_BASE_URL ?? "http://127.0.0.1:1420/";
const output = "docs/screenshots/v0.14b/pipeline-checkpoint";
const scenes = [
  ["01-authored-town-overview", "fixture=idle&camera=town&scale=2", 1440, 900],
  ["02-guild-camera-anchor", "fixture=density&window=guild&scale=2", 1440, 900],
  ["03-runtime-density", "fixture=density&camera=town&scale=2", 1440, 900],
  [
    "04-quest-status-anchor",
    "fixture=pr-review&camera=town&scale=2",
    1440,
    900,
  ],
  [
    "05-authoring-debug-overlay",
    "fixture=density&camera=town&scale=2&debugMap=1",
    1440,
    900,
  ],
  ["06-responsive-guild", "fixture=density&window=guild&scale=1", 900, 600],
] as const;

for (const [name, query, width, height] of scenes) {
  const url = new URL(base);
  url.search = query;
  const command = Bun.spawn(
    [
      "bun",
      "client/scripts/capture-scene.ts",
      `--url=${url}`,
      `--out=${output}/${name}.png`,
      `--width=${width}`,
      `--height=${height}`,
      "--dpr=1",
    ],
    { cwd: repo, stdout: "inherit", stderr: "inherit" },
  );
  if ((await command.exited) !== 0) throw new Error(`Capture failed: ${name}`);
}
