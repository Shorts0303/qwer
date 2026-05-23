# 메이드 인 매화: 택티컬 아레나 — 에이전트 API 스펙

> **문서 버전**: v0.3
> **작성일**: 2026년 5월
> **대상**: 엔진 구현자 / 학생 배포용 레퍼런스
> **전제**: `02_게임_룰북.md` v0.4를 읽고 왔다고 가정

---

## 1. 개요

이 문서는 학생이 작성할 AI 에이전트가 게임 엔진과 상호작용하는 **파이썬 API**를 정의한다. 학생은 이 API만 사용해서 `MaehwaAgent`를 구현하며, 엔진 내부 구조에 직접 접근할 수 없다.

### 1.1. 설계 원칙

- **읽기 전용 스냅샷**: 에이전트에 전달되는 모든 객체는 읽기 전용이다. 직접 수정 시 실격.
- **명시적 메서드 호출**: 유닛의 행동은 메서드 호출로 수행하며, 호출하지 않은 행동은 "안 함"이 기본값이다.
- **실패는 조용히**: 불법 행동은 메서드가 `False` 또는 예외로 반환되며, 엔진 상태는 변경되지 않는다. 학생은 반환값을 확인해야 한다.
- **타입 힌트 제공**: 모든 API 함수는 파이썬 타입 힌트를 가진다. IDE 자동완성이 작동하도록 설계.

### 1.2. 학생이 알아야 할 핵심 객체

| 객체 | 의미 | 수정 가능? |
|---|---|---|
| `MaehwaAgent` | 학생이 상속해서 구현하는 베이스 클래스 | 서브클래스 작성 시만 |
| `GameState` | 현재 게임 상태의 스냅샷 | ❌ 읽기 전용 |
| `Unit` | 유닛 정보 (위치, 체력, 스탯) | ❌ 읽기 전용 |
| `GameMap` | 전장 정보 (타일, 거리, 시야 계산) | ❌ 읽기 전용 |
| `Position` | 오프셋 좌표 `(col, row)` | ❌ 불변 |
| `UnitAction` | 유닛에게 행동을 지시하는 프록시 객체 | ✅ 메서드 호출용 |

---

## 2. 파일 구조 및 배포

### 2.1. 학생 배포 패키지 구조

학생에게는 다음 구조의 프로젝트가 배포된다:

```
maehwa_tactical_arena/
├── engine/                      # 블랙박스. 학생이 수정 금지
│   ├── __init__.py
│   ├── game_engine.py           # 메인 게임 루프
│   ├── game_state.py            # 읽기 전용 상태 클래스
│   ├── game_map.py              # 헥스 맵 구현
│   ├── unit.py                  # Unit 클래스
│   ├── combat.py                # 전투 공식
│   └── balance.json             # 밸런스 데이터
├── agents/                      # 베이스라인 에이전트 (읽기 전용)
│   ├── base_agent.py            # MaehwaAgent 베이스 클래스
│   ├── example_simple.py        # 베이스라인 예시 (단순 휴리스틱)
│   ├── example_aggressive.py    # 베이스라인 예시 (공격형)
│   ├── example_defensive.py     # 베이스라인 예시 (수비형)
│   └── example_demo.py          # DemoAgent — 다요인 점수 그리디 (시연·교보재용)
├── agent.py                     # 학생이 작성하는 파일 ⬅️ (레포 루트)
├── viewer/                      # 웹 뷰어 (PixiJS) — 리플레이 시각화·Pyodide 대전
├── replays/                     # 경기 리플레이 JSON 저장 폴더
├── run_match.py                 # 두 에이전트 대결 실행 (CLI)
├── check_agent.py               # 에이전트 문법 검사
└── requirements.txt             # 파이썬 표준 라이브러리만 사용 (의존성 없음)
```

### 2.2. 학생이 수정하는 파일

학생은 **레포 루트의 `agent.py` 한 파일만** 수정한다. 다른 파일은 읽기 전용이며, 수정하면 토너먼트 제출 시 원본으로 복원된다.

### 2.3. 경기 실행 명령

