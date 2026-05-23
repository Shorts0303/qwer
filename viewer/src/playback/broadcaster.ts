/**
 * Broadcaster — orchestrates a "live broadcast" replay mode.
 *
 * Between each replay frame it:
 *   1. Diffs the current → next frame to identify acting units.
 *   2. For units that attacked/healed, renders a team-colored range overlay
 *      on reachable tiles so viewers see "what this unit can hit".
 *   3. Pauses briefly (rangeShowMs) to let the audience read the threat.
 *   4. Advances the player one frame — UnitRenderer snaps positions and
 *      triggers its fire / push anim from its existing heuristics.
 *   5. Pauses again (frameSettleMs) for animations to breathe.
 *
 * The broadcaster does not drive UnitRenderer directly; it just paces the
 * underlying ReplayPlayer. Movement tweening + per-unit focus are follow-ups.
 */

import type { Container } from 'pixi.js';
import { hexDistance } from '../hex/coord';
import type { HexLayout } from '../hex/layout';
import { computeAttackRange } from '../map/attackRange';
import type { GameMap } from '../map/gameMap';
import { createRangeOverlay } from '../render/rangeOverlay';
import { computePhaseAnimationDurationMs } from '../render/unitRenderer';
import type { ReplayPlayer } from './player';
import type { Frame, UnitState } from './timeline';
import type { TeamId, UnitClass } from '../replay/types';

const TEAM_COLORS: Record<TeamId, number> = {
  A: 0xff6b47,
  B: 0x4ba3ff,
};

const ACTION_RANGE: Record<UnitClass, number> = {
  shield: 1,
  rifle:  3,
  dmr:    5,
  medic:  2,
};

export interface BroadcasterOptions {
  readonly rangeLayer: Container;
  readonly map: GameMap;
  readonly layout: HexLayout;
  readonly rangeShowMs?: number;
  readonly frameSettleMs?: number;
  readonly scheduler?: {
    setTimeout(cb: () => void, ms: number): number;
    clearTimeout(h: number): void;
  };
}

const defaultScheduler = {
  setTimeout: (cb: () => void, ms: number): number =>
    globalThis.setTimeout(cb, ms) as unknown as number,
  clearTimeout: (h: number): void =>
    globalThis.clearTimeout(h as unknown as ReturnType<typeof globalThis.setTimeout>),
};

export class Broadcaster {
  private readonly player: ReplayPlayer;
  private readonly rangeLayer: Container;
  private readonly map: GameMap;
  private readonly layout: HexLayout;
  private readonly rangeShowMs: number;
  private readonly frameSettleMs: number;
  private readonly scheduler: NonNullable<BroadcasterOptions['scheduler']>;
  private readonly rangeChildren: Container[] = [];
  private running = false;
  private timerHandle: number | null = null;

  constructor(player: ReplayPlayer, options: BroadcasterOptions) {
    this.player = player;
    this.rangeLayer = options.rangeLayer;
    this.map = options.map;
    this.layout = options.layout;
    this.rangeShowMs = options.rangeShowMs ?? 500;
    // Baseline settle used for non-phase frames (gauge/end) or phases without
    // actions. Phase frames with actions override this with a dynamic value
    // computed from the action sequence length — see tick().
    this.frameSettleMs = options.frameSettleMs ?? 600;
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  get isRunning(): boolean {
    return this.running;
  }

  play(): void {
    if (this.running) return;
    this.running = true;
    this.tick();
  }

  pause(): void {
    this.running = false;
    if (this.timerHandle !== null) {
      this.scheduler.clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
    this.clearRange();
  }

  togglePlay(): void {
    if (this.running) this.pause();
    else this.play();
  }

  dispose(): void {
    this.pause();
  }

  private tick(): void {
    if (!this.running) return;
    if (this.player.isAtEnd) {
      this.running = false;
      return;
    }

    const current = this.player.currentFrame;
    const nextIdx = this.player.currentIndex + 1;
    const next = this.player.getTimeline().frames[nextIdx];
    if (next === undefined) {
      this.running = false;
      return;
    }

    this.clearRange();
    const actors = identifyAttackers(current, next);
    for (const a of actors) {
      const tiles = computeAttackRange(a, this.map, next.units.values());
      if (tiles.length === 0) continue;
      const overlay = createRangeOverlay(tiles, {
        color: TEAM_COLORS[a.team],
        alpha: 0.22,
        strokeWidth: 2,
        layout: this.layout,
      });
      this.rangeLayer.addChild(overlay);
      this.rangeChildren.push(overlay);
    }

    this.timerHandle = this.scheduler.setTimeout(() => {
      this.timerHandle = null;
      if (!this.running) return;
      this.clearRange();
      this.player.stepForward();
      // After the frame is painted, wait long enough for its sequential
      // per-unit animation to finish. Phase frames with actions get dynamic
      // settle; other frames fall back to the baseline.
      const revealed = this.player.currentFrame;
      const settle = revealed.actions.length > 0
        ? computePhaseAnimationDurationMs(revealed.actions)
        : this.frameSettleMs;
      this.timerHandle = this.scheduler.setTimeout(() => {
        this.timerHandle = null;
        this.tick();
      }, settle);
    }, this.rangeShowMs);
  }

  private clearRange(): void {
    for (const c of this.rangeChildren) {
      c.destroy({ children: true });
    }
    this.rangeChildren.length = 0;
  }
}

/**
 * Identify units of the acting team (the phase_team of `next`) that plausibly
 * attacked/healed between `prev` and `next`. Attribution is heuristic: any
 * acting-team unit within action range of an HP-changed enemy/ally is marked.
 * False positives are acceptable — they just produce slightly more range
 * overlays, which looks more dramatic anyway.
 */
function identifyAttackers(prev: Frame, next: Frame): UnitState[] {
  if (next.phase !== 'A' && next.phase !== 'B') return [];
  const team = next.phase;
  const out: UnitState[] = [];
  for (const [uid, u] of next.units) {
    if (u.team !== team || !u.alive) continue;
    const range = ACTION_RANGE[u.unitClass];
    let hit = false;
    for (const [tid, t] of next.units) {
      if (tid === uid) continue;
      const before = prev.units.get(tid);
      if (before === undefined) continue;
      if (u.unitClass === 'medic') {
        // Medic "acts" if an ally's HP increased within range.
        if (t.team === team && t.hp > before.hp) {
          const d = hexDistance({ col: u.col, row: u.row }, { col: t.col, row: t.row });
          if (d <= range) {
            hit = true;
            break;
          }
        }
      } else {
        if (t.team !== team && t.hp < before.hp) {
          const d = hexDistance({ col: u.col, row: u.row }, { col: t.col, row: t.row });
          if (d <= range) {
            hit = true;
            break;
          }
        }
      }
    }
    if (hit) out.push(u);
  }
  return out;
}
