import { expect, test } from "bun:test";
import { buildCrewRouteGraph } from "../authored/crew-navigation";
import type {
  AuthoredCrewActivity,
  AuthoredCrewNavigation,
  AuthoredWorldRegion,
} from "../authored/map-schema";
import {
  type ProjectIslandInstance,
  ProjectIslandRegistry,
  type WorldComposition,
} from "../composition/world-composer";
import type { WorldRegionInstance } from "../composition/world-region";
import { ActiveCrewSystem } from "./ActiveCrewSystem";
import type { ActiveCrewPresentation } from "./crew-presentation";

function navigation(projectId: string, origin = 0): AuthoredCrewNavigation {
  const routes = [
    {
      id: `${projectId}:road`,
      points: [
        { x: origin, y: 0 },
        { x: origin + 120, y: 0 },
      ],
    },
  ];
  const zones: AuthoredCrewActivity[] = [
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `${projectId}:mining-${index + 1}`,
      activity: "mining" as const,
      shape: "point" as const,
      facing: "west" as const,
      x: origin + 80 + index * 4,
      y: 4,
      width: 0,
      height: 0,
    })),
    {
      id: `${projectId}:mining-district`,
      activity: "mining",
      shape: "rectangle",
      facing: null,
      x: origin + 60,
      y: -6,
      width: 48,
      height: 12,
    },
    {
      id: `${projectId}:crafting-district`,
      activity: "crafting",
      shape: "rectangle",
      facing: null,
      x: origin + 35,
      y: -6,
      width: 24,
      height: 12,
    },
    {
      id: `${projectId}:research-district`,
      activity: "research",
      shape: "rectangle",
      facing: null,
      x: origin + 15,
      y: -6,
      width: 20,
      height: 12,
    },
    {
      id: `${projectId}:general-district`,
      activity: "general",
      shape: "rectangle",
      facing: null,
      x: origin + 5,
      y: -6,
      width: 110,
      height: 12,
    },
  ];
  return {
    enabled: true,
    spawns: [{ id: `${projectId}:dock`, x: origin, y: 0 }],
    routes,
    activities: zones,
    graph: buildCrewRouteGraph(routes),
  };
}

function world(projectIds = ["project-a"]): WorldComposition {
  const islands: ProjectIslandInstance[] = projectIds.map((id, index) => ({
    project: { id, key: id, name: id },
    baseRegionId: `region:${id}`,
    placementSlot: index + 1,
    regionIds: [`region:${id}`],
    bounds: { x: index * 200, y: 0, width: 120, height: 40 },
    crewNavigation: navigation(id, index * 200),
    comfortableVisualCapacity: 10,
    activeActorCount: 0,
    activeRunIds: [],
    workGroups: [],
    attachments: [],
  }));
  const authored = {
    bounds: { x: 0, y: 0, width: 1, height: 1 },
  } as AuthoredWorldRegion;
  const home = {
    instanceId: "home",
    templateId: "home",
    kind: "home",
    worldOrigin: { x: 0, y: 0 },
    localBounds: authored.bounds,
    worldBounds: authored.bounds,
    template: { templateId: "home", kind: "home", authored },
    project: null,
    parentRegionId: null,
  } as WorldRegionInstance;
  return {
    templates: [home.template],
    regions: [home],
    home,
    projectIslands: new ProjectIslandRegistry(islands),
    worldBounds: { x: 0, y: 0, width: 500, height: 500 },
  };
}

function member(
  index: number,
  overrides: Partial<ActiveCrewPresentation> = {},
): ActiveCrewPresentation {
  const projectId = overrides.projectId ?? "project-a";
  return {
    actorId: `run-a\0squad-a\0member-${index}`,
    activityId: `run-a\0occurrence-${index}`,
    runId: "run-a",
    occurrenceId: `occurrence-${index}`,
    projectId,
    projectKey: projectId,
    projectName: projectId,
    memberKey: `member-${index}`,
    memberName: `Member ${index}`,
    classKey: "builder",
    className: "Builder",
    squadKey: "squad-a",
    squadName: "Squad A",
    squadAccentColor: 0x4e8ca0,
    questTitle: "Quest",
    stepName: "Mine ore",
    activityCategory: "mining",
    workAnimationTag: "mining",
    ...overrides,
  };
}

function settle(system: ActiveCrewSystem): void {
  for (let index = 0; index < 800; index += 1) system.update(16);
}

