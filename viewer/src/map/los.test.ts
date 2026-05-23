import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parseMap } from './gameMap';
import { hasLineOfSight, hexLine } from './los';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MAP_PATH = resolve(__dirname, '../../../engine/maps/default.txt');
const map = parseMap(readFileSync(DEFAULT_MAP_PATH, 'utf-8'));

describe('hexLine', () => {
  it('returns [a] when endpoints are identical', () => {
    const line = hexLine({ col: 5, row: 3 }, { col: 5, row: 3 });
    expect(line).toHaveLength(1);
  });

  it('length equals distance + 1', () => {
    const a = { col: 0, row: 0 };
    const b = { col: 10, row: 6 };
    // Known distance between these corners is 13.
    expect(hexLine(a, b)).toHaveLength(14);
  });

  it('both endpoints are included at the extremes', () => {
    const a = { col: 2, row: 2 };
    const b = { col: 6, row: 2 };
    const line = hexLine(a, b);
    expect(line[0]).toEqual(a);
    expect(line[line.length - 1]).toEqual(b);
  });
});

describe('hasLineOfSight: default map', () => {
  const empty = new Set<string>();

  it('is true for identical positions', () => {
    expect(hasLineOfSight(map, { col: 5, row: 3 }, { col: 5, row: 3 }, empty)).toBe(true);
  });

  it('vertical shot across a lake passes (lakes do not block vision)', () => {
    expect(hasLineOfSight(map, { col: 3, row: 0 }, { col: 3, row: 6 }, empty)).toBe(true);
  });

  it('wall at (5, 1) blocks the shot from (5, 0) to (5, 3)', () => {
    expect(hasLineOfSight(map, { col: 5, row: 0 }, { col: 5, row: 3 }, empty)).toBe(false);
  });

  it('intermediate unit blocks LoS but target unit does not', () => {
    const blocker = new Set(['5,2']); // target tile is NOT this — this sits between
    expect(hasLineOfSight(map, { col: 5, row: 0 }, { col: 5, row: 3 }, blocker)).toBe(false);
    // if only the target is occupied, endpoints are excluded from the check:
    const targetOnly = new Set(['5,3']);
    expect(
      hasLineOfSight(map, { col: 5, row: 1 - 1 }, { col: 5, row: 3 }, targetOnly),
    ).toBe(false); // still blocked by wall at (5, 1)
  });
});
