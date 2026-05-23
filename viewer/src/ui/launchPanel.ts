import type { Replay, ReplayEvent, SetupEvent, TeamId } from '../replay/types';
import { OPPONENT_OPTIONS, type OpponentOption } from '../pyodide/engineSources';
import { loadEngineRuntime, type EngineRuntime } from '../pyodide/runtime';

export interface LaunchPanelHandle {
  readonly root: HTMLElement;
  dispose(): void;
}

export interface LiveStreamHandlers {
  /** Fires once when the setup event arrives — caller sets up live timeline. */
  onSetup: (event: SetupEvent) => void;
  /** Fires for every subsequent event (phase / gauge / end). */
  onEvent: (event: ReplayEvent) => void;
  /** Fires once the match ends — caller swaps to the canonical fixed replay. */
  onComplete: (replay: Replay) => void;
}

export interface LaunchPanelOptions {
  readonly onReplay: (replay: Replay) => void;
  readonly onError?: (err: Error) => void;
  /** Optional live broadcast handlers — when provided, the panel exposes a
   *  toggle that pumps events as Pyodide yields them. */
  readonly onLiveStream?: LiveStreamHandlers;
  /** If provided, the panel starts with this source pre-loaded. */
  readonly initialSource?: string | null;
  readonly initialLabel?: string;
}

