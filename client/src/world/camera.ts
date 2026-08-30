export const ZOOM_LEVELS = [2, 3, 4] as const;
export type ZoomLevel = (typeof ZOOM_LEVELS)[number];

export function normalizeZoom(value: number): ZoomLevel {
  return ZOOM_LEVELS.reduce((best, level) =>
    Math.abs(level - value) < Math.abs(best - value) ? level : best,
  );
}

export function stepZoom(current: ZoomLevel, direction: -1 | 1): ZoomLevel {
  const index = ZOOM_LEVELS.indexOf(current);
  return (
    ZOOM_LEVELS[
      Math.max(0, Math.min(ZOOM_LEVELS.length - 1, index + direction))
    ] ?? current
  );
}

export function boundedFocus(
  focus: { x: number; y: number },
  viewport: { width: number; height: number },
  world: { width: number; height: number },
  zoom: ZoomLevel,
) {
  const halfWidth = viewport.width / (2 * zoom);
  const halfHeight = viewport.height / (2 * zoom);
  return {
    x:
      halfWidth * 2 >= world.width
        ? world.width / 2
        : Math.max(halfWidth, Math.min(world.width - halfWidth, focus.x)),
    y:
      halfHeight * 2 >= world.height
        ? world.height / 2
        : Math.max(halfHeight, Math.min(world.height - halfHeight, focus.y)),
  };
}

export function cameraPosition(
  focus: { x: number; y: number },
  viewport: { width: number; height: number },
  world: { width: number; height: number },
  zoom: ZoomLevel,
  horizontalAnchor = 0.5,
) {
  const bounded = boundedFocus(focus, viewport, world, zoom);
  return {
    x: Math.round(viewport.width * horizontalAnchor - bounded.x * zoom),
    y: Math.round(viewport.height / 2 - bounded.y * zoom),
  };
}
