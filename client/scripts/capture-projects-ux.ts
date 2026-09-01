#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const base = process.env.QE_CAPTURE_BASE_URL ?? "http://127.0.0.1:1420/";
const outputRoot = "docs/screenshots/projects-ux";

const scenes = [
  [
    "01-projects-list",
    "fixture=projects&window=gatehouse&projects=list&scale=2&camera=town",
  ],
  [
    "02-selected-ready-project",
    "fixture=idle&window=gatehouse&projects=ready&scale=2&camera=town",
  ],
  [
    "03-add-project-repository-selection",
    "fixture=projects-empty&window=gatehouse&projects=add-selection&scale=2&camera=town",
  ],
  [
    "04-add-project-name-confirmation",
    "fixture=projects-empty&window=gatehouse&projects=add-confirm&scale=2&camera=town",
  ],
  [
    "05-preparing-project",
    "fixture=projects-preparing&window=gatehouse&scale=2&camera=town",
  ],
  [
    "06-needs-attention-project",
    "fixture=projects-attention&window=gatehouse&scale=2&camera=town",
  ],
  [
    "07-advanced-diagnostics",
    "fixture=projects&window=gatehouse&projects=advanced&scale=2&camera=town",
  ],
  [
    "08-archive-confirmation",
    "fixture=projects&window=gatehouse&projects=archive&scale=2&camera=town",
  ],
  [
    "09-empty-state",
    "fixture=projects-empty&window=gatehouse&scale=2&camera=town",
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
  "10-responsive-projects",
  "fixture=projects&window=gatehouse&projects=ready&scale=2&camera=town",
  900,
  600,
  "900x600",
);

await Bun.write(
  resolve(repo, outputRoot, "comparison/AFTER-projects-1440x900.png"),
  Bun.file(
    resolve(repo, outputRoot, "after/1440x900/02-selected-ready-project.png"),
  ),
);
await Bun.write(
  resolve(repo, outputRoot, "comparison/BEFORE-projects-1440x900.png"),
  Bun.file(resolve(repo, outputRoot, "before/projects-current-1440x900.png")),
);
const comparison = Bun.spawn(
  [
    "python3",
    "client/scripts/side-by-side-png.py",
    `${outputRoot}/comparison/BEFORE-projects-1440x900.png`,
    `${outputRoot}/comparison/AFTER-projects-1440x900.png`,
    `${outputRoot}/comparison/before-after-side-by-side.png`,
  ],
  { cwd: repo, stdout: "inherit", stderr: "inherit" },
);
if ((await comparison.exited) !== 0)
  throw new Error("Before/after comparison failed.");
