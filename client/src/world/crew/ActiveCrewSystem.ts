import type { CrewActivityCategory, TownPoint } from "../authored/map-schema";
import type {
  ProjectIslandInstance,
  WorldComposition,
} from "../composition/world-composer";
import { stableHash } from "../visual-identity";
import {
  CrewActivityAllocator,
  type CrewActivityClaim,
} from "./CrewActivityAllocator";
import { findCrewPath } from "./CrewNavigation";
import type { ActiveCrewPresentation } from "./crew-presentation";
import {
  type HumanAppearance,
  type HumanV1Animation,
  humanAppearance,
  humanDirectionalAnimation,
  humanWorkAnimation,
} from "./human-v1-runtime";

export type CrewActorPresentationState =
  | "spawn"
  | "walking_to_activity"
  | "relocating"
  | "working";

export interface CrewActor {
  actorId: string;
  activity: ActiveCrewPresentation;
  projectId: string;
  islandRegionId: string;
  state: CrewActorPresentationState;
  activityCategory: CrewActivityCategory;
  claim: CrewActivityClaim;
  position: TownPoint;
  destination: TownPoint;
  path: TownPoint[];
  pathIndex: number;
  laneOffset: number;
  appearance: HumanAppearance;
  animation: HumanV1Animation;
  animationTag: string;
  mirrorX: boolean;
  animationElapsedMs: number;
}

interface IslandAllocator {
  signature: string;
  allocator: CrewActivityAllocator;
}

const WALK_SPEED = 22;
const LANE_OFFSETS = [-1.5, -0.5, 0.5, 1.5] as const;

