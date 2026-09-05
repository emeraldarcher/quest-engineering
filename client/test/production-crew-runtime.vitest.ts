import { describe, expect, test } from "vitest";
import { loadBundledWorldTemplates } from "../src/world/authored/map-loader";
import { WorldComposer } from "../src/world/composition/world-composer";
import { ActiveCrewSystem } from "../src/world/crew/ActiveCrewSystem";
import type { ActiveCrewPresentation } from "../src/world/crew/crew-presentation";

const projects = [
  { id: "project-a", key: "project-a", name: "Project A" },
  { id: "project-b", key: "project-b", name: "Project B" },
];

function member(
  index: number,
  projectId = "project-a",
): ActiveCrewPresentation {
  return {
    actorId: `run-${projectId}\0squad\0member-${index}`,
    activityId: `run-${projectId}\0occurrence-${index}`,
    runId: `run-${projectId}`,
    occurrenceId: `occurrence-${index}`,
    projectId,
    projectKey: projectId,
    projectName: projectId,
    memberKey: `member-${index}`,
    memberName: `Member ${index}`,
    classKey: "miner",
    className: "Miner",
    squadKey: "production-crew",
    squadName: "Production Crew",
    squadAccentColor: 0x4e8ca0,
    questTitle: "Production Crew Proof",
    stepName: "Mine",
    activityCategory: "mining",
    workAnimationTag: "mining",
  };
}

function productionWorld() {
  const loaded = loadBundledWorldTemplates();
  expect(loaded.error).toBeNull();
  if (!loaded.templates) throw loaded.error;
  return new WorldComposer(loaded.templates).compose({
    projects,
    activeCrew: [],
  });
}

describe("production Project-island CrewActor runtime", () => {
  test("production exact anchors carry the approved work-facing metadata", () => {
    const island =
      productionWorld().projectIslands.findProjectIsland("project-a");
    const facing = Object.fromEntries(
      (island?.crewNavigation.activities ?? [])
        .filter((activity) => activity.shape === "point")
        .map((activity) => [activity.id.split(":").at(-1), activity.facing]),
    );
    expect(facing).toMatchObject({
      "research-position-1": "south",
      "research-position-2": "south",
      "research-position-3": "south",
      "research-position-4": "south",
      "crafting-position-1": "south",
      "crafting-position-2": "south",
      "crafting-position-3": "south",
      "crafting-position-4": "south",
      "woodcutting-position-1": "east",
      "woodcutting-position-2": "north",
      "woodcutting-position-3": "west",
      "woodcutting-position-4": "north",
      "mining-position-1": "east",
      "mining-position-2": "east",
      "mining-position-3": "north",
      "mining-position-4": "east",
    });
  });

  test("24 active actors exceed exact anchors without disappearing or leaving safe route paths", () => {
    const active = Array.from({ length: 24 }, (_, index) => member(index));
    const system = new ActiveCrewSystem(productionWorld());
    system.reconcile(active);
    const actors = system.actors();
    expect(actors).toHaveLength(24);
    const exact = actors.filter(
      (actor) => actor.claim?.slot.kind === "exact-anchor",
    );
    expect(exact).toHaveLength(4);
    expect(new Set(exact.map((actor) => actor.claim?.slot.id)).size).toBe(4);
    expect(
      actors.every(
        (actor) =>
          actor.path.length >= 2 &&
          actor.path[0]?.x !== undefined &&
          actor.destination.x === actor.claim?.slot.x,
      ),
    ).toBe(true);
  });

  test("a 500ms production crafting Step completes travel, work, wrap, and bounded departure", () => {
    const crafting = member(40);
    crafting.classKey = "builder";
    crafting.className = "Builder";
    crafting.stepName = "Implement a short fix";
    crafting.activityCategory = "crafting";
    crafting.workAnimationTag = "hamering";
    const system = new ActiveCrewSystem(productionWorld());
    system.reconcile([crafting]);
    for (let elapsed = 0; elapsed < 500; elapsed += 16) system.update(16);
    system.reconcile([]);
    const actor = system.actor(crafting.actorId);
    expect(actor?.authoritativeRunning).toBe(false);
    expect(actor?.state).toBe("walking_to_activity");
    const states = new Set(actor ? [actor.state] : []);
    for (let elapsed = 500; elapsed < 15_000; elapsed += 16) {
      system.update(16);
      const state = system.actor(crafting.actorId)?.state;
      if (state) states.add(state);
    }
    expect(states).toContain("wrapping_up");
    expect(states).toContain("departing");
    expect(system.actor(crafting.actorId)).toBeNull();
  });

  test("same-Project Runs share one local graph while another Project uses its own translated graph", () => {
    const active = [member(1), member(2), member(3, "project-b")];
    const world = productionWorld();
    const system = new ActiveCrewSystem(world);
    system.reconcile(active);
    const firstIsland = world.projectIslands.findProjectIsland("project-a");
    const secondIsland = world.projectIslands.findProjectIsland("project-b");
    expect(firstIsland).not.toBeNull();
    expect(secondIsland).not.toBeNull();
    expect(
      system
        .actors()
        .filter((actor) => actor.projectId === "project-a")
        .every((actor) => actor.islandRegionId === firstIsland?.baseRegionId),
    ).toBe(true);
    expect(
      system
        .actors()
        .filter((actor) => actor.projectId === "project-b")
        .every((actor) => actor.islandRegionId === secondIsland?.baseRegionId),
    ).toBe(true);
    expect(firstIsland?.bounds).not.toEqual(secondIsland?.bounds);
  });
});
