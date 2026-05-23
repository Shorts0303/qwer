/**
 * Compute the tiles a unit can currently attack (or — for medics — heal).
 *
 * Matches engine rules:
 *   - min_rng ≤ hex_distance(actor, tile) ≤ rng (+1 if actor on HIGH_GROUND)
 *   - hasLineOfSight() from actor to tile, where other living units block
 *     the path but endpoints don't.
 */

import { hexDistance, type Offset } from '../hex/coord';
import type { UnitState } from '../playback/timeline';
import { BALANCE } from '../engineBalance';
import { hasLineOfSight, occupiedKey } from './los';
import { tileAt, type GameMap } from './gameMap';
import { TileType } from './tiles';

export function computeAttackRange(
  actor: UnitState,
  map: GameMap,
  allUnits: Iterable<UnitState>,
): Offset[] {
  if (!actor.alive) return [];
  const stats = BALANCE.units[actor.unitClass];
  const standing = tileAt(map, { col: actor.col, row: actor.row });
  const highBonus = standing === TileType.HIGH_GROUND ? BALANCE.combat.high_ground_range_bonus : 0;
  const rngMax = stats.rng + highBonus;
  const rngMin = stats.min_rng;

  const occupied = new Set<string>();
  for (const u of allUnits) {
    if (u.alive && !(u.col === actor.col && u.row === actor.row)) {
      occupied.add(occupiedKey({ col: u.col, row: u.row }));
    }
  }

  const from: Offset = { col: actor.col, row: actor.row };
  const out: Offset[] = [];
  for (let row = 0; row < map.height; row += 1) {
    for (let col = 0; col < map.width; col += 1) {
      if (col === actor.col && row === actor.row) continue;
      const d = hexDistance(from, { col, row });
      if (d < rngMin || d > rngMax) continue;
      if (!hasLineOfSight(map, from, { col, row }, occupied)) continue;
      out.push({ col, row });
    }
  }
  return out;
}
