import {
  Application,
  Assets,
  Container,
  Graphics,
  Polygon,
  Rectangle,
  Sprite,
  Text,
  Texture,
  TilingSprite,
} from "pixi.js";
import type { BuildingId } from "../state/app-store";
import {
  authoredCameraPosition,
  fitAuthoredBounds,
  unobscuredViewport,
} from "./authored/authored-camera";
import { crewRouteComponents } from "./authored/crew-navigation";
import type {
  AuthoredImageTile,
  AuthoredInteractionRegion,
  AuthoredLocationId,
  AuthoredTilePlacement,
  AuthoredWorldRegion,
  PanelSide,
  TownRect,
} from "./authored/map-schema";
import {
  type ProjectIslandInstance,
  projectIslandFocusTarget,
  type WorldComposition,
} from "./composition/world-composer";
import type { WorldRegionInstance } from "./composition/world-region";
import { ActiveCrewSystem, type CrewActor } from "./crew/ActiveCrewSystem";
import type { ActiveCrewPresentation } from "./crew/crew-presentation";
import { allHumanV1RuntimeUrls, humanV1LayerUrl } from "./crew/human-v1-assets";
import {
  humanAnimationFrameAt,
  humanHairRoleForFrame,
} from "./crew/human-v1-runtime";
import {
  oceanPresentation,
  SUNNYSIDE_OCEAN_TILE_LOCAL_ID,
  SUNNYSIDE_OCEAN_TILE_SIZE,
  WORLD_PRESENTATION_LAYER_ORDER,
} from "./rendering/ocean-background";
import { regionIsVisible } from "./rendering/region-culling";
import {
  allRuntimeAssets,
  type SunnysideAsset,
  SunnysideAssets,
} from "./runtime/sunnyside-assets";

export interface TownWorldEvents {
  onBuildingSelected(id: BuildingId): void;
  onMemberSelected(runId: string, memberKey: string): void;
}

export interface TownStatusModel {
  preparingReview: number;
  awaitingReview: number;
  attention: number;
  complete: number;
}

export interface TownWorldOptions {
  debugMap?: boolean;
  /** Development capture aid: advance once, then freeze CrewActor time. */
  crewDemoTimeMs?: number;
  crewDemoTransitions?: ReadonlyArray<{
    atMs: number;
    crew: ActiveCrewPresentation[];
  }>;
  demoHoverFirst?: boolean;
}

interface AnimatedSprite {
  sprite: Sprite;
  asset: SunnysideAsset;
  phase: number;
  regionInstanceId: string;
  route?: Array<{ x: number; y: number }>;
}

interface RenderedRegion {
  instance: WorldRegionInstance;
  root: Container;
  activity: Container;
}

interface CrewActorView {
  root: Container;
  body: Container;
  layers: Sprite[];
  tooltip: Text;
  regionInstanceId: string;
}

const palette = {
  ink: 0x29373a,
  cream: 0xfff3d4,
  success: 0x4d9468,
  warning: 0xd99a45,
  failure: 0xc35458,
  review: 0xd98545,
};

export class TownWorld {
  private app = new Application();
  private scene = new Container();
  private oceanLayer = new Container();
  private regionLayer = new Container();
  private globalDebugLayer = new Container();
  private crewDebugLayer = new Container();
  private renderedRegions = new Map<string, RenderedRegion>();
  private statusLayer: Container | null = null;
  private loaded = new Map<string, Texture>();
  private framed = new Map<string, Texture>();
  private labels = new Map<AuthoredLocationId, Text>();
  private animated: AnimatedSprite[] = [];
  private crew: ActiveCrewPresentation[] = [];
  private crewSystem: ActiveCrewSystem;
  private crewViews = new Map<string, CrewActorView>();
  private lastTickAt = performance.now();
  private nextCrewDebugUpdate = 0;
  private crewDemoApplied = false;
  private status: TownStatusModel = {
    preparingReview: 0,
    awaitingReview: 0,
    attention: 0,
    complete: 0,
  };
  private focusedBuilding: AuthoredLocationId | null = null;
  private focusedProjectId: string | null = null;
  private focus = { x: 320, y: 208 };
  private targetFocus = { ...this.focus };
  private zoom: 1 | 2 | 3;
  private cameraMode: "home" | "location" | "project" | "manual" = "home";
  private preferredPanelSide: PanelSide = "right";
  private panelBounds: TownRect | null = null;
  private dragging: { x: number; y: number } | null = null;
  private dragDistance = 0;
  private completionUntil = 0;
  private reducedMotion = matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  private initialized = false;
  private destroyed = false;
  private mounted = false;
  private regionSignature = "";

  constructor(
    private readonly host: HTMLElement,
    private readonly events: TownWorldEvents,
    private composition: WorldComposition,
    initialZoom = 2,
    private readonly options: TownWorldOptions = {},
  ) {
    this.crewSystem = new ActiveCrewSystem(composition);
    this.zoom = this.normalizeZoom(initialZoom);
    this.focus = this.rectCenter(this.homeMap().functionalTownBounds);
    this.targetFocus = { ...this.focus };
  }

