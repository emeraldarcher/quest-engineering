#!/usr/bin/env bun
import { resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const base = process.env.QE_CAPTURE_BASE_URL ?? "http://127.0.0.1:1420/";
const outputRoot = "docs/screenshots/crew-grounding-ux";
type Capture = readonly [string, string];
const project = "focusProject=crew-demo-a&scale=2";
const calibration = (animation: string, elapsed = 0, extra = "") =>
  `worldDemoProjects=1&groundingAnimation=${animation}&groundingElapsed=${elapsed}&focusProject=archipelago-demo-0&scale=3${extra}`;
const direction = (value: string) =>
  `worldDemoProjects=1&facingSheet=1&facingDirection=${value}&focusProject=archipelago-demo-0&scale=3`;

const captures: Capture[] = [
  ["01-ground-crosshair/idle", calibration("idle")],
  ["02-idle-feet/frame-0", calibration("idle", 0)],
  ["02-idle-feet/frame-2", calibration("idle", 400)],
  ["03-walk-feet/frame-0", calibration("walk-s", 0)],
  ["03-walk-feet/frame-3", calibration("walk-s", 300)],
  ["03-walk-feet/frame-7", calibration("walk-s", 700)],
  ["04-hammering-feet/frame-0", calibration("hamering", 0)],
  ["04-hammering-feet/frame-mid", calibration("hamering", 825)],
  ["04-hammering-feet/frame-end", calibration("hamering", 1650)],
  ["05-mining-feet/frame-0", calibration("mining", 0)],
  ["05-mining-feet/frame-mid", calibration("mining", 375)],
  ["06-axe-feet/frame-0", calibration("axe", 0)],
  ["06-axe-feet/frame-mid", calibration("axe", 375)],
  ["07-doing-feet", calibration("doing", 300)],
  ["08-shadow-squad-rim", `crewDemo=short-500&crewDemoTime=8500&${project}`],
  ["09-facing/north", direction("north")],
  ["09-facing/south", direction("south")],
  ["09-facing/east", direction("east")],
  ["09-facing/west", direction("west")],
  [
    "09-facing/diagonals",
    "worldDemoProjects=1&facingSheet=1&focusProject=archipelago-demo-0&scale=2",
  ],
  [
    "10-route-velocity-ground-debug",
    `crewDemo=entering&crewDemoTime=2500&${project}&debugMap=1`,
  ],
  [
    "11-exact-crafting-anchor",
    `crewDemo=short-500&crewDemoTime=8500&${project}`,
  ],
  ["12-exact-mining-anchor", `crewDemo=mining&crewDemoTime=9000&${project}`],
  ["13-task-500ms/01-spawn", `crewDemo=short-500&crewDemoTime=0&${project}`],
  [
    "13-task-500ms/02-semantic-complete",
    `crewDemo=short-500&crewDemoTime=500&${project}`,
  ],
  [
    "13-task-500ms/03-mid-walk",
    `crewDemo=short-500&crewDemoTime=2500&${project}`,
  ],
  [
    "13-task-500ms/04-arrival",
    `crewDemo=short-500&crewDemoTime=7000&${project}`,
  ],
  [
    "13-task-500ms/05-readable-work",
    `crewDemo=short-500&crewDemoTime=8500&${project}`,
  ],
  ["13-task-500ms/06-wrap", `crewDemo=short-500&crewDemoTime=10300&${project}`],
  [
    "13-task-500ms/07-depart",
    `crewDemo=short-500&crewDemoTime=10800&${project}`,
  ],
  [
    "13-task-500ms/08-removed",
    `crewDemo=short-500&crewDemoTime=15000&${project}`,
  ],
  [
    "14-task-1500ms/01-semantic-complete",
    `crewDemo=short-1500&crewDemoTime=1500&${project}`,
  ],
  [
    "14-task-1500ms/02-readable-work",
    `crewDemo=short-1500&crewDemoTime=8500&${project}`,
  ],
  [
    "14-task-1500ms/03-depart",
    `crewDemo=short-1500&crewDemoTime=10800&${project}`,
  ],
  [
    "15-duration-candidates/2000ms",
    `crewDemo=short-500&crewDemoTime=10000&crewDemoMinimumWork=2000&${project}`,
  ],
  [
    "15-duration-candidates/2500ms",
    `crewDemo=short-500&crewDemoTime=10000&crewDemoMinimumWork=2500&${project}`,
  ],
  [
    "15-duration-candidates/3000ms-selected",
    `crewDemo=short-500&crewDemoTime=10000&crewDemoMinimumWork=3000&${project}`,
  ],
  [
    "15-duration-candidates/3500ms",
    `crewDemo=short-500&crewDemoTime=10000&crewDemoMinimumWork=3500&${project}`,
  ],
  [
    "16-recording-repro/before-legacy-anchor",
    calibration("walk-s", 300, "&groundingLegacy=1"),
  ],
  ["16-recording-repro/after-grounded-anchor", calibration("walk-s", 300)],
  ["17-final-no-actors", `crewDemo=short-500&crewDemoTime=15000&${project}`],
];

for (const [name, query] of captures) {
  const url = new URL(base);
  url.search = query;
  const child = Bun.spawn(
    [
      "bun",
      "client/scripts/capture-scene.ts",
      `--url=${url}`,
      `--out=${outputRoot}/${name}.png`,
      "--width=1440",
      "--height=900",
      "--dpr=1",
    ],
    { cwd: repo, stdout: "inherit", stderr: "inherit" },
  );
  if ((await child.exited) !== 0) throw new Error(`Capture failed: ${name}`);
}
