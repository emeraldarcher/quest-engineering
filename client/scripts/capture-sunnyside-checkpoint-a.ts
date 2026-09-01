#!/usr/bin/env bun
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const base = process.env.QE_CAPTURE_BASE_URL ?? "http://127.0.0.1:1420/";
const outputRoot = "docs/screenshots/v0.14b/checkpoint-a";

const captures = [
  [
    "palette/A1-native-cozy",
    "scene=town&palette=native&scale=2&panel=0",
    1440,
    900,
    1,
  ],
  [
    "palette/A2-warm-management",
    "scene=town&palette=management&scale=2&panel=0",
    1440,
    900,
    1,
  ],
  [
    "palette/A3-soft-earthy",
    "scene=town&palette=earthy&scale=2&panel=0",
    1440,
    900,
    1,
  ],
  [
    "scale/S1-1x",
    "scene=parity&palette=management&scale=1&panel=1",
    1440,
    900,
    1,
  ],
  [
    "scale/S2-2x",
    "scene=parity&palette=management&scale=2&panel=1",
    1440,
    900,
    1,
  ],
  [
    "scale/S3-3x",
    "scene=parity&palette=management&scale=3&panel=1",
    1440,
    900,
    1,
  ],
  [
    "comparison/D-sunnyside-semantic-parity",
    "scene=parity&palette=management&scale=2&panel=1",
    1440,
    900,
    1,
  ],
  [
    "composition/B-native-sunnyside-town",
    "scene=town&palette=management&scale=2&panel=0",
    1440,
    900,
    1,
  ],
  [
    "responsive/1280x800",
    "scene=town&palette=management&scale=2&panel=0",
    1280,
    800,
    1,
  ],
  [
    "responsive/900x600",
    "scene=parity&palette=management&scale=2&panel=1",
    900,
    600,
    1,
  ],
  [
    "retina/dpr2",
    "scene=town&palette=management&scale=2&panel=0",
    1440,
    900,
    2,
  ],
] as const;

async function capture(
  name: string,
  query: string,
  width: number,
  height: number,
  dpr: number,
) {
  const url = new URL(base);
  url.search = `spike=sunnyside&${query}`;
  const out = `${outputRoot}/${name}.png`;
  const command = Bun.spawn(
    [
      "bun",
      "client/scripts/capture-scene.ts",
      `--url=${url}`,
      `--out=${out}`,
      `--width=${width}`,
      `--height=${height}`,
      `--dpr=${dpr}`,
    ],
    { cwd: repo, stdout: "inherit", stderr: "inherit" },
  );
  if ((await command.exited) !== 0) throw new Error(`Capture failed: ${name}`);
}

for (const [name, query, width, height, dpr] of captures)
  await capture(name, query, width, height, dpr);

const miniSource = resolve(
  repo,
  "docs/screenshots/v0.14a/1440x900/02-density-scene.png",
);
const miniCopy = resolve(
  repo,
  `${outputRoot}/comparison/M-mini-medieval-v014a.png`,
);
await mkdir(dirname(miniCopy), { recursive: true });
await copyFile(miniSource, miniCopy);

const comparison = Bun.spawn(
  [
    "python3",
    "client/scripts/side-by-side-png.py",
    `${outputRoot}/comparison/M-mini-medieval-v014a.png`,
    `${outputRoot}/comparison/D-sunnyside-semantic-parity.png`,
    `${outputRoot}/comparison/side-by-side.png`,
  ],
  { cwd: repo, stdout: "inherit", stderr: "inherit" },
);
if ((await comparison.exited) !== 0)
  throw new Error("Comparison composition failed.");
