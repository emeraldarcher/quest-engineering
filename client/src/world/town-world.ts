import {
  Application,
  Assets,
  Container,
  Graphics,
  Rectangle,
  Sprite,
  Text,
  Texture,
} from "pixi.js";
import type { BuildingId } from "../state/app-store";
import {
  cameraPosition,
  normalizeZoom,
  stepZoom,
  type ZoomLevel,
} from "./camera";
import {
  type MiniMedievalFrame,
  type MiniMedievalSheet,
  miniMedievalFrames,
  miniMedievalSheets,
} from "./mini-medieval-assets";
import type {
  MemberWorldModel,
  RunWorldModel,
  VisualActivity,
} from "./projector";
import {
  futureWarRoom,
  idleHomes,
  TOWN_SIZE,
  townBuildings,
  workSites,
} from "./town-layout";
import { assignWorkSites, memberIdentity, stableHash } from "./visual-identity";

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

interface MemberEntity {
  container: Container;
  sprite: Sprite;
  marker: Graphics;
  glyph: Graphics;
  name: Text;
  status: Text;
  model: MemberWorldModel;
  identity: ReturnType<typeof memberIdentity>;
  target: { x: number; y: number };
  previousCompleted: Set<string>;
  completedUntil: number;
  hovered: boolean;
}

interface AmbientAnimal {
  sprite: Sprite;
  origin: { x: number; y: number };
  phase: number;
}

function frameAt(
  frames: MiniMedievalFrame[],
  index: number,
): MiniMedievalFrame {
  const frame = frames[index] ?? frames[0];
  if (!frame) throw new Error("Mini Medieval animation has no frames.");
  return frame;
}

const palette = {
  ink: 0x120e23,
  panel: 0x2a2942,
  water: 0x24505f,
  waterLight: 0x2a7d75,
  grassDark: 0x56642e,
  grass: 0x7e9432,
  grassLight: 0xc9c03d,
  dirt: 0xa15c34,
  woodDark: 0x402e2b,
  wood: 0x764032,
  woodLight: 0xc78539,
  cream: 0xfff1a9,
  parchment: 0xdacea4,
  stone: 0x6f6e72,
  stoneLight: 0xaea47e,
  success: 0x6dba79,
  warning: 0xebb85b,
  failure: 0xe67a84,
  review: 0xc9c03d,
  pink: 0xe67a84,
};

