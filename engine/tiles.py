"""Tile types and their static properties (walkable / vision / bonuses)."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class TileType(str, Enum):
    PLAIN = "plain"
    LAKE = "lake"
    WALL = "wall"
    HIGH_GROUND = "high_ground"
    CAPTURE = "capture"


_CHAR_MAP = {
    ".": TileType.PLAIN,
    "~": TileType.LAKE,
    "#": TileType.WALL,
    "^": TileType.HIGH_GROUND,
    "*": TileType.CAPTURE,
}


def tile_from_char(ch: str) -> TileType:
    try:
        return _CHAR_MAP[ch]
    except KeyError as exc:
        raise ValueError(f"unknown map character: {ch!r}") from exc


@dataclass(frozen=True)
class TileProps:
    walkable: bool
    blocks_vision: bool
    is_high_ground: bool
    is_capture_point: bool


_PROPS: dict[TileType, TileProps] = {
    TileType.PLAIN: TileProps(True, False, False, False),
    TileType.LAKE: TileProps(False, False, False, False),
    TileType.WALL: TileProps(False, True, False, False),
    TileType.HIGH_GROUND: TileProps(True, False, True, False),
    TileType.CAPTURE: TileProps(True, False, False, True),
}


def props_of(tile: TileType) -> TileProps:
    return _PROPS[tile]
