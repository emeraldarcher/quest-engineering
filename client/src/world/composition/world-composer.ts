import { buildCrewRouteGraph } from "../authored/crew-navigation";
import type { AuthoredCrewNavigation, TownRect } from "../authored/map-schema";
import type { ActiveCrewActivity } from "../crew/active-crew";
import {
  attachExpansion,
  comfortableVisualCapacity,
  type ExpansionAttachment,
} from "./expansion-composer";
import { placementGrid, placeProjects } from "./world-placement";
import {
  instantiateWorldRegion,
  padWorldBounds,
  type RegionProjectIdentity,
  translateRect,
  unionWorldBounds,
  type WorldRegionInstance,
  type WorldRegionTemplate,
  worldCrewNavigation,
} from "./world-region";

export interface RunWorkGroup {
  id: string;
  runId: string;
  projectId: string;
  questId: string;
  questTitle: string;
  squadId: string;
  activityIds: string[];
}

export interface ProjectIslandInstance {
  project: RegionProjectIdentity;
  baseRegionId: string;
  placementSlot: number;
  regionIds: string[];
  bounds: TownRect;
  crewNavigation: AuthoredCrewNavigation;
  comfortableVisualCapacity: number;
  activeActorCount: number;
  activeRunIds: string[];
  workGroups: RunWorkGroup[];
  attachments: ExpansionAttachment[];
}

export class ProjectIslandRegistry {
  private readonly byProject = new Map<string, ProjectIslandInstance>();

  constructor(islands: readonly ProjectIslandInstance[]) {
    for (const island of islands) this.byProject.set(island.project.id, island);
  }

  findProjectIsland(projectId: string): ProjectIslandInstance | null {
    return this.byProject.get(projectId) ?? null;
  }

  values(): ProjectIslandInstance[] {
    return [...this.byProject.values()].sort((a, b) =>
      a.project.id.localeCompare(b.project.id),
    );
  }
}

export interface WorldComposition {
  templates: WorldRegionTemplate[];
  regions: WorldRegionInstance[];
  home: WorldRegionInstance;
  projectIslands: ProjectIslandRegistry;
  worldBounds: TownRect;
}

export interface ProjectIslandFocusTarget {
  island: ProjectIslandInstance;
  center: { x: number; y: number };
}

/** Home management space plus nearby first-ring islands for discovery. */
export function homeArchipelagoOverviewBounds(
  composition: WorldComposition,
): TownRect {
  const home = translateRect(
    composition.home.template.authored.functionalTownBounds,
    composition.home.worldOrigin,
  );
  const nearby = composition.projectIslands
    .values()
    .filter((island) => island.placementSlot <= 8)
    .map((island) => island.bounds);
  return unionWorldBounds([home, ...nearby]);
}

export function projectIslandFocusTarget(
  composition: WorldComposition,
  projectId: string,
): ProjectIslandFocusTarget | null {
  const island = composition.projectIslands.findProjectIsland(projectId);
  if (!island) return null;
  return {
    island,
    center: {
      x: island.bounds.x + island.bounds.width / 2,
      y: island.bounds.y + island.bounds.height / 2,
    },
  };
}

export interface WorldComposerTemplates {
  home: WorldRegionTemplate;
  projectIsland: WorldRegionTemplate;
  projectExpansion?: WorldRegionTemplate;
}

export interface ComposeWorldInput {
  projects: readonly RegionProjectIdentity[];
  activeCrew: readonly ActiveCrewActivity[];
  expansionProjectIds?: ReadonlySet<string>;
}

function activeProjects(input: ComposeWorldInput): RegionProjectIdentity[] {
  const projects = new Map(
    input.projects.map((project) => [project.id, project]),
  );
  const launchSnapshots = [...input.activeCrew].sort(
    (a, b) =>
      a.project.id.localeCompare(b.project.id) ||
      a.runId.localeCompare(b.runId) ||
      a.activityId.localeCompare(b.activityId),
  );
  const seen = new Set<string>();
  for (const activity of launchSnapshots) {
    if (seen.has(activity.project.id)) continue;
    seen.add(activity.project.id);
    projects.set(activity.project.id, activity.project);
  }
  return [...projects.values()];
}

