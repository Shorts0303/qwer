/**
 * TypeScript shape for replay JSON emitted by engine/replay.py (format_version=3).
 *
 * Keep these types in lockstep with engine/game_engine.py::_run_phase (phase events),
 * engine/game_engine.py::run (setup + end events), and engine/game_engine.py::_apply_gauge.
 * documents/02_게임_룰북.md is the authoritative source if values diverge.
 *
 * v3 adds `actions[]` inside each phase event: an ordered per-action log
 * (move/attack/heal) used by the viewer for per-tile animation, attack
 * telegraphs, and heal FX. Engine state remains snapshot-authoritative —
 * `actions` is strictly a renderer sidecar.
 */

export type TeamId = 'A' | 'B';
export type UnitClass = 'dmr' | 'rifle' | 'shield' | 'medic';

/** (col, row) odd-r offset coordinates — matches engine/position.py */
export type Coord = readonly [number, number];

export type PhaseStatus = 'ok' | 'timeout' | 'exception';

export type EndReason =
  | 'gauge'
  | 'gauge_tied_hp'   // v4+: 양 팀 동시 게이지 100 도달 → HP 합 tiebreak 결정
  | 'annihilation'
  | 'timeout'
  | 'consecutive_timeout'
  | 'exception'
  | 'rounds'
  | 'rounds_gauge'
  | 'rounds_hp'
  | 'draw';

export interface ReplayMeta {
  readonly balance_version: string;
  readonly first_team: TeamId;
  readonly agents: { readonly A: string; readonly B: string };
  readonly agent_a_path?: string;
  readonly agent_b_path?: string;
  readonly format_version?: number;
  readonly [extra: string]: unknown;
}

export interface SetupUnit {
  readonly id: number;
  readonly team: TeamId;
  readonly unit_class: UnitClass;
  readonly hp: number;
  readonly max_hp: number;
  readonly pos: Coord;
}

export interface PhaseUnit {
  readonly id: number;
  readonly hp: number;
  readonly pos: Coord;
  readonly alive: boolean;
}

export interface SetupEvent {
  readonly kind: 'setup';
  readonly round: 0;
  readonly phase_team: '-';
  readonly data: { readonly units: readonly SetupUnit[] };
}

export interface MoveAction {
  readonly kind: 'move';
  readonly unit_id: number;
  readonly from: Coord;
  readonly to: Coord;
  /** Intermediate tiles (excluding `from`, including `to`) for per-tile animation. */
  readonly path: readonly Coord[];
}

export interface AttackAction {
  readonly kind: 'attack';
  readonly unit_id: number;
  readonly target_id: number;
  readonly damage: number;
  readonly target_hp_after: number;
}

export interface HealAction {
  readonly kind: 'heal';
  readonly unit_id: number;
  readonly target_id: number;
  readonly amount: number;
  readonly target_hp_after: number;
}

export type PhaseAction = MoveAction | AttackAction | HealAction;

export interface PhaseEvent {
  readonly kind: 'phase';
  readonly round: number;
  readonly phase_team: TeamId;
  readonly data: {
    readonly status: PhaseStatus;
    readonly elapsed: number;
    readonly units: readonly PhaseUnit[];
    /** v3+: per-action log. Absent or empty on older replays. */
    readonly actions: readonly PhaseAction[];
    /** v4+: 양 팀 독립 게이지 (이전: 단일 시소 gauge: number). */
    readonly gauge_a: number;
    readonly gauge_b: number;
  };
}

export interface GaugeEvent {
  readonly kind: 'gauge';
  readonly round: number;
  readonly phase_team: '-';
  readonly data: {
    readonly n_a: number;
    readonly n_b: number;
    /** v4+: 팀별 독립 누적량 (이전: 단일 delta). */
    readonly delta_a: number;
    readonly delta_b: number;
    readonly gauge_a: number;
    readonly gauge_b: number;
  };
}

export interface EndEvent {
  readonly kind: 'end';
  readonly round: number;
  readonly phase_team: '-';
  readonly data: {
    readonly winner: TeamId | null;
    readonly reason: EndReason;
    /** v4+: 양 팀 독립 게이지. */
    readonly gauge_a: number;
    readonly gauge_b: number;
  };
}

export type ReplayEvent = SetupEvent | PhaseEvent | GaugeEvent | EndEvent;

export interface Replay {
  readonly meta: ReplayMeta;
  readonly events: readonly ReplayEvent[];
  readonly hash: string;
}
