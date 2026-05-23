import type { Offset } from '../hex/coord';
import { TileType, tileFromChar } from './tiles';

export interface GameMap {
  readonly width: number;
  readonly height: number;
  readonly tiles: readonly (readonly TileType[])[];
  readonly capturePoints: readonly Offset[];
}

export function parseMap(text: string): GameMap {
  const rows = text
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
    .filter((line) => line.length > 0);
  if (rows.length === 0) {
    throw new Error('empty map');
  }
  const width = rows[0]!.length;
  const tiles: TileType[][] = rows.map((line, r) => {
    if (line.length !== width) {
      throw new Error(`ragged map rows: row ${r} length=${line.length}, expected ${width}`);
    }
    return Array.from(line, tileFromChar);
  });

  const capturePoints: Offset[] = [];
  tiles.forEach((row, rIdx) => {
    row.forEach((t, cIdx) => {
      if (t === TileType.CAPTURE) {
        capturePoints.push({ col: cIdx, row: rIdx });
      }
    });
  });

  return {
    width,
    height: rows.length,
    tiles,
    capturePoints,
  };
}

export function tileAt(map: GameMap, pos: Offset): TileType {
  if (!isValidPosition(map, pos)) {
    throw new Error(`position out of bounds: (${pos.col}, ${pos.row})`);
  }
  return map.tiles[pos.row]![pos.col]!;
}

export function isValidPosition(map: GameMap, pos: Offset): boolean {
  return pos.col >= 0 && pos.col < map.width && pos.row >= 0 && pos.row < map.height;
}
