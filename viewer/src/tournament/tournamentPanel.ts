/**
 * Tournament panel — instructor-side UI for the showcase day.
 *
 * Lifecycle phases (`Phase`):
 *   - 'upload'  : drag-drop / pick student .py files, build the entrant list
 *   - 'round'   : Swiss round in progress; show pairings, run matches via the
 *                 caller-supplied onPlayMatch callback, accumulate results
 *   - 'final'   : top-4 single-elimination bracket (semifinals + final)
 *   - 'done'    : final podium + W/L recap
 *
 * Match execution itself lives outside this panel — caller passes
 * `onPlayMatch(pair) → Promise<aggregateWinner>` so the panel stays UI-only
 * and can be tested without Pyodide. A bye round is auto-scored (handled by
 * the swiss algorithm itself, no callback fires).
 */

import {
  applyMatchResult,
  generateNextRound,
  leaderboard,
  makeEntrant,
  points,
  type Entrant,
  type MatchPair,
  type RoundPairing,
} from './swiss';

export type Phase = 'upload' | 'round' | 'final' | 'done';

export interface MatchProgress {
  readonly pair: MatchPair;
  readonly index: number;
  readonly total: number;
}

export interface TournamentPanelOptions {
  /** Run a single home-and-away match and return the aggregate winner. */
  readonly onPlayMatch?: (
    pair: MatchPair,
    progress: MatchProgress,
  ) => Promise<'A' | 'B' | null>;
  readonly onError?: (err: Error) => void;
  /** Number of Swiss preliminary rounds before the top-4 final. Default 4. */
  readonly preliminaryRounds?: number;
  /** Number of finalists (single elimination bracket). Default 4. */
  readonly finalistCount?: number;
}

export interface TournamentPanelHandle {
  readonly root: HTMLElement;
  show(): void;
  hide(): void;
  dispose(): void;
}

interface RoundRecord {
  readonly round: number;
  readonly pairing: RoundPairing;
  /** aggregateWinner per pair, in the same order as pairing.pairs. null = match not yet played. */
  results: ('A' | 'B' | null | 'pending')[];
}

interface BracketMatch {
  readonly label: string;
  readonly a: Entrant;
  readonly b: Entrant;
  /** Seed indices (0-based, lower = higher seed). Used as the tiebreak when
   *  the aggregate result is a draw — the higher seed advances. */
  readonly aSeed: number;
  readonly bSeed: number;
  result: 'A' | 'B' | null | 'pending';
}

interface FinalBracket {
  readonly seeds: readonly Entrant[];
  /** Two semifinal matches, in display order (top → bottom). */
  semis: [BracketMatch, BracketMatch];
  /** The final — populated once both semis are decided. */
  final: BracketMatch | null;
  /** Optional 3rd-place playoff (instructor toggle). */
  third: BracketMatch | null;
  /** Whether the third-place playoff is enabled. */
  thirdEnabled: boolean;
  /** Final ranking once everything's done. */
  podium: Entrant[] | null;
}

function effectiveWinner(m: BracketMatch): Entrant {
  if (m.result === 'A') return m.a;
  if (m.result === 'B') return m.b;
  // Draw OR not yet played — fall back to higher seed (lower index).
  return m.aSeed <= m.bSeed ? m.a : m.b;
}