```bash
# 두 에이전트 대결 실행 (CLI, 결과 + replay 해시 출력)
python3 run_match.py agent.py agents/example_simple.py

# 옵션
python3 run_match.py A.py B.py --replay out.json       # 리플레이 JSON 저장
python3 run_match.py A.py B.py --first-team B          # 후공 강제
python3 run_match.py A.py B.py --enforce-timeout       # 페이즈 timeout 실제 강제 (CI/토너먼트용)
```

> **렌더링은 웹 뷰어가 담당** — `viewer/` 의 PixiJS 뷰어가 리플레이 JSON 을 로드해 시각화한다 (단일 매치·라이브 중계·토너먼트 모드). CLI 자체는 결과/해시만 출력. `--no-render`/`--speed` 같은 옛 pygame 옵션은 더 이상 없다.

---

## 3. `MaehwaAgent` 베이스 클래스

학생이 상속해서 구현할 베이스 클래스. `agents/base_agent.py`에 정의되어 있다.

```python
from engine.game_state import GameState

class MaehwaAgent:
    """
    학생이 상속해서 작성하는 에이전트 베이스 클래스.
    반드시 execute_phase() 메서드를 오버라이드해야 한다.
    """
    
    def __init__(self, team: str):
        """
        Args:
            team: "A" 또는 "B" 중 하나. 자기 팀 식별자.
        """
        self.team = team
        # 학생이 필요한 인스턴스 변수를 여기서 초기화 가능
        # 예: self.turn_count = 0
        #     self.memory = {}
    
    def execute_phase(self, game_state: GameState) -> None:
        """
        매 페이즈 시작 시 엔진이 호출하는 메인 함수.
        학생은 이 함수 내에서 자기 팀 유닛들의 슬롯을 사용해야 한다.
        
        Args:
            game_state: 현재 게임 상태 스냅샷 (읽기 전용)
        
        Returns:
            None. 반환값은 무시됨. 유닛 슬롯 사용은 
            game_state.my_units의 각 유닛의 action 프록시를 통해 수행.
        
        제한:
            - 페이즈당 10초 (첫 페이즈 15초)
            - 연속 3회 시간 초과 시 실격
            - game_state 및 그 하위 객체 직접 수정 금지 (실격)
        """
        raise NotImplementedError("서브클래스에서 구현하세요")
    
    def on_game_start(self, game_state: GameState) -> None:
        """
        게임 시작 시 1회 호출. 선택적 구현.
        무거운 초기화 작업이 있다면 여기서 수행.
        """
        pass
    
    def on_game_end(self, game_state: GameState, won: bool) -> None:
        """
        게임 종료 시 1회 호출. 선택적 구현.
        로깅이나 학습용 데이터 저장에 사용 가능.
        """
        pass
```

### 3.1. 학생 에이전트 작성 최소 예시

```python
# agent.py  (레포 루트의 학생 작성 파일)
from agents.base_agent import MaehwaAgent
from engine.game_state import GameState

class MyAgent(MaehwaAgent):
    def execute_phase(self, game_state: GameState) -> None:
        for unit in game_state.my_units:
            if unit.is_alive:
                # 가장 가까운 적으로 이동
                closest = self.find_closest_enemy(unit, game_state)
                if closest:
                    unit.action.move_toward(closest.position)
                    if unit.action.can_attack(closest):
                        unit.action.attack(closest)
    
    def find_closest_enemy(self, unit, game_state):
        enemies = [e for e in game_state.enemy_units if e.is_alive]
        if not enemies:
            return None
        return min(enemies, key=lambda e: game_state.map.distance(unit.position, e.position))

# 엔진이 이 변수명을 찾아 인스턴스화함
AGENT_CLASS = MyAgent
```

### 3.2. 필수 규약

학생 파일은 반드시 다음을 만족해야 한다:
- `MaehwaAgent`를 상속한 클래스를 정의할 것
- 파일 끝에 `AGENT_CLASS = <클래스명>` 변수를 선언할 것
- `execute_phase()`를 오버라이드할 것

이 규약을 어기면 에이전트 로드가 실패하여 실격 처리된다.

---

## 4. `GameState` 클래스

