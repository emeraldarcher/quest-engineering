import type { PanelSide, TownPoint, TownRect } from "./map-schema";

export type AuthoredZoom = 1 | 2 | 3;

export function unobscuredViewport(
  screen: { width: number; height: number },
  panel: TownRect | null,
  panelSide: PanelSide,
  top = 52,
): TownRect {
  let left = 0;
  let right = screen.width;
  if (panel) {
    if (panelSide === "right") right = panel.x - 12;
    else left = panel.x + panel.width + 12;
  }
  return {
    x: left,
    y: top,
    width: Math.max(160, right - left),
    height: Math.max(120, screen.height - top),
  };
}

export function fitAuthoredBounds(
  bounds: TownRect,
  viewport: TownRect,
  padding = 24,
): AuthoredZoom {
  const fit = Math.min(
    (viewport.width - padding * 2) / bounds.width,
    (viewport.height - padding * 2) / bounds.height,
  );
  if (fit >= 3) return 3;
  if (fit >= 2) return 2;
  return 1;
}

export function authoredCameraPosition(
  focus: TownPoint,
  viewport: TownRect,
  world: TownRect,
  zoom: AuthoredZoom,
): { x: number; y: number; boundedFocus: TownPoint } {
  const halfWidth = viewport.width / (2 * zoom);
  const halfHeight = viewport.height / (2 * zoom);
  const x =
    halfWidth * 2 >= world.width
      ? world.x + world.width / 2
      : Math.max(
          world.x + halfWidth,
          Math.min(world.x + world.width - halfWidth, focus.x),
        );
  const y =
    halfHeight * 2 >= world.height
      ? world.y + world.height / 2
      : Math.max(
          world.y + halfHeight,
          Math.min(world.y + world.height - halfHeight, focus.y),
        );
  return {
    x: Math.round(viewport.x + viewport.width / 2 - x * zoom),
    y: Math.round(viewport.y + viewport.height / 2 - y * zoom),
    boundedFocus: { x, y },
  };
}
