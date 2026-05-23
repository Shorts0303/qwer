/**
 * Hex line and line-of-sight — verbatim port of engine/position.py::hex_line
 * and engine/game_map.py::has_line_of_sight so the viewer's targeting preview
 * matches what the engine will actually permit at attack-resolution time.
 */

import { fromCube, hexDistance, toCube, type Cube, type Offset } from '../hex/coord';
import { isValidPosition, tileAt, type GameMap } from './gameMap';
import { propsOf } from './tiles';

export function hexLine(a: Offset, b: Offset): Offset[] {
  const n = hexDistance(a, b);
  if (n === 0) return [a];
  const ac = toCube(a);
  const bc = toCube(b);
  const eps = 1e-6;
  const aqf = ac.q + eps;
  const arf = ac.r + eps;
  const asf = ac.s - 2 * eps;
  const out: Offset[] = [];
  for (let i = 0; i <= n; i += 1) {
    const t = i / n;
    const qf = aqf + (bc.q - aqf) * t;
    const rf = arf + (bc.r - arf) * t;
    const sf = asf + (bc.s - asf) * t;
    const rounded = cubeRound(qf, rf, sf);
    out.push(fromCube(rounded));
  }
  return out;
}

function cubeRound(qf: number, rf: number, sf: number): Cube {
  let q = Math.round(qf);
  let r = Math.round(rf);
  let s = Math.round(sf);
  const dq = Math.abs(q - qf);
  const dr = Math.abs(r - rf);
  const ds = Math.abs(s - sf);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  else s = -q - r;
  return { q, r, s };
}

export function blocksVision(map: GameMap, pos: Offset): boolean {
  if (!isValidPosition(map, pos)) return false;
  return propsOf(tileAt(map, pos)).blocksVision;
}

/**
 * Endpoints are excluded from obstruction checks — the target tile being
 * occupied by a unit does not block targeting that unit.
 */
export function hasLineOfSight(
  map: GameMap,
  from: Offset,
  to: Offset,
  occupied: ReadonlySet<string>,
): boolean {
  if (from.col === to.col && from.row === to.row) return true;
  const line = hexLine(from, to);
  for (let i = 1; i < line.length - 1; i += 1) {
    const tile = line[i]!;
    if (!isValidPosition(map, tile)) return false;
    if (blocksVision(map, tile)) return false;
    if (occupied.has(`${tile.col},${tile.row}`)) return false;
  }
  return true;
}

export function occupiedKey(pos: Offset): string {
  return `${pos.col},${pos.row}`;
}
