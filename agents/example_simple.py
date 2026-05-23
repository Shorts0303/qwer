"""SimpleAgent — closest enemy, weakest target, medic heals lowest ally."""

from agents.base_agent import MaehwaAgent
from engine.game_state import GameState


class SimpleAgent(MaehwaAgent):
    def execute_phase(self, game_state: GameState) -> None:
        for unit in game_state.my_units:
            if not unit.is_alive:
                continue
            if unit.unit_class == "medic":
                self._handle_medic(unit, game_state)
            else:
                self._handle_combat(unit, game_state)

    def _handle_combat(self, unit, game_state):
        enemies = [e for e in game_state.enemy_units if e.is_alive]
        if not enemies:
            return
        closest = min(
            enemies,
            key=lambda e: (game_state.map.distance(unit.position, e.position), e.unit_id),
        )
        unit.action.move_toward(closest.position)
        targets = unit.action.attack_targets()
        if targets:
            weakest = min(targets, key=lambda e: (e.hp, e.unit_id))
            unit.action.attack(weakest)

    def _handle_medic(self, medic, game_state):
        wounded = [
            u
            for u in game_state.my_units
            if u.is_alive and u.unit_id != medic.unit_id and u.hp < u.max_hp
        ]
        if wounded:
            target = min(wounded, key=lambda u: (u.hp / u.max_hp, u.unit_id))
            medic.action.move_toward(target.position)
            if medic.action.can_heal(target):
                medic.action.heal(target)
            return
        # 힐할 아군이 없으면 거점으로 이동하며 사정거리 내 적은 사격
        center = game_state.map.capture_point_positions[1]
        medic.action.move_toward(center)
        targets = medic.action.attack_targets()
        if targets:
            weakest = min(targets, key=lambda e: (e.hp, e.unit_id))
            medic.action.attack(weakest)


AGENT_CLASS = SimpleAgent
