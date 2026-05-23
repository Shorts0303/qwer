import type {
  AttackAction,
  Coord,
  EndEvent,
  EndReason,
  GaugeEvent,
  HealAction,
  MoveAction,
  PhaseAction,
  PhaseEvent,
  PhaseStatus,
  PhaseUnit,
  Replay,
  ReplayEvent,
  ReplayMeta,
  SetupEvent,
  SetupUnit,
  TeamId,
  UnitClass,
} from './types';

export class ReplayParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayParseError';
  }
}

const UNIT_CLASSES = new Set<UnitClass>(['dmr', 'rifle', 'shield', 'medic']);
const PHASE_STATUSES = new Set<PhaseStatus>(['ok', 'timeout', 'exception']);
const END_REASONS = new Set<EndReason>([
  'gauge',
  'gauge_tied_hp',
  'annihilation',
  'timeout',
  'consecutive_timeout',
  'exception',
  'rounds',
  'rounds_gauge',
  'rounds_hp',
  'draw',
]);

export function parseReplay(json: unknown): Replay {
  const root = asObject(json, 'root');
  const meta = parseMeta(root['meta']);
  const rawEvents = asArray(root['events'], 'events');
  const events = rawEvents.map((e, i) => parseEvent(e, i));
  const hash = asString(root['hash'], 'hash');
  return { meta, events, hash };
}

export async function loadReplayFromUrl(url: string): Promise<Replay> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new ReplayParseError(`HTTP ${res.status} fetching ${url}`);
  }
  return parseReplay(await res.json());
}

export async function loadReplayFromBlob(blob: Blob): Promise<Replay> {
  const text = await blob.text();
  return parseReplay(JSON.parse(text));
}

// ---------- meta -----------------------------------------------------------

function parseMeta(value: unknown): ReplayMeta {
  const obj = asObject(value, 'meta');
  const first_team = asTeam(obj['first_team'], 'meta.first_team');
  const balance_version = asString(obj['balance_version'], 'meta.balance_version');
  const agentsObj = asObject(obj['agents'], 'meta.agents');
  const agents = {
    A: asString(agentsObj['A'], 'meta.agents.A'),
    B: asString(agentsObj['B'], 'meta.agents.B'),
  };

  const meta: Record<string, unknown> = { ...obj };
  meta['balance_version'] = balance_version;
  meta['first_team'] = first_team;
  meta['agents'] = agents;
  return meta as unknown as ReplayMeta;
}

// ---------- events ---------------------------------------------------------

/**
 * Parse a single ReplayEvent JSON object — used by the live broadcast pump
 * to consume events one at a time as Python yields them. The full-replay
 * parser uses this internally.
 */
export function parseSingleEvent(value: unknown): ReplayEvent {
  return parseEvent(value, 0);
}

function parseEvent(value: unknown, idx: number): ReplayEvent {
  const obj = asObject(value, `events[${idx}]`);
  const kind = asString(obj['kind'], `events[${idx}].kind`);
  const round = asNumber(obj['round'], `events[${idx}].round`);
  const phase_team = asString(obj['phase_team'], `events[${idx}].phase_team`);
  const data = asObject(obj['data'], `events[${idx}].data`);
  switch (kind) {
    case 'setup':
      return parseSetupEvent(round, phase_team, data, idx);
    case 'phase':
      return parsePhaseEvent(round, phase_team, data, idx);
    case 'gauge':
      return parseGaugeEvent(round, phase_team, data, idx);
    case 'end':
      return parseEndEvent(round, phase_team, data, idx);
    default:
      throw new ReplayParseError(`events[${idx}].kind: unknown kind "${kind}"`);
  }
}

function parseSetupEvent(
  round: number,
  phase_team: string,
  data: Record<string, unknown>,
  idx: number,
): SetupEvent {
  if (round !== 0) {
    throw new ReplayParseError(`events[${idx}]: setup event must have round=0, got ${round}`);
  }
  if (phase_team !== '-') {
    throw new ReplayParseError(`events[${idx}]: setup event must have phase_team="-"`);
  }
  const rawUnits = asArray(data['units'], `events[${idx}].data.units`);
  const units = rawUnits.map((u, i) => parseSetupUnit(u, `events[${idx}].data.units[${i}]`));
  return { kind: 'setup', round: 0, phase_team: '-', data: { units } };
}

