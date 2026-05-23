import type { Frame, UnitState } from '../playback/timeline';
import type { ReplayMeta } from '../replay/types';

const UNIT_CLASS_KO: Record<UnitState['unitClass'], string> = {
  shield: '방패',
  rifle: '소총',
  dmr: '지정사수',
  medic: '의무병',
};

const GAUGE_MAX = 100;

export interface DisplayedHpSnapshot {
  readonly hp: number;
  readonly alive: boolean;
  readonly maxHp: number;
}

export interface StatusOverlayOptions {
  /** When provided, the overlay polls this each rAF tick to read the *displayed*
   *  hp/alive (lagging frame.units while the hit FX hasn't fired yet). Returns
   *  null when the unit isn't registered yet — caller falls back to frame value. */
  readonly getDisplayedHp?: (unitId: number) => DisplayedHpSnapshot | null;
  /** When set, the end-of-match banner fades out this many ms after the end
   *  frame is first shown. Used in 자유대전 (free match) so the result card
   *  doesn't sit on top of the field forever — tournament leaves it off so
   *  the audience can read the result until the next leg starts. */
  readonly endBannerAutoHideMs?: number;
}

export interface StatusOverlayHandle {
  readonly root: HTMLElement;
  update(frame: Frame): void;
  /** Show/hide the 🔴 LIVE badge in the top-right. */
  setLive(live: boolean): void;
  /**
   * Show "사고 중…" indicator when the player is at the latest available
   * frame in live mode (waiting for the agent to compute the next phase).
   */
  setThinking(thinking: boolean): void;
  dispose(): void;
}

