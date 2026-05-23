/**
 * Atmospheric lighting + post-FX pipeline (Magic-Hour palette).
 *
 * Strategy:
 *   - Atmosphere tint via ColorMatrixFilter on the world container itself
 *     (filter is deterministic; not dependent on overlay blend modes).
 *   - Capture point halos as ADD-blend radial gradients inside world,
 *     alpha-pulsing, optionally post-processed with AdvancedBloomFilter.
 *   - Vignette as a full-viewport sprite with MULTIPLY blend on top of app.stage.
 *   - Godray / dust are **opt-in** (disabled by default) because they are easy
 *     to mis-configure into a full-screen wash.
 */

import { AdvancedBloomFilter, GodrayFilter } from 'pixi-filters';
import {
  ColorMatrixFilter,
  Container,
  Sprite,
  Texture,
  type Application,
} from 'pixi.js';
import { offsetToPixel, type HexLayout } from '../hex/layout';
import type { GameMap } from '../map/gameMap';

export interface LightingConfig {
  readonly atmosphereColor?: number;
  readonly atmosphereStrength?: number; // 0..1 — how much of the tint is applied
  readonly vignetteEdgeColor?: number;
  readonly vignetteEdgeStrength?: number; // 0..1
  readonly capturePointColor?: number;
  readonly enableBloom?: boolean;
  readonly enableGodray?: boolean;
  readonly enableDust?: boolean;
}

const DEFAULT_CONFIG: Required<LightingConfig> = {
  atmosphereColor: 0xffe0bc,       // warm amber — ColorMatrix tint target
  atmosphereStrength: 0.22,         // lowered so bright tile colors read through
  vignetteEdgeColor: 0x0b1430,
  vignetteEdgeStrength: 0.5,
  capturePointColor: 0xffcd6a,
  enableBloom: true,
  enableGodray: false,              // opt-in: easy to over-expose
  enableDust: false,                // opt-in: clarity-first default
};

export interface LightingHandle {
  resize(width: number, height: number): void;
  dispose(): void;
}

interface DustParticle {
  readonly sprite: Sprite;
  vx: number;
  vy: number;
}

export function mountLighting(
  app: Application,
  world: Container,
  map: GameMap,
  layout: HexLayout,
  userConfig: LightingConfig = {},
): LightingHandle {
  const cfg = { ...DEFAULT_CONFIG, ...userConfig };

  // --- Atmosphere tint on the world itself (ColorMatrixFilter) ------------
  const tint = new ColorMatrixFilter();
  applyWarmTint(tint, cfg.atmosphereColor, cfg.atmosphereStrength);

  // --- Capture-point halos (inside world, ADD blend) ----------------------
  const captureLights = new Container();
  captureLights.zIndex = 1_000_000;
  world.addChild(captureLights);

  const haloSprites: Sprite[] = [];
  for (const pt of map.capturePoints) {
    // Radius ~= hex radius so halos stay inside their own tile instead of
    // merging into one blob at the cluster of 5 central capture points.
    const halo = makePointLight(cfg.capturePointColor, 48);
    const px = offsetToPixel(pt, layout);
    halo.position.set(px.x, px.y + 2);
    captureLights.addChild(halo);
    haloSprites.push(halo);
  }

  const worldFilters: ColorMatrixFilter[] = [tint];
  world.filters = worldFilters;

  if (cfg.enableBloom) {
    captureLights.filters = [
      new AdvancedBloomFilter({
        threshold: 0.6,
        bloomScale: 0.8,
        brightness: 0.9,
        blur: 3,
        quality: 4,
      }),
    ];
  }

  // --- Godray (opt-in, applied to WORLD so rays ride existing content) -----
  let godray: GodrayFilter | null = null;
  if (cfg.enableGodray) {
    godray = new GodrayFilter({
      angle: 32,
      gain: 0.28,
      lacunarity: 2.4,
      parallel: true,
      time: 0,
    });
    world.filters = [tint, godray];
  }

  // --- Dust (opt-in, viewport coords) -------------------------------------
  const dustContainer = new Container();
  const dustParticles: DustParticle[] = [];
  if (cfg.enableDust) {
    app.stage.addChild(dustContainer);
    seedDust(dustContainer, dustParticles, app.screen.width, app.screen.height);
  }

  // --- Vignette (always on, top of app.stage) ------------------------------
  const vignette = new Sprite(Texture.EMPTY);
  vignette.blendMode = 'multiply';
  app.stage.addChild(vignette);

  function resize(width: number, height: number): void {
    regenerateVignette(vignette, width, height, cfg.vignetteEdgeColor, cfg.vignetteEdgeStrength);
  }
  resize(app.screen.width, app.screen.height);

  const tickerHandler = (ticker: { deltaMS: number; lastTime: number }): void => {
    // Gentler range so the cluster at the center stays readable.
    const pulse = 0.35 + 0.2 * Math.sin(ticker.lastTime / 600);
    for (const s of haloSprites) s.alpha = pulse;
    if (godray) godray.time += ticker.deltaMS / 1000;
    if (cfg.enableDust) {
      updateDust(dustParticles, app.screen.width, app.screen.height, ticker.deltaMS);
    }
  };
  app.ticker.add(tickerHandler);

  return {
    resize,
    dispose(): void {
      app.ticker.remove(tickerHandler);
      world.filters = [];
      captureLights.destroy({ children: true });
      dustContainer.destroy({ children: true });
      vignette.destroy();
    },
  };
}

