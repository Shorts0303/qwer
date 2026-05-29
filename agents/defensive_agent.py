"""Defensive Agent — 고급 방어적 전략
전략 개요:
  - DMR: 후방 고지(high_ground) 선점, 장거리 저격
  - Rifle: 중간선 유지, shield 엄호 및 반격
  - Shield: 전방 거점(*) 진입 차단, 탱킹
  - Medic: 후방 대기, 체력 50% 이하 아군 우선 힐

우선순위:
  1. 메딕 힐 (아군 HP 50% 이하)
  2. 킬 가능 적 즉시 제거
  3. 타입 어드밴티지 공격
  4. 고지 점령 후 원거리 저격
  5. 거점 방어 포지셔닝
  6. 적 추적 이동
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from agents.base_agent import MaehwaAgent
from engine.game_state import GameState
from engine.position import Position
from engine.unit_view import UnitView

# 타입 어드밴티지 테이블 (balance.json 기준)
TYPE_ADVANTAGE: dict[str, str] = {
    "shield": "dmr",   # shield가 dmr에게 유리
    "rifle":  "shield",
    "dmr":    "rifle",
}


class DefensiveAgent(MaehwaAgent):
    """방어 중심 고급 에이전트."""

    # ------------------------------------------------------------------ helpers

    def _can_kill(self, actor: UnitView, target: UnitView, gs: GameState) -> bool:
        """공격 한 방으로 킬 가능 여부."""
        if not actor.action or not actor.action.can_attack(target):
            return False
        balance = gs._ctx.balance
        from engine.combat import compute_damage
        dmg = compute_damage(actor._unit, target._unit, gs.map, balance)
        return dmg >= target.hp

    def _compute_damage_preview(self, actor: UnitView, target: UnitView, gs: GameState) -> int:
        """예상 데미지 계산."""
        from engine.combat import compute_damage
        return compute_damage(actor._unit, target._unit, gs.map, gs._ctx.balance)

    def _has_type_advantage(self, actor: UnitView, target: UnitView) -> bool:
        return TYPE_ADVANTAGE.get(actor.unit_class) == target.unit_class

    def _best_attack_target(self, actor: UnitView, gs: GameState) -> UnitView | None:
        """우선순위: 킬샷 > 타입 유리 > 최저 HP."""
        if not actor.action:
            return None
        targets = actor.action.attack_targets()
        if not targets:
            return None

        kill_targets = [t for t in targets if self._can_kill(actor, t, gs)]
        if kill_targets:
            return min(kill_targets, key=lambda t: t.hp)

        adv_targets = [t for t in targets if self._has_type_advantage(actor, t)]
        if adv_targets:
            return min(adv_targets, key=lambda t: t.hp)

        return min(targets, key=lambda t: t.hp)

    def _nearest_capture_point(self, pos: Position, gs: GameState) -> Position | None:
        caps = gs.map.capture_point_positions
        if not caps:
            return None
        return min(caps, key=lambda c: gs.map.distance(pos, c))

    def _nearest_high_ground(self, pos: Position, gs: GameState) -> Position | None:
        """가장 가까운 고지 타일 반환."""
        best = None
        best_dist = 999
        for r in range(gs.map.height):
            for c in range(gs.map.width):
                p = Position(c, r)
                if gs.map.is_high_ground(p):
                    d = gs.map.distance(pos, p)
                    if d < best_dist:
                        best_dist = d
                        best = p
        return best

    def _is_on_high_ground(self, unit: UnitView, gs: GameState) -> bool:
        return gs.map.is_high_ground(unit.position)

    def _nearest_enemy(self, unit: UnitView, gs: GameState) -> UnitView | None:
        enemies = [e for e in gs.enemy_units if e.is_alive]
        if not enemies:
            return None
        return min(enemies, key=lambda e: gs.map.distance(unit.position, e.position))

    # ------------------------------------------------------------------ per-unit logic

    def _safe_position_near_ally(self, unit: UnitView, gs: GameState) -> Position | None:
        """아군 뒤쪽(적과 멀리) 이동 가능한 타일 반환.

        전략: 살아있는 아군의 무게중심을 구하고, 메딕은 그 무게중심보다
        적 방향에서 한 발 물러선 타일로 이동한다.
        고지 타일은 노출이 심하므로 명시적으로 패널티를 부여한다.
        """
        allies = [u for u in gs.my_units if u.is_alive and u.unit_id != unit.unit_id]
        enemies = [e for e in gs.enemy_units if e.is_alive]
        if not allies or not enemies:
            return None

        # 적 무게중심
        ec = (
            sum(e.position.col for e in enemies) / len(enemies),
            sum(e.position.row for e in enemies) / len(enemies),
        )

        reachable = act_reachable = unit.action.reachable_tiles() if unit.action else []
        if not reachable:
            return None

        def score(p: Position) -> float:
            # 적과 멀수록 좋음 (생존)
            d_enemy = ((p.col - ec[0]) ** 2 + (p.row - ec[1]) ** 2) ** 0.5
            # 아군 중 힐 사거리 내 인원 수 (커버리지)
            coverage = sum(
                1 for a in allies
                if gs.map.distance(p, a.position) <= unit.rng
            )
            # 고지 패널티: 노출 위험
            hg_penalty = 2.0 if gs.map.is_high_ground(p) else 0.0
            return d_enemy + coverage * 1.5 - hg_penalty

        return max(reachable, key=score)

    def _act_medic(self, unit: UnitView, gs: GameState) -> None:
        """메딕: 힐 최우선 → 안전한 후방 포지셔닝. 고지 이동 절대 금지."""
        act = unit.action
        if not act:
            return

        # 1. 현재 위치에서 힐 가능하면 즉시 힐
        heal_targets = act.heal_targets()
        if heal_targets:
            wounded = min(heal_targets, key=lambda t: t.hp / t.max_hp)
            if act.heal(wounded):
                return

        # 2. 이동: 부상 아군 있으면 접근, 없으면 안전 포지션으로
        if not unit.has_moved_this_phase:
            allies_wounded = [
                u for u in gs.my_units
                if u.is_alive and u.unit_id != unit.unit_id and u.hp / u.max_hp < 0.6
            ]
            if allies_wounded:
                closest = min(allies_wounded, key=lambda u: gs.map.distance(unit.position, u.position))
                act.move_toward(closest.position)
            else:
                safe = self._safe_position_near_ally(unit, gs)
                if safe and safe != unit.position:
                    act.move_to(safe)

        # 3. 이동 후 힐 재시도
        if not unit.has_acted_this_phase:
            heal_targets = act.heal_targets()
            if heal_targets:
                wounded = min(heal_targets, key=lambda t: t.hp / t.max_hp)
                act.heal(wounded)
                return

        # 4. 반격 (최후 수단, atk 낮음)
        if not unit.has_acted_this_phase:
            target = self._best_attack_target(unit, gs)
            if target:
                act.attack(target)

    def _act_dmr(self, unit: UnitView, gs: GameState) -> None:
        """DMR: 고지 선점 → 최장거리 저격. 이미 고지면 제자리."""
        act = unit.action
        if not act:
            return

        on_hg = self._is_on_high_ground(unit, gs)

        # 1. 고지 아니면 고지로 이동
        if not unit.has_moved_this_phase and not on_hg:
            hg = self._nearest_high_ground(unit.position, gs)
            if hg:
                act.move_toward(hg)

        # 2. 공격 (고지 이동 후 or 이미 고지)
        if not unit.has_acted_this_phase:
            target = self._best_attack_target(unit, gs)
            if target:
                act.attack(target)
                return

        # 3. 공격 전 이동으로 각도 확보 (시야 차단 우회)
        if not unit.has_moved_this_phase:
            enemies = [e for e in gs.enemy_units if e.is_alive]
            if enemies:
                act.move_toward(enemies[0].position)

    def _act_rifle(self, unit: UnitView, gs: GameState) -> None:
        """Rifle: 중간선 유지 — 공격 가능하면 즉시 타격, 아니면 거점 방향 전진."""
        act = unit.action
        if not act:
            return

        # 1. 현 위치에서 공격 가능하면 즉시
        if not unit.has_acted_this_phase:
            target = self._best_attack_target(unit, gs)
            if target:
                act.attack(target)
                return

        # 2. 이동 후 공격 기회 탐색
        if not unit.has_moved_this_phase:
            # 이동 가능 타일 중 공격 가능 타일 탐색
            reachable = act.reachable_tiles()
            best_move: Position | None = None
            best_score = -1

            for tile in reachable:
                if tile == unit.position:
                    continue
                # 해당 타일에서 공격 가능한 적 수 계산
                from engine.unit_action import UnitAction
                score = sum(
                    1 for e in gs.enemy_units
                    if e.is_alive and act.can_attack_from(tile, e)
                )
                # 고지 보너스
                if gs.map.is_high_ground(tile):
                    score += 0.5
                if score > best_score:
                    best_score = score
                    best_move = tile

            if best_move and best_score > 0:
                act.move_to(best_move)
            else:
                # 거점 방향으로 전진
                cap = self._nearest_capture_point(unit.position, gs)
                if cap:
                    act.move_toward(cap)

        # 3. 이동 후 재공격 시도
        if not unit.has_acted_this_phase:
            target = self._best_attack_target(unit, gs)
            if target:
                act.attack(target)

    def _act_shield(self, unit: UnitView, gs: GameState) -> None:
        """Shield: 거점 점령 + 전방 탱킹. 반격 우선."""
        act = unit.action
        if not act:
            return

        on_cap = gs.map.is_capture_point(unit.position)

        # 1. 사거리 내 공격 가능하면 즉시 타격
        if not unit.has_acted_this_phase:
            target = self._best_attack_target(unit, gs)
            if target:
                act.attack(target)
                return

        # 2. 이동
        if not unit.has_moved_this_phase:
            if not on_cap:
                # 거점으로 이동
                cap = self._nearest_capture_point(unit.position, gs)
                if cap:
                    act.move_toward(cap)
            else:
                # 거점 위에 있으면 인접 적 향해 이동 (근접 유도)
                nearest = self._nearest_enemy(unit, gs)
                if nearest and gs.map.distance(unit.position, nearest.position) <= 3:
                    act.move_toward(nearest.position)

        # 3. 이동 후 재공격
        if not unit.has_acted_this_phase:
            target = self._best_attack_target(unit, gs)
            if target:
                act.attack(target)

    # ------------------------------------------------------------------ main

    def execute_phase(self, gs: GameState) -> None:
        # 라운드 1: 공격 불가 → 포지셔닝만
        if gs.is_first_round:
            self._positioning_phase(gs)
            return

        # 유닛 역할별로 순서 지정: medic → dmr → rifle × 2 → shield
        role_order = ["medic", "dmr", "rifle", "shield"]
        units_by_role: dict[str, list[UnitView]] = {r: [] for r in role_order}
        for u in gs.my_units:
            if u.is_alive and u.unit_class in units_by_role:
                units_by_role[u.unit_class].append(u)

        for role in role_order:
            for unit in units_by_role[role]:
                if role == "medic":
                    self._act_medic(unit, gs)
                elif role == "dmr":
                    self._act_dmr(unit, gs)
                elif role == "rifle":
                    self._act_rifle(unit, gs)
                elif role == "shield":
                    self._act_shield(unit, gs)

    def _positioning_phase(self, gs: GameState) -> None:
        """1라운드: 공격 없이 초기 포지션 잡기."""
        for unit in gs.my_units:
            if not unit.is_alive or not unit.action:
                continue
            act = unit.action
            if unit.unit_class == "dmr":
                hg = self._nearest_high_ground(unit.position, gs)
                if hg:
                    act.move_toward(hg)
            elif unit.unit_class == "shield":
                cap = self._nearest_capture_point(unit.position, gs)
                if cap:
                    act.move_toward(cap)
            elif unit.unit_class == "rifle":
                cap = self._nearest_capture_point(unit.position, gs)
                if cap:
                    act.move_toward(cap)
            elif unit.unit_class == "medic":
                # 메딕은 고지 금지 — 아군 뒤쪽 안전 타일로
                safe = self._safe_position_near_ally(unit, gs)
                if safe and safe != unit.position:
                    act.move_to(safe)


AGENT_CLASS = DefensiveAgent
