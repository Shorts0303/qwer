/**
 * Unit sprite sheet loader + cache.
 *
 * Sheet layout (Unity asset store character generator):
 *   - Cell size: 64×64
 *   - Top 32 px: decorative header band (ignored)
 *   - 14 rows, 1 animation per row, variable frames per row
 *   - Unity pivot (0.5, 0.125) → PixiJS anchor (0.5, 0.875)
 *
 * One sheet per (class × team) — 8 sheets total. Files live at
 * viewer/public/assets/sprites/units/{class}-{a|b}.png and are served at
 * /assets/sprites/units/... by Vite's default public dir behavior.
 */

import { Assets, Spritesheet, Texture } from 'pixi.js';
import type { UnitClass, TeamId } from '../../replay/types';

const CELL = 64;
const HEADER_OFFSET = 32;

interface AnimSpec {
  readonly name: string;
  readonly frames: number;
}

/**
 * Row order and frame counts per the asset spec.
 * `shot` is a bow animation and `block` is low-quality per user feedback —
 * included in the atlas but not used by the renderer.
 */
const ROWS: readonly AnimSpec[] = [
  { name: 'idle',  frames: 2 },
  { name: 'ready', frames: 2 },
  { name: 'run',   frames: 4 },
  { name: 'crawl', frames: 4 },
  { name: 'climb', frames: 2 },
  { name: 'jump',  frames: 3 },
  { name: 'push',  frames: 3 },
  { name: 'jab',   frames: 3 },
  { name: 'slash', frames: 4 },
  { name: 'shot',  frames: 4 },
  { name: 'fire',  frames: 2 },
  { name: 'block', frames: 2 },
  { name: 'death', frames: 3 },
  { name: 'roll',  frames: 9 },
];

const atlasCache = new Map<string, Spritesheet>();
const loadPromises = new Map<string, Promise<Spritesheet>>();

function keyOf(unitClass: UnitClass, team: TeamId): string {
  return `${unitClass}-${team.toLowerCase()}`;
}

function urlOf(unitClass: UnitClass, team: TeamId): string {
  // BASE_URL is '/' in dev/local build and '/<repo>/' on GitHub Pages.
  return `${import.meta.env.BASE_URL}assets/sprites/units/${keyOf(unitClass, team)}.png`;
}

export function getLoadedAtlas(unitClass: UnitClass, team: TeamId): Spritesheet | null {
  return atlasCache.get(keyOf(unitClass, team)) ?? null;
}

export function loadUnitAtlas(unitClass: UnitClass, team: TeamId): Promise<Spritesheet> {
  const key = keyOf(unitClass, team);
  const existing = loadPromises.get(key);
  if (existing !== undefined) return existing;
  const p = buildSheet(unitClass, team).then((sheet) => {
    atlasCache.set(key, sheet);
    return sheet;
  });
  loadPromises.set(key, p);
  return p;
}

export async function preloadAllUnitAtlases(): Promise<void> {
  const classes: UnitClass[] = ['shield', 'rifle', 'dmr', 'medic'];
  const teams: TeamId[] = ['A', 'B'];
  const results = await Promise.allSettled(
    classes.flatMap((c) => teams.map((t) => loadUnitAtlas(c, t))),
  );
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length > 0) {
    console.warn(
      `[unit-atlas] ${failed.length}/${results.length} sheet(s) failed to load — ` +
      `check that viewer/public/assets/sprites/units/*.png are present.`,
      failed.map((r) => (r as PromiseRejectedResult).reason),
    );
  }
}

async function buildSheet(unitClass: UnitClass, team: TeamId): Promise<Spritesheet> {
  const key = keyOf(unitClass, team);
  const url = urlOf(unitClass, team);
  const tex = await Assets.load<Texture>(url);
  tex.source.scaleMode = 'nearest';

  const frames: Record<string, { frame: { x: number; y: number; w: number; h: number } }> = {};
  const animations: Record<string, string[]> = {};

  ROWS.forEach((row, rowIdx) => {
    const names: string[] = [];
    for (let col = 0; col < row.frames; col += 1) {
      const name = `${key}-${row.name}-${col}`;
      frames[name] = {
        frame: {
          x: col * CELL,
          y: HEADER_OFFSET + rowIdx * CELL,
          w: CELL,
          h: CELL,
        },
      };
      names.push(name);
    }
    animations[row.name] = names;
  });

  const sheet = new Spritesheet(tex, {
    frames,
    animations,
    meta: { scale: '1' },
  });
  await sheet.parse();
  return sheet;
}