export class TownWorld {
  private app = new Application();
  private scene = new Container();
  private terrain = new Container();
  private places = new Container();
  private activity = new Container();
  private overlays = new Container();
  private members = new Map<string, MemberEntity>();
  private buildingHighlights = new Map<BuildingId, Graphics>();
  private focusedBuilding: BuildingId | null = null;
  private orderLayer = new Container();
  private statusLayer = new Container();
  private sheets = new Map<MiniMedievalSheet, Texture>();
  private textures = new Map<string, Texture>();
  private model: RunWorldModel | null = null;
  private status: TownStatusModel = {
    preparingReview: 0,
    awaitingReview: 0,
    attention: 0,
    complete: 0,
  };
  private focused = { x: TOWN_SIZE.width / 2, y: TOWN_SIZE.height / 2 };
  private targetFocus = { ...this.focused };
  private dragging: { x: number; y: number } | null = null;
  private dragDistance = 0;
  private zoom: ZoomLevel;
  private selectedMemberKey: string | null = null;
  private completionUntil = 0;
  private completionFlourish: Graphics | null = null;
  private animals: AmbientAnimal[] = [];
  private reducedMotion = matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  private mounted = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly events: TownWorldEvents,
    initialZoom = 3,
  ) {
    this.zoom = normalizeZoom(initialZoom);
  }

  async mount(): Promise<void> {
    const resolution = Math.max(
      1,
      Math.min(2, Math.round(devicePixelRatio || 1)),
    );
    await this.app.init({
      resizeTo: this.host,
      background: "#120e23",
      antialias: false,
      autoDensity: true,
      preference: "webgl",
      preserveDrawingBuffer: true,
      resolution,
    });
    this.host.appendChild(this.app.canvas);
    const loaded = await Promise.all(
      Object.entries(miniMedievalSheets).map(async ([key, url]) => {
        const texture = await Assets.load<Texture>(url);
        texture.source.scaleMode = "nearest";
        return [key as MiniMedievalSheet, texture] as const;
      }),
    );
    for (const [key, texture] of loaded) this.sheets.set(key, texture);

    this.scene.addChild(
      this.terrain,
      this.places,
      this.activity,
      this.overlays,
    );
    this.activity.addChild(this.orderLayer);
    this.overlays.addChild(this.statusLayer);
    this.app.stage.addChild(this.scene);
    this.drawTerrain();
    this.drawPlaces();
    this.drawAmbientLife();
    this.updateStatusMarker();
    this.updateMembers();

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
      this.focused = { ...this.targetFocus };
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
    if (this.mounted && status.complete > this.status.complete) {
      this.completionUntil =
        performance.now() + (this.reducedMotion ? 0 : 2200);
    }
    this.status = status;
    if (this.mounted) this.updateStatusMarker();
  }

  setZoom(value: number): void {
    this.zoom = normalizeZoom(value);
    this.updateHitAreas();
  }

  getZoom(): ZoomLevel {
    return this.zoom;
  }

  focusBuilding(id: BuildingId): void {
    const value = townBuildings.find((item) => item.id === id);
    this.focusedBuilding = id;
    for (const [key, highlight] of this.buildingHighlights)
      highlight.visible = key === id;
    if (value) this.targetFocus = { x: value.x + 36, y: value.y };
  }

  clearBuildingFocus(): void {
    this.focusedBuilding = null;
    for (const highlight of this.buildingHighlights.values())
      highlight.visible = false;
  }

  focusMember(memberKey: string): void {
    this.selectedMemberKey = memberKey;
    const value = this.members.get(memberKey);
    if (value) {
      this.targetFocus = { x: value.container.x + 32, y: value.container.y };
      this.refreshMemberPresentation(value);
    }
  }

  focusTown(): void {
    this.targetFocus = { x: 312, y: 236 };
  }

  destroy(): void {
    this.host.removeEventListener("wheel", this.onWheel);
    window.removeEventListener("keydown", this.onKeydown);
    this.app.ticker.remove(this.tick);
    this.app.destroy(true, { children: true });
  }

  private onWheel = (event: WheelEvent) => {
    event.preventDefault();
    this.zoom = stepZoom(this.zoom, event.deltaY > 0 ? -1 : 1);
    this.updateHitAreas();
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
      this.zoom = stepZoom(this.zoom, 1);
    else if (event.key === "-") this.zoom = stepZoom(this.zoom, -1);
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
    event.preventDefault();
    this.updateHitAreas();
  };

  private tick = () => {
    const now = performance.now();
    if (!this.reducedMotion) {
      this.focused.x += (this.targetFocus.x - this.focused.x) * 0.24;
      this.focused.y += (this.targetFocus.y - this.focused.y) * 0.24;
    } else this.focused = { ...this.targetFocus };

    this.scene.scale.set(this.zoom);
    const position = cameraPosition(
      this.focused,
      this.app.screen,
      TOWN_SIZE,
      this.zoom,
      0.44,
    );
    this.scene.position.set(position.x, position.y + 28);

    for (const entity of this.members.values()) this.animateMember(entity, now);
    if (this.completionFlourish && now >= this.completionUntil) {
      this.completionFlourish.visible = false;
      this.completionFlourish = null;
    }
    if (!this.reducedMotion) {
      for (const animal of this.animals) {
        const offset = Math.round(Math.sin(now / 1800 + animal.phase) * 10);
        animal.sprite.x = animal.origin.x + offset;
        animal.sprite.texture = this.frameTexture(
          frameAt(
            miniMedievalFrames.animals.chickenWalk,
            Math.floor(now / 180) %
              miniMedievalFrames.animals.chickenWalk.length,
          ),
        );
      }
    }
  };

  private frameTexture(frame: MiniMedievalFrame): Texture {
    const key = `${frame.sheet}:${frame.x},${frame.y},${frame.width},${frame.height}`;
    const existing = this.textures.get(key);
    if (existing) return existing;
    const sheet = this.sheets.get(frame.sheet);
    if (!sheet) return Texture.EMPTY;
    const texture = new Texture({
      source: sheet.source,
      frame: new Rectangle(frame.x, frame.y, frame.width, frame.height),
    });
    this.textures.set(key, texture);
    return texture;
  }

  private sprite(frame: MiniMedievalFrame): Sprite {
    const value = new Sprite(this.frameTexture(frame));
    if (frame.anchor) value.anchor.set(frame.anchor[0], frame.anchor[1]);
    return value;
  }

  private drawTerrain(): void {
    const ground = new Graphics()
      .rect(0, 0, TOWN_SIZE.width, TOWN_SIZE.height)
      .fill(palette.grassDark);
    this.terrain.addChild(ground);

    const commons = new Graphics()
      .roundRect(78, 70, 500, 330, 26)
      .fill(palette.grass)
      .stroke({ color: palette.grassLight, alpha: 0.18, width: 1 });
    this.terrain.addChild(commons);

    const paths = new Graphics()
      .moveTo(90, 214)
      .lineTo(328, 232)
      .lineTo(360, 326)
      .moveTo(168, 322)
      .lineTo(328, 232)
      .lineTo(280, 108)
      .moveTo(328, 232)
      .lineTo(470, 124)
      .stroke({ color: palette.dirt, width: 10, alpha: 0.75 });
    this.terrain.addChild(paths);

    const pond = new Graphics()
      .roundRect(18, 274, 82, 94, 20)
      .fill(palette.water)
      .stroke({ color: palette.waterLight, width: 3 });
    this.terrain.addChild(pond);

    for (let index = 0; index < 70; index += 1) {
      const hash = stableHash(`terrain-${index}`);
      const detail = this.sprite(
        hash % 4 === 0
          ? miniMedievalFrames.terrain.grassFlowers
          : miniMedievalFrames.terrain.grass,
      );
      detail.alpha = hash % 4 === 0 ? 0.6 : 0.32;
      detail.position.set(
        24 + (hash % 650),
        36 + (Math.floor(hash / 650) % 380),
      );
      this.terrain.addChild(detail);
    }

    const treePositions = [
      [28, 88],
      [62, 112],
      [650, 74],
      [682, 110],
      [30, 424],
      [70, 438],
      [642, 416],
      [682, 440],
      [20, 208],
      [674, 264],
      [598, 52],
      [108, 44],
    ];
    treePositions.forEach(([x, y], index) => {
      const tree = this.sprite(
        index % 3 === 0
          ? miniMedievalFrames.terrain.treePine
          : miniMedievalFrames.terrain.treeRound,
      );
      tree.position.set(x ?? 0, y ?? 0);
      this.terrain.addChild(tree);
    });
  }

  private drawPlaces(): void {
    for (const building of townBuildings) this.drawBuilding(building);
    this.drawWorkYard();
    const site = new Container();
    const foundation = new Graphics()
      .rect(
        -futureWarRoom.width / 2,
        -futureWarRoom.height / 2,
        futureWarRoom.width,
        futureWarRoom.height,
      )
      .fill({ color: palette.woodDark, alpha: 0.38 })
      .stroke({ color: palette.stone, width: 2, alpha: 0.7 })
      .moveTo(-30, -20)
      .lineTo(30, 20)
      .moveTo(30, -20)
      .lineTo(-30, 20)
      .stroke({ color: palette.stoneLight, width: 1, alpha: 0.5 });
    const label = this.worldText("COMMAND SITE", 6, palette.stoneLight);
    label.anchor.set(0.5);
    label.y = 36;
    site.addChild(foundation, label);
    site.position.set(futureWarRoom.x, futureWarRoom.y);
    this.places.addChild(site);
  }

  private drawBuilding(building: (typeof townBuildings)[number]): void {
    const house = new Container();
    const hit = new Graphics()
      .roundRect(
        -building.width / 2 - 4,
        -building.height + 4,
        building.width + 8,
        building.height + 14,
        4,
      )
      .fill({ color: palette.cream, alpha: 0.001 });
    const highlight = new Graphics()
      .ellipse(0, 3, building.width + 14, 15)
      .fill({ color: palette.cream, alpha: 0.22 });
    highlight.visible = false;
    const body = new Graphics()
      .rect(-building.width / 2 + 6, -30, building.width - 12, 30)
      .fill(building.roof === "blue" ? palette.water : palette.wood)
      .stroke({ color: palette.ink, width: 2 });
    const roofFrame =
      building.roof === "orange"
        ? miniMedievalFrames.buildings.roofOrange
        : building.roof === "blue"
          ? miniMedievalFrames.buildings.roofBlue
          : miniMedievalFrames.buildings.roofThatch;
    const roof = this.sprite(roofFrame);
    roof.position.set(0, -22);
    const door = this.sprite(
      building.roof === "blue"
        ? miniMedievalFrames.buildings.doorBlue
        : miniMedievalFrames.buildings.doorOrange,
    );
    door.position.set(0, 0);
    const accents = new Container();
    if (building.id === "quest-board") {
      body.visible = false;
      roof.visible = false;
      door.visible = false;
      accents.addChild(
        new Graphics()
          .rect(-24, -32, 48, 28)
          .fill(palette.parchment)
          .stroke({ color: palette.woodDark, width: 3 })
          .moveTo(-18, -24)
          .lineTo(15, -24)
          .moveTo(-18, -17)
          .lineTo(10, -17)
          .moveTo(-18, -10)
          .lineTo(18, -10)
          .stroke({ color: palette.wood, width: 2 })
          .rect(-22, -4, 4, 12)
          .fill(palette.woodDark)
          .rect(18, -4, 4, 12)
          .fill(palette.woodDark),
      );
    } else if (building.id === "blacksmith") {
      const anvil = this.sprite(miniMedievalFrames.props.anvil);
      anvil.position.set(17, -1);
      accents.addChild(anvil);
    } else if (building.id === "tavern") {
      const lantern = this.sprite(miniMedievalFrames.props.lantern);
      lantern.position.set(18, -12);
      accents.addChild(lantern);
    } else if (building.id === "gatehouse") {
      const sign = this.sprite(miniMedievalFrames.props.sign);
      sign.position.set(18, 0);
      accents.addChild(sign);
    } else if (building.id === "guild") {
      const flag = this.sprite(miniMedievalFrames.props.flag);
      flag.position.set(-20, -34);
      accents.addChild(flag);
    } else if (building.id === "work-area") {
      door.visible = false;
      body.alpha = 0.65;
    }
    const title = this.worldText(building.label, 7, palette.cream);
    title.anchor.set(0.5);
    title.y = 10;
    const subtitle = this.worldText(
      building.functionLabel,
      5,
      palette.parchment,
    );
    subtitle.anchor.set(0.5);
    subtitle.y = 18;
    subtitle.visible = false;
    house.addChild(highlight, body, roof, door, accents, title, subtitle, hit);
    house.position.set(building.x, building.y);
    house.hitArea = new Rectangle(
      -building.width / 2 - 5,
      -building.height,
      building.width + 10,
      building.height + 24,
    );
    house.eventMode = "static";
    house.cursor = "pointer";
    this.buildingHighlights.set(building.id, highlight);
    house.on("pointerover", () => {
      highlight.visible = true;
      subtitle.visible = true;
    });
    house.on("pointerout", () => {
      highlight.visible = this.focusedBuilding === building.id;
      subtitle.visible = false;
    });
    house.on("pointertap", () => {
      if (this.dragDistance >= 5) return;
      this.focusBuilding(building.id);
      this.events.onBuildingSelected(building.id);
    });
    this.places.addChild(house);
  }

  private drawWorkYard(): void {
    const fence = new Graphics()
      .roundRect(282, 264, 104, 108, 6)
      .stroke({ color: palette.woodDark, width: 4, alpha: 0.9 });
    this.places.addChild(fence);
    for (const site of workSites) {
      const station = new Container();
      if (site.kind === "table") {
        const table = this.sprite(miniMedievalFrames.props.table);
        table.position.set(0, 3);
        station.addChild(table);
      } else {
        station.addChild(
          new Graphics()
            .rect(-8, -3, 16, 5)
            .fill(site.kind === "bench" ? palette.stone : palette.wood)
            .stroke({ color: palette.ink, width: 1 }),
        );
      }
      if (site.kind === "bench") {
        const anvil = this.sprite(miniMedievalFrames.props.anvil);
        anvil.position.set(0, -3);
        station.addChild(anvil);
      }
      station.position.set(site.x, site.y);
      this.places.addChild(station);
    }
    const rack = new Graphics()
      .rect(276, 276, 12, 66)
      .fill(palette.woodDark)
      .stroke({ color: palette.woodLight, width: 1 });
    this.places.addChild(rack);
  }

  private drawAmbientLife(): void {
    for (const [index, position] of [
      [118, 292],
      [232, 382],
      [392, 156],
    ].entries()) {
      const sprite = this.sprite(
        frameAt(miniMedievalFrames.animals.chickenIdle, index % 2),
      );
      sprite.position.set(position[0] ?? 0, position[1] ?? 0);
      this.activity.addChild(sprite);
      this.animals.push({
        sprite,
        origin: { x: position[0] ?? 0, y: position[1] ?? 0 },
        phase: index * 2.1,
      });
    }
    const flag = this.sprite(miniMedievalFrames.props.flag);
    flag.position.set(270, 66);
    this.activity.addChild(flag);

    const smoke = new Graphics()
      .circle(0, 0, 3)
      .fill({ color: palette.parchment, alpha: 0.35 });
    smoke.position.set(486, 78);
    this.activity.addChild(smoke);
    if (!this.reducedMotion)
      this.app.ticker.add(() => {
        smoke.y = 78 - Math.round((performance.now() / 400) % 18);
        smoke.alpha = 0.42 - ((performance.now() / 400) % 18) / 60;
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
    const assignments = this.model.members
      .filter((member) => member.activeOccurrenceId)
      .map((member) => ({
        occurrenceId: member.activeOccurrenceId as string,
        memberKey: member.member.member_key,
      }));
    const sites = assignWorkSites(assignments);
    for (const member of this.model.members) {
      const key = member.member.member_key;
      let entity = this.members.get(key);
      if (!entity) {
        entity = this.createMember(member, this.model.squadKey);
        this.members.set(key, entity);
        this.activity.addChild(entity.container);
      }
      const newlyCompleted = member.completedOccurrenceIds.some(
        (id) => !entity?.previousCompleted.has(id),
      );
      if (newlyCompleted) entity.completedUntil = performance.now() + 1400;
      entity.previousCompleted = new Set(member.completedOccurrenceIds);
      entity.model = member;
      const site = member.activeOccurrenceId
        ? sites.get(member.activeOccurrenceId)
        : null;
      entity.target = site
        ? { x: site.x, y: site.y - 5 }
        : { ...(entity.identity.home ?? idleHomes[0]) };
      if (
        member.visual === "working" ||
        member.visual === "failed" ||
        member.visual === "uncertain"
      ) {
        entity.container.position.set(entity.target.x, entity.target.y);
      }
      this.refreshMemberPresentation(entity);
    }
    this.updateOrders();
    this.updateHitAreas();
  }

  private createMember(
    model: MemberWorldModel,
    squadKey: string,
  ): MemberEntity {
    const identity = memberIdentity(squadKey, model.member.member_key);
    const container = new Container();
    const marker = new Graphics();
    const sprite = this.sprite(
      frameAt(miniMedievalFrames.units.idle, identity.spriteIndex),
    );
    const glyph = new Graphics();
    glyph.y = -14;
    const name = this.worldText(model.member.name, 6, palette.cream);
    name.anchor.set(0.5);
    name.y = -24;
    name.visible = false;
    const status = this.worldText("idle", 5, palette.parchment);
    status.anchor.set(0.5);
    status.y = -18;
    status.visible = false;
    container.addChild(marker, sprite, glyph, status, name);
    container.position.set(identity.home?.x ?? 160, identity.home?.y ?? 360);
    container.eventMode = "static";
    container.cursor = "pointer";
    const entity: MemberEntity = {
      container,
      sprite,
      marker,
      glyph,
      name,
      status,
      model,
      identity,
      target: { ...(identity.home ?? idleHomes[0]) },
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

  private animateMember(entity: MemberEntity, now: number): void {
    const transitional = entity.completedUntil > now;
    const visual: VisualActivity = transitional
      ? "completed_transition"
      : entity.model.visual;
    const moving = visual === "moving_to_work" || visual === "idle";
    if (moving && !this.reducedMotion) {
      const home = entity.identity.home ?? idleHomes[0];
      const wander =
        visual === "idle"
          ? {
              x:
                home.x +
                Math.round(Math.sin(now / 2600 + entity.identity.hash) * 6),
              y:
                home.y +
                Math.round(Math.cos(now / 3100 + entity.identity.hash) * 4),
            }
          : entity.target;
      const dx = wander.x - entity.container.x;
      const dy = wander.y - entity.container.y;
      const distance = Math.hypot(dx, dy);
      if (distance > 0.5) {
        const amount = Math.min(distance, visual === "idle" ? 0.18 : 0.55);
        entity.container.x = Math.round(
          entity.container.x + (dx / distance) * amount,
        );
        entity.container.y = Math.round(
          entity.container.y + (dy / distance) * amount,
        );
      }
    }
    if (visual === "moving_to_work") {
      const frames = miniMedievalFrames.units.run;
      entity.sprite.texture = this.frameTexture(
        frameAt(frames, Math.floor(now / 120) % frames.length),
      );
    } else if (visual === "working") {
      const frames = miniMedievalFrames.units.work;
      entity.sprite.texture = this.frameTexture(
        frameAt(frames, Math.floor(now / 160) % frames.length),
      );
      entity.sprite.y = this.reducedMotion
        ? 0
        : Math.floor(now / 180) % 2 === 0
          ? 0
          : -1;
    } else {
      entity.sprite.texture = this.frameTexture(
        frameAt(miniMedievalFrames.units.idle, entity.identity.spriteIndex),
      );
      entity.sprite.y =
        transitional && !this.reducedMotion && Math.floor(now / 160) % 2 === 0
          ? -1
          : 0;
    }
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
      .ellipse(0, 1, selected ? 14 : 11, selected ? 6 : 4)
      .fill({
        color: selected ? palette.cream : palette.ink,
        alpha: selected ? 0.8 : 0.42,
      });
  }

  private drawStatusGlyph(glyph: Graphics, visual: VisualActivity): void {
    glyph.clear();
    if (visual === "idle" || visual === "moving_to_work") return;
    const color =
      visual === "working"
        ? palette.success
        : visual === "waiting"
          ? palette.warning
          : visual === "failed"
            ? palette.failure
            : visual === "uncertain"
              ? palette.parchment
              : palette.review;
    glyph
      .circle(0, 0, 5)
      .fill({ color: palette.ink, alpha: 0.95 })
      .stroke({ color, width: 1 });
    if (visual === "working")
      glyph
        .moveTo(-2, 2)
        .lineTo(2, -2)
        .moveTo(-2, -2)
        .lineTo(2, 2)
        .stroke({ color, width: 1 });
    else if (visual === "waiting")
      glyph.rect(-1, -3, 2, 4).fill(color).rect(-1, 2, 2, 1).fill(color);
    else if (visual === "failed")
      glyph
        .moveTo(-2, -2)
        .lineTo(2, 2)
        .moveTo(2, -2)
        .lineTo(-2, 2)
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
    else
      glyph
        .moveTo(-3, 0)
        .lineTo(-1, 2)
        .lineTo(3, -2)
        .stroke({ color, width: 1.5 });
  }

  private updateOrders(): void {
    this.orderLayer.removeChildren().forEach((child) => {
      child.destroy({ children: true });
    });
    for (const [index, marker] of (this.model?.orderMarkers ?? [])
      .slice(0, 8)
      .entries()) {
      const token = new Container();
      const back = new Graphics()
        .rect(-5, -5, 10, 10)
        .fill(marker.state === "waiting" ? palette.warning : palette.stone)
        .stroke({ color: palette.ink, width: 1 });
      const glyph = this.worldText(
        marker.state === "waiting" ? "!" : "·",
        7,
        palette.ink,
      );
      glyph.anchor.set(0.5);
      glyph.y = -1;
      const label = this.worldText(marker.name, 5, palette.cream);
      label.x = 8;
      label.y = -4;
      label.visible = false;
      token.addChild(back, glyph, label);
      token.position.set(282, 286 + index * 13);
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
    this.statusLayer.removeChildren().forEach((child) => {
      child.destroy({ children: true });
    });
    this.completionFlourish = null;
    const board = townBuildings.find((value) => value.id === "quest-board");
    if (!board) return;
    const values: Array<{
      count: number;
      symbol: string;
      color: number;
      label: string;
    }> = [
      {
        count: this.status.attention,
        symbol: "!",
        color: palette.failure,
        label: "delivery attention",
      },
      {
        count: this.status.awaitingReview,
        symbol: "R",
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
    const packArt = this.sprite(
      active.label === "Quest complete"
        ? miniMedievalFrames.overlays.banner
        : miniMedievalFrames.overlays.review,
    );
    packArt.anchor.set(0.5);
    packArt.position.set(-9, -1);
    const seal = new Graphics()
      .circle(0, 0, 7)
      .fill(palette.ink)
      .stroke({ color: active.color, width: 2 });
    const symbol = this.worldText(active.symbol, 7, active.color);
    symbol.anchor.set(0.5);
    symbol.y = -1;
    const count = this.worldText(
      active.count > 1 ? String(active.count) : active.label,
      5,
      palette.cream,
    );
    count.anchor.set(0.5);
    count.y = -12;
    marker.addChild(packArt, seal, symbol, count);
    if (
      this.completionUntil > performance.now() &&
      active.label === "Quest complete"
    ) {
      const banner = new Graphics()
        .moveTo(-24, -8)
        .lineTo(24, -8)
        .lineTo(20, 4)
        .lineTo(0, 0)
        .lineTo(-20, 4)
        .closePath()
        .fill(palette.success)
        .stroke({ color: palette.ink, width: 1 });
      banner.y = -14;
      this.completionFlourish = banner;
      marker.addChildAt(banner, 0);
    }
    marker.position.set(board.x + 24, board.y - 34);
    this.statusLayer.addChild(marker);
  }

  private updateHitAreas(): void {
    const size = Math.ceil(36 / this.zoom);
    for (const entity of this.members.values()) {
      entity.container.hitArea = new Rectangle(
        -size / 2,
        -size + 5,
        size,
        size,
      );
    }
  }

  private worldText(text: string, size: number, color: number): Text {
    return new Text({
      text,
      style: {
        fill: color,
        fontFamily: "system-ui, sans-serif",
        fontSize: size,
        fontWeight: "700",
        stroke: { color: palette.ink, width: 2 },
      },
    });
  }
}
