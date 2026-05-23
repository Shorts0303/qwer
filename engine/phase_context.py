"""Shared per-phase context bundling map / balance / round info / unit views.

A new ``PhaseContext`` is built by the engine at the start of every phase.
All ``UnitAction`` proxies for that phase reference the same context, so
state visible to the acting agent (position/HP/etc.) is always live.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from engine.game_map import GameMap
from engine.position import Position
from engine.unit import Unit

if TYPE_CHECKING:  # pragma: no cover - typing only
    from engine.unit_view import UnitView


@dataclass
class PhaseContext:
    game_map: GameMap
    balance: dict
    round_number: int
    phase_team: str
    units: list[Unit]
    # 게이지 v2 — 양 팀 독립 누적. {"A": 0..100, "B": 0..100}.
    capture_gauge: dict[str, int] = field(default_factory=lambda: {"A": 0, "B": 0})
    view_by_id: dict[int, "UnitView"] = field(default_factory=dict)
    # Per-phase action log used by the viewer to replay each move/attack/heal
    # one step at a time (per-tile animation, attack telegraph, etc.). Not read
    # by the engine itself — strictly a sidecar for downstream renderers.
    actions: list[dict[str, Any]] = field(default_factory=list)

    @property
    def is_first_round(self) -> bool:
        return self.round_number == 1

    def alive_units(self) -> list[Unit]:
        return [u for u in self.units if u.is_alive]

    def my_alive_raw(self) -> list[Unit]:
        return [u for u in self.units if u.is_alive and u.team == self.phase_team]

    def enemy_alive_raw(self) -> list[Unit]:
        return [u for u in self.units if u.is_alive and u.team != self.phase_team]

    def occupied_positions(self, exclude_ids: tuple[int, ...] = ()) -> set:
        excl = set(exclude_ids)
        return {u.position for u in self.units if u.is_alive and u.unit_id not in excl}

    # ---------- action log (viewer-facing sidecar) -----------------------

    def record_move(
        self,
        unit_id: int,
        frm: Position,
        to: Position,
        path: list[Position],
    ) -> None:
        self.actions.append({
            "kind": "move",
            "unit_id": unit_id,
            "from": [frm.col, frm.row],
            "to": [to.col, to.row],
            "path": [[p.col, p.row] for p in path],
        })

    def record_attack(
        self,
        unit_id: int,
        target_id: int,
        damage: int,
        target_hp_after: int,
    ) -> None:
        self.actions.append({
            "kind": "attack",
            "unit_id": unit_id,
            "target_id": target_id,
            "damage": damage,
            "target_hp_after": target_hp_after,
        })

    def record_heal(
        self,
        unit_id: int,
        target_id: int,
        amount: int,
        target_hp_after: int,
    ) -> None:
        self.actions.append({
            "kind": "heal",
            "unit_id": unit_id,
            "target_id": target_id,
            "amount": amount,
            "target_hp_after": target_hp_after,
        })
