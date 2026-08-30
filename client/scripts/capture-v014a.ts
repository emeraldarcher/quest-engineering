#!/usr/bin/env bun
import { resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const base = process.env.QE_CAPTURE_BASE_URL ?? "http://127.0.0.1:1420/";
const scenes = [
  ["01-idle-town", "fixture=idle&scale=3&camera=town"],
  ["02-density-scene", "fixture=density&window=guild&scale=3&camera=town"],
  ["03-guild-hall", "fixture=idle&window=guild&scale=3"],
  ["04-blacksmith", "fixture=idle&window=blacksmith&scale=3"],
  ["05-tavern", "fixture=idle&window=tavern&scale=3"],
  ["06-quest-board", "fixture=idle&window=quest-board&scale=3"],
  ["07-projects", "fixture=idle&window=gatehouse&scale=3"],
  [
    "08-active-single-member",
    "fixture=single-active&window=work-area&scale=3&camera=town",
  ],
  [
    "09-parallel-execution",
    "fixture=parallel&window=work-area&scale=3&camera=town",
  ],
  ["10-waiting-work", "fixture=waiting&window=work-area&scale=3&camera=town"],
  [
    "11-pr-awaiting-review",
    "fixture=pr-review&window=quest-board&scale=3&camera=town",
  ],
  ["12-merged-quest", "fixture=merged&window=quest-board&scale=3&camera=town"],
  [
    "13-member-inspector",
    "fixture=member-inspector&window=work-area&scale=3&camera=town",
  ],
  [
    "14-work-yard-run-inspector",
    "fixture=parallel&window=work-area&scale=3&camera=town",
  ],
  [
    "15-cleanup-available",
    "fixture=cleanup-available&window=work-area&scale=3&camera=town",
  ],
  [
    "16-delivery-attention",
    "fixture=delivery-attention&window=work-area&scale=3&camera=town",
  ],
  ["17-recent-runs", "fixture=recent-runs&journal=1&scale=3&camera=town"],
] as const;

async function capture(
  name: string,
  query: string,
  width: number,
  height: number,
  dpr: number,
  folder: string,
) {
  const url = new URL(base);
  url.search = query;
  const command = Bun.spawn(
    [
      "bun",
      "client/scripts/capture-scene.ts",
      `--url=${url}`,
      `--out=docs/screenshots/v0.14a/${folder}/${name}.png`,
      `--width=${width}`,
      `--height=${height}`,
      `--dpr=${dpr}`,
    ],
    { cwd: repo, stdout: "inherit", stderr: "inherit" },
  );
  if ((await command.exited) !== 0) throw new Error(`Capture failed: ${name}`);
}

for (const [name, query] of scenes)
  await capture(name, query, 1440, 900, 1, "1440x900");
for (const [name, query] of [
  ["density-scene", "fixture=density&window=guild&scale=2&camera=town"],
  ["quest-board", "fixture=pr-review&window=quest-board&scale=2&camera=town"],
  ["work-yard", "fixture=parallel&window=work-area&scale=2&camera=town"],
] as const)
  await capture(name, query, 900, 600, 1, "900x600");
await capture(
  "density-scene-retina",
  "fixture=density&window=guild&scale=3&camera=town",
  1440,
  900,
  2,
  "retina",
);
