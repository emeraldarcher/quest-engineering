import {
  CREW_ROUTE_ACCESS_TOLERANCE,
  nearestCrewRouteConnection,
} from "../authored/crew-navigation";
import type {
  AuthoredCrewActivity,
  CrewActivityCategory,
  CrewRouteGraph,
  TownPoint,
} from "../authored/map-schema";
import { stableHash } from "../visual-identity";

export interface CrewActivitySlot extends TownPoint {
  id: string;
  zoneId: string;
  activity: CrewActivityCategory;
  kind: "exact-anchor" | "district";
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
        kind: "exact-anchor",
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
    kind: "district" as const,
    x: zone.x + xStep * ((index % columns) + 0.5),
    y: zone.y + yStep * (Math.floor(index / columns) + 0.5),
  }));
}

/** Stateful presentation-only occupancy; it never affects execution. */
export class CrewActivityAllocator {
  private readonly slots: CrewActivitySlot[];
  private readonly claims = new Map<string, CrewActivityClaim>();
  private readonly occupied = new Map<string, string>();

  constructor(zones: readonly AuthoredCrewActivity[], graph?: CrewRouteGraph) {
    const ordered = [...zones].sort((a, b) => a.id.localeCompare(b.id));
    this.slots = ordered.flatMap((zone) => {
      const generated = activitySlots(zone);
      if (!graph || zone.shape === "point") return generated;
      const safe = generated.filter(
        (slot) =>
          (nearestCrewRouteConnection(slot, graph)?.distance ?? Infinity) <=
          CREW_ROUTE_ACCESS_TOLERANCE,
      );
      if (safe.length) return safe;
      const connection = nearestCrewRouteConnection(zone, graph);
      return connection
        ? [
            {
              id: `${zone.id}:route`,
              zoneId: zone.id,
              activity: zone.activity,
              kind: "district" as const,
              ...connection.point,
            },
          ]
        : [];
    });
  }

  claim(
    actorId: string,
    requestedActivity: CrewActivityCategory,
    affinityKey = actorId,
  ): CrewActivityClaim | null {
    const current = this.claims.get(actorId);
    if (current && current.requestedActivity === requestedActivity)
      return current;
    this.release(actorId);

    const stages: Array<{
      category: CrewActivityCategory;
      kind: CrewActivitySlot["kind"];
    }> = [
      { category: requestedActivity, kind: "exact-anchor" },
      { category: requestedActivity, kind: "district" },
      { category: "general", kind: "district" },
    ];
    for (const stage of stages) {
      const available = this.slots.filter(
        (slot) =>
          slot.activity === stage.category &&
          slot.kind === stage.kind &&
          !this.occupied.has(slot.id),
      );
      if (!available.length) continue;
      const slot =
        available[
          stableHash(`${affinityKey}\0${stage.category}`) % available.length
        ];
      if (slot) return this.save(actorId, requestedActivity, slot);
    }

    // Districts are flexible shared presentation areas, not execution capacity.
    // If their comfortably spaced grid is full, derive a stable actor-specific
    // point inside general (or the requested category) rather than hiding work.
    const general = this.slots.filter(
      (slot) => slot.kind === "district" && slot.activity === "general",
    );
    const matching = this.slots.filter(
      (slot) => slot.kind === "district" && slot.activity === requestedActivity,
    );
    const overflow = general.length ? general : matching;
    const base = overflow[stableHash(`${actorId}\0overflow`) % overflow.length];
    if (!base) return null;
    return this.save(actorId, requestedActivity, {
      ...base,
      id: `${base.zoneId}:overflow:${actorId}`,
    });
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

  private save(
    actorId: string,
    requestedActivity: CrewActivityCategory,
    slot: CrewActivitySlot,
  ): CrewActivityClaim {
    const claim = {
      actorId,
      requestedActivity,
      resolvedActivity: slot.activity,
      slot,
    };
    this.claims.set(actorId, claim);
    this.occupied.set(slot.id, actorId);
    return claim;
  }
}
