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
import dungeonSheetUrl from "../assets/kenney/tiny-dungeon/tilemap.png";
import townSheetUrl from "../assets/kenney/tiny-town/tilemap.png";
import type { BuildingId } from "../state/app-store";
import type { MemberWorldModel, RunWorldModel } from "./projector";

export interface TownWorldEvents {
  onBuildingSelected(id: BuildingId): void;
  onMemberSelected(memberKey: string): void;
}

const TILE = 16;
const WORLD_WIDTH = 768;
const WORLD_HEIGHT = 560;
const buildings: Array<{
  id: BuildingId;
  label: string;
  x: number;
  y: number;
  kind: "blue_house" | "orange_house" | "castle" | "board" | "yard";
}> = [
  { id: "gatehouse", label: "Wayfinder", x: 130, y: 115, kind: "blue_house" },
  { id: "guild", label: "Guild Hall", x: 384, y: 106, kind: "castle" },
  { id: "blacksmith", label: "Forge", x: 638, y: 145, kind: "orange_house" },
  { id: "tavern", label: "Tavern", x: 142, y: 350, kind: "orange_house" },
  { id: "quest-board", label: "Quest Board", x: 390, y: 315, kind: "board" },
  { id: "work-area", label: "Work Yard", x: 620, y: 388, kind: "yard" },
];

