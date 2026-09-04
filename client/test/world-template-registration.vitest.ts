import { describe, expect, test } from "vitest";
import { loadBundledWorldTemplates } from "../src/world/authored/map-loader";
import {
  projectIslandFocusTarget,
  WorldComposer,
} from "../src/world/composition/world-composer";

const project = (id: string) => ({
  id,
  key: `key-${id}`,
  name: `Project ${id}`,
});

function templates(selection?: "production" | "reference-fixture") {
  const result = loadBundledWorldTemplates(selection);
  expect(result.error).toBeNull();
  if (!result.templates) throw result.error;
  return result.templates;
}

describe("Project-island template registration", () => {
  test("normal runtime registers the human-authored production map without fixture-name coupling", () => {
    const source = templates();
    expect(source.projectIsland.templateId).toBe("project-island");
    expect(source.projectIsland.authored.source).toBe(
      "client/src/world/maps/project-island.tmj",
    );
    const semanticIds = [
      ...source.projectIsland.authored.crewNavigation.spawns,
      ...source.projectIsland.authored.crewNavigation.routes,
      ...source.projectIsland.authored.crewNavigation.activities,
      ...source.projectIsland.authored.islandSockets,
    ].map((value) => value.id);
    expect(semanticIds.length).toBeGreaterThan(0);
    expect(semanticIds.every((id) => !id.startsWith("fixture-"))).toBe(true);
  });

  test("the architecture fixture is selected only explicitly", () => {
    const production = templates();
    const fixture = templates("reference-fixture");
    expect(production.projectIsland.authored.source).toBe(
      "client/src/world/maps/project-island.tmj",
    );
    expect(fixture.projectIsland.authored.source).toBe(
      "client/src/world/maps/reference/project-island-fixture.tmj",
    );
    expect(fixture.projectIsland.templateId).toBe("project-island-fixture");
    expect(production.projectExpansion).toBeUndefined();
    expect(fixture.projectExpansion?.templateId).toBe(
      "project-expansion-fixture",
    );
  });

  test("one and multiple Projects receive distinct production instances sharing one template", () => {
    const source = templates();
    const composer = new WorldComposer(source);
    const one = composer.compose({ projects: [project("a")], activeCrew: [] });
    const oneIsland = one.projectIslands.findProjectIsland("a");
    expect(oneIsland).not.toBeNull();
    expect(
      one.regions.find(
        (region) => region.instanceId === oneIsland?.baseRegionId,
      )?.template,
    ).toBe(source.projectIsland);

    const multiple = composer.compose({
      projects: [project("a"), project("b")],
      activeCrew: [],
    });
    const regions = multiple.regions.filter(
      (region) => region.kind === "project",
    );
    expect(regions).toHaveLength(2);
    expect(new Set(regions.map((region) => region.instanceId)).size).toBe(2);
    expect(
      new Set(
        regions.map(
          (region) => `${region.worldOrigin.x}:${region.worldOrigin.y}`,
        ),
      ).size,
    ).toBe(2);
    expect(
      regions.every((region) => region.template === source.projectIsland),
    ).toBe(true);
  });

  test("focusProject resolves the center of the correct production island", () => {
    const source = templates();
    const world = new WorldComposer(source).compose({
      projects: [project("a"), project("b")],
      activeCrew: [],
    });
    const target = projectIslandFocusTarget(world, "b");
    expect(target?.island.project.id).toBe("b");
    expect(target?.island.baseRegionId).toBe("project:b");
    expect(target?.center).toEqual({
      x:
        (target?.island.bounds.x ?? 0) + (target?.island.bounds.width ?? 0) / 2,
      y:
        (target?.island.bounds.y ?? 0) +
        (target?.island.bounds.height ?? 0) / 2,
    });
  });
});
