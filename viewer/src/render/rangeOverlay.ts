import { Container, Graphics } from 'pixi.js';
import type { Offset } from '../hex/coord';
import { DEFAULT_HEX_LAYOUT, offsetToPixel, rowZIndex, type HexLayout } from '../hex/layout';

export interface RangeOverlayOptions {
  readonly color: number;
  readonly alpha?: number;
  readonly strokeWidth?: number;
  readonly layout?: HexLayout;
}

export function createRangeOverlay(
  tiles: readonly Offset[],
  options: RangeOverlayOptions,
): Container {
  const layout = options.layout ?? DEFAULT_HEX_LAYOUT;
  const alpha = options.alpha ?? 0.25;
  const strokeWidth = options.strokeWidth ?? 2;

  const root = new Container();
  root.sortableChildren = true;

  const verts = pointyHexVertices(layout);
  const flat: number[] = [];
  for (const v of verts) {
    flat.push(v.x, v.y);
  }

  for (const tile of tiles) {
    const g = new Graphics();
    g.poly(flat);
    g.fill({ color: options.color, alpha });
    g.stroke({ width: strokeWidth, color: options.color, alpha: 0.95 });
    const px = offsetToPixel(tile, layout);
    g.position.set(px.x, px.y);
    // Above the tile face (layer 2), below the units (layer 10).
    g.zIndex = rowZIndex(tile.row, 5);
    root.addChild(g);
  }

  return root;
}

function pointyHexVertices(layout: HexLayout): Array<{ x: number; y: number }> {
  const s = layout.size;
  const c = layout.isoCompress;
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < 6; i += 1) {
    const angle = ((30 + i * 60) * Math.PI) / 180;
    out.push({ x: s * Math.cos(angle), y: s * Math.sin(angle) * c });
  }
  return out;
}
