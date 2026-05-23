"""Game map: tile grid, distance / neighbor / line-of-sight helpers."""

from __future__ import annotations

from collections import deque
from pathlib import Path
from typing import Callable, Iterable

from engine.position import Position, hex_distance, hex_line, hex_neighbors
from engine.tiles import TileProps, TileType, props_of, tile_from_char


class GameMap:
    def __init__(self, tiles: list[list[TileType]]):
        if not tiles:
            raise ValueError("empty map")
        self._tiles = tiles
        self.height = len(tiles)
        self.width = len(tiles[0])
        if any(len(row) != self.width for row in tiles):
            raise ValueError("ragged map rows")
        self._capture_points: tuple[Position, ...] = tuple(
            Position(c, r)
            for r, row in enumerate(tiles)
            for c, t in enumerate(row)
            if t is TileType.CAPTURE
        )

    # ----- construction --------------------------------------------------

    @classmethod
    def load(cls, path: str | Path) -> "GameMap":
        text = Path(path).read_text(encoding="utf-8")
        grid: list[list[TileType]] = []
        for line in text.splitlines():
            if not line:
                continue
            grid.append([tile_from_char(ch) for ch in line])
        return cls(grid)

    # ----- basics --------------------------------------------------------

    def is_valid_position(self, pos: Position) -> bool:
        return 0 <= pos.col < self.width and 0 <= pos.row < self.height

    def tile_at(self, pos: Position) -> TileType:
        return self._tiles[pos.row][pos.col]

    def props_at(self, pos: Position) -> TileProps:
        return props_of(self.tile_at(pos))

    def is_walkable(self, pos: Position) -> bool:
        return self.is_valid_position(pos) and self.props_at(pos).walkable

    def blocks_vision(self, pos: Position) -> bool:
        return self.is_valid_position(pos) and self.props_at(pos).blocks_vision

    def is_high_ground(self, pos: Position) -> bool:
        return self.is_valid_position(pos) and self.props_at(pos).is_high_ground

    def is_capture_point(self, pos: Position) -> bool:
        return self.is_valid_position(pos) and self.props_at(pos).is_capture_point

    @property
    def capture_point_positions(self) -> tuple[Position, ...]:
        return self._capture_points

    # ----- geometry ------------------------------------------------------

    def distance(self, a: Position, b: Position) -> int:
        return hex_distance(a, b)

    def neighbors(self, pos: Position) -> list[Position]:
        return [n for n in hex_neighbors(pos) if self.is_valid_position(n)]

    def tiles_in_range(self, center: Position, radius: int) -> list[Position]:
        out: list[Position] = []
        for r in range(self.height):
            for c in range(self.width):
                p = Position(c, r)
                if hex_distance(center, p) <= radius:
                    out.append(p)
        return out

    def line_between(self, a: Position, b: Position) -> list[Position]:
        return hex_line(a, b)

    # ----- pathfinding ---------------------------------------------------

    def bfs_reachable(
        self,
        origin: Position,
        max_cost: int,
        blocked: Callable[[Position], bool] | None = None,
    ) -> dict[Position, int]:
        """Breadth-first reachable tiles up to ``max_cost`` hex steps.

        ``blocked(pos)`` returns True if a tile is impassable in addition to
        the normal walkable check (used to mark unit-occupied tiles). The
        origin tile itself is always reachable at cost 0.
        """
        out: dict[Position, int] = {origin: 0}
        queue: deque[Position] = deque([origin])
        while queue:
            cur = queue.popleft()
            cost = out[cur]
            if cost == max_cost:
                continue
            for nb in self.neighbors(cur):
                if nb in out:
                    continue
                if not self.is_walkable(nb):
                    continue
                if blocked is not None and blocked(nb):
                    continue
                out[nb] = cost + 1
                queue.append(nb)
        return out

    def find_path(
        self,
        start: Position,
        goal: Position,
        blocked: Callable[[Position], bool] | None = None,
    ) -> list[Position] | None:
        """BFS shortest path (excluding ``start``) or None if unreachable."""
        if start == goal:
            return []
        if not self.is_walkable(goal):
            return None
        came: dict[Position, Position] = {}
        seen: set[Position] = {start}
        queue: deque[Position] = deque([start])
        while queue:
            cur = queue.popleft()
            for nb in self.neighbors(cur):
                if nb in seen:
                    continue
                if not self.is_walkable(nb):
                    continue
                if nb != goal and blocked is not None and blocked(nb):
                    continue
                seen.add(nb)
                came[nb] = cur
                if nb == goal:
                    path: list[Position] = []
                    node = goal
                    while node != start:
                        path.append(node)
                        node = came[node]
                    path.reverse()
                    return path
                queue.append(nb)
        return None

    # ----- line of sight -------------------------------------------------

    def has_line_of_sight(
        self,
        from_pos: Position,
        to_pos: Position,
        occupied: Iterable[Position] = (),
    ) -> bool:
        """Vision test: walls and intervening units block; lakes do not.

        Endpoints are excluded from obstruction checks.
        """
        if from_pos == to_pos:
            return True
        occupied_set = set(occupied)
        line = hex_line(from_pos, to_pos)
        for tile in line[1:-1]:
            if not self.is_valid_position(tile):
                return False
            if self.blocks_vision(tile):
                return False
            if tile in occupied_set:
                return False
        return True
