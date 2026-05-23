import { AnimatedSprite, BlurFilter, Container, Graphics } from 'pixi.js';
import type { Spritesheet, Ticker } from 'pixi.js';
import { DEFAULT_HEX_LAYOUT, offsetToPixel, rowZIndex, type HexLayout } from '../hex/layout';
import type { Frame, UnitState } from '../playback/timeline';
import type { PhaseAction, TeamId, UnitClass } from '../replay/types';
import { getLoadedAtlas } from './sprites/unitAtlas';

export interface ActionFireEvent {
  readonly kind: 'attack' | 'heal';
  readonly unitClass: UnitClass;
  readonly team: TeamId;
  readonly shooterPos: { readonly x: number; readonly y: number };
  readonly targetPos: { readonly x: number; readonly y: number };
}

export interface UnitStepEvent {
  readonly unitClass: UnitClass;
  readonly team: TeamId;
}

const SHADOW_WIDTH = 42;
const SHADOW_HEIGHT = 12;
const SHADOW_OFFSET_X = -8;
const SHADOW_OFFSET_Y = 6;
const SHADOW_STRETCH = 1.3;
const UNIT_SCALE = 2;
const ATTACK_ANIM_MS = 500;
const DEFAULT_MS_PER_TILE = 180;
/** Default gap between consecutive sequential actions (e.g. between two units). */
const ACTION_GAP_MS = 100;
/** Longer pause after a unit's move when its NEXT action is an attack/heal —
 *  reads as "settle, aim, fire" instead of "move + instant fire". */
const POST_MOVE_AIM_MS = 280;
/** Extra buffer appended after the last scheduled action (breathing room before next frame). */
const PHASE_TAIL_MS = 120;

/**
 * Compute how long the sequential per-unit animation for a phase takes.
 * Callers (player/broadcaster) use this to pace the next frame transition
 * so the animation isn't cut off mid-move.
 */
export function computePhaseAnimationDurationMs(
  actions: readonly PhaseAction[],
  msPerTile: number = DEFAULT_MS_PER_TILE,
): number {
  if (actions.length === 0) return 0;
  let cursor = 0;
  let prevKind: 'move' | 'attack' | 'heal' | null = null;
  for (const a of actions) {
    if (prevKind !== null) {
      const isAimAfterMove =
        prevKind === 'move' && (a.kind === 'attack' || a.kind === 'heal');
      cursor += isAimAfterMove ? POST_MOVE_AIM_MS : ACTION_GAP_MS;
    }
    if (a.kind === 'move') {
      cursor += a.path.length * msPerTile;
    } else {
      cursor += ATTACK_ANIM_MS;
    }
    prevKind = a.kind;
  }
  return cursor + PHASE_TAIL_MS;
}

/** Which clip plays when the unit performs its class action. */
const ATTACK_ANIM_NAME: Record<UnitClass, string> = {
  shield: 'fire',
  rifle:  'fire',
  dmr:    'fire',
  medic:  'push',
};

interface MoveTween {
  /** Pixel positions for each waypoint; index 0 is origin, last is target. */
  readonly waypoints: readonly { x: number; y: number; col: number; row: number }[];
  readonly startedAtMs: number;
  readonly msPerTile: number;
}

interface ScheduledAnim {
  readonly kind: 'attack' | 'heal';
  readonly fireAtMs: number;
  readonly targetId: number;
  triggered: boolean;
}

interface PendingHpChange {
  readonly atMs: number;
  readonly hp: number;
  readonly alive: boolean;
}

