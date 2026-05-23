/// <reference lib="webworker" />
/**
 * Pyodide engine worker — runs the entire Python game engine off the main
 * thread so the PIXI ticker, audio, and DOM stay responsive even when an
 * agent's compute (tree search, MCTS, etc.) takes hundreds of milliseconds
 * per phase.
 *
 * Protocol: main thread sends `MainMessage`, worker replies with one or more
 * `WorkerMessage` keyed by the same request id. The streaming variant emits
 * one `stream-event` per yielded ReplayEvent and a final `stream-complete`
 * carrying the canonical replay (with hash). `stop` flips a flag the streaming
 * loop checks between events to exit early.
 */

import type { PyodideInterface } from 'pyodide';
import {
  collectAgentFiles,
  collectEngineFiles,
  type OpponentOption,
} from './engineSources';

const PYODIDE_VERSION = '0.29.3';
const PYODIDE_CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

export interface SerializedTutorialOverride {
  readonly mapText: string;
  readonly startPositions: {
    readonly A: Readonly<Record<string, readonly [number, number]>>;
    readonly B: Readonly<Record<string, readonly [number, number]>>;
  };
  readonly maxRounds?: number;
}

export interface SerializedRunOptions {
  readonly studentSource: string;
  readonly studentClassName: string;
  readonly opponent: OpponentOption;
  readonly studentTeam: 'A' | 'B';
  readonly firstTeam?: 'A' | 'B';
  readonly tutorialOverride?: SerializedTutorialOverride;
}

/** Tournament match: both sides supply their own .py source — no opponent
 *  baked-in. Used for instructor-driven brackets where every entrant is a
 *  user-uploaded agent. firstTeam is required (we run both legs explicitly). */
export interface SerializedTournamentOptions {
  readonly aSource: string;
  readonly bSource: string;
  readonly firstTeam: 'A' | 'B';
  readonly aLabel: string;
  readonly bLabel: string;
}

export type MainMessage =
  | { type: 'init'; id: number }
  | { type: 'runMatch'; id: number; options: SerializedRunOptions }
  | { type: 'runMatchStreaming'; id: number; options: SerializedRunOptions }
  | { type: 'runTournamentLive'; id: number; options: SerializedTournamentOptions }
  | { type: 'runTournamentBatch'; id: number; options: SerializedTournamentOptions }
  | { type: 'stop'; id: number };