매 페이즈 시작 시 에이전트에 전달되는 게임 상태 스냅샷. **읽기 전용**.

```python
class GameState:
    # 속성 (모두 읽기 전용)
    
    round_number: int           # 현재 라운드 번호 (1부터 시작)
    phase_team: str             # 현재 행동 중인 팀 ("A" 또는 "B")
    is_first_round: bool        # 1라운드 공격 금지 여부 확인용
    
    my_units: list[Unit]        # 자기 팀 유닛 리스트 (죽은 유닛 포함)
    enemy_units: list[Unit]     # 상대 팀 유닛 리스트 (죽은 유닛 포함)
    all_units: list[Unit]       # 모든 유닛 (양 팀)
    
    map: GameMap                # 게임 맵 객체
    
    # 점령 게이지 v2 — 양 팀 독립 (각 0~100, 자기 거점 점거로만 누적)
    my_gauge: int               # 우리 팀 점령 게이지 (0 ~ 100). 100 도달 시 즉시 승.
    enemy_gauge: int            # 상대 팀 점령 게이지 (0 ~ 100). 100 도달 시 즉시 패.
    capture_gauge: dict         # {"A": int, "B": int}. 직접 접근용 (my_gauge 권장).
    
    # 유틸리티 메서드
    
    def get_unit_by_id(self, unit_id: int) -> Unit | None:
        """ID로 유닛 조회. 없으면 None."""
    
    def get_units_on_tile(self, pos: Position) -> list[Unit]:
        """해당 타일 위의 유닛 리스트 (보통 0~1개)."""
    
    def units_on_capture_points(self, team: str) -> list[Unit]:
        """특정 팀의 거점 위 유닛 리스트."""
```

### 4.1. 주의사항

- `my_units`와 `enemy_units`는 **죽은 유닛도 포함**한다. 살아있는 유닛만 원하면 `unit.is_alive`로 필터링.
- `all_units`는 `my_units + enemy_units`와 동일하지만 순서는 ID 기준.
- 이 객체의 속성에 직접 쓰기 시도(예: `game_state.capture_gauge["A"] = 100`)는 **실격**.

---

## 5. `Unit` 클래스

개별 유닛 정보. **읽기 전용 속성** + **`action` 프록시**로 구성.

```python
class Unit:
    # 식별 정보
    unit_id: int                # 고유 ID (0~9, A팀 0~4, B팀 5~9)
    team: str                   # "A" 또는 "B"
    unit_class: str             # "shield" | "rifle" | "dmr" | "medic"
    
    # 위치
    position: Position          # 현재 (col, row)
    
    # 상태
    hp: int                     # 현재 체력
    max_hp: int                 # 최대 체력
    is_alive: bool              # hp > 0
    
    # 스탯 (balance.json에서 로드된 값)
    atk: int
    defense: int                # 'def'는 파이썬 예약어라 'defense' 사용
    mov: int
    rng: int
    min_rng: int
    heal_amount: int            # 의무병만. 다른 유닛은 0
    
    # 슬롯 사용 상태
    has_moved_this_phase: bool
    has_acted_this_phase: bool
    
    # 행동 프록시 (자기 팀 유닛에만 유효)
    action: UnitAction          # 상대 팀 유닛에는 None
```

### 5.1. 속성 접근 예시

```python
for unit in game_state.my_units:
    if not unit.is_alive:
        continue
    
    print(f"{unit.unit_class} at {unit.position}, HP {unit.hp}/{unit.max_hp}")
    
    if unit.unit_class == "medic":
        # 의무병 특수 처리
        pass
```

### 5.2. `action` 프록시의 의미

`unit.action`은 **자기 팀 유닛에만 존재**하며, 상대 유닛의 `action`은 `None`이다. 이는 학생이 실수로 상대 유닛을 조작하지 못하게 막는 안전장치.

```python
my_rifle = game_state.my_units[0]
my_rifle.action.move_to(Position(3, 2))  # ✓ OK

enemy = game_state.enemy_units[0]
enemy.action.move_to(Position(5, 5))     # ✗ AttributeError (action is None)
```

---

