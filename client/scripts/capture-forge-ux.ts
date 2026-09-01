#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const base = process.env.QE_CAPTURE_BASE_URL ?? "http://127.0.0.1:1420/";
const outputRoot = "docs/screenshots/forge-ux";

const scenes = [
  [
    "01-loadout-list",
    "fixture=forge&window=blacksmith&forge=list&scale=2&camera=town",
  ],
  [
    "02-selected-coding",
    "fixture=forge&window=blacksmith&forge=coding&scale=2&camera=town",
  ],
  [
    "03-selected-review",
    "fixture=forge&window=blacksmith&forge=review&scale=2&camera=town",
  ],
  [
    "04-custom-loadout",
    "fixture=forge-custom&window=blacksmith&forge=custom&scale=2&camera=town",
  ],
  [
    "05-new-loadout",
    "fixture=forge&window=blacksmith&forge=new&scale=2&camera=town",
  ],
  [
    "06-edit-loadout",
    "fixture=forge&window=blacksmith&forge=edit&scale=2&camera=town",
  ],
  [
    "07-custom-configuration",
    "fixture=forge-custom&window=blacksmith&forge=custom-config&scale=2&camera=town",
  ],
  [
    "08-advanced",
    "fixture=forge&window=blacksmith&forge=advanced&scale=2&camera=town",
  ],
  [
    "09-archive-confirmation",
    "fixture=forge&window=blacksmith&forge=archive&scale=2&camera=town",
  ],
  [
    "10-dirty-confirmation",
    "fixture=forge&window=blacksmith&forge=dirty&scale=2&camera=town",
  ],
  [
    "11-empty-state",
    "fixture=forge-empty&window=blacksmith&scale=2&camera=town",
  ],
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
  "12-responsive-forge",
  "fixture=forge&window=blacksmith&forge=coding&scale=2&camera=town",
  900,
  600,
  "900x600",
);

await Bun.write(
  resolve(repo, outputRoot, "comparison/AFTER-forge-1440x900.png"),
  Bun.file(resolve(repo, outputRoot, "after/1440x900/02-selected-coding.png")),
);
await Bun.write(
  resolve(repo, outputRoot, "comparison/BEFORE-forge-1440x900.png"),
  Bun.file(resolve(repo, outputRoot, "before/forge-current-1440x900.png")),
);
const comparison = Bun.spawn(
  [
    "python3",
    "client/scripts/side-by-side-png.py",
    `${outputRoot}/comparison/BEFORE-forge-1440x900.png`,
    `${outputRoot}/comparison/AFTER-forge-1440x900.png`,
    `${outputRoot}/comparison/before-after-side-by-side.png`,
  ],
  { cwd: repo, stdout: "inherit", stderr: "inherit" },
);
if ((await comparison.exited) !== 0)
  throw new Error("Before/after comparison failed.");
