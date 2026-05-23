"""AggressiveAgent — rush the capture point, attack anything in range."""

from agents.base_agent import MaehwaAgent
from engine.game_state import GameState


class AggressiveAgent(MaehwaAgent):
    def execute_phase(self, game_state: GameState) -> None:
        center = game_state.map.capture_point_positions[1]
        # shield first, then rifles, then dmr, medic last
        order = {"shield": 0, "rifle": 1, "dmr": 2, "medic": 3}
        units = sorted(
            (u for u in game_state.my_units if u.is_alive),
            key=lambda u: (order[u.unit_class], u.unit_id),
        )
        for unit in units:
            if unit.unit_class == "medic":
                self._handle_medic(unit, game_state, center)
                continue
            unit.action.move_toward(center)
            targets = unit.action.attack_targets()
            if targets:
                weakest = min(targets, key=lambda e: (e.hp, e.unit_id))
                unit.action.attack(weakest)

    def _handle_medic(self, medic, game_state, center):
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
        # 힐 대상이 없으면 거점으로 진격하며 사거리 내 적 사격
        medic.action.move_toward(center)
        targets = medic.action.attack_targets()
        if targets:
            weakest = min(targets, key=lambda e: (e.hp, e.unit_id))
            medic.action.attack(weakest)


AGENT_CLASS = AggressiveAgent
