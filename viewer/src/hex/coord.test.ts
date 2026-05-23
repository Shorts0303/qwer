import { describe, it, expect } from 'vitest';
import { fromCube, hexDistance, hexNeighbors, offsetEquals, toCube } from './coord';

describe('hex coord: offset ↔ cube round trip', () => {
  it('round-trips for a swath of map coordinates', () => {
    for (let row = 0; row < 7; row += 1) {
      for (let col = 0; col < 11; col += 1) {
        const cube = toCube({ col, row });
        expect(cube.q + cube.r + cube.s).toBe(0);
        const back = fromCube(cube);
        expect(back).toEqual({ col, row });
      }
    }
  });

  it('matches engine/position.py spot values (odd-r)', () => {
    // engine: Position(2, 1).to_cube()
    //   q = 2 - (1 - (1 & 1)) // 2 = 2 - 0 = 2 ; r = 1 ; s = -3
    expect(toCube({ col: 2, row: 1 })).toEqual({ q: 2, r: 1, s: -3 });
    // Position(2, 2): q = 2 - (2 - 0)/2 = 2 - 1 = 1 ; r = 2 ; s = -3
    expect(toCube({ col: 2, row: 2 })).toEqual({ q: 1, r: 2, s: -3 });
    // Position(5, 3): q = 5 - (3 - 1)/2 = 5 - 1 = 4 ; r = 3 ; s = -7
    expect(toCube({ col: 5, row: 3 })).toEqual({ q: 4, r: 3, s: -7 });
  });
});

describe('hex distance', () => {
  it('is zero for identical positions', () => {
    expect(hexDistance({ col: 3, row: 3 }, { col: 3, row: 3 })).toBe(0);
  });

  it('matches known distances on the 11×7 default map', () => {
    // Same row, adjacent columns
    expect(hexDistance({ col: 0, row: 0 }, { col: 1, row: 0 })).toBe(1);
    // Diagonal one hex over
    expect(hexDistance({ col: 2, row: 1 }, { col: 2, row: 2 })).toBe(1);
    // Opposite corners of an 11×7 (big diagonal)
    const d = hexDistance({ col: 0, row: 0 }, { col: 10, row: 6 });
    expect(d).toBeGreaterThan(0);
    expect(d).toBe(13);
  });

  it('is symmetric', () => {
    const a = { col: 1, row: 4 };
    const b = { col: 9, row: 2 };
    expect(hexDistance(a, b)).toBe(hexDistance(b, a));
  });
});

describe('hex neighbors', () => {
  it('returns six unique neighbors for an interior cell', () => {
    const nbs = hexNeighbors({ col: 5, row: 3 });
    expect(nbs).toHaveLength(6);
    const fingerprints = new Set(nbs.map((n) => `${n.col},${n.row}`));
    expect(fingerprints.size).toBe(6);
  });

  it('all neighbors are at distance 1', () => {
    const center = { col: 5, row: 3 };
    for (const nb of hexNeighbors(center)) {
      expect(hexDistance(center, nb)).toBe(1);
    }
  });

  it('pointy-top odd-r: row 1 (odd) neighbors of (5, 1) include row-0 cols {5,6} and row-2 cols {5,6}', () => {
    const nbs = hexNeighbors({ col: 5, row: 1 });
    const key = (o: { col: number; row: number }) => `${o.col},${o.row}`;
    const ks = new Set(nbs.map(key));
    // horizontal
    expect(ks.has('4,1')).toBe(true);
    expect(ks.has('6,1')).toBe(true);
    // up-left, up-right from odd row shift right by +0 in col space
    expect(ks.has('5,0')).toBe(true);
    expect(ks.has('6,0')).toBe(true);
    // down-left, down-right
    expect(ks.has('5,2')).toBe(true);
    expect(ks.has('6,2')).toBe(true);
  });
});

describe('offsetEquals', () => {
  it('equal by value', () => {
    expect(offsetEquals({ col: 1, row: 2 }, { col: 1, row: 2 })).toBe(true);
    expect(offsetEquals({ col: 1, row: 2 }, { col: 2, row: 1 })).toBe(false);
  });
});