  async mount(): Promise<void> {
    const resolution = Math.max(
      1,
      Math.min(2, Math.round(devicePixelRatio || 1)),
    );
    await this.app.init({
      resizeTo: this.host,
      background: "#168fc4",
      antialias: false,
      autoDensity: true,
      preference: "webgl",
      preserveDrawingBuffer: true,
      resolution,
    });
    this.initialized = true;
    if (this.destroyed) {
      this.app.destroy(true, { children: true });
      return;
    }
    this.host.appendChild(this.app.canvas);
    const urls = new Set([
      ...this.composition.templates.flatMap((template) => [
        ...template.authored.tileLayers.flatMap((layer) =>
          layer.tiles.map((tile) => tile.image.url),
        ),
        ...template.authored.staticObjects.map((object) => object.image.url),
      ]),
      ...allRuntimeAssets().map((asset) => asset.url),
      ...allHumanV1RuntimeUrls(),
    ]);
    await Promise.all(
      [...urls].map(async (url) => {
        const texture = await Assets.load<Texture>(url);
        texture.source.scaleMode = "nearest";
        this.loaded.set(url, texture);
      }),
    );
    if (this.destroyed) return;

    this.oceanLayer.label = WORLD_PRESENTATION_LAYER_ORDER[0];
    this.regionLayer.label = WORLD_PRESENTATION_LAYER_ORDER[1];
    this.globalDebugLayer.label = WORLD_PRESENTATION_LAYER_ORDER[2];
    this.scene.addChild(
      this.oceanLayer,
      this.regionLayer,
      this.globalDebugLayer,
    );
    this.globalDebugLayer.addChild(this.crewDebugLayer);
    this.app.stage.addChild(this.scene);
    this.rebuildRegions();
    this.updateStatusMarker();
    this.focusHome();

    this.app.stage.eventMode = "static";
    this.app.stage.hitArea = this.app.screen;
    this.app.stage.on("pointerdown", (event) => {
      this.dragging = { x: event.global.x, y: event.global.y };
      this.dragDistance = 0;
    });
    this.app.stage.on("pointerup", () => {
      this.dragging = null;
    });
    this.app.stage.on("pointerupoutside", () => {
      this.dragging = null;
    });
    this.app.stage.on("pointermove", (event) => {
      if (!this.dragging) return;
      const dx = event.global.x - this.dragging.x;
      const dy = event.global.y - this.dragging.y;
      this.dragDistance += Math.hypot(dx, dy);
      this.targetFocus.x -= Math.round(dx / this.zoom);
      this.targetFocus.y -= Math.round(dy / this.zoom);
      this.focus = { ...this.targetFocus };
      this.cameraMode = "manual";
      this.dragging = { x: event.global.x, y: event.global.y };
    });
    this.host.addEventListener("wheel", this.onWheel, { passive: false });
    window.addEventListener("keydown", this.onKeydown);
    this.app.ticker.add(this.tick);
    this.mounted = true;
  }

  setComposition(composition: WorldComposition): void {
    const signature = composition.regions
      .map(
        (region) =>
          `${region.instanceId}:${region.templateId}:${region.worldOrigin.x}:${region.worldOrigin.y}`,
      )
      .join("|");
    this.composition = composition;
    this.crewSystem.setComposition(composition);
    this.crewSystem.reconcile(this.crew);
    if (this.cameraMode === "project" && this.focusedProjectId) {
      const target = projectIslandFocusTarget(
        composition,
        this.focusedProjectId,
      );
      if (target) this.targetFocus = target.center;
      else this.focusHome();
    }
    if (!this.mounted) return;
    if (signature !== this.regionSignature) this.rebuildRegions();
    else if (this.options.debugMap) this.updateCrewDebugOverlay();
  }

  setCrew(crew: readonly ActiveCrewPresentation[]): void {
    this.crew = [...crew];
    this.crewSystem.reconcile(this.crew);
    this.applyCrewDemoTime();
    if (!this.mounted) return;
    this.syncCrewViews();
    if (this.options.debugMap) this.updateCrewDebugOverlay();
  }

  setStatus(status: TownStatusModel): void {
    if (this.mounted && status.complete > this.status.complete)
      this.completionUntil =
        performance.now() + (this.reducedMotion ? 0 : 2200);
    this.status = status;
    if (this.mounted) this.updateStatusMarker();
  }

  setZoom(value: number): void {
    this.zoom = this.normalizeZoom(value);
  }

  getZoom(): 1 | 2 | 3 {
    return this.zoom;
  }

  setPanelBounds(bounds: TownRect | null): void {
    this.panelBounds = bounds;
    if (this.mounted && this.cameraMode === "home")
      this.zoom = this.overviewZoom();
  }

  focusBuilding(id: BuildingId): void {
    const anchor = this.homeMap().cameraAnchors.find(
      (value) => value.id === id,
    );
    if (!anchor) return;
    this.focusedBuilding = anchor.id;
    this.focusedProjectId = null;
    this.cameraMode = "location";
    this.zoom = anchor.zoom;
    this.preferredPanelSide = anchor.panelSide;
    this.targetFocus = {
      x: anchor.x + this.composition.home.worldOrigin.x,
      y: anchor.y + this.composition.home.worldOrigin.y,
    };
    this.refreshHighlights();
  }

  focusProject(projectId: string): boolean {
    const target = projectIslandFocusTarget(this.composition, projectId);
    if (!target) return false;
    this.focusedBuilding = null;
    this.focusedProjectId = projectId;
    this.cameraMode = "project";
    this.preferredPanelSide = "right";
    this.zoom = fitAuthoredBounds(target.island.bounds, this.viewport());
    this.targetFocus = target.center;
    this.refreshHighlights();
    return true;
  }

  focusWorld(): void {
    this.cameraMode = "manual";
    this.focusedBuilding = null;
    this.focusedProjectId = null;
    this.zoom = 1;
    this.targetFocus = this.rectCenter(this.composition.worldBounds);
    this.refreshHighlights();
  }

  clearBuildingFocus(): void {
    this.focusedBuilding = null;
    this.refreshHighlights();
  }