function parsePhaseEvent(
  round: number,
  phase_team: string,
  data: Record<string, unknown>,
  idx: number,
): PhaseEvent {
  const team = asTeam(phase_team, `events[${idx}].phase_team`);
  const status = asPhaseStatus(data['status'], `events[${idx}].data.status`);
  const elapsed = asNumber(data['elapsed'], `events[${idx}].data.elapsed`);
  const gauge_a = asNumber(data['gauge_a'], `events[${idx}].data.gauge_a`);
  const gauge_b = asNumber(data['gauge_b'], `events[${idx}].data.gauge_b`);
  const rawUnits = asArray(data['units'], `events[${idx}].data.units`);
  const units = rawUnits.map((u, i) => parsePhaseUnit(u, `events[${idx}].data.units[${i}]`));
  const rawActions = data['actions'];
  const actions = rawActions === undefined
    ? []
    : asArray(rawActions, `events[${idx}].data.actions`).map(
        (a, i) => parsePhaseAction(a, `events[${idx}].data.actions[${i}]`),
      );
  return {
    kind: 'phase',
    round,
    phase_team: team,
    data: { status, elapsed, units, actions, gauge_a, gauge_b },
  };
}

function parsePhaseAction(value: unknown, path: string): PhaseAction {
  const obj = asObject(value, path);
  const kind = asString(obj['kind'], `${path}.kind`);
  switch (kind) {
    case 'move':
      return parseMoveAction(obj, path);
    case 'attack':
      return parseAttackAction(obj, path);
    case 'heal':
      return parseHealAction(obj, path);
    default:
      throw new ReplayParseError(`${path}.kind: unknown action kind "${kind}"`);
  }
}

function parseMoveAction(obj: Record<string, unknown>, path: string): MoveAction {
  const rawPath = asArray(obj['path'], `${path}.path`);
  const pathCoords = rawPath.map((p, i) => asCoord(p, `${path}.path[${i}]`));
  return {
    kind: 'move',
    unit_id: asNumber(obj['unit_id'], `${path}.unit_id`),
    from: asCoord(obj['from'], `${path}.from`),
    to: asCoord(obj['to'], `${path}.to`),
    path: pathCoords,
  };
}

function parseAttackAction(obj: Record<string, unknown>, path: string): AttackAction {
  return {
    kind: 'attack',
    unit_id: asNumber(obj['unit_id'], `${path}.unit_id`),
    target_id: asNumber(obj['target_id'], `${path}.target_id`),
    damage: asNumber(obj['damage'], `${path}.damage`),
    target_hp_after: asNumber(obj['target_hp_after'], `${path}.target_hp_after`),
  };
}

function parseHealAction(obj: Record<string, unknown>, path: string): HealAction {
  return {
    kind: 'heal',
    unit_id: asNumber(obj['unit_id'], `${path}.unit_id`),
    target_id: asNumber(obj['target_id'], `${path}.target_id`),
    amount: asNumber(obj['amount'], `${path}.amount`),
    target_hp_after: asNumber(obj['target_hp_after'], `${path}.target_hp_after`),
  };
}

function parseGaugeEvent(
  round: number,
  phase_team: string,
  data: Record<string, unknown>,
  idx: number,
): GaugeEvent {
  if (phase_team !== '-') {
    throw new ReplayParseError(`events[${idx}]: gauge event must have phase_team="-"`);
  }
  return {
    kind: 'gauge',
    round,
    phase_team: '-',
    data: {
      n_a: asNumber(data['n_a'], `events[${idx}].data.n_a`),
      n_b: asNumber(data['n_b'], `events[${idx}].data.n_b`),
      delta_a: asNumber(data['delta_a'], `events[${idx}].data.delta_a`),
      delta_b: asNumber(data['delta_b'], `events[${idx}].data.delta_b`),
      gauge_a: asNumber(data['gauge_a'], `events[${idx}].data.gauge_a`),
      gauge_b: asNumber(data['gauge_b'], `events[${idx}].data.gauge_b`),
    },
  };
}