export type WorkerMessage =
  | { type: 'progress'; id: number; message: string }
  | { type: 'ready'; id: number }
  | { type: 'match-replay'; id: number; replayJson: string }
  | { type: 'stream-event'; id: number; eventJson: string }
  | { type: 'stream-complete'; id: number; replayJson: string }
  | { type: 'error'; id: number; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let pyodide: PyodideInterface | null = null;
const stopFlags = new Map<number, boolean>();

ctx.onmessage = async (e: MessageEvent<MainMessage>): Promise<void> => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'init':
        await handleInit(msg.id);
        break;
      case 'runMatch':
        await handleRunMatch(msg.id, msg.options);
        break;
      case 'runMatchStreaming':
        await handleRunMatchStreaming(msg.id, msg.options);
        break;
      case 'runTournamentLive':
        await handleRunTournamentLive(msg.id, msg.options);
        break;
      case 'runTournamentBatch':
        await handleRunTournamentBatch(msg.id, msg.options);
        break;
      case 'stop':
        stopFlags.set(msg.id, true);
        break;
    }
  } catch (err) {
    post({
      type: 'error',
      id: msg.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

function post(msg: WorkerMessage): void {
  ctx.postMessage(msg);
}

async function handleInit(id: number): Promise<void> {
  if (pyodide !== null) {
    post({ type: 'ready', id });
    return;
  }
  post({ type: 'progress', id, message: 'Pyodide WASM 다운로드 중… (최초 1회, ~10MB)' });
  const { loadPyodide } = await import('pyodide');
  pyodide = await loadPyodide({ indexURL: PYODIDE_CDN });

  post({ type: 'progress', id, message: '엔진·에이전트 파일 적재 중…' });
  writeEngineToPyodide(pyodide);

  post({ type: 'progress', id, message: '엔진 초기화 중…' });
  await pyodide.runPythonAsync(`
import sys
if '/' not in sys.path:
    sys.path.insert(0, '/')
from engine.agent_loader import load_agent_class
from engine.game_engine import GameEngine
import json as _json
`);

  post({ type: 'progress', id, message: '준비 완료' });
  post({ type: 'ready', id });
}

function writeEngineToPyodide(py: PyodideInterface): void {
  const allFiles = [...collectEngineFiles(), ...collectAgentFiles()];
  for (const { path, content } of allFiles) {
    ensureDirFor(py, path);
    py.FS.writeFile(`/${path}`, content);
  }
  for (const pkg of ['engine', 'agents']) {
    const initPath = `/${pkg}/__init__.py`;
    try {
      py.FS.stat(initPath);
    } catch {
      py.FS.writeFile(initPath, '');
    }
  }
}

function ensureDirFor(py: PyodideInterface, path: string): void {
  const segments = path.split('/');
  let cur = '';
  for (let i = 0; i < segments.length - 1; i += 1) {
    cur += `/${segments[i]}`;
    try {
      py.FS.stat(cur);
    } catch {
      py.FS.mkdir(cur);
    }
  }
}

function ensurePyodide(): PyodideInterface {
  if (pyodide === null) {
    throw new Error('worker not initialized — send init first');
  }
  return pyodide;
}

/**
 * 튜토리얼 시나리오 override 가 있으면 patched map 파일과 patched balance 파일을
 * Pyodide MEMFS 에 쓰고 그 경로를 리턴. 없으면 디폴트 경로 (engine/maps/default.txt
 * + engine/balance.json) 를 그대로 리턴.
 *
 * 엔진은 항상 5명/팀을 스폰하므로 startPositions 가 모든 슬롯을 채워야 한다.
 * patched balance 는 디폴트의 deep copy 에서 start_positions 만 갈아끼운 형태.
 *
 * 부수효과로 meta['tutorial_map'] 에 mapText 를 박는다 — 결정론 hash 는 events
 * 에만 의존하므로 (replay.py 의 _NON_HASHED_KEYS 와 별개로 meta 자체가 hash 외)
 * 메타 변경은 안전하다. viewer 가 이 키를 보고 맵 렌더러를 swap 한다.
 */
function applyTutorialOverride(
  py: PyodideInterface,
  override: SerializedTutorialOverride | undefined,
): { mapPath: string; balancePath: string; metaPatch: Record<string, unknown> } {
  if (override === undefined) {
    return {
      mapPath: '/engine/maps/default.txt',
      balancePath: '/engine/balance.json',
      metaPatch: {},
    };
  }
  const mapPath = '/engine/maps/_tutorial.txt';
  const balancePath = '/engine/_balance_tutorial.json';
  py.FS.writeFile(mapPath, override.mapText);
  // 디폴트 balance 를 읽어와 start_positions 만 교체. 다른 필드 (units 스탯,
  // victory 조건, 룰) 는 본 게임과 동일해야 학생이 배우는 수치가 일관된다.
  const baseBalanceRaw = py.FS.readFile('/engine/balance.json', { encoding: 'utf8' }) as string;
  const balance = JSON.parse(baseBalanceRaw) as Record<string, unknown>;
  balance['start_positions'] = override.startPositions;
  if (override.maxRounds !== undefined) {
    // victory.max_rounds 만 갈아끼움 — gauge_win_threshold / per_turn 등 다른
    // 승리 조건 수치는 본 게임과 동일하게 둬야 학생이 배우는 게 일관된다.
    const victory = { ...(balance['victory'] as Record<string, unknown>) };
    victory['max_rounds'] = override.maxRounds;
    balance['victory'] = victory;
  }
  py.FS.writeFile(balancePath, JSON.stringify(balance));
  return {
    mapPath,
    balancePath,
    metaPatch: { tutorial_map: override.mapText },
  };
}

function setupMatchGlobals(py: PyodideInterface, options: SerializedRunOptions): void {
  py.FS.writeFile('/my_agent.py', options.studentSource);
  py.globals.set('_student_team', options.studentTeam);
  py.globals.set('_first_team', options.firstTeam ?? 'A');
  py.globals.set('_opponent_path', options.opponent.path);
  const tut = applyTutorialOverride(py, options.tutorialOverride);
  py.globals.set('_map_path', tut.mapPath);
  py.globals.set('_balance_path', tut.balancePath);
  py.globals.set('_meta_patch_json', JSON.stringify(tut.metaPatch));
}

const MATCH_SETUP_PY = `
student_cls = load_agent_class('/my_agent.py')
opponent_cls = load_agent_class('/' + _opponent_path)
_meta_patch = _json.loads(_meta_patch_json)
if _student_team == 'A':
    agent_a, agent_b = student_cls, opponent_cls
    meta = {'agent_a_path': 'my_agent.py', 'agent_b_path': _opponent_path}
else:
    agent_a, agent_b = opponent_cls, student_cls
    meta = {'agent_a_path': _opponent_path, 'agent_b_path': 'my_agent.py'}
meta.update(_meta_patch)
`;

async function handleRunMatch(id: number, options: SerializedRunOptions): Promise<void> {
  const py = ensurePyodide();
  setupMatchGlobals(py, options);
  const replayJson = await py.runPythonAsync(`
${MATCH_SETUP_PY}
engine = GameEngine(
    agent_a, agent_b,
    balance_path=_balance_path,
    map_path=_map_path,
    first_team=_first_team,
    enforce_timeout=False,
    replay_meta=meta,
)
result = engine.run()
_json.dumps(result.replay.to_dict(), ensure_ascii=False)
`);
  post({ type: 'match-replay', id, replayJson: replayJson as string });
}

async function handleRunMatchStreaming(id: number, options: SerializedRunOptions): Promise<void> {
  const py = ensurePyodide();
  stopFlags.set(id, false);
  setupMatchGlobals(py, options);
  await py.runPythonAsync(`
${MATCH_SETUP_PY}
_stream_engine = GameEngine(
    agent_a, agent_b,
    balance_path=_balance_path,
    map_path=_map_path,
    first_team=_first_team,
    enforce_timeout=False,
    replay_meta=meta,
)
_stream_gen = _stream_engine.run_iter()
`);

  while (!stopFlags.get(id)) {
    // Bind the result to a name and end with an expression so runPythonAsync
    // returns the JSON string (or None on StopIteration). A bare try/except
    // is a statement, not an expression, so its value would always be None
    // and the pump would exit after the very first next() call without ever
    // forwarding a single event.
    const eventJson = await py.runPythonAsync(`
_stream_out = None
try:
    _ev = next(_stream_gen)
    _stream_out = _json.dumps({
        'kind': _ev.kind,
        'round': _ev.round,
        'phase_team': _ev.phase_team,
        'data': _ev.data,
    }, ensure_ascii=False, default=str)
except StopIteration:
    pass
_stream_out
`);
    if (eventJson === null || eventJson === undefined) break;
    post({ type: 'stream-event', id, eventJson: eventJson as string });
    // Yield to the worker event loop so a `stop` message can be received.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  if (stopFlags.get(id)) {
    stopFlags.delete(id);
    return;
  }

  const replayJson = await py.runPythonAsync(`
_json.dumps(_stream_engine.replay.to_dict(), ensure_ascii=False)
`);
  post({ type: 'stream-complete', id, replayJson: replayJson as string });
  stopFlags.delete(id);
}

// ─── Tournament: both sides supply uploaded sources ───────────────────────────

function setupTournamentGlobals(py: PyodideInterface, options: SerializedTournamentOptions): void {
  py.FS.writeFile('/agent_a.py', options.aSource);
  py.FS.writeFile('/agent_b.py', options.bSource);
  py.globals.set('_first_team', options.firstTeam);
  py.globals.set('_a_label', options.aLabel);
  py.globals.set('_b_label', options.bLabel);
}

const TOURNEY_SETUP_PY = `
agent_a_cls = load_agent_class('/agent_a.py')
agent_b_cls = load_agent_class('/agent_b.py')
meta = {
    'agent_a_path': 'agent_a.py',
    'agent_b_path': 'agent_b.py',
    'agents': {'A': _a_label, 'B': _b_label},
}
`;

async function handleRunTournamentLive(id: number, options: SerializedTournamentOptions): Promise<void> {
  const py = ensurePyodide();
  stopFlags.set(id, false);
  setupTournamentGlobals(py, options);
  await py.runPythonAsync(`
${TOURNEY_SETUP_PY}
_stream_engine = GameEngine(
    agent_a_cls, agent_b_cls,
    balance_path='/engine/balance.json',
    map_path='/engine/maps/default.txt',
    first_team=_first_team,
    enforce_timeout=False,
    replay_meta=meta,
)
# meta.agents gets overwritten by GameEngine.__init__; restore the labels.
_stream_engine.replay.meta['agents'] = {'A': _a_label, 'B': _b_label}
_stream_gen = _stream_engine.run_iter()
`);

  while (!stopFlags.get(id)) {
    const eventJson = await py.runPythonAsync(`
_stream_out = None
try:
    _ev = next(_stream_gen)
    _stream_out = _json.dumps({
        'kind': _ev.kind,
        'round': _ev.round,
        'phase_team': _ev.phase_team,
        'data': _ev.data,
    }, ensure_ascii=False, default=str)
except StopIteration:
    pass
_stream_out
`);
    if (eventJson === null || eventJson === undefined) break;
    post({ type: 'stream-event', id, eventJson: eventJson as string });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  if (stopFlags.get(id)) {
    stopFlags.delete(id);
    return;
  }

  const replayJson = await py.runPythonAsync(`
_json.dumps(_stream_engine.replay.to_dict(), ensure_ascii=False)
`);
  post({ type: 'stream-complete', id, replayJson: replayJson as string });
  stopFlags.delete(id);
}

async function handleRunTournamentBatch(id: number, options: SerializedTournamentOptions): Promise<void> {
  const py = ensurePyodide();
  setupTournamentGlobals(py, options);
  const replayJson = await py.runPythonAsync(`
${TOURNEY_SETUP_PY}
_engine = GameEngine(
    agent_a_cls, agent_b_cls,
    balance_path='/engine/balance.json',
    map_path='/engine/maps/default.txt',
    first_team=_first_team,
    enforce_timeout=False,
    replay_meta=meta,
)
_engine.replay.meta['agents'] = {'A': _a_label, 'B': _b_label}
_result = _engine.run()
_json.dumps(_result.replay.to_dict(), ensure_ascii=False)
`);
  post({ type: 'match-replay', id, replayJson: replayJson as string });
}