export function mountTournamentPanel(
  parent: HTMLElement,
  options: TournamentPanelOptions = {},
): TournamentPanelHandle {
  const PRELIM_ROUNDS = options.preliminaryRounds ?? 4;
  const FINALIST_COUNT = options.finalistCount ?? 4;
  // Pacing for the auto-progression dashboard interlude. Lets spectators
  // absorb pairings/standings before the next match auto-starts.
  const INTER_MATCH_HOLD_MS = 3000;
  const INTER_ROUND_HOLD_MS = 6000;
  // 한 매치 (홈+어웨이 두 leg 합산) 가 N분 넘게 걸리면 draw 로 강제 종료.
  // pathological 봇 (무한 루프 / 30라운드 stalemate × 느린 Pyodide) 으로 인해
  // 토너먼트 진행이 멈추는 걸 방지. 워커는 백그라운드에서 계속 돌지만 UI 는
  // 즉시 다음 매치로 넘어감. 진짜 정상 매치는 보통 30초~3분 내.
  const MATCH_TIMEOUT_MS = 5 * 60 * 1000;  // 5분

  const root = document.createElement('div');
  root.className = 'maehwa-tourney';
  root.innerHTML = `
    <style>
      .maehwa-tourney {
        /* max-height: 팀-A 패널이 top:60 부터 시작해 ~310px 까지 점유하므로
           토너먼트 패널 top 이 320 아래로 내려오도록 제한. 노트북(800h) 기준
           max-height ~388 → 충분히 콘텐츠 표시 + 내부 스크롤. */
        position: fixed; left: 18px; bottom: 92px; width: 340px;
        max-height: calc(100vh - 412px);
        background: rgba(10, 14, 24, 0.92);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 10px;
        padding: 14px 14px 12px;
        font: 13px/1.4 'Pretendard Variable', 'Galmuri11', system-ui, sans-serif;
        color: #e8eaf0;
        backdrop-filter: blur(10px);
        z-index: 10;
        display: none;
        overflow-y: auto;
      }
      .maehwa-tourney.open { display: block; }
      .maehwa-tourney h3 {
        margin: 0 0 10px; font-size: 13px; font-weight: 600;
        letter-spacing: 0.02em;
      }
      .maehwa-tourney .phase-label {
        font-size: 11px; opacity: 0.7; margin-bottom: 8px;
        text-transform: uppercase; letter-spacing: 0.08em;
      }
      .maehwa-tourney label.upload-label {
        display: block; padding: 14px; margin-bottom: 10px;
        border: 1px dashed rgba(255, 255, 255, 0.25);
        border-radius: 8px; text-align: center; cursor: pointer;
        font-size: 12px; opacity: 0.85;
      }
      .maehwa-tourney label.upload-label:hover { border-color: #ffb84d; opacity: 1; }
      .maehwa-tourney input[type="file"] { display: none; }
      .maehwa-tourney .entrant-list {
        list-style: none; padding: 0; margin: 0 0 10px;
        max-height: 160px; overflow-y: auto;
        border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: 6px;
      }
      .maehwa-tourney .entrant-list li {
        display: flex; justify-content: space-between; align-items: center;
        padding: 5px 8px; font-size: 12px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      }
      .maehwa-tourney .entrant-list li:last-child { border-bottom: 0; }
      .maehwa-tourney .entrant-remove {
        background: transparent; border: 0; color: #ff7878;
        cursor: pointer; padding: 0 4px; font-size: 13px;
      }
      .maehwa-tourney button.action {
        width: 100%; margin-top: 4px; padding: 8px;
        background: #ffb84d; color: #0b0f1a;
        border: 0; border-radius: 6px; font-weight: 600; cursor: pointer;
      }
      .maehwa-tourney button.action:disabled { opacity: 0.45; cursor: default; }
      .maehwa-tourney button.secondary {
        width: 100%; margin-top: 6px; padding: 7px;
        background: rgba(255, 255, 255, 0.07);
        color: #e8eaf0;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 6px; cursor: pointer;
      }
      .maehwa-tourney .round-header {
        display: flex; justify-content: space-between; align-items: center;
        font-weight: 600; font-size: 12px; margin: 10px 0 6px;
      }
      .maehwa-tourney .pair-card {
        display: grid; grid-template-columns: 1fr 30px 1fr 18px;
        gap: 6px; align-items: center;
        padding: 6px 8px; margin-bottom: 4px;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: 6px; font-size: 12px;
      }
      .maehwa-tourney .pair-card.playing {
        border-color: #ffb84d; box-shadow: 0 0 8px rgba(255, 184, 77, 0.3);
      }
      .maehwa-tourney .pair-card.done {
        opacity: 0.85;
      }
      .maehwa-tourney .pair-card .vs { text-align: center; opacity: 0.5; }
      .maehwa-tourney .pair-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .maehwa-tourney .pair-name.winner { color: #ffce8a; font-weight: 600; }
      .maehwa-tourney .pair-name.loser { color: #888; text-decoration: line-through; }
      .maehwa-tourney .pair-status { text-align: right; font-size: 11px; opacity: 0.7; }
      .maehwa-tourney .leaderboard {
        margin-top: 10px; padding-top: 8px;
        border-top: 1px solid rgba(255, 255, 255, 0.08);
      }
      .maehwa-tourney .leaderboard h4 {
        margin: 0 0 6px; font-size: 11px; font-weight: 600; opacity: 0.75;
        text-transform: uppercase; letter-spacing: 0.08em;
      }
      .maehwa-tourney .leader-row {
        display: grid; grid-template-columns: 22px 1fr auto;
        gap: 6px; padding: 3px 0; font-size: 12px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.03);
      }
      .maehwa-tourney .leader-row.bye-this-round { opacity: 0.7; }
      .maehwa-tourney .leader-row .rank { opacity: 0.6; text-align: right; }
      .maehwa-tourney .leader-row .pts { font-variant-numeric: tabular-nums; opacity: 0.85; }
      .maehwa-tourney .bye-note {
        font-size: 11px; opacity: 0.7; padding: 6px 8px;
        background: rgba(255, 255, 255, 0.03); border-radius: 6px;
        margin-bottom: 4px;
      }
      .maehwa-tourney .status-line {
        margin-top: 8px; min-height: 16px; font-size: 11px;
        opacity: 0.85;
      }
      .maehwa-tourney .status-line.error { color: #ff7878; opacity: 1; }
      .maehwa-tourney .legend-tip {
        font-size: 10px; opacity: 0.55; font-weight: 400;
        letter-spacing: 0.04em; margin-left: 6px;
      }

      /* ── Final bracket tree (renderFinal) ─────────────────────────── */
      .maehwa-tourney .bracket-tree {
        display: flex; flex-direction: column; align-items: center;
        padding: 4px 0 8px;
      }
      .maehwa-tourney .bracket-row-semis {
        display: grid; grid-template-columns: 1fr 1fr;
        gap: 12px; width: 100%;
      }
      .maehwa-tourney .bracket-match {
        display: flex; flex-direction: column;
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.04);
        overflow: hidden;
        min-width: 0;
      }
      .maehwa-tourney .bracket-match.playing {
        border-color: #ffb84d;
        animation: maehwa-bracket-pulse 1.4s ease-in-out infinite;
      }
      .maehwa-tourney .bracket-match.done .seed-row.winner {
        background: rgba(255, 206, 138, 0.10);
      }
      .maehwa-tourney .bracket-match-label {
        font-size: 9.5px; opacity: 0.55; padding: 2px 6px;
        background: rgba(0, 0, 0, 0.3);
        letter-spacing: 0.06em; text-transform: uppercase;
      }
      .maehwa-tourney .seed-row {
        display: grid; grid-template-columns: 16px 1fr;
        gap: 6px; padding: 4px 8px;
        font-size: 11.5px; min-width: 0;
      }
      .maehwa-tourney .seed-row + .seed-row {
        border-top: 1px solid rgba(255, 255, 255, 0.05);
      }
      .maehwa-tourney .seed-num {
        opacity: 0.5; font-size: 10px; text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .maehwa-tourney .seed-name {
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .maehwa-tourney .seed-name.winner { color: #ffce8a; font-weight: 600; }
      .maehwa-tourney .seed-name.loser { color: #777; text-decoration: line-through; opacity: 0.65; }
      .maehwa-tourney .seed-name.empty { color: rgba(255, 255, 255, 0.25); font-style: italic; }

      /* H-shaped connector: two semis → final */
      .maehwa-tourney .bracket-connector-h {
        position: relative; width: 100%; height: 18px;
      }
      .maehwa-tourney .bracket-connector-h::before {
        content: ''; position: absolute;
        top: 0; left: 25%; right: 25%; height: 1.5px;
        background: rgba(255, 184, 77, 0.4);
      }
      .maehwa-tourney .bracket-connector-h::after {
        content: ''; position: absolute;
        top: 0; bottom: 0; left: 50%; transform: translateX(-50%);
        width: 1.5px; background: rgba(255, 184, 77, 0.4);
      }
      /* Single vertical line: final → champion */
      .maehwa-tourney .bracket-connector-v {
        width: 1.5px; height: 16px;
        background: rgba(255, 184, 77, 0.4);
      }

      .maehwa-tourney .bracket-match.bracket-final {
        width: 65%; border-color: rgba(255, 184, 77, 0.4);
      }
      .maehwa-tourney .bracket-champion {
        margin-top: 0; padding: 8px 18px;
        background: linear-gradient(135deg, rgba(255, 206, 138, 0.20), rgba(255, 184, 77, 0.10));
        border: 1px solid rgba(255, 206, 138, 0.55);
        border-radius: 999px;
        font-size: 13px; font-weight: 700; color: #ffce8a;
        display: inline-flex; align-items: center; gap: 8px;
        box-shadow: 0 0 12px rgba(255, 184, 77, 0.25);
      }
      .maehwa-tourney .bracket-champion.pending {
        background: rgba(255, 255, 255, 0.04);
        border-color: rgba(255, 255, 255, 0.1);
        color: rgba(255, 255, 255, 0.45);
        font-weight: 500; box-shadow: none;
      }
      .maehwa-tourney .bracket-third-block {
        margin-top: 14px; padding-top: 10px; width: 100%;
        border-top: 1px dashed rgba(255, 255, 255, 0.08);
      }
      .maehwa-tourney .bracket-third-label {
        font-size: 10px; opacity: 0.55; margin-bottom: 6px;
        letter-spacing: 0.06em; text-transform: uppercase; text-align: center;
      }
      .maehwa-tourney .bracket-third-block .bracket-match { width: 65%; margin: 0 auto; }
      @keyframes maehwa-bracket-pulse {
        0%, 100% { box-shadow: 0 0 8px rgba(255, 184, 77, 0.3); }
        50% { box-shadow: 0 0 14px rgba(255, 184, 77, 0.55); }
      }

      /* ── Inter-match / inter-round interlude ──────────────────────── */
      .maehwa-tourney .interlude-card {
        margin-top: 10px; padding: 12px 10px 10px;
        background: linear-gradient(135deg, rgba(255, 184, 77, 0.12), rgba(255, 184, 77, 0.04));
        border: 1px solid rgba(255, 184, 77, 0.40);
        border-radius: 8px; text-align: center;
        animation: maehwa-interlude-pulse 1.6s ease-in-out infinite;
      }
      .maehwa-tourney .interlude-label {
        font-size: 10.5px; opacity: 0.85;
        letter-spacing: 0.06em; text-transform: uppercase;
      }
      .maehwa-tourney .interlude-countdown {
        font-size: 30px; font-weight: 700;
        color: #ffce8a; line-height: 1;
        font-variant-numeric: tabular-nums;
        margin: 4px 0 2px;
      }
      .maehwa-tourney .interlude-skip {
        font-size: 10px; opacity: 0.6;
        cursor: pointer; letter-spacing: 0.04em;
        user-select: none;
      }
      .maehwa-tourney .interlude-skip:hover { opacity: 1; color: #ffce8a; }
      @keyframes maehwa-interlude-pulse {
        0%, 100% { box-shadow: 0 0 0 rgba(255, 184, 77, 0); }
        50% { box-shadow: 0 0 12px rgba(255, 184, 77, 0.30); }
      }

      /* ── Rank-change delta chip (vs round-start snapshot) ─────────── */
      .maehwa-tourney .rank-delta {
        display: inline-block; margin-left: 6px;
        font-size: 9.5px; font-weight: 700;
        padding: 1px 4px; border-radius: 3px;
        font-variant-numeric: tabular-nums;
        vertical-align: 1px;
      }
      .maehwa-tourney .rank-delta.up   { color: #6dd99a; background: rgba(109, 217, 154, 0.16); }
      .maehwa-tourney .rank-delta.down { color: #ff7878; background: rgba(255, 120, 120, 0.16); }
      .maehwa-tourney .rank-delta.same { color: rgba(255, 255, 255, 0.30); background: transparent; }
    </style>
    <h3>🏆 토너먼트 운영</h3>
    <div class="phase-label">대기 중</div>
    <div class="body"></div>
    <div class="status-line"></div>
  `;
  parent.appendChild(root);

  const phaseLabel = root.querySelector<HTMLElement>('.phase-label')!;
  const body = root.querySelector<HTMLElement>('.body')!;
  const statusLine = root.querySelector<HTMLElement>('.status-line')!;

  // ─── State ────────────────────────────────────────────────────────────
  let phase: Phase = 'upload';
  const entrants: Entrant[] = [];
  const history: RoundRecord[] = [];
  let activeRound: RoundRecord | null = null;
  let bracket: FinalBracket | null = null;
  let busy = false;
  // Active dashboard interlude (countdown card replacing action buttons).
  // null when no pause is in flight.
  let interlude: { kind: 'inter-match' | 'inter-round'; endsAt: number; cancel: () => void } | null = null;
  // Snapshot of leaderboard ranks at the moment the current round started.
  // Used to render ▲/▼ rank-change chips that accumulate across the round.
  let roundStartRanks: Map<string, number> | null = null;

  function captureRoundStartRanks(): void {
    const lb = leaderboard(entrants);
    roundStartRanks = new Map(lb.map((e, i) => [e.id, i]));
  }

  function holdInterlude(kind: 'inter-match' | 'inter-round'): Promise<void> {
    return new Promise((resolve) => {
      const dur = kind === 'inter-match' ? INTER_MATCH_HOLD_MS : INTER_ROUND_HOLD_MS;
      let done = false;
      let timerId: number | null = null;
      let frameId: number | null = null;
      const finish = (): void => {
        if (done) return;
        done = true;
        interlude = null;
        if (timerId !== null) clearTimeout(timerId);
        if (frameId !== null) cancelAnimationFrame(frameId);
        window.removeEventListener('keydown', onKey);
        render();
        resolve();
      };
      const onKey = (e: KeyboardEvent): void => {
        if (e.code === 'Space' || e.code === 'Enter') {
          e.preventDefault();
          finish();
        }
      };
      interlude = { kind, endsAt: performance.now() + dur, cancel: finish };
      window.addEventListener('keydown', onKey);
      timerId = window.setTimeout(finish, dur);
      const tick = (): void => {
        if (done || !interlude) return;
        const cd = body.querySelector<HTMLElement>('.interlude-countdown');
        if (cd) {
          const remaining = Math.max(0, Math.ceil((interlude.endsAt - performance.now()) / 1000));
          cd.textContent = String(remaining);
        }
        frameId = requestAnimationFrame(tick);
      };
      render();
      frameId = requestAnimationFrame(tick);
    });
  }

  function setStatus(msg: string, isError = false): void {
    statusLine.textContent = msg;
    statusLine.classList.toggle('error', isError);
  }

  function setPhase(p: Phase): void {
    phase = p;
    phaseLabel.textContent =
      p === 'upload' ? '단계 1 — 출전자 등록'
      : p === 'round' ? `단계 2 — 예선 라운드 ${activeRound?.round ?? '?'} / ${PRELIM_ROUNDS}`
      : p === 'final' ? '단계 3 — 결선 토너먼트'
      : '완료';
    render();
  }

  // ─── Upload phase ─────────────────────────────────────────────────────
  function renderUpload(): void {
    body.innerHTML = `
      <label class="upload-label">
        <input type="file" multiple accept=".py" />
        에이전트 .py 파일 선택 (여러 개)
      </label>
      <ul class="entrant-list"></ul>
      <button class="action start-btn" disabled>토너먼트 시작</button>
    `;
    const fileInput = body.querySelector<HTMLInputElement>('input[type="file"]')!;
    const list = body.querySelector<HTMLUListElement>('.entrant-list')!;
    const startBtn = body.querySelector<HTMLButtonElement>('.start-btn')!;

    function refreshList(): void {
      list.innerHTML = entrants
        .map(
          (e) => `
        <li>
          <span>${escapeHtml(e.name)}</span>
          <button class="entrant-remove" data-id="${escapeHtml(e.id)}" title="제거">✕</button>
        </li>`,
        )
        .join('');
      list.querySelectorAll<HTMLButtonElement>('.entrant-remove').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.dataset['id']!;
          const idx = entrants.findIndex((e) => e.id === id);
          if (idx >= 0) entrants.splice(idx, 1);
          refreshList();
          updateStartBtn();
        });
      });
    }

    function updateStartBtn(): void {
      startBtn.disabled = entrants.length < 2;
      startBtn.textContent = entrants.length < 2
        ? `최소 2명 (현재 ${entrants.length})`
        : `토너먼트 시작 (${entrants.length}명)`;
    }

    fileInput.addEventListener('change', async () => {
      const files = Array.from(fileInput.files ?? []);
      for (const file of files) {
        const text = await file.text();
        const stem = file.name.replace(/\.py$/i, '');
        // Avoid duplicate names by suffixing.
        let unique = stem;
        let n = 2;
        while (entrants.some((e) => e.name === unique)) {
          unique = `${stem}_${n++}`;
        }
        const id = `${unique}-${entrants.length}`;
        entrants.push(makeEntrant(id, unique, text));
      }
      fileInput.value = '';
      refreshList();
      updateStartBtn();
    });

    startBtn.addEventListener('click', () => {
      startNextRound();
    });

    refreshList();
    updateStartBtn();
  }

  // ─── Round phase ──────────────────────────────────────────────────────
  function startNextRound(): void {
    const roundNum = history.length + 1;
    captureRoundStartRanks();
    const pairing = generateNextRound(roundNum, entrants);
    const record: RoundRecord = {
      round: roundNum,
      pairing,
      results: pairing.pairs.map(() => 'pending' as const),
    };
    history.push(record);
    activeRound = record;
    setPhase('round');
  }

  function renderRound(): void {
    if (activeRound === null) {
      body.innerHTML = '<p style="opacity:0.7; font-size:12px;">활성 라운드 없음</p>';
      return;
    }
    const r = activeRound;
    const pendingIdx = r.results.findIndex((x) => x === 'pending');
    const allDone = pendingIdx === -1;

    const byeBlock = r.pairing.bye
      ? `<div class="bye-note">부전승: <b>${escapeHtml(r.pairing.bye.name)}</b> (자동 1승)</div>`
      : '';

    const pairsHtml = r.pairing.pairs
      .map((pair, i) => {
        const status = r.results[i];
        const isPlaying = status === 'pending' && i === pendingIdx && busy;
        const isDone = status !== 'pending';
        const aWin = status === 'A';
        const bWin = status === 'B';
        const aClass = isDone ? (aWin ? 'winner' : bWin ? 'loser' : '') : '';
        const bClass = isDone ? (bWin ? 'winner' : aWin ? 'loser' : '') : '';
        const cls = ['pair-card'];
        if (isPlaying) cls.push('playing');
        if (isDone) cls.push('done');
        const statusText = isPlaying ? '진행 중'
          : isDone ? (status === null ? '무승부' : '승')
          : `${i + 1}/${r.pairing.pairs.length}`;
        return `
          <div class="${cls.join(' ')}">
            <span class="pair-name ${aClass}">${escapeHtml(pair.a.name)}</span>
            <span class="vs">vs</span>
            <span class="pair-name ${bClass}">${escapeHtml(pair.b.name)}</span>
            <span class="pair-status">${statusText}</span>
          </div>`;
      })
      .join('');

    const interludeCard = interlude ? renderInterludeCard() : '';
    const controls = interlude
      ? ''
      : busy
      ? `<button class="action" disabled>매치 진행 중…</button>`
      : allDone
      ? (history.length >= PRELIM_ROUNDS
          ? `<button class="action proceed-btn">결선 진출 (상위 ${FINALIST_COUNT}명)</button>`
          : `<button class="action proceed-btn">다음 라운드</button>`)
      : `<button class="action play-next-btn">▶ 다음 매치 시작</button>
         <button class="secondary play-all-btn">⏩ 라운드 끝까지 자동 진행</button>`;

    body.innerHTML = `
      <div class="round-header">
        <span>예선 라운드 ${r.round} / ${PRELIM_ROUNDS}</span>
        <span style="font-size:11px; opacity:0.7;">${r.pairing.pairs.length} 매치</span>
      </div>
      ${byeBlock}
      ${pairsHtml}
      ${interludeCard}
      ${controls}
      ${renderLeaderboard()}
    `;

    body.querySelector<HTMLButtonElement>('.play-next-btn')?.addEventListener('click', () => {
      void playNextMatch(false);
    });
    body.querySelector<HTMLButtonElement>('.play-all-btn')?.addEventListener('click', () => {
      void playNextMatch(true);
    });
    body.querySelector<HTMLButtonElement>('.proceed-btn')?.addEventListener('click', () => {
      // 라운드/결선 진입은 사용자가 명시적으로 버튼을 눌러 트리거하므로 별도
      // 카운트다운(inter-round) 을 띄우지 않음 — 누른 직후 추가 대기는 노이즈.
      // 매치 자동 연쇄(playNextMatch) 의 inter-match 카운트만 유지.
      if (busy || interlude) return;
      const isFinalTransition = history.length >= PRELIM_ROUNDS;
      if (isFinalTransition) {
        startFinal();
      } else {
        startNextRound();
      }
    });
    body.querySelector<HTMLElement>('.interlude-skip')?.addEventListener('click', () => {
      interlude?.cancel();
    });
  }

  function startFinal(): void {
    const seeds = leaderboard(entrants).slice(0, FINALIST_COUNT);
    if (seeds.length < FINALIST_COUNT) {
      setStatus(`결선 진행에는 ${FINALIST_COUNT}명 이상 필요합니다 (현재 ${seeds.length}).`, true);
      return;
    }
    // Standard 4-seed bracket: 1 vs 4, 2 vs 3.
    bracket = {
      seeds,
      semis: [
        { label: '준결승 1 (1 vs 4)', a: seeds[0]!, b: seeds[3]!, aSeed: 0, bSeed: 3, result: 'pending' },
        { label: '준결승 2 (2 vs 3)', a: seeds[1]!, b: seeds[2]!, aSeed: 1, bSeed: 2, result: 'pending' },
      ],
      final: null,
      third: null,
      thirdEnabled: false,
      podium: null,
    };
    setPhase('final');
  }

  function nextPendingBracketMatch(): { match: BracketMatch; key: string } | null {
    if (!bracket) return null;
    if (bracket.semis[0].result === 'pending') return { match: bracket.semis[0], key: 'sf1' };
    if (bracket.semis[1].result === 'pending') return { match: bracket.semis[1], key: 'sf2' };
    if (bracket.final && bracket.final.result === 'pending') return { match: bracket.final, key: 'final' };
    if (bracket.third && bracket.third.result === 'pending') return { match: bracket.third, key: 'third' };
    return null;
  }

  function maybeAdvanceBracket(): void {
    if (!bracket) return;
    // Once both semis are done, materialize the final.
    if (bracket.final === null
        && bracket.semis[0].result !== 'pending'
        && bracket.semis[1].result !== 'pending') {
      const f1 = effectiveWinner(bracket.semis[0]);
      const f2 = effectiveWinner(bracket.semis[1]);
      bracket.final = {
        label: '결승',
        a: f1, b: f2,
        aSeed: bracket.seeds.indexOf(f1),
        bSeed: bracket.seeds.indexOf(f2),
        result: 'pending',
      };
      // If 3rd-place enabled, also seed the playoff with the two semi losers.
      if (bracket.thirdEnabled && bracket.third === null) {
        const l1 = bracket.semis[0].a === f1 ? bracket.semis[0].b : bracket.semis[0].a;
        const l2 = bracket.semis[1].a === f2 ? bracket.semis[1].b : bracket.semis[1].a;
        bracket.third = {
          label: '3·4위전',
          a: l1, b: l2,
          aSeed: bracket.seeds.indexOf(l1),
          bSeed: bracket.seeds.indexOf(l2),
          result: 'pending',
        };
      }
    }
    // Once everything's resolved, build the podium.
    const finalDone = bracket.final !== null && bracket.final.result !== 'pending';
    const thirdDone = !bracket.thirdEnabled || (bracket.third !== null && bracket.third.result !== 'pending');
    if (finalDone && thirdDone && bracket.podium === null) {
      const champ = effectiveWinner(bracket.final!);
      const runnerUp = champ === bracket.final!.a ? bracket.final!.b : bracket.final!.a;
      const podium: Entrant[] = [champ, runnerUp];
      if (bracket.thirdEnabled && bracket.third) {
        const third = effectiveWinner(bracket.third);
        const fourth = third === bracket.third.a ? bracket.third.b : bracket.third.a;
        podium.push(third, fourth);
      } else {
        // No playoff — push both semi losers in seed order so the rendering
        // shows "tied 3rd" honestly.
        const semiLosers = [
          bracket.semis[0].a === effectiveWinner(bracket.semis[0]) ? bracket.semis[0].b : bracket.semis[0].a,
          bracket.semis[1].a === effectiveWinner(bracket.semis[1]) ? bracket.semis[1].b : bracket.semis[1].a,
        ];
        semiLosers.sort((x, y) => bracket!.seeds.indexOf(x) - bracket!.seeds.indexOf(y));
        podium.push(...semiLosers);
      }
      bracket.podium = podium;
    }
  }

  async function playNextBracketMatch(): Promise<void> {
    if (busy || !bracket) return;
    if (!options.onPlayMatch) {
      setStatus('매치 실행 콜백이 연결되지 않았습니다.', true);
      return;
    }
    const next = nextPendingBracketMatch();
    if (!next) return;
    busy = true;
    render();
    try {
      // 매치 timeout 가드 — 결선도 동일 (5분 넘으면 시드 우선 무승부 → 상위 시드 진출).
      const timeoutSentinel = Symbol('match-timeout');
      const winner = await Promise.race([
        options.onPlayMatch(
          { a: next.match.a, b: next.match.b },
          { pair: { a: next.match.a, b: next.match.b }, index: 0, total: 1 },
        ),
        new Promise<typeof timeoutSentinel>((resolve) =>
          setTimeout(() => resolve(timeoutSentinel), MATCH_TIMEOUT_MS),
        ),
      ]);
      const finalWinner: 'A' | 'B' | null = winner === timeoutSentinel ? null : winner;
      if (winner === timeoutSentinel) {
        setStatus(`결선 매치 시간 초과 — 무승부 (시드 우선 진출)`, true);
      }
      next.match.result = finalWinner;
      // Bracket matches don't update Swiss W/L (entrants' season totals are
      // already final at this point) — only the bracket's own state advances.
      busy = false;
      maybeAdvanceBracket();
      if (bracket.podium !== null) setPhase('done');
      else render();
    } catch (err) {
      busy = false;
      const e = err instanceof Error ? err : new Error(String(err));
      setStatus(`매치 실패: ${e.message}`, true);
      options.onError?.(e);
      render();
    }
  }

  function renderLeaderboard(): string {
    if (entrants.length === 0) return '';
    const lb = leaderboard(entrants);
    const byeIds = activeRound?.pairing.bye ? [activeRound.pairing.bye.id] : [];
    return `
      <div class="leaderboard">
        <h4>현재 순위 <span class="legend-tip">승-무-패 · 점수</span></h4>
        ${lb
          .map((e, i) => {
            const isBye = byeIds.includes(e.id);
            const prev = roundStartRanks?.get(e.id);
            // delta > 0 = climbed (lower index = better rank).
            const delta = prev === undefined ? null : prev - i;
            const deltaHtml =
              delta === null ? ''
              : delta > 0 ? `<span class="rank-delta up">▲${delta}</span>`
              : delta < 0 ? `<span class="rank-delta down">▼${-delta}</span>`
              : '';
            return `
            <div class="leader-row ${isBye ? 'bye-this-round' : ''}">
              <span class="rank">${i + 1}</span>
              <span>${escapeHtml(e.name)}${isBye ? ' (부전승)' : ''}${deltaHtml}</span>
              <span class="pts">${e.wins}-${e.draws}-${e.losses} · ${points(e).toFixed(1)}pt</span>
            </div>`;
          })
          .join('')}
      </div>`;
  }

  function renderInterludeCard(): string {
    if (!interlude) return '';
    const remaining = Math.max(1, Math.ceil((interlude.endsAt - performance.now()) / 1000));
    const label = interlude.kind === 'inter-match' ? '다음 매치까지' : '다음 라운드까지';
    return `
      <div class="interlude-card">
        <div class="interlude-label">${label}</div>
        <div class="interlude-countdown">${remaining}</div>
        <div class="interlude-skip" title="Space로 즉시 진행">⏭ 즉시 진행 (Space)</div>
      </div>`;
  }

  async function playNextMatch(autoContinue: boolean): Promise<void> {
    if (activeRound === null || busy || interlude) return;
    if (!options.onPlayMatch) {
      setStatus('매치 실행 콜백이 연결되지 않았습니다.', true);
      return;
    }
    const r = activeRound;
    const idx = r.results.findIndex((x) => x === 'pending');
    if (idx === -1) return;
    busy = true;
    render();
    try {
      // 매치 timeout 가드 — 5분 넘으면 draw 강제 종료 (워커는 백그라운드 진행).
      const timeoutSentinel = Symbol('match-timeout');
      const winner = await Promise.race([
        options.onPlayMatch(r.pairing.pairs[idx]!, {
          pair: r.pairing.pairs[idx]!,
          index: idx,
          total: r.pairing.pairs.length,
        }),
        new Promise<typeof timeoutSentinel>((resolve) =>
          setTimeout(() => resolve(timeoutSentinel), MATCH_TIMEOUT_MS),
        ),
      ]);
      const finalWinner: 'A' | 'B' | null = winner === timeoutSentinel ? null : winner;
      if (winner === timeoutSentinel) {
        setStatus(`매치 시간 초과 (${MATCH_TIMEOUT_MS / 60000}분) — 무승부 처리`, true);
      }
      r.results[idx] = finalWinner;
      applyMatchResult(r.pairing.pairs[idx]!, finalWinner);
      busy = false;
      // Auto-cascade with a dashboard interlude. Skipping render() before
      // holdInterlude — the interlude itself renders the countdown card with
      // the just-updated state, avoiding a button-flash between matches.
      if (autoContinue && r.results.some((x) => x === 'pending')) {
        await holdInterlude('inter-match');
        await playNextMatch(true);
      } else {
        render();
      }
    } catch (err) {
      busy = false;
      const e = err instanceof Error ? err : new Error(String(err));
      setStatus(`매치 실패: ${e.message}`, true);
      options.onError?.(e);
      render();
    }
  }

  // ─── Final bracket ────────────────────────────────────────────────────
  /**
   * Render a single bracket match as a stacked seed-row card. Each row carries
   * the seed number (1-4 across the bracket) + name; winner gets gold tint,
   * loser gets struck through. Empty cards (final 결정 전) show "대기 중".
   */
  function renderBracketCard(m: BracketMatch | null, opts: {
    label?: string;
    extraClass?: string;
  } = {}): string {
    const cls = ['bracket-match'];
    if (opts.extraClass) cls.push(opts.extraClass);
    const labelHtml = opts.label
      ? `<div class="bracket-match-label">${escapeHtml(opts.label)}</div>`
      : '';
    if (m === null) {
      return `<div class="${cls.join(' ')}" style="opacity:0.5">
        ${labelHtml}
        <div class="seed-row"><span class="seed-num">·</span><span class="seed-name empty">대기 중</span></div>
        <div class="seed-row"><span class="seed-num">·</span><span class="seed-name empty">대기 중</span></div>
      </div>`;
    }
    const playing = busy && nextPendingBracketMatch()?.match === m;
    const done = m.result !== 'pending';
    const winnerEntrant = done ? effectiveWinner(m) : null;
    if (playing) cls.push('playing');
    if (done) cls.push('done');
    const aIsWinner = done && winnerEntrant === m.a;
    const bIsWinner = done && winnerEntrant === m.b;
    const aClass = done ? (aIsWinner ? 'winner' : 'loser') : '';
    const bClass = done ? (bIsWinner ? 'winner' : 'loser') : '';
    const aRowCls = aIsWinner ? 'seed-row winner' : 'seed-row';
    const bRowCls = bIsWinner ? 'seed-row winner' : 'seed-row';
    return `
      <div class="${cls.join(' ')}" data-bracket-key="${escapeHtml(m.label)}">
        ${labelHtml}
        <div class="${aRowCls}">
          <span class="seed-num">${m.aSeed + 1}</span>
          <span class="seed-name ${aClass}">${escapeHtml(m.a.name)}</span>
        </div>
        <div class="${bRowCls}">
          <span class="seed-num">${m.bSeed + 1}</span>
          <span class="seed-name ${bClass}">${escapeHtml(m.b.name)}</span>
        </div>
      </div>`;
  }

  function renderFinal(): void {
    if (!bracket) {
      body.innerHTML = '<p style="opacity:0.7; font-size:12px;">결선 데이터가 없습니다.</p>';
      return;
    }
    const next = nextPendingBracketMatch();
    const allDone = next === null;
    const thirdToggle = `
      <label style="display:flex; align-items:center; gap:6px; margin:10px 0 4px; font-size:11px; cursor:pointer;">
        <input type="checkbox" class="third-toggle" ${bracket.thirdEnabled ? 'checked' : ''}
          ${bracket.third !== null && bracket.third.result !== 'pending' ? 'disabled' : ''} />
        <span>3·4위전 활성화 (시간 여유 있을 때)</span>
      </label>`;

    const seedsList = bracket.seeds.map((e, i) => `
      <div class="leader-row">
        <span class="rank">${i + 1}</span>
        <span>${escapeHtml(e.name)}</span>
        <span class="pts">${e.wins}-${e.draws}-${e.losses} · ${points(e).toFixed(1)}pt</span>
      </div>`).join('');

    // Champion pill: glows once the final is decided, dimmed otherwise.
    const finalDecided = bracket.final !== null && bracket.final.result !== 'pending';
    const champEntrant = finalDecided ? effectiveWinner(bracket.final!) : null;
    const champPill = champEntrant
      ? `<div class="bracket-champion">🏆 ${escapeHtml(champEntrant.name)}</div>`
      : `<div class="bracket-champion pending">🏆 우승자 결정 중</div>`;

    const action = busy
      ? `<button class="action" disabled>매치 진행 중…</button>`
      : allDone
      ? `<button class="action proceed-done">최종 시상 보기</button>`
      : `<button class="action play-bracket-btn">▶ ${escapeHtml(next!.match.label)} 시작</button>`;

    const thirdBlock = bracket.thirdEnabled
      ? `<div class="bracket-third-block">
           <div class="bracket-third-label">3·4위전</div>
           ${renderBracketCard(bracket.third, { label: '3·4위전' })}
         </div>`
      : '';

    body.innerHTML = `
      <div class="round-header"><span>결선 진출 (시드 1-4)</span><span class="legend-tip">승-무-패 · 점수</span></div>
      ${seedsList}
      <div class="round-header" style="margin-top:14px"><span>대진표</span></div>
      <div class="bracket-tree">
        <div class="bracket-row-semis">
          ${renderBracketCard(bracket.semis[0], { label: '4강 1' })}
          ${renderBracketCard(bracket.semis[1], { label: '4강 2' })}
        </div>
        <div class="bracket-connector-h"></div>
        ${renderBracketCard(bracket.final, { label: '결승', extraClass: 'bracket-final' })}
        <div class="bracket-connector-v"></div>
        ${champPill}
        ${thirdBlock}
      </div>
      ${thirdToggle}
      ${action}
    `;

    body.querySelector<HTMLInputElement>('.third-toggle')?.addEventListener('change', (e) => {
      if (!bracket) return;
      bracket.thirdEnabled = (e.target as HTMLInputElement).checked;
      // If we're enabling AFTER both semis already done, materialize now.
      if (bracket.thirdEnabled
          && bracket.third === null
          && bracket.semis[0].result !== 'pending'
          && bracket.semis[1].result !== 'pending') {
        const w0 = effectiveWinner(bracket.semis[0]);
        const w1 = effectiveWinner(bracket.semis[1]);
        const l0 = bracket.semis[0].a === w0 ? bracket.semis[0].b : bracket.semis[0].a;
        const l1 = bracket.semis[1].a === w1 ? bracket.semis[1].b : bracket.semis[1].a;
        bracket.third = {
          label: '3·4위전',
          a: l0, b: l1,
          aSeed: bracket.seeds.indexOf(l0),
          bSeed: bracket.seeds.indexOf(l1),
          result: 'pending',
        };
        // Podium will be rebuilt next tick.
        bracket.podium = null;
      }
      render();
    });
    body.querySelector<HTMLButtonElement>('.play-bracket-btn')?.addEventListener('click', () => {
      void playNextBracketMatch();
    });
    body.querySelector<HTMLButtonElement>('.proceed-done')?.addEventListener('click', () => {
      maybeAdvanceBracket();
      if (bracket?.podium) setPhase('done');
    });
  }

  function renderDone(): void {
    const podium = bracket?.podium ?? leaderboard(entrants).slice(0, FINALIST_COUNT);
    const medals = ['🥇', '🥈', '🥉', '4️⃣'];
    body.innerHTML = `
      <div class="round-header"><span>🏆 최종 시상</span><span class="legend-tip">승-무-패</span></div>
      ${podium.map((e, i) => `
        <div class="leader-row" style="font-size:13px; padding:6px 0;">
          <span class="rank">${medals[i] ?? `${i + 1}`}</span>
          <span style="font-weight:${i === 0 ? 700 : 500}; ${i === 0 ? 'color:#ffce8a;' : ''}">${escapeHtml(e.name)}</span>
          <span class="pts">${e.wins}-${e.draws}-${e.losses}</span>
        </div>`).join('')}
      <div class="round-header" style="margin-top:14px"><span>예선 전체 순위</span></div>
      ${leaderboard(entrants).map((e, i) => `
        <div class="leader-row">
          <span class="rank">${i + 1}</span>
          <span>${escapeHtml(e.name)}</span>
          <span class="pts">${e.wins}-${e.draws}-${e.losses} · ${points(e).toFixed(1)}pt</span>
        </div>`).join('')}
    `;
  }

  function render(): void {
    switch (phase) {
      case 'upload': renderUpload(); break;
      case 'round':  renderRound();  break;
      case 'final':  renderFinal();  break;
      case 'done':   renderDone();   break;
    }
  }

  setPhase('upload');

  return {
    root,
    show() { root.classList.add('open'); },
    hide() { root.classList.remove('open'); },
    dispose() {
      interlude?.cancel();
      root.remove();
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] ?? ch),
  );
}