  focusHome(): void {
    this.cameraMode = "home";
    this.focusedBuilding = null;
    this.focusedProjectId = null;
    this.zoom = this.overviewZoom();
    const bounds = this.homeMap().functionalTownBounds;
    this.targetFocus = {
      x: bounds.x + bounds.width / 2 + this.composition.home.worldOrigin.x,
      y: bounds.y + bounds.height / 2 + this.composition.home.worldOrigin.y,
    };
    this.refreshHighlights();
  }

  /** Compatibility alias for existing controls. */
  focusTown(): void {
    this.focusHome();
  }

  destroy(): void {
    this.destroyed = true;
    this.mounted = false;
    this.host.removeEventListener("wheel", this.onWheel);
    window.removeEventListener("keydown", this.onKeydown);
    if (this.initialized) {
      this.app.ticker.remove(this.tick);
      this.app.destroy(true, { children: true });
    }
  }

  private homeMap(): AuthoredWorldRegion {
    return this.composition.home.template.authored;
  }

  private normalizeZoom(value: number): 1 | 2 | 3 {
    return [1, 2, 3].reduce((best, zoom) =>
      Math.abs(zoom - value) < Math.abs(best - value) ? zoom : best,
    ) as 1 | 2 | 3;
  }

  private onWheel = (event: WheelEvent) => {
    event.preventDefault();
    this.zoom = this.normalizeZoom(this.zoom + (event.deltaY > 0 ? -1 : 1));
    this.cameraMode = "manual";
  };

  private onKeydown = (event: KeyboardEvent) => {
    if (
      (event.target as HTMLElement | null)?.matches(
        "input, textarea, select, button",
      )
    )
      return;
    const amount = event.shiftKey ? 48 : 24;
    if (event.key === "+" || event.key === "=")
      this.zoom = this.normalizeZoom(this.zoom + 1);
    else if (event.key === "-") this.zoom = this.normalizeZoom(this.zoom - 1);
    else if (event.key === "0") this.focusHome();
    else if (event.key === "ArrowLeft" || event.key.toLowerCase() === "a")
      this.targetFocus.x -= amount;
    else if (event.key === "ArrowRight" || event.key.toLowerCase() === "d")
      this.targetFocus.x += amount;
    else if (event.key === "ArrowUp" || event.key.toLowerCase() === "w")
      this.targetFocus.y -= amount;
    else if (event.key === "ArrowDown" || event.key.toLowerCase() === "s")
      this.targetFocus.y += amount;
    else return;
    if (event.key !== "0") this.cameraMode = "manual";
    event.preventDefault();
  };

  private tick = () => {
    const now = performance.now();
    const elapsed = Math.min(100, Math.max(0, now - this.lastTickAt));
    this.lastTickAt = now;
    this.app.stage.hitArea = this.app.screen;
    if (!this.reducedMotion) {
      this.focus.x += (this.targetFocus.x - this.focus.x) * 0.24;
      this.focus.y += (this.targetFocus.y - this.focus.y) * 0.24;
    } else this.focus = { ...this.targetFocus };
    this.positionCamera();
    this.updateRegionCulling();
    if (this.options.crewDemoTimeMs === undefined)
      this.crewSystem.update(elapsed);
    this.syncCrewViews();
    if (this.options.debugMap && now >= this.nextCrewDebugUpdate) {
      this.nextCrewDebugUpdate = now + 250;
      this.updateCrewDebugOverlay();
    }
    this.animated = this.animated.filter((value) => !value.sprite.destroyed);
    for (const animated of this.animated) {
      if (!this.renderedRegions.get(animated.regionInstanceId)?.root.visible)
        continue;
      const frames = animated.asset.frames ?? 1;
      const frame = this.reducedMotion
        ? 0
        : (Math.floor(now / (animated.asset.frameDurationMs ?? 120)) +
            animated.phase) %
          frames;
      animated.sprite.texture = this.assetFrame(animated.asset, frame);
      if (!this.reducedMotion && animated.route && animated.route.length > 1) {
        const segments = animated.route.length - 1;
        const progress = (now / 2400 + animated.phase) % (segments * 2);
        const reflected =
          progress > segments ? segments * 2 - progress : progress;
        const index = Math.min(segments - 1, Math.floor(reflected));
        const start = animated.route[index];
        const end = animated.route[index + 1];
        if (start && end) {
          const amount = reflected - index;
          animated.sprite.position.set(
            Math.round(start.x + (end.x - start.x) * amount),
            Math.round(start.y + (end.y - start.y) * amount),
          );
          animated.sprite.zIndex = Math.round(animated.sprite.y);
        }
      }
    }
  };

  private viewport(): TownRect {
    return unobscuredViewport(
      { width: this.app.screen.width, height: this.app.screen.height },
      this.panelBounds,
      this.preferredPanelSide,
    );
  }

  private overviewZoom(): 1 | 2 | 3 {
    return fitAuthoredBounds(
      this.homeMap().functionalTownBounds,
      this.viewport(),
    );
  }

  private positionCamera(): void {
    const placement = authoredCameraPosition(
      this.focus,
      this.viewport(),
      this.composition.worldBounds,
      this.zoom,
    );
    this.scene.scale.set(this.zoom);
    this.scene.position.set(placement.x, placement.y);
    for (const [id, label] of this.labels)
      label.visible = id === this.focusedBuilding;
  }

  private updateRegionCulling(): void {
    const viewport = this.viewport();
    const worldViewport = {
      x: (viewport.x - this.scene.x) / this.zoom,
      y: (viewport.y - this.scene.y) / this.zoom,
      width: viewport.width / this.zoom,
      height: viewport.height / this.zoom,
    };
    for (const rendered of this.renderedRegions.values())
      rendered.root.visible = regionIsVisible(
        rendered.instance.worldBounds,
        worldViewport,
      );
  }

