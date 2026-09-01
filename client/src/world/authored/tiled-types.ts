export interface TiledProperty {
  name: string;
  type: string;
  value: unknown;
}

export interface TiledTilesetReference {
  firstgid: number;
  source: string;
}

export interface TiledTileLayer {
  id: number;
  name: string;
  type: "tilelayer";
  width: number;
  height: number;
  data: number[];
  visible: boolean;
  opacity: number;
  x: number;
  y: number;
}

export interface TiledPoint {
  x: number;
  y: number;
}

export interface TiledObject {
  id: number;
  name: string;
  type?: string;
  class?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  rotation?: number;
  visible?: boolean;
  point?: boolean;
  gid?: number;
  polygon?: TiledPoint[];
  polyline?: TiledPoint[];
  properties?: TiledProperty[];
}

export interface TiledObjectLayer {
  id: number;
  name: string;
  type: "objectgroup";
  objects: TiledObject[];
  visible: boolean;
  opacity: number;
  x: number;
  y: number;
}

export type TiledLayer = TiledTileLayer | TiledObjectLayer;

export interface TiledMapJson {
  type: "map";
  version: string | number;
  tiledversion?: string;
  orientation: string;
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  infinite: boolean;
  layers: TiledLayer[];
  tilesets: TiledTilesetReference[];
  properties?: TiledProperty[];
}

export interface TiledCollectionTile {
  id: number;
  image: string;
  imagewidth: number;
  imageheight: number;
  properties?: TiledProperty[];
}

export interface TiledTilesetJson {
  type: "tileset";
  name: string;
  tilewidth: number;
  tileheight: number;
  tilecount: number;
  columns?: number;
  image?: string;
  imagewidth?: number;
  imageheight?: number;
  margin?: number;
  spacing?: number;
  objectalignment?: string;
  tiles?: TiledCollectionTile[];
  wangsets?: unknown[];
}
