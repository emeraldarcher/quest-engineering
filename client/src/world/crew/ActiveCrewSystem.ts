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
  CREW_MOTION_EPSILON,
  type CrewWorkFacingSource,
  crewFacingMirrorsWork,
  crewIdleVisual,
  crewWalkingVisual,
  crewWorkFacing,
} from "./crew-facing";
import type { ActiveCrewPresentation } from "./crew-presentation";
import {
  CREW_PRESENTATION_TIMING,
  type CrewPresentationTiming,
  crewDepartureBudgetMs,
  crewPathDistance,
  crewVisualTailBudgetMs,
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
  visualDeadlineAtMs: number | null;
  departureElapsedMs: number;
  departureBudgetMs: number;
  departureTarget: TownPoint | null;
  movementDelta: TownPoint;
  movementAngleDegrees: number | null;
}

interface IslandAllocator {
  signature: string;
  allocator: CrewActivityAllocator;
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

  constructor(
    private composition: WorldComposition,
    private readonly timing: CrewPresentationTiming = CREW_PRESENTATION_TIMING,
  ) {}

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
      const sameCommittedDestination =
        existing.projectId === activity.projectId &&
        existing.activityCategory === activity.activityCategory &&
        existing.claim !== null &&
        existing.state !== "departing";
      existing.authoritativeRunning = true;
      existing.inactiveElapsedMs = 0;
      existing.visualDeadlineAtMs = null;
      if ((changed || !wasRunning) && sameCommittedDestination)
        this.continueCommittedActivity(existing, activity, changed);
      else if (changed || !wasRunning) this.relocate(existing, activity);
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
      actor.movementDelta = { x: 0, y: 0 };
      actor.movementAngleDegrees = null;
      actor.animationElapsedMs += milliseconds;
      actor.presentationAgeMs += milliseconds;
      if (!actor.authoritativeRunning) actor.inactiveElapsedMs += milliseconds;