  private rectCenter(rect: TownRect): { x: number; y: number } {
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }

  private rebuildRegions(): void {
    for (const child of this.regionLayer.removeChildren())
      child.destroy({ children: true });
    this.buildOceanBackground();
    this.renderedRegions.clear();
    this.crewViews.clear();
    this.labels.clear();
    this.animated = [];
    this.statusLayer = null;
    this.regionSignature = this.composition.regions
      .map(
        (region) =>
          `${region.instanceId}:${region.templateId}:${region.worldOrigin.x}:${region.worldOrigin.y}`,
      )
      .join("|");
    for (const instance of this.composition.regions) this.buildRegion(instance);
    this.syncCrewViews();
    this.updateStatusMarker();
    if (this.options.debugMap) this.updateCrewDebugOverlay();
  }

  private buildOceanBackground(): void {
    for (const child of this.oceanLayer.removeChildren()) child.destroy();
    const ocean = oceanPresentation(this.composition.worldBounds);
    const source = this.loaded.get(SunnysideAssets.terrain.world.url);
    if (!source) return;
    const localId = SUNNYSIDE_OCEAN_TILE_LOCAL_ID;
    const textureKey = `world-ocean:${localId}`;
    let texture = this.framed.get(textureKey);
    if (!texture) {
      texture = new Texture({
        source: source.source,
        frame: new Rectangle(
          (localId % 64) * SUNNYSIDE_OCEAN_TILE_SIZE,
          Math.floor(localId / 64) * SUNNYSIDE_OCEAN_TILE_SIZE,
          SUNNYSIDE_OCEAN_TILE_SIZE,
          SUNNYSIDE_OCEAN_TILE_SIZE,
        ),
      });
      this.framed.set(textureKey, texture);
    }
    const sprite = new TilingSprite({
      texture,
      width: ocean.bounds.width,
      height: ocean.bounds.height,
    });
    sprite.label = "sunnyside-repeating-ocean";
    sprite.position.set(ocean.bounds.x, ocean.bounds.y);
    this.oceanLayer.addChild(sprite);
  }

  private buildRegion(instance: WorldRegionInstance): void {
    const map = instance.template.authored;
    const root = new Container();
    root.label = instance.instanceId;
    root.position.set(instance.worldOrigin.x, instance.worldOrigin.y);
    const staticWorld = new Container();
    const activity = new Container();
    const foreground = new Container();
    const overlays = new Container();
    const debug = new Container();
    activity.sortableChildren = true;
    root.addChild(staticWorld, activity, foreground, overlays, debug);
    this.regionLayer.addChild(root);
    this.renderedRegions.set(instance.instanceId, { instance, root, activity });

    for (const layer of map.tileLayers) {
      const container = new Container();
      container.label = layer.name;
      for (const tile of layer.tiles) container.addChild(this.mapSprite(tile));
      if (layer.foreground) foreground.addChild(container);
      else staticWorld.addChild(container);
    }
    const objects = new Container();
    objects.label = "Static Objects Below Members";
    for (const object of [...map.staticObjects].sort((a, b) => a.y - b.y))
      objects.addChild(this.mapSprite(object));
    staticWorld.addChild(objects);

    if (instance.kind === "home") {
      const orderLayer = new Container();
      const statusLayer = new Container();
      const interactionLayer = new Container();
      overlays.addChild(orderLayer, statusLayer, interactionLayer);
      this.statusLayer = statusLayer;
      this.buildInteractions(map, overlays, interactionLayer);
    }
    this.buildAmbientLife(instance, activity);
    if (this.options.debugMap) this.buildDebugOverlay(instance, debug);
  }

  private mapTexture(image: AuthoredImageTile): Texture {
    const key = `${image.url}:${image.localId}`;
    const cached = this.framed.get(key);
    if (cached) return cached;
    const source = this.loaded.get(image.url) ?? Texture.EMPTY;
    if (image.collectionImage) return source;
    const texture = new Texture({
      source: source.source,
      frame: new Rectangle(
        (image.localId % image.columns) * image.tileWidth,
        Math.floor(image.localId / image.columns) * image.tileHeight,
        image.tileWidth,
        image.tileHeight,
      ),
    });
    this.framed.set(key, texture);
    return texture;
  }

  private mapSprite(tile: AuthoredTilePlacement): Sprite {
    const sprite = new Sprite(this.mapTexture(tile.image));
    const width = tile.width ?? tile.image.sourceWidth;
    const height = tile.height ?? tile.image.sourceHeight;
    sprite.anchor.set(0.5);
    sprite.width = width;
    sprite.height = height;
    sprite.position.set(
      tile.x + width / 2,
      tile.anchor === "bottom-left" ? tile.y - height / 2 : tile.y + height / 2,
    );
    if (tile.flipHorizontal) sprite.scale.x *= -1;
    if (tile.flipVertical) sprite.scale.y *= -1;
    if (tile.flipDiagonal) sprite.rotation = Math.PI / 2;
    return sprite;
  }

  private buildInteractions(
    map: AuthoredWorldRegion,
    overlays: Container,
    interactionLayer: Container,
  ): void {
    for (const location of map.locations) {
      const label = this.worldText(location.label, 6, palette.cream);
      label.anchor.set(0.5, 0);
      label.position.set(location.x, location.y + 4);
      label.visible = false;
      this.labels.set(location.id, label);
      overlays.addChild(label);
    }
    for (const region of map.interactionRegions)
      this.buildInteraction(region, interactionLayer);
  }

