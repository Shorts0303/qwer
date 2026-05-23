import { Application, Container } from 'pixi.js';
import defaultMapText from '../../engine/maps/default.txt?raw';
import smokeReplayJson from '../../replays/smoke.json?raw';
import { DEFAULT_HEX_LAYOUT, mapPixelBounds } from './hex/layout';
import { parseMap } from './map/gameMap';
import { buildTimeline, createLiveTimeline, type LiveTimelineHandle } from './playback/timeline';
import { ReplayPlayer } from './playback/player';
import { parseReplay } from './replay/parse';
import type { Replay, ReplayMeta, SetupEvent } from './replay/types';
import { Broadcaster } from './playback/broadcaster';
import { mountLighting } from './render/lighting';
import { createFxLayer } from './render/fxLayer';
import { createMapContainer } from './render/mapRenderer';
import { createSfx } from './render/sfx';
import { preloadAllUnitAtlases } from './render/sprites/unitAtlas';
import { computePhaseAnimationDurationMs, createUnitLayer } from './render/unitRenderer';
import { bakedStudentAgent } from './studentAgent';
import { aggregateWinner, type GameWinner } from './tournament/swiss';
import { mountTournamentPanel } from './tournament/tournamentPanel';
import { loadEngineRuntime, type EngineRuntime } from './pyodide/runtime';
import { mountControlsOverlay, type ControlsOverlayHandle } from './ui/controlsOverlay';
import { mountLaunchPanel } from './ui/launchPanel';
import { mountMainMenu, type MenuMode } from './ui/mainMenu';
import { mountStatusOverlay, type StatusOverlayHandle } from './ui/statusOverlay';
import { applyStoredScale, maybeShowAutoPrompt } from './ui/uiScale';
import { mountTutorialPanel } from './tutorial/tutorialPanel';

