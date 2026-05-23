/**
 * 튜토리얼 풀스크린 패널 — 좌: 코드 에디터, 우: 시나리오 설명 + 실행 결과.
 *
 * 흐름:
 *   1. 학생이 시나리오 드롭다운에서 골라 에디터에 본문 작성
 *   2. ▶ 실행 누름 → 패널 숨김 → 워커가 매치 실행 → setReplay 로 viewer 에 재생
 *   3. 재생 끝나면 자동으로 패널 복귀 (또는 좌상단 ← 클릭) → 합격/실패 결과 표시
 *
 * 시나리오 변경 시 에디터 starter code 가 새로 로드되며 직전 코드는 폐기된다.
 * (MVP — localStorage 저장은 차후.)
 */

import type { Replay, TeamId } from '../replay/types';
import type { OpponentOption } from '../pyodide/engineSources';
import type { EngineRuntime } from '../pyodide/runtime';
import { check, type CheckResult } from './checkers';
import { createCodeEditor, type CodeEditorHandle } from './editor';
import { findScenario, SCENARIOS, type Scenario } from './scenarios';

export interface TutorialPanelOptions {
  /** 워커가 처음 호출 시점에 lazy 하게 초기화되도록 — Pyodide 부팅 비용 ~10MB */
  readonly ensureRuntime: () => Promise<EngineRuntime>;
  /** 매치 결과를 viewer 에 재생시키기 위한 콜백 (main.ts 의 setReplay) */
  readonly playReplay: (replay: Replay) => void;
  /** 좌상단 백버튼이 visible / hidden 인지 main.ts 가 제어 */
  readonly setBackButtonVisible: (visible: boolean) => void;
  /**
   * 시나리오 진입/변경 시 맵 텍스트로 viewer 의 맵 렌더러를 swap.
   * 본 게임 11×7 맵이 아니라 좁은 디오라마 맵으로 갈아끼우기 위함.
   */
  readonly swapMap: (mapText: string) => void;
}

export interface TutorialPanelHandle {
  readonly root: HTMLElement;
  show(): void;
  hide(): void;
  /** 재생 중인 리플레이가 끝났음을 패널에 알림 — 결과 카드 노출 */
  onReplayEnded(): void;
  dispose(): void;
}

const STUDENT_TEAM: TeamId = 'A';

