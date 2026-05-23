"""튜토리얼 전용 — 아무 행동도 하지 않는 상대 봇.

T4 (함수 단계) 에서 학생이 직접 작성한 헬퍼 함수의 효과를 확인할 수 있도록
완전 수동적인 상대를 제공한다. 자유 대전 드롭다운에는 노출되지 않으며 (engineSources.ts
의 OPPONENT_OPTIONS 에 없음) 튜토리얼 시나리오에서만 path 로 참조한다.
"""

from agents.base_agent import MaehwaAgent
from engine.game_state import GameState


class DummyPassive(MaehwaAgent):
    def execute_phase(self, game_state: GameState) -> None:
        # 의도적으로 비어 있음 — 학생이 자기 코드만으로 결과를 확인할 수 있게.
        return


AGENT_CLASS = DummyPassive
