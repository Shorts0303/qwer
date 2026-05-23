"""DefensiveAgent — hold near spawn, grab nearest high ground, shoot intruders."""

from agents.base_agent import MaehwaAgent
from engine.game_state import GameState
from engine.position import Position


HIGH_GROUNDS = [Position(2, 1), Position(2, 5), Position(9, 1), Position(9, 5)]


class DefensiveAgent(MaehwaAgent):
    def execute_phase(self, game_state: GameState) -> None:
        for unit in game_state.my_units:
            if not unit.is_alive:
                continue
            if unit.unit_class == "medic":
                self._handle_medic(unit, game_state)
                continue
            targets = unit.action.attack_targets()
            if targets:
                weakest = min(targets, key=lambda e: (e.hp, e.unit_id))
                unit.action.attack(weakest)
                continue
            anchor = self._anchor_for(unit, game_state)
            if unit.position != anchor:
                unit.action.move_toward(anchor)

    def _anchor_for(self, unit, game_state):
        # Pick the nearest friendly high-ground that isn't already occupied by an ally.
        occupied = {u.position for u in game_state.my_units if u.is_alive and u.unit_id != unit.unit_id}
        candidates = [hg for hg in HIGH_GROUNDS if hg not in occupied]
        if not candidates:
            return unit.position
        return min(candidates, key=lambda p: game_state.map.distance(unit.position, p))

    def _handle_medic(self, medic, game_state):
        wounded = [
            u
            for u in game_state.my_units
            if u.is_alive and u.unit_id != medic.unit_id and u.hp < u.max_hp
        ]
        if wounded:
            target = min(wounded, key=lambda u: (u.hp, u.unit_id))
            medic.action.move_toward(target.position)
            if medic.action.can_heal(target):
                medic.action.heal(target)
            return
        # 힐 대상이 없으면 사거리 내 적 사격으로 화력 보탬
        targets = medic.action.attack_targets()
        if targets:
            weakest = min(targets, key=lambda e: (e.hp, e.unit_id))
            medic.action.attack(weakest)


AGENT_CLASS = DefensiveAgent