interface UnitNode {
  container: Container;
  shadow: Graphics;
  sprite: AnimatedSprite;
  atlas: Spritesheet;
  hpBack: Graphics;
  hpFill: Graphics;
  /** Last fully-resolved logical tile (target of any in-flight tween). */
  logicalCol: number;
  logicalRow: number;
  facing: 1 | -1;
  tween: MoveTween | null;
  /** Highest segment index for which we've fired a footstep event in the current tween. -1 = none yet. */
  lastStepSegIdx: number;
  scheduled: ScheduledAnim[];
  attackUntilMs: number;
  currentAnim: string;
  unitClass: UnitClass;
  team: TeamId;
  /** DISPLAYED hp/alive — lags `frame.units` by the action schedule so the bar
   *  doesn't drop before the hit FX lands. Drained from `pendingHpChanges`. */
  alive: boolean;
  hp: number;
  maxHp: number;
  pendingHpChanges: PendingHpChange[];
}

interface UnitPlan {
  move: { action: Extract<PhaseAction, { kind: 'move' }>; startAtMs: number } | null;
  anim: { kind: 'attack' | 'heal'; fireAtMs: number; targetId: number } | null;
}

export interface DisplayedHp {
  readonly hp: number;
  readonly alive: boolean;
  readonly maxHp: number;
}

export interface UnitLayerHandle {
  readonly root: Container;
  update(frame: Frame): void;
  /** Read the unit's currently DISPLAYED hp/alive — lags frame.units while
   *  pending hit FX hasn't fired yet. Returns null if the unit hasn't been
   *  registered (e.g., atlas not loaded). */
  getDisplayedHp(unitId: number): DisplayedHp | null;
  dispose(): void;
}

export interface UnitRenderOptions {
  readonly layout?: HexLayout;
  /** Pixi ticker driving tween/animation advancement. If omitted, per-tile animation is disabled (positions snap). */
  readonly ticker?: Ticker;
  /** Milliseconds per tile during move tween. Defaults to 180ms. */
  readonly msPerTile?: number;
  /** Fires at the exact instant an attack/heal animation is triggered. Use for VFX/SFX. */
  readonly onActionFire?: (ev: ActionFireEvent) => void;
  /** Fires at the start of each tile segment during a move tween — one per tile stepped onto. */
  readonly onUnitStep?: (ev: UnitStepEvent) => void;
}

export function createUnitLayer(options: UnitRenderOptions = {}): UnitLayerHandle {
  const layout = options.layout ?? DEFAULT_HEX_LAYOUT;
  const ticker = options.ticker ?? null;
  const msPerTile = options.msPerTile ?? DEFAULT_MS_PER_TILE;
  const onActionFire = options.onActionFire ?? null;
  const onUnitStep = options.onUnitStep ?? null;
  const root = new Container();
  root.sortableChildren = true;
  const unitNodes = new Map<number, UnitNode>();

  const tickHandler = (_t: Ticker): void => {
    // Use performance.now() here to match the clock used in applyFrame() for
    // tween startedAtMs. Ticker.lastTime is relative to ticker start and would
    // desync, producing negative elapsed → segIdx=-1 → undefined waypoint.
    const now = performance.now();
    for (const node of unitNodes.values()) {
      advanceNode(node, now, layout, unitNodes, onActionFire, onUnitStep);
    }
  };
  if (ticker) ticker.add(tickHandler);

  return {
    root,
    update(frame) {
      const now = performance.now();
      // Walk actions in order and accumulate a cursor, so unit N starts only
      // after unit N-1 finishes its move+attack sequence. Each unit's plan
      // carries absolute start times (performance.now basis).
      const plans = new Map<number, UnitPlan>();
      const hpPendingByUnit = new Map<number, PendingHpChange[]>();
      let cursor = now;
      let prevKind: 'move' | 'attack' | 'heal' | null = null;
      for (const a of frame.actions) {
        if (prevKind !== null) {
          const isAimAfterMove =
            prevKind === 'move' && (a.kind === 'attack' || a.kind === 'heal');
          cursor += isAimAfterMove ? POST_MOVE_AIM_MS : ACTION_GAP_MS;
        }
        let plan = plans.get(a.unit_id);
        if (plan === undefined) {
          plan = { move: null, anim: null };
          plans.set(a.unit_id, plan);
        }
        if (a.kind === 'move') {
          plan.move = { action: a, startAtMs: cursor };
          cursor += a.path.length * msPerTile;
        } else {
          const fireAtMs = cursor;
          plan.anim = { kind: a.kind, fireAtMs, targetId: a.target_id };
          // Queue the target's HP transition to land exactly when the hit FX
          // fires — avoids the bar dropping before the visual impact.
          let arr = hpPendingByUnit.get(a.target_id);
          if (arr === undefined) {
            arr = [];
            hpPendingByUnit.set(a.target_id, arr);
          }
          arr.push({
            atMs: fireAtMs,
            hp: a.target_hp_after,
            alive: a.target_hp_after > 0,
          });
          cursor += ATTACK_ANIM_MS;
        }
        prevKind = a.kind;
      }

      for (const [id, unit] of frame.units) {
        let node = unitNodes.get(id);
        if (node === undefined) {
          const atlas = getLoadedAtlas(unit.unitClass, unit.team);
          if (atlas === null) continue;
          node = createUnitNode(unit, atlas, layout);
          unitNodes.set(id, node);
          root.addChild(node.container);
        }
        applyFrame(
          node,
          unit,
          plans.get(id),
          hpPendingByUnit.get(id) ?? [],
          layout,
          ticker !== null,
          msPerTile,
        );
      }
      // If ticker is disabled (tests), still need to paint at least once.
      if (ticker === null) {
        for (const node of unitNodes.values()) {
          advanceNode(node, now, layout, unitNodes, onActionFire, onUnitStep);
        }
      }
    },
    getDisplayedHp(unitId) {
      const node = unitNodes.get(unitId);
      if (node === undefined) return null;
      return { hp: node.hp, alive: node.alive, maxHp: node.maxHp };
    },
    dispose() {
      if (ticker) ticker.remove(tickHandler);
      for (const n of unitNodes.values()) {
        n.container.destroy({ children: true });
      }
      unitNodes.clear();
      root.destroy({ children: true });
    },
  };
}

