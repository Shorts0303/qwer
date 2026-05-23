/**
 * Pointy-top odd-r hex → screen pixel projection with iso compression.
 *
 * Odd rows shift RIGHT by 0.5 hex-width (matches engine/position.py odd-r).
 * An iso compression factor squashes the Y axis to simulate a tilted camera,
 * producing the Cult-of-the-Lamb "fake 2.5D" look when paired with upright
 * billboard sprites.
 */

import type { Offset } from './coord';

export interface HexLayout {
  /** Outer radius of a hex (center to vertex). */
  readonly size: number;
  /** Vertical squash ratio applied to the base Y pixel coordinate. 1.0 = true pointy-top, 0.5 = strongly iso. */
  readonly isoCompress: number;
  /** Pixel offset applied to every tile (origin of the map in screen space). */
  readonly origin: { readonly x: number; readonly y: number };
}

export interface PixelPoint {
  readonly x: number;
  readonly y: number;
}

export const DEFAULT_HEX_LAYOUT: HexLayout = {
  size: 48,
  isoCompress: 0.7,
  origin: { x: 0, y: 0 },
};

export function hexWidth(size: number): number {
  return Math.sqrt(3) * size;
}

/** Pre-compression height of a hex (before iso squash). */
export function hexHeight(size: number): number {
  return 2 * size;
}

export function offsetToPixel(pos: Offset, layout: HexLayout = DEFAULT_HEX_LAYOUT): PixelPoint {
  const w = hexWidth(layout.size);
  const rowShift = pos.row & 1 ? 0.5 : 0;
  const x = w * (pos.col + rowShift);
  const yBase = 1.5 * layout.size * pos.row;
  return {
    x: x + layout.origin.x,
    y: yBase * layout.isoCompress + layout.origin.y,
  };
}

export function mapPixelBounds(
  width: number,
  height: number,
  layout: HexLayout = DEFAULT_HEX_LAYOUT,
): { readonly width: number; readonly height: number } {
  if (width === 0 || height === 0) {
    return { width: 0, height: 0 };
  }
  const w = hexWidth(layout.size);
  // Max x considers odd-row right-shift.
  const maxCol = width - 1;
  const hasOddRow = height > 1;
  const xRight = w * (maxCol + (hasOddRow ? 0.5 : 0)) + w;
  const yBottomRow = 1.5 * layout.size * (height - 1);
  const yBottom = yBottomRow * layout.isoCompress + hexHeight(layout.size) * layout.isoCompress;
  return { width: xRight, height: yBottom };
}

/**
 * Compose a z-index for tiles so that higher rows render in front of lower rows.
 *
 * Each row gets a block of 1000 z-values; `layer` is a fine-grained offset for
 * within-row ordering (e.g., cliff side = 0, tile top = 1, unit = 10, HP bar = 20).
 */
export function rowZIndex(row: number, layer: number = 0): number {
  return row * 1000 + layer;
}
