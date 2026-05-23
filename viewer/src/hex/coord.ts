/**
 * Hex coordinate primitives — mirrors engine/position.py exactly.
 *
 * External form: (col, row) odd-r offset with pointy-top hexagons.
 * Internal form: cube (q, r, s) with q + r + s = 0.
 *
 * The cube conversion formulas are verbatim ports of Position.to_cube /
 * Position.from_cube to guarantee identical rounding behavior.
 */

export interface Offset {
  readonly col: number;
  readonly row: number;
}

export interface Cube {
  readonly q: number;
  readonly r: number;
  readonly s: number;
}

export function toCube({ col, row }: Offset): Cube {
  const q = col - ((row - (row & 1)) >> 1);
  const r = row;
  return { q, r, s: -q - r };
}

export function fromCube({ q, r, s }: Cube): Offset {
  if (q + r + s !== 0) {
    throw new Error(`cube invariant violated: (${q}, ${r}, ${s})`);
  }
  const col = q + ((r - (r & 1)) >> 1);
  return { col, row: r };
}

export function hexDistance(a: Offset, b: Offset): number {
  const ac = toCube(a);
  const bc = toCube(b);
  return (Math.abs(ac.q - bc.q) + Math.abs(ac.r - bc.r) + Math.abs(ac.s - bc.s)) / 2;
}

const CUBE_DIRS: readonly Cube[] = [
  { q: +1, r: -1, s: 0 },
  { q: +1, r: 0, s: -1 },
  { q: 0, r: +1, s: -1 },
  { q: -1, r: +1, s: 0 },
  { q: -1, r: 0, s: +1 },
  { q: 0, r: -1, s: +1 },
];

export function hexNeighbors(pos: Offset): Offset[] {
  const c = toCube(pos);
  return CUBE_DIRS.map((d) => fromCube({ q: c.q + d.q, r: c.r + d.r, s: c.s + d.s }));
}

export function offsetEquals(a: Offset, b: Offset): boolean {
  return a.col === b.col && a.row === b.row;
}
