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
import {
  type CrewWorkFacingSource,
  crewFacingMirrorsWork,
  crewIdleVisual,
  crewWalkingVisual,
  crewWorkFacing,
} from "./crew-facing";
import type { ActiveCrewPresentation } from "./crew-presentation";
import {
  CREW_PRESENTATION_TIMING,
  CREW_WALK_SPEED,
} from "./crew-presentation-timing";
import {
  type HumanAppearance,
  type HumanV1Animation,
  type HumanVisualDirection,
  humanAppearance,
  humanWorkAnimation,
} from "./human-v1-runtime";

export type CrewActorPresentationState =
  | "entering"
  | "walking_to_activity"
  | "relocating"
  | "working"
  | "wrapping_up"
  | "departing";

export interface CrewActor {
  actorId: string;
  activity: ActiveCrewPresentation;
  projectId: string;
  islandRegionId: string;
  authoritativeRunning: boolean;
  state: CrewActorPresentationState;
  activityCategory: CrewActivityCategory;
  claim: CrewActivityClaim | null;
  position: TownPoint;
  destination: TownPoint;
  path: TownPoint[];
  pathIndex: number;
  laneOffset: number;
  appearance: HumanAppearance;
  animation: HumanV1Animation;
  animationTag: string;
  mirrorX: boolean;
  facing: HumanVisualDirection;
  workFacingSource: CrewWorkFacingSource;
  animationElapsedMs: number;
  presentationAgeMs: number;
  workElapsedMs: number;
  wrapElapsedMs: number;
  inactiveElapsedMs: number;
  departureTarget: TownPoint | null;
}