## 6. `UnitAction` 프록시

자기 팀 유닛의 슬롯을 사용하는 메서드 모음. `unit.action`으로 접근.

### 6.1. 이동 슬롯 메서드

```python
class UnitAction:
    def move_to(self, target: Position) -> bool:
        """
        목적지까지 최단 경로로 이동. 엔진이 경로 자동 계산.
        
        Returns:
            True: 이동 성공 (엔진 상태 변경됨)
            False: 실패 (거리 초과, 목적지 도달 불가, 이미 이동함 등)
        """
    
    def move_along(self, path: list[Position]) -> bool:
        """
        지정된 경로를 따라 이동. 경로의 각 타일이 유효해야 함.
        path는 현재 위치를 포함하지 않고, 이동할 타일만 순서대로 나열.
        
        Args:
            path: 이동할 타일 순서 리스트. len(path) <= mov.
        
        Returns:
            True: 이동 성공
            False: 실패 (경로상 장애물, 거리 초과 등)
        """
    
    def move_toward(self, target: Position) -> bool:
        """
        대상 방향으로 mov 거리만큼 접근 (최대 접근).
        target까지 도달 불가능해도 가능한 만큼 접근한다.
        
        Returns:
            True: 최소 1칸이라도 접근했으면 True
            False: 한 칸도 못 움직이면 False
        """
```

### 6.2. 행동 슬롯 메서드

```python
class UnitAction:
    def attack(self, target: Unit) -> bool:
        """
        대상 적 유닛 공격.
        
        Returns:
            True: 공격 성공 (데미지 적용됨)
            False: 실패 (사거리 밖, 시야 차단, 1라운드, 이미 행동함 등)
        """
    
    def heal(self, target: Unit) -> bool:
        """
        아군 유닛 치유. 의무병만 사용 가능.
        
        Returns:
            True: 치유 성공 (HP 회복됨)
            False: 실패 (의무병 아님, 사거리 밖, 시야 차단, 
                         자기 자신, 죽은 유닛, 1라운드 등)
        """
```

### 6.3. 질의 메서드 (상태를 바꾸지 않음)

실제로 행동하기 전에 "이 행동이 가능한가?"를 확인할 수 있는 메서드들. 모두 부작용 없음.

```python
class UnitAction:
    def can_move_to(self, target: Position) -> bool:
        """해당 위치로 이번 페이즈에 이동 가능한지 판정."""
    
    def can_attack(self, target: Unit) -> bool:
        """해당 적을 이번 페이즈에 공격 가능한지 판정 (현재 위치 기준)."""
    
    def can_attack_from(self, from_pos: Position, target: Unit) -> bool:
        """특정 위치에서 해당 적을 공격 가능한지 판정. 
        '이동 후 공격' 조합을 미리 평가할 때 사용."""
    
    def can_heal(self, target: Unit) -> bool:
        """해당 아군을 치유 가능한지 판정."""
    
    def reachable_tiles(self) -> list[Position]:
        """이번 페이즈에 도달 가능한 모든 타일 리스트."""
    
    def attack_targets(self) -> list[Unit]:
        """현재 위치에서 공격 가능한 적 리스트."""
    
    def heal_targets(self) -> list[Unit]:
        """현재 위치에서 치유 가능한 아군 리스트 (의무병만 유효)."""
```

### 6.4. 슬롯 재사용 방지

각 유닛은 페이즈당 이동 슬롯 1회, 행동 슬롯 1회만 사용 가능하다. 두 번째 호출은 `False` 반환.

```python
unit.action.move_to(Position(3, 2))   # True
unit.action.move_to(Position(4, 2))   # False (이미 이동함)

unit.action.attack(enemy1)            # True
unit.action.attack(enemy2)            # False (이미 행동함)
```

---

## 7. `GameMap` 클래스

전장 정보를 담는 객체. `game_state.map`으로 접근.

