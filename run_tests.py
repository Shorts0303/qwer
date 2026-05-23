"""Minimal pytest-free runner.

Discovers ``tests/test_*.py`` modules, runs every top-level function whose
name starts with ``test_``, prints a summary, and exits non-zero on failure.
Designed for environments where pip/pytest are unavailable.
"""

from __future__ import annotations

import importlib.util
import sys
import traceback
from pathlib import Path


def discover_tests(root: Path) -> list[Path]:
    return sorted(root.glob("test_*.py"))


def load_module(path: Path):
    spec = importlib.util.spec_from_file_location(f"_t_{path.stem}", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    project = Path(__file__).resolve().parent
    sys.path.insert(0, str(project))
    tests_dir = project / "tests"
    files = discover_tests(tests_dir)

    passed: list[str] = []
    failed: list[tuple[str, str]] = []
    for path in files:
        try:
            module = load_module(path)
        except Exception:
            failed.append((path.name, traceback.format_exc()))
            continue
        for name in sorted(vars(module)):
            if not name.startswith("test_"):
                continue
            fn = getattr(module, name)
            if not callable(fn):
                continue
            label = f"{path.stem}::{name}"
            try:
                fn()
            except Exception:
                failed.append((label, traceback.format_exc()))
                print(f"FAIL {label}")
            else:
                passed.append(label)
                print(f"PASS {label}")

    print()
    print(f"{len(passed)} passed, {len(failed)} failed")
    if failed:
        print("\n--- failures ---")
        for label, tb in failed:
            print(f"\n### {label}\n{tb}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