export function mountTutorialPanel(
  parent: HTMLElement,
  options: TutorialPanelOptions,
): TutorialPanelHandle {
  let currentScenario: Scenario = findScenario('T1') ?? SCENARIOS[0]!;

  const root = document.createElement('div');
  root.className = 'maehwa-tutorial';
  root.innerHTML = `
    <style>
      .maehwa-tutorial {
        position: fixed; inset: 0;
        display: none;
        background: linear-gradient(135deg, rgba(8, 11, 20, 0.97) 0%, rgba(16, 22, 38, 0.97) 100%);
        z-index: 40;
        font: 14px/1.5 'Pretendard Variable', 'Galmuri11', system-ui, sans-serif;
        color: #e8eaf0;
      }
      .maehwa-tutorial.open { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr); gap: 14px; padding: 70px 24px 24px; box-sizing: border-box; }
      .maehwa-tutorial .editor-pane {
        display: flex; flex-direction: column; gap: 10px; min-height: 0;
      }
      .maehwa-tutorial .editor-pane .editor-host { flex: 1 1 auto; min-height: 0; }
      .maehwa-tutorial .editor-toolbar {
        display: flex; gap: 8px; justify-content: flex-end; align-items: center;
      }
      .maehwa-tutorial .scenario-picker {
        display: flex; align-items: center; gap: 8px;
        margin-right: auto;
        font-size: 12px; opacity: 0.8;
      }
      .maehwa-tutorial .scenario-picker select {
        padding: 6px 10px; border-radius: 6px;
        background: rgba(255, 255, 255, 0.06);
        color: #e8eaf0;
        border: 1px solid rgba(255, 255, 255, 0.14);
        font: inherit; font-weight: 600;
        cursor: pointer;
        /* dark color-scheme 힌트 — 일부 브라우저가 native dropdown 을 다크 모드로 렌더 */
        color-scheme: dark;
      }
      .maehwa-tutorial .scenario-picker select option {
        /* OS native dropdown 은 select 의 색을 안 물려받아 명시적으로 박아준다 */
        background: #161c2e;
        color: #e8eaf0;
        font-weight: 600;
      }
      .maehwa-tutorial .scenario-picker select option:checked {
        background: #ffb84d;
        color: #0b0f1a;
      }
      .maehwa-tutorial .editor-toolbar button {
        padding: 9px 18px; border-radius: 8px;
        background: #ffb84d; color: #0b0f1a;
        border: 0; cursor: pointer; font: inherit; font-weight: 700;
        letter-spacing: 0.02em;
      }
      .maehwa-tutorial .editor-toolbar button.secondary {
        background: rgba(255, 255, 255, 0.08);
        color: #e8eaf0;
        border: 1px solid rgba(255, 255, 255, 0.14);
      }
      .maehwa-tutorial .editor-toolbar button:disabled {
        opacity: 0.5; cursor: not-allowed;
      }
      .maehwa-tutorial .info-pane {
        display: flex; flex-direction: column; gap: 14px;
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 10px;
        padding: 22px 24px;
        overflow-y: auto; min-height: 0;
      }
      .maehwa-tutorial .info-pane .badge {
        display: inline-block; padding: 3px 9px;
        background: rgba(255, 184, 77, 0.15); color: #ffb84d;
        font-size: 10px; font-weight: 700; letter-spacing: 0.08em;
        border-radius: 999px; align-self: flex-start;
      }
      .maehwa-tutorial .info-pane h2 {
        margin: 0; font-size: 18px; font-weight: 700;
      }
      .maehwa-tutorial .info-pane .desc {
        font-size: 14px; line-height: 1.6;
        background: rgba(255, 184, 77, 0.05);
        border-left: 3px solid rgba(255, 184, 77, 0.6);
        padding: 10px 14px; border-radius: 0 6px 6px 0;
      }
      .maehwa-tutorial .info-pane .hint {
        font-size: 12.5px; line-height: 1.65;
        white-space: pre-wrap;
        opacity: 0.78;
        background: rgba(0, 0, 0, 0.2);
        border-radius: 6px;
        padding: 12px 14px;
        font-family: Consolas, "Cascadia Code", "JetBrains Mono", Menlo, Monaco, ui-monospace, monospace;
      }
      .maehwa-tutorial .info-pane .hint code,
      .maehwa-tutorial .info-pane .desc code {
        background: rgba(255, 184, 77, 0.12); color: #ffd58a;
        padding: 1px 5px; border-radius: 3px; font-size: 0.92em;
      }
      .maehwa-tutorial .status {
        font-size: 13px; min-height: 18px;
        opacity: 0.8;
      }
      .maehwa-tutorial .result {
        display: none;
        padding: 14px 16px; border-radius: 8px;
        font-size: 13.5px; line-height: 1.5;
      }
      .maehwa-tutorial .result.show { display: block; }
      .maehwa-tutorial .result.pass {
        background: rgba(140, 181, 103, 0.14);
        border: 1px solid rgba(140, 181, 103, 0.5);
        color: #c4e29d;
      }
      .maehwa-tutorial .result.fail {
        background: rgba(232, 96, 96, 0.13);
        border: 1px solid rgba(232, 96, 96, 0.5);
        color: #ff9a9a;
      }
      .maehwa-result-banner {
        position: fixed; top: 18px; left: 50%;
        transform: translateX(-50%) translateY(-12px);
        padding: 12px 22px; border-radius: 999px;
        font: 600 14px/1.4 'Pretendard Variable', system-ui, sans-serif;
        z-index: 45;
        backdrop-filter: blur(10px);
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
        opacity: 0; pointer-events: none;
        transition: opacity 220ms ease, transform 220ms ease;
        max-width: min(82vw, 720px);
        text-align: center;
      }
      .maehwa-result-banner.show {
        opacity: 1; transform: translateX(-50%) translateY(0);
        pointer-events: auto;
      }
      .maehwa-result-banner.pass {
        background: rgba(45, 70, 35, 0.94);
        border: 1px solid rgba(140, 181, 103, 0.7);
        color: #c4e29d;
      }
      .maehwa-result-banner.fail {
        background: rgba(70, 30, 30, 0.94);
        border: 1px solid rgba(232, 96, 96, 0.7);
        color: #ffb0b0;
      }
      .maehwa-result-banner .icon { margin-right: 6px; font-size: 16px; }
    </style>
    <div class="editor-pane">
      <div class="editor-host"></div>
      <div class="editor-toolbar">
        <div class="scenario-picker">
          <span>시나리오</span>
          <select class="scenario-select"></select>
        </div>
        <button class="secondary reset" type="button">↺ 시작 코드</button>
        <button class="run" type="button">▶ 실행</button>
      </div>
    </div>
    <div class="info-pane">
      <div class="badge"></div>
      <h2></h2>
      <div class="desc"></div>
      <div class="hint"></div>
      <div class="status"></div>
      <div class="result"></div>
    </div>
  `;

  const editorHost = root.querySelector<HTMLDivElement>('.editor-host')!;
  const runBtn = root.querySelector<HTMLButtonElement>('button.run')!;
  const resetBtn = root.querySelector<HTMLButtonElement>('button.reset')!;
  const select = root.querySelector<HTMLSelectElement>('.scenario-select')!;
  const statusEl = root.querySelector<HTMLDivElement>('.status')!;
  const resultEl = root.querySelector<HTMLDivElement>('.result')!;
  const badgeEl = root.querySelector<HTMLDivElement>('.badge')!;
  const titleEl = root.querySelector<HTMLHeadingElement>('h2')!;
  const descEl = root.querySelector<HTMLDivElement>('.desc')!;
  const hintEl = root.querySelector<HTMLDivElement>('.hint')!;

  // 시나리오 드롭다운 채우기
  for (const sc of SCENARIOS) {
    const opt = document.createElement('option');
    opt.value = sc.id;
    opt.textContent = sc.title;
    select.appendChild(opt);
  }
  select.value = currentScenario.id;

  const editor: CodeEditorHandle = createCodeEditor(currentScenario.starterCode);
  editorHost.appendChild(editor.element);

  parent.appendChild(root);

  // 결과 배너 — 매치가 끝나자마자(재생 시작 직전) 떠서 재생 내내 위에 머무른다.
  // 재생이 끝나고 패널이 다시 뜨면 자동으로 사라진다.
  const banner = document.createElement('div');
  banner.className = 'maehwa-result-banner';
  parent.appendChild(banner);

  function showBanner(passed: boolean, text: string): void {
    banner.classList.remove('pass', 'fail', 'show');
    banner.classList.add(passed ? 'pass' : 'fail');
    banner.innerHTML = `<span class="icon">${passed ? '✓' : '✗'}</span>${escapeHtml(text)}`;
    requestAnimationFrame(() => banner.classList.add('show'));
  }
  function hideBanner(): void {
    banner.classList.remove('show');
  }

  function loadScenario(sc: Scenario): void {
    currentScenario = sc;
    badgeEl.textContent = sc.id;
    titleEl.textContent = sc.title;
    descEl.textContent = sc.description;
    hintEl.innerHTML = formatHint(sc.hint);
    editor.setValue(sc.starterCode);
    resultEl.classList.remove('show', 'pass', 'fail');
    statusEl.textContent = '';
  }

  // 첫 화면 정보 채우기 — 맵 swap 은 show() 에서 일괄 트리거 (부팅 시 메뉴에서
  // tutorial 맵이 깜빡 보이지 않도록 분리).
  loadScenario(currentScenario);

  select.addEventListener('change', () => {
    const sc = findScenario(select.value);
    if (sc === undefined) return;
    loadScenario(sc);
    // 사용자가 시나리오 바꿨으면 패널 뒤 viewer 도 새 맵으로 즉시 갈아끼움.
    options.swapMap(sc.mapText);
  });

  resetBtn.addEventListener('click', () => {
    if (running) return;
    editor.setValue(currentScenario.starterCode);
    resultEl.classList.remove('show', 'pass', 'fail');
    statusEl.textContent = '시작 코드로 되돌렸습니다.';
    editor.focus();
  });

  /** 직전 실행 결과를 보관 — 리플레이 끝났을 때 결과 카드를 띄우기 위해 */
  let pendingResult: { result: CheckResult; scenario: Scenario } | null = null;
  let running = false;

  async function runScenario(): Promise<void> {
    if (running) return;
    running = true;
    setRunning(true);
    statusEl.textContent = '엔진 준비 중… (최초 1회 ~10MB 다운로드)';
    resultEl.classList.remove('show');

    try {
      const studentBody = editor.getValue();
      const fullSource = studentBody + '\n' + currentScenario.autoWrap;
      const opponent: OpponentOption = {
        id: 'tut-' + currentScenario.id.toLowerCase(),
        path: currentScenario.opponentPath,
        label: '튜토리얼 상대',
      };

      const runtime = await options.ensureRuntime();
      statusEl.textContent = '경기 진행 중…';
      const replay = await runtime.runMatch({
        studentSource: fullSource,
        studentClassName: '_StudentAgent',
        opponent,
        studentTeam: STUDENT_TEAM,
        firstTeam: 'A',
        tutorialOverride: {
          mapText: currentScenario.mapText,
          startPositions: currentScenario.startPositions,
          maxRounds: currentScenario.maxRounds,
        },
      });

      const checkResult = check(currentScenario.checker, {
        replay,
        studentSource: studentBody,
        studentTeam: STUDENT_TEAM,
      });
      pendingResult = { result: checkResult, scenario: currentScenario };

      // 합격/실패는 재생을 다 보기 전에 즉시 알려준다 — 상단 배너로 띄워두면
      // 재생 내내 위에 떠 있어서 학생이 결과를 놓치지 않는다.
      showBanner(
        checkResult.passed,
        checkResult.passed ? currentScenario.passMessage : checkResult.reason,
      );

      // 패널 숨기고 리플레이 재생 — 끝나면 main.ts 가 onReplayEnded() 호출
      hide();
      options.setBackButtonVisible(true);
      options.playReplay(replay);
    } catch (err) {
      statusEl.textContent = '';
      showResult(false, `실행 실패: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
      setRunning(false);
    }
  }

  function setRunning(isRunning: boolean): void {
    runBtn.disabled = isRunning;
    resetBtn.disabled = isRunning;
    select.disabled = isRunning;
  }

  function showResult(passed: boolean, msg: string): void {
    resultEl.classList.remove('pass', 'fail');
    resultEl.classList.add('show', passed ? 'pass' : 'fail');
    resultEl.textContent = msg;
  }

  runBtn.addEventListener('click', () => {
    void runScenario();
  });

  function show(): void {
    // 패널 복귀 = 배너 역할 끝 (info-pane 의 result 카드가 결과 표시 인계)
    hideBanner();
    root.classList.add('open');
    statusEl.textContent = '';
    // 튜토리얼 모드 진입(또는 리플레이 후 복귀) 시 viewer 가 본 게임 맵으로
    // 돌아가 있을 수 있으므로 현재 시나리오 맵으로 다시 swap.
    options.swapMap(currentScenario.mapText);
    setTimeout(() => editor.focus(), 0);
  }
  function hide(): void {
    root.classList.remove('open');
  }

  return {
    root,
    show,
    hide,
    onReplayEnded(): void {
      if (pendingResult === null) return;
      const { result, scenario: sc } = pendingResult;
      pendingResult = null;
      show();
      // 패널로 복귀해도 메뉴로 빠지는 ← 백버튼은 계속 노출 — 패널 자체에는
      // 메뉴 복귀 UI 가 없어서 false 로 두면 학생이 튜토리얼 화면에 갇힌다.
      options.setBackButtonVisible(true);
      if (result.passed) {
        showResult(true, sc.passMessage);
      } else {
        showResult(false, result.reason);
      }
    },
    dispose(): void {
      editor.destroy();
      banner.remove();
      root.remove();
    },
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 힌트 텍스트의 백틱(`)을 <code>로 변환 + 줄바꿈 보존. */
function formatHint(hint: string): string {
  return escapeHtml(hint).replace(/`([^`]+)`/g, '<code>$1</code>');
}
