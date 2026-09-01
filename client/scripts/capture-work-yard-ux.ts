#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const base = process.env.QE_CAPTURE_BASE_URL ?? "http://127.0.0.1:1420/";
const outputRoot = "docs/screenshots/work-yard-ux";

const scenes = [
  [
    "01-run-browser-history",
    "fixture=work-yard-history&window=work-area&scale=2&camera=town",
  ],
  [
    "02-completed-attention-overview",
    "fixture=work-yard-overview&window=work-area&scale=2&camera=town",
  ],
  [
    "03-running-overview",
    "fixture=work-yard-running&window=work-area&scale=2&camera=town",
  ],
  [
    "04-remediation-timeline",
    "fixture=work-yard-remediation&window=work-area&work-yard=remediation&scale=2&camera=town",
  ],
  [
    "05-artifacts-list",
    "fixture=work-yard-artifacts&window=work-area&work-yard=artifacts&scale=2&camera=town",
  ],
  [
    "06-friendly-artifact-detail",
    "fixture=work-yard-artifacts&window=work-area&work-yard=artifact-detail&scale=2&camera=town",
  ],
  [
    "07-custom-artifact-fallback",
    "fixture=work-yard-artifacts&window=work-area&work-yard=artifact-raw&scale=2&camera=town",
  ],
  [
    "08-preparing-review",
    "fixture=preparing-review&window=work-area&work-yard=delivery&scale=2&camera=town",
  ],
  [
    "09-awaiting-pull-request-review",
    "fixture=work-yard-awaiting-review&window=work-area&work-yard=delivery&scale=2&camera=town",
  ],
  [
    "10-merged-quest-complete",
    "fixture=work-yard-merged&window=work-area&scale=2&camera=town",
  ],
  [
    "11-cleanup-available",
    "fixture=work-yard-cleanup&window=work-area&work-yard=delivery&scale=2&camera=town",
  ],
  [
    "12-member-inspector",
    "fixture=work-yard-overview&window=work-area&work-yard=member&scale=2&camera=town",
  ],
  [
    "13-technical-details",
    "fixture=work-yard-overview&window=work-area&work-yard=technical&scale=2&camera=town",
  ],
  [
    "14-empty-state",
    "fixture=work-yard-empty&window=work-area&scale=2&camera=town",
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
  "15-responsive-work-yard",
  "fixture=work-yard-history&window=work-area&scale=2&camera=town",
  900,
  600,
  "900x600",
);

await Bun.write(
  resolve(repo, outputRoot, "comparison/AFTER-work-yard-1440x900.png"),
  Bun.file(
    resolve(
      repo,
      outputRoot,
      "after/1440x900/02-completed-attention-overview.png",
    ),
  ),
);
await Bun.write(
  resolve(repo, outputRoot, "comparison/BEFORE-work-yard-1440x900.png"),
  Bun.file(resolve(repo, outputRoot, "before/work-yard-current-1440x900.png")),
);
const comparison = Bun.spawn(
  [
    "python3",
    "client/scripts/side-by-side-png.py",
    `${outputRoot}/comparison/BEFORE-work-yard-1440x900.png`,
    `${outputRoot}/comparison/AFTER-work-yard-1440x900.png`,
    `${outputRoot}/comparison/before-after-side-by-side.png`,
  ],
  { cwd: repo, stdout: "inherit", stderr: "inherit" },
);
if ((await comparison.exited) !== 0)
  throw new Error("Before/after comparison failed.");
