#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const base = process.env.QE_CAPTURE_BASE_URL ?? "http://127.0.0.1:1420/";
const outputRoot = "docs/screenshots/tavern-ux";

const scenes = [
  [
    "01-squad-list-selected",
    "fixture=tavern&window=tavern&tavern=backend&scale=2&camera=town",
  ],
  [
    "02-engineering-pair-roster",
    "fixture=tavern&window=tavern&tavern=engineering&scale=2&camera=town",
  ],
  [
    "03-new-squad",
    "fixture=tavern&window=tavern&tavern=new&scale=2&camera=town",
  ],
  [
    "04-edit-squad",
    "fixture=tavern&window=tavern&tavern=edit&scale=2&camera=town",
  ],
  [
    "05-add-member",
    "fixture=tavern&window=tavern&tavern=add-member&scale=2&camera=town",
  ],
  [
    "06-edit-member",
    "fixture=tavern&window=tavern&tavern=edit-member&scale=2&camera=town",
  ],
  [
    "07-class-picker",
    "fixture=tavern&window=tavern&tavern=class-picker&scale=2&camera=town",
  ],
  [
    "08-loadout-picker",
    "fixture=tavern&window=tavern&tavern=loadout-picker&scale=2&camera=town",
  ],
  [
    "09-reordered-roster",
    "fixture=tavern&window=tavern&tavern=reordered&scale=2&camera=town",
  ],
  [
    "10-archived-reference-warning",
    "fixture=tavern-archived&window=tavern&tavern=engineering&scale=2&camera=town",
  ],
  [
    "11-advanced",
    "fixture=tavern&window=tavern&tavern=advanced&scale=2&camera=town",
  ],
  [
    "12-archive-confirmation",
    "fixture=tavern&window=tavern&tavern=archive&scale=2&camera=town",
  ],
  [
    "13-dirty-confirmation",
    "fixture=tavern&window=tavern&tavern=dirty&scale=2&camera=town",
  ],
  ["14-empty-state", "fixture=tavern-empty&window=tavern&scale=2&camera=town"],
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
  "15-responsive-tavern",
  "fixture=tavern&window=tavern&tavern=engineering&scale=2&camera=town",
  900,
  600,
  "900x600",
);

await Bun.write(
  resolve(repo, outputRoot, "comparison/AFTER-tavern-1440x900.png"),
  Bun.file(
    resolve(repo, outputRoot, "after/1440x900/02-engineering-pair-roster.png"),
  ),
);
await Bun.write(
  resolve(repo, outputRoot, "comparison/BEFORE-tavern-1440x900.png"),
  Bun.file(resolve(repo, outputRoot, "before/tavern-current-1440x900.png")),
);
const comparison = Bun.spawn(
  [
    "python3",
    "client/scripts/side-by-side-png.py",
    `${outputRoot}/comparison/BEFORE-tavern-1440x900.png`,
    `${outputRoot}/comparison/AFTER-tavern-1440x900.png`,
    `${outputRoot}/comparison/before-after-side-by-side.png`,
  ],
  { cwd: repo, stdout: "inherit", stderr: "inherit" },
);
if ((await comparison.exited) !== 0)
  throw new Error("Before/after comparison failed.");
