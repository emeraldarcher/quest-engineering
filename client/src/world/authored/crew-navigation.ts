import type {
  AuthoredCrewActivity,
  AuthoredCrewRoute,
  CrewRouteEdge,
  CrewRouteGraph,
  CrewRouteNode,
  TownPoint,
  TownRect,
} from "./map-schema";

/** Vertices this close are the same authored route junction, in world pixels. */
export const CREW_ROUTE_CONNECTION_TOLERANCE = 1;
/** Entrances and activity areas must meet a route within half a 16px tile. */
export const CREW_ROUTE_ACCESS_TOLERANCE = 8;

export interface NearestRouteConnection {
  edgeId: string;
  point: TownPoint;
  distance: number;
}

function distance(a: TownPoint, b: TownPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function comparePoints(a: TownPoint, b: TownPoint): number {
  return a.y - b.y || a.x - b.x;
}

export function buildCrewRouteGraph(
  routes: readonly AuthoredCrewRoute[],
  tolerance = CREW_ROUTE_CONNECTION_TOLERANCE,
): CrewRouteGraph {
  const authored = routes
    .flatMap((route) =>
      route.points.map((point, index) => ({ routeId: route.id, index, point })),
    )
    .sort(
      (a, b) =>
        comparePoints(a.point, b.point) ||
        a.routeId.localeCompare(b.routeId) ||
        a.index - b.index,
    );
  const parents = authored.map((_, index) => index);
  const root = (index: number): number => {
    let value = index;
    while (parents[value] !== value) value = parents[value] as number;
    return value;
  };
  for (let first = 0; first < authored.length; first += 1)
    for (let second = first + 1; second < authored.length; second += 1)
      if (
        distance(
          (authored[first] as (typeof authored)[number]).point,
          (authored[second] as (typeof authored)[number]).point,
        ) <= tolerance
      ) {
        const firstRoot = root(first);
        const secondRoot = root(second);
        if (firstRoot !== secondRoot)
          parents[Math.max(firstRoot, secondRoot)] = Math.min(
            firstRoot,
            secondRoot,
          );
      }
  const groups = new Map<number, number[]>();
  for (const [index] of authored.entries()) {
    const parent = root(index);
    const values = groups.get(parent) ?? [];
    values.push(index);
    groups.set(parent, values);
  }
  const orderedGroups = [...groups.values()].sort(
    (a, b) => (a[0] ?? 0) - (b[0] ?? 0),
  );
  const nodes: CrewRouteNode[] = orderedGroups.map((indices, index) => ({
    id: `crew-route-node-${index + 1}`,
    ...(authored[indices[0] as number] as (typeof authored)[number]).point,
  }));
  const nodeForVertex = new Map<string, string>();
  for (const [groupIndex, indices] of orderedGroups.entries())
    for (const index of indices) {
      const vertex = authored[index] as (typeof authored)[number];
      nodeForVertex.set(
        `${vertex.routeId}:${vertex.index}`,
        (nodes[groupIndex] as CrewRouteNode).id,
      );
    }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edges: CrewRouteEdge[] = [];
  for (const route of [...routes].sort((a, b) => a.id.localeCompare(b.id))) {
    for (let index = 0; index < route.points.length - 1; index += 1) {
      const from = nodeForVertex.get(`${route.id}:${index}`);
      const to = nodeForVertex.get(`${route.id}:${index + 1}`);
      if (!from || !to || from === to) continue;
      const a = nodeById.get(from);
      const b = nodeById.get(to);
      if (!a || !b) continue;
      edges.push({
        id: `${route.id}:${index}`,
        routeId: route.id,
        from,
        to,
        length: distance(a, b),
      });
    }
  }
  return { nodes, edges };
}

export function crewRouteComponents(graph: CrewRouteGraph): string[][] {
  const adjacency = new Map(
    graph.nodes.map((node) => [node.id, new Set<string>()]),
  );
  for (const edge of graph.edges) {
    adjacency.get(edge.from)?.add(edge.to);
    adjacency.get(edge.to)?.add(edge.from);
  }
  const remaining = new Set(graph.nodes.map((node) => node.id));
  const components: string[][] = [];
  while (remaining.size) {
    const first = [...remaining].sort()[0];
    if (!first) break;
    const component: string[] = [];
    const queue = [first];
    remaining.delete(first);
    while (queue.length) {
      const current = queue.shift();
      if (!current) continue;
      component.push(current);
      for (const next of [...(adjacency.get(current) ?? [])].sort()) {
        if (!remaining.delete(next)) continue;
        queue.push(next);
      }
    }
    components.push(component.sort());
  }
  return components;
}

function nearestPointOnSegment(
  point: TownPoint,
  start: TownPoint,
  end: TownPoint,
): TownPoint {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return { ...start };
  const amount = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared,
    ),
  );
  return { x: start.x + dx * amount, y: start.y + dy * amount };
}