function createUnitNode(unit: UnitState, atlas: Spritesheet, layout: HexLayout): UnitNode {
  const container = new Container();

  const shadow = new Graphics();
  shadow.ellipse(
    SHADOW_OFFSET_X,
    SHADOW_OFFSET_Y,
    (SHADOW_WIDTH * SHADOW_STRETCH) / 2,
    SHADOW_HEIGHT / 2,
  );
  shadow.fill({ color: 0x000000, alpha: 0.45 });
  shadow.filters = [new BlurFilter({ strength: 4 })];

  const idleFrames = atlas.animations['idle']!;
  const sprite = new AnimatedSprite(idleFrames);
  sprite.anchor.set(0.5, 0.875);
  sprite.scale.set(UNIT_SCALE);
  sprite.animationSpeed = 0.05;
  sprite.play();

  const hpBack = new Graphics();
  const hpFill = new Graphics();

  container.addChild(shadow, sprite, hpBack, hpFill);

  const pixel = offsetToPixel({ col: unit.col, row: unit.row }, layout);
  container.position.set(pixel.x, pixel.y);
  container.zIndex = rowZIndex(unit.row, 10);

  return {
    container,
    shadow,
    sprite,
    atlas,
    hpBack,
    hpFill,
    logicalCol: unit.col,
    logicalRow: unit.row,
    facing: unit.team === 'A' ? 1 : -1,
    tween: null,
    lastStepSegIdx: -1,
    scheduled: [],
    attackUntilMs: 0,
    currentAnim: 'idle',
    unitClass: unit.unitClass,
    team: unit.team,
    alive: unit.alive,
    hp: unit.hp,
    maxHp: unit.maxHp,
    pendingHpChanges: [],
  };
}

