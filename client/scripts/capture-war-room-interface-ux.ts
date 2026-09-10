#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const base = process.env.QE_CAPTURE_BASE_URL ?? "http://127.0.0.1:1420/";
const outputRoot = "docs/screenshots/war-room-interface-ux";

const checkpoints = [
  {
    name: "01-empty-new-tactic",
    query:
      "fixture=war-room-empty&window=war-room&war-room=new&scale=2&camera=town",
    width: 1440,
    height: 900,
  },
  {
    name: "02-plan-review-semantic-tree",
    query:
      "fixture=war-room-plan-interface&window=war-room&war-room=until&scale=2&camera=town",
    width: 1440,
    height: 900,
  },
  {
    name: "03-compact-interface-summary",
    query:
      "fixture=war-room-plan-interface&window=war-room&scale=2&camera=town",
    width: 1200,
    height: 800,
  },
  {
    name: "04-interface-editor",
    query:
      "fixture=war-room-plan-interface&window=war-room&war-room=interface&scale=2&camera=town",
    width: 1440,
    height: 900,
  },
  {
    name: "05-output-accepted-quest-plan",
    query:
      "fixture=war-room-plan-interface&window=war-room&war-room=interface&scale=2&camera=town",
    width: 1200,
    height: 800,
  },
  {
    name: "06-optional-input-quest-plan",
    query:
      "fixture=war-room-detail&window=war-room&war-room=interface&scale=2&camera=town",
    width: 1024,
    height: 768,
  },
  {
    name: "07-until-inspector",
    query:
      "fixture=war-room-plan-interface&window=war-room&war-room=until&scale=2&camera=town",
    width: 1200,
    height: 800,
  },
  {
    name: "08-tactic-use-binding",
    query:
      "fixture=war-room-use&window=war-room&war-room=use-delivery&scale=2&camera=town",
    width: 1200,
    height: 800,
  },
  {
    name: "09-nested-semantic-tree",
    query:
      "fixture=war-room-nested-use&window=war-room&war-room=nested-use&scale=2&camera=town",
    width: 1440,
    height: 900,
  },
  {
    name: "10-removal-move-toolbar",
    query:
      "fixture=war-room-detail&window=war-room&war-room=sequence&scale=2&camera=town",
    width: 1024,
    height: 768,
  },
  {
    name: "11-1200-width-workspace",
    query:
      "fixture=war-room-plan-interface&window=war-room&war-room=until&scale=1&camera=town",
    width: 1200,
    height: 800,
  },
  {
    name: "12-full-width-workspace",
    query:
      "fixture=war-room-use&window=war-room&war-room=use-delivery&scale=2&camera=town",
    width: 1440,
    height: 900,
  },
] as const;

await mkdir(resolve(repo, outputRoot), { recursive: true });
for (const checkpoint of checkpoints) {
  const url = new URL(base);
  url.search = checkpoint.query;
  const child = Bun.spawn(
    [
      "bun",
      "client/scripts/capture-scene.ts",
      `--url=${url}`,
      `--out=${outputRoot}/${checkpoint.name}.png`,
      `--width=${checkpoint.width}`,
      `--height=${checkpoint.height}`,
      "--dpr=1",
      "--assertLayout=true",
    ],
    { cwd: repo, stdout: "inherit", stderr: "inherit" },
  );
  if ((await child.exited) !== 0)
    throw new Error(`Capture failed: ${checkpoint.name}`);
}
console.log(`War Room interface UX checkpoints written to ${outputRoot}`);
