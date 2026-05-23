/**
 * Collects the Python engine + agents source files at build time so they can
 * be materialized into Pyodide's MEMFS. Vite's import.meta.glob + ?raw query
 * inlines the file contents as static strings.
 */

const engineRaw = import.meta.glob('../../../engine/**/*.py', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const engineJson = import.meta.glob('../../../engine/**/*.json', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const engineMaps = import.meta.glob('../../../engine/maps/*.txt', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const agentRaw = import.meta.glob('../../../agents/*.py', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export interface SourceFile {
  readonly path: string;
  readonly content: string;
}

function relFrom(prefix: string, fullPath: string): string {
  const idx = fullPath.indexOf(prefix);
  if (idx === -1) throw new Error(`path does not contain ${prefix}: ${fullPath}`);
  return fullPath.slice(idx);
}

export function collectEngineFiles(): SourceFile[] {
  const files: SourceFile[] = [];
  for (const [p, content] of Object.entries(engineRaw)) {
    files.push({ path: relFrom('engine/', p), content });
  }
  for (const [p, content] of Object.entries(engineJson)) {
    files.push({ path: relFrom('engine/', p), content });
  }
  for (const [p, content] of Object.entries(engineMaps)) {
    files.push({ path: relFrom('engine/', p), content });
  }
  return files;
}

export function collectAgentFiles(): SourceFile[] {
  const files: SourceFile[] = [];
  for (const [p, content] of Object.entries(agentRaw)) {
    files.push({ path: relFrom('agents/', p), content });
  }
  return files;
}

export interface OpponentOption {
  readonly id: string;
  readonly path: string;
  readonly label: string;
}

export const OPPONENT_OPTIONS: readonly OpponentOption[] = [
  { id: 'simple', path: 'agents/example_simple.py', label: 'SimpleAgent (기본 휴리스틱)' },
  { id: 'aggressive', path: 'agents/example_aggressive.py', label: 'AggressiveAgent (공격형)' },
  { id: 'defensive', path: 'agents/example_defensive.py', label: 'DefensiveAgent (수비형)' },
  { id: 'scorer', path: 'agents/example_scorer.py', label: 'ScorerAgent (점수 함수 입문 — Lv 3)' },
  // NOTE: DemoAgent / TitanAgent / AlphaBetaAgent 는 강사 전용 reference.
  // 학생 viewer 드롭다운에 노출 X — 토너먼트 매치를 통해 black box 도전.
];
