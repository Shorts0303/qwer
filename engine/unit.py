"""Internal mutable Unit state. Engine-only; agents see ``UnitView`` instead."""

from __future__ import annotations

from dataclasses import dataclass

from engine.position import Position


UNIT_CLASSES: tuple[str, ...] = ("shield", "rifle", "dmr", "medic")


@dataclass
class Unit:
    unit_id: int
    team: str
    unit_class: str
    position: Position
    hp: int
    max_hp: int
    atk: int
    defense: int
    mov: int
    rng: int
    min_rng: int
    heal_amount: int = 0
    has_moved_this_phase: bool = False
    has_acted_this_phase: bool = False

    @property
    def is_alive(self) -> bool:
        return self.hp > 0

    @classmethod
    def from_class(
        cls,
        unit_id: int,
        team: str,
        unit_class: str,
        position: Position,
        stats: dict,
    ) -> "Unit":
        if unit_class not in UNIT_CLASSES:
            raise ValueError(f"unknown unit class: {unit_class}")
        return cls(
            unit_id=unit_id,
            team=team,
            unit_class=unit_class,
            position=position,
            hp=stats["hp"],
            max_hp=stats["hp"],
            atk=stats["atk"],
            defense=stats["def"],
            mov=stats["mov"],
            rng=stats["rng"],
            min_rng=stats["min_rng"],
            heal_amount=stats.get("heal_amount", 0),
        )

    def reset_phase_flags(self) -> None:
        self.has_moved_this_phase = False
        self.has_acted_this_phase = False

    def take_damage(self, amount: int) -> int:
        dealt = max(0, amount)
        self.hp = max(0, self.hp - dealt)
        return dealt

    def heal(self, amount: int) -> int:
        if not self.is_alive:
            return 0
        before = self.hp
        self.hp = min(self.max_hp, self.hp + max(0, amount))
        return self.hp - before