function groupsFor(
  projectId: string,
  activities: readonly ActiveCrewActivity[],
): RunWorkGroup[] {
  const groups = new Map<string, ActiveCrewActivity[]>();
  for (const activity of activities) {
    if (activity.project.id !== projectId) continue;
    const values = groups.get(activity.runId) ?? [];
    values.push(activity);
    groups.set(activity.runId, values);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([runId, values]) => {
      const first = values[0] as ActiveCrewActivity;
      return {
        id: `${projectId}:${runId}`,
        runId,
        projectId,
        questId: first.quest.id,
        questTitle: first.quest.title,
        squadId: first.squad.id,
        activityIds: values.map((value) => value.activityId).sort(),
      };
    });
}

function composeNavigation(
  regions: readonly WorldRegionInstance[],
): AuthoredCrewNavigation {
  const values = regions.map(worldCrewNavigation);
  const routes = values.flatMap((value) => value.routes);
  return {
    enabled: values.some((value) => value.enabled),
    spawns: values.flatMap((value) => value.spawns),
    routes,
    activities: values.flatMap((value) => value.activities),
    graph: buildCrewRouteGraph(routes),
  };
}

export class WorldComposer {
  constructor(private readonly templates: WorldComposerTemplates) {}

  compose(input: ComposeWorldInput): WorldComposition {
    const home = instantiateWorldRegion(this.templates.home, "home", {
      x: 0,
      y: 0,
    });
    const projects = activeProjects(input);
    const originBase = instantiateWorldRegion(
      this.templates.projectIsland,
      "placement-probe",
      { x: 0, y: 0 },
    );
    const probeRegions = [originBase];
    if (this.templates.projectExpansion)
      probeRegions.push(
        attachExpansion(originBase, this.templates.projectExpansion).instance,
      );
    const maximumProjectBounds = unionWorldBounds(
      probeRegions.map((region) => region.worldBounds),
    );
    const placements = placeProjects(
      projects,
      placementGrid(home.worldBounds, maximumProjectBounds),
    );
    const regions: WorldRegionInstance[] = [home];
    const islands: ProjectIslandInstance[] = [];
    for (const placement of placements) {
      const base = instantiateWorldRegion(
        this.templates.projectIsland,
        `project:${placement.project.id}`,
        placement.origin,
        placement.project,
      );
      const islandRegions = [base];
      const attachments: ExpansionAttachment[] = [];
      if (
        this.templates.projectExpansion &&
        input.expansionProjectIds?.has(placement.project.id)
      ) {
        const attachment = attachExpansion(
          base,
          this.templates.projectExpansion,
        );
        attachments.push(attachment);
        islandRegions.push(attachment.instance);
      }
      regions.push(...islandRegions);
      const activities = input.activeCrew.filter(
        (activity) => activity.project.id === placement.project.id,
      );
      const workGroups = groupsFor(placement.project.id, activities);
      islands.push({
        project: placement.project,
        baseRegionId: base.instanceId,
        placementSlot: placement.slot,
        regionIds: islandRegions.map((region) => region.instanceId),
        bounds: unionWorldBounds(
          islandRegions.map((region) => region.worldBounds),
        ),
        crewNavigation: composeNavigation(islandRegions),
        comfortableVisualCapacity: comfortableVisualCapacity(islandRegions),
        activeActorCount: activities.length,
        activeRunIds: workGroups.map((group) => group.runId),
        workGroups,
        attachments,
      });
    }
    const union = unionWorldBounds(regions.map((region) => region.worldBounds));
    return {
      templates: [
        this.templates.home,
        this.templates.projectIsland,
        ...(this.templates.projectExpansion
          ? [this.templates.projectExpansion]
          : []),
      ],
      regions,
      home,
      projectIslands: new ProjectIslandRegistry(islands),
      worldBounds: regions.length === 1 ? union : padWorldBounds(union, 64),
    };
  }
}