export function mountStatusOverlay(
  parent: HTMLElement,
  meta: ReplayMeta,
  options: StatusOverlayOptions = {},
): StatusOverlayHandle {
  const root = document.createElement('div');
  root.className = 'maehwa-status';
  root.innerHTML = `
    <style>
      .maehwa-status {
        position: fixed; inset: 0; pointer-events: none;
        font: 13px/1.2 'Pretendard Variable', 'Galmuri11', system-ui, -apple-system, sans-serif;
        color: #e8eaf0;
        z-index: 20;
      }
      /* ── 양 팀 독립 게이지 (v4) — 두 줄 막대, 자기 팀이 0→100 으로 누적 ── */
      .maehwa-status .gauge {
        position: absolute; left: 50%; top: 50px; transform: translateX(-50%);
        width: min(520px, 60vw);
        display: flex; flex-direction: column; align-items: stretch; gap: 3px;
      }
      .maehwa-status .gauge-row {
        display: grid; grid-template-columns: 36px 1fr 40px;
        align-items: center; gap: 8px;
      }
      .maehwa-status .gauge-row-label {
        font-size: 11px; font-weight: 700; letter-spacing: 0.04em;
        opacity: 0.85;
      }
      .maehwa-status .gauge-row-a .gauge-row-label { color: #ffb29e; }
      .maehwa-status .gauge-row-b .gauge-row-label { color: #a9cbff; }
      .maehwa-status .gauge-track {
        position: relative; height: 12px; border-radius: 999px;
        background: rgba(10, 14, 24, 0.75);
        border: 1px solid rgba(255, 255, 255, 0.1);
        overflow: hidden;
      }
      .maehwa-status .gauge-fill {
        position: absolute; top: 0; bottom: 0; left: 0;
        transition: width 0.2s ease-out;
      }
      .maehwa-status .gauge-row-a .gauge-fill {
        background: linear-gradient(90deg, #ff4a27, #ff7b57);
      }
      .maehwa-status .gauge-row-b .gauge-fill {
        background: linear-gradient(90deg, #4b8fff, #6faeff);
      }
      .maehwa-status .gauge-row-a .gauge-fill.full,
      .maehwa-status .gauge-row-b .gauge-fill.full {
        animation: maehwa-gauge-full-pulse 0.8s ease-in-out infinite;
      }
      @keyframes maehwa-gauge-full-pulse {
        0%, 100% { box-shadow: 0 0 0 rgba(255, 255, 255, 0); }
        50% { box-shadow: inset 0 0 14px rgba(255, 255, 255, 0.6); }
      }
      .maehwa-status .gauge-row-num {
        font-size: 11px; font-weight: 700;
        font-variant-numeric: tabular-nums;
        text-align: right;
      }
      .maehwa-status .team {
        /* top: 60 — 좌상단 백버튼(top:16, height ~30) 영역(16-46) 과 겹치지
           않게 14px 마진 두고 시작. 게이지(top:56-84) 와는 가로 분리되어 OK. */
        position: absolute; top: 60px; width: 240px;
        background: rgba(10, 14, 24, 0.78);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 10px;
        padding: 10px 12px;
        backdrop-filter: blur(8px);
      }
      .maehwa-status .team-a { left: 18px; border-left: 3px solid #ff6b47; }
      .maehwa-status .team-b { right: 18px; border-right: 3px solid #4ba3ff; }
      .maehwa-status .team-header {
        display: flex; justify-content: space-between; align-items: center;
        margin-bottom: 8px; font-weight: 600;
      }
      .maehwa-status .team-a .team-header { color: #ffb29e; }
      .maehwa-status .team-b .team-header { color: #a9cbff; }
      /* ── 연속 타임아웃 누적 표시 (모듈형) ─────────────────────────
         룰북 §5.6 의 consecutive_timeout_limit=3. 팀 패널 본문 아래 별도 행으로
         3 깃발 점등. 신호등 단계: 0 회색/투명, 1 노랑, 2 주황, 3 빨강+빠른 펄스. */
      .maehwa-status .warn-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-top: 10px;
        padding: 8px 10px;
        background: rgba(0, 0, 0, 0.28);
        border-radius: 8px;
        border: 1px solid rgba(255, 255, 255, 0.05);
        transition: background 0.2s, border-color 0.2s;
      }
      .maehwa-status .warn-label {
        font-size: 11px; font-weight: 600;
        letter-spacing: 0.04em;
        color: rgba(255, 255, 255, 0.55);
        transition: color 0.2s;
      }
      .maehwa-status .warn-flags {
        display: flex; gap: 6px;
        font-variant-numeric: tabular-nums;
      }
      .maehwa-status .warn-flag {
        font-size: 22px; line-height: 1;
        filter: grayscale(1);
        opacity: 0.16;
        transition: opacity 0.25s, filter 0.25s, transform 0.25s;
        will-change: transform, opacity;
      }
      .maehwa-status .warn-flag.lit {
        filter: none;
        opacity: 1;
        animation: maehwa-warn-flag-pulse 1.0s ease-in-out infinite;
      }
      .maehwa-status .warn-row.warn-1 {
        border-color: rgba(255, 220, 100, 0.45);
      }
      .maehwa-status .warn-row.warn-1 .warn-label {
        color: #ffe48a;
      }
      .maehwa-status .warn-row.warn-2 {
        border-color: rgba(255, 160, 60, 0.55);
        background: rgba(255, 160, 60, 0.10);
      }
      .maehwa-status .warn-row.warn-2 .warn-label {
        color: #ffc788;
      }
      .maehwa-status .warn-row.warn-2 .warn-flag.lit {
        animation: maehwa-warn-flag-pulse 0.7s ease-in-out infinite;
      }
      .maehwa-status .warn-row.warn-3 {
        border-color: rgba(232, 60, 60, 0.75);
        background: rgba(232, 60, 60, 0.18);
        animation: maehwa-warn-row-flash 0.7s ease-in-out infinite;
      }
      .maehwa-status .warn-row.warn-3 .warn-label {
        color: #ff9a9a; font-weight: 800;
      }
      .maehwa-status .warn-row.warn-3 .warn-flag.lit {
        animation: maehwa-warn-flag-pulse 0.4s ease-in-out infinite;
      }
      @keyframes maehwa-warn-flag-pulse {
        0%, 100% { transform: scale(1) translateY(0); }
        50%      { transform: scale(1.18) translateY(-2px); }
      }
      @keyframes maehwa-warn-row-flash {
        0%, 100% { box-shadow: 0 0 0 rgba(232, 60, 60, 0); }
        50%      { box-shadow: 0 0 14px rgba(232, 60, 60, 0.55); }
      }
      .maehwa-status .unit-row {
        display: grid;
        grid-template-columns: 52px 1fr 40px;
        align-items: center;
        gap: 8px;
        padding: 3px 0;
        font-size: 12px;
      }
      .maehwa-status .unit-row.dead { opacity: 0.35; }
      .maehwa-status .unit-class { opacity: 0.9; }
      .maehwa-status .unit-hpbar {
        position: relative; height: 8px; border-radius: 4px;
        background: rgba(0, 0, 0, 0.55);
        overflow: hidden;
      }
      .maehwa-status .unit-hpbar-fill {
        position: absolute; top: 0; bottom: 0; left: 0;
        background: #7fdd63; transition: width 0.15s linear, background 0.15s linear;
      }
      .maehwa-status .unit-hp {
        font-variant-numeric: tabular-nums; font-size: 11px;
        text-align: right; opacity: 0.85;
      }
      /* LIVE 표시는 controlsOverlay 의 caption 에 통합돼 별도 배지는 항상 숨김.
         (이전엔 top:22 에 떠 있었지만 caption(top:18) 과 위치 충돌 → 동일 z-index
         + DOM 순서로 caption 이 가렸음. caption 안 LIVE 태그로 일원화.) */
      .maehwa-status .live-badge { display: none !important; }
      .maehwa-status .thinking {
        position: absolute; left: 50%; bottom: 110px; transform: translateX(-50%);
        display: none; align-items: center; gap: 10px;
        padding: 6px 14px; border-radius: 999px;
        background: rgba(10, 14, 24, 0.85);
        border: 1px solid rgba(255, 184, 77, 0.35);
        font-size: 12px; opacity: 0.95;
      }
      .maehwa-status .thinking.on { display: inline-flex; }
      .maehwa-status .thinking-timer {
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        font-size: 13px;
        color: #ffce8a;
        min-width: 36px; text-align: right;
        transition: color 0.2s;
      }
      .maehwa-status .thinking.urgent .thinking-timer { color: #ff8a55; }
      .maehwa-status .thinking.critical {
        border-color: rgba(232, 60, 60, 0.7);
        animation: maehwa-thinking-flash 0.5s ease-in-out infinite;
      }
      .maehwa-status .thinking.critical .thinking-timer { color: #ff7a7a; }
      @keyframes maehwa-thinking-flash {
        0%, 100% { box-shadow: 0 0 0 rgba(232, 60, 60, 0); }
        50%      { box-shadow: 0 0 12px rgba(232, 60, 60, 0.55); }
      }
      /* ── 매치 종료 결과 배너 (대형) ──────────────────────────
         end 프레임 도달 시 화면 중앙에 큰 결과 카드. 자동 패배(연속 타임아웃 /
         예외) 같은 결정적 결과는 빨강 + 흔들림으로 즉각 인지 유도. */
      .maehwa-status .end-banner {
        position: absolute; inset: 0;
        display: none; align-items: center; justify-content: center;
        pointer-events: none;
        opacity: 1;
        transition: opacity 0.6s ease;
      }
      .maehwa-status .end-banner.on { display: flex; }
      .maehwa-status .end-banner.fading { opacity: 0; }
      .maehwa-status .end-banner-card {
        padding: 32px 56px;
        background: rgba(10, 14, 24, 0.92);
        border: 2px solid rgba(255, 206, 138, 0.55);
        border-radius: 18px;
        text-align: center;
        backdrop-filter: blur(14px);
        box-shadow: 0 12px 48px rgba(0, 0, 0, 0.45),
                    0 0 0 1px rgba(255, 255, 255, 0.05) inset;
        animation: maehwa-end-pop 0.4s cubic-bezier(0.2, 1.2, 0.4, 1);
      }
      .maehwa-status .end-banner-icon {
        /* line-height 1 이면 🏁 막대기 같은 descender 영역이 line-box 밖으로 나가
           카드 padding 안에서 잘림. 1.2 로 여유 확보. */
        font-size: 56px; line-height: 1.2; margin-bottom: 6px;
      }
      .maehwa-status .end-banner-title {
        font-size: 36px; font-weight: 800; letter-spacing: 0.02em;
        color: #ffce8a;
        margin-bottom: 10px;
      }
      .maehwa-status .end-banner-reason {
        font-size: 18px; font-weight: 600;
        color: rgba(255, 255, 255, 0.85);
        letter-spacing: 0.02em;
      }
      .maehwa-status .end-banner.disqualified .end-banner-card {
        border-color: rgba(232, 60, 60, 0.75);
        animation: maehwa-end-pop 0.4s cubic-bezier(0.2, 1.2, 0.4, 1),
                   maehwa-end-shake 0.5s ease-in-out 0.4s 2;
        box-shadow: 0 12px 48px rgba(232, 60, 60, 0.35),
                    0 0 0 1px rgba(232, 60, 60, 0.5) inset;
      }
      .maehwa-status .end-banner.disqualified .end-banner-title {
        color: #ff7a7a;
      }
      .maehwa-status .end-banner.disqualified .end-banner-reason {
        color: #ffb0b0; font-weight: 700;
      }
      .maehwa-status .end-banner.draw .end-banner-card {
        border-color: rgba(180, 180, 180, 0.5);
        box-shadow: 0 12px 48px rgba(0, 0, 0, 0.4);
      }
      .maehwa-status .end-banner.draw .end-banner-title {
        color: #d0d0d0;
      }
      @keyframes maehwa-end-pop {
        0%   { opacity: 0; transform: scale(0.6); }
        100% { opacity: 1; transform: scale(1); }
      }
      @keyframes maehwa-end-shake {
        0%, 100% { transform: translateX(0); }
        25% { transform: translateX(-8px); }
        75% { transform: translateX(8px); }
      }
      .maehwa-status .thinking-spinner {
        width: 12px; height: 12px; border-radius: 50%;
        border: 2px solid rgba(255, 184, 77, 0.35);
        border-top-color: #ffb84d;
        animation: maehwa-spin 0.8s linear infinite;
      }
      @keyframes maehwa-spin { to { transform: rotate(360deg); } }
    </style>
    <div class="gauge">
      <div class="gauge-row gauge-row-a">
        <span class="gauge-row-label">A팀</span>
        <div class="gauge-track"><div class="gauge-fill" data-team="A" style="width:0"></div></div>
        <span class="gauge-row-num" data-team="A">0/100</span>
      </div>
      <div class="gauge-row gauge-row-b">
        <span class="gauge-row-label">B팀</span>
        <div class="gauge-track"><div class="gauge-fill" data-team="B" style="width:0"></div></div>
        <span class="gauge-row-num" data-team="B">0/100</span>
      </div>
    </div>
    <div class="team team-a">
      <div class="team-header">
        <span>A팀</span>
        <span class="agent-name">${escapeHtml(meta.agents.A)}</span>
      </div>
      <div class="team-body"></div>
      <div class="warn-row" data-team="A">
        <span class="warn-label">⚠ 누적 시간 초과</span>
        <div class="warn-flags">
          <span class="warn-flag">🚩</span>
          <span class="warn-flag">🚩</span>
          <span class="warn-flag">🚩</span>
        </div>
      </div>
    </div>
    <div class="team team-b">
      <div class="team-header">
        <span class="agent-name">${escapeHtml(meta.agents.B)}</span>
        <span>B팀</span>
      </div>
      <div class="team-body"></div>
      <div class="warn-row" data-team="B">
        <span class="warn-label">⚠ 누적 시간 초과</span>
        <div class="warn-flags">
          <span class="warn-flag">🚩</span>
          <span class="warn-flag">🚩</span>
          <span class="warn-flag">🚩</span>
        </div>
      </div>
    </div>
    <div class="live-badge"><span class="live-dot"></span>LIVE</div>
    <div class="thinking">
      <span class="thinking-spinner"></span>
      <span class="thinking-text">에이전트 사고 중…</span>
      <span class="thinking-timer">10.0s</span>
    </div>
    <div class="end-banner">
      <div class="end-banner-card">
        <div class="end-banner-icon"></div>
        <div class="end-banner-title"></div>
        <div class="end-banner-reason"></div>
      </div>
    </div>
  `;
  parent.appendChild(root);

  const gaugeFillA = root.querySelector<HTMLElement>('.gauge-fill[data-team="A"]')!;
  const gaugeFillB = root.querySelector<HTMLElement>('.gauge-fill[data-team="B"]')!;
  const gaugeNumA = root.querySelector<HTMLElement>('.gauge-row-num[data-team="A"]')!;
  const gaugeNumB = root.querySelector<HTMLElement>('.gauge-row-num[data-team="B"]')!;
  const bodyA = root.querySelector<HTMLElement>('.team-a .team-body')!;
  const bodyB = root.querySelector<HTMLElement>('.team-b .team-body')!;
  const liveBadge = root.querySelector<HTMLElement>('.live-badge')!;
  const thinking = root.querySelector<HTMLElement>('.thinking')!;
  const thinkingTimer = root.querySelector<HTMLElement>('.thinking-timer')!;
  // phase_time_limit_sec=10 (balance.json). 첫 페이즈는 15초지만 viewer 의
  // setThinking 발화 시점은 라이브 스트림 도착 기준이라 일반 phase 한도(10s)
  // 로 표시 — 첫 페이즈도 10s 안에 끝나는 게 정상이고 15s 마진은 import 용.
  const PHASE_LIMIT_MS = 10_000;
  let thinkingStartedAt: number | null = null;
  let thinkingRafId: number | null = null;
  const warnRowA = root.querySelector<HTMLElement>('.warn-row[data-team="A"]')!;
  const warnRowB = root.querySelector<HTMLElement>('.warn-row[data-team="B"]')!;
  const warnLabelA = warnRowA.querySelector<HTMLElement>('.warn-label')!;
  const warnLabelB = warnRowB.querySelector<HTMLElement>('.warn-label')!;
  const warnFlagsA = warnRowA.querySelectorAll<HTMLElement>('.warn-flag');
  const warnFlagsB = warnRowB.querySelectorAll<HTMLElement>('.warn-flag');
  const endBanner = root.querySelector<HTMLElement>('.end-banner')!;
  const endIcon = root.querySelector<HTMLElement>('.end-banner-icon')!;
  const endTitle = root.querySelector<HTMLElement>('.end-banner-title')!;
  const endReason = root.querySelector<HTMLElement>('.end-banner-reason')!;

  const getDisplayedHp = options.getDisplayedHp;
  let currentFrame: Frame | null = null;
  let rafId: number | null = null;

  function paint(): void {
    rafId = null;
    if (currentFrame === null) return;
    // 게이지 v2: 양 팀 독립 0~100. 자기 팀 막대가 0→100 으로 누적.
    const ga = currentFrame.gauge.A;
    const gb = currentFrame.gauge.B;
    gaugeFillA.style.width = `${(ga / GAUGE_MAX) * 100}%`;
    gaugeFillB.style.width = `${(gb / GAUGE_MAX) * 100}%`;
    gaugeFillA.classList.toggle('full', ga >= GAUGE_MAX);
    gaugeFillB.classList.toggle('full', gb >= GAUGE_MAX);
    gaugeNumA.textContent = `${ga}/100`;
    gaugeNumB.textContent = `${gb}/100`;

    renderTeam(bodyA, currentFrame, 'A', getDisplayedHp);
    renderTeam(bodyB, currentFrame, 'B', getDisplayedHp);

    renderWarnRow(warnRowA, warnLabelA, warnFlagsA, currentFrame.warnings.A);
    renderWarnRow(warnRowB, warnLabelB, warnFlagsB, currentFrame.warnings.B);

    // While a getDisplayedHp source exists, keep redrawing — the displayed
    // hp may lag the frame and only catch up when the hit FX fires.
    if (getDisplayedHp !== undefined) {
      rafId = requestAnimationFrame(paint);
    }
  }

  // end-banner 자동 fade 타이머. autoHideMs 옵션이 켜져 있으면 end 프레임이 처음
  // 들어올 때 한 번만 setTimeout 을 등록한다. 같은 end 프레임이 재차 update 로 들어와도
  // 타이머는 한 번만 켜고 (alreadyShown 가드), 새 세션/dispose 에서 정리한다.
  const autoHideMs = options.endBannerAutoHideMs;
  let endBannerHideTimer: number | null = null;
  let endBannerShown = false;
  function applyEndBanner(frame: Frame): void {
    if (frame.phase !== 'end') {
      endBanner.classList.remove('on', 'disqualified', 'draw', 'fading');
      endBannerShown = false;
      if (endBannerHideTimer !== null) {
        window.clearTimeout(endBannerHideTimer);
        endBannerHideTimer = null;
      }
      return;
    }
    // frame.description 은 timeline 의 formatEnd 결과 (예: "A팀 승리 (연속 타임아웃)").
    // 여기서 reason 을 다시 파싱하지 않고 description 끝의 () 안 텍스트를 reason 으로 사용.
    const m = /^(.+?)(?:\s*\(([^)]+)\))?$/.exec(frame.description);
    const headline = m?.[1] ?? frame.description;
    const reason = m?.[2] ?? '';
    const isDraw = headline.includes('무승부');
    const isDisqualified = reason.includes('연속 타임아웃') || reason.includes('예외');
    endBanner.classList.add('on');
    endBanner.classList.toggle('disqualified', isDisqualified);
    endBanner.classList.toggle('draw', isDraw);
    endIcon.textContent = isDisqualified ? '⚠️' : isDraw ? '🤝' : '🏁';
    endTitle.textContent = headline;
    endReason.textContent = isDisqualified
      ? `상대 ${reason} 으로 자동 패배`
      : reason || '';
    if (!endBannerShown && autoHideMs !== undefined && autoHideMs > 0) {
      endBannerShown = true;
      endBannerHideTimer = window.setTimeout(() => {
        endBanner.classList.add('fading');
        endBannerHideTimer = null;
      }, autoHideMs);
    }
  }

  return {
    root,
    update(frame) {
      currentFrame = frame;
      applyEndBanner(frame);
      if (rafId === null) {
        rafId = requestAnimationFrame(paint);
      }
    },
    setLive(live) { liveBadge.classList.toggle('on', live); },
    setThinking(t) {
      thinking.classList.toggle('on', t);
      if (t) {
        // false → true 전환 시점 = 새 phase 사고 시작. phaseStartedAt 갱신.
        // true → true (200ms poll 재호출) 시점은 phaseStartedAt 유지해 카운트다운 보존.
        if (thinkingStartedAt === null) {
          thinkingStartedAt = performance.now();
          const tick = (): void => {
            if (thinkingStartedAt === null) return;
            const elapsed = performance.now() - thinkingStartedAt;
            const remaining = Math.max(0, PHASE_LIMIT_MS - elapsed);
            thinkingTimer.textContent = `${(remaining / 1000).toFixed(1)}s`;
            // 색상 단계: 5s+ 정상(노랑), 2-5s 경고(주황), 0-2s 위험(빨강+펄스)
            thinking.classList.toggle('urgent', remaining > 0 && remaining <= 5000 && remaining > 2000);
            thinking.classList.toggle('critical', remaining > 0 && remaining <= 2000);
            if (remaining > 0) {
              thinkingRafId = requestAnimationFrame(tick);
            } else {
              // 한도 초과 — 표시 0.0s 빨강 유지
              thinking.classList.add('critical');
              thinkingRafId = null;
            }
          };
          tick();
        }
      } else {
        thinkingStartedAt = null;
        thinking.classList.remove('urgent', 'critical');
        if (thinkingRafId !== null) cancelAnimationFrame(thinkingRafId);
        thinkingRafId = null;
        thinkingTimer.textContent = '10.0s';
      }
    },
    dispose() {
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (endBannerHideTimer !== null) {
        window.clearTimeout(endBannerHideTimer);
        endBannerHideTimer = null;
      }
      root.remove();
    },
  };
}

