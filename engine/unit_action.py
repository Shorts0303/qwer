"""Action proxy: the only way an agent mutates engine state.

Every method returns ``bool`` — ``True`` means the action was legal and the
underlying engine state was mutated; ``False`` means the request was
rejected (out of range, already acted, first-round restriction, ...) and
nothing changed.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from engine.combat import compute_damage, effective_range
from engine.position import Position
from engine.unit import Unit

if TYPE_CHECKING:  # pragma: no cover
    from engine.phase_context import PhaseContext
    from engine.unit_view import UnitView


def _resolve(target) -> Unit | None:
    if target is None:
        return None
    if isinstance(target, Unit):
        return target
    # UnitView — avoid hard import to dodge cycles
    inner = getattr(target, "_unit", None)
    return inner if isinstance(inner, Unit) else None


class UnitAction:
    __slots__ = ("_unit", "_ctx")

    def __init__(self, unit: Unit, ctx: "PhaseContext"):
        self._unit = unit
        self._ctx = ctx

    # ---------- helpers --------------------------------------------------

    def _blocked_set(self) -> set[Position]:
        return self._ctx.occupied_positions(exclude_ids=(self._unit.unit_id,))

    def _los_occupied(self, other_id: int) -> set[Position]:
        return self._ctx.occupied_positions(exclude_ids=(self._unit.unit_id, other_id))

    # ---------- movement -------------------------------------------------

    def can_move_to(self, target: Position) -> bool:
        u = self._unit
        if not u.is_alive or u.has_moved_this_phase:
            return False
        if not isinstance(target, Position):
            return False
        gm = self._ctx.game_map
        if not gm.is_valid_position(target) or not gm.is_walkable(target):
            return False
        if target == u.position:
            return True
        blocked = self._blocked_set()
        if target in blocked:
            return False
        reach = gm.bfs_reachable(u.position, u.mov, blocked=lambda p: p in blocked)
        return target in reach

    def move_to(self, target: Position) -> bool:
        if not self.can_move_to(target):
            return False
        frm = self._unit.position
        if target != frm:
            blocked = self._blocked_set()
            path = self._ctx.game_map.find_path(frm, target, blocked=lambda p: p in blocked) or []
            self._unit.position = target
        else:
            path = []
        self._unit.has_moved_this_phase = True
        self._ctx.record_move(self._unit.unit_id, frm, target, path)
        return True

    def move_along(self, path: list[Position]) -> bool:
        u = self._unit
        if not u.is_alive or u.has_moved_this_phase:
            return False
        if not path or len(path) > u.mov:
            return False
        gm = self._ctx.game_map
        blocked = self._blocked_set()
        cur = u.position
        for step in path:
            if not isinstance(step, Position):
                return False
            if not gm.is_valid_position(step) or not gm.is_walkable(step):
                return False
            if step in blocked:
                return False
            if gm.distance(cur, step) != 1:
                return False
            cur = step
        frm = u.position
        u.position = path[-1]
        u.has_moved_this_phase = True
        self._ctx.record_move(u.unit_id, frm, path[-1], list(path))
        return True

    def move_toward(self, target: Position) -> bool:
        u = self._unit
        if not u.is_alive or u.has_moved_this_phase:
            return False
        if not isinstance(target, Position):
            return False
        gm = self._ctx.game_map
        blocked = self._blocked_set()
        reach = gm.bfs_reachable(u.position, u.mov, blocked=lambda p: p in blocked)
        best = min(
            reach.keys(),
            key=lambda p: (gm.distance(p, target), reach[p], p.col, p.row),
        )
        if best == u.position:
            return False
        frm = u.position
        path = gm.find_path(frm, best, blocked=lambda p: p in blocked) or []
        u.position = best
        u.has_moved_this_phase = True
        self._ctx.record_move(u.unit_id, frm, best, path)
        return True

    def reachable_tiles(self) -> list[Position]:
        u = self._unit
        if not u.is_alive:
            return []
        gm = self._ctx.game_map
        blocked = self._blocked_set()
        reach = gm.bfs_reachable(u.position, u.mov, blocked=lambda p: p in blocked)
        return sorted(reach.keys(), key=lambda p: (p.col, p.row))

    # ---------- attack ---------------------------------------------------

    def can_attack(self, target) -> bool:
        return self.can_attack_from(self._unit.position, target)

    def can_attack_from(self, from_pos: Position, target) -> bool:
        u = self._unit
        if not u.is_alive or u.has_acted_this_phase:
            return False
        if self._ctx.is_first_round:
            return False
        if not isinstance(from_pos, Position):
            return False
        t = _resolve(target)
        if t is None or not t.is_alive or t.team == u.team or t.unit_id == u.unit_id:
            return False
        gm = self._ctx.game_map
        dist = gm.distance(from_pos, t.position)
        eff_max = effective_range(u, from_pos, gm, self._ctx.balance["combat"])
        if dist < u.min_rng or dist > eff_max:
            return False
        occ = self._los_occupied(t.unit_id)
        return gm.has_line_of_sight(from_pos, t.position, occupied=occ)

    def attack(self, target) -> bool:
        if not self.can_attack(target):
            return False
        t = _resolve(target)
        assert t is not None
        dmg = compute_damage(self._unit, t, self._ctx.game_map, self._ctx.balance)
        dealt = t.take_damage(dmg)
        self._unit.has_acted_this_phase = True
        self._ctx.record_attack(self._unit.unit_id, t.unit_id, dealt, t.hp)
        return True

    def attack_targets(self):
        results = []
        for enemy in self._ctx.enemy_alive_raw():
            if self.can_attack(enemy):
                view = self._ctx.view_by_id.get(enemy.unit_id, enemy)
                results.append(view)
        return results

    # ---------- heal -----------------------------------------------------

    def can_heal(self, target) -> bool:
        u = self._unit
        if u.unit_class != "medic":
            return False
        if not u.is_alive or u.has_acted_this_phase:
            return False
        if self._ctx.is_first_round:
            return False
        t = _resolve(target)
        if t is None or not t.is_alive:
            return False
        if t.team != u.team or t.unit_id == u.unit_id:
            return False
        gm = self._ctx.game_map
        dist = gm.distance(u.position, t.position)
        if dist < 1 or dist > u.rng:
            return False
        occ = self._los_occupied(t.unit_id)
        return gm.has_line_of_sight(u.position, t.position, occupied=occ)

    def heal(self, target) -> bool:
        if not self.can_heal(target):
            return False
        t = _resolve(target)
        assert t is not None
        healed = t.heal(self._unit.heal_amount)
        self._unit.has_acted_this_phase = True
        self._ctx.record_heal(self._unit.unit_id, t.unit_id, healed, t.hp)
        return True

    def heal_targets(self):
        if self._unit.unit_class != "medic":
            return []
        results = []
        for ally in self._ctx.my_alive_raw():
            if ally.unit_id == self._unit.unit_id:
                continue
            if self.can_heal(ally):
                view = self._ctx.view_by_id.get(ally.unit_id, ally)
                results.append(view)
        return results