export class TownWorld {
  private app = new Application();
  private scene = new Container();
  private members = new Container();
  private model: RunWorldModel | null = null;
  private focused = { x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2 };
  private dragging: { x: number; y: number } | null = null;
  private scaleLevel = 2;
  private townTexture: Texture | null = null;
  private dungeonTexture: Texture | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly events: TownWorldEvents,
  ) {}

  async mount(): Promise<void> {
    await this.app.init({
      resizeTo: this.host,
      background: "#17272a",
      antialias: false,
      autoDensity: false,
      preference: "webgl",
      preserveDrawingBuffer: true,
      resolution: 1,
    });
    this.host.appendChild(this.app.canvas);
    [this.townTexture, this.dungeonTexture] = await Promise.all([
      Assets.load<Texture>(townSheetUrl),
      Assets.load<Texture>(dungeonSheetUrl),
    ]);
    this.townTexture.source.scaleMode = "nearest";
    this.dungeonTexture.source.scaleMode = "nearest";
    this.scene.eventMode = "static";
    this.app.stage.addChild(this.scene);
    this.drawWorld();
    this.scene.addChild(this.members);
    this.drawMembers();
    this.tick();
    this.app.render();
    this.app.stage.eventMode = "static";
    this.app.stage.hitArea = this.app.screen;
    this.app.stage.on("pointerdown", (event) => {
      this.dragging = { x: event.global.x, y: event.global.y };
    });
    this.app.stage.on("pointerup", () => {
      this.dragging = null;
    });
    this.app.stage.on("pointerupoutside", () => {
      this.dragging = null;
    });
    this.app.stage.on("pointermove", (event) => {
      if (!this.dragging) return;
      this.focused.x -= Math.round(
        (event.global.x - this.dragging.x) / this.scaleLevel,
      );
      this.focused.y -= Math.round(
        (event.global.y - this.dragging.y) / this.scaleLevel,
      );
      this.dragging = { x: event.global.x, y: event.global.y };
    });
    this.host.addEventListener("wheel", this.onWheel, { passive: false });
    this.app.ticker.add(() => this.tick());
  }

  setModel(model: RunWorldModel | null): void {
    this.model = model;
    this.drawMembers();
  }
  focusBuilding(id: BuildingId): void {
    const value = buildings.find((item) => item.id === id);
    if (value) this.focused = { x: value.x, y: value.y };
  }
  destroy(): void {
    this.host.removeEventListener("wheel", this.onWheel);
    this.app.destroy(true, { children: true });
  }

  private onWheel = (event: WheelEvent) => {
    event.preventDefault();
    this.scaleLevel = Math.max(
      1,
      Math.min(3, this.scaleLevel + (event.deltaY > 0 ? -1 : 1)),
    );
  };

  private tick(): void {
    this.scene.scale.set(this.scaleLevel);
    const halfWidth = this.app.renderer.width / (2 * this.scaleLevel);
    const halfHeight = this.app.renderer.height / (2 * this.scaleLevel);
    const focusX =
      halfWidth * 2 >= WORLD_WIDTH
        ? WORLD_WIDTH / 2
        : Math.max(
            halfWidth,
            Math.min(WORLD_WIDTH - halfWidth, this.focused.x),
          );
    const focusY =
      halfHeight * 2 >= WORLD_HEIGHT
        ? WORLD_HEIGHT / 2
        : Math.max(
            halfHeight,
            Math.min(WORLD_HEIGHT - halfHeight, this.focused.y),
          );
    this.scene.position.set(
      Math.round(this.app.renderer.width / 2 - focusX * this.scaleLevel),
      Math.round(this.app.renderer.height / 2 - focusY * this.scaleLevel),
    );
    for (const child of this.members.children) {
      if (child.label === "working") child.y = Math.round(child.y);
    }
  }

  private drawWorld(): void {
    if (!this.townTexture) return;
    const ground = new Container();
    for (let y = 0; y < WORLD_HEIGHT; y += TILE) {
      for (let x = 0; x < WORLD_WIDTH; x += TILE) {
        const grass = this.tile(
          this.townTexture,
          (x / TILE + y / TILE) % 11 === 0 ? 1 : 0,
        );
        grass.position.set(x, y);
        ground.addChild(grass);
      }
    }
    this.scene.addChild(ground);
    this.drawPaths();
    this.drawDecor();
    for (const building of buildings) this.drawBuilding(building);
    const title = new Text({
      text: "RUNEFALL",
      style: {
        fill: 0xffe29a,
        fontFamily: "Georgia",
        fontSize: 20,
        fontWeight: "bold",
        stroke: { color: 0x1a2020, width: 4 },
      },
    });
    title.anchor.set(0.5);
    title.position.set(WORLD_WIDTH / 2, 24);
    this.scene.addChild(title);
  }

  private drawPaths(): void {
    if (!this.townTexture) return;
    const points: Array<[number, number, number, number]> = [
      [384, 110, 384, 470],
      [130, 220, 640, 220],
      [142, 350, 620, 388],
    ];
    for (const [x1, y1, x2, y2] of points) {
      const length = Math.hypot(x2 - x1, y2 - y1);
      const steps = Math.ceil(length / TILE);
      for (let i = 0; i <= steps; i += 1) {
        const sprite = this.tile(this.townTexture, 43);
        sprite.position.set(
          Math.round(x1 + ((x2 - x1) * i) / steps),
          Math.round(y1 + ((y2 - y1) * i) / steps),
        );
        sprite.anchor.set(0.5);
        this.scene.addChild(sprite);
      }
    }
  }

  private drawDecor(): void {
    if (!this.townTexture) return;
    const groves: Array<[number, number, number[][]]> = [
      [
        20,
        52,
        [
          [6, 7, 8],
          [18, 19, 20],
          [30, 31, 32],
        ],
      ],
      [
        680,
        40,
        [
          [9, 10, 11],
          [21, 22, 23],
          [33, 34, 35],
        ],
      ],
      [
        22,
        440,
        [
          [9, 10, 11],
          [21, 22, 23],
          [33, 34, 35],
        ],
      ],
      [
        680,
        452,
        [
          [6, 7, 8],
          [18, 19, 20],
          [30, 31, 32],
        ],
      ],
    ];
    for (const [x, y, matrix] of groves) {
      const grove = this.tileMatrix(matrix);
      grove.position.set(x, y);
      grove.scale.set(1.5);
      this.scene.addChild(grove);
    }
    for (const [x, y, index] of [
      [76, 265, 3],
      [690, 270, 4],
      [250, 470, 5],
      [518, 72, 29],
      [305, 490, 17],
    ] as Array<[number, number, number]>) {
      const sprite = this.tile(this.townTexture, index);
      sprite.anchor.set(0.5, 1);
      sprite.position.set(x, y);
      sprite.scale.set(index === 17 ? 1.5 : 2);
      this.scene.addChild(sprite);
    }
  }

  private drawBuilding(building: (typeof buildings)[number]): void {
    if (!this.townTexture) return;
    const house = new Container();
    const shadow = new Graphics()
      .ellipse(0, 30, 58, 18)
      .fill({ color: 0x132023, alpha: 0.45 });
    house.addChild(shadow);
    const matrices: Record<(typeof building)["kind"], number[][]> = {
      blue_house: [
        [60, 63, 62],
        [72, 73, 75],
        [72, 85, 75],
      ],
      orange_house: [
        [64, 67, 66],
        [72, 73, 75],
        [72, 85, 75],
      ],
      castle: [
        [96, 97, 97, 97, 98],
        [108, 109, 109, 109, 110],
        [108, 111, 112, 113, 110],
        [120, 121, 124, 121, 122],
      ],
      board: [
        [44, 45, 46],
        [56, 57, 58],
        [68, 81, 70],
      ],
      yard: [
        [44, 45, 45, 46],
        [56, 115, 116, 58],
        [56, 128, 119, 58],
        [68, 81, 81, 70],
      ],
    };
    const art = this.tileMatrix(matrices[building.kind]);
    art.scale.set(2);
    art.pivot.set(art.width / 4, art.height / 4);
    art.y = -12;
    house.addChild(art);
    if (building.id === "tavern") this.addBuildingBadge(house, 94, 31, -4);
    if (building.id === "blacksmith") this.addBuildingBadge(house, 128, 31, -4);
    if (building.id === "gatehouse") this.addBuildingBadge(house, 95, 31, -4);
    const label = new Text({
      text: building.label,
      style: {
        fill: 0xffedb0,
        fontFamily: "Georgia",
        fontSize: 12,
        fontWeight: "bold",
        stroke: { color: 0x152024, width: 3 },
      },
    });
    label.anchor.set(0.5);
    label.y = building.kind === "castle" || building.kind === "yard" ? 62 : 49;
    house.addChild(label);
    house.position.set(building.x, building.y);
    house.eventMode = "static";
    house.cursor = "pointer";
    house.on("pointertap", () => {
      this.focusBuilding(building.id);
      this.events.onBuildingSelected(building.id);
    });
    this.scene.addChild(house);
  }

  private addBuildingBadge(
    house: Container,
    index: number,
    x: number,
    y: number,
  ): void {
    if (!this.townTexture) return;
    const badge = this.tile(this.townTexture, index);
    badge.anchor.set(0.5);
    badge.scale.set(1.5);
    badge.position.set(x, y);
    house.addChild(badge);
  }

  private tileMatrix(matrix: number[][]): Container {
    if (!this.townTexture) return new Container();
    const container = new Container();
    matrix.forEach((row, rowIndex) => {
      row.forEach((index, columnIndex) => {
        const sprite = this.tile(this.townTexture as Texture, index);
        sprite.position.set(columnIndex * TILE, rowIndex * TILE);
        container.addChild(sprite);
      });
    });
    return container;
  }

  private drawMembers(): void {
    this.members.removeChildren().forEach((child) => {
      child.destroy();
    });
    if (!this.model || !this.dungeonTexture) return;
    this.model.members.forEach((member, index) => {
      this.drawMember(member, index);
    });
    this.model.orderMarkers.slice(0, 5).forEach((marker, index) => {
      const placard = new Container();
      const back = new Graphics()
        .roundRect(-48, -8, 96, 16, 2)
        .fill(marker.state === "waiting" ? 0x5b3f34 : 0x293d40)
        .stroke({ color: 0xb38b51, width: 1 });
      const text = new Text({
        text: `${marker.state === "waiting" ? "!" : "…"} ${marker.name}`.slice(
          0,
          24,
        ),
        style: { fill: 0xffe3a0, fontFamily: "Georgia", fontSize: 8 },
      });
      text.anchor.set(0.5);
      placard.addChild(back, text);
      placard.position.set(390, 410 + index * 18);
      this.members.addChild(placard);
    });
  }

  private drawMember(member: MemberWorldModel, index: number): void {
    if (!this.dungeonTexture) return;
    const active =
      member.visual === "moving_to_work" || member.visual === "working";
    const entity = new Container();
    const characterTiles = [
      84, 85, 86, 87, 88, 96, 97, 98, 99, 100, 109, 111, 112,
    ];
    const sprite = this.tile(
      this.dungeonTexture,
      characterTiles[index % characterTiles.length] ?? 85,
    );
    sprite.anchor.set(0.5, 1);
    sprite.scale.set(1.5);
    const haloColor = {
      idle: 0x9cb6a2,
      moving_to_work: 0x87c4d1,
      working: 0x8ed06b,
      completed: 0xf3d475,
      failed: 0xdf6d5f,
      uncertain: 0xc78ae3,
    }[member.visual];
    const halo = new Graphics()
      .ellipse(0, 2, 12, 5)
      .fill({ color: haloColor, alpha: 0.75 });
    const name = new Text({
      text: member.member.name.slice(0, 12),
      style: {
        fill: 0xfff0c4,
        fontFamily: "Georgia",
        fontSize: 8,
        stroke: { color: 0x111b20, width: 2 },
      },
    });
    name.anchor.set(0.5);
    name.y = 11;
    entity.addChild(halo, sprite, name);
    entity.position.set(
      active ? 548 + (index % 3) * 30 : 280 + index * 32,
      active ? 430 + Math.floor(index / 3) * 28 : 270,
    );
    entity.label = member.visual;
    entity.eventMode = "static";
    entity.cursor = "pointer";
    entity.on("pointertap", () =>
      this.events.onMemberSelected(member.member.member_key),
    );
    this.members.addChild(entity);
  }

  private tile(sheet: Texture, index: number): Sprite {
    const columns = Math.floor(sheet.width / TILE);
    const texture = new Texture({
      source: sheet.source,
      frame: new Rectangle(
        (index % columns) * TILE,
        Math.floor(index / columns) * TILE,
        TILE,
        TILE,
      ),
    });
    return new Sprite(texture);
  }
}
