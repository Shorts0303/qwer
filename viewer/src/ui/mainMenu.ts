import { isCompact, onChange as onUiScaleChange, setCompact } from './uiScale';

export type MenuMode = 'tutorial' | 'match' | 'tournament';

export interface MainMenuOptions {
  readonly onSelect: (mode: MenuMode) => void;
  readonly tutorialEnabled?: boolean;
}

export interface MainMenuHandle {
  readonly root: HTMLElement;
  show(): void;
  hide(): void;
  dispose(): void;
}

interface CardSpec {
  readonly mode: MenuMode;
  readonly icon: string;
  readonly title: string;
  readonly subtitle: string;
  readonly desc: string;
  readonly disabled?: boolean;
}

export function mountMainMenu(parent: HTMLElement, options: MainMenuOptions): MainMenuHandle {
  const tutorialEnabled = options.tutorialEnabled ?? false;

  const cards: CardSpec[] = [
    {
      mode: 'tutorial',
      icon: '🎓',
      title: '튜토리얼',
      subtitle: '처음 시작하는 학생용',
      desc: '브라우저 안에서 코드를 직접 작성하며 1유닛 → 1v1 → 풀 5v5 까지 단계별로 익힙니다.',
      disabled: !tutorialEnabled,
    },
    {
      mode: 'match',
      icon: '⚔️',
      title: '자유 대전',
      subtitle: '내 AI 시연·연습',
      desc: '직접 만든 에이전트(.py) 또는 빌드 시 박힌 agent.py 로 베이스라인과 1:1 대전.',
    },
    {
      mode: 'tournament',
      icon: '🏆',
      title: '토너먼트',
      subtitle: '강사 운영 모드',
      desc: '학생 .py 다중 업로드 → 스위스 라운드 → 결선 브래킷 → 시상까지 전 과정.',
    },
  ];

  const root = document.createElement('div');
  root.className = 'maehwa-menu';
  root.innerHTML = `
    <style>
      .maehwa-menu {
        position: fixed; inset: 0;
        display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        background: radial-gradient(ellipse at center, rgba(20, 28, 48, 0.85) 0%, rgba(8, 11, 20, 0.95) 70%);
        backdrop-filter: blur(8px);
        z-index: 50;
        font: 14px/1.5 'Pretendard Variable', 'Galmuri11', system-ui, sans-serif;
        color: #e8eaf0;
        opacity: 0; transition: opacity 220ms ease;
        pointer-events: none;
      }
      .maehwa-menu.open { opacity: 1; pointer-events: auto; }
      .maehwa-menu header {
        text-align: center; margin-bottom: 36px;
      }
      .maehwa-menu h1 {
        margin: 0 0 6px; font-size: 28px; font-weight: 700;
        letter-spacing: 0.04em;
        background: linear-gradient(135deg, #ffd58a 0%, #ffb84d 60%, #f88f3a 100%);
        -webkit-background-clip: text; background-clip: text;
        color: transparent;
      }
      .maehwa-menu .subtitle {
        font-size: 13px; opacity: 0.65; letter-spacing: 0.06em;
      }
      .maehwa-menu .cards {
        display: flex; gap: 18px; flex-wrap: wrap;
        justify-content: center; max-width: 960px; padding: 0 20px;
      }
      .maehwa-menu .card {
        width: 240px; padding: 22px 20px;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 14px;
        cursor: pointer;
        transition: transform 160ms ease, border-color 160ms ease, background 160ms ease;
        text-align: left;
      }
      .maehwa-menu .card:hover:not(.disabled) {
        transform: translateY(-3px);
        border-color: rgba(255, 184, 77, 0.6);
        background: rgba(255, 255, 255, 0.07);
      }
      .maehwa-menu .card.disabled {
        cursor: not-allowed; opacity: 0.55;
      }
      .maehwa-menu .card .icon {
        font-size: 32px; line-height: 1; margin-bottom: 10px;
        filter: drop-shadow(0 2px 8px rgba(255, 184, 77, 0.25));
      }
      .maehwa-menu .card h2 {
        margin: 0; font-size: 17px; font-weight: 700;
        display: flex; align-items: center; gap: 8px;
      }
      .maehwa-menu .card .badge {
        display: inline-block; padding: 2px 7px;
        background: rgba(255, 184, 77, 0.18);
        color: #ffb84d;
        font-size: 10px; font-weight: 700; letter-spacing: 0.05em;
        border-radius: 999px;
      }
      .maehwa-menu .card h3 {
        margin: 4px 0 10px; font-size: 11px; font-weight: 600;
        opacity: 0.55; letter-spacing: 0.08em; text-transform: uppercase;
      }
      .maehwa-menu .card p {
        margin: 0; font-size: 12.5px; line-height: 1.55;
        opacity: 0.78;
      }
      .maehwa-menu footer {
        margin-top: 36px; font-size: 11px; opacity: 0.4;
        letter-spacing: 0.04em;
      }
      /* ── UI 스케일 토글 ───────────────────────────────────────
         4K 고배율 + 작은 노트북에서 UI가 크게 보일 때 학생이 직접 줄일 수 있게.
         부팅 시 자동 추천 토스트와 같은 상태를 공유한다. */
      .maehwa-menu .ui-scale-toggle {
        margin-top: 20px;
        display: inline-flex; align-items: center; gap: 8px;
        padding: 6px 12px;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(255, 255, 255, 0.03);
        font-size: 12px;
        opacity: 0.7;
        cursor: pointer;
        user-select: none;
        transition: opacity 160ms ease, border-color 160ms ease, background 160ms ease;
      }
      .maehwa-menu .ui-scale-toggle:hover {
        opacity: 1;
        border-color: rgba(255, 184, 77, 0.5);
        background: rgba(255, 184, 77, 0.06);
      }
      .maehwa-menu .ui-scale-toggle input {
        width: 14px; height: 14px;
        accent-color: #ffb84d;
        cursor: pointer;
      }
      .maehwa-menu .ui-scale-toggle.on { opacity: 1; color: #ffd58a; }
      .maehwa-toast {
        position: fixed; left: 50%; bottom: 36px; transform: translateX(-50%);
        padding: 10px 16px; border-radius: 999px;
        background: rgba(10, 14, 24, 0.92); color: #e8eaf0;
        border: 1px solid rgba(255, 255, 255, 0.12);
        font: 12.5px/1.4 'Pretendard Variable', system-ui, sans-serif;
        z-index: 60;
        opacity: 0; transition: opacity 200ms ease;
        pointer-events: none;
      }
      .maehwa-toast.show { opacity: 1; }
    </style>
    <header>
      <h1>메이드 인 매화 : 택티컬 아레나</h1>
      <div class="subtitle">MODE SELECT</div>
    </header>
    <div class="cards"></div>
    <label class="ui-scale-toggle">
      <input type="checkbox" />
      <span>컴팩트 UI <small style="opacity:0.55">(고배율 화면용)</small></span>
    </label>
    <footer>방향키 ← → 또는 마우스로 선택  ·  Enter 로 진입</footer>
  `;

  const cardsRoot = root.querySelector<HTMLDivElement>('.cards')!;
  const cardEls: HTMLDivElement[] = [];

  cards.forEach((spec, idx) => {
    const el = document.createElement('div');
    el.className = 'card';
    if (spec.disabled) el.classList.add('disabled');
    el.dataset['mode'] = spec.mode;
    el.dataset['idx'] = String(idx);
    el.innerHTML = `
      <div class="icon">${spec.icon}</div>
      <h2>${spec.title}${spec.disabled ? ' <span class="badge">준비 중</span>' : ''}</h2>
      <h3>${spec.subtitle}</h3>
      <p>${spec.desc}</p>
    `;
    el.addEventListener('click', () => {
      if (spec.disabled) {
        showToast('튜토리얼은 곧 공개됩니다. 지금은 자유 대전 / 토너먼트만 사용 가능해요.');
        return;
      }
      options.onSelect(spec.mode);
    });
    cardsRoot.appendChild(el);
    cardEls.push(el);
  });

  parent.appendChild(root);

  // ── UI 스케일 토글 ─ 체크박스 ↔ uiScale 모듈 양방향 바인딩.
  // 자동 추천 토스트의 "켜기" 결과도 onUiScaleChange 로 흘러와 체크박스에 반영된다.
  const uiScaleLabel = root.querySelector<HTMLLabelElement>('.ui-scale-toggle')!;
  const uiScaleCheckbox = uiScaleLabel.querySelector<HTMLInputElement>('input')!;
  function reflectUiScale(compact: boolean): void {
    uiScaleCheckbox.checked = compact;
    uiScaleLabel.classList.toggle('on', compact);
  }
  reflectUiScale(isCompact());
  uiScaleCheckbox.addEventListener('change', () => {
    setCompact(uiScaleCheckbox.checked);
  });
  const unsubscribeUiScale = onUiScaleChange(reflectUiScale);

  let toastEl: HTMLDivElement | null = null;
  let toastTimer: number | null = null;
  function showToast(msg: string): void {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'maehwa-toast';
      parent.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    requestAnimationFrame(() => toastEl!.classList.add('show'));
    if (toastTimer !== null) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastEl?.classList.remove('show');
    }, 2400);
  }

  let focusIdx = cards.findIndex((c) => !c.disabled);
  function applyFocus(): void {
    cardEls.forEach((el, i) => {
      el.style.outline = i === focusIdx ? '2px solid rgba(255, 184, 77, 0.7)' : 'none';
      el.style.outlineOffset = i === focusIdx ? '3px' : '0';
    });
  }

  function onKey(ev: KeyboardEvent): void {
    if (!root.classList.contains('open')) return;
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') {
      ev.preventDefault();
      for (let step = 1; step <= cards.length; step += 1) {
        const next = (focusIdx + step) % cards.length;
        if (!cards[next]?.disabled) {
          focusIdx = next;
          applyFocus();
          break;
        }
      }
    } else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      for (let step = 1; step <= cards.length; step += 1) {
        const next = (focusIdx - step + cards.length) % cards.length;
        if (!cards[next]?.disabled) {
          focusIdx = next;
          applyFocus();
          break;
        }
      }
    } else if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      const spec = cards[focusIdx];
      if (spec && !spec.disabled) options.onSelect(spec.mode);
    }
  }
  window.addEventListener('keydown', onKey);

  return {
    root,
    show(): void {
      root.classList.add('open');
      applyFocus();
    },
    hide(): void {
      root.classList.remove('open');
    },
    dispose(): void {
      window.removeEventListener('keydown', onKey);
      unsubscribeUiScale();
      if (toastTimer !== null) window.clearTimeout(toastTimer);
      toastEl?.remove();
      root.remove();
    },
  };
}
