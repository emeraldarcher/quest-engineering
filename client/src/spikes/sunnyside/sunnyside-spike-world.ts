import {
  Application,
  Assets,
  ColorMatrixFilter,
  Container,
  Graphics,
  Rectangle,
  Sprite,
  Text,
  Texture,
  TilingSprite,
} from "pixi.js";
import type { RunWorldModel, VisualActivity } from "../../world/projector";
import {
  allRuntimeAssets,
  type HairStyle,
  hairStyles,
  type SpikeCharacterAction,
  type SunnysideAsset,
  SunnysideAssets,
} from "../../world/runtime/sunnyside-assets";
import { memberIdentity } from "../../world/visual-identity";

export type PaletteTreatment = "native" | "management" | "earthy";
export type SpikeScene = "parity" | "town";

export interface SunnysideSpikeWorldOptions {
  model: RunWorldModel;
  palette: PaletteTreatment;
  scene: SpikeScene;
  zoom: 1 | 2 | 3;
  showPanel: boolean;
  awaitingReview: number;
}

interface AnimatedLayer {
  sprite: Sprite;
  asset: SunnysideAsset;
  frames: number;
  phase: number;
}

interface MemberEntity {
  root: Container;
  base: Sprite;
  hair: Sprite;
  hairStyle: HairStyle;
  visual: VisualActivity;
  phase: number;
  origin: { x: number; y: number };
}

const WORLD = { width: 640, height: 416 } as const;
const colors = {
  ink: 0x29373a,
  cream: 0xfff3d4,
  paper: 0xf3dfb5,
  path: 0xd69a64,
  pathEdge: 0xb97951,
  wood: 0x79513c,
  woodLight: 0xb77a50,
  success: 0x4d9468,
  moving: 0x4e8ca0,
  warning: 0xd99a45,
  failure: 0xc35458,
  uncertain: 0x845d99,
  review: 0xd98545,
};

export class SunnysideSpikeWorld {
  private app = new Application();
  private root = new Container();
  private terrain = new Container();
  private places = new Container();
  private details = new Container();
  private activity = new Container();
  private overlays = new Container();
  private loaded = new Map<string, Texture>();
  private framed = new Map<string, Texture>();
  private animated: AnimatedLayer[] = [];
  private members: MemberEntity[] = [];
  private reducedMotion = matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  constructor(
    private host: HTMLElement,
    private options: SunnysideSpikeWorldOptions,
  ) {}

  async mount(): Promise<void> {
    const resolution = Math.max(
      1,
      Math.min(2, Math.round(devicePixelRatio || 1)),
    );
    await this.app.init({
      resizeTo: this.host,
      background: this.options.palette === "earthy" ? "#c8b98b" : "#cfe7bd",
      antialias: false,
      autoDensity: true,
      preserveDrawingBuffer: true,
      preference: "webgl",
      resolution,
    });
    this.host.appendChild(this.app.canvas);

    const assets = allRuntimeAssets();
    await Promise.all(
      assets.map(async (asset) => {
        if (this.loaded.has(asset.url)) return;
        const texture = await Assets.load<Texture>(asset.url);
        texture.source.scaleMode = "nearest";
        this.loaded.set(asset.url, texture);
      }),
    );

    this.root.addChild(
      this.terrain,
      this.places,
      this.details,
      this.activity,
      this.overlays,
    );
    this.app.stage.addChild(this.root);
    this.drawTerrain();
    this.drawSettlement();
    this.drawAmbientLife();
    this.drawMembers();
    this.drawSemanticOverlays();
    this.applyPalette();
    this.positionCamera();
    this.app.ticker.add(this.tick);
  }

  destroy(): void {
    this.app.ticker.remove(this.tick);
    this.app.destroy(true, { children: true });
  }

  private texture(asset: SunnysideAsset): Texture {
    return this.loaded.get(asset.url) ?? Texture.EMPTY;
  }