```python
class GameMap:
    # 속성
    width: int                          # 11
    height: int                         # 7
    
    # 기본 조회
    def get_tile(self, pos: Position) -> Tile:
        """해당 위치의 타일 객체 조회."""
    
    def is_valid_position(self, pos: Position) -> bool:
        """위치가 맵 범위 내인지 확인."""
    
    def is_walkable(self, pos: Position) -> bool:
        """이동 가능 타일인지 (평지/고지대/거점). 유닛 점유 여부는 별개."""
    
    def blocks_vision(self, pos: Position) -> bool:
        """시야 차단 타일인지 (벽만 True, 호수는 False)."""
    
    def is_high_ground(self, pos: Position) -> bool:
        """고지대인지."""
    
    def is_capture_point(self, pos: Position) -> bool:
        """거점 타일인지."""
    
    # 거리 계산
    def distance(self, a: Position, b: Position) -> int:
        """두 위치 간 헥스 거리."""
    
    def neighbors(self, pos: Position) -> list[Position]:
        """인접한 6개 타일 (맵 범위 밖 제외)."""
    
    def tiles_in_range(self, center: Position, radius: int) -> list[Position]:
        """중심으로부터 radius 이내의 모든 타일."""
    
    # 경로 및 시야
    def find_path(self, start: Position, goal: Position,
                  blocked: Callable[[Position], bool] | None = None
                  ) -> list[Position] | None:
        """
        start에서 goal까지 최단 경로 계산 (BFS 기반).
        도달 불가능하면 None. 반환 경로는 start 를 제외한 타일 리스트.

        Args:
            blocked: True 를 반환하면 그 타일을 통과 불가로 간주하는 콜백.
                     보통 학생이 직접 쓸 일은 없고, 엔진 내부에서 유닛 점유
                     타일을 회피하기 위해 사용한다.
        """
    
    def has_line_of_sight(self, from_pos: Position, to_pos: Position) -> bool:
        """
        두 위치 간 사격선이 통하는지 판정.
        벽(blocks_vision=True)과 중간 유닛을 체크.
        호수는 통과 가능.
        """
    
    def line_between(self, from_pos: Position, to_pos: Position) -> list[Position]:
        """
        두 위치를 잇는 헥스 직선 타일 리스트 (양 끝점 포함).
        Red Blob Games 알고리즘 기반.
        """
    
    # 거점 관련
    @property
    def capture_point_positions(self) -> tuple[Position, ...]:
        """모든 거점 타일 좌표 — 3개 단일 타일, 좌·중·우 분산: (3,3)(5,3)(7,3)."""
```

### 7.1. 타일 객체

```python
class Tile:
    position: Position
    tile_type: str              # "plain" | "wall" | "lake" | "high_ground" | "capture"
    walkable: bool
    blocks_vision: bool
    is_high_ground: bool
    is_capture_point: bool
```

---

## 8. `Position` 클래스

오프셋 좌표. **불변(immutable) 객체**.

```python
class Position:
    col: int
    row: int
    
    def __init__(self, col: int, row: int):
        """오프셋 좌표로 위치 생성."""
    
    def __eq__(self, other) -> bool: ...
    def __hash__(self) -> int: ...
    def __repr__(self) -> str: ...
    
    # 큐브 좌표 변환 (고급 사용)
    def to_cube(self) -> tuple[int, int, int]:
        """큐브 좌표 (q, r, s)로 변환."""
    
    @classmethod
    def from_cube(cls, q: int, r: int, s: int) -> 'Position':
        """큐브 좌표에서 Position 생성."""
```

### 8.1. 사용 예시

```python
pos_a = Position(3, 2)
pos_b = Position(5, 4)

if pos_a == pos_b:  # False
    ...

tile_dict = {pos_a: "some_value"}  # 해시 가능
```

---

## 9. 제공되는 예시 에이전트

학생 학습용으로 4개의 베이스라인 에이전트가 제공된다.

### 9.1. `example_simple.py` — 단순 공격형

가장 가까운 적에게 이동·공격. 의무병은 가장 체력 낮은 아군을 힐. 파이썬 입문자용 레퍼런스.

