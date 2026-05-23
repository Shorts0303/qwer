"""Append-only event log → deterministic JSON replay.

The engine records one event per phase/action. A final hash over the event
stream is stored alongside so two replays of the same game can be compared
byte-for-byte.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class ReplayEvent:
    kind: str
    round: int
    phase_team: str
    data: dict[str, Any] = field(default_factory=dict)


class Replay:
    # v4: 게이지 독립화 (단일 시소 [-100, +100] → 양 팀 독립 0~100).
    # gauge event: {gauge_a, gauge_b, delta_a, delta_b} (이전: {gauge, delta}).
    # end event:   {gauge_a, gauge_b}                    (이전: {gauge}).
    FORMAT_VERSION = 4

    def __init__(self, meta: dict[str, Any] | None = None):
        self.meta: dict[str, Any] = dict(meta or {})
        self.meta.setdefault("format_version", self.FORMAT_VERSION)
        self.events: list[ReplayEvent] = []

    def record(self, kind: str, round_: int, phase_team: str, **data) -> None:
        self.events.append(ReplayEvent(kind=kind, round=round_, phase_team=phase_team, data=data))

    def to_dict(self) -> dict[str, Any]:
        body = {
            "meta": self.meta,
            "events": [asdict(e) for e in self.events],
        }
        body["hash"] = self.compute_hash()
        return body

    # Wall-clock / timing fields are excluded from the deterministic hash.
    _NON_HASHED_KEYS = frozenset({"elapsed"})

    def _canonical_events(self) -> list[dict[str, Any]]:
        canonical = []
        for e in self.events:
            d = asdict(e)
            d["data"] = {k: v for k, v in d["data"].items() if k not in self._NON_HASHED_KEYS}
            canonical.append(d)
        return canonical

    def compute_hash(self) -> str:
        payload = json.dumps(
            {"events": self._canonical_events()},
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def save(self, path: str | Path) -> Path:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(
            json.dumps(self.to_dict(), ensure_ascii=False, indent=2, default=str),
            encoding="utf-8",
        )
        return p