function segmentRectIntersection(
  start: TownPoint,
  end: TownPoint,
  rect: TownRect,
): TownPoint | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  let minimum = 0;
  let maximum = 1;
  for (const [origin, delta, low, high] of [
    [start.x, dx, rect.x, rect.x + rect.width],
    [start.y, dy, rect.y, rect.y + rect.height],
  ] as const) {
    if (delta === 0) {
      if (origin < low || origin > high) return null;
      continue;
    }
    const first = (low - origin) / delta;
    const second = (high - origin) / delta;
    minimum = Math.max(minimum, Math.min(first, second));
    maximum = Math.min(maximum, Math.max(first, second));
    if (minimum > maximum) return null;
  }
  return { x: start.x + dx * minimum, y: start.y + dy * minimum };
}

function connectionTargets(
  area: TownPoint | AuthoredCrewActivity,
): TownPoint[] {
  if (!("shape" in area) || area.shape === "point")
    return [{ x: area.x, y: area.y }];
  return [
    { x: area.x + area.width / 2, y: area.y + area.height / 2 },
    { x: area.x, y: area.y },
    { x: area.x + area.width, y: area.y },
    { x: area.x, y: area.y + area.height },
    { x: area.x + area.width, y: area.y + area.height },
  ];
}

export function nearestCrewRouteConnection(
  area: TownPoint | AuthoredCrewActivity,
  graph: CrewRouteGraph,
): NearestRouteConnection | null {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  let nearest: NearestRouteConnection | null = null;
  for (const edge of graph.edges) {
    const start = nodes.get(edge.from);
    const end = nodes.get(edge.to);
    if (!start || !end) continue;
    if ("shape" in area && area.shape === "rectangle") {
      const intersection = segmentRectIntersection(start, end, area);
      if (intersection)
        return { edgeId: edge.id, point: intersection, distance: 0 };
      for (const endpoint of [start, end]) {
        const areaPoint = {
          x: Math.max(area.x, Math.min(area.x + area.width, endpoint.x)),
          y: Math.max(area.y, Math.min(area.y + area.height, endpoint.y)),
        };
        const candidate = {
          edgeId: edge.id,
          point: { x: endpoint.x, y: endpoint.y },
          distance: distance(endpoint, areaPoint),
        };
        if (
          !nearest ||
          candidate.distance < nearest.distance ||
          (candidate.distance === nearest.distance &&
            candidate.edgeId < nearest.edgeId)
        )
          nearest = candidate;
      }
    }
    for (const target of connectionTargets(area)) {
      const point = nearestPointOnSegment(target, start, end);
      const candidate = {
        edgeId: edge.id,
        point,
        distance: distance(target, point),
      };
      if (
        !nearest ||
        candidate.distance < nearest.distance ||
        (candidate.distance === nearest.distance &&
          candidate.edgeId < nearest.edgeId)
      )
        nearest = candidate;
    }
  }
  return nearest;
}
