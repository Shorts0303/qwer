import { describe, it, expect } from 'vitest';
import {
  aggregateWinner,
  applyMatchResult,
  generateNextRound,
  leaderboard,
  makeEntrant,
  points,
  type Entrant,
  type MatchPair,
} from './swiss';

function mk(name: string): Entrant {
  return makeEntrant(name, name, '');
}

describe('aggregateWinner', () => {
  it('A wins both → A', () => expect(aggregateWinner('A', 'A')).toBe('A'));
  it('A wins one + draw → A', () => expect(aggregateWinner('A', null)).toBe('A'));
  it('1-1 split → null (match draw)', () => expect(aggregateWinner('A', 'B')).toBe(null));
  it('B wins both → B', () => expect(aggregateWinner('B', 'B')).toBe('B'));
  it('two draws → null', () => expect(aggregateWinner(null, null)).toBe(null));
  it('B wins one + draw → B', () => expect(aggregateWinner(null, 'B')).toBe('B'));
  it('1-1 split with A-favor gauge → A wins via tiebreak', () =>
    expect(aggregateWinner('A', 'B', { A: 90, B: 0 }, { A: 10, B: 0 })).toBe('A'));
  it('1-1 split with B-favor gauge → B wins via tiebreak', () =>
    expect(aggregateWinner('A', 'B', { A: 0, B: 20 }, { A: 0, B: 90 })).toBe('B'));
  it('1-1 split with equal gauge totals → still draw', () =>
    expect(aggregateWinner('A', 'B', { A: 50, B: 50 }, { A: 30, B: 30 })).toBe(null));
  it('decisive scoreline ignores gauge tiebreak', () =>
    expect(aggregateWinner('A', 'A', { A: 0, B: 200 }, { A: 0, B: 200 })).toBe('A'));
});

describe('points', () => {
  it('counts wins as 1 and draws as 0.5', () => {
    const e = makeEntrant('x', 'x', '');
    e.wins = 3;
    e.draws = 2;
    e.losses = 1;
    expect(points(e)).toBe(4);
  });
});

describe('generateNextRound — round 1 (no prior matches)', () => {
  it('pairs all entrants when count is even', () => {
    const es = [mk('a'), mk('b'), mk('c'), mk('d')];
    const r = generateNextRound(1, es);
    expect(r.pairs.length).toBe(2);
    expect(r.bye).toBe(null);
    // Every entrant appears exactly once
    const ids = r.pairs.flatMap((p) => [p.a.id, p.b.id]);
    expect(new Set(ids).size).toBe(4);
  });

  it('byes the lowest-name entrant when count is odd', () => {
    const es = [mk('alice'), mk('bob'), mk('charlie')];
    const r = generateNextRound(1, es);
    expect(r.pairs.length).toBe(1);
    expect(r.bye).not.toBe(null);
    // With equal points and name tiebreak, charlie (last) gets the carry → bye
    expect(r.bye!.name).toBe('charlie');
    expect(r.bye!.wins).toBe(1);
    expect(r.bye!.byeReceived).toBe(true);
  });
});

