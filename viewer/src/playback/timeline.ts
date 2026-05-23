/**
 * Build a frame-by-frame timeline from a Replay. Each frame is the materialized
 * game state at that point in time (unit positions/HP, gauge, round).
 *
 * Frame granularity = one replay event. The initial "setup" event becomes
 * frame 0; subsequent phase/gauge/end events each append a frame that diffs
 * from the previous one.
 */

import type { PhaseAction, Replay, ReplayEvent, SetupEvent, TeamId, UnitClass } from '../replay/types';

export interface UnitState {
  readonly id: number;
  readonly team: TeamId;
  readonly unitClass: UnitClass;
  readonly hp: number;
  readonly maxHp: number;
  readonly col: number;
  readonly row: number;
  readonly alive: boolean;
}

export type FramePhase = TeamId | 'setup' | 'gauge' | 'end';

export interface Frame {
  readonly eventIndex: number;
  readonly round: number;
  readonly phase: FramePhase;
  readonly units: ReadonlyMap<number, UnitState>;
  /** v4+: 양 팀 독립 게이지 (이전: 단일 시소 number). */
  readonly gauge: { readonly A: number; readonly B: number };
  readonly description: string;
  /**
   * Per-action log for phase frames (v3+ replays). Empty for setup/gauge/end
   * frames and for v2 replays. Used by the renderer to animate per-tile
   * movement and telegraph attacks/heals with precise attribution.
   */
  readonly actions: readonly PhaseAction[];
  /**
   * 연속 타임아웃 누적 (이 프레임 시점). 룰북 §5.6 의 consecutive_timeout_limit
   * (=3) 도달 시 자동 패배. 정상 phase 후엔 해당 팀 카운트가 0으로 리셋.
   * status overlay 의 ⚠ 표시에 사용.
   */
  readonly warnings: { readonly A: number; readonly B: number };
}

export interface Timeline {
  readonly frames: readonly Frame[];
  readonly winner: TeamId | null;
  readonly endReason: string;
}

export class TimelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimelineError';
  }
}

/**
 * Mutable timeline implementation that conforms to the public ``Timeline``
 * interface. Used both by the batch ``buildTimeline`` (which fills it once)
 * and by the live broadcast pump (which appends frames as Pyodide yields).
 */
class MutableTimeline implements Timeline {
  readonly frames: Frame[] = [];
  winner: TeamId | null = null;
  endReason: string = 'rounds';
}

export interface LiveTimelineHandle {
  readonly timeline: Timeline;
  /** True once the end event has been appended (match concluded). */
  readonly isComplete: boolean;
  /** Append one event from a streaming source — mutates `timeline.frames`. */
  appendEvent(event: ReplayEvent): void;
}

export function createLiveTimeline(setupEvent: SetupEvent): LiveTimelineHandle {
  const out = new MutableTimeline();
  const builder = new Builder(out);
  builder.applySetup(setupEvent);
  let complete = false;
  return {
    get timeline(): Timeline { return out; },
    get isComplete(): boolean { return complete; },
    appendEvent(event) {
      if (event.kind === 'setup') {
        throw new TimelineError('live timeline rejects a second setup event');
      }
      builder.applyEvent(event, out.frames.length);
      if (event.kind === 'end') complete = true;
    },
  };
}

export function buildTimeline(replay: Replay): Timeline {
  if (replay.events.length === 0) {
    throw new TimelineError('replay has no events');
  }
  const first = replay.events[0]!;
  if (first.kind !== 'setup') {
    throw new TimelineError('replay must start with a setup event');
  }

  const out = new MutableTimeline();
  const builder = new Builder(out);
  builder.applySetup(first);

  for (let i = 1; i < replay.events.length; i += 1) {
    const e = replay.events[i]!;
    if (e.kind === 'setup') {
      throw new TimelineError(`unexpected second setup event at index ${i}`);
    }
    builder.applyEvent(e, i);
  }
  return out;
}

/** Internal helper that owns the running unit/gauge state and pushes frames. */
class Builder {
  private units: Map<number, UnitState> = new Map();
  private gaugeA = 0;
  private gaugeB = 0;
  /**
   * 연속 타임아웃 누적 (엔진 _consec_timeout 와 동일 의미). 정상 phase 후
   * 해당 팀 카운트 0 으로 리셋. 매 프레임 emit 시 freeze 한 카피를 박음.
   */
  private warnA = 0;
  private warnB = 0;
  constructor(private readonly out: MutableTimeline) {}

  private snapshotWarnings(): { readonly A: number; readonly B: number } {
    return { A: this.warnA, B: this.warnB };
  }

  private snapshotGauge(): { readonly A: number; readonly B: number } {
    return { A: this.gaugeA, B: this.gaugeB };
  }