export function mountLaunchPanel(parent: HTMLElement, options: LaunchPanelOptions): LaunchPanelHandle {
  const root = document.createElement('div');
  root.className = 'maehwa-launch';
  root.innerHTML = `
    <style>
      .maehwa-launch {
        position: fixed; right: 18px; bottom: 92px; width: 280px;
        background: rgba(10, 14, 24, 0.88);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 10px;
        padding: 14px 14px 12px;
        font: 13px/1.4 'Pretendard Variable', 'Galmuri11', system-ui, sans-serif;
        color: #e8eaf0;
        backdrop-filter: blur(10px);
        z-index: 10;
      }
      .maehwa-launch h3 {
        margin: 0 0 10px; font-size: 13px; font-weight: 600;
        letter-spacing: 0.02em; opacity: 0.95;
      }
      .maehwa-launch label {
        display: block; margin-top: 10px; font-size: 12px; opacity: 0.8;
      }
      .maehwa-launch select,
      .maehwa-launch input[type="file"] {
        width: 100%; margin-top: 4px; padding: 6px;
        background: rgba(255, 255, 255, 0.06);
        color: #e8eaf0;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 6px;
        font: inherit;
      }
      /* select 자체는 다크 테마지만 <option> popup 은 OS 기본(흰 배경)으로 떠서
         #e8eaf0 회색 텍스트가 묻힘. option 만 따로 다크 배경+밝은 텍스트로 고정. */
      .maehwa-launch select option {
        background: #1a1f2e;
        color: #e8eaf0;
      }
      .maehwa-launch .team-toggle { display: flex; gap: 6px; margin-top: 4px; }
      .maehwa-launch .team-toggle button {
        flex: 1; padding: 6px;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.12);
        color: #e8eaf0;
        border-radius: 6px; font: inherit; cursor: pointer;
      }
      .maehwa-launch .team-toggle button.active.team-a {
        background: rgba(255, 107, 71, 0.25); border-color: #ff6b47;
      }
      .maehwa-launch .team-toggle button.active.team-b {
        background: rgba(75, 163, 255, 0.25); border-color: #4ba3ff;
      }
      .maehwa-launch .run-btn {
        width: 100%; margin-top: 12px; padding: 9px;
        background: #ffb84d; color: #0b0f1a;
        border: 0; border-radius: 6px; font-weight: 600; cursor: pointer;
      }
      .maehwa-launch .run-btn:disabled { opacity: 0.5; cursor: default; }
      .maehwa-launch .status {
        margin-top: 10px; min-height: 20px; font-size: 12px;
        opacity: 0.85; white-space: pre-wrap;
      }
      .maehwa-launch .status.error { color: #ff7878; opacity: 1; }
    </style>
    <h3>내 AI 돌려보기</h3>
    <label>
      에이전트 파일 (.py)
      <input type="file" accept=".py" />
    </label>
    <label>
      상대
      <select class="opp-select">
        ${OPPONENT_OPTIONS.map((o) => `<option value="${o.id}">${o.label}</option>`).join('')}
      </select>
    </label>
    <label>내 팀</label>
    <div class="team-toggle">
      <button type="button" data-team="A" class="team-a active">A (주황)</button>
      <button type="button" data-team="B" class="team-b">B (파랑)</button>
    </div>
    <label class="live-toggle" style="display:flex; align-items:center; gap:6px; cursor:pointer; margin-top:10px;">
      <input type="checkbox" class="live-check" />
      <span>🔴 라이브 중계 모드 (페이즈마다 즉시 표시)</span>
    </label>
    <button type="button" class="run-btn" disabled>파일을 선택하세요</button>
    <div class="status"></div>
  `;
  parent.appendChild(root);

  const fileInput = root.querySelector<HTMLInputElement>('input[type="file"]')!;
  const oppSelect = root.querySelector<HTMLSelectElement>('.opp-select')!;
  const teamButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('.team-toggle button'));
  const runBtn = root.querySelector<HTMLButtonElement>('.run-btn')!;
  const statusEl = root.querySelector<HTMLDivElement>('.status')!;
  const liveCheck = root.querySelector<HTMLInputElement>('.live-check')!;
  const liveToggleLabel = root.querySelector<HTMLLabelElement>('.live-toggle')!;
  if (!options.onLiveStream) {
    // Hide the live toggle entirely if the host hasn't wired up handlers.
    liveToggleLabel.style.display = 'none';
  }

  let studentSource: string | null = options.initialSource ?? null;
  let studentFileName: string | null = options.initialSource ? options.initialLabel ?? 'agent.py' : null;
  let studentTeam: TeamId = 'A';
  let runtime: EngineRuntime | null = null;
  let runtimeLoading = false;

  if (studentSource !== null) {
    setStatus(`로드됨: ${studentFileName} (${studentSource.length.toLocaleString()} bytes)`);
  }

  function setStatus(msg: string, isError = false): void {
    statusEl.textContent = msg;
    statusEl.classList.toggle('error', isError);
  }

  function updateRunButton(): void {
    if (studentSource === null) {
      runBtn.disabled = true;
      runBtn.textContent = '파일을 선택하세요';
    } else if (runtimeLoading) {
      runBtn.disabled = true;
      runBtn.textContent = '로딩 중…';
    } else {
      runBtn.disabled = false;
      runBtn.textContent = '대전 실행';
    }
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) {
      studentSource = null;
      studentFileName = null;
      updateRunButton();
      return;
    }
    studentSource = await file.text();
    studentFileName = file.name;
    setStatus(`로드됨: ${studentFileName} (${studentSource.length.toLocaleString()} bytes)`);
    updateRunButton();
  });

  teamButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      studentTeam = btn.dataset['team'] as TeamId;
      teamButtons.forEach((b) => b.classList.toggle('active', b === btn));
    });
  });

  runBtn.addEventListener('click', async () => {
    if (studentSource === null) return;
    runBtn.disabled = true;
    try {
      if (runtime === null) {
        runtimeLoading = true;
        updateRunButton();
        runtime = await loadEngineRuntime((msg) => setStatus(msg));
        runtimeLoading = false;
      }
      const opponent = resolveOpponent(oppSelect.value);
      const matchOpts = {
        studentSource,
        studentClassName: '',
        opponent,
        studentTeam,
      };

      if (liveCheck.checked && options.onLiveStream) {
        setStatus('🔴 라이브 중계 시작…');
        const liveHandlers = options.onLiveStream;
        let setupSeen = false;
        await new Promise<void>((resolve, reject) => {
          runtime!.runMatchStreaming(matchOpts, {
            onEvent: (ev) => {
              if (!setupSeen) {
                if (ev.kind !== 'setup') {
                  reject(new Error(`첫 이벤트가 setup 이 아님: ${ev.kind}`));
                  return;
                }
                setupSeen = true;
                liveHandlers.onSetup(ev);
              } else {
                liveHandlers.onEvent(ev);
              }
            },
            onComplete: (replay) => {
              const winner = replay.events.at(-1);
              setStatus(
                winner?.kind === 'end'
                  ? `완료: ${formatResult(winner.data.winner, winner.data.reason, studentTeam)}`
                  : '완료',
              );
              liveHandlers.onComplete(replay);
              resolve();
            },
            onError: (err) => reject(err),
          });
        });
      } else {
        setStatus('대전 실행 중…');
        const replay = await runtime.runMatch(matchOpts);
        const winner = replay.events.at(-1);
        setStatus(
          winner?.kind === 'end'
            ? `완료: ${formatResult(winner.data.winner, winner.data.reason, studentTeam)}`
            : '완료',
        );
        options.onReplay(replay);
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      setStatus(`실패: ${e.message}`, true);
      options.onError?.(e);
    } finally {
      runtimeLoading = false;
      updateRunButton();
    }
  });

  return {
    root,
    dispose() {
      root.remove();
    },
  };
}

function resolveOpponent(id: string): OpponentOption {
  const match = OPPONENT_OPTIONS.find((o) => o.id === id);
  if (!match) throw new Error(`unknown opponent id: ${id}`);
  return match;
}

function formatResult(winner: 'A' | 'B' | null, reason: string, studentTeam: TeamId): string {
  if (winner === null) return `무승부 (${reason})`;
  const verdict = winner === studentTeam ? '승리' : '패배';
  return `${verdict} — ${winner}팀 ${reason}`;
}
