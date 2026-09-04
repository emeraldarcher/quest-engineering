import type {
  AuthoredCrewActivity,
  AuthoredCrewNavigation,
  AuthoredCrewRoute,
  AuthoredCrewSpawn,
  AuthoredIslandSocket,
  AuthoredWorldRegion,
  TownPoint,
  TownRect,
  WorldRegionKind,
} from "../authored/map-schema";

export interface WorldRegionTemplate {
  templateId: string;
  kind: WorldRegionKind;
  authored: AuthoredWorldRegion;
}

export interface RegionProjectIdentity {
  id: string;
  key: string;
  name: string;
}

export interface WorldRegionInstance {
  instanceId: string;
  templateId: string;
  kind: WorldRegionKind;
  worldOrigin: TownPoint;
  localBounds: TownRect;
  worldBounds: TownRect;
  template: WorldRegionTemplate;
  project: RegionProjectIdentity | null;
  parentRegionId: string | null;
}

export function translatePoint(point: TownPoint, origin: TownPoint): TownPoint {
  return { x: point.x + origin.x, y: point.y + origin.y };
}

export function translateRect(rect: TownRect, origin: TownPoint): TownRect {
  return {
    ...translatePoint(rect, origin),
    width: rect.width,
    height: rect.height,
  };
}

export function instantiateWorldRegion(
  template: WorldRegionTemplate,
  instanceId: string,
  worldOrigin: TownPoint,
  project: RegionProjectIdentity | null = null,
  parentRegionId: string | null = null,
): WorldRegionInstance {
  return {
    instanceId,
    templateId: template.templateId,
    kind: template.kind,
    worldOrigin: { ...worldOrigin },
    localBounds: { ...template.authored.bounds },
    worldBounds: translateRect(template.authored.bounds, worldOrigin),
    template,
    project,
    parentRegionId,
  };
}

function scopedId(instance: WorldRegionInstance, id: string): string {
  return `${instance.instanceId}:${id}`;
}

export function worldCrewNavigation(
  instance: WorldRegionInstance,
): Omit<AuthoredCrewNavigation, "graph"> {
  const navigation = instance.template.authored.crewNavigation;
  const spawns: AuthoredCrewSpawn[] = navigation.spawns.map((spawn) => ({
    ...spawn,
    id: scopedId(instance, spawn.id),
    ...translatePoint(spawn, instance.worldOrigin),
  }));
  const routes: AuthoredCrewRoute[] = navigation.routes.map((route) => ({
    ...route,
    id: scopedId(instance, route.id),
    points: route.points.map((point) =>
      translatePoint(point, instance.worldOrigin),
    ),
  }));
  const activities: AuthoredCrewActivity[] = navigation.activities.map(
    (activity) => ({
      ...activity,
      id: scopedId(instance, activity.id),
      ...translatePoint(activity, instance.worldOrigin),
    }),
  );
  return { enabled: navigation.enabled, spawns, routes, activities };
}

export function worldSocket(
  instance: WorldRegionInstance,
  socket: AuthoredIslandSocket,
): AuthoredIslandSocket {
  return {
    ...socket,
    id: scopedId(instance, socket.id),
    ...translatePoint(socket, instance.worldOrigin),
  };
}

export function unionWorldBounds(rectangles: readonly TownRect[]): TownRect {
  if (!rectangles.length) return { x: 0, y: 0, width: 0, height: 0 };
  const left = Math.min(...rectangles.map((rect) => rect.x));
  const top = Math.min(...rectangles.map((rect) => rect.y));
  const right = Math.max(...rectangles.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rectangles.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function padWorldBounds(bounds: TownRect, padding: number): TownRect {
  return {
    x: bounds.x - padding,
    y: bounds.y - padding,
    width: bounds.width + padding * 2,
    height: bounds.height + padding * 2,
  };
}
