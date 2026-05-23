import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { isValidPosition, parseMap, tileAt } from './gameMap';
import { TileType, tileFromChar, propsOf } from './tiles';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MAP_PATH = resolve(__dirname, '../../../engine/maps/default.txt');

describe('tileFromChar', () => {
  it('maps each supported character', () => {
    expect(tileFromChar('.')).toBe(TileType.PLAIN);
    expect(tileFromChar('~')).toBe(TileType.LAKE);
    expect(tileFromChar('#')).toBe(TileType.WALL);
    expect(tileFromChar('^')).toBe(TileType.HIGH_GROUND);
    expect(tileFromChar('*')).toBe(TileType.CAPTURE);
  });

  it('throws on unknown character', () => {
    expect(() => tileFromChar('?')).toThrow(/unknown map character/);
  });
});

describe('propsOf', () => {
  it('reflects engine/tiles.py bitmap', () => {
    expect(propsOf(TileType.PLAIN).walkable).toBe(true);
    expect(propsOf(TileType.LAKE).walkable).toBe(false);
    expect(propsOf(TileType.LAKE).blocksVision).toBe(false);
    expect(propsOf(TileType.WALL).walkable).toBe(false);
    expect(propsOf(TileType.WALL).blocksVision).toBe(true);
    expect(propsOf(TileType.HIGH_GROUND).walkable).toBe(true);
    expect(propsOf(TileType.HIGH_GROUND).isHighGround).toBe(true);
    expect(propsOf(TileType.CAPTURE).walkable).toBe(true);
    expect(propsOf(TileType.CAPTURE).isCapturePoint).toBe(true);
  });
});

describe('parseMap: default.txt', () => {
  const text = readFileSync(DEFAULT_MAP_PATH, 'utf-8');
  const map = parseMap(text);

  it('is 11 wide × 7 tall', () => {
    expect(map.width).toBe(11);
    expect(map.height).toBe(7);
  });

  it('has exactly 3 capture points', () => {
    expect(map.capturePoints).toHaveLength(3);
  });

  it('capture points are 3 zones spread across mid-row', () => {
    const keys = new Set(map.capturePoints.map((c) => `${c.col},${c.row}`));
    // engine/maps/default.txt now places one capture tile in each of three
    // zones — west/center/east — at row 3, cols 3/5/7.
    expect(keys.has('3,3')).toBe(true);
    expect(keys.has('5,3')).toBe(true);
    expect(keys.has('7,3')).toBe(true);
  });

  it('tileAt reflects grid', () => {
    // Corner is plain
    expect(tileAt(map, { col: 0, row: 0 })).toBe(TileType.PLAIN);
    // Center of row 3 is a capture point
    expect(tileAt(map, { col: 5, row: 3 })).toBe(TileType.CAPTURE);
  });

  it('isValidPosition gates lookups', () => {
    expect(isValidPosition(map, { col: 0, row: 0 })).toBe(true);
    expect(isValidPosition(map, { col: 10, row: 6 })).toBe(true);
    expect(isValidPosition(map, { col: -1, row: 0 })).toBe(false);
    expect(isValidPosition(map, { col: 11, row: 0 })).toBe(false);
    expect(isValidPosition(map, { col: 0, row: 7 })).toBe(false);
  });
});

describe('parseMap: error handling', () => {
  it('throws on empty string', () => {
    expect(() => parseMap('')).toThrow(/empty map/);
  });

  it('throws on ragged rows', () => {
    expect(() => parseMap('....\n..')).toThrow(/ragged map rows/);
  });

  it('throws on unknown character', () => {
    expect(() => parseMap('....?')).toThrow(/unknown map character/);
  });
});
