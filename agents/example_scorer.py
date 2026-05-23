"""ScorerAgent — Lv 3 징검다리 봇.

simple/aggressive/defensive 의 1-ply 반응형 휴리스틱과 demo 의 풀 점수 함수
사이의 학습 다리. 학생이 "다요인 점수 함수 패러다임" 을 코드로 처음 접하기
좋은 형태로 단순화.

demo 와 차이 — feature 8개 → 4개:
  - 거점 위 (W_CAPTURE_STAND)
  - 거점 거리 페널티 (W_CAPTURE_DIST)
  - 적에게 줄 데미지 (W_DAMAGE_OUT)
  - 고지대 보너스 (W_HIGH_GROUND)

demo 가 가지고 있던 추가 항목들 (학생이 다음 단계에서 추가해갈 것):
  - 위협 회피 (W_THREAT_IN)
  - 막타 보너스 (W_KILL_BONUS)
  - DMR 거리 유지 보너스 (W_DMR_STANDOFF)
  - 의무병 부상자 근처 (W_MEDIC_NEAR_HURT)
  - focus-fire 시퀀스 인식 (hp_remaining mutating state)

학생 학습 흐름:
  Lv 1 simple 격파 → Lv 2 aggressive/defensive → **Lv 3 이 코드 베껴서
  자기 가중치로 시작 → Lv 4 항목 추가하며 demo 도전**.

이 봇 이름이 "scorer" 인 이유: 점수(score) 매겨서 결정한다는 핵심 컨셉을
학생이 한눈에 인지하도록.
"""

from __future__ import annotations

from agents.base_agent import MaehwaAgent
from engine.game_state import GameState
from engine.position import Position


# ─── 4개 feature 가중치 ───
W_CAPTURE_STAND = 30.0   # 거점 위에 서 있으면 +30 — 거점이 게임 핵심
W_CAPTURE_DIST  = -1.6   # 거점에서 헥스 거리 1당 -1.6 — 멀수록 손해
W_DAMAGE_OUT    = 12.0   # 적에게 줄 데미지 1당 +12 — demo(15) 보다 약함
W_HIGH_GROUND   = 4.0    # 고지대 위에 서 있으면 +4

# 룰북 §4.2 상성 (data 측) — balance.json type_advantages 와 동기화
TYPE_MULT = {
    ("shield", "dmr"):    1.5,
    ("rifle",  "shield"): 1.5,
    ("dmr",    "rifle"):  1.5,
}
HIGH_ATK_MULT = 1.10
MIN_DAMAGE = 1


class ScorerAgent(MaehwaAgent):
    """다요인 점수 함수 입문용 — feature 4개 단순 합산 + per-unit 단순 best."""

    def execute_phase(self, game_state: GameState) -> None:
        for unit in game_state.my_units:
            if not unit.is_alive:
                continue
            if unit.unit_class == "medic":
                self._handle_medic(unit, game_state)
                continue
            self._act_combat(unit, game_state)

    # ─── 일반 유닛 ───

    def _act_combat(self, unit, gs: GameState) -> None:
        enemies = [e for e in gs.enemy_units if e.is_alive]
        candidates: list[tuple[Position, str, int, float]] = []
        reachable = list(unit.action.reachable_tiles())
        if unit.position not in reachable:
            reachable.append(unit.position)
        for tile in reachable:
            base = self._position_score(tile, gs)
            # (1) 이동만
            candidates.append((tile, "wait", -1, base))
            # (2) 이동 후 공격
            for e in enemies:
                if not unit.action.can_attack_from(tile, e):
                    continue
                dmg = self._estimate_damage(unit, e, tile, gs)
                candidates.append((tile, "attack", e.unit_id, base + W_DAMAGE_OUT * dmg))
        if not candidates:
            return
        # 동률 시 stay 선호 → col/row 작은 곳 → target_id 작은 순
        best = max(
            candidates,
            key=lambda c: (c[3], c[0] == unit.position, -c[0].col, -c[0].row, -c[2]),
        )
        tile, action, target_id, _ = best
        if tile != unit.position:
            unit.action.move_to(tile)
        if gs.is_first_round:
            return
        if action == "attack":
            target = gs.get_unit_by_id(target_id)
            if target is not None and unit.action.can_attack(target):
                unit.action.attack(target)

    # ─── 의무병 ───

    def _handle_medic(self, medic, gs: GameState) -> None:
        # 가장 다친 ally 가 있으면 그쪽으로 이동 + 힐
        wounded = [
            a for a in gs.my_units
            if a.is_alive and a.hp < a.max_hp and a.unit_id != medic.unit_id
        ]
        if wounded:
            target = min(wounded, key=lambda a: (a.hp, a.unit_id))
            medic.action.move_toward(target.position)
            if not gs.is_first_round and medic.action.can_heal(target):
                medic.action.heal(target)
            return
        # 힐 대상 없으면 거점 가까이 — 의무병도 점수 함수 따라감
        reachable = list(medic.action.reachable_tiles())
        if medic.position not in reachable:
            reachable.append(medic.position)
        if not reachable:
            return
        best_tile = max(reachable, key=lambda t: self._position_score(t, gs))
        if best_tile != medic.position:
            medic.action.move_to(best_tile)

    # ─── 점수 함수 (4 feature) ───

    def _position_score(self, tile: Position, gs: GameState) -> float:
        gm = gs.map
        score = 0.0
        caps = gm.capture_point_positions
        if tile in caps:
            score += W_CAPTURE_STAND
        score += W_CAPTURE_DIST * min(gm.distance(tile, p) for p in caps)
        if gm.is_high_ground(tile):
            score += W_HIGH_GROUND
        return score

    def _estimate_damage(self, attacker, defender, from_pos: Position, gs: GameState) -> int:
        type_mul = TYPE_MULT.get((attacker.unit_class, defender.unit_class), 1.0)
        terrain = HIGH_ATK_MULT if gs.map.is_high_ground(from_pos) else 1.0
        base = attacker.atk * type_mul * terrain
        return max(MIN_DAMAGE, int(base) - defender.defense)


AGENT_CLASS = ScorerAgent