interface IslandAllocator {
  signature: string;
  allocator: CrewActivityAllocator;
}

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
        `${value.id}:${value.activity}:${value.x}:${value.y}:${value.width}:${value.height}:${value.facing ?? ""}`,
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
    for (const actor of this.actorsById.values()) {
      if (desired.has(actor.actorId) || !actor.authoritativeRunning) continue;
      this.beginPresentationTail(actor);
    }
    for (const activity of [...desired.values()].sort((a, b) =>
      a.actorId.localeCompare(b.actorId),
    )) {
      const existing = this.actorsById.get(activity.actorId);
      if (!existing) {
        this.spawn(activity);
        continue;
      }
      const changed =
        existing.activity.activityId !== activity.activityId ||
        existing.activityCategory !== activity.activityCategory ||
        existing.projectId !== activity.projectId;
      const wasRunning = existing.authoritativeRunning;
      existing.authoritativeRunning = true;
      existing.inactiveElapsedMs = 0;
      if (changed || !wasRunning) this.relocate(existing, activity);
      else existing.activity = activity;
    }
    const claimed = new Set(
      this.actors()
        .filter((actor) => actor.claim)
        .map((actor) => actor.actorId),
    );
    for (const island of this.composition.projectIslands.values())
      this.allocatorFor(island).reconcile(claimed);
  }

  update(elapsedMs: number): void {
    const milliseconds = Math.min(100, Math.max(0, elapsedMs));
    const seconds = milliseconds / 1000;
    for (const actor of [...this.actorsById.values()]) {
      actor.animationElapsedMs += milliseconds;
      actor.presentationAgeMs += milliseconds;
      if (!actor.authoritativeRunning) actor.inactiveElapsedMs += milliseconds;

      if (actor.state === "entering") actor.state = "walking_to_activity";
      if (
        actor.state === "walking_to_activity" ||
        actor.state === "relocating"
      ) {
        if (this.advancePath(actor, CREW_WALK_SPEED * seconds))
          this.beginWorking(actor);
        continue;
      }
      if (actor.state === "working") {
        actor.workElapsedMs += milliseconds;
        continue;
      }
      if (actor.state === "wrapping_up") {
        if (actor.workElapsedMs < CREW_PRESENTATION_TIMING.minimumWorkMs) {
          actor.workElapsedMs += milliseconds;
        } else {
          actor.wrapElapsedMs += milliseconds;
          this.setIdleAnimation(actor);
          if (actor.wrapElapsedMs >= CREW_PRESENTATION_TIMING.wrapUpMs)
            this.beginDeparture(actor);
        }
        continue;
      }
      if (actor.state === "departing") {
        const arrived = this.advancePath(actor, CREW_WALK_SPEED * seconds);
        if (arrived) this.setIdleAnimation(actor);
        if (
          actor.inactiveElapsedMs >=
            CREW_PRESENTATION_TIMING.maximumDepartureMs ||
          (arrived &&
            actor.presentationAgeMs >=
              CREW_PRESENTATION_TIMING.minimumVisibleMs)
        )
          this.remove(actor.actorId);
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

  minimumWorkRemaining(actor: CrewActor): number {
    return Math.max(
      0,
      CREW_PRESENTATION_TIMING.minimumWorkMs - actor.workElapsedMs,
    );
  }

  renderPosition(actor: CrewActor): TownPoint {
    if (
      actor.state === "working" ||
      actor.state === "wrapping_up" ||
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
    const walking = crewWalkingVisual(this.initialVector(path));
    this.actorsById.set(activity.actorId, {
      actorId: activity.actorId,
      activity,
      projectId: activity.projectId,
      islandRegionId: this.regionForClaim(island, claim),
      authoritativeRunning: true,
      state: "entering",
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
      facing: walking.facing,
      workFacingSource: "default",
      animationElapsedMs: 0,
      presentationAgeMs: 0,
      workElapsedMs: 0,
      wrapElapsedMs: 0,
      inactiveElapsedMs: 0,
      departureTarget: null,
    });
  }

  private relocate(actor: CrewActor, activity: ActiveCrewPresentation): void {
    this.releaseClaim(actor);
    const island = this.composition.projectIslands.findProjectIsland(
      activity.projectId,
    );
    if (!island) {
      this.remove(actor.actorId);
      return;
    }
    const claim = this.allocatorFor(island).claim(
      actor.actorId,
      activity.activityCategory,
      activity.runId,
    );
    if (!claim) {
      this.remove(actor.actorId);
      return;
    }
    const path = findCrewPath(island.crewNavigation.graph, {
      start: actor.position,
      destination: claim.slot,
    });
    actor.activity = activity;
    actor.projectId = activity.projectId;
    actor.islandRegionId = this.regionForClaim(island, claim);
    actor.authoritativeRunning = true;
    actor.activityCategory = activity.activityCategory;
    actor.claim = claim;
    actor.destination = { x: claim.slot.x, y: claim.slot.y };
    actor.path = path ?? [actor.position];
    actor.pathIndex = Math.min(1, actor.path.length);
    actor.state = "relocating";
    actor.workElapsedMs = 0;
    actor.wrapElapsedMs = 0;
    actor.inactiveElapsedMs = 0;
    actor.departureTarget = null;
    this.setWalkingAnimation(actor, this.initialVector(actor.path));
  }

  private beginWorking(actor: CrewActor): void {
    actor.position = { ...actor.destination };
    actor.state = "working";
    actor.workElapsedMs = 0;
    const workFacing = crewWorkFacing(
      actor.claim?.slot.facing ?? null,
      actor.facing,
    );
    actor.facing = workFacing.facing;
    actor.workFacingSource = workFacing.source;
    this.setAnimation(
      actor,
      humanWorkAnimation(actor.activity.workAnimationTag),
      crewFacingMirrorsWork(actor.facing),
    );
  }

  private beginPresentationTail(actor: CrewActor): void {
    actor.authoritativeRunning = false;
    actor.inactiveElapsedMs = 0;
    actor.wrapElapsedMs = 0;
    if (actor.state === "working") {
      actor.state = "wrapping_up";
      return;
    }
    if (actor.state === "wrapping_up" || actor.state === "departing") return;
    this.beginDeparture(actor);
  }

  private beginDeparture(actor: CrewActor): void {
    const island = this.composition.projectIslands.findProjectIsland(
      actor.projectId,
    );
    this.releaseClaim(actor);
    const spawn = island
      ? [...island.crewNavigation.spawns].sort(
          (a, b) =>
            distance(actor.position, a) - distance(actor.position, b) ||
            a.id.localeCompare(b.id),
        )[0]
      : null;
    actor.state = "departing";
    actor.departureTarget = spawn ? { x: spawn.x, y: spawn.y } : null;
    actor.destination = actor.departureTarget ?? { ...actor.position };
    actor.path =
      spawn && island
        ? (findCrewPath(island.crewNavigation.graph, {
            start: actor.position,
            destination: spawn,
          }) ?? [actor.position])
        : [actor.position];
    actor.pathIndex = Math.min(1, actor.path.length);
    this.setWalkingAnimation(actor, this.initialVector(actor.path));
  }

  private advancePath(actor: CrewActor, distanceBudget: number): boolean {
    let remaining = distanceBudget;
    while (remaining > 0 && actor.pathIndex < actor.path.length) {
      const target = actor.path[actor.pathIndex] as TownPoint;
      const vector = {
        x: target.x - actor.position.x,
        y: target.y - actor.position.y,
      };
      const length = Math.hypot(vector.x, vector.y);
      if (length <= remaining || length < 0.001) {
        this.setWalkingAnimation(actor, vector);
        actor.position = { ...target };
        actor.pathIndex += 1;
        remaining -= length;
        continue;
      }
      this.setWalkingAnimation(actor, vector);
      const amount = remaining / length;
      actor.position = {
        x: actor.position.x + vector.x * amount,
        y: actor.position.y + vector.y * amount,
      };
      remaining = 0;
    }
    if (actor.pathIndex >= actor.path.length) {
      actor.position = { ...actor.destination };
      return true;
    }
    const target = actor.path[actor.pathIndex] as TownPoint;
    this.setWalkingAnimation(actor, {
      x: target.x - actor.position.x,
      y: target.y - actor.position.y,
    });
    return false;
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

  private releaseClaim(actor: CrewActor): void {
    if (!actor.claim) return;
    this.allocators.get(actor.projectId)?.allocator.release(actor.actorId);
    actor.claim = null;
  }

  private remove(actorId: string): void {
    const actor = this.actorsById.get(actorId);
    if (!actor) return;
    this.releaseClaim(actor);
    this.actorsById.delete(actorId);
  }

  private initialVector(path: readonly TownPoint[]): TownPoint {
    const from = path[0] ?? { x: 0, y: 0 };
    const to = path[1] ?? { x: from.x, y: from.y + 1 };
    return { x: to.x - from.x, y: to.y - from.y };
  }

  private setWalkingAnimation(actor: CrewActor, vector: TownPoint): void {
    const visual = crewWalkingVisual(vector, actor.facing);
    actor.facing = visual.facing;
    this.setAnimation(actor, visual.animation, visual.mirrorX);
  }

  private setIdleAnimation(actor: CrewActor): void {
    const visual = crewIdleVisual(actor.facing);
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
