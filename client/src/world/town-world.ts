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
} from "pixi.js";
import type { BuildingId } from "../state/app-store";
import {
  authoredCameraPosition,
  fitAuthoredBounds,
  unobscuredViewport,
} from "./authored/authored-camera";
import type {
  AuthoredImageTile,
  AuthoredInteractionRegion,
  AuthoredLocationId,
  AuthoredTilePlacement,
  AuthoredTownMap,
  PanelSide,
  TownRect,
} from "./authored/map-schema";
import type {
  MemberWorldModel,
  RunWorldModel,
  VisualActivity,
} from "./projector";
import {
  allRuntimeAssets,
  type HairStyle,
  hairStyles,
  type SpikeCharacterAction,
  type SunnysideAsset,
  SunnysideAssets,
} from "./runtime/sunnyside-assets";
import {
  assignMemberHomes,
  assignWorkSites,
  memberIdentity,
} from "./visual-identity";

export interface TownWorldEvents {
  onBuildingSelected(id: BuildingId): void;
  onMemberSelected(memberKey: string): void;
}

export interface TownStatusModel {
  preparingReview: number;
  awaitingReview: number;
  attention: number;
  complete: number;
}

export interface TownWorldOptions {
  debugMap?: boolean;
}

interface MemberEntity {
  container: Container;
  base: Sprite;
  hair: Sprite;
  marker: Graphics;
  glyph: Graphics;
  name: Text;
  status: Text;
  model: MemberWorldModel;
  identity: ReturnType<typeof memberIdentity>;
  hairStyle: HairStyle;
  target: { x: number; y: number };
  home: { x: number; y: number };
  previousCompleted: Set<string>;
  completedUntil: number;
  hovered: boolean;
}

interface AnimatedSprite {
  sprite: Sprite;
  asset: SunnysideAsset;
  phase: number;
  route?: Array<{ x: number; y: number }>;
}

const palette = {
  ink: 0x29373a,
  cream: 0xfff3d4,
  paper: 0xf3dfb5,
  success: 0x4d9468,
  moving: 0x4e8ca0,
  warning: 0xd99a45,
  failure: 0xc35458,
  uncertain: 0x845d99,
  review: 0xd98545,
};

export class TownWorld {
  private app = new Application();
  private scene = new Container();
  private staticWorld = new Container();
  private activity = new Container();
  private foreground = new Container();
  private overlays = new Container();
  private interactionLayer = new Container();
  private orderLayer = new Container();
  private statusLayer = new Container();
  private debugLayer = new Container();
  private loaded = new Map<string, Texture>();
  private framed = new Map<string, Texture>();
  private members = new Map<string, MemberEntity>();
  private labels = new Map<AuthoredLocationId, Text>();
  private animated: AnimatedSprite[] = [];
  private model: RunWorldModel | null = null;
  private status: TownStatusModel = {
    preparingReview: 0,
    awaitingReview: 0,
    attention: 0,
    complete: 0,
  };
  private focusedBuilding: AuthoredLocationId | null = null;
  private selectedMemberKey: string | null = null;
  private focus = { x: 320, y: 208 };
  private targetFocus = { ...this.focus };
  private zoom: 1 | 2 | 3;
  private cameraMode: "town" | "location" | "member" | "manual" = "town";
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

  constructor(
    private readonly host: HTMLElement,
    private readonly events: TownWorldEvents,
    private readonly map: AuthoredTownMap,
    initialZoom = 2,
    private readonly options: TownWorldOptions = {},
  ) {
    this.zoom = this.normalizeZoom(initialZoom);
    this.focus = this.rectCenter(map.functionalTownBounds);
    this.targetFocus = { ...this.focus };
  }

