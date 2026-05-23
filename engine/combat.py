"""Deterministic combat math (pure functions)."""

from __future__ import annotations

import math
from typing import Any

from engine.game_map import GameMap
from engine.position import Position
from engine.unit import Unit


def type_multiplier(attacker_class: str, target_class: str, table: list[dict[str, Any]]) -> float:
    for entry in table:
        if entry["attacker"] == attacker_class and entry["target"] == target_class:
            return float(entry["multiplier"])
    return 1.0


def high_ground_attack_multiplier(pos: Position, game_map: GameMap, combat_cfg: dict) -> float:
    if game_map.is_high_ground(pos):
        return float(combat_cfg["high_ground_attack_multiplier"])
    return 1.0


def effective_range(attacker: Unit, from_pos: Position, game_map: GameMap, combat_cfg: dict) -> int:
    bonus = combat_cfg["high_ground_range_bonus"] if game_map.is_high_ground(from_pos) else 0
    return attacker.rng + bonus


def compute_damage(
    attacker: Unit,
    defender: Unit,
    game_map: GameMap,
    balance: dict,
    from_pos: Position | None = None,
) -> int:
    pos = from_pos if from_pos is not None else attacker.position
    type_mul = type_multiplier(attacker.unit_class, defender.unit_class, balance["type_advantages"])
    terr_mul = high_ground_attack_multiplier(pos, game_map, balance["combat"])
    base = attacker.atk * type_mul * terr_mul
    raw = math.floor(base) - defender.defense
    return max(balance["combat"]["min_damage"], raw)
