import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { RunProjection, SnapshotMember } from "../../api/contracts";
import {
  parseAuthoredTownMap,
  parseAuthoredWorldRegion,
  type TiledTilesetResource,
} from "../authored/map-validation";
import type { TiledMapJson } from "../authored/tiled-types";
import type { ActiveCrewActivity } from "../crew/active-crew";
import { findCrewPath } from "../crew/CrewNavigation";
import { regionIsVisible } from "../rendering/region-culling";
import { WorldComposer, type WorldComposerTemplates } from "./world-composer";
import type {
  RegionProjectIdentity,
  WorldRegionTemplate,
} from "./world-region";

const maps = resolve(import.meta.dir, "../maps");

async function authored(
  relative: string,
  profile: "home" | "project_island" | "project_expansion",
) {
  const mapPath = resolve(maps, relative);
  const map = (await Bun.file(mapPath).json()) as TiledMapJson;
  const resources: Record<string, TiledTilesetResource> = {};
  for (const reference of map.tilesets) {
    const path = resolve(dirname(mapPath), reference.source);
    resources[reference.source] = {
      source: reference.source,
      basePath: dirname(path),
      json: await Bun.file(path).json(),
      resolveImage: (source) => {
        const imagePath = resolve(dirname(path), source);
        return existsSync(imagePath) ? imagePath : null;
      },
    };
  }
  return profile === "home"
    ? parseAuthoredTownMap(map, resources, mapPath)
    : parseAuthoredWorldRegion(map, resources, mapPath, profile);
}

async function templates(): Promise<WorldComposerTemplates> {
  const home: WorldRegionTemplate = {
    templateId: "home-town",
    kind: "home",
    authored: await authored("town.tmj", "home"),
  };
  const projectIsland: WorldRegionTemplate = {
    templateId: "project-island-fixture",
    kind: "project",
    authored: await authored(
      "reference/project-island-fixture.tmj",
      "project_island",
    ),
  };
  const projectExpansion: WorldRegionTemplate = {
    templateId: "project-expansion-fixture",
    kind: "expansion",
    authored: await authored(
      "reference/project-expansion-fixture.tmj",
      "project_expansion",
    ),
  };
  return { home, projectIsland, projectExpansion };
}

function projects(count: number): RegionProjectIdentity[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `project-${String(index + 1).padStart(3, "0")}`,
    key: `project-${index + 1}`,
    name: `Project ${index + 1}`,
  }));
}

const member: SnapshotMember = {
  member_key: "rowan",
  name: "Rowan",
  class: { id: "class-builder", key: "builder", name: "Builder" },
  loadout: { id: "loadout", key: "coding", name: "Coding" },
};

function activity(
  project: RegionProjectIdentity,
  runId: string,
  suffix = "1",
): ActiveCrewActivity {
  const workspace: RunProjection["execution_environment"]["workspace"] =
    project;
  return {
    activityId: `${runId}:${suffix}`,
    actorId: `${runId}:rowan:${suffix}`,
    runId,
    quest: {
      id: `quest-${runId}`,
      title: `Quest ${runId}`,
      objective: "Prove composition",
    },
    project: workspace,
    squad: { id: "squad", key: "engineering-pair", name: "Engineering Pair" },
    member: { ...member, member_key: `rowan-${suffix}` },
    occurrenceId: `occurrence-${suffix}`,
    stepKey: `step-${suffix}`,
    stepName: "Build",
    stepInstruction: null,
    state: "running",
  };
}

function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

test("Home-only composition preserves the authored Home origin and bounds", async () => {
  const world = new WorldComposer(await templates()).compose({
    projects: [],
    activeCrew: [],
  });
  expect(world.regions).toHaveLength(1);
  expect(world.home.worldOrigin).toEqual({ x: 0, y: 0 });
  expect(world.worldBounds).toEqual(world.home.template.authored.bounds);
  expect(world.home.template.authored.profile).toBe("home");
});

