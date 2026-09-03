import {
  CREW_ROUTE_ACCESS_TOLERANCE,
  nearestCrewRouteConnection,
} from "../authored/crew-navigation";
import type { CrewRouteGraph, TownPoint } from "../authored/map-schema";

export interface CrewPathRequest {
  start: TownPoint;
  destination: TownPoint;
}

function distance(a: TownPoint, b: TownPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function samePoint(a: TownPoint, b: TownPoint): boolean {
  return a.x === b.x && a.y === b.y;
}

function shortestNodePath(
  graph: CrewRouteGraph,
  from: string,
  to: string,
): string[] | null {
  if (from === to) return [from];
  const adjacency = new Map<string, Array<{ id: string; length: number }>>(
    graph.nodes.map((node) => [node.id, []]),
  );
  for (const edge of graph.edges) {
    adjacency.get(edge.from)?.push({ id: edge.to, length: edge.length });
    adjacency.get(edge.to)?.push({ id: edge.from, length: edge.length });
  }
  for (const values of adjacency.values())
    values.sort((a, b) => a.id.localeCompare(b.id));

  const distances = new Map(
    graph.nodes.map((node) => [node.id, Number.POSITIVE_INFINITY]),
  );
  const previous = new Map<string, string>();
  const remaining = new Set(graph.nodes.map((node) => node.id));
  distances.set(from, 0);
  while (remaining.size) {
    const current = [...remaining].sort(
      (a, b) =>
        (distances.get(a) ?? Infinity) - (distances.get(b) ?? Infinity) ||
        a.localeCompare(b),
    )[0];
    if (!current || !Number.isFinite(distances.get(current))) break;
    remaining.delete(current);
    if (current === to) break;
    for (const neighbor of adjacency.get(current) ?? []) {
      if (!remaining.has(neighbor.id)) continue;
      const candidate = (distances.get(current) ?? Infinity) + neighbor.length;
      if (candidate < (distances.get(neighbor.id) ?? Infinity)) {
        distances.set(neighbor.id, candidate);
        previous.set(neighbor.id, current);
      }
    }
  }
  if (!previous.has(to)) return null;
  const result = [to];
  while (result[0] !== from) {
    const prior = previous.get(result[0] ?? "");
    if (!prior) return null;
    result.unshift(prior);
  }
  return result;
}

/** Builds a deterministic route without deriving walkability from visual tiles. */
export function findCrewPath(
  graph: CrewRouteGraph,
  request: CrewPathRequest,
): TownPoint[] | null {
  const startConnection = nearestCrewRouteConnection(request.start, graph);
  const endConnection = nearestCrewRouteConnection(request.destination, graph);
  if (
    !startConnection ||
    !endConnection ||
    startConnection.distance > CREW_ROUTE_ACCESS_TOLERANCE ||
    endConnection.distance > CREW_ROUTE_ACCESS_TOLERANCE
  )
    return null;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const edges = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const startEdge = edges.get(startConnection.edgeId);
  const endEdge = edges.get(endConnection.edgeId);
  if (!startEdge || !endEdge) return null;

  if (startEdge.id === endEdge.id) {
    return [
      request.start,
      startConnection.point,
      endConnection.point,
      request.destination,
    ].filter(
      (point, index, values) =>
        index === 0 || !samePoint(point, values[index - 1] as TownPoint),
    );
  }

  let best: { length: number; ids: string[]; tie: string } | null = null;
  for (const startNodeId of [startEdge.from, startEdge.to]) {
    for (const endNodeId of [endEdge.from, endEdge.to]) {
      const ids = shortestNodePath(graph, startNodeId, endNodeId);
      if (!ids) continue;
      const points = ids
        .map((id) => nodes.get(id))
        .filter((point): point is NonNullable<typeof point> => !!point);
      const length =
        distance(startConnection.point, nodes.get(startNodeId) as TownPoint) +
        points
          .slice(1)
          .reduce(
            (sum, point, index) =>
              sum + distance(points[index] as TownPoint, point),
            0,
          ) +
        distance(nodes.get(endNodeId) as TownPoint, endConnection.point);
      const tie = ids.join("/");
      if (
        !best ||
        length < best.length ||
        (length === best.length && tie < best.tie)
      )
        best = { length, ids, tie };
    }
  }
  if (!best) return null;
  const points = [
    request.start,
    startConnection.point,
    ...best.ids.map((id) => {
      const node = nodes.get(id) as TownPoint;
      return { x: node.x, y: node.y };
    }),
    endConnection.point,
    request.destination,
  ];
  return points.filter(
    (point, index) =>
      index === 0 || !samePoint(point, points[index - 1] as TownPoint),
  );
}