  private buildInteraction(
    region: AuthoredInteractionRegion,
    interactionLayer: Container,
  ): void {
    const root = new Container();
    root.position.set(region.x, region.y);
    root.eventMode = "static";
    root.cursor = "pointer";
    const hit = new Graphics();
    if (region.polygon) {
      const values = region.polygon.flatMap((point) => [point.x, point.y]);
      hit.poly(values).fill({ color: palette.cream, alpha: 0.001 });
      root.hitArea = new Polygon(values);
    } else {
      hit.rect(0, 0, region.width, region.height).fill({
        color: palette.cream,
        alpha: 0.001,
      });
      root.hitArea = new Rectangle(0, 0, region.width, region.height);
    }
    root.addChild(hit);
    root.on("pointerover", () => {
      const label = this.labels.get(region.locationId);
      if (label) label.visible = true;
    });
    root.on("pointerout", () => {
      const label = this.labels.get(region.locationId);
      if (label) label.visible = this.focusedBuilding === region.locationId;
    });
    root.on("pointertap", () => {
      if (this.dragDistance >= 5) return;
      this.focusBuilding(region.locationId as BuildingId);
      this.events.onBuildingSelected(region.locationId as BuildingId);
    });
    interactionLayer.addChild(root);
  }

  private drawInteractionRegion(
    graphics: Graphics,
    region: AuthoredInteractionRegion,
    color: number,
    alpha: number,
  ): void {
    if (region.polygon)
      graphics
        .poly(region.polygon.flatMap((point) => [point.x, point.y]))
        .fill({ color, alpha })
        .stroke({ color, width: 1 });
    else
      graphics
        .roundRect(0, 0, region.width, region.height, 4)
        .fill({ color, alpha })
        .stroke({ color, width: 1 });
  }

  private refreshHighlights(): void {
    for (const [id, label] of this.labels)
      label.visible = id === this.focusedBuilding;
  }

  private buildAmbientLife(
    instance: WorldRegionInstance,
    activity: Container,
  ): void {
    const map = instance.template.authored;
    const routes = new Map(
      map.animalRoutes.map((route) => [route.variant, route]),
    );
    for (const [index, zone] of map.ambientZones.entries()) {
      const asset =
        zone.variant === "duck"
          ? SunnysideAssets.animals.duck
          : zone.variant === "bird"
            ? SunnysideAssets.animals.bird
            : SunnysideAssets.animals.chicken;
      const route = routes.get(zone.variant);
      const point = route?.points[0] ?? {
        x: zone.x + zone.width / 2,
        y: zone.y + zone.height / 2,
      };
      this.addAnimated(
        instance.instanceId,
        activity,
        asset,
        point.x,
        point.y,
        index * 3,
        route?.points,
      );
    }
  }

  private texture(asset: SunnysideAsset): Texture {
    return this.loaded.get(asset.url) ?? Texture.EMPTY;
  }

  private assetFrame(asset: SunnysideAsset, frame = 0): Texture {
    if (!asset.rect) return this.texture(asset);
    const x = asset.rect.x + asset.rect.width * frame;
    const key = `${asset.url}:${x}:${asset.rect.y}:${asset.rect.width}:${asset.rect.height}`;
    const cached = this.framed.get(key);
    if (cached) return cached;
    const source = this.texture(asset);
    const texture = new Texture({
      source: source.source,
      frame: new Rectangle(
        x,
        asset.rect.y,
        asset.rect.width,
        asset.rect.height,
      ),
    });
    this.framed.set(key, texture);
    return texture;
  }

  private addAnimated(
    regionInstanceId: string,
    activityLayer: Container,
    asset: SunnysideAsset,
    x: number,
    y: number,
    phase: number,
    route?: Array<{ x: number; y: number }>,
  ): void {
    const sprite = new Sprite(this.assetFrame(asset));
    sprite.anchor.set(asset.anchor[0], asset.anchor[1]);
    sprite.position.set(x, y);
    sprite.zIndex = Math.round(y);
    activityLayer.addChild(sprite);
    this.animated.push({
      sprite,
      asset,
      phase,
      regionInstanceId,
      ...(route ? { route } : {}),
    });
  }

  private humanFrameTexture(role: string, actor: CrewActor): Texture {
    const frame = humanAnimationFrameAt(
      actor.animation,
      actor.animationElapsedMs,
    );
    const resolvedRole = role.startsWith("hair-")
      ? humanHairRoleForFrame(role, frame.index)
      : role;
    const url = humanV1LayerUrl(resolvedRole);
    const key = `human-v1:${url}:${frame.index}`;
    const cached = this.framed.get(key);
    if (cached) return cached;
    const source = this.loaded.get(url) ?? Texture.EMPTY;
    const texture = new Texture({
      source: source.source,
      frame: new Rectangle(
        frame.rect.x,
        frame.rect.y,
        frame.rect.w,
        frame.rect.h,
      ),
    });
    this.framed.set(key, texture);
    return texture;
  }

  private syncCrewViews(): void {
    const actors = this.crewSystem.actors();
    const active = new Set(actors.map((actor) => actor.actorId));
    for (const [actorId, view] of this.crewViews) {
      if (active.has(actorId)) continue;
      view.root.destroy({ children: true });
      this.crewViews.delete(actorId);
    }
    for (const actor of actors) {
      const rendered = this.renderedRegions.get(actor.islandRegionId);
      if (!rendered) continue;
      const existing = this.crewViews.get(actor.actorId);
      if (existing?.regionInstanceId === actor.islandRegionId) continue;
      existing?.root.destroy({ children: true });
      const view = this.buildCrewActorView(actor);
      rendered.activity.addChild(view.root);
      this.crewViews.set(actor.actorId, view);
    }
    this.updateCrewViews();
  }

