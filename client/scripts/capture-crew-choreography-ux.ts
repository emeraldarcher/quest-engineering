#!/usr/bin/env bun
import { resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const base = process.env.QE_CAPTURE_BASE_URL ?? "http://127.0.0.1:1420/";
const outputRoot = "docs/screenshots/crew-choreography-ux";

type Capture = readonly [string, string, number?, number?];
const project = "focusProject=crew-demo-a&scale=2";
const timeline = (
  folder: string,
  scenario: string,
  completionMs: number,
  long = false,
): Capture[] => {
  const times = long
    ? [0, 2_500, completionMs, 7_000, 8_500, 30_300, 30_800, 35_000]
    : [0, 2_500, completionMs, 7_000, 8_000, 9_200, 9_700, 15_000];
  const phases = [
    "spawn",
    "mid-walk",
    "semantic-completion",
    "arrival",
    "work-beat",
    "wrap-up",
    "departure",
    "removed",
  ];
  return times.map((time, index) => [
    `${folder}/${String(index + 1).padStart(2, "0")}-${phases[index]}-${time}ms`,
    `crewDemo=${scenario}&crewDemoTime=${time}&${project}`,
  ]);
};

const captures: Capture[] = [
  [
    "01-facing-sheet/8-directions",
    "worldDemoProjects=1&facingSheet=1&focusProject=archipelago-demo-0&scale=2",
  ],
  [
    "02-research-facing/exact-anchors",
    `crewDemo=research-facing&crewDemoTime=10000&${project}`,
  ],
  [
    "03-crafting-facing/exact-anchors",
    `crewDemo=crafting-facing&crewDemoTime=10000&${project}`,
  ],
  [
    "04-woodcutting-facing/east-west-north",
    `crewDemo=woodcutting-facing&crewDemoTime=10000&${project}`,
  ],
  [
    "05-mining-facing/east-north",
    `crewDemo=mining-facing&crewDemoTime=10000&${project}`,
  ],
  ...timeline("06-task-500ms", "short-500", 500),
  ...timeline("07-task-1500ms", "short-1500", 1_500),
  ...timeline("08-task-5000ms", "short-5000", 5_000),
  ...timeline("09-task-long", "long-running", 30_000, true),
  [
    "10-real-short-quest/01-semantic-complete",
    `crewDemo=real-short-crafting&crewDemoTime=500&${project}`,
  ],
  [
    "10-real-short-quest/02-arrival",
    `crewDemo=real-short-crafting&crewDemoTime=7000&${project}`,
  ],
  [
    "10-real-short-quest/03-readable-crafting",
    `crewDemo=real-short-crafting&crewDemoTime=8000&${project}`,
  ],
  [
    "10-real-short-quest/04-wrap",
    `crewDemo=real-short-crafting&crewDemoTime=9200&${project}`,
  ],
  [
    "10-real-short-quest/05-depart",
    `crewDemo=real-short-crafting&crewDemoTime=9700&${project}`,
  ],
  [
    "11-builder-reviewer-handoff",
    `crewDemo=sequential&crewDemoTime=7200&${project}`,
  ],
  ["12-parallel-tail", `crewDemo=parallel-tail&crewDemoTime=7200&${project}`],
  [
    "13-same-member-relocation",
    `crewDemo=same-member-relocation&crewDemoTime=7200&${project}`,
  ],
  ["14-final-no-actors", `crewDemo=short-500&crewDemoTime=15000&${project}`],
  [
    "15-facing-telemetry",
    `crewDemo=entering&crewDemoTime=2500&${project}&debugMap=1`,
  ],
  [
    "timing-candidates/1500ms",
    `crewDemo=short-500&crewDemoTime=8800&crewDemoMinimumWork=1500&${project}`,
  ],
  [
    "timing-candidates/2000ms-selected",
    `crewDemo=short-500&crewDemoTime=8800&crewDemoMinimumWork=2000&${project}`,
  ],
  [
    "timing-candidates/2500ms",
    `crewDemo=short-500&crewDemoTime=8800&crewDemoMinimumWork=2500&${project}`,
  ],
];

for (const [name, query, width = 1_440, height = 900] of captures) {
  const url = new URL(base);
  url.search = query;
  const child = Bun.spawn(
    [
      "bun",
      "client/scripts/capture-scene.ts",
      `--url=${url}`,
      `--out=${outputRoot}/${name}.png`,
      `--width=${width}`,
      `--height=${height}`,
      "--dpr=1",
    ],
    { cwd: repo, stdout: "inherit", stderr: "inherit" },
  );
  if ((await child.exited) !== 0) throw new Error(`Capture failed: ${name}`);
}
