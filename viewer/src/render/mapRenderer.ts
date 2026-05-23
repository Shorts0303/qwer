import { Container, Graphics } from 'pixi.js';
import { DEFAULT_HEX_LAYOUT, offsetToPixel, rowZIndex, type HexLayout } from '../hex/layout';
import type { GameMap } from '../map/gameMap';
import { TileType } from '../map/tiles';

const TILE_COLORS: Record<TileType, number> = {
  [TileType.PLAIN]: 0x5aa070,        // brighter mossy grass
  [TileType.LAKE]: 0x3e78b8,         // vivid slate blue
  [TileType.WALL]: 0x8a7d6a,         // warm stone (lit top)
  [TileType.HIGH_GROUND]: 0x8cb567,  // bright olive highland
  [TileType.CAPTURE]: 0xe8bf6e,      // vivid warm gold
};

// Per-tile vertical lift (how far the top sits above the ground plane).
// Walls double the high-ground lift so they read as solid obstacles, not just
// recolored hexes — important for screenshots where players need to see at a
// glance which tiles block movement vs. which ones are merely elevated.
const TILE_LIFT: Record<TileType, number> = {
  [TileType.PLAIN]: 0,
  [TileType.LAKE]: 0,
  [TileType.WALL]: 24,
  [TileType.HIGH_GROUND]: 12,
  [TileType.CAPTURE]: 0,
};

const TILE_CLIFF_FILL: Record<TileType, number> = {
  [TileType.PLAIN]: 0,
  [TileType.LAKE]: 0,
  [TileType.WALL]: 0x4a4035,         // dark stone (shadowed cliff face)
  [TileType.HIGH_GROUND]: 0x4f6a3a,  // dark olive
  [TileType.CAPTURE]: 0,
};

const HIGHLIGHT_ALPHA = 0.22;        // upper-face sheen intensity
const SHADOW_ALPHA = 0.14;           // lower-face ambient occlusion
const CLIFF_BASE_DEPTH = 18;         // extra depth below the lift for cliff face

export interface MapRenderOptions {
  readonly layout?: HexLayout;
}

export function createMapContainer(map: GameMap, options: MapRenderOptions = {}): Container {
  const layout = options.layout ?? DEFAULT_HEX_LAYOUT;
  const root = new Container();
  root.sortableChildren = true;

  const verts = pointyHexVertices(layout);

  for (let row = 0; row < map.height; row += 1) {
    for (let col = 0; col < map.width; col += 1) {
      const tile = map.tiles[row]![col]!;
      const pixel = offsetToPixel({ col, row }, layout);

      const top = drawHexTop(tile, verts);
      const lift = TILE_LIFT[tile];
      top.position.set(pixel.x, pixel.y - lift);
      top.zIndex = rowZIndex(row, 2);
      root.addChild(top);

      if (lift > 0) {
        const side = drawCliffSide(verts, lift + CLIFF_BASE_DEPTH, TILE_CLIFF_FILL[tile]);
        side.position.set(pixel.x, pixel.y - lift);
        side.zIndex = rowZIndex(row, 1);
        root.addChild(side);
      }
    }
  }

  return root;
}

function drawHexTop(tile: TileType, verts: readonly Point[]): Graphics {
  const g = new Graphics();
  // Base fill
  g.poly(verts.flatMap(({ x, y }) => [x, y]));
  g.fill({ color: TILE_COLORS[tile] });
  g.stroke({ width: 1, color: 0x000000, alpha: 0.3 });

  // Upper-half sheen — white overlay on the top three vertices + center, gives a
  // pseudo-specular highlight as if light came from above.
  g.poly(upperHalfPoly(verts));
  g.fill({ color: 0xffffff, alpha: HIGHLIGHT_ALPHA });

  // Lower-half ambient occlusion — subtle dark wash on the lower three
  // vertices + center, deepens contrast without looking muddy.
  g.poly(lowerHalfPoly(verts));
  g.fill({ color: 0x000000, alpha: SHADOW_ALPHA });

  if (tile === TileType.CAPTURE) {
    g.poly(innerStarPoly(verts));
    g.fill({ color: 0xffe39a, alpha: 0.95 });
  }
  return g;
}

function upperHalfPoly(verts: readonly Point[]): number[] {
  // Vertices at angles 30°/90°/150°/210°/270°/330° (math). In screen-space
  // Y-down, indices 3/4/5 (angles 210/270/330) are the upper vertices.
  return [
    0, 0,
    verts[3]!.x, verts[3]!.y,
    verts[4]!.x, verts[4]!.y,
    verts[5]!.x, verts[5]!.y,
  ];
}

function lowerHalfPoly(verts: readonly Point[]): number[] {
  // Indices 0/1/2 (angles 30/90/150) are the lower-screen vertices.
  return [
    0, 0,
    verts[2]!.x, verts[2]!.y,
    verts[1]!.x, verts[1]!.y,
    verts[0]!.x, verts[0]!.y,
  ];
}

function drawCliffSide(verts: readonly Point[], depth: number, color: number): Graphics {
  const sorted = [...verts].sort((a, b) => b.y - a.y);
  const bottomTriplet = sorted.slice(0, 3).sort((a, b) => a.x - b.x);
  const left = bottomTriplet[0]!;
  const mid = bottomTriplet[1]!;
  const right = bottomTriplet[2]!;
  const g = new Graphics();
  g.poly([
    left.x, left.y,
    mid.x, mid.y,
    right.x, right.y,
    right.x, right.y + depth,
    mid.x, mid.y + depth,
    left.x, left.y + depth,
  ]);
  g.fill({ color });
  g.stroke({ width: 1, color: 0x000000, alpha: 0.4 });
  return g;
}

function innerStarPoly(verts: readonly Point[]): number[] {
  // Smaller inset diamond on top of capture tile for readable icon.
  return [
    0, verts[1]!.y * 0.45,
    verts[0]!.x * 0.45, 0,
    0, verts[4]!.y * 0.45,
    verts[3]!.x * 0.45, 0,
  ];
}

interface Point {
  readonly x: number;
  readonly y: number;
}

function pointyHexVertices(layout: HexLayout): Point[] {
  const s = layout.size;
  const c = layout.isoCompress;
  const verts: Point[] = [];
  for (let i = 0; i < 6; i += 1) {
    const angle = ((30 + i * 60) * Math.PI) / 180;
    verts.push({ x: s * Math.cos(angle), y: s * Math.sin(angle) * c });
  }
  return verts;
}