function distance(a: TownPoint, b: TownPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function navigationSignature(island: ProjectIslandInstance): string {
  return [
    ...island.crewNavigation.spawns.map(
      (value) => `${value.id}:${value.x}:${value.y}`,
    ),
    ...island.crewNavigation.activities.map(
      (value) =>
        `${value.id}:${value.activity}:${value.x}:${value.y}:${value.width}:${value.height}`,
    ),
    ...island.crewNavigation.graph.edges.map((value) => value.id),
  ].join("|");
}

/**
 * Reconciles authoritative active work into presentation-only actors. It has no
 * API/Runtime dependencies and cannot delay or mutate execution.
 */
export class ActiveCrewSystem {
  private readonly actorsById = new Map<string, CrewActor>();
  private readonly allocators = new Map<string, IslandAllocator>();

  constructor(private composition: WorldComposition) {}

  setComposition(composition: WorldComposition): void {
    this.composition = composition;
    const projects = new Set(
      composition.projectIslands.values().map((island) => island.project.id),
    );
    for (const projectId of this.allocators.keys())
      if (!projects.has(projectId)) this.allocators.delete(projectId);
  }

  reconcile(active: readonly ActiveCrewPresentation[]): void {
    const desired = new Map(active.map((value) => [value.actorId, value]));
    for (const actorId of this.actorsById.keys()) {
      if (desired.has(actorId)) continue;
      this.release(actorId);
    }
    for (const activity of [...desired.values()].sort((a, b) =>
      a.actorId.localeCompare(b.actorId),
    )) {
      const existing = this.actorsById.get(activity.actorId);
      if (!existing) this.spawn(activity);
      else if (
        existing.activity.activityId !== activity.activityId ||
        existing.activityCategory !== activity.activityCategory ||
        existing.projectId !== activity.projectId
      )
        this.relocate(existing, activity);
      else existing.activity = activity;
    }
    for (const island of this.composition.projectIslands.values()) {
      const activeIds = new Set(
        active
          .filter((value) => value.projectId === island.project.id)
          .map((value) => value.actorId),
      );
      this.allocatorFor(island).reconcile(activeIds);
    }
  }

  update(elapsedMs: number): void {
    const seconds = Math.min(0.1, Math.max(0, elapsedMs / 1000));
    for (const actor of this.actorsById.values()) {
      actor.animationElapsedMs += elapsedMs;
      if (actor.state === "spawn") actor.state = "walking_to_activity";
      if (actor.state === "working") continue;
      let remaining = WALK_SPEED * seconds;
      while (remaining > 0 && actor.pathIndex < actor.path.length) {
        const target = actor.path[actor.pathIndex] as TownPoint;
        const length = distance(actor.position, target);
        if (length <= remaining || length < 0.001) {
          actor.position = { ...target };
          actor.pathIndex += 1;
          remaining -= length;
          continue;
        }
        const amount = remaining / length;
        const movement = {
          x: (target.x - actor.position.x) * amount,
          y: (target.y - actor.position.y) * amount,
        };
        actor.position = {
          x: actor.position.x + movement.x,
          y: actor.position.y + movement.y,
        };
        this.setWalkingAnimation(actor, movement);
        remaining = 0;
      }
      if (actor.pathIndex >= actor.path.length) {
        actor.position = { ...actor.destination };
        actor.state = "working";
        this.setAnimation(
          actor,
          humanWorkAnimation(actor.activity.workAnimationTag),
          false,
        );
      } else {
        const target = actor.path[actor.pathIndex] as TownPoint;
        this.setWalkingAnimation(actor, {
          x: target.x - actor.position.x,
          y: target.y - actor.position.y,
        });
      }
    }
  }

  actors(): CrewActor[] {
    return [...this.actorsById.values()].sort((a, b) =>
      a.actorId.localeCompare(b.actorId),
    );
  }

  actor(actorId: string): CrewActor | null {
    return this.actorsById.get(actorId) ?? null;
  }

  renderPosition(actor: CrewActor): TownPoint {
    if (
      actor.state === "working" ||
      actor.pathIndex <= 0 ||
      actor.pathIndex >= actor.path.length - 1
    )
      return { ...actor.position };
    const from = actor.path[actor.pathIndex - 1] as TownPoint;
    const to = actor.path[actor.pathIndex] as TownPoint;
    const length = distance(from, to) || 1;
    return {
      x: actor.position.x + ((to.y - from.y) / length) * actor.laneOffset,
      y: actor.position.y - ((to.x - from.x) / length) * actor.laneOffset,
    };
  }

  private spawn(activity: ActiveCrewPresentation): void {
    const island = this.composition.projectIslands.findProjectIsland(
      activity.projectId,
    );
    if (!island) return;
    const spawns = [...island.crewNavigation.spawns].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    const spawn = spawns[stableHash(activity.actorId) % spawns.length];
    const claim = this.allocatorFor(island).claim(
      activity.actorId,
      activity.activityCategory,
      activity.runId,
    );
    if (!spawn || !claim) return;
    const position = { x: spawn.x, y: spawn.y };
    const path = findCrewPath(island.crewNavigation.graph, {
      start: position,
      destination: claim.slot,
    }) ?? [position];
    const walking = humanDirectionalAnimation("walk", this.initialVector(path));
    this.actorsById.set(activity.actorId, {
      actorId: activity.actorId,
      activity,
      projectId: activity.projectId,
      islandRegionId: this.regionForClaim(island, claim),
      state: "spawn",
      activityCategory: activity.activityCategory,
      claim,
      position,
      destination: { x: claim.slot.x, y: claim.slot.y },
      path,
      pathIndex: Math.min(1, path.length),
      laneOffset:
        LANE_OFFSETS[
          stableHash(`${activity.actorId}\0lane`) % LANE_OFFSETS.length
        ] ?? 0,
      appearance: humanAppearance(activity.squadKey, activity.memberKey),
      animation: walking.animation,
      animationTag: walking.animation.tag,
      mirrorX: walking.mirrorX,
      animationElapsedMs: 0,
    });
  }

  private relocate(actor: CrewActor, activity: ActiveCrewPresentation): void {
    const oldProject = actor.projectId;
    this.allocators.get(oldProject)?.allocator.release(actor.actorId);
    const island = this.composition.projectIslands.findProjectIsland(
      activity.projectId,
    );
    if (!island) {
      this.actorsById.delete(actor.actorId);
      return;
    }
    const claim = this.allocatorFor(island).claim(
      actor.actorId,
      activity.activityCategory,
      activity.runId,
    );
    if (!claim) {
      this.actorsById.delete(actor.actorId);
      return;
    }
    const path = findCrewPath(island.crewNavigation.graph, {
      start: actor.position,
      destination: claim.slot,
    });
    actor.activity = activity;
    actor.projectId = activity.projectId;
    actor.islandRegionId = this.regionForClaim(island, claim);
    actor.activityCategory = activity.activityCategory;
    actor.claim = claim;
    actor.destination = { x: claim.slot.x, y: claim.slot.y };
    actor.path = path ?? [actor.position];
    actor.pathIndex = Math.min(1, actor.path.length);
    actor.state = "relocating";
    actor.animationElapsedMs = 0;
    this.setWalkingAnimation(actor, this.initialVector(actor.path));
  }

  private regionForClaim(
    island: ProjectIslandInstance,
    claim: CrewActivityClaim,
  ): string {
    return (
      [...island.regionIds]
        .sort((a, b) => b.length - a.length)
        .find((regionId) => claim.slot.zoneId.startsWith(`${regionId}:`)) ??
      island.baseRegionId
    );
  }

  private allocatorFor(island: ProjectIslandInstance): CrewActivityAllocator {
    const signature = navigationSignature(island);
    const current = this.allocators.get(island.project.id);
    if (current?.signature === signature) return current.allocator;
    const allocator = new CrewActivityAllocator(
      island.crewNavigation.activities,
      island.crewNavigation.graph,
    );
    this.allocators.set(island.project.id, { signature, allocator });
    return allocator;
  }

  private release(actorId: string): void {
    const actor = this.actorsById.get(actorId);
    if (!actor) return;
    this.allocators.get(actor.projectId)?.allocator.release(actorId);
    this.actorsById.delete(actorId);
  }

  private initialVector(path: readonly TownPoint[]): TownPoint {
    const from = path[0] ?? { x: 0, y: 0 };
    const to = path[1] ?? { x: from.x, y: from.y + 1 };
    return { x: to.x - from.x, y: to.y - from.y };
  }

  private setWalkingAnimation(actor: CrewActor, vector: TownPoint): void {
    const visual = humanDirectionalAnimation("walk", vector);
    this.setAnimation(actor, visual.animation, visual.mirrorX);
  }

  private setAnimation(
    actor: CrewActor,
    animation: HumanV1Animation,
    mirrorX: boolean,
  ): void {
    if (actor.animation.id !== animation.id || actor.mirrorX !== mirrorX)
      actor.animationElapsedMs = 0;
    actor.animation = animation;
    actor.animationTag = animation.tag;
    actor.mirrorX = mirrorX;
  }
}
