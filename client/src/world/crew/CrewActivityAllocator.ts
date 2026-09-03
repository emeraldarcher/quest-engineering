import type {
  AuthoredCrewActivity,
  CrewActivityCategory,
  TownPoint,
} from "../authored/map-schema";
import { stableHash } from "../visual-identity";

export interface CrewActivitySlot extends TownPoint {
  id: string;
  zoneId: string;
  activity: CrewActivityCategory;
}

export interface CrewActivityClaim {
  actorId: string;
  requestedActivity: CrewActivityCategory;
  resolvedActivity: CrewActivityCategory;
  slot: CrewActivitySlot;
}

export const CREW_ACTIVITY_SLOT_SPACING = 12;

export function activitySlots(
  zone: AuthoredCrewActivity,
  spacing = CREW_ACTIVITY_SLOT_SPACING,
): CrewActivitySlot[] {
  if (zone.shape === "point")
    return [
      {
        id: `${zone.id}:1`,
        zoneId: zone.id,
        activity: zone.activity,
        x: zone.x,
        y: zone.y,
      },
    ];
  const columns = Math.max(1, Math.floor(zone.width / spacing));
  const rows = Math.max(1, Math.floor(zone.height / spacing));
  const xStep = zone.width / columns;
  const yStep = zone.height / rows;
  return Array.from({ length: columns * rows }, (_, index) => ({
    id: `${zone.id}:${index + 1}`,
    zoneId: zone.id,
    activity: zone.activity,
    x: zone.x + xStep * ((index % columns) + 0.5),
    y: zone.y + yStep * (Math.floor(index / columns) + 0.5),
  }));
}

/** Stateful presentation-only occupancy; it never affects execution. */
export class CrewActivityAllocator {
  private readonly slots: CrewActivitySlot[];
  private readonly claims = new Map<string, CrewActivityClaim>();
  private readonly occupied = new Map<string, string>();

  constructor(zones: readonly AuthoredCrewActivity[]) {
    this.slots = [...zones]
      .sort((a, b) => a.id.localeCompare(b.id))
      .flatMap((zone) => activitySlots(zone));
  }

  claim(
    actorId: string,
    requestedActivity: CrewActivityCategory,
  ): CrewActivityClaim | null {
    const current = this.claims.get(actorId);
    if (current && current.requestedActivity === requestedActivity)
      return current;
    this.release(actorId);
    const categories: CrewActivityCategory[] =
      requestedActivity === "general"
        ? ["general"]
        : [requestedActivity, "general"];
    for (const category of categories) {
      const available = this.slots.filter(
        (slot) => slot.activity === category && !this.occupied.has(slot.id),
      );
      if (!available.length) continue;
      const slot =
        available[stableHash(`${actorId}\0${category}`) % available.length];
      if (!slot) continue;
      const claim = {
        actorId,
        requestedActivity,
        resolvedActivity: category,
        slot,
      };
      this.claims.set(actorId, claim);
      this.occupied.set(slot.id, actorId);
      return claim;
    }
    return null;
  }

  release(actorId: string): void {
    const claim = this.claims.get(actorId);
    if (!claim) return;
    this.occupied.delete(claim.slot.id);
    this.claims.delete(actorId);
  }

  reconcile(activeActorIds: ReadonlySet<string>): void {
    for (const actorId of this.claims.keys())
      if (!activeActorIds.has(actorId)) this.release(actorId);
  }

  snapshot(): CrewActivityClaim[] {
    return [...this.claims.values()].sort((a, b) =>
      a.actorId.localeCompare(b.actorId),
    );
  }
}
