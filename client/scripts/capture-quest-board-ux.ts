#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const base = process.env.QE_CAPTURE_BASE_URL ?? "http://127.0.0.1:1420/";
const outputRoot = "docs/screenshots/quest-board-ux";
const scenes = [
  [
    "01-empty-first-quest",
    "fixture=quest-board-empty&window=quest-board&scale=2&camera=town",
  ],
  [
    "02-quest-list-ready",
    "fixture=quest-board-ready&window=quest-board&scale=2&camera=town",
  ],
  [
    "03-new-quest",
    "fixture=quest-board-new&window=quest-board&quest-board=new&scale=2&camera=town",
  ],
  [
    "04-project-picker",
    "fixture=quest-board-new&window=quest-board&quest-board=project-picker&scale=2&camera=town",
  ],
  [
    "05-squad-picker",
    "fixture=quest-board-new&window=quest-board&quest-board=squad-picker&scale=2&camera=town",
  ],
  [
    "06-tactic-picker-preview",
    "fixture=quest-board-new&window=quest-board&quest-board=tactic-picker&scale=2&camera=town",
  ],
  [
    "07-ready-to-launch",
    "fixture=quest-board-ready&window=quest-board&scale=2&camera=town",
  ],
  [
    "08-working-quest",
    "fixture=quest-board-working&window=quest-board&scale=2&camera=town",
  ],
  [
    "09-preparing-review",
    "fixture=quest-board-preparing-review&window=quest-board&scale=2&camera=town",
  ],
  [
    "10-awaiting-review-pr",
    "fixture=quest-board-awaiting-review&window=quest-board&scale=2&camera=town",
  ],
  [
    "11-needs-attention",
    "fixture=quest-board-attention&window=quest-board&scale=2&camera=town",
  ],
  [
    "12-execution-complete-quest-incomplete",
    "fixture=quest-board-execution-complete&window=quest-board&scale=2&camera=town",
  ],
  [
    "13-complete-merged",
    "fixture=quest-board-complete&window=quest-board&scale=2&camera=town",
  ],
  [
    "14-run-again-eligible",
    "fixture=quest-board-closed-unmerged&window=quest-board&scale=2&camera=town",
  ],
  [
    "15-dirty-state-confirmation",
    "fixture=quest-board-dirty&window=quest-board&quest-board=dirty&scale=2&camera=town",
  ],
  [
    "16-project-offline-launchable",
    "fixture=quest-board-project-offline&window=quest-board&scale=2&camera=town",
  ],
  [
    "17-invalid-squad",
    "fixture=quest-board-invalid-squad&window=quest-board&scale=2&camera=town",
  ],
  [
    "18-contextual-tactic-error",
    "fixture=quest-board-tactic-error&window=quest-board&scale=2&camera=town",
  ],
  [
    "19-launching",
    "fixture=quest-board-launching&window=quest-board&quest-board=launching&scale=2&camera=town",
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
  "20-responsive-quest-board",
  "fixture=quest-board-ready&window=quest-board&scale=2&camera=town",
  900,
  600,
  "900x600",
);

await Bun.write(
  resolve(repo, outputRoot, "comparison/AFTER-quest-board-1440x900.png"),
  Bun.file(resolve(repo, outputRoot, "after/1440x900/02-quest-list-ready.png")),
);
await Bun.write(
  resolve(repo, outputRoot, "comparison/BEFORE-quest-board-1440x900.png"),
  Bun.file(
    resolve(repo, outputRoot, "before/quest-board-current-1440x900.png"),
  ),
);
const comparison = Bun.spawn(
  [
    "python3",
    "client/scripts/side-by-side-png.py",
    `${outputRoot}/comparison/BEFORE-quest-board-1440x900.png`,
    `${outputRoot}/comparison/AFTER-quest-board-1440x900.png`,
    `${outputRoot}/comparison/before-after-side-by-side.png`,
  ],
  { cwd: repo, stdout: "inherit", stderr: "inherit" },
);
if ((await comparison.exited) !== 0)
  throw new Error("Before/after comparison failed.");
