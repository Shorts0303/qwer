/**
 * UI 스케일 토글 — 4K @ 275% 같은 고배율 환경에서 학생이 "UI가 너무 크다"
 * 고 느낄 때 0.75x 컴팩트 모드로 일괄 축소. CSS `zoom` 으로 적용 — 캔버스
 * (맵/유닛/이펙트) 는 건드리지 않고 DOM 오버레이(menu/status/controls/launch/
 * tourney/tutorial/back) 만 줄어든다.
 *
 * `zoom` 은 비표준이지만 Chrome/Edge/Safari/Firefox 모두 지원하며, `transform:
 * scale` 과 달리 자식 요소의 레이아웃 박스가 같이 줄어들어 위치 계산이 깨지지
 * 않는다 (fixed-position 오버레이가 많아서 transform 으로는 한 번에 못 줄임).
 *
 * - 상태는 localStorage(`maehwa.uiScale.compact`) 에 저장 → 새로고침 후 유지
 * - 부팅 시 한 번, DPR 높고 실효 해상도 작으면 자동 추천 토스트 노출 (한 번
 *   닫으면 `maehwa.uiScale.autoPromptDismissed` 에 표시되어 다시 안 뜬다)
 * - mainMenu 안에 수동 토글 체크박스 노출 — 학생이 직접 켜고 끌 수 있음
 */

const STORAGE_KEY = 'maehwa.uiScale.compact';
const PROMPT_DISMISS_KEY = 'maehwa.uiScale.autoPromptDismissed';
const COMPACT_ZOOM = 0.75;
const CSS_STYLE_ID = 'maehwa-ui-scale-style';

// zoom 을 적용할 오버레이 root 클래스들. 새 오버레이를 추가했다면 여기에도 추가.
const OVERLAY_SELECTORS = [
  '.maehwa-menu',
  '.maehwa-launch',
  '.maehwa-tourney',
  '.maehwa-tutorial',
  '.maehwa-tutorial-editor',
  '.maehwa-status',
  '.maehwa-controls',
  '.maehwa-caption',
  '.maehwa-result-banner',
  '.maehwa-toast',
  '.maehwa-back',
  '.maehwa-uiscale-prompt',
];

const listeners = new Set<(compact: boolean) => void>();

