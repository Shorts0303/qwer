"""Top-level game engine: setup → round loop → victory decision."""

from __future__ import annotations

import json
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterator

from agents.base_agent import MaehwaAgent
from engine.game_map import GameMap
from engine.game_state import GameState
from engine.phase_context import PhaseContext
from engine.position import Position
from engine.replay import Replay, ReplayEvent
from engine.unit import Unit


# Pyodide / browser runtime cannot enforce wall-clock timeouts via threading
# because Python runs on the main thread and join(timeout) will block the full
# duration. Detect the environment and fall back to advisory elapsed-only
# measurement when ``enforce_timeout=True`` is requested there. Native CPython
# runs (CLI tournaments, CI) keep the threading implementation unchanged so the
# deterministic replay hash is preserved for local test matches.
_IS_BROWSER = sys.platform == "emscripten"


def _run_phase_with_timeout(
    fn: Callable[[], None],
    limit_sec: float,
) -> tuple[str, float, BaseException | None]:
    """Run ``fn`` with an advisory / enforced timeout.

    Returns ``(status, elapsed_sec, exception_or_None)`` where status is
    ``'ok' | 'timeout' | 'exception'``. In the browser the status is always
    ``'ok' | 'exception'`` because preemptive enforcement is not possible;
    elapsed time is still measured so tournament-grade tooling can flag slow
    phases after the fact.
    """
    start = time.monotonic()

    if _IS_BROWSER:
        try:
            fn()
            return "ok", time.monotonic() - start, None
        except BaseException as exc:  # noqa: BLE001 — boundary needs to capture all
            return "exception", time.monotonic() - start, exc

    captured: list[BaseException] = []

    def _target() -> None:
        try:
            fn()
        except BaseException as exc:  # noqa: BLE001
            captured.append(exc)

    t = threading.Thread(target=_target, daemon=True)
    t.start()
    t.join(limit_sec)
    elapsed = time.monotonic() - start
    if t.is_alive():
        return "timeout", elapsed, None
    if captured:
        return "exception", elapsed, captured[0]
    return "ok", elapsed, None


# Fixed unit order per team. Engine assigns sequential unit_ids A=0..4, B=5..9.
UNIT_ORDER: tuple[tuple[str, str], ...] = (
    ("dmr", "dmr"),
    ("rifle_1", "rifle"),
    ("shield", "shield"),
    ("rifle_2", "rifle"),
    ("medic", "medic"),
)


@dataclass
class GameResult:
    winner: str | None  # "A", "B", or None for draw
    reason: str         # gauge / gauge_tied_hp / annihilation / rounds_gauge / rounds_hp / draw / consecutive_timeout / exception
    round_number: int
    final_gauge: dict[str, int]  # 양 팀 독립 게이지 {"A": 0..100, "B": 0..100}
    replay: Replay


