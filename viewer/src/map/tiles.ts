/**
 * Tile types — mirrors engine/tiles.py.
 *
 * Map ASCII:
 *   .  → PLAIN
 *   ~  → LAKE      (impassable, does not block vision)
 *   #  → WALL      (impassable, blocks vision)
 *   ^  → HIGH_GROUND (passable, elevated)
 *   *  → CAPTURE   (passable, capture point)
 */

export const TileType = {
  PLAIN: 'plain',
  LAKE: 'lake',
  WALL: 'wall',
  HIGH_GROUND: 'high_ground',
  CAPTURE: 'capture',
} as const;

export type TileType = (typeof TileType)[keyof typeof TileType];

export interface TileProps {
  readonly walkable: boolean;
  readonly blocksVision: boolean;
  readonly isHighGround: boolean;
  readonly isCapturePoint: boolean;
}

const TILE_CHAR_MAP: Record<string, TileType> = {
  '.': TileType.PLAIN,
  '~': TileType.LAKE,
  '#': TileType.WALL,
  '^': TileType.HIGH_GROUND,
  '*': TileType.CAPTURE,
};

const TILE_PROPS: Record<TileType, TileProps> = {
  [TileType.PLAIN]:       { walkable: true,  blocksVision: false, isHighGround: false, isCapturePoint: false },
  [TileType.LAKE]:        { walkable: false, blocksVision: false, isHighGround: false, isCapturePoint: false },
  [TileType.WALL]:        { walkable: false, blocksVision: true,  isHighGround: false, isCapturePoint: false },
  [TileType.HIGH_GROUND]: { walkable: true,  blocksVision: false, isHighGround: true,  isCapturePoint: false },
  [TileType.CAPTURE]:     { walkable: true,  blocksVision: false, isHighGround: false, isCapturePoint: true  },
};

export function tileFromChar(ch: string): TileType {
  const t = TILE_CHAR_MAP[ch];
  if (t === undefined) {
    throw new Error(`unknown map character: ${JSON.stringify(ch)}`);
  }
  return t;
}

export function propsOf(tile: TileType): TileProps {
  return TILE_PROPS[tile];
}
