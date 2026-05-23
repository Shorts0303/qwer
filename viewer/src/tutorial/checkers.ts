/**
 * 시나리오 통과 조건 체커.
 *
 * 두 가지 신호를 결합해 "합격" 여부를 본다:
 * 1. 게임 결과 (replay) — 거점 점유 / 적 격파 / 승리 등
 * 2. 학생 코드 (source) — 의도한 Python 개념을 실제로 썼는지 (for / def / class)
 *
 * 너무 엄격하면 학생이 다른 valid 한 풀이로 풀어도 fail 이라 좌절. 너무 너그러우면
 * 의미 없음. 마이크로 시나리오 단계에선 "결과 + 키워드 사용 여부" 정도가 적정.
 *
 * 시나리오별 검증 강도:
 *   T1 — `if` 키워드 + 매치가 예외 없이 종료
 *   T2 — `for` + `print` 키워드 + 매치 종료
 *   T3 — `for` + 거점 점유 (gauge.n_a >= 1)
 *   T4 — `def find_weakest` + 호출 + 승리 (winner == student team)
 */

import type { Replay, TeamId } from '../replay/types';
import type { CheckerId } from './scenarios';

export interface CheckResult {
  readonly passed: boolean;
  /** 학생에게 보여줄 사유 — 합격이면 빈 문자열 (시나리오의 passMessage 가 사용됨), 실패면 부족했던 부분. */
  readonly reason: string;
}

export interface CheckContext {
  readonly replay: Replay;
  readonly studentSource: string;
  readonly studentTeam: TeamId;
}

export function check(id: CheckerId, ctx: CheckContext): CheckResult {
  switch (id) {
    case 'T1':
      return checkT1(ctx);
    case 'T2':
      return checkT2(ctx);
    case 'T3':
      return checkT3(ctx);
    case 'T4':
      return checkT4(ctx);
  }
}

function checkT1(ctx: CheckContext): CheckResult {
  if (!hasIfStatement(ctx.studentSource)) {
    return {
      passed: false,
      reason: '`if` 분기가 보이지 않아요. `if 조건:` 형태의 줄을 작성했는지 확인해보세요.',
    };
  }
  if (!matchCompleted(ctx.replay)) {
    return {
      passed: false,
      reason: '매치가 정상 종료되지 않았어요. 코드에 오타나 들여쓰기 오류가 없는지 확인해보세요.',
    };
  }
  // 분기를 썼더라도 양쪽 다 비어 있으면 (또는 else 가 비면) 유닛이 한 칸도
  // 안 움직임 → 화면에선 "✓합격인데 아무도 안 움직임" 어색한 상태가 된다.
  // T1 starter 의 시작 hp 는 max 이므로 정상 풀이는 else 로 진입해 move_toward
  // 가 호출된다 — move 액션이 한 번도 없다면 풀이가 비어 있다고 봐야 한다.
  if (!studentTeamMoved(ctx.replay, ctx.studentTeam)) {
    return {
      passed: false,
      reason:
        '`if` 분기는 썼지만 우리 팀 유닛이 한 번도 움직이지 않았어요. '
        + 'else 쪽에 `unit.action.move_toward(enemy.position)` 을 채웠는지 확인해보세요.',
    };
  }
  return { passed: true, reason: '' };
}

function checkT2(ctx: CheckContext): CheckResult {
  if (!hasForLoop(ctx.studentSource)) {
    return {
      passed: false,
      reason: '`for` 문이 보이지 않아요. `for unit in game_state.my_units:` 형태로 5명을 한 번에 순회해보세요.',
    };
  }
  if (!hasPrintCall(ctx.studentSource)) {
    return {
      passed: false,
      reason: '`print(...)` 호출이 보이지 않아요. for 문 안에서 각 unit 정보를 출력해보세요.',
    };
  }
  if (!matchCompleted(ctx.replay)) {
    return {
      passed: false,
      reason: '매치가 정상 종료되지 않았어요. 코드 오류를 확인해보세요.',
    };
  }
  return { passed: true, reason: '' };
}

function checkT3(ctx: CheckContext): CheckResult {
  const studentKey = ctx.studentTeam === 'A' ? 'n_a' : 'n_b';
  const everCaptured = ctx.replay.events.some(
    (e) => e.kind === 'gauge' && (e.data[studentKey] as number) >= 1,
  );
  if (!everCaptured) {
    return {
      passed: false,
      reason: '아직 우리 팀 유닛이 거점에 도착하지 않았어요. for 문으로 모든 유닛을 거점으로 이동시켰는지 확인해보세요.',
    };
  }
  if (!hasForLoop(ctx.studentSource)) {
    return {
      passed: false,
      reason: 'for 문이 보이지 않아요. 5명을 직접 한 줄씩 쓰는 대신 for 문으로 한 번에 처리해보세요.',
    };
  }
  return { passed: true, reason: '' };
}