test("one, three, and ten Projects receive deterministic non-overlapping islands", async () => {
  const composer = new WorldComposer(await templates());
  for (const count of [1, 3, 10]) {
    const input = projects(count);
    const world = composer.compose({ projects: input, activeCrew: [] });
    const islands = world.projectIslands.values();
    expect(islands).toHaveLength(count);
    for (const [index, island] of islands.entries()) {
      expect(overlaps(island.bounds, world.home.worldBounds)).toBe(false);
      for (const other of islands.slice(index + 1))
        expect(overlaps(island.bounds, other.bounds)).toBe(false);
    }
    const reordered = composer.compose({
      projects: [...input].reverse(),
      activeCrew: [],
    });
    expect(
      reordered.projectIslands
        .values()
        .map((island) => [island.project.id, island.bounds.x, island.bounds.y]),
    ).toEqual(
      islands.map((island) => [
        island.project.id,
        island.bounds.x,
        island.bounds.y,
      ]),
    );
  }
});

test("active Project identity comes from the Run launch snapshot", async () => {
  const composer = new WorldComposer(await templates());
  const snapshot = {
    id: "project-stable",
    key: "launch-snapshot-key",
    name: "Launch Snapshot Project",
  };
  const world = composer.compose({
    projects: [
      {
        id: snapshot.id,
        key: "mutable-current-key",
        name: "Mutable current name",
      },
    ],
    activeCrew: [activity(snapshot, "run-a")],
  });
  expect(world.projectIslands.findProjectIsland(snapshot.id)?.project).toEqual(
    snapshot,
  );
});

test("Run work groups share their Project island and separate across Projects", async () => {
  const composer = new WorldComposer(await templates());
  const [a, b] = projects(2) as [RegionProjectIdentity, RegionProjectIdentity];
  const world = composer.compose({
    projects: [a, b],
    activeCrew: [
      activity(a, "run-a", "1"),
      activity(a, "run-b", "2"),
      activity(b, "run-c", "3"),
    ],
  });
  expect(world.projectIslands.findProjectIsland(a.id)?.activeRunIds).toEqual([
    "run-a",
    "run-b",
  ]);
  expect(world.projectIslands.findProjectIsland(b.id)?.activeRunIds).toEqual([
    "run-c",
  ]);
  expect(world.projectIslands.findProjectIsland(a.id)?.workGroups).toHaveLength(
    2,
  );
});

test("fixture expansion composes by socket and joins the Project-local route network", async () => {
  const composer = new WorldComposer(await templates());
  const project = projects(1)[0] as RegionProjectIdentity;
  const world = composer.compose({
    projects: [project],
    activeCrew: [],
    expansionProjectIds: new Set([project.id]),
  });
  const island = world.projectIslands.findProjectIsland(project.id);
  expect(island?.regionIds).toHaveLength(2);
  expect(island?.attachments).toHaveLength(1);
  expect(island?.crewNavigation.activities).toHaveLength(3);
  const spawn = island?.crewNavigation.spawns[0];
  const expansionActivity = island?.crewNavigation.activities.find((zone) =>
    zone.id.includes("expansion"),
  );
  expect(spawn).toBeDefined();
  expect(expansionActivity).toBeDefined();
  expect(
    findCrewPath(island?.crewNavigation.graph ?? { nodes: [], edges: [] }, {
      start: spawn as { x: number; y: number },
      destination: {
        x: (expansionActivity?.x ?? 0) + (expansionActivity?.width ?? 0) / 2,
        y: (expansionActivity?.y ?? 0) + (expansionActivity?.height ?? 0) / 2,
      },
    }),
  ).not.toBeNull();
});

test("50 lightweight Project regions compose quickly, share templates, and cull offscreen", async () => {
  const source = await templates();
  const composer = new WorldComposer(source);
  const started = performance.now();
  const world = composer.compose({ projects: projects(50), activeCrew: [] });
  const elapsed = performance.now() - started;
  expect(elapsed).toBeLessThan(500);
  const projectRegions = world.regions.filter(
    (region) => region.kind === "project",
  );
  expect(projectRegions).toHaveLength(50);
  expect(
    new Set(
      projectRegions.map(
        (region) => `${region.worldOrigin.x}:${region.worldOrigin.y}`,
      ),
    ).size,
  ).toBe(50);
  expect(
    projectRegions.every((region) => region.template === source.projectIsland),
  ).toBe(true);
  const homeViewport = world.home.worldBounds;
  const visible = world.regions.filter((region) =>
    regionIsVisible(region.worldBounds, homeViewport),
  );
  expect(visible.length).toBeLessThan(world.regions.length);
});