  async mount(): Promise<void> {
    const resolution = Math.max(
      1,
      Math.min(2, Math.round(devicePixelRatio || 1)),
    );
    await this.app.init({
      resizeTo: this.host,
      background: "#cfe7bd",
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
      ...this.map.tileLayers.flatMap((layer) =>
        layer.tiles.map((tile) => tile.image.url),
      ),
      ...this.map.staticObjects.map((object) => object.image.url),
      ...allRuntimeAssets().map((asset) => asset.url),
    ]);
    await Promise.all(
      [...urls].map(async (url) => {
        const texture = await Assets.load<Texture>(url);
        texture.source.scaleMode = "nearest";
        this.loaded.set(url, texture);
      }),
    );
    if (this.destroyed) return;

    this.scene.addChild(
      this.staticWorld,
      this.activity,
      this.foreground,
      this.overlays,
      this.debugLayer,
    );
    this.activity.sortableChildren = true;
    this.overlays.addChild(
      this.orderLayer,
      this.statusLayer,
      this.interactionLayer,
    );
    this.app.stage.addChild(this.scene);
    this.buildStaticMap();
    this.buildInteractions();
    this.buildAmbientLife();
    if (this.options.debugMap) this.buildDebugOverlay();
    this.updateStatusMarker();
    this.updateMembers();
    this.focusTown();

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

  setModel(model: RunWorldModel | null): void {
    this.model = model;
    if (this.mounted) this.updateMembers();
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
    if (this.mounted && this.cameraMode === "town")
      this.zoom = this.overviewZoom();
  }

  focusBuilding(id: BuildingId): void {
    const anchor = this.map.cameraAnchors.find((value) => value.id === id);
    if (!anchor) return;
    this.focusedBuilding = anchor.id;
    this.selectedMemberKey = null;
    this.cameraMode = "location";
    this.zoom = anchor.zoom;
    this.preferredPanelSide = anchor.panelSide;
    this.targetFocus = { x: anchor.x, y: anchor.y };
    this.refreshHighlights();
  }

  clearBuildingFocus(): void {
    this.focusedBuilding = null;
    this.refreshHighlights();
  }

  focusMember(memberKey: string): void {
    this.selectedMemberKey = memberKey;
    const entity = this.members.get(memberKey);
    if (!entity) return;
    this.cameraMode = "member";
    this.targetFocus = { x: entity.container.x, y: entity.container.y - 10 };
    this.refreshMemberPresentation(entity);
  }

  focusTown(): void {
    this.cameraMode = "town";
    this.focusedBuilding = null;
    this.selectedMemberKey = null;
    this.zoom = this.overviewZoom();
    this.targetFocus = this.rectCenter(this.map.functionalTownBounds);
    this.refreshHighlights();
    for (const entity of this.members.values())
      this.refreshMemberPresentation(entity);
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
    else if (event.key === "0") this.focusTown();
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
    this.app.stage.hitArea = this.app.screen;
    if (!this.reducedMotion) {
      this.focus.x += (this.targetFocus.x - this.focus.x) * 0.24;
      this.focus.y += (this.targetFocus.y - this.focus.y) * 0.24;
    } else this.focus = { ...this.targetFocus };
    this.positionCamera();
    for (const entity of this.members.values()) this.animateMember(entity, now);
    this.animated = this.animated.filter(
      (animated) => !animated.sprite.destroyed,
    );
    for (const animated of this.animated) {
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
    return fitAuthoredBounds(this.map.functionalTownBounds, this.viewport());
  }

  private positionCamera(): void {
    const placement = authoredCameraPosition(
      this.focus,
      this.viewport(),
      this.map.bounds,
      this.zoom,
    );
    this.scene.scale.set(this.zoom);
    this.scene.position.set(placement.x, placement.y);
    for (const [id, label] of this.labels)
      label.visible = id === this.focusedBuilding;
  }

  private rectCenter(rect: TownRect): { x: number; y: number } {
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }

  private buildStaticMap(): void {
    for (const layer of this.map.tileLayers) {
      const container = new Container();
      container.label = layer.name;
      for (const tile of layer.tiles) container.addChild(this.mapSprite(tile));
      if (layer.foreground) this.foreground.addChild(container);
      else this.staticWorld.addChild(container);
    }
    const objects = new Container();
    objects.label = "Static Objects Below Members";
    for (const object of [...this.map.staticObjects].sort((a, b) => a.y - b.y))
      objects.addChild(this.mapSprite(object));
    this.staticWorld.addChild(objects);
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

  private buildInteractions(): void {
    for (const location of this.map.locations) {
      const label = this.worldText(location.label, 6, palette.cream);
      label.anchor.set(0.5, 0);
      label.position.set(location.x, location.y + 4);
      label.visible = false;
      this.labels.set(location.id, label);
      this.overlays.addChild(label);
    }
    for (const region of this.map.interactionRegions)
      this.buildInteraction(region);
  }

  private buildInteraction(region: AuthoredInteractionRegion): void {
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
      hit
        .rect(0, 0, region.width, region.height)
        .fill({ color: palette.cream, alpha: 0.001 });
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
    this.interactionLayer.addChild(root);
  }

  private drawRegion(
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

  private buildAmbientLife(): void {
    const routes = new Map(
      this.map.animalRoutes.map((route) => [route.variant, route]),
    );
    for (const [index, zone] of this.map.ambientZones.entries()) {
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
      this.addAnimated(asset, point.x, point.y, index * 3, route?.points);
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
    this.activity.addChild(sprite);
    this.animated.push({
      sprite,
      asset,
      phase,
      ...(route ? { route } : {}),
    });
  }

  private updateMembers(): void {
    const incoming = new Set(
      this.model?.members.map((value) => value.member.member_key) ?? [],
    );
    for (const [key, entity] of this.members) {
      if (!incoming.has(key)) {
        entity.container.destroy({ children: true });
        this.members.delete(key);
      }
    }
    if (!this.model) {
      this.updateOrders();
      return;
    }
    const memberKeys = this.model.members.map(
      (member) => member.member.member_key,
    );
    const homes = assignMemberHomes(
      this.model.squadKey,
      memberKeys,
      this.map.memberHomes,
    );
    const assignments = this.model.members
      .filter((member) => member.activeOccurrenceId)
      .map((member) => ({
        occurrenceId: member.activeOccurrenceId as string,
        memberKey: member.member.member_key,
      }));
    const sites = assignWorkSites(assignments, this.map.workstations);
    for (const member of this.model.members) {
      const key = member.member.member_key;
      const home = homes.get(key) ?? this.map.memberHomes[0];
      if (!home) continue;
      let entity = this.members.get(key);
      if (!entity) {
        entity = this.createMember(member, this.model.squadKey, home);
        this.members.set(key, entity);
        this.activity.addChild(entity.container);
      }
      const newlyCompleted = member.completedOccurrenceIds.some(
        (id) => !entity?.previousCompleted.has(id),
      );
      if (newlyCompleted) entity.completedUntil = performance.now() + 1400;
      entity.previousCompleted = new Set(member.completedOccurrenceIds);
      entity.model = member;
      entity.home = { x: home.x, y: home.y };
      const site = member.activeOccurrenceId
        ? sites.get(member.activeOccurrenceId)
        : null;
      entity.target = site
        ? { x: site.x, y: site.y }
        : { x: home.x, y: home.y };
      if (
        member.visual === "working" ||
        member.visual === "failed" ||
        member.visual === "uncertain"
      )
        entity.container.position.set(entity.target.x, entity.target.y);
      this.refreshMemberPresentation(entity);
    }
    this.updateOrders();
  }

  private createMember(
    model: MemberWorldModel,
    squadKey: string,
    home: { x: number; y: number },
  ): MemberEntity {
    const identity = memberIdentity(squadKey, model.member.member_key);
    const hairStyle =
      hairStyles[identity.hash % hairStyles.length] ?? hairStyles[0];
    const base = new Sprite();
    const hair = new Sprite();
    base.anchor.set(0.5, 1);
    hair.anchor.set(0.5, 1);
    const container = new Container();
    const marker = new Graphics();
    const glyph = new Graphics();
    glyph.y = -22;
    const name = this.worldText(model.member.name, 6, palette.cream);
    name.anchor.set(0.5);
    name.y = -36;
    name.visible = false;
    const status = this.worldText("idle", 5, palette.paper);
    status.anchor.set(0.5);
    status.y = -29;
    status.visible = false;
    container.addChild(marker, base, hair, glyph, status, name);
    container.position.set(home.x, home.y);
    container.eventMode = "static";
    container.cursor = "pointer";
    container.zIndex = Math.round(home.y);
    const entity: MemberEntity = {
      container,
      base,
      hair,
      marker,
      glyph,
      name,
      status,
      model,
      identity,
      hairStyle,
      target: { ...home },
      home: { ...home },
      previousCompleted: new Set(model.completedOccurrenceIds),
      completedUntil: 0,
      hovered: false,
    };
    container.on("pointerover", () => {
      entity.hovered = true;
      this.refreshMemberPresentation(entity);
    });
    container.on("pointerout", () => {
      entity.hovered = false;
      this.refreshMemberPresentation(entity);
    });
    container.on("pointertap", () => {
      if (this.dragDistance >= 5) return;
      this.focusMember(model.member.member_key);
      this.events.onMemberSelected(model.member.member_key);
    });
    return entity;
  }

  private actionFor(visual: VisualActivity): SpikeCharacterAction {
    if (visual === "working") return "doing";
    if (visual === "moving_to_work") return "walk";
    return "idle";
  }

  private animateMember(entity: MemberEntity, now: number): void {
    const transitional = entity.completedUntil > now;
    const visual: VisualActivity = transitional
      ? "completed_transition"
      : entity.model.visual;
    const action = this.actionFor(visual);
    const animation = SunnysideAssets.characters[action];
    const frame = this.reducedMotion
      ? 0
      : (Math.floor(now / 100) + (entity.identity.hash % 17)) %
        animation.frames;
    entity.base.texture = this.assetFrame(animation.base, frame);
    entity.hair.texture = this.assetFrame(
      animation.hair[entity.hairStyle],
      frame,
    );
    if (
      !this.reducedMotion &&
      (visual === "moving_to_work" || visual === "idle")
    ) {
      const destination =
        visual === "idle"
          ? {
              x:
                entity.home.x +
                Math.round(Math.sin(now / 2600 + entity.identity.hash) * 5),
              y:
                entity.home.y +
                Math.round(Math.cos(now / 3100 + entity.identity.hash) * 3),
            }
          : entity.target;
      const dx = destination.x - entity.container.x;
      const dy = destination.y - entity.container.y;
      const distance = Math.hypot(dx, dy);
      if (distance > 0.5) {
        const amount = Math.min(distance, visual === "idle" ? 0.18 : 0.55);
        entity.container.x += (dx / distance) * amount;
        entity.container.y += (dy / distance) * amount;
      }
    }
    entity.container.position.set(
      Math.round(entity.container.x),
      Math.round(entity.container.y),
    );
    entity.container.zIndex = Math.round(entity.container.y);
    if (
      this.cameraMode === "member" &&
      this.selectedMemberKey === entity.model.member.member_key
    )
      this.targetFocus = { x: entity.container.x, y: entity.container.y - 10 };
    this.drawStatusGlyph(entity.glyph, visual);
  }

  private refreshMemberPresentation(entity: MemberEntity): void {
    const selected = this.selectedMemberKey === entity.model.member.member_key;
    entity.name.visible =
      entity.hovered ||
      selected ||
      ["failed", "uncertain"].includes(entity.model.visual);
    entity.status.visible = entity.hovered || selected;
    entity.status.text = entity.model.visual.replaceAll("_", " ");
    entity.marker
      .clear()
      .ellipse(0, 0, selected ? 17 : 13, selected ? 7 : 5)
      .fill({
        color: selected ? palette.cream : palette.ink,
        alpha: selected ? 0.82 : 0.28,
      });
    const size = Math.ceil(36 / this.zoom);
    entity.container.hitArea = new Rectangle(-size / 2, -size + 5, size, size);
  }

  private drawStatusGlyph(glyph: Graphics, visual: VisualActivity): void {
    glyph.clear();
    if (visual === "idle") return;
    const color =
      visual === "working"
        ? palette.success
        : visual === "moving_to_work"
          ? palette.moving
          : visual === "failed"
            ? palette.failure
            : visual === "uncertain"
              ? palette.uncertain
              : palette.review;
    glyph.circle(0, 0, 6).fill(palette.cream).stroke({ color, width: 2 });
    if (visual === "working")
      glyph
        .moveTo(-3, 0)
        .lineTo(0, 3)
        .lineTo(4, -3)
        .stroke({ color, width: 1.5 });
    else if (visual === "moving_to_work")
      glyph
        .moveTo(-3, 0)
        .lineTo(3, 0)
        .lineTo(1, -2)
        .moveTo(3, 0)
        .lineTo(1, 2)
        .stroke({ color, width: 1.5 });
    else if (visual === "failed")
      glyph
        .moveTo(-3, -3)
        .lineTo(3, 3)
        .moveTo(3, -3)
        .lineTo(-3, 3)
        .stroke({ color, width: 1.5 });
    else if (visual === "uncertain")
      glyph
        .moveTo(-2, -2)
        .lineTo(0, -3)
        .lineTo(2, -2)
        .lineTo(0, 0)
        .lineTo(0, 1)
        .moveTo(0, 3)
        .lineTo(0, 3)
        .stroke({ color, width: 1 });
  }

  private updateOrders(): void {
    for (const child of this.orderLayer.removeChildren())
      child.destroy({ children: true });
    const workArea = this.map.locations.find(
      (location) => location.id === "work-area",
    );
    if (!workArea) return;
    for (const [index, marker] of (this.model?.orderMarkers ?? [])
      .slice(0, 8)
      .entries()) {
      const token = new Container();
      const back = new Graphics()
        .roundRect(-7, -7, 14, 14, 3)
        .fill(marker.state === "waiting" ? palette.warning : 0x718b86)
        .stroke({ color: palette.ink, width: 1 });
      const glyph = this.worldText(
        marker.state === "waiting" ? "!" : "·",
        7,
        palette.ink,
      );
      glyph.anchor.set(0.5);
      const label = this.worldText(marker.name, 5, palette.cream);
      label.position.set(10, -4);
      label.visible = false;
      token.addChild(back, glyph, label);
      token.position.set(workArea.x - 54 + index * 17, workArea.y + 42);
      token.eventMode = "static";
      token.cursor = "help";
      token.on("pointerover", () => {
        label.visible = true;
      });
      token.on("pointerout", () => {
        label.visible = false;
      });
      this.orderLayer.addChild(token);
    }
  }

  private updateStatusMarker(): void {
    for (const child of this.statusLayer.removeChildren())
      child.destroy({ children: true });
    const anchor = this.map.statusAnchors.find(
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
      });
    }
    marker.position.set(anchor.x, anchor.y);
    this.statusLayer.addChild(marker);
  }

  private buildDebugOverlay(): void {
    const townBounds = this.map.functionalTownBounds;
    const boundsGraphic = new Graphics()
      .rect(townBounds.x, townBounds.y, townBounds.width, townBounds.height)
      .fill({ color: 0xfacc15, alpha: 0.025 })
      .stroke({ color: 0xfacc15, width: 1 });
    const boundsLabel = this.worldText("functional-town-bounds", 5, 0xfacc15);
    boundsLabel.position.set(townBounds.x + 3, townBounds.y + 3);
    this.debugLayer.addChild(boundsGraphic, boundsLabel);

    const drawPoint = (x: number, y: number, color: number, label: string) => {
      const graphic = new Graphics()
        .moveTo(x - 4, y)
        .lineTo(x + 4, y)
        .moveTo(x, y - 4)
        .lineTo(x, y + 4)
        .stroke({ color, width: 1 });
      const text = this.worldText(label, 5, color);
      text.position.set(x + 5, y - 4);
      this.debugLayer.addChild(graphic, text);
    };

    for (const location of this.map.locations)
      drawPoint(location.x, location.y, 0x3b82f6, `location:${location.id}`);
    for (const region of this.map.interactionRegions) {
      const graphics = new Graphics();
      graphics.position.set(region.x, region.y);
      this.drawRegion(graphics, region, 0x22c55e, 0.08);
      this.debugLayer.addChild(graphics);
    }
    for (const anchor of this.map.cameraAnchors)
      drawPoint(anchor.x, anchor.y, 0xfacc15, `camera:${anchor.id}`);
    for (const station of this.map.workstations)
      drawPoint(station.x, station.y, 0xf97316, station.id);
    for (const home of this.map.memberHomes)
      drawPoint(home.x, home.y, 0xa855f7, home.id);
    for (const anchor of this.map.statusAnchors)
      drawPoint(anchor.x, anchor.y, 0xef4444, anchor.id);
    for (const zone of this.map.ambientZones) {
      const graphic = new Graphics()
        .rect(zone.x, zone.y, zone.width, zone.height)
        .fill({ color: 0x06b6d4, alpha: 0.08 })
        .stroke({ color: 0x06b6d4, width: 1 });
      this.debugLayer.addChild(graphic);
    }
    for (const route of this.map.animalRoutes) {
      const first = route.points[0];
      if (!first) continue;
      const graphic = new Graphics().moveTo(first.x, first.y);
      for (const point of route.points.slice(1))
        graphic.lineTo(point.x, point.y);
      graphic.stroke({ color: 0x38bdf8, width: 1 });
      this.debugLayer.addChild(graphic);
    }
    for (const site of this.map.reservedSites) {
      const graphic = new Graphics()
        .rect(site.x, site.y, site.width, site.height)
        .fill({ color: 0x9ca3af, alpha: 0.08 })
        .stroke({ color: 0x9ca3af, width: 1 });
      const text = this.worldText(`reserved:${site.id}`, 5, 0x9ca3af);
      text.position.set(site.x + 3, site.y + 3);
      this.debugLayer.addChild(graphic, text);
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