function applyFrame(
  node: UnitNode,
  unit: UnitState,
  plan: UnitPlan | undefined,
  pendingHp: readonly PendingHpChange[],
  layout: HexLayout,
  hasTicker: boolean,
  msPerTile: number,
): void {
  node.maxHp = unit.maxHp;

  // HP/alive: if this unit takes hits in this phase, defer the bar update to
  // the action schedule. Otherwise snap to the frame's value.
  if (pendingHp.length > 0 && hasTicker) {
    node.pendingHpChanges = [...pendingHp];
  } else {
    node.pendingHpChanges = [];
    node.hp = unit.hp;
    node.alive = unit.alive;
  }

  // Any previous transition is superseded — clear in-flight.
  node.tween = null;
  node.scheduled = [];

  const movedLogically = unit.col !== node.logicalCol || unit.row !== node.logicalRow;
  const moveAction = plan?.move?.action;

  if (plan?.move && hasTicker && unit.alive && moveAction && moveAction.path.length > 0) {
    // Build waypoint list including origin. Tween startedAtMs may be in the
    // future — advanceNode clamps elapsed<0 to keep the unit at waypoints[0]
    // until its turn comes up.
    const origin = { col: node.logicalCol, row: node.logicalRow };
    const originPixel = offsetToPixel(origin, layout);
    const waypoints = [
      { ...originPixel, col: origin.col, row: origin.row },
      ...moveAction.path.map(([col, row]) => {
        const p = offsetToPixel({ col, row }, layout);
        return { x: p.x, y: p.y, col, row };
      }),
    ];
    node.tween = {
      waypoints,
      startedAtMs: plan.move.startAtMs,
      msPerTile,
    };
    node.lastStepSegIdx = -1;
    // Snap visual to origin now so future-scheduled tween doesn't flash.
    node.container.position.set(originPixel.x, originPixel.y);
    node.container.zIndex = rowZIndex(origin.row, 10);
  } else if (movedLogically) {
    // No tween (either no actions, no ticker, or dead) — snap to target.
    const pixel = offsetToPixel({ col: unit.col, row: unit.row }, layout);
    node.container.position.set(pixel.x, pixel.y);
    node.container.zIndex = rowZIndex(unit.row, 10);
  }

  // Update logical target now so subsequent frames diff correctly.
  node.logicalCol = unit.col;
  node.logicalRow = unit.row;

  if (plan?.anim && unit.alive) {
    node.scheduled.push({
      kind: plan.anim.kind,
      fireAtMs: plan.anim.fireAtMs,
      targetId: plan.anim.targetId,
      triggered: false,
    });
  }

  // Use DISPLAYED alive (lagged) so dying alpha doesn't jump in early.
  node.container.alpha = node.alive ? 1 : 0.35;

  drawHpBar(node);
}