```python
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
    
    def _handle_medic(self, medic, game_state):
        # 가장 다친 아군 찾기
        wounded = [u for u in game_state.my_units 
                   if u.is_alive and u.hp < u.max_hp and u.unit_id != medic.unit_id]
        if wounded:
            target = min(wounded, key=lambda u: u.hp / u.max_hp)
            medic.action.move_toward(target.position)
            if medic.action.can_heal(target):
                medic.action.heal(target)
    
    def _handle_combat(self, unit, game_state):
        enemies = [e for e in game_state.enemy_units if e.is_alive]
        if not enemies:
            return
        
        closest = min(enemies, 
                      key=lambda e: game_state.map.distance(unit.position, e.position))
        unit.action.move_toward(closest.position)
        
        targets = unit.action.attack_targets()
        if targets:
            # 가장 약한 적 우선
            weakest = min(targets, key=lambda e: e.hp)
            unit.action.attack(weakest)

AGENT_CLASS = SimpleAgent
```

### 9.2. `example_aggressive.py` — 돌격형

거점을 최우선으로 돌격. 방패병이 앞장서고 나머지가 뒤따름.

### 9.3. `example_defensive.py` — 수비형

아군 진영 근처에서 대기하다가 적이 사거리에 들어오면 사격. 소극적이지만 교환비 좋음.

### 9.4. `example_demo.py` — DemoAgent (다요인 점수 그리디)

각 후보 행동(이동 후 위치 + 사격/치유 조합)을 여러 요인(거점 가까움, 약한 적 사격 가능, 위험 노출 등)으로 가중 합산해 점수가 가장 높은 행동을 1-ply 그리디로 선택. 베이스라인 3종 상대로 안정적으로 우세 (2026-04 기준 10승 2패). **W3 "휴리스틱 = 스코어 함수" 입문의 코드 모델**로 활용 권장.

**참고**: 이 네 에이전트는 학생이 "잘 만든 AI"의 기준점이 된다. 학생은 이들과 연습 경기를 치르며 자신의 AI를 발전시킨다.

---

## 10. 자주 하는 실수 및 디버깅

### 10.1. "내 유닛이 안 움직여요"

**원인 1**: `move_to()`가 `False` 반환했지만 확인 안 함.
```python
# 잘못된 예
unit.action.move_to(invalid_pos)  # False 반환, 유닛 안 움직임
unit.action.attack(enemy)          # 공격은 원래 위치에서 수행

# 올바른 예
if not unit.action.move_to(target_pos):
    # 대안 위치로 이동 시도
    unit.action.move_toward(target_pos)
```

**원인 2**: 슬롯을 두 번 사용하려 함.
```python
unit.action.move_to(pos_a)
unit.action.move_to(pos_b)  # False (이미 이동함)
```

### 10.2. "공격이 안 돼요"

체크리스트:
- [ ] 사거리 내에 있는가? (`can_attack(target)` 확인)
- [ ] 시야가 통하는가? (벽이나 다른 유닛이 경로 막는지)
- [ ] 지정사수인데 최소사거리(2) 이하인가?
- [ ] 1라운드인가? (공격 금지)
- [ ] 이미 이번 페이즈에 행동했는가?
- [ ] 대상이 살아있는가? (`target.is_alive`)

### 10.3. "시간 초과가 자꾸 나요"

**원인**: 복잡한 탐색을 모든 유닛에 대해 수행.
```python
# 나쁜 예: O(유닛수 × 타일수 × 적수)
for unit in game_state.my_units:
    for tile in game_state.map.tiles_in_range(unit.position, unit.mov):
        for enemy in game_state.enemy_units:
            score = self.evaluate(unit, tile, enemy)
            # ...
```

**해결**: 조기 종료, 캐싱, 중요한 유닛 우선 처리.

### 10.4. "실격 당했어요"

확인:
- `game_state`의 속성을 직접 수정하지 않았는가?
- 파일 시스템·네트워크 접근하지 않았는가?
- `exec`, `eval` 같은 금지 함수 사용하지 않았는가?

---

## 11. 허용된 외부 라이브러리

학생 에이전트 코드는 **파이썬 표준 라이브러리만** 사용 가능하다.

**사용 가능 (표준 라이브러리)**:
`math`, `random`, `collections`, `heapq`, `itertools`, `functools`, `typing`, `dataclasses` 등

