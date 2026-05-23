
"""ScorerAgent — Stable Formation AI

← 적 방향 기준

formation:

rifle
shield
medic
dmr

핵심 수정 사항

1. col 기반 제거
2. 실제 전선 방향 함수 도입
3. shield = rifle 뒤 고정
4. medic = shield 뒤 2칸 유지
5. medic 흔들림 제거
6. medic 과전진 금지
7. dmr 고지 우선 유지
"""

from __future__ import annotations

from agents.base_agent import MaehwaAgent
from engine.game_state import GameState
from engine.position import Position


# ─────────────────────────────────────────────
# 가중치
# ─────────────────────────────────────────────

W_CAPTURE_STAND = 30.0
W_CAPTURE_DIST = -1.6

W_DAMAGE_OUT = 12.0

W_DMR_STANDOFF = 2.5

HIGH_GROUND_BONUS = {
    "dmr": 14.0,
    "rifle": 4.0,
    "shield": 1.0,
    "medic": 0.5,
}

TYPE_MULT = {
    ("shield", "dmr"): 1.5,
    ("rifle", "shield"): 1.5,
    ("dmr", "rifle"): 1.5,
}

HIGH_ATK_MULT = 1.10
MIN_DAMAGE = 1


class ScorerAgent(MaehwaAgent):

    # ─────────────────────────────────────────
    # 메인 phase
    # ─────────────────────────────────────────

    def execute_phase(self, gs: GameState) -> None:

        # rifle
        for unit in gs.my_units:

            if (
                unit.is_alive
                and unit.unit_class == "rifle"
            ):
                self._handle_rifle(unit, gs)

        # shield
        for unit in gs.my_units:

            if (
                unit.is_alive
                and unit.unit_class == "shield"
            ):
                self._handle_shield(unit, gs)

        # medic
        for unit in gs.my_units:

            if (
                unit.is_alive
                and unit.unit_class == "medic"
            ):
                self._handle_medic(unit, gs)

        # dmr
        for unit in gs.my_units:

            if (
                unit.is_alive
                and unit.unit_class == "dmr"
            ):
                self._handle_dmr(unit, gs)

    # ─────────────────────────────────────────
    # 전선 방향 값
    # 값이 작을수록 적 방향
    # ─────────────────────────────────────────

    def _front_value(self, pos: Position):

        # 필요하면 row -> col 로 변경해서 테스트
        return -pos.row

    # ─────────────────────────────────────────
    # rifle
    # ─────────────────────────────────────────

    def _handle_rifle(self, rifle, gs: GameState) -> None:
        self._act_combat(rifle, gs)

    # ─────────────────────────────────────────
    # shield
    # ─────────────────────────────────────────

    def _handle_shield(self, shield, gs: GameState) -> None:

        rifles = [
            u for u in gs.my_units
            if (
                u.is_alive
                and u.unit_class == "rifle"
            )
        ]

        if not rifles:
            self._act_combat(shield, gs)
            return

        frontline = min(
            rifles,
            key=lambda r: min(
                gs.map.distance(
                    r.position,
                    cp,
                )
                for cp in gs.map.capture_point_positions
            )
        )

        enemies = [
            e for e in gs.enemy_units
            if e.is_alive
        ]

        reachable = list(
            shield.action.reachable_tiles()
        )

        if shield.position not in reachable:
            reachable.append(shield.position)

        candidates = []

        front_rifle = self._front_value(
            frontline.position
        )

        for tile in reachable:

            score = 0.0

            front_tile = self._front_value(
                tile
            )

            # ─────────────────────
            # rifle 뒤 1칸 유지
            # ─────────────────────

            desired_front = (
                front_rifle + 2
            )

            score -= (
                abs(front_tile - desired_front)
                * 18
            )

            # rifle 와 거리 유지
            dist_to_rifle = gs.map.distance(
                tile,
                frontline.position,
            )

            score -= dist_to_rifle * 5

            # rifle 보다 앞 금지
            if front_tile < front_rifle:
                score -= 60

            # 적 차단
            if enemies:

                nearest_enemy = min(
                    gs.map.distance(
                        tile,
                        e.position,
                    )
                    for e in enemies
                )

                if nearest_enemy <= 2:
                    score += 10

            # 약한 거점 선호
            score += (
                self._position_score(
                    shield,
                    tile,
                    gs,
                ) * 0.3
            )

            candidates.append(
                (
                    tile,
                    "wait",
                    -1,
                    score,
                )
            )

            # 공격
            for enemy in enemies:

                if not shield.action.can_attack_from(
                    tile,
                    enemy,
                ):
                    continue

                dmg = self._estimate_damage(
                    shield,
                    enemy,
                    tile,
                    gs,
                )

                candidates.append(
                    (
                        tile,
                        "attack",
                        enemy.unit_id,
                        score + dmg * 8,
                    )
                )

        if not candidates:
            return

        best = max(
            candidates,
            key=lambda c: (
                c[3],
                c[0] == shield.position,
            ),
        )

        tile, action, target_id, _ = best

        if tile != shield.position:
            shield.action.move_to(tile)

        if gs.is_first_round:
            return

        if action == "attack":

            target = gs.get_unit_by_id(
                target_id
            )

            if (
                target
                and shield.action.can_attack(
                    target
                )
            ):
                shield.action.attack(target)

    # ─────────────────────────────────────────
    # medic
    # ─────────────────────────────────────────

    def _handle_medic(self, medic, gs: GameState) -> None:

        shields = [
            u for u in gs.my_units
            if (
                u.is_alive
                and u.unit_class == "shield"
            )
        ]

        if not shields:
            return

        protector = shields[0]

        # ─────────────────────
        # 힐 우선
        # ─────────────────────

        wounded = [
            a for a in gs.my_units
            if (
                a.is_alive
                and a.hp < a.max_hp
                and a.unit_id != medic.unit_id
            )
        ]

        if wounded:

            target = min(
                wounded,
                key=lambda a: (
                    a.hp,
                    a.unit_id,
                ),
            )

            if (
                not gs.is_first_round
                and medic.action.can_heal(
                    target
                )
            ):
                medic.action.heal(target)
                return

        # ─────────────────────
        # shield 와 2칸 이내면 정지
        # ─────────────────────

        dist_to_shield = gs.map.distance(
            medic.position,
            protector.position,
        )

        if dist_to_shield <= 2:
            return

        reachable = list(
            medic.action.reachable_tiles()
        )

        if medic.position not in reachable:
            reachable.append(medic.position)

        enemies = [
            e for e in gs.enemy_units
            if e.is_alive
        ]

        front_shield = self._front_value(
            protector.position
        )

        def medic_score(tile):

            score = 0.0

            front_tile = self._front_value(
                tile
            )

            # ─────────────────
            # shield 뒤 2칸 목표
            # ─────────────────

            desired_front = (
                front_shield + 3
            )

            score -= (
                abs(front_tile - desired_front)
                * 20
            )

            # shield 와 거리 유지
            dist = gs.map.distance(
                tile,
                protector.position,
            )

            score -= abs(dist - 2) * 12

            # shield 보다 앞 금지
            if front_tile < front_shield:
                score -= 100

            # 적 접근 강력 회피
            if enemies:

                nearest_enemy = min(
                    gs.map.distance(
                        tile,
                        e.position,
                    )
                    for e in enemies
                )

                score += nearest_enemy * 3

                if nearest_enemy <= 3:
                    score -= 60

            return score

        best_tile = max(
            reachable,
            key=medic_score,
        )

        if best_tile != medic.position:
            medic.action.move_to(best_tile)

    # ─────────────────────────────────────────
    # dmr
    # ─────────────────────────────────────────

    def _handle_dmr(self, dmr, gs: GameState) -> None:
        self._act_combat(dmr, gs)

    # ─────────────────────────────────────────
    # 공통 전투 AI
    # ─────────────────────────────────────────

    def _act_combat(self, unit, gs: GameState) -> None:

        enemies = [
            e for e in gs.enemy_units
            if e.is_alive
        ]

        reachable = list(
            unit.action.reachable_tiles()
        )

        if unit.position not in reachable:
            reachable.append(unit.position)

        candidates = []

        for tile in reachable:

            base = self._position_score(
                unit,
                tile,
                gs,
            )

            candidates.append(
                (
                    tile,
                    "wait",
                    -1,
                    base,
                )
            )

            for enemy in enemies:

                if not unit.action.can_attack_from(
                    tile,
                    enemy,
                ):
                    continue

                dmg = self._estimate_damage(
                    unit,
                    enemy,
                    tile,
                    gs,
                )

                score = (
                    base
                    + W_DAMAGE_OUT * dmg
                )

                candidates.append(
                    (
                        tile,
                        "attack",
                        enemy.unit_id,
                        score,
                    )
                )

        if not candidates:
            return

        best = max(
            candidates,
            key=lambda c: (
                c[3],
                c[0] == unit.position,
                -c[0].col,
                -c[0].row,
                -c[2],
            ),
        )

        tile, action, target_id, _ = best

        if tile != unit.position:
            unit.action.move_to(tile)

        if gs.is_first_round:
            return

        if action == "attack":

            target = gs.get_unit_by_id(
                target_id
            )

            if (
                target
                and unit.action.can_attack(
                    target
                )
            ):
                unit.action.attack(target)

    # ─────────────────────────────────────────
    # 위치 점수
    # ─────────────────────────────────────────

    def _position_score(
        self,
        unit,
        tile: Position,
        gs: GameState,
    ) -> float:

        gm = gs.map

        score = 0.0

        caps = gm.capture_point_positions

        # 거점
        if tile in caps:
            score += W_CAPTURE_STAND

        score += (
            W_CAPTURE_DIST
            * min(
                gm.distance(tile, p)
                for p in caps
            )
        )

        # 고지
        if gm.is_high_ground(tile):

            score += HIGH_GROUND_BONUS.get(
                unit.unit_class,
                0,
            )

        # DMR 전용
        if unit.unit_class == "dmr":

            enemies = [
                e for e in gs.enemy_units
                if e.is_alive
            ]

            medics = [
                u for u in gs.my_units
                if (
                    u.is_alive
                    and u.unit_class == "medic"
                )
            ]

            # medic 근처 약하게 유지
            if medics:

                dist = min(
                    gm.distance(
                        tile,
                        m.position,
                    )
                    for m in medics
                )

                score -= dist * 0.8

            if enemies:

                nearest_enemy = min(
                    gm.distance(
                        tile,
                        e.position,
                    )
                    for e in enemies
                )

                # 거리 유지
                score += (
                    nearest_enemy
                    * W_DMR_STANDOFF
                )

                # 고지 시야 보너스
                if gm.is_high_ground(tile):

                    visible = sum(
                        1
                        for e in enemies
                        if unit.action.can_attack_from(
                            tile,
                            e,
                        )
                    )

                    score += visible * 3

        return score

    # ─────────────────────────────────────────
    # 데미지 계산
    # ─────────────────────────────────────────

    def _estimate_damage(
        self,
        attacker,
        defender,
        from_pos: Position,
        gs: GameState,
    ) -> int:

        type_mul = TYPE_MULT.get(
            (
                attacker.unit_class,
                defender.unit_class,
            ),
            1.0,
        )

        terrain = (
            HIGH_ATK_MULT
            if gs.map.is_high_ground(
                from_pos
            )
            else 1.0
        )

        base = (
            attacker.atk
            * type_mul
            * terrain
        )

        return max(
            MIN_DAMAGE,
            int(base) - defender.defense,
        )


AGENT_CLASS = ScorerAgent