"""Read-only ``GameState`` passed to agents each phase."""

from __future__ import annotations

from engine.phase_context import PhaseContext
from engine.position import Position
from engine.unit_action import UnitAction
from engine.unit_view import UnitView


def build_phase_views(ctx: PhaseContext) -> tuple[list[UnitView], list[UnitView]]:
    """Populate ``ctx.view_by_id`` and return (my_views, enemy_views).

    Called by the engine once per phase right before the agent runs.
    """
    my_views: list[UnitView] = []
    enemy_views: list[UnitView] = []
    ctx.view_by_id.clear()
    for unit in sorted(ctx.units, key=lambda u: u.unit_id):
        if unit.team == ctx.phase_team:
            view = UnitView(unit, UnitAction(unit, ctx))
            my_views.append(view)
        else:
            view = UnitView(unit, None)
            enemy_views.append(view)
        ctx.view_by_id[unit.unit_id] = view
    return my_views, enemy_views


class GameState:
    __slots__ = ("_ctx", "_my", "_enemy")

    def __init__(self, ctx: PhaseContext):
        my, enemy = build_phase_views(ctx)
        object.__setattr__(self, "_ctx", ctx)
        object.__setattr__(self, "_my", tuple(my))
        object.__setattr__(self, "_enemy", tuple(enemy))

    def __setattr__(self, name, value):  # pragma: no cover - defensive
        raise AttributeError(f"GameState is read-only (tried to set {name!r})")

    # ---- core properties -----------------------------------------------

    @property
    def round_number(self) -> int:
        return self._ctx.round_number

    @property
    def phase_team(self) -> str:
        return self._ctx.phase_team

    @property
    def is_first_round(self) -> bool:
        return self._ctx.is_first_round

    @property
    def my_units(self) -> tuple[UnitView, ...]:
        return self._my

    @property
    def enemy_units(self) -> tuple[UnitView, ...]:
        return self._enemy

    @property
    def all_units(self) -> tuple[UnitView, ...]:
        combined = list(self._my) + list(self._enemy)
        combined.sort(key=lambda v: v.unit_id)
        return tuple(combined)

    @property
    def map(self):
        return self._ctx.game_map

    @property
    def capture_gauge(self) -> dict[str, int]:
        """양 팀 게이지 dict — {"A": 0..100, "B": 0..100}.
        편의 접근은 my_gauge / enemy_gauge property 사용 권장."""
        return self._ctx.capture_gauge

    @property
    def my_gauge(self) -> int:
        """우리 팀의 점령 게이지 (0~100). 100 도달 시 즉시 승."""
        return self._ctx.capture_gauge[self._ctx.phase_team]

    @property
    def enemy_gauge(self) -> int:
        """상대 팀의 점령 게이지 (0~100). 100 도달 시 즉시 패."""
        other = "B" if self._ctx.phase_team == "A" else "A"
        return self._ctx.capture_gauge[other]

    # ---- queries --------------------------------------------------------

    def get_unit_by_id(self, unit_id: int) -> UnitView | None:
        return self._ctx.view_by_id.get(unit_id)

    def get_units_on_tile(self, pos: Position) -> list[UnitView]:
        return [v for v in self.all_units if v.is_alive and v.position == pos]

    def units_on_capture_points(self, team: str) -> list[UnitView]:
        caps = set(self._ctx.game_map.capture_point_positions)
        return [v for v in self.all_units if v.is_alive and v.team == team and v.position in caps]