  private buildCrewActorView(actor: CrewActor): CrewActorView {
    const root = new Container();
    root.label = `active-crew:${actor.actorId}`;
    root.eventMode = "static";
    root.cursor = "pointer";
    root.hitArea = new Rectangle(-12, -38, 24, 40);

    const accent = new Graphics()
      .ellipse(0, -1, 8, 3)
      .fill({ color: actor.activity.squadAccentColor, alpha: 0.18 })
      .stroke({ color: actor.activity.squadAccentColor, width: 1, alpha: 0.9 });
    const body = new Container();
    const roles = [
      "tools-rear",
      "base",
      actor.appearance.hairRole,
      "tools-front",
    ];
    const layers = roles.map((role) => {
      const sprite = new Sprite(this.humanFrameTexture(role, actor));
      sprite.anchor.set(0.5, 1);
      return sprite;
    });
    body.addChild(...layers);

    const tooltip = this.worldText(
      `${actor.activity.memberName}\n${actor.activity.className} · ${actor.activity.squadName}\n${actor.activity.questTitle}\n${actor.activity.stepName}`,
      5,
      palette.cream,
    );
    tooltip.anchor.set(0.5, 1);
    tooltip.position.set(0, -42);
    tooltip.visible =
      this.options.demoHoverFirst === true && this.crewViews.size === 0;
    root.addChild(accent, body, tooltip);
    root.on("pointerover", () => {
      tooltip.visible = true;
    });
    root.on("pointerout", () => {
      tooltip.visible = false;
    });
    root.on("pointertap", () => {
      if (this.dragDistance >= 5) return;
      this.events.onMemberSelected(
        actor.activity.runId,
        actor.activity.memberKey,
      );
    });
    return {
      root,
      body,
      layers,
      tooltip,
      regionInstanceId: actor.islandRegionId,
    };
  }

  private applyCrewDemoTime(): void {
    if (
      this.crewDemoApplied ||
      this.options.crewDemoTimeMs === undefined ||
      this.crewSystem.actors().length === 0
    )
      return;
    const targetTime = this.options.crewDemoTimeMs;
    let cursor = 0;
    const advance = (duration: number) => {
      let remaining = duration;
      while (remaining > 0) {
        const elapsed = Math.min(16, remaining);
        this.crewSystem.update(elapsed);
        remaining -= elapsed;
      }
    };
    for (const transition of [...(this.options.crewDemoTransitions ?? [])].sort(
      (a, b) => a.atMs - b.atMs,
    )) {
      if (transition.atMs > targetTime) break;
      advance(Math.max(0, transition.atMs - cursor));
      cursor = transition.atMs;
      this.crew = [...transition.crew];
      this.crewSystem.reconcile(this.crew);
    }
    advance(Math.max(0, targetTime - cursor));
    this.crewDemoApplied = true;
  }

  private updateCrewViews(): void {
    for (const actor of this.crewSystem.actors()) {
      const view = this.crewViews.get(actor.actorId);
      const rendered = this.renderedRegions.get(actor.islandRegionId);
      if (!view || !rendered || !rendered.root.visible) continue;
      const position = this.crewSystem.renderPosition(actor);
      view.root.position.set(
        Math.round(position.x - rendered.instance.worldOrigin.x),
        Math.round(position.y - rendered.instance.worldOrigin.y),
      );
      view.root.zIndex = Math.round(view.root.y);
      view.body.scale.x = actor.mirrorX ? -1 : 1;
      const roles = [
        "tools-rear",
        "base",
        actor.appearance.hairRole,
        "tools-front",
      ];
      for (const [index, sprite] of view.layers.entries()) {
        const role = roles[index];
        if (role) sprite.texture = this.humanFrameTexture(role, actor);
      }
    }
  }

  private updateStatusMarker(): void {
    if (!this.statusLayer) return;
    for (const child of this.statusLayer.removeChildren())
      child.destroy({ children: true });
    const anchor = this.homeMap().statusAnchors.find(
      (value) => value.locationId === "quest-board",
    );
    if (!anchor) return;
    const values = [
      {
        count: this.status.attention,
        symbol: "!",
        color: palette.failure,
        label: "delivery attention",
      },
      {
        count: this.status.awaitingReview,
        symbol: "PR",
        color: palette.review,
        label: "PR awaiting review",
      },
      {
        count: this.status.preparingReview,
        symbol: "…",
        color: palette.warning,
        label: "preparing review",
      },
      {
        count: this.status.complete,
        symbol: "✓",
        color: palette.success,
        label: "Quest complete",
      },
    ];
    const active = values.find((value) => value.count > 0);
    if (!active) return;
    const marker = new Container();
    const back = new Graphics()
      .roundRect(-18, -9, 36, 18, 8)
      .fill(palette.cream)
      .stroke({ color: active.color, width: 2 });
    const symbol = this.worldText(active.symbol, 7, active.color);
    symbol.anchor.set(0.5);
    const label = this.worldText(
      active.count > 1 ? String(active.count) : active.label,
      5,
      palette.cream,
    );
    label.anchor.set(0.5);
    label.y = -13;
    marker.addChild(back, symbol, label);
    if (
      active.label === "Quest complete" &&
      this.completionUntil > performance.now()
    ) {
      const glint = new Sprite(this.assetFrame(SunnysideAssets.effects.glint));
      glint.anchor.set(0.5);
      glint.position.set(22, -10);
      marker.addChild(glint);
      this.animated.push({
        sprite: glint,
        asset: SunnysideAssets.effects.glint,
        phase: 0,
        regionInstanceId: this.composition.home.instanceId,
      });
    }
    marker.position.set(anchor.x, anchor.y);
    this.statusLayer.addChild(marker);
  }