      if (actor.state === "entering") actor.state = "walking_to_activity";
      if (
        actor.state === "walking_to_activity" ||
        actor.state === "relocating"
      ) {
        const movement = this.advancePath(
          actor,
          this.timing.walkSpeed * seconds,
        );
        if (movement.arrived) this.beginWorking(actor);
        else if (
          !actor.authoritativeRunning &&
          actor.visualDeadlineAtMs !== null &&
          actor.presentationAgeMs >= actor.visualDeadlineAtMs
        )
          this.remove(actor.actorId);
        continue;
      }
      if (actor.state === "working") {
        actor.workElapsedMs += milliseconds;
        continue;
      }
      if (actor.state === "wrapping_up") {
        if (actor.workElapsedMs < this.timing.minimumWorkMs) {
          actor.workElapsedMs += milliseconds;
        } else {
          actor.wrapElapsedMs += milliseconds;
          this.setIdleAnimation(actor);
          if (actor.wrapElapsedMs >= this.timing.wrapUpMs)
            this.beginDeparture(actor);
        }
        continue;
      }
      if (actor.state === "departing") {
        actor.departureElapsedMs += milliseconds;
        const movement = this.advancePath(
          actor,
          this.timing.walkSpeed * seconds,
        );
        if (movement.arrived) this.setIdleAnimation(actor);
        if (
          movement.arrived ||
          actor.departureElapsedMs >= actor.departureBudgetMs ||
          (actor.visualDeadlineAtMs !== null &&
            actor.presentationAgeMs >= actor.visualDeadlineAtMs)
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
    return Math.max(0, this.timing.minimumWorkMs - actor.workElapsedMs);
  }

  /** The route position is the sole world ground/contact position. */
  renderPosition(actor: CrewActor): TownPoint {
    return { ...actor.position };
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
    const walking = crewWalkingVisual({ x: 0, y: 0 });
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
      visualDeadlineAtMs: null,
      departureElapsedMs: 0,
      departureBudgetMs: 0,
      departureTarget: null,
      movementDelta: { x: 0, y: 0 },
      movementAngleDegrees: null,
    });
  }

  private continueCommittedActivity(
    actor: CrewActor,
    activity: ActiveCrewPresentation,
    changed: boolean,
  ): void {
    actor.activity = activity;
    actor.authoritativeRunning = true;
    actor.inactiveElapsedMs = 0;
    actor.visualDeadlineAtMs = null;
    if (actor.state === "working" || actor.state === "wrapping_up") {
      actor.state = "working";
      actor.wrapElapsedMs = 0;
      if (changed) actor.workElapsedMs = 0;
      this.setWorkAnimation(actor);
    }
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
    actor.visualDeadlineAtMs = null;
    actor.departureElapsedMs = 0;
    actor.departureBudgetMs = 0;
    actor.departureTarget = null;
  }

  private beginWorking(actor: CrewActor): void {
    actor.position = { ...actor.destination };
    actor.state = actor.authoritativeRunning ? "working" : "wrapping_up";
    actor.workElapsedMs = 0;
    this.setWorkAnimation(actor);
  }

  private setWorkAnimation(actor: CrewActor): void {
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
    const travelling =
      actor.state === "entering" ||
      actor.state === "walking_to_activity" ||
      actor.state === "relocating";
    const remainingTravelDistance = travelling
      ? crewPathDistance(actor.position, actor.path, actor.pathIndex)
      : 0;
    const workStart = travelling ? actor.destination : actor.position;
    const departure = this.departurePlan(actor, workStart);
    actor.visualDeadlineAtMs =
      actor.presentationAgeMs +
      crewVisualTailBudgetMs(
        {
          remainingTravelDistance,
          remainingWorkMs: Math.max(
            0,
            this.timing.minimumWorkMs - (travelling ? 0 : actor.workElapsedMs),
          ),
          departureDistance: departure.distance,
        },
        this.timing,
      );
    if (actor.state === "working") actor.state = "wrapping_up";
    // A spawned actor keeps its committed destination. Short semantic work is
    // reenacted as travel -> readable work -> wrap -> departure.
  }

  private departurePlan(
    actor: CrewActor,
    start: TownPoint,
  ): {
    target: TownPoint | null;
    path: TownPoint[];
    distance: number;
  } {
    const island = this.composition.projectIslands.findProjectIsland(
      actor.projectId,
    );
    if (!island) return { target: null, path: [start], distance: 0 };
    const candidates = [...island.crewNavigation.spawns]
      .map((spawn) => {
        const path = findCrewPath(island.crewNavigation.graph, {
          start,
          destination: spawn,
        }) ?? [start];
        return {
          target: { x: spawn.x, y: spawn.y },
          path,
          distance: crewPathDistance(start, path, Math.min(1, path.length)),
          id: spawn.id,
        };
      })
      .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
    return candidates[0] ?? { target: null, path: [start], distance: 0 };
  }

  private beginDeparture(actor: CrewActor): void {
    const departure = this.departurePlan(actor, actor.position);
    this.releaseClaim(actor);
    actor.state = "departing";
    actor.departureTarget = departure.target;
    actor.destination = departure.target ?? { ...actor.position };
    actor.path = departure.path;
    actor.pathIndex = Math.min(1, actor.path.length);
    actor.departureElapsedMs = 0;
    actor.departureBudgetMs = crewDepartureBudgetMs(
      departure.distance,
      this.timing,
    );
  }

  private advancePath(
    actor: CrewActor,
    distanceBudget: number,
  ): { arrived: boolean; moved: number } {
    let remaining = distanceBudget;
    let moved = 0;
    const previousGround = { ...actor.position };
    while (remaining > 0 && actor.pathIndex < actor.path.length) {
      const target = actor.path[actor.pathIndex] as TownPoint;
      const vector = {
        x: target.x - actor.position.x,
        y: target.y - actor.position.y,
      };
      const length = Math.hypot(vector.x, vector.y);
      if (length <= CREW_MOTION_EPSILON) {
        actor.position = { ...target };
        actor.pathIndex += 1;
        continue;
      }
      const step = Math.min(remaining, length);
      actor.position = {
        x: actor.position.x + (vector.x / length) * step,
        y: actor.position.y + (vector.y / length) * step,
      };
      moved += step;
      remaining -= step;
      if (step >= length - CREW_MOTION_EPSILON) {
        actor.position = { ...target };
        actor.pathIndex += 1;
      }
    }
    const arrived = actor.pathIndex >= actor.path.length;
    if (arrived) actor.position = { ...actor.destination };
    this.recordMotion(actor, {
      x: actor.position.x - previousGround.x,
      y: actor.position.y - previousGround.y,
    });
    return { arrived, moved };
  }

  private recordMotion(actor: CrewActor, delta: TownPoint): void {
    if (Math.hypot(delta.x, delta.y) <= CREW_MOTION_EPSILON) return;
    actor.movementDelta = delta;
    actor.movementAngleDegrees = (Math.atan2(delta.y, delta.x) * 180) / Math.PI;
    this.setWalkingAnimation(actor, delta);
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
