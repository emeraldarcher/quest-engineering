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