  private frame(asset: SunnysideAsset, frame = 0): Texture {
    const sourceRect = asset.rect;
    if (!sourceRect) return this.texture(asset);
    const x = sourceRect.x + sourceRect.width * frame;
    const key = `${asset.url}:${x}:${sourceRect.y}:${sourceRect.width}:${sourceRect.height}`;
    const cached = this.framed.get(key);
    if (cached) return cached;
    const source = this.texture(asset);
    const value = new Texture({
      source: source.source,
      frame: new Rectangle(
        x,
        sourceRect.y,
        sourceRect.width,
        sourceRect.height,
      ),
    });
    this.framed.set(key, value);
    return value;
  }

  private sheetFrame(rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Texture {
    const asset = SunnysideAssets.terrain.world;
    const key = `world:${rect.x}:${rect.y}:${rect.width}:${rect.height}`;
    const cached = this.framed.get(key);
    if (cached) return cached;
    const value = new Texture({
      source: this.texture(asset).source,
      frame: new Rectangle(rect.x, rect.y, rect.width, rect.height),
    });
    this.framed.set(key, value);
    return value;
  }

  private drawTerrain(): void {
    const grass = this.sheetFrame({ x: 16, y: 16, width: 16, height: 16 });
    this.terrain.addChild(
      new TilingSprite({
        texture: grass,
        width: WORLD.width,
        height: WORLD.height,
      }),
    );

    const quietShade = new Graphics()
      .roundRect(8, 8, WORLD.width - 16, WORLD.height - 16, 26)
      .fill({ color: 0x4d9a57, alpha: 0.08 })
      .stroke({ color: 0xf4e3ae, alpha: 0.18, width: 1 });
    this.terrain.addChild(quietShade);

    if (this.options.scene === "town") this.drawTownPaths();
    else this.drawParityPaths();
    this.drawPond();
    this.drawGrassDetails();
    this.drawTreeClusters();
  }

  private drawTownPaths(): void {
    const primary = new Graphics()
      .moveTo(238, 416)
      .bezierCurveTo(230, 372, 266, 346, 280, 307)
      .bezierCurveTo(289, 279, 304, 254, 307, 230)
      .moveTo(303, 231)
      .bezierCurveTo(262, 226, 219, 243, 178, 268)
      .bezierCurveTo(158, 280, 141, 281, 126, 286)
      .moveTo(311, 230)
      .bezierCurveTo(349, 251, 394, 256, 428, 243)
      .bezierCurveTo(441, 238, 451, 236, 462, 242)
      .stroke({
        color: colors.pathEdge,
        width: 20,
        cap: "round",
        join: "round",
      })
      .stroke({ color: colors.path, width: 15, cap: "round", join: "round" });
    const secondary = new Graphics()
      .moveTo(291, 205)
      .bezierCurveTo(278, 184, 251, 181, 238, 161)
      .bezierCurveTo(228, 148, 219, 143, 210, 136)
      .moveTo(279, 307)
      .bezierCurveTo(335, 313, 397, 341, 470, 353)
      .stroke({ color: colors.pathEdge, width: 15, cap: "round" })
      .stroke({ color: colors.path, width: 10, cap: "round" });
    const square = new Graphics()
      .roundRect(270, 191, 76, 70, 22)
      .fill(colors.path)
      .stroke({ color: colors.pathEdge, alpha: 0.7, width: 2 });
    this.terrain.addChild(primary, secondary, square);
  }

  private drawParityPaths(): void {
    const path = new Graphics()
      .moveTo(80, 214)
      .bezierCurveTo(150, 210, 205, 218, 284, 214)
      .bezierCurveTo(321, 218, 337, 259, 354, 322)
      .moveTo(284, 214)
      .bezierCurveTo(270, 174, 252, 145, 250, 105)
      .moveTo(287, 215)
      .bezierCurveTo(334, 194, 374, 164, 432, 145)
      .moveTo(282, 218)
      .bezierCurveTo(236, 245, 192, 270, 145, 292)
      .stroke({ color: colors.pathEdge, width: 20, cap: "round" })
      .stroke({ color: colors.path, width: 15, cap: "round" });
    const square = new Graphics()
      .roundRect(251, 183, 72, 65, 20)
      .fill(colors.path)
      .stroke({ color: colors.pathEdge, alpha: 0.7, width: 2 });
    this.terrain.addChild(path, square);
  }

  private drawPond(): void {
    const pond =
      this.options.scene === "town"
        ? { x: 24, y: 72, width: 118, height: 86 }
        : { x: 505, y: 266, width: 105, height: 78 };
    const waterTexture = this.sheetFrame({
      x: 64,
      y: 16,
      width: 16,
      height: 16,
    });
    const water = new TilingSprite({
      texture: waterTexture,
      width: pond.width,
      height: pond.height,
    });
    water.position.set(pond.x, pond.y);
    const mask = new Graphics()
      .roundRect(pond.x, pond.y, pond.width, pond.height, 28)
      .fill(0xffffff);
    const edge = new Graphics()
      .roundRect(pond.x - 2, pond.y - 2, pond.width + 4, pond.height + 4, 30)
      .stroke({ color: 0xeee1a8, width: 3, alpha: 0.9 })
      .roundRect(pond.x + 3, pond.y + 3, pond.width - 6, pond.height - 6, 24)
      .stroke({ color: 0x62d6d0, width: 2, alpha: 0.75 });
    water.mask = mask;
    this.terrain.addChild(water, mask, edge);
  }

  private drawGrassDetails(): void {
    const flower = this.sheetFrame({ x: 432, y: 32, width: 16, height: 16 });
    const dirt = this.sheetFrame({ x: 112, y: 16, width: 16, height: 16 });
    const positions =
      this.options.scene === "town"
        ? [
            [34, 36],
            [78, 184],
            [158, 54],
            [362, 42],
            [548, 62],
            [598, 198],
            [68, 354],
            [185, 374],
            [384, 382],
            [565, 372],
            [354, 160],
            [204, 205],
          ]
        : [
            [34, 44],
            [124, 86],
            [360, 64],
            [548, 85],
            [590, 198],
            [62, 350],
            [206, 382],
            [488, 386],
            [178, 184],
            [462, 240],
          ];
    for (const [index, position] of positions.entries()) {
      const sprite = new Sprite(index % 3 === 0 ? dirt : flower);
      sprite.alpha = index % 3 === 0 ? 0.22 : 0.78;
      sprite.position.set(position[0] ?? 0, position[1] ?? 0);
      this.terrain.addChild(sprite);
    }
  }

  private drawTreeClusters(): void {
    const clusters =
      this.options.scene === "town"
        ? [
            [8, 26],
            [38, 28],
            [69, 31],
            [101, 34],
            [516, 17],
            [548, 20],
            [581, 26],
            [607, 42],
            [18, 350],
            [50, 371],
            [584, 344],
            [613, 366],
            [524, 100],
            [553, 115],
          ]
        : [
            [10, 24],
            [42, 30],
            [73, 40],
            [548, 25],
            [580, 31],
            [610, 52],
            [17, 344],
            [49, 367],
            [573, 350],
            [608, 368],
          ];
    for (const [index, position] of clusters.entries()) {
      const asset =
        index % 3 === 0
          ? SunnysideAssets.foliage.pineTree
          : SunnysideAssets.foliage.roundTree;
      const sprite = new Sprite(this.texture(asset));
      sprite.anchor.set(0.5, 1);
      sprite.position.set(position[0] ?? 0, position[1] ?? 0);
      this.terrain.addChild(sprite);
    }
  }

  private drawSettlement(): void {
    if (this.options.scene === "town") this.drawNativeSettlement();
    else this.drawParitySettlement();
  }

  private drawNativeSettlement(): void {
    this.drawBuilding("Guild Hall", "guild", 210, 132);
    this.drawFence(
      [
        [142, 137],
        [142, 151],
        [274, 151],
        [274, 136],
      ],
      12,
    );
    this.prop("flowers", 161, 139);
    this.prop("flowers", 259, 139);
    this.prop("chair", 176, 150);
    this.prop("chair", 240, 150);

    this.drawBuilding("Tavern", "tavern", 126, 286);
    this.drawFence(
      [
        [53, 282],
        [53, 315],
        [185, 315],
        [185, 295],
      ],
      11,
    );
    this.prop("barrel", 72, 287);
    this.prop("barrel", 84, 287);
    this.prop("chair", 158, 300);
    this.prop("trough", 45, 325);

    this.drawBuilding("Forge", "forge", 462, 246);
    this.drawFence(
      [
        [393, 242],
        [393, 279],
        [530, 279],
        [530, 251],
      ],
      11,
    );
    this.prop("anvil", 402, 267);
    this.prop("barrelSwords", 422, 265);
    this.prop("oreCoal", 499, 268);
    this.prop("oreStone", 513, 268);
    this.prop("minecart", 531, 279);
    this.addAnimated(SunnysideAssets.effects.fire, 440, 271);
    this.addAnimated(SunnysideAssets.effects.smoke, 502, 163);

    this.drawSmallBuilding("Projects", 244, 410);
    this.prop("chest", 204, 393);
    this.prop("crate", 220, 397);
    this.prop("crateAlt", 271, 396);

    this.drawQuestBoard(309, 224);
    this.prop("well", 337, 237);
    this.drawWorkYard(470, 353);
  }

  private drawParitySettlement(): void {
    this.drawBuilding("Guild Hall", "guild", 250, 122);
    this.drawBuilding("Tavern", "tavern", 137, 312);
    this.drawBuilding("Forge", "forge", 436, 158);
    this.drawSmallBuilding("Projects", 80, 231);
    this.drawQuestBoard(286, 215);
    this.drawWorkYard(392, 342);
    this.prop("flowers", 198, 137);
    this.prop("chair", 222, 145);
    this.prop("barrel", 86, 299);
    this.prop("barrelSwords", 397, 170);
    this.prop("anvil", 415, 174);
    this.prop("oreCoal", 463, 176);
    this.prop("crate", 110, 229);
    this.prop("chest", 97, 231);
    this.addAnimated(SunnysideAssets.effects.fire, 450, 177);
    this.addAnimated(SunnysideAssets.effects.smoke, 472, 76);
  }

  private drawBuilding(
    label: string,
    variant: "guild" | "forge" | "tavern",
    x: number,
    y: number,
  ): void {
    const sprite = new Sprite(this.texture(SunnysideAssets.buildings[variant]));
    sprite.anchor.set(0.5, 1);
    sprite.position.set(x, y);
    const shadow = new Graphics()
      .ellipse(x, y - 2, variant === "guild" ? 102 : 86, 15)
      .fill({ color: colors.ink, alpha: 0.16 });
    this.places.addChild(shadow, sprite, this.label(label, x, y + 4));
  }

  private drawSmallBuilding(label: string, x: number, y: number): void {
    const sprite = new Sprite(this.texture(SunnysideAssets.buildings.projects));
    sprite.anchor.set(0.5, 1);
    sprite.position.set(x, y);
    const shadow = new Graphics()
      .ellipse(x, y - 2, 48, 12)
      .fill({ color: colors.ink, alpha: 0.16 });
    this.places.addChild(shadow, sprite, this.label(label, x, y + 4));
  }

  private drawQuestBoard(x: number, y: number): void {
    const board = new Container();
    const art = new Graphics()
      .roundRect(-15, -23, 30, 21, 2)
      .fill(0xf3d7a2)
      .stroke({ color: colors.wood, width: 2 })
      .moveTo(-10, -17)
      .lineTo(9, -17)
      .moveTo(-10, -12)
      .lineTo(6, -12)
      .moveTo(-10, -7)
      .lineTo(10, -7)
      .stroke({ color: colors.wood, width: 1 })
      .rect(-12, -2, 3, 12)
      .fill(colors.wood)
      .rect(9, -2, 3, 12)
      .fill(colors.wood);
    board.addChild(art);
    board.position.set(x, y);
    this.places.addChild(board, this.label("Quest Board", x, y + 13));
  }

  private drawWorkYard(x: number, y: number): void {
    const yard = new Graphics()
      .roundRect(x - 75, y - 52, 150, 82, 12)
      .fill({ color: 0xc98c58, alpha: 0.22 })
      .stroke({ color: colors.wood, width: 3, alpha: 0.9 });
    this.places.addChild(yard);
    this.drawFence(
      [
        [x - 70, y - 47],
        [x + 70, y - 47],
      ],
      12,
    );
    const stations = [
      [x - 50, y - 28],
      [x - 12, y - 28],
      [x + 27, y - 28],
      [x - 50, y + 2],
      [x - 12, y + 2],
      [x + 27, y + 2],
    ];
    for (const [index, position] of stations.entries()) {
      const table = new Graphics()
        .roundRect(-10, -3, 20, 7, 2)
        .fill(index % 2 === 0 ? colors.woodLight : 0x718b86)
        .stroke({ color: colors.ink, width: 1 });
      table.position.set(position[0] ?? 0, position[1] ?? 0);
      this.details.addChild(table);
    }
    this.prop("sideTable", x + 58, y + 18);
    this.prop("beam", x - 66, y + 22);
    this.prop("crate", x + 69, y - 10);
    this.prop("bucket", x + 50, y + 22);
    this.places.addChild(this.label("Workshop District", x, y + 39));
  }

  private drawFence(points: number[][], postEvery: number): void {
    const fence = new Graphics();
    const first = points[0];
    if (!first) return;
    fence.moveTo(first[0] ?? 0, first[1] ?? 0);
    for (const point of points.slice(1))
      fence.lineTo(point[0] ?? 0, point[1] ?? 0);
    fence.stroke({ color: colors.wood, width: 3, alpha: 0.9 });
    for (let index = 0; index < points.length - 1; index += 1) {
      const a = points[index];
      const b = points[index + 1];
      if (!a || !b) continue;
      const distance = Math.hypot(
        (b[0] ?? 0) - (a[0] ?? 0),
        (b[1] ?? 0) - (a[1] ?? 0),
      );
      const count = Math.max(1, Math.floor(distance / postEvery));
      for (let step = 0; step <= count; step += 1) {
        const ratio = step / count;
        const x = (a[0] ?? 0) + ((b[0] ?? 0) - (a[0] ?? 0)) * ratio;
        const y = (a[1] ?? 0) + ((b[1] ?? 0) - (a[1] ?? 0)) * ratio;
        fence
          .rect(Math.round(x) - 1, Math.round(y) - 4, 3, 8)
          .fill(colors.woodLight);
      }
    }
    this.details.addChild(fence);
  }

  private prop(
    name: keyof typeof SunnysideAssets.props,
    x: number,
    y: number,
  ): void {
    const asset = SunnysideAssets.props[name];
    const sprite = new Sprite(this.texture(asset));
    sprite.anchor.set(asset.anchor[0], asset.anchor[1]);
    sprite.position.set(x, y);
    this.details.addChild(sprite);
  }

  private drawAmbientLife(): void {
    const values =
      this.options.scene === "town"
        ? ([
            [SunnysideAssets.animals.chicken, 82, 328],
            [SunnysideAssets.animals.chicken, 173, 306],
            [SunnysideAssets.animals.duck, 72, 130],
            [SunnysideAssets.animals.duck, 98, 118],
            [SunnysideAssets.animals.bird, 362, 102],
          ] as const)
        : ([
            [SunnysideAssets.animals.chicken, 129, 352],
            [SunnysideAssets.animals.duck, 548, 307],
            [SunnysideAssets.animals.bird, 355, 91],
          ] as const);
    for (const [index, [asset, x, y]] of values.entries())
      this.addAnimated(asset, x, y, index * 2);
    this.addAnimated(
      SunnysideAssets.effects.glint,
      this.options.scene === "town" ? 548 : 518,
      this.options.scene === "town" ? 154 : 118,
      3,
    );
  }

  private addAnimated(
    asset: SunnysideAsset,
    x: number,
    y: number,
    phase = 0,
  ): void {
    const sprite = new Sprite(this.frame(asset, 0));
    sprite.anchor.set(asset.anchor[0], asset.anchor[1]);
    sprite.position.set(x, y);
    this.activity.addChild(sprite);
    this.animated.push({
      sprite,
      asset,
      frames: asset.frames ?? 1,
      phase,
    });
  }

  private drawMembers(): void {
    const positions = this.memberPositions();
    for (const [index, model] of this.options.model.members.entries()) {
      const position = positions[index] ??
        positions[positions.length - 1] ?? [300, 250];
      const identity = memberIdentity(
        this.options.model.squadKey,
        model.member.member_key,
      );
      const hairStyle =
        hairStyles[identity.hash % hairStyles.length] ?? hairStyles[0];
      const action = this.actionFor(model.visual);
      const animation = SunnysideAssets.characters[action];
      const base = new Sprite(this.frame(animation.base, 0));
      const hair = new Sprite(this.frame(animation.hair[hairStyle], 0));
      base.anchor.set(0.5, 1);
      hair.anchor.set(0.5, 1);
      const root = new Container();
      const shadow = new Graphics()
        .ellipse(0, -1, 15, 6)
        .fill({ color: colors.ink, alpha: 0.28 });
      root.addChild(shadow, base, hair);
      root.position.set(position[0] ?? 0, position[1] ?? 0);
      this.activity.addChild(root);
      this.drawMemberStatus(root, model.visual, model.member.name);
      this.members.push({
        root,
        base,
        hair,
        hairStyle,
        visual: model.visual,
        phase: identity.hash % 17,
        origin: { x: position[0] ?? 0, y: position[1] ?? 0 },
      });
    }
  }

  private memberPositions(): number[][] {
    if (this.options.scene === "town")
      return [
        [423, 326],
        [456, 326],
        [489, 326],
        [355, 294],
        [383, 305],
        [436, 366],
        [477, 366],
        [78, 307],
        [125, 321],
        [174, 308],
        [270, 260],
        [344, 264],
      ];
    return [
      [349, 309],
      [389, 309],
      [429, 309],
      [306, 273],
      [332, 289],
      [373, 356],
      [418, 356],
      [98, 330],
      [137, 342],
      [177, 330],
      [230, 254],
      [260, 261],
    ];
  }

  private actionFor(visual: VisualActivity): SpikeCharacterAction {
    if (visual === "working") return "doing";
    if (visual === "moving_to_work") return "walk";
    return "idle";
  }

  private drawMemberStatus(
    root: Container,
    visual: VisualActivity,
    name: string,
  ): void {
    if (visual === "idle") return;
    const marker = new Graphics();
    const color =
      visual === "working"
        ? colors.success
        : visual === "moving_to_work"
          ? colors.moving
          : visual === "failed"
            ? colors.failure
            : visual === "uncertain"
              ? colors.uncertain
              : colors.warning;
    marker.circle(0, -22, 6).fill(colors.cream).stroke({ color, width: 2 });
    root.addChild(marker);
    if (visual === "working") {
      const icon = new Sprite(this.texture(SunnysideAssets.ui.working));
      icon.anchor.set(0.5);
      icon.position.set(0, -22);
      root.addChild(icon);
    } else if (visual === "moving_to_work") {
      marker
        .moveTo(-3, -22)
        .lineTo(3, -22)
        .moveTo(1, -24)
        .lineTo(3, -22)
        .lineTo(1, -20)
        .stroke({ color, width: 1.5 });
    } else if (visual === "failed") {
      marker
        .moveTo(-3, -25)
        .lineTo(3, -19)
        .moveTo(3, -25)
        .lineTo(-3, -19)
        .stroke({ color, width: 1.5 });
    } else if (visual === "uncertain") {
      const icon = new Sprite(this.texture(SunnysideAssets.ui.confused));
      icon.anchor.set(0.5);
      icon.position.set(0, -22);
      root.addChild(icon);
    }
    if (visual === "failed" || visual === "uncertain") {
      const label = this.text(name, 5, colors.cream);
      label.anchor.set(0.5);
      label.position.set(0, -34);
      root.addChild(label);
    }
  }

  private drawSemanticOverlays(): void {
    const board =
      this.options.scene === "town" ? { x: 309, y: 224 } : { x: 286, y: 215 };
    if (this.options.awaitingReview > 0) {
      const marker = new Container();
      const back = new Graphics()
        .roundRect(-18, -9, 36, 18, 8)
        .fill(colors.cream)
        .stroke({ color: colors.review, width: 2 });
      const icon = new Sprite(this.texture(SunnysideAssets.ui.alerted));
      icon.anchor.set(0.5);
      icon.position.set(-10, 0);
      const label = this.text("PR", 7, colors.review);
      label.anchor.set(0.5);
      label.position.set(6, -1);
      marker.addChild(back, icon, label);
      marker.position.set(board.x + 18, board.y - 35);
      this.overlays.addChild(marker);
    }

    const yard =
      this.options.scene === "town" ? { x: 392, y: 382 } : { x: 314, y: 354 };
    for (const [index, order] of this.options.model.orderMarkers
      .slice(0, 2)
      .entries()) {
      const notice = new Container();
      const back = new Graphics()
        .roundRect(-8, -8, 16, 16, 3)
        .fill(colors.paper)
        .stroke({ color: colors.warning, width: 2 });
      const icon = new Sprite(this.texture(SunnysideAssets.ui.plan));
      icon.anchor.set(0.5);
      const number = this.text(String(index + 1), 5, colors.ink);
      number.anchor.set(0.5);
      number.position.set(6, 6);
      notice.addChild(back, icon, number);
      notice.position.set(yard.x + index * 21, yard.y);
      const label = this.text(
        order.state === "waiting" ? "waiting" : "pending",
        5,
        colors.cream,
      );
      label.position.set(10, -4);
      notice.addChild(label);
      this.overlays.addChild(notice);
    }
  }

  private applyPalette(): void {
    if (this.options.palette === "native") return;
    const filter = new ColorMatrixFilter();
    if (this.options.palette === "management") {
      filter.saturate(-0.16, false);
      filter.brightness(0.98, true);
    } else {
      filter.saturate(-0.3, false);
      filter.brightness(1.01, true);
      this.terrain.addChild(
        new Graphics()
          .rect(0, 0, WORLD.width, WORLD.height)
          .fill({ color: 0xd59a68, alpha: 0.09 }),
      );
    }
    this.terrain.filters = [filter];
    if (this.options.palette === "earthy") this.details.tint = 0xf2d9b0;
  }

  private positionCamera(): void {
    const width = this.app.screen.width;
    const height = this.app.screen.height;
    const panelWidth = this.options.showPanel
      ? width <= 980
        ? Math.min(350, width * 0.42)
        : 410
      : 0;
    const availableWidth = width - panelWidth;
    const availableHeight = height - 98;
    const target =
      this.options.scene === "town"
        ? { x: WORLD.width / 2, y: WORLD.height / 2 }
        : { x: 310, y: 230 };
    this.root.scale.set(this.options.zoom);
    this.root.position.set(
      Math.round(availableWidth / 2 - target.x * this.options.zoom),
      Math.round(53 + availableHeight / 2 - target.y * this.options.zoom),
    );
  }

  private tick = () => {
    const now = performance.now();
    this.positionCamera();
    for (const layer of this.animated) {
      const frame = this.reducedMotion
        ? 0
        : (Math.floor(now / (layer.asset.frameDurationMs ?? 120)) +
            layer.phase) %
          layer.frames;
      layer.sprite.texture = this.frame(layer.asset, frame);
    }
    for (const member of this.members) {
      const action = this.actionFor(member.visual);
      const animation = SunnysideAssets.characters[action];
      const frame = this.reducedMotion
        ? 0
        : (Math.floor(now / 100) + member.phase) % animation.frames;
      member.base.texture = this.frame(animation.base, frame);
      member.hair.texture = this.frame(animation.hair[member.hairStyle], frame);
      if (member.visual === "moving_to_work" && !this.reducedMotion) {
        member.root.x =
          member.origin.x + Math.round(Math.sin(now / 480 + member.phase) * 4);
      }
    }
  };

  private label(value: string, x: number, y: number): Text {
    const text = this.text(value, 7, colors.cream);
    text.anchor.set(0.5, 0);
    text.position.set(x, y);
    return text;
  }

  private text(value: string, size: number, color: number): Text {
    return new Text({
      text: value,
      style: {
        fill: color,
        fontFamily: "Georgia, serif",
        fontSize: size,
        fontWeight: "700",
        stroke: { color: colors.ink, width: 2 },
      },
    });
  }
}
