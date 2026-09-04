#!/usr/bin/env bun
import { resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const base = process.env.QE_CAPTURE_BASE_URL ?? "http://127.0.0.1:1420/";
const outputRoot = "docs/screenshots/checkpoint-c";

const captures = [
  ["00-no-active-crew", "none", 0, "", ""],
  ["walk/00-dock", "entering", 0, "crew-demo-a", ""],
  ["walk/01-directional", "entering", 1000, "crew-demo-a", ""],
  ["walk/02-route-progress", "entering", 3000, "crew-demo-a", ""],
  ["work/01-crafting", "crafting", 12000, "crew-demo-a", ""],
  ["work/02-research-review", "research", 12000, "crew-demo-a", ""],
  ["work/03-mining", "mining", 12000, "crew-demo-a", ""],
  ["work/04-woodcutting", "woodcutting", 12000, "crew-demo-a", ""],
  ["parallel-two-squads", "parallel", 12000, "crew-demo-a", ""],
  ["multiple-projects/01-project-a", "showcase", 12000, "crew-demo-a", ""],
  ["multiple-projects/02-project-b", "showcase", 12000, "crew-demo-b", ""],
  ["hover", "parallel", 12000, "crew-demo-a", "1"],
] as const;

for (const [name, scenario, time, focus, hover] of captures) {
  const url = new URL(base);
  url.searchParams.set("crewDemo", scenario);
  url.searchParams.set("crewDemoTime", String(time));
  url.searchParams.set("scale", "2");
  if (focus) url.searchParams.set("focusProject", focus);
  if (hover) url.searchParams.set("crewDemoHover", hover);
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
