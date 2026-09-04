import { expect, test } from "bun:test";
import type { AuthoredCrewActivity } from "../authored/map-schema";
import { activitySlots, CrewActivityAllocator } from "./CrewActivityAllocator";

const zones: AuthoredCrewActivity[] = [
  {
    id: "craft-point",
    activity: "crafting",
    shape: "point",
    x: 5,
    y: 5,
    width: 0,
    height: 0,
  },
  {
    id: "general-yard",
    activity: "general",
    shape: "rectangle",
    x: 20,
    y: 20,
    width: 120,
    height: 48,
  },
];

test("activity rectangles generate practical capacity without a global maximum", () => {
  expect(
    activitySlots(zones[1] as AuthoredCrewActivity).length,
  ).toBeGreaterThanOrEqual(24);
  const allocator = new CrewActivityAllocator(zones);
  const claims = Array.from({ length: 24 }, (_, index) =>
    allocator.claim(`actor-${index}`, "general"),
  );
  expect(claims.every(Boolean)).toBe(true);
  expect(new Set(claims.map((claim) => claim?.slot.id)).size).toBe(24);
});

test("district overflow never becomes execution or actor capacity", () => {
  const allocator = new CrewActivityAllocator(zones);
  const claims = Array.from({ length: 200 }, (_, index) =>
    allocator.claim(`overflow-${index}`, "general"),
  );
  expect(claims.every(Boolean)).toBe(true);
});

test("exclusive slots fall back to general and are released", () => {
  const allocator = new CrewActivityAllocator(zones);
  const first = allocator.claim("a", "crafting");
  const fallback = allocator.claim("b", "crafting");
  expect(first?.resolvedActivity).toBe("crafting");
  expect(fallback?.resolvedActivity).toBe("general");
  allocator.release("a");
  expect(allocator.claim("c", "crafting")?.slot.id).toBe("craft-point:1");
});

test("claims remain stable across duplicate reconciliation", () => {
  const allocator = new CrewActivityAllocator(zones);
  const first = allocator.claim("a", "general");
  expect(allocator.claim("a", "general")).toEqual(first);
  allocator.reconcile(new Set());
  expect(allocator.snapshot()).toEqual([]);
});