async function bootstrap(): Promise<void> {
  const mount = document.getElementById('app');
  if (!mount) throw new Error('missing #app mount point');

  // 컴팩트 UI 상태를 가장 먼저 적용 — 이후 mount 되는 오버레이는 처음부터 zoom 적용된
  // 채로 렌더되어 깜빡임이 없다. 토스트 추천은 첫 렌더 끝나고 applyHash() 뒤에 띄움.
  applyStoredScale();

  const app = new Application();
  await app.init({
    background: '#0b0f1a',
    resizeTo: window,
    antialias: false,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  });
  mount.appendChild(app.canvas);

  // Map / lighting / bounds 는 튜토리얼 시나리오 진입 시 좁은 맵으로 swap 되므로
  // 모두 mutable. swapMap() 이 갈아끼움 — Broadcaster/lighting 도 동시에 갈아끼움.
  let currentMapText = defaultMapText;
  let map = parseMap(defaultMapText);
  let mapContainer = createMapContainer(map);
  let bounds = mapPixelBounds(map.width, map.height);
  const stage = new Container();
  stage.sortableChildren = true;
  stage.addChild(mapContainer);
  app.stage.addChild(stage);

  await preloadAllUnitAtlases();

  const sfx = createSfx();
  sfx.primeOnUserGesture();

  const fxLayer = createFxLayer(app.ticker);

  // Class-specific firing pattern: rifle = 3-shot burst, dmr = single heavy
  // boom (bigger fx + heavier sound), shield = single normal, medic heal =
  // double pulse. All bursts happen within the 500ms attack/push sprite
  // window so the sprite anim still reads continuously.
  function fireBurst(ev: import('./render/unitRenderer').ActionFireEvent): void {
    if (ev.kind === 'attack') {
      if (ev.unitClass === 'rifle') {
        const shots = 3;
        const spacingMs = 70;
        for (let i = 0; i < shots; i += 1) {
          window.setTimeout(() => {
            fxLayer.spawn(ev);
            sfx.playAttack('rifle');
          }, i * spacingMs);
        }
      } else if (ev.unitClass === 'dmr') {
        fxLayer.spawn(ev, { intensity: 1.7 });
        sfx.playAttack('dmr');
      } else {
        fxLayer.spawn(ev);
        sfx.playAttack(ev.unitClass);
      }
    } else {
      // Heal: double pulse — second one slightly later for a "double tap" feel.
      const pulses = 2;
      const spacingMs = 150;
      for (let i = 0; i < pulses; i += 1) {
        window.setTimeout(() => {
          fxLayer.spawn(ev);
          sfx.playHeal();
        }, i * spacingMs);
      }
    }
  }

  const unitLayer = createUnitLayer({
    ticker: app.ticker,
    onActionFire: fireBurst,
    onUnitStep: (ev) => {
      sfx.playStep(ev.unitClass);
    },
  });
  stage.addChild(unitLayer.root);

  // FX sits above units so muzzle flash / tracer / hit ring read on top.
  stage.addChild(fxLayer.root);

  // Layer for transient broadcast overlays (attack/heal ranges). Sits above
  // the map but below units via container zIndex inside.
  const rangeLayer = new Container();
  rangeLayer.sortableChildren = true;
  stage.addChild(rangeLayer);

  let lighting = mountLighting(app, stage, map, DEFAULT_HEX_LAYOUT);

  const margin = DEFAULT_HEX_LAYOUT.size * 1.1;
  function recenter(): void {
    stage.position.set(
      (window.innerWidth - bounds.width) / 2 + margin,
      (window.innerHeight - bounds.height) / 2 + margin,
    );
  }

  /**
   * 맵 텍스트를 받아 mapContainer + lighting + bounds 를 새로 구성한다.
   * 튜토리얼 모드 진입/이탈 시 default ↔ 좁은 시나리오 맵 사이를 토글하기 위해
   * 만든 함수. 진행 중인 ReplayPlayer/Broadcaster 는 다음 mountSession 호출에서
   * 새 map 참조로 자연스럽게 갱신되므로 여기서 따로 건드리지 않는다 — 호출자가
   * setReplay 를 곧이어 부른다는 전제.
   */
  function swapMap(mapText: string): void {
    if (mapText === currentMapText) return; // no-op — same map already mounted
    const newMap = parseMap(mapText);
    stage.removeChild(mapContainer);
    mapContainer.destroy({ children: true });
    lighting.dispose();
    map = newMap;
    currentMapText = mapText;
    mapContainer = createMapContainer(map);
    // 맵은 stage 의 다른 레이어들보다 아래에 있어야 한다 (unitLayer/fxLayer 위에
    // 깔리는 형태). zIndex 미사용 — addChildAt(0) 으로 제일 아래에 박음.
    stage.addChildAt(mapContainer, 0);
    lighting = mountLighting(app, stage, map, DEFAULT_HEX_LAYOUT);
    lighting.resize(window.innerWidth, window.innerHeight);
    bounds = mapPixelBounds(map.width, map.height);
    recenter();
  }

  // mountSession 의 status overlay 옵션 분기에 쓰이는 트래커. 화면(screen)이 아니라
  // "지금 진행 중인 매치 세션이 어떤 종류인가"를 추적한다 — 자유대전 매치가 끝난 뒤
  // 라이브→픽스드 swap 은 END_HOLD(3s) 만큼 지연되므로, 그 사이에 사용자가 토너먼트로
  // navigate 하더라도 swap 이 일관되게 자유대전 정책(배너 자동 fade)을 따르도록 한다.
  // 세션 시작 시점(launchPanel/tournamentPanel/tutorialPanel)에서만 갱신; navigation
  // (goTo) 으로는 바뀌지 않는다.
  type MatchKind = 'free' | 'tournament' | 'tutorial' | null;
  let currentMatchKind: MatchKind = null;

  let player: ReplayPlayer | null = null;
  let controls: ControlsOverlayHandle | null = null;
  let status: StatusOverlayHandle | null = null;
  let broadcaster: Broadcaster | null = null;

  let liveHandle: LiveTimelineHandle | null = null;
  let thinkingPoll: number | null = null;
  // The fixed (hash-bearing) replay arrives via onComplete, but we hold off
  // swapping to it until the live player has actually played through every
  // appended frame — otherwise fast agents (sub-second matches) would flash
  // the LIVE badge for milliseconds before reverting.
  let pendingFinalReplay: Replay | null = null;
  /** Wall-clock time when the live player first reached the final frame.
   *  We hold the result on screen for END_HOLD_MS before swapping to fixed. */
  let endReachedAt: number | null = null;
  const END_HOLD_MS = 3000;
  /** Resolves at the moment the live session swaps to the fixed replay —
   *  used by the tournament runner to await one leg before starting the next. */
  let liveLegResolver: ((replay: Replay) => void) | null = null;

  function mountSession(timeline: ReturnType<typeof buildTimeline>, meta: ReplayMeta, live: boolean) {
    const next = new ReplayPlayer(timeline, {
      // Phase frames own their full sequential animation time. Setup / gauge /
      // end / no-action frames only need a brief beat (the audience already
      // sees the new state instantly via emit; we just don't want them to
      // sweep past too fast). 600ms used to apply across the board, which
      // made pressing ▶ feel sluggish for ~half a second.
      getFrameDurationMs: (frame) =>
        frame.actions.length > 0 ? computePhaseAnimationDurationMs(frame.actions) : 220,
      liveMode: live,
    });
    // 자유대전(free)에서만 결과 배너를 3초 후 자동 fade — 토너먼트는 다음 leg 까지
    // 결과를 계속 보여줘야 하고, 튜토리얼은 결과 카드 띄우는 별도 흐름이 있음.
    // currentMatchKind 는 navigation 으로 바뀌지 않으므로 라이브→픽스드 swap 이
    // 늦어도 (END_HOLD 도중 사용자가 다른 패널로 이동해도) 일관된 정책을 유지한다.
    const nextStatus = mountStatusOverlay(document.body, meta, {
      getDisplayedHp: (id) => unitLayer.getDisplayedHp(id),
      ...(currentMatchKind === 'free' ? { endBannerAutoHideMs: 3000 } : {}),
    });
    const nextBroadcaster = new Broadcaster(next, {
      rangeLayer,
      map,
      layout: DEFAULT_HEX_LAYOUT,
    });
    const nextControls = mountControlsOverlay(document.body, next, nextBroadcaster);
    next.subscribe((frame) => unitLayer.update(frame));
    next.subscribe((frame) => nextStatus.update(frame));
    next.subscribe(nextControls.onFrame);

    player?.dispose();
    controls?.dispose();
    status?.dispose();
    broadcaster?.dispose();
    if (thinkingPoll !== null) {
      window.clearInterval(thinkingPoll);
      thinkingPoll = null;
    }

    player = next;
    controls = nextControls;
    status = nextStatus;
    broadcaster = nextBroadcaster;
    nextStatus.setLive(live);
    nextControls.setLive(live);
    next.emitCurrent();

    if (live) {
      // Auto-start playback so the viewer follows new frames as they arrive,
      // and poll the player's "at end" state to drive the thinking spinner.
      next.play();
      endReachedAt = null;
      thinkingPoll = window.setInterval(() => {
        if (!status) return;
        const matchOver = liveHandle !== null && liveHandle.isComplete;
        const atTip = next.isAtEnd;
        status.setThinking(atTip && !matchOver);
        // Hold the final result on screen for END_HOLD_MS before swapping to
        // the fixed replay, so viewers can read the winner / final state.
        // The player is paused immediately on first reach so the live polling
        // tick stops counting against the hold timer.
        if (matchOver && atTip && pendingFinalReplay !== null) {
          if (endReachedAt === null) {
            endReachedAt = performance.now();
            next.pause();
          } else if (performance.now() - endReachedAt >= END_HOLD_MS) {
            const replay = pendingFinalReplay;
            pendingFinalReplay = null;
            endReachedAt = null;
            status.setLive(false);
            controls?.setLive(false);
            status.setThinking(false);
            setReplay(replay);
            // Notify any tournament runner waiting on this leg.
            if (liveLegResolver !== null) {
              const r = liveLegResolver;
              liveLegResolver = null;
              r(replay);
            }
          }
        }
      }, 200);
    }
    return next;
  }

  // 튜토리얼 모드에서 리플레이 재생 끝나면 호출할 콜백 — 합격 결과 카드 띄우기 등.
  // setReplay 가 호출될 때마다 새 재생이 시작되므로 이전 watch 는 폐기한다.
  let pendingPlaybackEnd: (() => void) | null = null;
  let pendingPlaybackEndInterval: number | null = null;

  function setReplay(replay: Replay): void {
    liveHandle = null;
    const timeline = buildTimeline(replay);
    mountSession(timeline, replay.meta, false);
    if (pendingPlaybackEndInterval !== null) {
      window.clearInterval(pendingPlaybackEndInterval);
      pendingPlaybackEndInterval = null;
    }
    if (pendingPlaybackEnd !== null) {
      const cb = pendingPlaybackEnd;
      pendingPlaybackEnd = null;
      pendingPlaybackEndInterval = window.setInterval(() => {
        if (player?.isAtEnd === true) {
          if (pendingPlaybackEndInterval !== null) {
            window.clearInterval(pendingPlaybackEndInterval);
            pendingPlaybackEndInterval = null;
          }
          cb();
        }
      }, 200);
    }
  }

  function startLiveStream(setup: SetupEvent, meta: ReplayMeta): void {
    liveHandle = createLiveTimeline(setup);
    mountSession(liveHandle.timeline as ReturnType<typeof buildTimeline>, meta, true);
  }

  setReplay(parseReplay(JSON.parse(smokeReplayJson)));

  const baked = bakedStudentAgent();
  // Default meta used while the live stream is mounting (before the engine's
  // own meta is available — we don't know agent class names until the replay
  // completes). Keeps the status panel headers from breaking.
  const placeholderMeta: ReplayMeta = {
    balance_version: '1.0',
    first_team: 'A',
    agents: { A: '내 AI', B: '상대 AI' },
  };
  const launchPanel = mountLaunchPanel(document.body, {
    onReplay: (replay) => {
      currentMatchKind = 'free';
      setReplay(replay);
    },
    onError: (err) => console.error('[launch]', err),
    initialSource: baked,
    ...(baked ? { initialLabel: 'agent.py (빌드 시점 고정)' } : {}),
    onLiveStream: {
      onSetup: (setup) => {
        currentMatchKind = 'free';
        startLiveStream(setup, placeholderMeta);
      },
      onEvent: (event) => {
        if (liveHandle && !liveHandle.isComplete) {
          liveHandle.appendEvent(event);
        }
      },
      onComplete: (replay) => {
        // Don't swap immediately — let the live player play through every
        // appended frame first. The thinkingPoll inside mountSession watches
        // for `liveHandle.isComplete && player.isAtEnd` and triggers the
        // swap to the fixed (hashed) replay then.
        pendingFinalReplay = replay;
      },
    },
  });

  // ─── Tournament panel (instructor mode) ───────────────────────────────
  // Reuse the launchPanel's runtime once it's loaded — Pyodide init is heavy
  // (~10MB) so we share the worker across single-match and tournament modes.
  // The runtime handle isn't directly exposed by launchPanel; we lazily load
  // our own here on first tournament match.
  let sharedRuntime: EngineRuntime | null = null;
  async function ensureRuntime(): Promise<EngineRuntime> {
    if (sharedRuntime !== null) return sharedRuntime;
    sharedRuntime = await loadEngineRuntime((msg) => {
      console.debug('[runtime]', msg);
    });
    return sharedRuntime;
  }

  /** Extract the aggregate winner team ('A' / 'B' / null) from a finished replay. */
  function winnerOfReplay(replay: Replay): GameWinner {
    const last = replay.events.at(-1);
    if (last?.kind !== 'end') return null;
    return last.data.winner;
  }

  /** Extract the final capture gauge dict from a finished replay (zeros if missing). */
  function gaugeOfReplay(replay: Replay): { A: number; B: number } {
    const last = replay.events.at(-1);
    if (last?.kind !== 'end') return { A: 0, B: 0 };
    return { A: last.data.gauge_a, B: last.data.gauge_b };
  }

  const tournamentPanel = mountTournamentPanel(document.body, {
    onError: (err) => console.error('[tournament]', err),
    onPlayMatch: async (pair, progress) => {
      currentMatchKind = 'tournament';
      const runtime = await ensureRuntime();
      const matchMeta: ReplayMeta = {
        balance_version: '1.0',
        first_team: 'A',
        agents: { A: pair.a.name, B: pair.b.name },
      };

      // Leg 1 — A goes first, broadcast LIVE so the audience watches the
      // signature game with full pacing + commentary opportunity.
      const homeReplay = await new Promise<Replay>((resolve, reject) => {
        liveLegResolver = resolve;
        runtime.runTournamentLive(
          {
            aSource: pair.a.source,
            bSource: pair.b.source,
            firstTeam: 'A',
            aLabel: pair.a.name,
            bLabel: pair.b.name,
          },
          {
            onEvent: (ev) => {
              if (ev.kind === 'setup') {
                startLiveStream(ev, matchMeta);
              } else if (liveHandle && !liveHandle.isComplete) {
                liveHandle.appendEvent(ev);
              }
            },
            onComplete: (replay) => {
              pendingFinalReplay = replay;
              // The actual resolve fires from the swap site (END_HOLD elapsed).
            },
            onError: (err) => {
              liveLegResolver = null;
              reject(err);
            },
          },
        );
      });
      const homeWinner = winnerOfReplay(homeReplay);

      // Leg 2 — B first. Run in worker batch so the bracket finishes in a
      // sensible time. The audience already saw the signature live game; the
      // away leg only needs to determine aggregate winner.
      void progress; // (reserved — could overlay leg progress later)
      const awayReplay = await runtime.runTournamentBatch({
        aSource: pair.a.source,
        bSource: pair.b.source,
        firstTeam: 'B',
        aLabel: pair.a.name,
        bLabel: pair.b.name,
      });
      const awayWinner = winnerOfReplay(awayReplay);

      return aggregateWinner(
        homeWinner,
        awayWinner,
        gaugeOfReplay(homeReplay),
        gaugeOfReplay(awayReplay),
      );
    },
  });

  // ─── Main menu + back button + hash routing ────────────────────────────
  // 부팅 시 메뉴를 띄우고, 모드 선택 시 해당 패널만 보이게 한다. 해시(#match
  // /#tournament/#tutorial)로 직진입 가능 — 강사가 수업 중 URL 공유로 빠르게
  // 진입시킬 때 유용.
  type ScreenMode = 'menu' | 'match' | 'tournament' | 'tutorial';

  let tutorialPanel: ReturnType<typeof mountTutorialPanel> | null = null;
  function setPanelsHidden(): void {
    launchPanel.root.style.display = 'none';
    tournamentPanel.hide();
    tutorialPanel?.hide();
  }
  setPanelsHidden();

  const backBtn = document.createElement('button');
  backBtn.className = 'maehwa-back';
  backBtn.innerHTML = `
    <style>
      .maehwa-back {
        position: fixed; top: 16px; left: 16px;
        padding: 9px 16px; border-radius: 999px;
        background: rgba(10, 14, 24, 0.9); color: #e8eaf0;
        border: 1px solid rgba(255, 184, 77, 0.35);
        font: 13px/1 'Pretendard Variable', system-ui, sans-serif;
        font-weight: 600; letter-spacing: 0.03em;
        cursor: pointer; z-index: 60;
        backdrop-filter: blur(8px);
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
        display: none;
      }
      .maehwa-back:hover { background: rgba(255, 184, 77, 0.22); color: #ffd58a; border-color: rgba(255, 184, 77, 0.7); }
      .maehwa-back.show { display: block; }
    </style>
    ← 메뉴로
  `;
  document.body.appendChild(backBtn);

  // 백버튼 동작은 컨텍스트에 따라 다르다 — 보통은 메뉴로 가지만, 튜토리얼 모드에서
  // 리플레이 재생 중 누르면 "튜토리얼 패널로 복귀"로 동작한다.
  let backHandler: () => void = () => goTo('menu');
  backBtn.addEventListener('click', () => backHandler());

  // 튜토리얼 패널은 결과 재생을 viewer 에 위임한다 — playReplay 가 호출되면 리플레이가
  // 끝날 때까지 백버튼을 "튜토리얼로 복귀"로 바꿔두고, 끝나면 결과 카드를 띄운다.
  tutorialPanel = mountTutorialPanel(document.body, {
    ensureRuntime,
    swapMap,
    setBackButtonVisible: (visible) => {
      if (visible) backBtn.classList.add('show');
      else backBtn.classList.remove('show');
    },
    playReplay: (replay) => {
      currentMatchKind = 'tutorial';
      pendingPlaybackEnd = () => {
        if (tutorialPanel !== null) tutorialPanel.onReplayEnded();
        backHandler = () => goTo('menu');
      };
      backHandler = () => {
        // 재생 도중 ← 누르면: watch 폐기 + 튜토리얼 패널 즉시 복귀.
        // 백버튼은 계속 노출(메뉴 복귀용) — 패널엔 메뉴 가는 UI 가 없다.
        pendingPlaybackEnd = null;
        if (pendingPlaybackEndInterval !== null) {
          window.clearInterval(pendingPlaybackEndInterval);
          pendingPlaybackEndInterval = null;
        }
        backHandler = () => goTo('menu');
        if (tutorialPanel !== null) {
          tutorialPanel.show();
        }
      };
      setReplay(replay);
      // batch 리플레이는 mountSession 이 자동 재생을 안 시키므로 (live 만 자동),
      // 튜토리얼 흐름에선 명시적으로 재생 시작 — 학생이 컨트롤 오버레이 ▶ 누르지 않아도 흘러가도록.
      player?.play();
    },
  });
  tutorialPanel.hide();

  const menu = mountMainMenu(document.body, {
    tutorialEnabled: true,
    onSelect: (mode: MenuMode) => goTo(mode),
  });

  function goTo(screen: ScreenMode): void {
    setPanelsHidden();
    backHandler = () => goTo('menu');
    // 튜토리얼 외 모드는 본 게임 11×7 디폴트 맵으로 복귀. 튜토리얼 모드 진입 시
    // 패널 자체가 currentScenario.mapText 로 swap 을 트리거한다.
    if (screen !== 'tutorial') {
      swapMap(defaultMapText);
    }
    if (screen === 'menu') {
      menu.show();
      backBtn.classList.remove('show');
      if (window.location.hash) {
        history.replaceState(null, '', window.location.pathname + window.location.search);
      }
      return;
    }
    menu.hide();
    backBtn.classList.add('show');
    if (screen === 'match') {
      launchPanel.root.style.display = '';
      if (window.location.hash !== '#match') history.replaceState(null, '', '#match');
    } else if (screen === 'tournament') {
      tournamentPanel.show();
      if (window.location.hash !== '#tournament') history.replaceState(null, '', '#tournament');
    } else if (screen === 'tutorial') {
      tutorialPanel?.show();
      if (window.location.hash !== '#tutorial') history.replaceState(null, '', '#tutorial');
    }
  }

  function applyHash(): void {
    const h = window.location.hash;
    if (h === '#match') goTo('match');
    else if (h === '#tournament') goTo('tournament');
    else if (h === '#tutorial') goTo('tutorial');
    else goTo('menu');
  }
  window.addEventListener('hashchange', applyHash);
  applyHash();

  // 첫 부팅 직후 한 번만 — DPR/해상도 조건 맞으면 컴팩트 UI 추천 토스트. 사용자가
  // 거절/수락하면 dismiss 플래그가 박혀 다시 안 뜬다.
  maybeShowAutoPrompt(document.body);

  recenter();
  window.addEventListener('resize', () => {
    recenter();
    lighting.resize(window.innerWidth, window.innerHeight);
  });
}

bootstrap().catch((err) => {
  console.error('[maehwa-viewer] bootstrap failed', err);
});
