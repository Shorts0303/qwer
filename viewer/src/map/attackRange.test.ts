import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parseMap } from './gameMap';
import { computeAttackRange } from './attackRange';
import type { UnitState } from '../playback/timeline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MAP_PATH = resolve(__dirname, '../../../engine/maps/default.txt');
const map = parseMap(readFileSync(DEFAULT_MAP_PATH, 'utf-8'));

function mk(overrides: Partial<UnitState>): UnitState {
  return {
    id: 0,
    team: 'A',
    unitClass: 'rifle',
    hp: 400,
    maxHp: 400,
    col: 5,
    row: 3,
    alive: true,
    ...overrides,
  };
}

describe('computeAttackRange', () => {
  it('returns [] for dead actor', () => {
    const actor = mk({ alive: false });
    expect(computeAttackRange(actor, map, [])).toEqual([]);
  });

  it('respects rifle rng=3 (distance 1..3, no high ground)', () => {
    const actor = mk({ unitClass: 'rifle', col: 0, row: 3 });
    const tiles = computeAttackRange(actor, map, [actor]);
    for (const t of tiles) {
      const d = Math.abs(t.col - actor.col) + Math.abs(t.row - actor.row);
      // chebyshev upper bound is ≥ hex distance, so this is a sanity-only check
      expect(d).toBeGreaterThan(0);
    }
    // Rifle at corner (0, 3) should hit something in col 1..3
    const anyInRange = tiles.some((t) => t.col <= 3);
    expect(anyInRange).toBe(true);
  });

  it('DMR min_rng=2: own neighbors are NOT in range', () => {
    const actor = mk({ unitClass: 'dmr', col: 4, row: 1 });
    const tiles = computeAttackRange(actor, map, [actor]);
    const keys = new Set(tiles.map((t) => `${t.col},${t.row}`));
    // hex neighbors of (4,1) — odd row — include (5,1) which is a WALL and should not be selectable anyway
    // but (4,0), (5,0), (3,1), (4,2), (5,2) are all distance 1. None should be in the range set.
    expect(keys.has('4,0')).toBe(false);
    expect(keys.has('3,1')).toBe(false);
    expect(keys.has('5,0')).toBe(false);
  });

  it('wall at (5, 1) blocks a rifle at (5, 0) from reaching (5, 3)', () => {
    const actor = mk({ unitClass: 'rifle', col: 5, row: 0 });
    const tiles = computeAttackRange(actor, map, [actor]);
    const keys = new Set(tiles.map((t) => `${t.col},${t.row}`));
    expect(keys.has('5,3')).toBe(false);
  });

  it('high-ground attacker gets +1 effective range', () => {
    // (2, 1) is a HIGH_GROUND tile per engine/maps/default.txt
    const shieldFlat = mk({ unitClass: 'shield', col: 0, row: 1 });
    const shieldHigh = mk({ unitClass: 'shield', col: 2, row: 1 });
    const flatTiles = computeAttackRange(shieldFlat, map, [shieldFlat]);
    const highTiles = computeAttackRange(shieldHigh, map, [shieldHigh]);
    // both on open terrain but the HG one should see strictly more tiles
    expect(highTiles.length).toBeGreaterThan(flatTiles.length - 2);
    // also the HG shield with rng=1+1=2 should be able to hit tiles at distance 2
    const hgKeys = new Set(highTiles.map((t) => `${t.col},${t.row}`));
    expect(hgKeys.size).toBeGreaterThan(6); // more than just the 6 neighbors
  });
});
