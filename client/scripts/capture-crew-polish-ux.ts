#!/usr/bin/env bun
import { resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const base = process.env.QE_CAPTURE_BASE_URL ?? "http://127.0.0.1:1420/";
const outputRoot = "docs/screenshots/crew-polish-ux";

const captures = [
  [
    "01-home-one-project-ocean",
    "worldDemoProjects=1&camera=home&scale=1",
    1_440,
    900,
  ],
  [
    "02-home-four-projects",
    "worldDemoProjects=4&focusWorld=1&scale=1",
    2_560,
    1_800,
  ],
  [
    "03-world-ten-projects",
    "worldDemoProjects=10&focusWorld=1&scale=1",
    3_600,
    2_800,
  ],
  [
    "04-walk-north-1000ms",
    "crewDemo=entering&crewDemoTime=1000&focusProject=crew-demo-a&scale=2",
  ],
  [
    "05a-walk-south-departing-900ms",
    "crewDemo=short&crewDemoTime=900&focusProject=crew-demo-a&scale=2",
  ],
  [
    "05b-walk-east-6000ms",
    "crewDemo=mining&crewDemoTime=6000&focusProject=crew-demo-a&scale=2",
  ],
  [
    "05c-walk-west-5000ms",
    "crewDemo=crafting&crewDemoTime=5000&focusProject=crew-demo-a&scale=2",
  ],
  [
    "06-work-exact-anchor",
    "crewDemo=mining&crewDemoTime=12000&focusProject=crew-demo-a&scale=2",
  ],
  [
    "07-qefacing-fixture",
    "worldTemplate=fixture&crewDemo=facing-fixture&crewDemoTime=12000&focusProject=crew-demo-a&debugMap=1&scale=2",
  ],
  [
    "08a-short-active-500ms",
    "crewDemo=short&crewDemoTime=500&focusProject=crew-demo-a&scale=2",
  ],
  [
    "08b-short-departure-900ms",
    "crewDemo=short&crewDemoTime=900&focusProject=crew-demo-a&scale=2",
  ],
  [
    "08c-short-tail-1500ms",
    "crewDemo=short&crewDemoTime=1500&focusProject=crew-demo-a&scale=2",
  ],
  [
    "09-sequential-handoff",
    "crewDemo=sequential&crewDemoTime=7200&focusProject=crew-demo-a&scale=2",
  ],
  [
    "10-parallel-one-departing",
    "crewDemo=parallel-tail&crewDemoTime=7200&focusProject=crew-demo-a&scale=2",
  ],
  ["11-ocean-between-islands", "worldDemoProjects=4&focusWorld=1&scale=1"],
  [
    "12-normal-zoom",
    "worldDemoProjects=1&focusProject=archipelago-demo-0&scale=2",
  ],
  [
    "13-overview-zoom",
    "worldDemoProjects=10&focusWorld=1&scale=1",
    3_600,
    2_800,
  ],
] as const;

for (const [
  name,
  query,
  captureWidth = 1_440,
  captureHeight = 900,
] of captures) {
  const url = new URL(base);
  url.search = query;
  const child = Bun.spawn(
    [
      "bun",
      "client/scripts/capture-scene.ts",
      `--url=${url}`,
      `--out=${outputRoot}/${name}.png`,
      `--width=${captureWidth}`,
      `--height=${captureHeight}`,
      "--dpr=1",
    ],
    { cwd: repo, stdout: "inherit", stderr: "inherit" },
  );
  if ((await child.exited) !== 0) throw new Error(`Capture failed: ${name}`);
}
