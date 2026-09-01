#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const base = process.env.QE_CAPTURE_BASE_URL ?? "http://127.0.0.1:1420/";
const outputRoot = "docs/screenshots/guild-hall-ux";

const scenes = [
  ["01-class-list", "fixture=idle&window=guild&guild=list&scale=2&camera=town"],
  [
    "02-selected-builder",
    "fixture=idle&window=guild&guild=builder&scale=2&camera=town",
  ],
  [
    "03-selected-reviewer",
    "fixture=idle&window=guild&guild=reviewer&scale=2&camera=town",
  ],
  ["04-new-class", "fixture=idle&window=guild&guild=new&scale=2&camera=town"],
  ["05-edit-class", "fixture=idle&window=guild&guild=edit&scale=2&camera=town"],
  [
    "06-advanced",
    "fixture=idle&window=guild&guild=advanced&scale=2&camera=town",
  ],
  [
    "07-archive-confirmation",
    "fixture=idle&window=guild&guild=archive&scale=2&camera=town",
  ],
  [
    "08-dirty-confirmation",
    "fixture=idle&window=guild&guild=dirty&scale=2&camera=town",
  ],
  ["09-empty-state", "fixture=guild-empty&window=guild&scale=2&camera=town"],
] as const;

async function capture(
  name: string,
  query: string,
  width: number,
  height: number,
  folder: string,
) {
  const url = new URL(base);
  url.search = query;
  const child = Bun.spawn(
    [
      "bun",
      "client/scripts/capture-scene.ts",
      `--url=${url}`,
      `--out=${outputRoot}/after/${folder}/${name}.png`,
      `--width=${width}`,
      `--height=${height}`,
      "--dpr=1",
    ],
    { cwd: repo, stdout: "inherit", stderr: "inherit" },
  );
  if ((await child.exited) !== 0) throw new Error(`Capture failed: ${name}`);
}

await mkdir(resolve(repo, outputRoot, "after/1440x900"), { recursive: true });
await mkdir(resolve(repo, outputRoot, "after/900x600"), { recursive: true });
await mkdir(resolve(repo, outputRoot, "comparison"), { recursive: true });
for (const [name, query] of scenes)
  await capture(name, query, 1440, 900, "1440x900");
await capture(
  "10-responsive-guild-hall",
  "fixture=idle&window=guild&guild=builder&scale=2&camera=town",
  900,
  600,
  "900x600",
);

await Bun.write(
  resolve(repo, outputRoot, "comparison/AFTER-guild-hall-1440x900.png"),
  Bun.file(resolve(repo, outputRoot, "after/1440x900/02-selected-builder.png")),
);
await Bun.write(
  resolve(repo, outputRoot, "comparison/BEFORE-guild-hall-1440x900.png"),
  Bun.file(resolve(repo, outputRoot, "before/guild-hall-current-1440x900.png")),
);
const comparison = Bun.spawn(
  [
    "python3",
    "client/scripts/side-by-side-png.py",
    `${outputRoot}/comparison/BEFORE-guild-hall-1440x900.png`,
    `${outputRoot}/comparison/AFTER-guild-hall-1440x900.png`,
    `${outputRoot}/comparison/before-after-side-by-side.png`,
  ],
  { cwd: repo, stdout: "inherit", stderr: "inherit" },
);
if ((await comparison.exited) !== 0)
  throw new Error("Before/after comparison failed.");