describe('generateNextRound — round N (point-bucketed pairing)', () => {
  it('pairs within point buckets, descending', () => {
    const es = [mk('a'), mk('b'), mk('c'), mk('d')];
    es[0]!.wins = 1; // a: 1 pt
    es[1]!.wins = 1; // b: 1 pt
    es[2]!.wins = 0; // c: 0 pt
    es[3]!.wins = 0; // d: 0 pt
    const r = generateNextRound(2, es);
    expect(r.pairs.length).toBe(2);
    expect(r.bye).toBe(null);
    // Top bucket pair must be (a, b); bottom bucket (c, d).
    const top = r.pairs[0]!;
    const bot = r.pairs[1]!;
    expect(new Set([top.a.id, top.b.id])).toEqual(new Set(['a', 'b']));
    expect(new Set([bot.a.id, bot.b.id])).toEqual(new Set(['c', 'd']));
  });

  it('floats odd entrant down into next bucket so no one byes', () => {
    const es = [mk('a'), mk('b'), mk('c'), mk('d'), mk('e'), mk('f')];
    // 3 entrants at 1pt, 3 at 0pt — both buckets odd, but the float merges
    // the strays into the lower bucket making it even.
    es[0]!.wins = 1;
    es[1]!.wins = 1;
    es[2]!.wins = 1;
    const r = generateNextRound(2, es);
    expect(r.pairs.length).toBe(3);
    expect(r.bye).toBe(null);
    // 'c' (last of the 1pt bucket alphabetically) should be paired with a
    // 0pt entrant rather than another 1pt entrant.
    const cPair = r.pairs.find((p) => p.a.id === 'c' || p.b.id === 'c')!;
    const cOpp = cPair.a.id === 'c' ? cPair.b : cPair.a;
    expect(['d', 'e', 'f']).toContain(cOpp.id);
  });

  it('avoids immediate rematch when one-swap look-ahead is available', () => {
    const es = [mk('a'), mk('b'), mk('c'), mk('d')];
    // All at 0 pts. Mark a–b as already played.
    es[0]!.opponents = ['b'];
    es[1]!.opponents = ['a'];
    const r = generateNextRound(2, es);
    // First pair would naturally be (a, b) — must swap to (a, c) instead.
    const aPair = r.pairs.find((p) => p.a.id === 'a' || p.b.id === 'a')!;
    const aOpp = aPair.a.id === 'a' ? aPair.b.id : aPair.a.id;
    expect(aOpp).not.toBe('b');
  });

  it('falls back to rematch when no swap target exists (last pair)', () => {
    const es = [mk('a'), mk('b')];
    es[0]!.opponents = ['b'];
    es[1]!.opponents = ['a'];
    const r = generateNextRound(2, es);
    expect(r.pairs.length).toBe(1);
    // Forced rematch — algorithm doesn't strand entrants.
    expect(new Set([r.pairs[0]!.a.id, r.pairs[0]!.b.id])).toEqual(new Set(['a', 'b']));
  });
});

describe('applyMatchResult', () => {
  it('A win → a +1W, b +1L; opponents updated', () => {
    const a = mk('a');
    const b = mk('b');
    const pair: MatchPair = { a, b };
    applyMatchResult(pair, 'A');
    expect(a.wins).toBe(1);
    expect(b.losses).toBe(1);
    expect(a.opponents).toEqual(['b']);
    expect(b.opponents).toEqual(['a']);
  });

  it('draw → both +1D', () => {
    const a = mk('a');
    const b = mk('b');
    applyMatchResult({ a, b }, null);
    expect(a.draws).toBe(1);
    expect(b.draws).toBe(1);
  });
});

describe('leaderboard', () => {
  it('orders by points desc, wins desc, name asc', () => {
    const a = mk('a');
    const b = mk('b');
    const c = mk('c');
    a.wins = 2;
    b.wins = 1;
    b.draws = 2; // 2 pts
    c.wins = 2; // ties a on points (2)
    const lb = leaderboard([a, b, c]);
    // a and c both 2pts/2wins → name asc: a then c. b has 2pts but only 1 win → after.
    expect(lb.map((e) => e.name)).toEqual(['a', 'c', 'b']);
  });
});

describe('integration — small 4-player tournament', () => {
  it('runs 3 rounds, all players paired each round (no bye), every match accounted for', () => {
    const es = [mk('a'), mk('b'), mk('c'), mk('d')];
    for (let round = 1; round <= 3; round += 1) {
      const r = generateNextRound(round, es);
      expect(r.bye).toBe(null);
      expect(r.pairs.length).toBe(2);
      // Resolve each pair deterministically (always 'A' wins for test purposes)
      for (const p of r.pairs) applyMatchResult(p, 'A');
    }
    // Total games per entrant = 3 (one per round)
    const totals = es.map((e) => e.wins + e.draws + e.losses);
    expect(totals).toEqual([3, 3, 3, 3]);
  });
});
