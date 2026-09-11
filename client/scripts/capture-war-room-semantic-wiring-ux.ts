#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const base = process.env.QE_CAPTURE_BASE_URL ?? "http://127.0.0.1:1420/";
const outputRoot = "docs/screenshots/war-room-semantic-wiring-ux";

const checkpoints = [
  [
    "01-invalid-review-input",
    "war-room-plan-interface",
    "wiring-invalid-input",
    1440,
    900,
  ],
  [
    "02-quest-plan-input-type",
    "war-room-plan-interface",
    "wiring-plan-input",
    1440,
    900,
  ],
  [
    "03-plan-review-contract",
    "war-room-plan-interface",
    "wiring-review-contract",
    1440,
    900,
  ],
  [
    "04-plan-acceptance-condition",
    "war-room-plan-interface",
    "wiring-plan-condition",
    1200,
    800,
  ],
  [
    "05-remediate-two-inputs",
    "war-room-plan-interface",
    "wiring-remediate",
    1440,
    900,
  ],
  [
    "06-current-quest-plan",
    "war-room-plan-interface",
    "wiring-current-plan",
    1200,
    800,
  ],
  [
    "07-rejected-review-verdict",
    "war-room-plan-interface",
    "wiring-rejected-review",
    1440,
    900,
  ],
  [
    "08-accepted-quest-plan-export",
    "war-room-plan-interface",
    "wiring-accepted-export",
    1440,
    900,
  ],
  [
    "09-internal-output-export",
    "war-room-plan-interface",
    "wiring-internal-export",
    1200,
    800,
  ],
  [
    "10-invalid-draft-summary",
    "war-room-plan-interface",
    "wiring-invalid-summary",
    1440,
    900,
  ],
  [
    "11-valid-plan-review",
    "war-room-plan-interface",
    "wiring-valid-plan",
    1024,
    768,
  ],
  [
    "12-parent-tactic-use-binding",
    "war-room-use",
    "wiring-parent-binding",
    1440,
    900,
  ],
] as const;

await mkdir(resolve(repo, outputRoot), { recursive: true });
for (const [name, fixture, scene, width, height] of checkpoints) {
  const url = new URL(base);
  url.search = new URLSearchParams({
    fixture,
    window: "war-room",
    "war-room": scene,
    scale: "2",
    camera: "town",
  }).toString();
  const child = Bun.spawn(
    [
      "bun",
      "client/scripts/capture-scene.ts",
      `--url=${url}`,
      `--out=${outputRoot}/${name}.png`,
      `--width=${width}`,
      `--height=${height}`,
      "--dpr=1",
      "--assertLayout=true",
    ],
    { cwd: repo, stdout: "inherit", stderr: "inherit" },
  );
  if ((await child.exited) !== 0) throw new Error(`Capture failed: ${name}`);
}
console.log(`War Room semantic wiring checkpoints written to ${outputRoot}`);
