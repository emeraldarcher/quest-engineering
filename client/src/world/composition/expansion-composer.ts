import type { AuthoredIslandSocket, TownPoint } from "../authored/map-schema";
import { activitySlots } from "../crew/CrewActivityAllocator";
import {
  instantiateWorldRegion,
  type WorldRegionInstance,
  type WorldRegionTemplate,
} from "./world-region";

const opposite = {
  north: "south",
  east: "west",
  south: "north",
  west: "east",
} as const;

export interface ExpansionAttachment {
  instance: WorldRegionInstance;
  baseSocketId: string;
  expansionSocketId: string;
}

export function socketsAreCompatible(
  base: AuthoredIslandSocket,
  inbound: AuthoredIslandSocket,
): boolean {
  return (
    base.role === "outbound" &&
    inbound.role === "inbound" &&
    base.edge === inbound.edge &&
    opposite[base.orientation] === inbound.orientation &&
    (!base.category || !inbound.category || base.category === inbound.category)
  );
}

export function attachExpansion(
  base: WorldRegionInstance,
  expansion: WorldRegionTemplate,
  ordinal = 1,
): ExpansionAttachment {
  const baseSockets = [...base.template.authored.islandSockets]
    .filter((socket) => socket.role === "outbound")
    .sort((a, b) => a.id.localeCompare(b.id));
  const inboundSockets = [...expansion.authored.islandSockets]
    .filter((socket) => socket.role === "inbound")
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const baseSocket of baseSockets)
    for (const inbound of inboundSockets) {
      if (!socketsAreCompatible(baseSocket, inbound)) continue;
      const origin: TownPoint = {
        x: base.worldOrigin.x + baseSocket.x - inbound.x,
        y: base.worldOrigin.y + baseSocket.y - inbound.y,
      };
      return {
        instance: instantiateWorldRegion(
          expansion,
          `${base.instanceId}:expansion:${ordinal}`,
          origin,
          base.project,
          base.instanceId,
        ),
        baseSocketId: baseSocket.id,
        expansionSocketId: inbound.id,
      };
    }
  throw new Error(
    `No compatible authored expansion socket joins '${base.templateId}' to '${expansion.templateId}'`,
  );
}

export function comfortableVisualCapacity(
  regions: readonly WorldRegionInstance[],
): number {
  return regions.reduce(
    (sum, region) =>
      sum +
      region.template.authored.crewNavigation.activities.reduce(
        (capacity, zone) => capacity + activitySlots(zone).length,
        0,
      ),
    0,
  );
}

export interface ExpansionHysteresisConfig {
  attachAbove: number;
  retireBelow: number;
  sustainForMs: number;
}

export interface ExpansionHysteresisState {
  attached: boolean;
  candidateSince: number | null;
}

/** Generic presentation policy; production thresholds await authored templates. */
export function evaluateExpansionHysteresis(
  state: ExpansionHysteresisState,
  demand: number,
  now: number,
  config: ExpansionHysteresisConfig,
): ExpansionHysteresisState {
  const threshold = state.attached ? config.retireBelow : config.attachAbove;
  const candidate = state.attached ? demand < threshold : demand > threshold;
  if (!candidate) return { ...state, candidateSince: null };
  const candidateSince = state.candidateSince ?? now;
  if (now - candidateSince < config.sustainForMs)
    return { ...state, candidateSince };
  return { attached: !state.attached, candidateSince: null };
}