function checkT4(ctx: CheckContext): CheckResult {
  if (!/\bdef\s+find_weakest\s*\(/.test(ctx.studentSource)) {
    return {
      passed: false,
      reason: '`find_weakest` 함수를 정의해야 해요. `def find_weakest(units):` 으로 시작하는 함수가 필요합니다.',
    };
  }
  if (!hasFunctionCall(ctx.studentSource, 'find_weakest')) {
    return {
      passed: false,
      reason: '`find_weakest` 를 호출해야 해요. `take_actions` 안에서 `find_weakest(enemies)` 처럼 불러서 결과를 활용하세요.',
    };
  }
  // 시작 코드의 `return None` 이 그대로 남아 있으면 함수 본문 미작성.
  // 정의는 있는데 본문이 None 만 반환하면 target 이 None 이라 공격을 못 함 → 승리 X.
  // 그래서 승리 검사가 자연스럽게 본문 작성 여부를 갈음한다.
  const winner = winnerOfReplay(ctx.replay);
  if (winner !== ctx.studentTeam) {
    return {
      passed: false,
      reason: '아직 승리하지 못했어요. `find_weakest` 가 진짜로 가장 약한 유닛을 반환하는지 (`return min(units, key=lambda u: u.hp)`) 확인해보세요.',
    };
  }
  return { passed: true, reason: '' };
}

// ─── 헬퍼 ────────────────────────────────────────────────────────────────

/**
 * 줄 단위 텍스트 검사 — 주석 줄(`#` 으로 시작) 은 제외하고 첫 비-공백 토큰만 본다.
 * 더 정밀하게는 Python `ast` 가 필요하지만 마이크로 시나리오 수준에선 정규식이 충분.
 */
function hasForLoop(source: string): boolean {
  return matchPattern(source, /^for\s+\w+\s+in\b/);
}

function hasIfStatement(source: string): boolean {
  return matchPattern(source, /^if\s+.+:/);
}

function hasPrintCall(source: string): boolean {
  // print 는 라인 시작이 아닌 위치에도 올 수 있어 (들여쓰기 안에서) 일반 텍스트 검색.
  // 단 주석 줄은 제외해야 한다.
  const lines = source.split('\n');
  for (const raw of lines) {
    const stripped = stripComment(raw);
    if (/\bprint\s*\(/.test(stripped)) return true;
  }
  return false;
}

function hasFunctionCall(source: string, fnName: string): boolean {
  const pattern = new RegExp(`\\b${fnName}\\s*\\(`);
  const lines = source.split('\n');
  let defLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const stripped = stripComment(lines[i] ?? '');
    if (new RegExp(`^def\\s+${fnName}\\s*\\(`).test(stripped.trim())) {
      defLine = i;
    } else if (pattern.test(stripped) && i !== defLine) {
      // 정의 라인 자체가 아닌 어디선가 호출됐으면 통과.
      return true;
    }
  }
  return false;
}

function matchPattern(source: string, pattern: RegExp): boolean {
  const lines = source.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('#') || line === '') continue;
    if (pattern.test(line)) return true;
  }
  return false;
}

function stripComment(line: string): string {
  // 단순화: 문자열 안의 # 까지는 처리 안 함 (튜토리얼 코드는 짧고 주석이 단순)
  const idx = line.indexOf('#');
  return idx >= 0 ? line.slice(0, idx) : line;
}

function matchCompleted(replay: Replay): boolean {
  return replay.events.some((e) => e.kind === 'end');
}

/**
 * 학생 팀 페이즈 동안 move 액션이 한 번이라도 기록됐는가.
 * phase 이벤트의 `actions[]` 는 v3 포맷에서 모든 페이즈 단위 행동 (move/attack/heal)
 * 을 순서대로 담는 사이드카. 학생 팀의 phase_team 과 일치하는 것만 본다.
 */
function studentTeamMoved(replay: Replay, team: TeamId): boolean {
  for (const ev of replay.events) {
    if (ev.kind !== 'phase' || ev.phase_team !== team) continue;
    if (ev.data.actions.some((a) => a.kind === 'move')) return true;
  }
  return false;
}

function winnerOfReplay(replay: Replay): TeamId | null {
  const last = [...replay.events].reverse().find((e) => e.kind === 'end');
  if (last === undefined || last.kind !== 'end') return null;
  return last.data.winner;
}