function parseEndEvent(
  round: number,
  phase_team: string,
  data: Record<string, unknown>,
  idx: number,
): EndEvent {
  if (phase_team !== '-') {
    throw new ReplayParseError(`events[${idx}]: end event must have phase_team="-"`);
  }
  const winnerRaw = data['winner'];
  let winner: TeamId | null;
  if (winnerRaw === null) {
    winner = null;
  } else if (winnerRaw === 'A' || winnerRaw === 'B') {
    winner = winnerRaw;
  } else {
    throw new ReplayParseError(
      `events[${idx}].data.winner: expected "A" | "B" | null, got ${JSON.stringify(winnerRaw)}`,
    );
  }
  const reasonStr = asString(data['reason'], `events[${idx}].data.reason`);
  if (!END_REASONS.has(reasonStr as EndReason)) {
    throw new ReplayParseError(
      `events[${idx}].data.reason: unknown reason "${reasonStr}"`,
    );
  }
  return {
    kind: 'end',
    round,
    phase_team: '-',
    data: {
      winner,
      reason: reasonStr as EndReason,
      gauge_a: asNumber(data['gauge_a'], `events[${idx}].data.gauge_a`),
      gauge_b: asNumber(data['gauge_b'], `events[${idx}].data.gauge_b`),
    },
  };
}

// ---------- unit parsers ---------------------------------------------------

function parseSetupUnit(value: unknown, path: string): SetupUnit {
  const obj = asObject(value, path);
  const cls = asString(obj['unit_class'], `${path}.unit_class`);
  if (!UNIT_CLASSES.has(cls as UnitClass)) {
    throw new ReplayParseError(`${path}.unit_class: unknown class "${cls}"`);
  }
  return {
    id: asNumber(obj['id'], `${path}.id`),
    team: asTeam(obj['team'], `${path}.team`),
    unit_class: cls as UnitClass,
    hp: asNumber(obj['hp'], `${path}.hp`),
    max_hp: asNumber(obj['max_hp'], `${path}.max_hp`),
    pos: asCoord(obj['pos'], `${path}.pos`),
  };
}

function parsePhaseUnit(value: unknown, path: string): PhaseUnit {
  const obj = asObject(value, path);
  return {
    id: asNumber(obj['id'], `${path}.id`),
    hp: asNumber(obj['hp'], `${path}.hp`),
    pos: asCoord(obj['pos'], `${path}.pos`),
    alive: asBoolean(obj['alive'], `${path}.alive`),
  };
}

// ---------- primitive asserters -------------------------------------------

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReplayParseError(`${path}: expected object, got ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ReplayParseError(`${path}: expected array, got ${describe(value)}`);
  }
  return value;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new ReplayParseError(`${path}: expected string, got ${describe(value)}`);
  }
  return value;
}

function asNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new ReplayParseError(`${path}: expected number, got ${describe(value)}`);
  }
  return value;
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ReplayParseError(`${path}: expected boolean, got ${describe(value)}`);
  }
  return value;
}

function asTeam(value: unknown, path: string): TeamId {
  if (value !== 'A' && value !== 'B') {
    throw new ReplayParseError(`${path}: expected "A" | "B", got ${describe(value)}`);
  }
  return value;
}

function asPhaseStatus(value: unknown, path: string): PhaseStatus {
  if (typeof value !== 'string' || !PHASE_STATUSES.has(value as PhaseStatus)) {
    throw new ReplayParseError(`${path}: expected phase status, got ${describe(value)}`);
  }
  return value as PhaseStatus;
}

function asCoord(value: unknown, path: string): Coord {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new ReplayParseError(`${path}: expected [col, row], got ${describe(value)}`);
  }
  const col = asNumber(value[0], `${path}[0]`);
  const row = asNumber(value[1], `${path}[1]`);
  return [col, row] as const;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(length=${value.length})`;
  return typeof value;
}