**외부 라이브러리 금지 이유**:
이 게임은 유닛 10개, 타일 77개 규모라 표준 라이브러리만으로 충분히 처리 가능하다. NumPy·pandas 등 외부 라이브러리는 이 규모에서 성능 이득이 없고, 오히려 코드를 복잡하게 만든다. 환경 세팅 리스크(Windows pip 에러 등)도 줄어든다. 학생 간 "라이브러리 사용 여부"로 인한 허위 격차도 방지된다.

**참고**: 학생이 Gemini에게 코드 작성을 요청할 때, Gemini가 NumPy 사용을 제안할 수 있다. 이 경우 "표준 라이브러리만 사용해줘"라고 다시 요청하면 된다.

**구체적 금지 항목**:
- 파일 시스템 접근: `open`, `os`, `pathlib`, `shutil`
- 네트워크: `socket`, `urllib`, `requests`, `http`
- 프로세스/스레드: `subprocess`, `multiprocessing`, `threading`, `asyncio`
- 동적 실행: `exec`, `eval`, `compile`, `__import__`
- 외부 패키지: `numpy`, `pandas`, `scipy`, `torch`, 기타 모든 pip 설치 패키지

**입출력 관련**: `print`는 허용되지만 성능상 자제 권장. `input`은 금지 (게임 흐름 차단).

**랜덤 사용**: `random` 모듈 사용은 허용되지만, 경기 결정론 원칙상 권장하지 않는다. 사용할 경우 매 페이즈 시작 시 시드를 고정할 것.

---

## 12. 엔진 구현자용 주의사항

이 섹션은 Claude Code로 엔진을 구현할 때 참고할 내용이다.

### 12.1. 읽기 전용 보장 방법

- `GameState`, `Unit`, `GameMap` 등은 `@dataclass(frozen=True)` 또는 `__slots__` + 프로퍼티로 구현
- 리스트 속성은 `tuple`로 노출 (`my_units: tuple[Unit, ...]`)
- 학생이 `unit.hp = 999` 같은 시도를 하면 `AttributeError` 발생

### 12.2. `UnitAction` 프록시 구현

- 학생은 `unit.action.attack(target)` 형태로 호출
- 내부적으로는 프록시가 엔진의 실제 상태 변경 함수를 호출
- 불법 행동은 `False` 반환, 엔진 상태 불변
- 슬롯 재사용은 유닛 객체의 `_moved_this_phase`, `_acted_this_phase` 플래그로 체크

### 12.3. 시간 측정

- `threading.Timer` 기반 타임아웃 사용 (Windows/macOS/Linux 호환)
- `execute_phase()` 호출 직전에 타이머 시작
- 타임아웃 발생 시 별도 스레드에서 강제 중단 플래그 설정
- 메인 스레드는 플래그 감지 후 페이즈 종료

### 12.4. 에이전트 검증 (제출 단계)

엔진은 에이전트 코드를 **런타임 샌드박스에 가두지 않는다**. 대신 별도의 **정적 검사 스크립트**(`check_agent.py`)가 학생 코드를 AST 파싱하여 금지 패턴을 탐지한다. 학생은 토너먼트 제출 전에 이 검사를 통과해야 한다.

**검사 스크립트가 확인하는 것**:
- 금지된 `import` 문 (numpy, os, socket 등)
- 금지된 내장 함수 호출 (`exec`, `eval`, `compile`, `__import__`, `open`, `input`)
- `AGENT_CLASS` 변수 존재 여부
- `MaehwaAgent` 상속 여부
- `execute_phase` 메서드 오버라이드 여부

**검사 흐름**:
```bash
python check_agent.py agents/my_agent.py
# PASS: 모든 규약 충족. 제출 가능.
# FAIL: Line 23 - forbidden import 'numpy'
```

**경기 중 런타임 체크**: 엔진은 경기 실행 중에는 에이전트의 동작을 제한적으로만 감시한다:
- 읽기 전용 객체에 대한 쓰기 시도 → `AttributeError` 자연 발생 → 실격
- 처리되지 않은 예외 → 실격
- 시간 초과 → §5.6 규칙 적용

