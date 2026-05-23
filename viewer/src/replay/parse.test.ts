import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parseReplay, ReplayParseError } from './parse';
import type { PhaseEvent, SetupEvent, EndEvent } from './types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SMOKE_PATH = resolve(__dirname, '../../../replays/smoke.json');

function loadSmoke(): unknown {
  return JSON.parse(readFileSync(SMOKE_PATH, 'utf-8'));
}

describe('parseReplay: real smoke.json fixture', () => {
  const replay = parseReplay(loadSmoke());

  it('round-trips the top-level structure', () => {
    expect(replay.meta.first_team).toBeTypeOf('string');
    expect(replay.meta.agents.A).toBeTypeOf('string');
    expect(replay.meta.agents.B).toBeTypeOf('string');
    expect(replay.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(replay.events.length).toBeGreaterThan(0);
  });

  it('emits a setup event with 10 units (5 per team) as the first event', () => {
    const first = replay.events[0];
    expect(first).toBeDefined();
    expect(first!.kind).toBe('setup');
    const setup = first as SetupEvent;
    expect(setup.data.units).toHaveLength(10);

    const teamA = setup.data.units.filter((u) => u.team === 'A');
    const teamB = setup.data.units.filter((u) => u.team === 'B');
    expect(teamA).toHaveLength(5);
    expect(teamB).toHaveLength(5);

    // unit_ids: A=0..4, B=5..9 per engine/game_engine.py UNIT_ORDER
    expect(teamA.map((u) => u.id).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    expect(teamB.map((u) => u.id).sort((a, b) => a - b)).toEqual([5, 6, 7, 8, 9]);
  });

  it('every setup unit_class is one of the four valid classes', () => {
    const first = replay.events[0] as SetupEvent;
    const valid = new Set(['dmr', 'rifle', 'shield', 'medic']);
    for (const u of first.data.units) {
      expect(valid.has(u.unit_class)).toBe(true);
    }
  });

  it('each phase event carries the full 10-unit snapshot', () => {
    const phases = replay.events.filter((e): e is PhaseEvent => e.kind === 'phase');
    expect(phases.length).toBeGreaterThan(0);
    for (const p of phases) {
      expect(p.data.units).toHaveLength(10);
      expect(['A', 'B']).toContain(p.phase_team);
      expect(['ok', 'timeout', 'exception']).toContain(p.data.status);
      expect(p.data.elapsed).toBeGreaterThanOrEqual(0);
    }
  });

  it('ends with an end event', () => {
    const last = replay.events[replay.events.length - 1];
    expect(last).toBeDefined();
    expect(last!.kind).toBe('end');
    const end = last as EndEvent;
    expect(['A', 'B', null]).toContain(end.data.winner);
    expect(typeof end.data.reason).toBe('string');
  });

  it('coords are readonly 2-tuples', () => {
    const first = replay.events[0] as SetupEvent;
    const u0 = first.data.units[0]!;
    expect(u0.pos).toHaveLength(2);
    expect(typeof u0.pos[0]).toBe('number');
    expect(typeof u0.pos[1]).toBe('number');
  });
});

describe('parseReplay: error reporting', () => {
  it('rejects non-object root', () => {
    expect(() => parseReplay(null)).toThrow(ReplayParseError);
    expect(() => parseReplay([])).toThrow(/expected object/);
    expect(() => parseReplay(42)).toThrow(/expected object/);
  });

  it('rejects missing meta.first_team', () => {
    expect(() =>
      parseReplay({ meta: { balance_version: '1.0', agents: { A: 'X', B: 'Y' } }, events: [], hash: 'x' }),
    ).toThrow(/meta.first_team/);
  });

  it('rejects invalid team id', () => {
    expect(() =>
      parseReplay({
        meta: { first_team: 'C', balance_version: '1.0', agents: { A: 'X', B: 'Y' } },
        events: [],
        hash: 'x',
      }),
    ).toThrow(/first_team/);
  });

  it('rejects unknown event kind', () => {
    expect(() =>
      parseReplay({
        meta: { first_team: 'A', balance_version: '1.0', agents: { A: 'X', B: 'Y' } },
        events: [{ kind: 'mystery', round: 1, phase_team: '-', data: {} }],
        hash: 'x',
      }),
    ).toThrow(/unknown kind "mystery"/);
  });

  it('rejects setup event with non-zero round', () => {
    expect(() =>
      parseReplay({
        meta: { first_team: 'A', balance_version: '1.0', agents: { A: 'X', B: 'Y' } },
        events: [{ kind: 'setup', round: 1, phase_team: '-', data: { units: [] } }],
        hash: 'x',
      }),
    ).toThrow(/setup event must have round=0/);
  });

  it('rejects phase event with phase_team="-"', () => {
    expect(() =>
      parseReplay({
        meta: { first_team: 'A', balance_version: '1.0', agents: { A: 'X', B: 'Y' } },
        events: [
          {
            kind: 'phase',
            round: 1,
            phase_team: '-',
            data: { status: 'ok', elapsed: 0, units: [], gauge: 0 },
          },
        ],
        hash: 'x',
      }),
    ).toThrow(/phase_team/);
  });

  it('rejects end event with unknown reason', () => {
    expect(() =>
      parseReplay({
        meta: { first_team: 'A', balance_version: '1.0', agents: { A: 'X', B: 'Y' } },
        events: [
          {
            kind: 'end',
            round: 5,
            phase_team: '-',
            data: { winner: 'A', reason: 'quantum_collapse', gauge: 0 },
          },
        ],
        hash: 'x',
      }),
    ).toThrow(/unknown reason/);
  });

  it('rejects malformed coords', () => {
    expect(() =>
      parseReplay({
        meta: { first_team: 'A', balance_version: '1.0', agents: { A: 'X', B: 'Y' } },
        events: [
          {
            kind: 'setup',
            round: 0,
            phase_team: '-',
            data: {
              units: [
                { id: 0, team: 'A', unit_class: 'dmr', hp: 250, max_hp: 250, pos: [1, 2, 3] },
              ],
            },
          },
        ],
        hash: 'x',
      }),
    ).toThrow(/pos/);
  });
});
