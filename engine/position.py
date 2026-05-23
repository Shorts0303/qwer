"""Hex coordinate primitives.

Uses pointy-top "odd-r" offset coordinates externally (col, row) and cube
coordinates (q, r, s) with q + r + s == 0 internally for distance / line
calculations.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Position:
    col: int
    row: int

    def to_cube(self) -> tuple[int, int, int]:
        q = self.col - (self.row - (self.row & 1)) // 2
        r = self.row
        s = -q - r
        return q, r, s

    @classmethod
    def from_cube(cls, q: int, r: int, s: int) -> "Position":
        assert q + r + s == 0, f"cube invariant violated: ({q},{r},{s})"
        col = q + (r - (r & 1)) // 2
        return cls(col, r)

    def __repr__(self) -> str:  # pragma: no cover - trivial
        return f"Position({self.col}, {self.row})"


_CUBE_DIRS: tuple[tuple[int, int, int], ...] = (
    (+1, -1, 0),
    (+1, 0, -1),
    (0, +1, -1),
    (-1, +1, 0),
    (-1, 0, +1),
    (0, -1, +1),
)


def hex_distance(a: Position, b: Position) -> int:
    aq, ar, as_ = a.to_cube()
    bq, br, bs_ = b.to_cube()
    return (abs(aq - bq) + abs(ar - br) + abs(as_ - bs_)) // 2


def hex_neighbors(pos: Position) -> list[Position]:
    q, r, s = pos.to_cube()
    return [Position.from_cube(q + dq, r + dr, s + ds) for dq, dr, ds in _CUBE_DIRS]


def _cube_round(qf: float, rf: float, sf: float) -> tuple[int, int, int]:
    q = round(qf)
    r = round(rf)
    s = round(sf)
    dq = abs(q - qf)
    dr = abs(r - rf)
    ds = abs(s - sf)
    if dq > dr and dq > ds:
        q = -r - s
    elif dr > ds:
        r = -q - s
    else:
        s = -q - r
    return q, r, s


def hex_line(a: Position, b: Position) -> list[Position]:
    """Return tiles on the straight hex line from ``a`` to ``b`` (inclusive)."""
    n = hex_distance(a, b)
    if n == 0:
        return [a]
    aq, ar, as_ = a.to_cube()
    bq, br, bs_ = b.to_cube()
    # Nudge endpoints infinitesimally to keep rounding deterministic on ties.
    eps = 1e-6
    aqf, arf, asf = aq + eps, ar + eps, as_ - 2 * eps
    results: list[Position] = []
    for i in range(n + 1):
        t = i / n
        qf = aqf + (bq - aqf) * t
        rf = arf + (br - arf) * t
        sf = asf + (bs_ - asf) * t
        q, r, s = _cube_round(qf, rf, sf)
        results.append(Position.from_cube(q, r, s))
    return results