test("active-only reconciliation handles 0, 1, 2, 12, and 24 actors without capacity loss", () => {
  for (const count of [0, 1, 2, 12, 24]) {
    const system = new ActiveCrewSystem(world());
    system.reconcile(
      Array.from({ length: count }, (_, index) => member(index)),
    );
    expect(system.actors()).toHaveLength(count);
    expect(
      new Set(
        system
          .actors()
          .filter((actor) => actor.claim?.slot.kind === "exact-anchor")
          .map((actor) => actor.claim?.slot.id),
      ).size,
    ).toBeLessThanOrEqual(4);
  }
});

test("actors spawn at the dock, walk authored routes, work, relocate, and disappear", () => {
  const system = new ActiveCrewSystem(world());
  const initial = member(1);
  system.reconcile([initial]);
  const actor = system.actor(initial.actorId);
  expect(actor?.state).toBe("entering");
  expect(actor?.position).toEqual({ x: 0, y: 0 });
  expect(actor?.path.length).toBeGreaterThan(2);
  system.update(16);
  expect(actor?.state).toBe("walking_to_activity");
  expect(actor?.animationTag).toBe("walk-se");
  expect(actor?.path.slice(0, -1).every((point) => point.y === 0)).toBe(true);
  settle(system);
  expect(actor?.state).toBe("working");
  expect(actor?.animationTag).toBe("mining");

  system.reconcile([
    member(1, {
      activityId: "run-a\0review",
      occurrenceId: "review",
      stepName: "Review",
      activityCategory: "research",
      workAnimationTag: "doing",
    }),
  ]);
  expect(system.actor(initial.actorId)).toBe(actor);
  expect(actor?.state).toBe("relocating");
  settle(system);
  expect(actor?.animationTag).toBe("doing");
  system.reconcile([]);
  expect(actor?.authoritativeRunning).toBe(false);
  expect(actor?.state).toBe("wrapping_up");
  for (let index = 0; index < 300; index += 1) system.update(16);
  expect(system.actors()).toHaveLength(0);
});

test("sequential Implement to Review replaces Builder with Reviewer at the dock", () => {
  const system = new ActiveCrewSystem(world());
  const builder = member(1, {
    stepName: "Implement",
    activityCategory: "crafting",
    workAnimationTag: "hamering",
  });
  system.reconcile([builder]);
  settle(system);
  expect(system.actor(builder.actorId)?.animationTag).toBe("hamering");
  const reviewer = member(2, {
    actorId: "run-a\0squad-a\0reviewer",
    memberKey: "reviewer",
    memberName: "Reviewer",
    classKey: "reviewer",
    className: "Reviewer",
    stepName: "Review",
    activityCategory: "research",
    workAnimationTag: "doing",
  });
  system.reconcile([reviewer]);
  expect(system.actor(builder.actorId)?.authoritativeRunning).toBe(false);
  expect(system.actor(builder.actorId)?.state).toBe("wrapping_up");
  expect(system.actor(reviewer.actorId)?.state).toBe("entering");
  expect(system.actor(reviewer.actorId)?.position).toEqual({ x: 0, y: 0 });
});

test("Parallel actors reconcile independently", () => {
  const system = new ActiveCrewSystem(world());
  const first = member(1);
  const second = member(2, {
    actorId: "run-a\0squad-a\0reviewer",
    memberKey: "reviewer",
    activityCategory: "research",
    workAnimationTag: "doing",
  });
  system.reconcile([first, second]);
  settle(system);
  const preserved = system.actor(second.actorId);
  system.reconcile([second]);
  expect(system.actor(first.actorId)?.authoritativeRunning).toBe(false);
  expect(system.actor(second.actorId)).toBe(preserved);
  expect(preserved?.authoritativeRunning).toBe(true);
  expect(preserved?.state).toBe("working");
});

test("a very short semantic Step becomes a bounded presentation-only departure", () => {
  const system = new ActiveCrewSystem(world());
  const active = member(1);
  system.reconcile([active]);
  for (let frame = 0; frame < 38; frame += 1) system.update(16);
  system.reconcile([]);
  const tail = system.actor(active.actorId);
  expect(tail?.authoritativeRunning).toBe(false);
  expect(tail?.state).toBe("departing");
  for (let frame = 0; frame < 50; frame += 1) system.update(16);
  expect(system.actor(active.actorId)).toBe(tail);
  for (let frame = 0; frame < 140; frame += 1) system.update(16);
  expect(system.actor(active.actorId)).toBeNull();
});