  private buildDebugOverlay(
    instance: WorldRegionInstance,
    debugLayer: Container,
  ): void {
    const map = instance.template.authored;
    const bounds = map.bounds;
    const boundsGraphic = new Graphics()
      .rect(bounds.x, bounds.y, bounds.width, bounds.height)
      .fill({ color: 0xfacc15, alpha: 0.025 })
      .stroke({ color: 0xfacc15, width: 1 });
    const project = instance.project
      ? ` · Project ${instance.project.key} (${instance.project.id})`
      : "";
    const boundsLabel = this.worldText(
      `${instance.kind}:${instance.instanceId} · ${instance.templateId}${project}\nsource ${map.source}\nlocal ${bounds.x},${bounds.y} · world origin ${instance.worldOrigin.x},${instance.worldOrigin.y}\nworld bounds ${instance.worldBounds.x},${instance.worldBounds.y},${instance.worldBounds.width},${instance.worldBounds.height}`,
      5,
      0xfacc15,
    );
    boundsLabel.position.set(bounds.x + 3, bounds.y + 3);
    debugLayer.addChild(boundsGraphic, boundsLabel);

    const drawPoint = (x: number, y: number, color: number, label: string) => {
      const graphic = new Graphics()
        .moveTo(x - 4, y)
        .lineTo(x + 4, y)
        .moveTo(x, y - 4)
        .lineTo(x, y + 4)
        .stroke({ color, width: 1 });
      const text = this.worldText(label, 5, color);
      text.position.set(x + 5, y - 4);
      debugLayer.addChild(graphic, text);
    };

    for (const location of map.locations)
      drawPoint(location.x, location.y, 0x3b82f6, `location:${location.id}`);
    for (const region of map.interactionRegions) {
      const graphics = new Graphics();
      graphics.position.set(region.x, region.y);
      this.drawInteractionRegion(graphics, region, 0x22c55e, 0.08);
      debugLayer.addChild(graphics);
    }
    for (const anchor of map.cameraAnchors)
      drawPoint(anchor.x, anchor.y, 0xfacc15, `camera:${anchor.id}`);
    for (const station of map.workstations)
      drawPoint(
        station.x,
        station.y,
        0xf97316,
        `legacy-workstation:${station.id}`,
      );
    for (const home of map.memberHomes)
      drawPoint(home.x, home.y, 0xa855f7, `legacy-home:${home.id}`);
    for (const spawn of map.crewNavigation.spawns)
      drawPoint(spawn.x, spawn.y, 0x14b8a6, `crew-spawn:${spawn.id}`);
    for (const route of map.crewNavigation.routes) {
      const first = route.points[0];
      if (!first) continue;
      const graphic = new Graphics().moveTo(first.x, first.y);
      for (const point of route.points.slice(1))
        graphic.lineTo(point.x, point.y);
      graphic.stroke({ color: 0x2dd4bf, width: 1 });
      debugLayer.addChild(graphic);
      drawPoint(first.x, first.y, 0x2dd4bf, `crew-route:${route.id}`);
    }
    for (const zone of map.crewNavigation.activities) {
      if (zone.shape === "point")
        drawPoint(
          zone.x,
          zone.y,
          0xe879f9,
          `crew:${zone.activity}:${zone.id}:facing=${zone.facing ?? "fallback"}`,
        );
      else {
        const graphic = new Graphics()
          .rect(zone.x, zone.y, zone.width, zone.height)
          .fill({ color: 0xe879f9, alpha: 0.08 })
          .stroke({ color: 0xe879f9, width: 1 });
        const text = this.worldText(
          `crew:${zone.activity}:${zone.id}`,
          5,
          0xe879f9,
        );
        text.position.set(zone.x + 3, zone.y + 3);
        debugLayer.addChild(graphic, text);
      }
    }
    for (const socket of map.islandSockets)
      drawPoint(
        socket.x,
        socket.y,
        0xfb7185,
        `socket:${socket.id}:${socket.role}:${socket.edge}:${socket.orientation}${socket.category ? `:${socket.category}` : ""}`,
      );
    for (const anchor of map.statusAnchors)
      drawPoint(anchor.x, anchor.y, 0xef4444, anchor.id);
    for (const zone of map.ambientZones) {
      const graphic = new Graphics()
        .rect(zone.x, zone.y, zone.width, zone.height)
        .fill({ color: 0x06b6d4, alpha: 0.08 })
        .stroke({ color: 0x06b6d4, width: 1 });
      debugLayer.addChild(graphic);
    }
    for (const route of map.animalRoutes) {
      const first = route.points[0];
      if (!first) continue;
      const graphic = new Graphics().moveTo(first.x, first.y);
      for (const point of route.points.slice(1))
        graphic.lineTo(point.x, point.y);
      graphic.stroke({ color: 0x38bdf8, width: 1 });
      debugLayer.addChild(graphic);
    }
    for (const site of map.reservedSites) {
      const graphic = new Graphics()
        .rect(site.x, site.y, site.width, site.height)
        .fill({ color: 0x9ca3af, alpha: 0.08 })
        .stroke({ color: 0x9ca3af, width: 1 });
      const text = this.worldText(`reserved:${site.id}`, 5, 0x9ca3af);
      text.position.set(site.x + 3, site.y + 3);
      debugLayer.addChild(graphic, text);
    }
  }

