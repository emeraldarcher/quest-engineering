#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const base = process.env.QE_CAPTURE_BASE_URL ?? "http://127.0.0.1:1420/";
const outputRoot = "docs/screenshots/war-room-ux";
const scenes = [
  [
    "01-empty-war-room",
    "fixture=war-room-empty&window=war-room&scale=2&camera=town",
  ],
  [
    "02-tactic-browser-detail",
    "fixture=war-room-detail&window=war-room&scale=2&camera=town",
  ],
  [
    "03-new-tactic",
    "fixture=war-room-new&window=war-room&war-room=new&scale=2&camera=town",
  ],
  [
    "04-simple-sequence-editor",
    "fixture=war-room-detail&window=war-room&war-room=sequence&scale=2&camera=town",
  ],
  [
    "05-step-inspector",
    "fixture=war-room-step&window=war-room&war-room=step&scale=2&camera=town",
  ],
  [
    "06-artifact-flow",
    "fixture=war-room-artifacts&window=war-room&war-room=artifacts&scale=2&camera=town",
  ],
  [
    "07-parallel-editor",
    "fixture=war-room-parallel&window=war-room&war-room=parallel&scale=2&camera=town",
  ],
  [
    "08-until-remediation-editor",
    "fixture=war-room-until&window=war-room&war-room=until&scale=2&camera=town",
  ],
  [
    "09-performer-affinity",
    "fixture=war-room-affinity&window=war-room&war-room=affinity&scale=2&camera=town",
  ],
  [
    "10-context-continuation",
    "fixture=war-room-context&window=war-room&war-room=context&scale=2&camera=town",
  ],
  [
    "11-tactic-use",
    "fixture=war-room-use&window=war-room&war-room=use&scale=2&camera=town",
  ],
  [
    "12-contextual-tactic-warning",
    "fixture=war-room-contextual&window=war-room&war-room=contextual&scale=2&camera=town",
  ],
  [
    "13-cycle-validation-error",
    "fixture=war-room-direct-cycle&window=war-room&war-room=cycle&scale=2&camera=town",
  ],
  [
    "14-shared-tactic-usage",
    "fixture=war-room-shared&window=war-room&war-room=step&scale=2&camera=town",
  ],
  [
    "15-archive-confirmation",
    "fixture=war-room-archive&window=war-room&war-room=archive&scale=2&camera=town",
  ],
  [
    "16-dirty-state-confirmation",
    "fixture=war-room-dirty&window=war-room&war-room=dirty&scale=2&camera=town",
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
  "17-responsive-editor",
  "fixture=war-room-responsive&window=war-room&war-room=step&scale=1&camera=town",
  900,
  600,
  "900x600",
);
await Bun.write(
  resolve(repo, outputRoot, "comparison/AFTER-war-room-1440x900.png"),
  Bun.file(
    resolve(repo, outputRoot, "after/1440x900/02-tactic-browser-detail.png"),
  ),
);
console.log(`War Room checkpoint written to ${outputRoot}`);