def _load_balance(path: str | Path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _spawn_team(team: str, base_id: int, balance: dict) -> list[Unit]:
    positions = balance["start_positions"][team]
    units: list[Unit] = []
    for idx, (slot_key, cls) in enumerate(UNIT_ORDER):
        col, row = positions[slot_key]
        stats = balance["units"][cls]
        u = Unit.from_class(base_id + idx, team, cls, Position(col, row), stats)
        units.append(u)
    return units


class GameEngine:
    def __init__(
        self,
        agent_a_cls: type[MaehwaAgent],
        agent_b_cls: type[MaehwaAgent],
        *,
        balance_path: str | Path = "engine/balance.json",
        map_path: str | Path | None = None,
        first_team: str = "A",
        enforce_timeout: bool = False,
        replay_meta: dict[str, Any] | None = None,
    ):
        self.balance = _load_balance(balance_path)
        map_path = map_path or self.balance["map"]["default_path"]
        self.game_map = GameMap.load(map_path)
        self.units: list[Unit] = _spawn_team("A", 0, self.balance) + _spawn_team("B", 5, self.balance)
        self.first_team = first_team
        self.enforce_timeout = enforce_timeout
        self.round_number = 1
        # 게이지 v2 (2026-05-05) — 양 팀 독립. 각자 0~100, 자기 거점 점거 시 누적.
        # 한쪽이 먼저 100 도달 → 즉시 승. 동시 100 도달 → HP 합 tiebreak.
        # (이전: 단일 시소 게이지 [-100, +100], A 기준 부호.)
        self.capture_gauge: dict[str, int] = {"A": 0, "B": 0}
        self.agent_a = agent_a_cls("A")
        self.agent_b = agent_b_cls("B")
        self._consec_timeout = {"A": 0, "B": 0}
        self._first_phase_done = {"A": False, "B": False}
        # Final outcome — populated by run_iter() once the match concludes so
        # both batch run() and streaming consumers can read it the same way.
        self.winner: str | None = None
        self.reason: str = "rounds"
        meta = {
            "balance_version": self.balance.get("version"),
            "first_team": first_team,
            "agents": {"A": agent_a_cls.__name__, "B": agent_b_cls.__name__},
        }
        if replay_meta:
            meta.update(replay_meta)
        self.replay = Replay(meta=meta)

    # ---------- helpers --------------------------------------------------

    def _team_alive(self, team: str) -> bool:
        return any(u.is_alive and u.team == team for u in self.units)

    def _hp_sum(self, team: str) -> int:
        return sum(u.hp for u in self.units if u.team == team and u.is_alive)

    def _reset_phase_flags(self, team: str) -> None:
        for u in self.units:
            if u.team == team:
                u.has_moved_this_phase = False
                u.has_acted_this_phase = False

    def _time_limit(self, team: str) -> float:
        rules = self.balance["rules"]
        if not self._first_phase_done[team]:
            return float(rules["first_phase_time_limit_sec"])
        return float(rules["phase_time_limit_sec"])

    # ---------- phase execution -----------------------------------------

    def _run_phase(self, team: str) -> str:
        """Run one team's phase. Returns status: 'ok', 'timeout', 'exception'."""
        self._reset_phase_flags(team)
        ctx = PhaseContext(
            game_map=self.game_map,
            balance=self.balance,
            round_number=self.round_number,
            phase_team=team,
            units=self.units,
            capture_gauge=self.capture_gauge,
        )
        gs = GameState(ctx)
        agent = self.agent_a if team == "A" else self.agent_b
        limit = self._time_limit(team)

        if self.enforce_timeout:
            status, elapsed, _exc = _run_phase_with_timeout(
                lambda: agent.execute_phase(gs),
                limit,
            )
        else:
            start = time.monotonic()
            try:
                agent.execute_phase(gs)
                status = "ok"
            except Exception:  # noqa: BLE001
                status = "exception"
            elapsed = time.monotonic() - start

        self._first_phase_done[team] = True
        self.replay.record(
            "phase",
            self.round_number,
            team,
            status=status,
            elapsed=round(elapsed, 4),
            units=[
                {
                    "id": u.unit_id,
                    "hp": u.hp,
                    "pos": [u.position.col, u.position.row],
                    "alive": u.is_alive,
                }
                for u in self.units
            ],
            actions=list(ctx.actions),
            gauge_a=self.capture_gauge["A"],
            gauge_b=self.capture_gauge["B"],
        )

        if status == "timeout":
            self._consec_timeout[team] += 1
        else:
            self._consec_timeout[team] = 0

        return status

    # ---------- round end ------------------------------------------------

    def _apply_gauge(self) -> None:
        caps = set(self.game_map.capture_point_positions)
        n_a = sum(1 for u in self.units if u.is_alive and u.team == "A" and u.position in caps)
        n_b = sum(1 for u in self.units if u.is_alive and u.team == "B" and u.position in caps)
        per_turn = self.balance["victory"]["gauge_per_turn"]
        threshold = self.balance["victory"]["gauge_win_threshold"]
        # 양 팀 독립 누적 — 자기 거점 점거 인원 × per_turn, 0~threshold 클램프.
        self.capture_gauge["A"] = min(threshold, self.capture_gauge["A"] + n_a * per_turn)
        self.capture_gauge["B"] = min(threshold, self.capture_gauge["B"] + n_b * per_turn)
        self.replay.record(
            "gauge",
            self.round_number,
            "-",
            n_a=n_a,
            n_b=n_b,
            delta_a=n_a * per_turn,
            delta_b=n_b * per_turn,
            gauge_a=self.capture_gauge["A"],
            gauge_b=self.capture_gauge["B"],
        )

    def _check_victory(self) -> tuple[str | None, str] | None:
        threshold = self.balance["victory"]["gauge_win_threshold"]
        a_reached = self.capture_gauge["A"] >= threshold
        b_reached = self.capture_gauge["B"] >= threshold
        if a_reached and not b_reached:
            return "A", "gauge"
        if b_reached and not a_reached:
            return "B", "gauge"
        if a_reached and b_reached:
            # 동시 100 도달 — HP 합 tiebreak
            hp_a, hp_b = self._hp_sum("A"), self._hp_sum("B")
            if hp_a > hp_b:
                return "A", "gauge_tied_hp"
            if hp_b > hp_a:
                return "B", "gauge_tied_hp"
            return None, "draw"
        if not self._team_alive("A"):
            return "B", "annihilation"
        if not self._team_alive("B"):
            return "A", "annihilation"
        return None

    # ---------- main loop ------------------------------------------------

    def run(self) -> GameResult:
        """Batch run — exhausts the streaming generator and returns the result.

        Equivalent to ``for _ in self.run_iter(): pass`` followed by building
        the GameResult. Kept as the canonical entry point for CLI / tests so
        downstream callers don't need to know about the generator form.
        """
        for _ in self.run_iter():
            pass
        return GameResult(
            winner=self.winner,
            reason=self.reason,
            round_number=self.round_number,
            final_gauge=dict(self.capture_gauge),  # {"A": int, "B": int}
            replay=self.replay,
        )

    def run_iter(self) -> Iterator[ReplayEvent]:
        """Generator form — yields each ReplayEvent the moment it's recorded.

        Used by the browser viewer's live broadcast mode to render frames as
        they happen instead of waiting for the whole match to finish. The
        recorded event sequence is identical to ``run()``, so the resulting
        replay hash is byte-equivalent (determinism guarantee preserved).
        """
        max_rounds = self.balance["victory"]["max_rounds"]
        timeout_limit = self.balance["rules"]["consecutive_timeout_limit"]

        # Setup event
        self.replay.record(
            "setup", 0, "-",
            units=[
                {
                    "id": u.unit_id,
                    "team": u.team,
                    "unit_class": u.unit_class,
                    "hp": u.hp,
                    "max_hp": u.max_hp,
                    "pos": [u.position.col, u.position.row],
                }
                for u in self.units
            ],
        )
        yield self.replay.events[-1]

        # on_game_start hooks (no replay events)
        try:
            ctx0 = PhaseContext(
                game_map=self.game_map,
                balance=self.balance,
                round_number=1,
                phase_team="A",
                units=self.units,
                capture_gauge={"A": 0, "B": 0},
            )
            gs0 = GameState(ctx0)
            self.agent_a.on_game_start(gs0)
            self.agent_b.on_game_start(gs0)
        except Exception:  # pragma: no cover
            pass

        # Snake order — alternates which team moves first each round so the
        # structural first-mover advantage cancels out within a single game.
        # Driven by the `rules.alternate_first_turn` flag in balance.json.
        base_order = [self.first_team, "B" if self.first_team == "A" else "A"]
        swap_order = [base_order[1], base_order[0]]
        alternate = bool(self.balance.get("rules", {}).get("alternate_first_turn", False))

        winner: str | None = None
        reason = "rounds"

        for round_no in range(1, max_rounds + 1):
            self.round_number = round_no
            order = (base_order if round_no % 2 == 1 else swap_order) if alternate else base_order
            for team in order:
                status = self._run_phase(team)
                yield self.replay.events[-1]  # phase event
                if status == "exception":
                    winner = "B" if team == "A" else "A"
                    reason = "exception"
                    break
                if self._consec_timeout[team] >= timeout_limit:
                    winner = "B" if team == "A" else "A"
                    reason = "consecutive_timeout"
                    break
                outcome = self._check_victory()
                if outcome is not None:
                    winner, reason = outcome
                    break
            if winner is not None:
                break
            self._apply_gauge()
            yield self.replay.events[-1]  # gauge event
            outcome = self._check_victory()
            if outcome is not None:
                winner, reason = outcome
                break

        if winner is None:
            # 30-round judgment — 양 팀 게이지 비교 → 동률이면 HP 합
            ga, gb = self.capture_gauge["A"], self.capture_gauge["B"]
            if ga > gb:
                winner, reason = "A", "rounds_gauge"
            elif gb > ga:
                winner, reason = "B", "rounds_gauge"
            else:
                hp_a = self._hp_sum("A")
                hp_b = self._hp_sum("B")
                if hp_a > hp_b:
                    winner, reason = "A", "rounds_hp"
                elif hp_b > hp_a:
                    winner, reason = "B", "rounds_hp"
                else:
                    winner, reason = None, "draw"

        self.winner = winner
        self.reason = reason
        self.replay.record(
            "end", self.round_number, "-",
            winner=winner, reason=reason,
            gauge_a=self.capture_gauge["A"], gauge_b=self.capture_gauge["B"],
        )
        yield self.replay.events[-1]