  applySetup(setupEvent: SetupEvent): void {
    this.units = seedUnits(setupEvent.data.units);
    this.gaugeA = 0;
    this.gaugeB = 0;
    this.out.frames.push({
      eventIndex: 0,
      round: 0,
      phase: 'setup',
      units: this.units,
      gauge: this.snapshotGauge(),
      description: '초기 배치',
      actions: [],
      warnings: this.snapshotWarnings(),
    });
  }

  applyEvent(e: Exclude<ReplayEvent, SetupEvent>, eventIndex: number): void {
    if (e.kind === 'phase') {
      if (e.data.status === 'timeout') {
        if (e.phase_team === 'A') this.warnA += 1; else this.warnB += 1;
      } else if (e.data.status === 'ok') {
        if (e.phase_team === 'A') this.warnA = 0; else this.warnB = 0;
      }
      this.units = applyPhaseSnapshot(this.units, e.data.units);
      this.gaugeA = e.data.gauge_a;
      this.gaugeB = e.data.gauge_b;
      const teamName = e.phase_team === 'A' ? 'A팀' : 'B팀';
      const statusTag = e.data.status === 'ok' ? '' : ` [${e.data.status}]`;
      this.out.frames.push({
        eventIndex,
        round: e.round,
        phase: e.phase_team,
        units: this.units,
        gauge: this.snapshotGauge(),
        description: `라운드 ${e.round} · ${teamName} 페이즈${statusTag}`,
        actions: e.data.actions,
        warnings: this.snapshotWarnings(),
      });
    } else if (e.kind === 'gauge') {
      this.gaugeA = e.data.gauge_a;
      this.gaugeB = e.data.gauge_b;
      const dA = e.data.delta_a;
      const dB = e.data.delta_b;
      const deltaStr = `A+${dA} B+${dB}`;
      this.out.frames.push({
        eventIndex,
        round: e.round,
        phase: 'gauge',
        units: this.units,
        gauge: this.snapshotGauge(),
        description: `라운드 ${e.round} · 점령 판정 (${deltaStr})`,
        actions: [],
        warnings: this.snapshotWarnings(),
      });
    } else if (e.kind === 'end') {
      this.out.winner = e.data.winner;
      this.out.endReason = e.data.reason;
      this.gaugeA = e.data.gauge_a;
      this.gaugeB = e.data.gauge_b;
      this.out.frames.push({
        eventIndex,
        round: e.round,
        phase: 'end',
        units: this.units,
        gauge: this.snapshotGauge(),
        description: formatEnd(e.data.winner, e.data.reason),
        actions: [],
        warnings: this.snapshotWarnings(),
      });
    }
  }
}

function seedUnits(setupUnits: readonly {
  id: number;
  team: TeamId;
  unit_class: UnitClass;
  hp: number;
  max_hp: number;
  pos: readonly [number, number];
}[]): Map<number, UnitState> {
  const m = new Map<number, UnitState>();
  for (const u of setupUnits) {
    m.set(u.id, {
      id: u.id,
      team: u.team,
      unitClass: u.unit_class,
      hp: u.hp,
      maxHp: u.max_hp,
      col: u.pos[0],
      row: u.pos[1],
      alive: u.hp > 0,
    });
  }
  return m;
}

function applyPhaseSnapshot(
  prev: ReadonlyMap<number, UnitState>,
  phaseUnits: readonly {
    id: number;
    hp: number;
    pos: readonly [number, number];
    alive: boolean;
  }[],
): Map<number, UnitState> {
  const next = new Map<number, UnitState>();
  for (const [id, u] of prev) {
    next.set(id, u);
  }
  for (const u of phaseUnits) {
    const existing = next.get(u.id);
    if (existing === undefined) {
      throw new TimelineError(
        `phase references unknown unit id=${u.id}; setup must precede phases`,
      );
    }
    next.set(u.id, {
      ...existing,
      hp: u.hp,
      col: u.pos[0],
      row: u.pos[1],
      alive: u.alive,
    });
  }
  return next;
}

function formatEnd(winner: TeamId | null, reason: string): string {
  const reasonKo = translateReason(reason);
  if (winner === null) {
    return `무승부 (${reasonKo})`;
  }
  return `${winner}팀 승리 (${reasonKo})`;
}

function translateReason(reason: string): string {
  switch (reason) {
    case 'gauge': return '게이지';
    case 'gauge_tied_hp': return '게이지 동률 → 체력';
    case 'annihilation': return '전멸';
    case 'timeout': return '타임아웃';
    case 'consecutive_timeout': return '연속 타임아웃';
    case 'exception': return '예외';
    case 'rounds': return '30라운드 소진';
    case 'rounds_gauge': return '30라운드 게이지';
    case 'rounds_hp': return '30라운드 체력';
    case 'draw': return '무승부';
    default: return reason;
  }
}
