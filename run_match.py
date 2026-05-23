"""CLI: run a single match between two agent files.

Usage:
    python3 run_match.py <agent_a.py> <agent_b.py> [--replay out.json]
                         [--first-team A|B] [--enforce-timeout]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from engine.agent_loader import load_agent_class
from engine.game_engine import GameEngine


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run a Maehwa Arena match.")
    parser.add_argument("agent_a", help="Path to agent A .py file")
    parser.add_argument("agent_b", help="Path to agent B .py file")
    parser.add_argument("--replay", default=None, help="Write replay JSON here")
    parser.add_argument("--first-team", default="A", choices=("A", "B"))
    parser.add_argument("--enforce-timeout", action="store_true")
    args = parser.parse_args(argv)

    a_cls = load_agent_class(args.agent_a)
    b_cls = load_agent_class(args.agent_b)
    engine = GameEngine(
        a_cls,
        b_cls,
        first_team=args.first_team,
        enforce_timeout=args.enforce_timeout,
        replay_meta={"agent_a_path": args.agent_a, "agent_b_path": args.agent_b},
    )
    result = engine.run()
    fg = result.final_gauge
    print(
        f"winner={result.winner} reason={result.reason} "
        f"round={result.round_number} gauge_a={fg['A']} gauge_b={fg['B']}"
    )
    if args.replay:
        path = engine.replay.save(args.replay)
        print(f"replay saved: {path}")
    else:
        print(f"replay hash: {engine.replay.compute_hash()[:16]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