function renderWarnRow(
  row: HTMLElement,
  label: HTMLElement,
  flags: NodeListOf<HTMLElement>,
  count: number,
): void {
  const clamped = Math.min(3, Math.max(0, count));
  row.classList.remove('warn-1', 'warn-2', 'warn-3');
  if (clamped >= 3) row.classList.add('warn-3');
  else if (clamped === 2) row.classList.add('warn-2');
  else if (clamped === 1) row.classList.add('warn-1');
  // 점등: 깃발 N 개를 lit 처리. clamped >= idx+1 이면 켜짐.
  flags.forEach((f, idx) => f.classList.toggle('lit', idx < clamped));
  label.textContent = clamped >= 3
    ? '🚨 자동 패배 — 연속 3회 시간 초과'
    : `⚠ 누적 시간 초과  ${clamped}/3`;
}

function renderTeam(
  container: HTMLElement,
  frame: Frame,
  team: 'A' | 'B',
  getDisplayedHp: ((id: number) => DisplayedHpSnapshot | null) | undefined,
): void {
  const units: UnitState[] = [];
  for (const u of frame.units.values()) {
    if (u.team === team) units.push(u);
  }
  units.sort((a, b) => a.id - b.id);

  // Reuse rows when possible to avoid flicker.
  while (container.children.length > units.length) {
    container.lastElementChild?.remove();
  }
  while (container.children.length < units.length) {
    const row = document.createElement('div');
    row.className = 'unit-row';
    row.innerHTML = `
      <span class="unit-class"></span>
      <div class="unit-hpbar"><div class="unit-hpbar-fill"></div></div>
      <span class="unit-hp"></span>
    `;
    container.appendChild(row);
  }

  units.forEach((u, i) => {
    const row = container.children[i] as HTMLElement;
    // Prefer the renderer's currently-displayed hp/alive — it's gated by the
    // pendingHpChanges queue so the bar drops in sync with the hit FX, not on
    // phase entry. Fall back to the frame value if the unit isn't registered.
    const disp = getDisplayedHp?.(u.id) ?? null;
    const hp = disp?.hp ?? u.hp;
    const alive = disp?.alive ?? u.alive;
    const maxHp = disp?.maxHp ?? u.maxHp;
    row.classList.toggle('dead', !alive);
    row.querySelector<HTMLElement>('.unit-class')!.textContent = UNIT_CLASS_KO[u.unitClass];
    const ratio = Math.max(0, Math.min(1, hp / maxHp));
    const fill = row.querySelector<HTMLElement>('.unit-hpbar-fill')!;
    fill.style.width = `${ratio * 100}%`;
    fill.style.background = ratio > 0.5 ? '#7fdd63' : ratio > 0.2 ? '#ffce4d' : '#ff5d4d';
    row.querySelector<HTMLElement>('.unit-hp')!.textContent = alive ? `${hp}` : '전사';
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] ?? ch),
  );
}