경기 중 "학생 코드가 악의적으로 무엇을 하는지" 감시하는 샌드박스는 **구현하지 않는다**. 이는 파이썬 언어 특성상 완벽히 구현하기 어렵고, 이 수업의 범위를 벗어난다. 정적 검사로 제출 전 한 번 걸러내는 것으로 충분하다.

**구현 주의 (Claude Code용)**: 
- 검사 스크립트는 `ast.parse()`로 파일을 파싱하고 `ast.NodeVisitor`로 순회
- `Import`, `ImportFrom`, `Call` 노드에서 금지 패턴 매칭
- 정규식 매칭은 피할 것 (문자열 내 금지어 오탐 방지)

### 12.5. 결정론 보장

- 모든 랜덤 요소 제거 (전투 공식에 random 없음)
- 유닛 ID 순서, 턴 순서 등은 고정
- 같은 에이전트 + 같은 맵 → 항상 같은 결과

---

## 13. 버전 이력

### v0.4 (2026-05-04) — 선공 편향 해소에 따른 맵·룰 변경 반영
- **§7 GameMap**: `capture_point_positions` 좌표를 `(5,2)(5,3)(6,4)` (NW-SE 대각선) → `(3,3)(5,3)(7,3)` (좌·중·우 분산 3거점) 으로 갱신. 룰북 v0.5에서 거점을 분산시킨 것과 동기화.
- API 시그니처 자체는 변경 없음 (반환 형식 동일). 좌표만 갱신.

### v0.3 (2026-05-03) — 코드 동기화 (실제 구현과 어긋난 부분 일괄 정정)
- **§3 / §3.1 import 정리**: `from engine.unit import UnitAction` 삭제 — `UnitAction` 은 실제로 `engine/unit_action.py` 에 있고, 학생 코드는 `unit.action` 프록시로만 접근하므로 import 자체가 불필요.
- **§3.1 학생 파일 경로**: `agents/my_agent.py` → `agent.py` (레포 루트, 템플릿 구조 일치).
- **§2.3 CLI 옵션 정리**: 옛 pygame 시절 옵션(`--no-render`, `--seed`, `--speed`) 삭제, 실제 옵션(`--replay`, `--first-team`, `--enforce-timeout`) 만 명시. 렌더링은 viewer 가 담당함을 명시.
- **§4 GameState**: 미구현 메서드 `time_elapsed_this_phase()` 삭제.
- **§7 GameMap**: `find_path` 시그니처를 실제 구현(`blocked` 콜백)에 맞게 수정. `capture_point_positions` 설명을 "5개 십자형" → "3개 NW-SE 대각선" 으로 정정 (옛 v0.1 잔재).
- **§2.1 / §9 베이스라인**: `example_defensive.py` 와 `example_demo.py` (DemoAgent) 추가 — 실제 4종 제공 중인데 스펙엔 2종만 있었음.

### v0.2 (2026-04-XX) — NumPy 제거 + 검증 방식 변경
- §11: 외부 라이브러리 전면 금지. 파이썬 표준 라이브러리만 허용. NumPy 삭제 (이 규모에서 이득 없음).
- §12.4: 런타임 샌드박스 → 제출 단계 정적 검사 스크립트(`check_agent.py`)로 변경. AST 파싱 기반.

### v0.1 (2026-04-XX) — 초안
- 최초 작성
- `MaehwaAgent` 베이스 클래스 정의
- `GameState`, `Unit`, `GameMap`, `Position`, `UnitAction` API 명세
- 베이스라인 에이전트 3종 구조 정의
- 금지 사항 및 디버깅 가이드

### 향후 작업 (TODO)
- [ ] `example_aggressive.py`, `example_defensive.py` 실제 코드 작성
- [ ] 리플레이 파일 포맷 스펙 (별도 섹션 또는 문서)
- [ ] 엔진 내부 이벤트 훅 (선택 사항, 고급 학생용)

---

*이 문서는 `Maehwa: Tactical Arena` 프로젝트의 일부입니다. 수정 시 버전 번호를 올리고 변경 내역을 §13에 기록하세요.*