// ---------- helpers ---------------------------------------------------------

function applyWarmTint(filter: ColorMatrixFilter, color: number, strength: number): void {
  const r = ((color >> 16) & 0xff) / 255;
  const g = ((color >> 8) & 0xff) / 255;
  const b = (color & 0xff) / 255;
  // Mix identity matrix with a multiplicative tint: per-channel multiplier,
  // lerped from 1.0 (identity) toward the target RGB by `strength`.
  const mr = 1 + (r - 1) * strength;
  const mg = 1 + (g - 1) * strength;
  const mb = 1 + (b - 1) * strength;
  filter.matrix = [
    mr, 0, 0, 0, 0,
    0, mg, 0, 0, 0,
    0, 0, mb, 0, 0,
    0, 0, 0, 1, 0,
  ];
}

function makePointLight(color: number, radius: number): Sprite {
  const size = radius * 2;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('2d context unavailable');
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const grad = ctx.createRadialGradient(radius, radius, 0, radius, radius, radius);
  grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 1)`);
  grad.addColorStop(0.25, `rgba(${r}, ${g}, ${b}, 0.55)`);
  grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const sprite = new Sprite(Texture.from(canvas));
  sprite.anchor.set(0.5);
  sprite.blendMode = 'add';
  return sprite;
}

function regenerateVignette(
  sprite: Sprite,
  width: number,
  height: number,
  edgeColor: number,
  strength: number,
): void {
  if (width <= 0 || height <= 0) return;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(64, Math.round(width));
  canvas.height = Math.max(64, Math.round(height));
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('2d context unavailable');
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const maxR = Math.sqrt(cx * cx + cy * cy);
  const er = (edgeColor >> 16) & 0xff;
  const eg = (edgeColor >> 8) & 0xff;
  const eb = edgeColor & 0xff;
  const grad = ctx.createRadialGradient(cx, cy, maxR * 0.45, cx, cy, maxR);
  // Center: pure white → multiply by 1 = no change.
  grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
  // Edge: dark navy at `strength` opacity → multiply darkens corners.
  grad.addColorStop(1, `rgba(${er}, ${eg}, ${eb}, ${strength})`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const oldTex = sprite.texture;
  sprite.texture = Texture.from(canvas);
  if (oldTex !== Texture.EMPTY && oldTex !== sprite.texture) {
    oldTex.destroy(true);
  }
  sprite.width = width;
  sprite.height = height;
}

function seedDust(
  container: Container,
  out: DustParticle[],
  width: number,
  height: number,
): void {
  const count = 40;
  for (let i = 0; i < count; i += 1) {
    const s = new Sprite(Texture.WHITE);
    s.tint = 0xffe6b8;
    const size = 2 + Math.random() * 2.2;
    s.width = size;
    s.height = size;
    s.alpha = 0.12 + Math.random() * 0.25;
    s.blendMode = 'add';
    s.position.set(Math.random() * width, Math.random() * height);
    container.addChild(s);
    out.push({
      sprite: s,
      vx: -0.15 + Math.random() * 0.35,
      vy: 0.12 + Math.random() * 0.4,
    });
  }
}

function updateDust(
  particles: DustParticle[],
  width: number,
  height: number,
  dtMs: number,
): void {
  const dt = dtMs / 16.67;
  for (const p of particles) {
    p.sprite.x += p.vx * dt;
    p.sprite.y += p.vy * dt;
    if (p.sprite.y > height + 4) {
      p.sprite.y = -4;
      p.sprite.x = Math.random() * width;
    }
    if (p.sprite.x < -6) p.sprite.x = width + 6;
    else if (p.sprite.x > width + 6) p.sprite.x = -6;
  }
}
