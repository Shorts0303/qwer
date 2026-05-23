/**
 * Transient combat FX layer — muzzle flash, tracer line, hit ring, heal pulse.
 *
 * Entities are PIXI Graphics instances with lifetimes, advanced each tick and
 * removed when their timeline ends. Self-contained (no textures needed) so it
 * works everywhere without asset loading.
 */

import { Container, Graphics } from 'pixi.js';
import type { Ticker } from 'pixi.js';
import type { ActionFireEvent } from './unitRenderer';
import type { TeamId, UnitClass } from '../replay/types';

const TEAM_COLORS: Record<TeamId, number> = {
  A: 0xffa347,
  B: 0x5bbff0,
};

const MUZZLE_COLOR = 0xfff1a0;
const HIT_COLOR = 0xff6b4a;
const HEAL_COLOR = 0x78ee99;

const MUZZLE_LIFE_MS = 120;
const TRACER_LIFE_MS = 180;
const HIT_LIFE_MS = 260;
const HEAL_LIFE_MS = 360;

/** Container origin sits at the unit's pivot (sprite anchor 0.5, 0.875). The
 *  character silhouette within the 64px cell is short — head is roughly at
 *  y ≈ -32, so anything at that level reads as "head shot". Put gun around
 *  mid-chest and hit ring around belly, and keep the ring compact so it
 *  doesn't expand up past the collarbone. Tuned empirically. */
const SHOOTER_GUN_DY = -18;
const TARGET_BODY_DY = -10;

interface FxEntity {
  gfx: Graphics;
  startAtMs: number;
  lifeMs: number;
  kind: 'muzzle' | 'tracer' | 'hit' | 'heal';
  shooter: { x: number; y: number };
  target: { x: number; y: number };
  color: number;
  /** Multiplies render radius/width — used for DMR's heavier boom. */
  intensity: number;
}

export interface FxSpawnOptions {
  /** 1.0 = default; >1 makes muzzle/tracer/hit visually bigger (DMR). */
  readonly intensity?: number;
}

export interface FxLayerHandle {
  readonly root: Container;
  spawn(ev: ActionFireEvent, opts?: FxSpawnOptions): void;
  dispose(): void;
}

export function createFxLayer(ticker: Ticker): FxLayerHandle {
  const root = new Container();
  root.sortableChildren = false;
  const entities: FxEntity[] = [];

  const tickHandler = (): void => {
    const now = performance.now();
    for (let i = entities.length - 1; i >= 0; i -= 1) {
      const e = entities[i]!;
      const t = (now - e.startAtMs) / e.lifeMs;
      if (t >= 1) {
        e.gfx.destroy();
        entities.splice(i, 1);
        continue;
      }
      renderEntity(e, Math.max(0, t));
    }
  };
  ticker.add(tickHandler);

  return {
    root,
    spawn(ev, opts) {
      const now = performance.now();
      const intensity = opts?.intensity ?? 1.0;
      const shooter = { x: ev.shooterPos.x, y: ev.shooterPos.y + SHOOTER_GUN_DY };
      const target = { x: ev.targetPos.x, y: ev.targetPos.y + TARGET_BODY_DY };

      if (ev.kind === 'attack') {
        const teamColor = TEAM_COLORS[ev.team];
        entities.push(makeEntity('muzzle', shooter, target, MUZZLE_COLOR, MUZZLE_LIFE_MS, now, root, intensity));
        entities.push(makeEntity('tracer', shooter, target, teamColor, TRACER_LIFE_MS, now, root, intensity));
        entities.push(makeEntity('hit', shooter, target, HIT_COLOR, HIT_LIFE_MS, now + TRACER_LIFE_MS * 0.6, root, intensity));
      } else {
        entities.push(makeEntity('heal', shooter, target, HEAL_COLOR, HEAL_LIFE_MS, now, root, intensity));
      }
      void (ev.unitClass as UnitClass);
    },
    dispose() {
      ticker.remove(tickHandler);
      for (const e of entities) e.gfx.destroy();
      entities.length = 0;
      root.destroy({ children: true });
    },
  };
}

function makeEntity(
  kind: FxEntity['kind'],
  shooter: { x: number; y: number },
  target: { x: number; y: number },
  color: number,
  lifeMs: number,
  startAtMs: number,
  root: Container,
  intensity: number,
): FxEntity {
  const gfx = new Graphics();
  root.addChild(gfx);
  const e: FxEntity = { gfx, startAtMs, lifeMs, kind, shooter, target, color, intensity };
  renderEntity(e, 0);
  return e;
}

function renderEntity(e: FxEntity, t: number): void {
  e.gfx.clear();
  switch (e.kind) {
    case 'muzzle':
      renderMuzzle(e, t);
      break;
    case 'tracer':
      renderTracer(e, t);
      break;
    case 'hit':
      renderHit(e, t);
      break;
    case 'heal':
      renderHeal(e, t);
      break;
  }
}

function renderMuzzle(e: FxEntity, t: number): void {
  const alpha = 1 - t;
  const radius = (10 + 12 * t) * e.intensity;
  e.gfx.circle(e.shooter.x, e.shooter.y, radius);
  e.gfx.fill({ color: e.color, alpha: alpha * 0.9 });
  e.gfx.circle(e.shooter.x, e.shooter.y, radius * 0.45);
  e.gfx.fill({ color: 0xffffff, alpha: alpha * 0.95 });
}

function renderTracer(e: FxEntity, t: number): void {
  const head = Math.min(1, t * 2);
  const tail = Math.max(0, t * 2 - 0.6);
  const hx = e.shooter.x + (e.target.x - e.shooter.x) * head;
  const hy = e.shooter.y + (e.target.y - e.shooter.y) * head;
  const tx = e.shooter.x + (e.target.x - e.shooter.x) * tail;
  const ty = e.shooter.y + (e.target.y - e.shooter.y) * tail;
  const alpha = 1 - t;
  e.gfx.moveTo(tx, ty);
  e.gfx.lineTo(hx, hy);
  e.gfx.stroke({ width: 3 * e.intensity, color: e.color, alpha: alpha * 0.85, cap: 'round' });
  e.gfx.moveTo(tx, ty);
  e.gfx.lineTo(hx, hy);
  e.gfx.stroke({ width: 1.2 * e.intensity, color: 0xffffff, alpha: alpha * 0.75, cap: 'round' });
}

function renderHit(e: FxEntity, t: number): void {
  if (t <= 0) return;
  const radius = (3 + 8 * Math.sqrt(t)) * e.intensity;
  const alpha = 1 - t;
  e.gfx.circle(e.target.x, e.target.y, radius);
  e.gfx.stroke({ width: 2.5 * e.intensity, color: e.color, alpha: alpha * 0.95 });
  e.gfx.circle(e.target.x, e.target.y, Math.max(0, 2.5 * e.intensity - 4 * t));
  e.gfx.fill({ color: 0xffffff, alpha });
}

function renderHeal(e: FxEntity, t: number): void {
  // Compact ring that stays around the torso — no head-height overshoot.
  const radius = 8 + 14 * t;
  const alpha = 1 - t;
  e.gfx.circle(e.target.x, e.target.y, radius);
  e.gfx.stroke({ width: 3, color: e.color, alpha: alpha * 0.9 });
  const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 4);
  e.gfx.circle(e.target.x, e.target.y, 6);
  e.gfx.fill({ color: e.color, alpha: alpha * 0.5 * pulse });
}
