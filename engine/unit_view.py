"""Read-only view of a ``Unit`` exposed to agent code.

Attribute reads forward to the underlying live ``Unit`` (so HP, position,
and slot flags reflect current state). Attribute writes are blocked. The
``action`` property returns the phase's ``UnitAction`` proxy for friendly
units and ``None`` for enemy units.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from engine.unit import Unit

if TYPE_CHECKING:  # pragma: no cover
    from engine.unit_action import UnitAction


_FORWARDED = frozenset(
    {
        "unit_id",
        "team",
        "unit_class",
        "position",
        "hp",
        "max_hp",
        "atk",
        "defense",
        "mov",
        "rng",
        "min_rng",
        "heal_amount",
        "has_moved_this_phase",
        "has_acted_this_phase",
        "is_alive",
    }
)


class UnitView:
    __slots__ = ("_unit", "_action")

    def __init__(self, unit: Unit, action: "UnitAction | None"):
        object.__setattr__(self, "_unit", unit)
        object.__setattr__(self, "_action", action)

    def __getattr__(self, name: str):
        if name in _FORWARDED:
            return getattr(self._unit, name)
        raise AttributeError(name)

    def __setattr__(self, name, value):  # pragma: no cover - defensive
        raise AttributeError(f"UnitView is read-only (tried to set {name!r})")

    @property
    def action(self) -> "UnitAction | None":
        return self._action

    def __repr__(self) -> str:  # pragma: no cover
        u = self._unit
        return (
            f"UnitView(id={u.unit_id}, team={u.team}, class={u.unit_class}, "
            f"pos={u.position}, hp={u.hp}/{u.max_hp})"
        )

    def __eq__(self, other) -> bool:
        if isinstance(other, UnitView):
            return self._unit.unit_id == other._unit.unit_id
        if isinstance(other, Unit):
            return self._unit.unit_id == other.unit_id
        return NotImplemented

    def __hash__(self) -> int:
        return hash(("UnitView", self._unit.unit_id))