  private updateCrewDebugOverlay(): void {
    for (const child of this.crewDebugLayer.removeChildren())
      child.destroy({ children: true });
    for (const island of this.composition.projectIslands.values())
      this.buildProjectDebug(island);
    const home = this.composition.home.worldBounds;
    const ocean = oceanPresentation(this.composition.worldBounds);
    const summary = this.worldText(
      `archipelago · ${this.composition.regions.length} regions · ${this.composition.projectIslands.values().length} Project islands · ${this.crew.length} authoritative active crew\nocean ${ocean.bounds.x},${ocean.bounds.y},${ocean.bounds.width},${ocean.bounds.height} · ${ocean.tileSize}px repeat · ${ocean.displayObjects} TilingSprite/${ocean.textureInstances} texture · ${ocean.estimatedVisibleTiles} virtual tiles`,
      5,
      0x5eead4,
    );
    summary.position.set(home.x + 4, home.y + 14);
    this.crewDebugLayer.addChild(summary);
  }

  private buildProjectDebug(island: ProjectIslandInstance): void {
    const graph = island.crewNavigation.graph;
    const districts = island.crewNavigation.activities.filter(
      (activity) => activity.shape === "rectangle",
    );
    const anchors = island.crewNavigation.activities.filter(
      (activity) => activity.shape === "point",
    );
    const categories = (values: typeof districts) =>
      [...new Set(values.map((activity) => activity.activity))]
        .sort()
        .map(
          (category) =>
            `${category}:${values.filter((activity) => activity.activity === category).length}`,
        )
        .join(", ");
    const homeCenter = this.rectCenter(this.composition.home.worldBounds);
    const islandCenter = this.rectCenter(island.bounds);
    const homeDistance = Math.round(
      Math.hypot(islandCenter.x - homeCenter.x, islandCenter.y - homeCenter.y),
    );
    const lines = [
      `Project island ${island.project.key} · slot ${island.placementSlot} · Home distance ${homeDistance}`,
      `footprint ${island.bounds.width}x${island.bounds.height}`,
      `${island.regionIds.length} regions · expansions: ${island.attachments.map((attachment) => attachment.instance.instanceId).join(", ") || "none"}`,
      `spawns:${island.crewNavigation.spawns.length} · routes ${graph.nodes.length}n/${graph.edges.length}e/${crewRouteComponents(graph).length}c`,
      `districts:${districts.length} ${categories(districts)}`,
      `exact anchors:${anchors.length} ${categories(anchors)}`,
      `sockets:${island.regionIds.reduce((count, regionId) => count + (this.renderedRegions.get(regionId)?.instance.template.authored.islandSockets.length ?? 0), 0)}`,
      `${island.activeActorCount} actors · Runs: ${island.activeRunIds.join(", ") || "none"}`,
    ];
    const text = this.worldText(lines.join("\n"), 5, 0x5eead4);
    text.position.set(island.bounds.x + 4, island.bounds.y + 24);
    this.crewDebugLayer.addChild(text);
    const actors = this.crewSystem
      .actors()
      .filter((actor) => actor.projectId === island.project.id);
    for (const [index, actor] of actors.entries()) {
      const path = actor.path;
      const first = path[0];
      if (first) {
        const route = new Graphics().moveTo(first.x, first.y);
        for (const point of path.slice(1)) route.lineTo(point.x, point.y);
        route.stroke({ color: actor.activity.squadAccentColor, width: 0.75 });
        route
          .circle(actor.destination.x, actor.destination.y, 2)
          .stroke({ color: 0xffffff, width: 1 });
        this.crewDebugLayer.addChild(route);
      }
      const position = this.crewSystem.renderPosition(actor);
      const dot = new Graphics()
        .circle(position.x, position.y, 2)
        .fill(actor.activity.squadAccentColor);
      const claim = actor.claim
        ? actor.claim.slot.kind === "exact-anchor"
          ? `exact:${actor.claim.slot.zoneId}`
          : `district:${actor.claim.slot.zoneId}`
        : "claim:none";
      const departure = actor.departureTarget
        ? `${actor.departureTarget.x.toFixed(1)},${actor.departureTarget.y.toFixed(1)}`
        : "none";
      const actorText = this.worldText(
        `${actor.activity.memberName} · ${actor.activity.projectKey}\nActor ${actor.actorId}\nRun ${actor.activity.runId} · Member ${actor.activity.memberKey}\nauthoritativeRunning:${actor.authoritativeRunning} · presentationState:${actor.state}\n${actor.activityCategory} · ${claim} · facing:${actor.facing}\nworkFacing:${actor.workFacingSource} · animation:${actor.animationTag}${actor.mirrorX ? " mirrored" : ""}\nlane ${actor.laneOffset} · target ${actor.destination.x.toFixed(1)},${actor.destination.y.toFixed(1)} · departure:${departure}\npath ${actor.pathIndex}/${actor.path.length} · age:${Math.round(actor.presentationAgeMs)}ms · min-work:${Math.round(this.crewSystem.minimumWorkRemaining(actor))}ms · #${actor.activity.squadAccentColor.toString(16).padStart(6, "0")}`,
        4,
        actor.activity.squadAccentColor,
      );
      actorText.position.set(
        island.bounds.x + 4,
        island.bounds.y + 68 + index * 46,
      );
      this.crewDebugLayer.addChild(dot, actorText);
    }
  }

  private worldText(text: string, size: number, color: number): Text {
    return new Text({
      text,
      style: {
        fill: color,
        fontFamily: "Georgia, ui-serif, serif",
        fontSize: size,
        fontWeight: "700",
        stroke: { color: palette.ink, width: 2 },
      },
    });
  }
}
