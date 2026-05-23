import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parseReplay } from '../replay/parse';
import { buildTimeline, TimelineError } from './timeline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SMOKE_PATH = resolve(__dirname, '../../../replays/smoke.json');

describe('buildTimeline: real smoke.json', () => {
  const replay = parseReplay(JSON.parse(readFileSync(SMOKE_PATH, 'utf-8')));
  const timeline = buildTimeline(replay);

  it('first frame is the setup snapshot', () => {
    const f = timeline.frames[0];
    expect(f).toBeDefined();
    expect(f!.phase).toBe('setup');
    expect(f!.round).toBe(0);
    expect(f!.units.size).toBe(10);
    // 게이지 v2 (2026-05-06): 양 팀 독립 0~100. 셋업 직후엔 양쪽 0.
    expect(f!.gauge).toEqual({ A: 0, B: 0 });
  });

  it('number of frames equals number of events', () => {
    expect(timeline.frames.length).toBe(replay.events.length);
  });

  it('unit ids 0..9 are populated in every frame', () => {
    for (const f of timeline.frames) {
      for (let id = 0; id <= 9; id += 1) {
        expect(f.units.has(id)).toBe(true);
      }
    }
  });

  it('units preserve their static identity (team, class, max_hp) across frames', () => {
    const first = timeline.frames[0]!;
    const last = timeline.frames[timeline.frames.length - 1]!;
    for (const [id, u0] of first.units) {
      const uN = last.units.get(id)!;
      expect(uN.team).toBe(u0.team);
      expect(uN.unitClass).toBe(u0.unitClass);
      expect(uN.maxHp).toBe(u0.maxHp);
    }
  });

  it('last frame is the end frame with a winner or null', () => {
    const last = timeline.frames[timeline.frames.length - 1]!;
    expect(last.phase).toBe('end');
    expect(['A', 'B', null]).toContain(timeline.winner);
    expect(timeline.endReason).toBeTypeOf('string');
  });

  it('positions can change between phase frames (units actually move)', () => {
    const f0 = timeline.frames[0]!;
    const someLater = timeline.frames[Math.min(3, timeline.frames.length - 1)]!;
    let moved = false;
    for (const [id, u0] of f0.units) {
      const uN = someLater.units.get(id)!;
      if (uN.col !== u0.col || uN.row !== u0.row) {
        moved = true;
        break;
      }
    }
    expect(moved).toBe(true);
  });

  it('gauge values are non-null numbers in [0, 100] for both teams', () => {
    // 게이지 v2: 양 팀 독립. 각각 0~100 범위에서만 움직인다.
    for (const f of timeline.frames) {
      expect(typeof f.gauge.A).toBe('number');
      expect(typeof f.gauge.B).toBe('number');
      expect(f.gauge.A).toBeGreaterThanOrEqual(0);
      expect(f.gauge.A).toBeLessThanOrEqual(100);
      expect(f.gauge.B).toBeGreaterThanOrEqual(0);
      expect(f.gauge.B).toBeLessThanOrEqual(100);
    }
  });

  it('descriptions are Korean strings', () => {
    expect(timeline.frames[0]!.description).toContain('초기');
    const phaseFrame = timeline.frames.find((f) => f.phase === 'A' || f.phase === 'B');
    expect(phaseFrame?.description).toMatch(/라운드|페이즈/);
  });
});

describe('buildTimeline: error cases', () => {
  it('rejects empty replay', () => {
    expect(() =>
      buildTimeline({
        meta: { first_team: 'A', balance_version: '1.0', agents: { A: 'X', B: 'Y' } },
        events: [],
        hash: 'x',
      }),
    ).toThrow(TimelineError);
  });

  it('rejects replay that does not start with setup', () => {
    expect(() =>
      buildTimeline({
        meta: { first_team: 'A', balance_version: '1.0', agents: { A: 'X', B: 'Y' } },
        events: [
          {
            kind: 'phase',
            round: 1,
            phase_team: 'A',
            data: { status: 'ok', elapsed: 0, units: [], actions: [], gauge_a: 0, gauge_b: 0 },
          },
        ],
        hash: 'x',
      }),
    ).toThrow(/must start with a setup event/);
  });
});