function ensureStyle(): void {
  if (document.getElementById(CSS_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = CSS_STYLE_ID;
  const selector = OVERLAY_SELECTORS
    .map((sel) => `body[data-ui-scale="compact"] ${sel}`)
    .join(',\n');
  style.textContent = `${selector} {\n  zoom: ${COMPACT_ZOOM};\n}\n`;
  document.head.appendChild(style);
}

function readStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeStored(compact: boolean): void {
  try {
    if (compact) localStorage.setItem(STORAGE_KEY, '1');
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // private mode / quota — 무시
  }
}

export function isCompact(): boolean {
  return document.body.getAttribute('data-ui-scale') === 'compact';
}

export function setCompact(compact: boolean): void {
  ensureStyle();
  if (compact) document.body.setAttribute('data-ui-scale', 'compact');
  else document.body.removeAttribute('data-ui-scale');
  writeStored(compact);
  for (const cb of listeners) cb(compact);
}

/** 컴팩트 모드 on/off 변화를 구독. 메인 메뉴 체크박스가 자동 추천 토스트의 결과를
 *  반영하기 위해 사용. 반환된 함수를 호출하면 구독 해제. */
export function onChange(cb: (compact: boolean) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** 부팅 시점에 한 번 호출 — localStorage 에서 읽어 즉시 적용. 오버레이 mount
 *  보다 먼저 호출하면 첫 렌더부터 컴팩트 상태로 그려진다. */
export function applyStoredScale(): void {
  ensureStyle();
  if (readStored()) document.body.setAttribute('data-ui-scale', 'compact');
}

/**
 * 고배율 + 실효 해상도 작은 환경 휴리스틱:
 *   devicePixelRatio >= 2.0 (4K@200%+, Retina laptop, 고배율 노트북 등)
 *   AND innerWidth < 1600 (배율을 한참 키워 가로 CSS 픽셀이 부족한 상태)
 * 둘 다 만족하면 컴팩트 UI 를 추천한다 — 27인치 4K 모니터에 100% 배율 같은
 * 경우엔 dpr=2.0 이어도 innerWidth 가 3840 이라 추천하지 않음.
 */
export function shouldRecommendCompact(): boolean {
  const dpr = window.devicePixelRatio || 1;
  return dpr >= 2.0 && window.innerWidth < 1600;
}

/**
 * 첫 부팅 시 한 번 추천 토스트를 띄운다. 이미 컴팩트 ON 이거나 / 한 번 닫았으면
 * skip. 사용자가 "컴팩트 켜기" 또는 "아니요" 둘 중 무엇을 눌러도 dismiss 플래그가
 * 박혀 다음 부팅 때 다시 뜨지 않는다 (체크박스로는 계속 토글 가능).
 */
export function maybeShowAutoPrompt(parent: HTMLElement): void {
  if (readStored()) return;
  try {
    if (localStorage.getItem(PROMPT_DISMISS_KEY) === '1') return;
  } catch {
    return;
  }
  if (!shouldRecommendCompact()) return;

  const toast = document.createElement('div');
  toast.className = 'maehwa-uiscale-prompt';
  toast.innerHTML = `
    <style>
      .maehwa-uiscale-prompt {
        position: fixed; left: 50%; bottom: 90px; transform: translate(-50%, 8px);
        max-width: 380px;
        padding: 14px 18px; border-radius: 12px;
        background: rgba(10, 14, 24, 0.95);
        border: 1px solid rgba(255, 184, 77, 0.55);
        color: #e8eaf0;
        font: 13px/1.5 'Pretendard Variable', system-ui, sans-serif;
        z-index: 80;
        box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
        opacity: 0;
        transition: opacity 220ms ease, transform 220ms ease;
        display: flex; flex-direction: column; gap: 10px;
      }
      .maehwa-uiscale-prompt.show {
        opacity: 1; transform: translate(-50%, 0);
      }
      .maehwa-uiscale-prompt p { margin: 0; }
      .maehwa-uiscale-prompt .actions {
        display: flex; gap: 8px; justify-content: flex-end;
      }
      .maehwa-uiscale-prompt button {
        appearance: none;
        padding: 6px 12px; border-radius: 8px;
        font: inherit; font-weight: 600;
        cursor: pointer;
        border: 1px solid rgba(255, 255, 255, 0.18);
        background: rgba(255, 255, 255, 0.06);
        color: #e8eaf0;
      }
      .maehwa-uiscale-prompt button.primary {
        background: rgba(255, 184, 77, 0.22);
        border-color: rgba(255, 184, 77, 0.7);
        color: #ffd58a;
      }
      .maehwa-uiscale-prompt button:hover { filter: brightness(1.15); }
    </style>
    <p>고해상도 환경이 감지됐어요. UI가 크게 느껴진다면 <b>컴팩트 모드</b>로 줄일까요?</p>
    <div class="actions">
      <button data-act="dismiss">아니요</button>
      <button data-act="apply" class="primary">컴팩트 켜기</button>
    </div>
  `;
  parent.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));

  function close(): void {
    toast.classList.remove('show');
    window.setTimeout(() => toast.remove(), 240);
  }
  function markDismissed(): void {
    try {
      localStorage.setItem(PROMPT_DISMISS_KEY, '1');
    } catch {
      // ignore
    }
  }
  toast.querySelector<HTMLButtonElement>('[data-act="apply"]')!.addEventListener('click', () => {
    setCompact(true);
    markDismissed();
    close();
  });
  toast.querySelector<HTMLButtonElement>('[data-act="dismiss"]')!.addEventListener('click', () => {
    markDismissed();
    close();
  });
}
