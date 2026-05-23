"""Dynamic agent loader used by run_match / run_tournament."""

from __future__ import annotations

import importlib.util
from pathlib import Path

from agents.base_agent import MaehwaAgent


class AgentLoadError(Exception):
    pass


def load_agent_class(path: str | Path) -> type[MaehwaAgent]:
    p = Path(path).resolve()
    if not p.exists():
        raise AgentLoadError(f"agent file not found: {p}")
    spec = importlib.util.spec_from_file_location(f"agent_{p.stem}", p)
    if spec is None or spec.loader is None:
        raise AgentLoadError(f"cannot load spec: {p}")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as exc:
        raise AgentLoadError(f"import failed: {exc}") from exc
    cls = getattr(module, "AGENT_CLASS", None)
    if cls is None:
        raise AgentLoadError(f"{p.name} has no AGENT_CLASS")
    if not isinstance(cls, type) or not issubclass(cls, MaehwaAgent):
        raise AgentLoadError(f"{p.name}: AGENT_CLASS must subclass MaehwaAgent")
    return cls
