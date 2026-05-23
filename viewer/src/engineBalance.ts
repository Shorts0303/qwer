/**
 * Read balance constants from engine/balance.json (the single source of truth).
 * Vite inlines the JSON at build time via resolveJsonModule.
 */

import balanceJson from '../../engine/balance.json';

import type { UnitClass } from './replay/types';

export interface UnitStats {
  readonly hp: number;
  readonly atk: number;
  readonly def: number;
  readonly mov: number;
  readonly rng: number;
  readonly min_rng: number;
  readonly heal_amount: number;
}

export interface CombatParams {
  readonly min_damage: number;
  readonly type_advantage_multiplier: number;
  readonly high_ground_attack_multiplier: number;
  readonly high_ground_range_bonus: number;
}

export interface BalanceData {
  readonly version: string;
  readonly units: Record<UnitClass, UnitStats>;
  readonly combat: CombatParams;
}

export const BALANCE = balanceJson as unknown as BalanceData;
