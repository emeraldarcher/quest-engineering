import { expect, test } from "bun:test";
import { findCrewPath } from "../crew/CrewNavigation";
import {
  buildCrewRouteGraph,
  CREW_ROUTE_ACCESS_TOLERANCE,
  CREW_ROUTE_CONNECTION_TOLERANCE,
  crewRouteComponents,
  nearestCrewRouteConnection,
} from "./crew-navigation";
import type { AuthoredCrewRoute } from "./map-schema";

const routes: AuthoredCrewRoute[] = [
  {
    id: "main",
    points: [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
    ],
  },
  {
    id: "branch",
    points: [
      { x: 20.5, y: 0 },
      { x: 40, y: 0 },
    ],
  },
];

test("route vertices connect deterministically only within the authored tolerance", () => {
  expect(CREW_ROUTE_CONNECTION_TOLERANCE).toBe(1);
  const graph = buildCrewRouteGraph(routes);
  expect(crewRouteComponents(graph)).toHaveLength(1);
  const disconnected = buildCrewRouteGraph([
    routes[0] as AuthoredCrewRoute,
    {
      id: "far",
      points: [
        { x: 22, y: 0 },
        { x: 40, y: 0 },
      ],
    },
  ]);
  expect(crewRouteComponents(disconnected)).toHaveLength(2);
});

test("nearest route connection and path use authored route segments", () => {
  expect(CREW_ROUTE_ACCESS_TOLERANCE).toBe(8);
  const graph = buildCrewRouteGraph(routes);
  const connection = nearestCrewRouteConnection({ x: 4, y: 3 }, graph);
  expect(connection?.point).toEqual({ x: 4, y: 0 });
  expect(connection?.distance).toBe(3);
  const path = findCrewPath(graph, {
    start: { x: 0, y: 2 },
    destination: { x: 40, y: 2 },
  });
  expect(path?.[0]).toEqual({ x: 0, y: 2 });
  expect(path?.at(-1)).toEqual({ x: 40, y: 2 });
  expect(path).toContainEqual({ x: 20, y: 0 });
  expect(
    findCrewPath(graph, {
      start: { x: 0, y: 20 },
      destination: { x: 40, y: 2 },
    }),
  ).toBeNull();
});

test("rectangle activity areas connect when a route segment crosses the zone", () => {
  const graph = buildCrewRouteGraph(routes);
  const connection = nearestCrewRouteConnection(
    {
      id: "work",
      activity: "general",
      shape: "rectangle",
      facing: null,
      x: 18,
      y: 8,
      width: 4,
      height: 4,
    },
    graph,
  );
  expect(connection?.distance).toBe(0);
});