test("arrival receives a minimum readable work beat before departure", () => {
  const system = new ActiveCrewSystem(world());
  const active = member(1);
  system.reconcile([active]);
  while (system.actor(active.actorId)?.state !== "working") system.update(16);
  system.reconcile([]);
  for (let frame = 0; frame < 30; frame += 1) system.update(16);
  const wrapping = system.actor(active.actorId);
  expect(wrapping?.state).toBe("wrapping_up");
  if (!wrapping) throw new Error("Missing wrapping actor");
  expect(system.minimumWorkRemaining(wrapping)).toBeGreaterThan(0);
  for (let frame = 0; frame < 35; frame += 1) system.update(16);
  expect(system.actor(active.actorId)?.state).toBe("departing");
});

test("long active work receives no artificial completion or departure", () => {
  const system = new ActiveCrewSystem(world());
  const active = member(1);
  system.reconcile([active]);
  settle(system);
  for (let frame = 0; frame < 600; frame += 1) system.update(16);
  expect(system.actor(active.actorId)?.authoritativeRunning).toBe(true);
  expect(system.actor(active.actorId)?.state).toBe("working");
});

test("a consecutive occurrence reuses a departing same-Run Member actor", () => {
  const system = new ActiveCrewSystem(world());
  const active = member(1);
  system.reconcile([active]);
  system.update(500);
  system.reconcile([]);
  const actor = system.actor(active.actorId);
  expect(actor?.state).toBe("departing");
  system.reconcile([
    member(1, {
      activityId: "run-a\0repair",
      occurrenceId: "repair",
      stepName: "Repair",
      activityCategory: "crafting",
      workAnimationTag: "hamering",
    }),
  ]);
  expect(system.actor(active.actorId)).toBe(actor);
  expect(actor?.authoritativeRunning).toBe(true);
  expect(actor?.state).toBe("relocating");
});

test("authored exact-anchor facing overrides deterministic approach fallback", () => {
  const system = new ActiveCrewSystem(world());
  const miner = member(1);
  system.reconcile([miner]);
  settle(system);
  expect(system.actor(miner.actorId)).toMatchObject({
    facing: "southwest",
    workFacingSource: "authored qeFacing",
    mirrorX: true,
  });

  const crafter = member(2, {
    actorId: "run-b\0squad-a\0crafter",
    runId: "run-b",
    activityCategory: "crafting",
    workAnimationTag: "hamering",
  });
  system.reconcile([miner, crafter]);
  settle(system);
  expect(system.actor(crafter.actorId)?.workFacingSource).toBe(
    "approach fallback",
  );
});

test("duplicate realtime facts preserve actor state and claims", () => {
  const system = new ActiveCrewSystem(world());
  const active = member(1);
  system.reconcile([active]);
  system.update(16);
  const actor = system.actor(active.actorId);
  const claim = actor?.claim;
  const position = actor?.position;
  system.reconcile([{ ...active }]);
  expect(system.actor(active.actorId)).toBe(actor);
  expect(actor?.claim).toBe(claim);
  expect(actor?.position).toEqual(position);
});

test("LaunchSnapshot Project identity isolates route graphs across islands", () => {
  const system = new ActiveCrewSystem(world(["project-a", "project-b"]));
  system.reconcile([
    member(1, { projectId: "project-a", runId: "run-same" }),
    member(2, {
      actorId: "run-b\0squad-b\0member-2",
      projectId: "project-b",
      runId: "run-b",
    }),
  ]);
  const actors = system.actors();
  expect(actors.map((actor) => actor.islandRegionId).sort()).toEqual([
    "region:project-a",
    "region:project-b",
  ]);
  expect(actors[0]?.path.every((point) => point.x <= 120)).toBe(true);
  expect(actors[1]?.path.every((point) => point.x >= 200)).toBe(true);
});

test("repeated realtime reconciliation does not leak presentation actors", () => {
  const system = new ActiveCrewSystem(world());
  const active = Array.from({ length: 24 }, (_, index) => member(index));
  for (let iteration = 0; iteration < 50; iteration += 1) {
    system.reconcile(active);
    system.update(16);
    system.reconcile([]);
    for (let frame = 0; frame < 180; frame += 1) system.update(16);
  }
  expect(system.actors()).toHaveLength(0);
});

test("shared roads receive small deterministic lateral lane offsets", () => {
  const system = new ActiveCrewSystem(world());
  system.reconcile([member(1), member(2)]);
  system.update(16);
  const actors = system.actors();
  expect(actors[0]?.laneOffset).not.toBe(actors[1]?.laneOffset);
  expect(actors.every((actor) => Math.abs(actor.laneOffset) <= 1.5)).toBe(true);
});
