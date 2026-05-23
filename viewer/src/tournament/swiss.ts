/**
 * Swiss-system tournament pairing — TypeScript port of run_tournament.py.
 *
 * Pure functions only: data model, points, pairing, aggregation, leaderboard.
 * Match execution lives elsewhere (Pyodide worker via runMatch). Keeping this
 * module IO-free lets it be unit-tested headlessly and reused regardless of
 * how matches are actually played out (live mode, batch, replay-only).
 *
 * Authoritative format spec: documents/04_운영_가이드.md §4.
 */

export type GameWinner = 'A' | 'B' | null;

export interface Entrant {
  readonly id: string;       // stable unique id (e.g. file blob hash or sequential)
  readonly name: string;     // display name (typically filename stem)
  readonly source: string;   // student .py source code
  wins: number;
  draws: number;
  losses: number;
  /** Ids of entrants already faced (used to discourage immediate rematches). */
  opponents: string[];
  /** True once this entrant has received a bye — the guide forbids two byes per entrant. */
  byeReceived: boolean;
}

export interface MatchPair {
  readonly a: Entrant;
  readonly b: Entrant;
}

export interface RoundPairing {
  readonly round: number;
  readonly pairs: readonly MatchPair[];
  /** Entrant who received a free-win bye this round (already credited +1 win), or null. */
  readonly bye: Entrant | null;
}

export function makeEntrant(id: string, name: string, source: string): Entrant {
  return {
    id,
    name,
    source,
    wins: 0,
    draws: 0,
    losses: 0,
    opponents: [],
    byeReceived: false,
  };
}

export function points(e: Entrant): number {
  return e.wins + 0.5 * e.draws;
}

/**
 * Aggregate winner of a home & away pair of games.
 * Scoring per game: win=3, draw=1, loss=0. Higher total takes the match.
 *
 * When totals are equal, an optional gauge tiebreak applies (v4 게이지 독립화 후):
 *   homeGauge / awayGauge 는 {A, B} 두 팀 게이지 dict.
 *   양 leg 의 A 게이지 합 vs B 게이지 합 비교 → 큰 쪽 승, 같으면 무승부.
 *
 * Rationale: 1-1 split 매치에서 어느 팀이 더 결정적이었는지 평가. 양 팀 독립
 * 게이지 누적합으로 계산하므로 학생 직관과 일치.
 */
export function aggregateWinner(
  home: GameWinner,
  away: GameWinner,
  homeGauge?: { A: number; B: number },
  awayGauge?: { A: number; B: number },
): 'A' | 'B' | null {
  let scoreA = 0;
  let scoreB = 0;
  for (const w of [home, away]) {
    if (w === 'A') scoreA += 3;
    else if (w === 'B') scoreB += 3;
    else {
      scoreA += 1;
      scoreB += 1;
    }
  }
  if (scoreA > scoreB) return 'A';
  if (scoreB > scoreA) return 'B';
  if (homeGauge !== undefined && awayGauge !== undefined) {
    const aTotal = homeGauge.A + awayGauge.A;
    const bTotal = homeGauge.B + awayGauge.B;
    if (aTotal > bTotal) return 'A';
    if (bTotal > aTotal) return 'B';
  }
  return null;
}

/**
 * Build the next round's pairing using the Swiss system.
 *
 * Algorithm (mirrors run_tournament.py::_swiss_round with a small extension):
 *   1. Sort entrants by points desc, name asc (deterministic tiebreak).
 *   2. Bucket by points value.
 *   3. Walk buckets high→low. If a bucket has odd size, pop the lowest-ranked
 *      member as a "carry" that descends into the next bucket.
 *   4. Pair adjacent members. If an entrant would face an opponent they've
 *      already met, swap with the next member (one-swap look-ahead).
 *   5. If an entrant carries past the lowest bucket, they receive a bye —
 *      a free win + the byeReceived flag is set.
 *
 * Mutates `bye` entrant directly when a bye is awarded (matches CLI behavior
 * so the caller doesn't need a separate "apply bye" step).
 */
export function generateNextRound(roundNum: number, entrants: readonly Entrant[]): RoundPairing {
  const buckets = new Map<number, Entrant[]>();
  const sorted = [...entrants].sort((x, y) => {
    const dp = points(y) - points(x);
    if (dp !== 0) return dp;
    return x.name.localeCompare(y.name);
  });
  for (const e of sorted) {
    const p = points(e);
    let arr = buckets.get(p);
    if (arr === undefined) {
      arr = [];
      buckets.set(p, arr);
    }
    arr.push(e);
  }

  const sortedPts = Array.from(buckets.keys()).sort((a, b) => b - a);
  const pairs: MatchPair[] = [];
  let carry: Entrant | null = null;

  for (const pts of sortedPts) {
    const group = buckets.get(pts)!.slice();
    if (carry !== null) {
      group.unshift(carry);
      carry = null;
    }
    if (group.length % 2 === 1) {
      carry = group.pop()!;
    }
    for (let i = 0; i < group.length; i += 2) {
      const a = group[i]!;
      let b = group[i + 1]!;
      // One-swap look-ahead to avoid immediate rematch.
      if (a.opponents.includes(b.id) && i + 2 < group.length) {
        const tmp = group[i + 1]!;
        group[i + 1] = group[i + 2]!;
        group[i + 2] = tmp;
        b = group[i + 1]!;
      }
      pairs.push({ a, b });
    }
  }

  let bye: Entrant | null = null;
  if (carry !== null) {
    bye = carry;
    carry.wins += 1;
    carry.byeReceived = true;
  }

  return { round: roundNum, pairs, bye };
}

/**
 * Apply a match's aggregate result to the two entrants involved.
 * Records the opponent and updates W/D/L. Mutates both entrants in place.
 */
export function applyMatchResult(pair: MatchPair, winner: 'A' | 'B' | null): void {
  const { a, b } = pair;
  a.opponents.push(b.id);
  b.opponents.push(a.id);
  if (winner === null) {
    a.draws += 1;
    b.draws += 1;
  } else if (winner === 'A') {
    a.wins += 1;
    b.losses += 1;
  } else {
    b.wins += 1;
    a.losses += 1;
  }
}

/** Sort by points desc, then wins desc, then name asc for deterministic display. */
export function leaderboard(entrants: readonly Entrant[]): Entrant[] {
  return [...entrants].sort((a, b) => {
    const dp = points(b) - points(a);
    if (dp !== 0) return dp;
    const dw = b.wins - a.wins;
    if (dw !== 0) return dw;
    return a.name.localeCompare(b.name);
  });
}
