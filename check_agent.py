"""Static agent validator (run before tournament submission).

Usage:
    python3 check_agent.py <path/to/agent.py>

Scans the source file for:
- forbidden imports (numpy, os, socket, requests, ...)
- forbidden builtin calls (exec, eval, compile, __import__, open, input)
- required AGENT_CLASS module variable
- MaehwaAgent subclass + execute_phase override
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path


FORBIDDEN_MODULES = frozenset(
    {
        "os",
        "sys",
        "subprocess",
        "multiprocessing",
        "threading",
        "asyncio",
        "socket",
        "urllib",
        "http",
        "requests",
        "pathlib",
        "shutil",
        "numpy",
        "pandas",
        "scipy",
        "torch",
        "tensorflow",
        "sklearn",
    }
)

FORBIDDEN_CALLS = frozenset({"exec", "eval", "compile", "__import__", "open", "input"})


class AgentCheck(ast.NodeVisitor):
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.has_agent_class_var = False
        self.class_defs_subclassing_agent: list[str] = []
        self._class_with_execute_phase: set[str] = set()

    def _forbidden_module(self, name: str) -> bool:
        root = name.split(".")[0]
        return root in FORBIDDEN_MODULES

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            if self._forbidden_module(alias.name):
                self.errors.append(f"line {node.lineno}: forbidden import '{alias.name}'")

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        mod = node.module or ""
        if self._forbidden_module(mod):
            self.errors.append(f"line {node.lineno}: forbidden import from '{mod}'")

    def visit_Call(self, node: ast.Call) -> None:
        func = node.func
        name: str | None = None
        if isinstance(func, ast.Name):
            name = func.id
        elif isinstance(func, ast.Attribute):
            name = func.attr
        if name in FORBIDDEN_CALLS:
            self.errors.append(f"line {node.lineno}: forbidden call '{name}'")
        self.generic_visit(node)

    def visit_Assign(self, node: ast.Assign) -> None:
        for target in node.targets:
            if isinstance(target, ast.Name) and target.id == "AGENT_CLASS":
                self.has_agent_class_var = True
        self.generic_visit(node)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        for base in node.bases:
            base_name = None
            if isinstance(base, ast.Name):
                base_name = base.id
            elif isinstance(base, ast.Attribute):
                base_name = base.attr
            if base_name == "MaehwaAgent":
                self.class_defs_subclassing_agent.append(node.name)
        for stmt in node.body:
            if isinstance(stmt, ast.FunctionDef) and stmt.name == "execute_phase":
                self._class_with_execute_phase.add(node.name)
        self.generic_visit(node)


def check_file(path: str | Path) -> list[str]:
    p = Path(path)
    if not p.exists():
        return [f"file not found: {p}"]
    try:
        tree = ast.parse(p.read_text(encoding="utf-8"), filename=str(p))
    except SyntaxError as exc:
        return [f"syntax error: {exc}"]
    checker = AgentCheck()
    checker.visit(tree)
    errs = list(checker.errors)
    if not checker.has_agent_class_var:
        errs.append("missing module-level AGENT_CLASS variable")
    if not checker.class_defs_subclassing_agent:
        errs.append("no class subclassing MaehwaAgent found")
    else:
        missing_exec = [
            c for c in checker.class_defs_subclassing_agent
            if c not in checker._class_with_execute_phase
        ]
        if missing_exec:
            errs.append(f"classes missing execute_phase override: {missing_exec}")
    return errs


def main(argv: list[str] | None = None) -> int:
    argv = argv or sys.argv[1:]
    if not argv:
        print("usage: python3 check_agent.py <agent.py>")
        return 2
    path = argv[0]
    errs = check_file(path)
    if errs:
        print(f"FAIL: {path}")
        for e in errs:
            print(f"  - {e}")
        return 1
    print(f"PASS: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
