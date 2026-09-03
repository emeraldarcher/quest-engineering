#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const base = process.env.QE_CAPTURE_BASE_URL ?? "http://127.0.0.1:1420/";
const outputRoot = "docs/screenshots/town-hud-ux";
const desktopScenes = [
  ["01-normal-active", "town-hud-active"],
  ["02-working", "town-hud-working"],
  ["03-attention", "town-hud-attention"],
  ["04-reviews", "town-hud-reviews"],
  ["05-mixed", "town-hud-mixed"],
  ["06-idle-zero", "town-hud-idle"],
  ["07-disconnected", "town-hud-disconnected"],
  ["08-first-quest", "town-hud-first-quest"],
] as const;

async function capture(
  name: string,
  fixture: string,
  width: number,
  height: number,
  folder: string,
) {
  const url = new URL(base);
  url.searchParams.set("fixture", fixture);
  url.searchParams.set("scale", width <= 900 ? "1" : "2");
  url.searchParams.set("camera", "town");
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
for (const [name, fixture] of desktopScenes)
  await capture(name, fixture, 1440, 900, "1440x900");
await capture("09-responsive", "town-hud-responsive", 900, 600, "900x600");
await Bun.write(
  resolve(repo, outputRoot, "comparison/BEFORE-toolbar-1440x900.png"),
  Bun.file(
    resolve(repo, outputRoot, "before/top-toolbar-current-1440x900.png"),
  ),
);
await Bun.write(
  resolve(repo, outputRoot, "comparison/AFTER-town-hud-1440x900.png"),
  Bun.file(resolve(repo, outputRoot, "after/1440x900/05-mixed.png")),
);
const comparison = Bun.spawn(
  [
    "python3",
    "client/scripts/side-by-side-png.py",
    `${outputRoot}/comparison/BEFORE-toolbar-1440x900.png`,
    `${outputRoot}/comparison/AFTER-town-hud-1440x900.png`,
    `${outputRoot}/comparison/before-after-side-by-side.png`,
  ],
  { cwd: repo, stdout: "inherit", stderr: "inherit" },
);
if ((await comparison.exited) !== 0)
  throw new Error("Before/after comparison failed.");
console.log(`Town HUD checkpoint written to ${outputRoot}`);
