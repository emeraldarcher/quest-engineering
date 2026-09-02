#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const base = process.env.QE_CAPTURE_BASE_URL ?? "http://127.0.0.1:1420/";
const outputRoot = "docs/screenshots/starter-onboarding-ux";
const scenes = [
  ["01-fresh-no-project", "fixture=starter-empty&scale=2&camera=town"],
  [
    "02-add-project-entry",
    "fixture=starter-project-add&window=gatehouse&projects=add-selection&scale=2&camera=town",
  ],
  ["03-project-preparing", "fixture=starter-preparing&scale=2&camera=town"],
  [
    "04-project-needs-attention",
    "fixture=starter-attention&scale=2&camera=town",
  ],
  ["05-ready-starter-preview", "fixture=starter-ready&scale=2&camera=town"],
  [
    "06-creating-starter-crew",
    "fixture=starter-creating&onboarding=creating&scale=2&camera=town",
  ],
  [
    "07-starter-setup-complete",
    "fixture=starter-complete&onboarding=success&scale=2&camera=town",
  ],
  [
    "08-atomic-failure-retry",
    "fixture=starter-failure&onboarding=failure&scale=2&camera=town",
  ],
  [
    "09-recoverable-legacy-partial",
    "fixture=starter-partial&scale=2&camera=town",
  ],
  [
    "10-canonical-starter-conflict",
    "fixture=starter-conflict&scale=2&camera=town",
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
  "11-responsive-starter-preview",
  "fixture=starter-ready&scale=2&camera=town",
  900,
  600,
  "900x600",
);

await Bun.write(
  resolve(repo, outputRoot, "comparison/AFTER-starter-onboarding-1440x900.png"),
  Bun.file(resolve(repo, outputRoot, "after/1440x900/01-fresh-no-project.png")),
);
await Bun.write(
  resolve(
    repo,
    outputRoot,
    "comparison/BEFORE-starter-onboarding-1440x900.png",
  ),
  Bun.file(resolve(repo, outputRoot, "before/starter-current-1440x900.png")),
);
const comparison = Bun.spawn(
  [
    "python3",
    "client/scripts/side-by-side-png.py",
    `${outputRoot}/comparison/BEFORE-starter-onboarding-1440x900.png`,
    `${outputRoot}/comparison/AFTER-starter-onboarding-1440x900.png`,
    `${outputRoot}/comparison/before-after-side-by-side.png`,
  ],
  { cwd: repo, stdout: "inherit", stderr: "inherit" },
);
if ((await comparison.exited) !== 0)
  throw new Error("Before/after comparison failed.");
