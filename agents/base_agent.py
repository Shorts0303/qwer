"""Student-facing agent base class.

Students subclass :class:`MaehwaAgent` and override :meth:`execute_phase`. The
file must also define a module-level ``AGENT_CLASS`` variable pointing at the
subclass so the engine can instantiate it.
"""

from __future__ import annotations

from engine.game_state import GameState


class MaehwaAgent:
    def __init__(self, team: str):
        self.team = team

    def execute_phase(self, game_state: GameState) -> None:
        raise NotImplementedError("Override execute_phase() in your agent.")

    def on_game_start(self, game_state: GameState) -> None:  # pragma: no cover - hook
        pass

    def on_game_end(self, game_state: GameState, won: bool) -> None:  # pragma: no cover
        pass
