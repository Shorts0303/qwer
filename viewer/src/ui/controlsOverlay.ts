import type { Frame } from '../playback/timeline';
import type { ReplayPlayer } from '../playback/player';
import type { Broadcaster } from '../playback/broadcaster';

export interface ControlsOverlayHandle {
  readonly root: HTMLElement;
  onFrame(frame: Frame, index: number): void;
  /** 라이브 중계 중일 때 caption 에 🔴 LIVE 태그 노출. */
  setLive(live: boolean): void;
  dispose(): void;
}

type Mode = 'tick' | 'broadcast';

export function mountControlsOverlay(
  parent: HTMLElement,
  player: ReplayPlayer,
  broadcaster: Broadcaster,
): ControlsOverlayHandle {
  const root = document.createElement('div');
  root.className = 'maehwa-controls';
  root.innerHTML = `
    <style>
      .maehwa-controls {
        position: fixed;
        left: 50%;
        bottom: 24px;
        transform: translateX(-50%);
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 16px;
        background: rgba(10, 14, 24, 0.82);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 12px;
        color: #e8eaf0;
        font: 13px/1.2 'Pretendard Variable', 'Galmuri11', system-ui, -apple-system, sans-serif;
        backdrop-filter: blur(8px);
        user-select: none;
        z-index: 20;
      }
      .maehwa-controls button {
        appearance: none;
        border: 1px solid rgba(255, 255, 255, 0.14);
        background: rgba(255, 255, 255, 0.06);
        color: #e8eaf0;
        padding: 6px 10px;
        border-radius: 6px;
        font-size: 13px;
        cursor: pointer;
        min-width: 34px;
      }
      .maehwa-controls button:hover { background: rgba(255, 255, 255, 0.12); }
      .maehwa-controls button:disabled { opacity: 0.35; cursor: default; }
      .maehwa-controls input[type="range"] {
        flex: 1 1 320px;
        min-width: 240px;
        accent-color: #ffb84d;
      }
      .maehwa-controls .frame-label {
        font-variant-numeric: tabular-nums;
        opacity: 0.85;
        min-width: 60px;
        text-align: right;
      }
      .maehwa-controls .mode-toggle {
        padding: 6px 10px;
        font-size: 12px;
        min-width: auto;
      }
      .maehwa-controls .mode-toggle.broadcast {
        background: rgba(255, 184, 77, 0.2);
        border-color: #ffb84d;
        color: #ffce8a;
      }
      .maehwa-caption {
        position: fixed;
        top: 18px;
        left: 50%;
        transform: translateX(-50%);
        padding: 6px 14px;
        background: rgba(10, 14, 24, 0.7);
        color: #e8eaf0;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        font: 13px/1.2 'Pretendard Variable', 'Galmuri11', system-ui, sans-serif;
        pointer-events: none;
        z-index: 20;
        display: inline-flex;
        align-items: center;
      }
      .maehwa-caption .live-tag {
        display: none;
        align-items: center;
        gap: 5px;
        margin-right: 10px;
        padding: 2px 9px;
        background: rgba(220, 30, 30, 0.92);
        color: #fff;
        font-weight: 700;
        font-size: 11px;
        letter-spacing: 0.05em;
        border-radius: 999px;
        box-shadow: 0 0 10px rgba(255, 60, 60, 0.45);
      }
      .maehwa-caption.live .live-tag { display: inline-flex; }
      .maehwa-caption .live-dot {
        width: 6px; height: 6px; border-radius: 50%;
        background: #fff;
        animation: maehwa-caption-live-pulse 1s ease-in-out infinite;
      }
      @keyframes maehwa-caption-live-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.35; }
      }
    </style>
    <button data-action="back" title="이전 프레임">◀</button>
    <button data-action="play" title="재생/정지">▶</button>
    <button data-action="forward" title="다음 프레임">▶▶</button>
    <input type="range" min="0" max="${player.frameCount - 1}" step="1" value="0" />
    <span class="frame-label">0 / ${player.frameCount - 1}</span>
    <button data-action="mode" class="mode-toggle" title="재생 모드">⏩ 빠른 재생</button>
  `;
  parent.appendChild(root);

  const caption = document.createElement('div');
  caption.className = 'maehwa-caption';
  caption.innerHTML = `<span class="live-tag"><span class="live-dot"></span>LIVE</span><span class="caption-text"></span>`;
  parent.appendChild(caption);
  const captionText = caption.querySelector<HTMLElement>('.caption-text')!;

  const back = root.querySelector<HTMLButtonElement>('button[data-action="back"]')!;
  const play = root.querySelector<HTMLButtonElement>('button[data-action="play"]')!;
  const forward = root.querySelector<HTMLButtonElement>('button[data-action="forward"]')!;
  const slider = root.querySelector<HTMLInputElement>('input[type="range"]')!;
  const label = root.querySelector<HTMLSpanElement>('.frame-label')!;
  const modeBtn = root.querySelector<HTMLButtonElement>('button[data-action="mode"]')!;

  let mode: Mode = 'tick';

  function updateModeBtn(): void {
    if (mode === 'broadcast') {
      modeBtn.textContent = '📺 중계 모드';
      modeBtn.classList.add('broadcast');
    } else {
      modeBtn.textContent = '⏩ 빠른 재생';
      modeBtn.classList.remove('broadcast');
    }
  }

  // togglePlay 직후 onFrame 이 바로 안 불리는 케이스 (긴 phase frame 의 setTimeout
  // 대기 중) 를 위해 버튼 텍스트는 클릭 즉시 새 상태로 갱신한다 — 그러지 않으면
  // 1~2초간 ▶ 그대로 보여 "안 눌린 것처럼" 보임.
  function syncPlayBtn(): void {
    const running = mode === 'broadcast' ? broadcaster.isRunning : player.isPlaying;
    play.textContent = running ? '⏸' : '▶';
  }
  back.addEventListener('click', () => {
    broadcaster.pause();
    player.stepBackward();
    syncPlayBtn();
  });
  forward.addEventListener('click', () => {
    broadcaster.pause();
    player.stepForward();
    syncPlayBtn();
  });
  play.addEventListener('click', () => {
    if (mode === 'broadcast') {
      broadcaster.togglePlay();
    } else {
      player.togglePlay();
    }
    syncPlayBtn();
  });
  slider.addEventListener('input', () => {
    broadcaster.pause();
    player.pause();
    const v = Number(slider.value);
    player.seek(v);
    syncPlayBtn();
  });
  modeBtn.addEventListener('click', () => {
    mode = mode === 'tick' ? 'broadcast' : 'tick';
    broadcaster.pause();
    player.pause();
    updateModeBtn();
    syncPlayBtn();
  });
  updateModeBtn();

  const handle: ControlsOverlayHandle = {
    root,
    onFrame(_frame, index) {
      slider.value = String(index);
      label.textContent = `${index} / ${player.frameCount - 1}`;
      back.disabled = player.isAtStart;
      forward.disabled = player.isAtEnd;
      syncPlayBtn();
      captionText.textContent = player.currentFrame.description;
    },
    setLive(live) {
      caption.classList.toggle('live', live);
    },
    dispose() {
      root.remove();
      caption.remove();
    },
  };

  // Initial paint
  handle.onFrame(player.currentFrame, player.currentIndex);
  return handle;
}
