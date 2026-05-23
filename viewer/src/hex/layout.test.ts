import { describe, it, expect } from 'vitest';
import { DEFAULT_HEX_LAYOUT, hexWidth, mapPixelBounds, offsetToPixel, rowZIndex } from './layout';

const EPS = 1e-9;

describe('hex layout: offsetToPixel (pointy-top odd-r)', () => {
  it('places origin tile at the layout origin', () => {
    const origin = { x: 100, y: 50 };
    const p = offsetToPixel({ col: 0, row: 0 }, { ...DEFAULT_HEX_LAYOUT, origin });
    expect(p.x).toBeCloseTo(origin.x, 6);
    expect(p.y).toBeCloseTo(origin.y, 6);
  });

  it('odd rows are shifted right by half a hex width', () => {
    const even = offsetToPixel({ col: 5, row: 0 });
    const odd = offsetToPixel({ col: 5, row: 1 });
    const half = hexWidth(DEFAULT_HEX_LAYOUT.size) / 2;
    expect(odd.x - even.x).toBeCloseTo(half, 6);
  });

  it('row spacing is 1.5 × size × isoCompress', () => {
    const layout = { ...DEFAULT_HEX_LAYOUT, isoCompress: 0.7 };
    const a = offsetToPixel({ col: 0, row: 2 }, layout);
    const b = offsetToPixel({ col: 0, row: 4 }, layout);
    const expected = 2 * 1.5 * layout.size * layout.isoCompress;
    expect(b.y - a.y).toBeCloseTo(expected, 6);
  });

  it('no iso compression gives 1.5 × size pitch per row', () => {
    const layout = { ...DEFAULT_HEX_LAYOUT, isoCompress: 1.0 };
    const a = offsetToPixel({ col: 0, row: 0 }, layout);
    const b = offsetToPixel({ col: 0, row: 1 }, layout);
    expect(b.y - a.y).toBeCloseTo(1.5 * layout.size, 6);
  });
});

describe('hex layout: mapPixelBounds', () => {
  it('returns zero bounds for empty grid', () => {
    expect(mapPixelBounds(0, 0)).toEqual({ width: 0, height: 0 });
  });

  it('covers all 11×7 tiles with room for the right-shifted odd rows', () => {
    const b = mapPixelBounds(11, 7);
    const w = hexWidth(DEFAULT_HEX_LAYOUT.size);
    // width must exceed the rightmost pixel of any odd row (col=10 + 0.5) plus a hex width
    expect(b.width).toBeGreaterThan(w * 10.5);
    expect(b.height).toBeGreaterThan(0);
  });
});

describe('rowZIndex', () => {
  it('orders rows so later rows draw in front', () => {
    expect(rowZIndex(3)).toBeGreaterThan(rowZIndex(2));
  });

  it('within a row, layer offsets are preserved', () => {
    expect(rowZIndex(2, 0)).toBeLessThan(rowZIndex(2, 10));
    expect(rowZIndex(2, 999)).toBeLessThan(rowZIndex(3, 0));
  });

  it('is a pure integer function', () => {
    expect(Number.isInteger(rowZIndex(5, 7))).toBe(true);
  });
});

describe('hexWidth sanity', () => {
  it('is √3 × size', () => {
    expect(hexWidth(48)).toBeCloseTo(Math.sqrt(3) * 48, 6);
  });

  it('matches EPS tolerance baseline', () => {
    expect(Math.abs(hexWidth(1) - Math.sqrt(3))).toBeLessThan(EPS);
  });
});