function advanceNode(
  node: UnitNode,
  now: number,
  layout: HexLayout,
  unitNodes: Map<number, UnitNode>,
  onActionFire: ((ev: ActionFireEvent) => void) | null,
  onUnitStep: ((ev: UnitStepEvent) => void) | null,
): void {
  // --- Movement tween ---
  // tweenActive is true only while the tween's start time has passed and it
  // isn't finished. Future-scheduled tweens (elapsed < 0) keep the unit parked
  // at waypoints[0] in idle state until their turn comes.
  let tweenActive = false;
  if (node.tween) {
    const { waypoints, startedAtMs, msPerTile } = node.tween;
    const elapsed = now - startedAtMs;
    const totalTiles = waypoints.length - 1;
    const totalMs = totalTiles * msPerTile;
    if (elapsed < 0) {
      const first = waypoints[0]!;
      node.container.position.set(first.x, first.y);
      node.container.zIndex = rowZIndex(first.row, 10);
    } else if (elapsed >= totalMs) {
      const last = waypoints[waypoints.length - 1]!;
      node.container.position.set(last.x, last.y);
      node.container.zIndex = rowZIndex(last.row, 10);
      node.tween = null;
    } else {
      tweenActive = true;
      const progress = elapsed / msPerTile;
      const segIdx = Math.max(0, Math.min(totalTiles - 1, Math.floor(progress)));
      const segT = easeInOutQuad(Math.max(0, Math.min(1, progress - segIdx)));
      const a = waypoints[segIdx]!;
      const b = waypoints[segIdx + 1]!;
      const x = a.x + (b.x - a.x) * segT;
      const y = a.y + (b.y - a.y) * segT;
      node.container.position.set(x, y);
      const activeRow = segT > 0.5 ? b.row : a.row;
      node.container.zIndex = rowZIndex(activeRow, 10);
      if (b.col !== a.col) {
        node.facing = b.col > a.col ? 1 : -1;
      }
      // Footstep: fire once when entering each new segment.
      if (segIdx > node.lastStepSegIdx) {
        node.lastStepSegIdx = segIdx;
        if (onUnitStep) {
          onUnitStep({ unitClass: node.unitClass, team: node.team });
        }
      }
    }
  }

  // --- Pending HP changes — drain those whose fire time has passed ---
  let hpChanged = false;
  while (node.pendingHpChanges.length > 0 && node.pendingHpChanges[0]!.atMs <= now) {
    const c = node.pendingHpChanges.shift()!;
    node.hp = c.hp;
    node.alive = c.alive;
    hpChanged = true;
  }
  if (hpChanged) {
    node.container.alpha = node.alive ? 1 : 0.35;
    drawHpBar(node);
  }

  // --- Scheduled attack/heal triggers ---
  for (const s of node.scheduled) {
    if (!s.triggered && now >= s.fireAtMs) {
      node.attackUntilMs = now + ATTACK_ANIM_MS;
      s.triggered = true;
      const target = unitNodes.get(s.targetId);
      if (target) {
        // Face the target before firing — fixes "shoots backwards at enemy
        // standing behind". Flip is instantaneous, but the POST_MOVE_AIM_MS
        // pause beforehand reads as "turn, settle, fire".
        const dx = target.container.position.x - node.container.position.x;
        if (dx !== 0) {
          node.facing = dx > 0 ? 1 : -1;
        }
        if (onActionFire) {
          onActionFire({
            kind: s.kind,
            unitClass: node.unitClass,
            team: node.team,
            shooterPos: { x: node.container.position.x, y: node.container.position.y },
            targetPos: { x: target.container.position.x, y: target.container.position.y },
          });
        }
      }
    }
  }
  if (node.scheduled.length > 0 && node.scheduled.every((s) => s.triggered)) {
    node.scheduled = [];
  }

  // --- Animation state selection ---
  let desired: string;
  if (!node.alive) {
    desired = 'death';
  } else if (now < node.attackUntilMs) {
    desired = ATTACK_ANIM_NAME[node.unitClass];
  } else if (tweenActive) {
    desired = 'run';
  } else {
    desired = 'idle';
  }
  setAnim(node, desired);

  node.sprite.scale.x = node.facing * UNIT_SCALE;

  void layout;
}

function setAnim(node: UnitNode, anim: string): void {
  if (node.currentAnim === anim) return;
  const frames = node.atlas.animations[anim];
  if (frames === undefined || frames.length === 0) return;
  node.sprite.textures = frames;
  node.sprite.loop = anim !== 'death';
  node.sprite.play();
  node.currentAnim = anim;
}

function drawHpBar(node: UnitNode): void {
  const width = 30;
  const height = 4;
  const yOff = -46; // just above the visible head silhouette (head top ≈ -36)
  const ratio = Math.max(0, Math.min(1, node.hp / node.maxHp));
  node.hpBack.clear();
  node.hpBack.rect(-width / 2, yOff, width, height);
  node.hpBack.fill({ color: 0x000000, alpha: 0.6 });
  node.hpBack.stroke({ width: 1, color: 0x000000, alpha: 0.85 });
  node.hpFill.clear();
  if (ratio > 0) {
    const color = ratio > 0.5 ? 0x7fdd63 : ratio > 0.2 ? 0xffce4d : 0xff5d4d;
    node.hpFill.rect(-width / 2, yOff, width * ratio, height);
    node.hpFill.fill({ color });
  }
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}
