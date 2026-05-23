import { describe, it, expect, vi } from 'vitest';
import { ReplayPlayer, type Scheduler } from './player';
import type { Frame, Timeline } from './timeline';

function makeTimeline(n: number): Timeline {
  const frames: Frame[] = [];
  for (let i = 0; i < n; i += 1) {
    frames.push({
      eventIndex: i,
      round: i === 0 ? 0 : Math.ceil(i / 2),
      phase: i === 0 ? 'setup' : i === n - 1 ? 'end' : 'A',
      units: new Map(),
      gauge: { A: i * 5, B: 0 },
      description: `frame ${i}`,
      actions: [],
      warnings: { A: 0, B: 0 },
    });
  }
  return { frames, winner: 'A', endReason: 'gauge' };
}

class FakeScheduler implements Scheduler {
  private nextHandle = 1;
  private callbacks = new Map<number, () => void>();
  setTimeout(cb: () => void, _ms: number): number {
    const h = this.nextHandle++;
    this.callbacks.set(h, cb);
    return h;
  }
  clearTimeout(handle: number): void {
    this.callbacks.delete(handle);
  }
  /** Fire and drop all currently-queued one-shot timers. */
  tick(): void {
    const pending = Array.from(this.callbacks.entries());
    this.callbacks.clear();
    for (const [, cb] of pending) cb();
  }
  get activeCount(): number {
    return this.callbacks.size;
  }
}

describe('ReplayPlayer: basic state', () => {
  it('starts at frame 0', () => {
    const p = new ReplayPlayer(makeTimeline(5));
    expect(p.currentIndex).toBe(0);
    expect(p.isAtStart).toBe(true);
    expect(p.isAtEnd).toBe(false);
    expect(p.frameCount).toBe(5);
    expect(p.isPlaying).toBe(false);
  });

  it('throws if timeline is empty', () => {
    expect(() => new ReplayPlayer(makeTimeline(0))).toThrow();
  });

  it('emits current frame to listener on step', () => {
    const onFrame = vi.fn();
    const p = new ReplayPlayer(makeTimeline(3), { onFrame });
    expect(onFrame).not.toHaveBeenCalled();
    p.stepForward();
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame).toHaveBeenCalledWith(expect.objectContaining({ eventIndex: 1 }), 1);
  });
});

describe('ReplayPlayer: step', () => {
  it('stepForward advances until end and then returns false', () => {
    const p = new ReplayPlayer(makeTimeline(3));
    expect(p.stepForward()).toBe(true);
    expect(p.currentIndex).toBe(1);
    expect(p.stepForward()).toBe(true);
    expect(p.currentIndex).toBe(2);
    expect(p.isAtEnd).toBe(true);
    expect(p.stepForward()).toBe(false);
    expect(p.currentIndex).toBe(2);
  });

  it('stepBackward retreats until start and then returns false', () => {
    const p = new ReplayPlayer(makeTimeline(3));
    p.seek(2);
    expect(p.stepBackward()).toBe(true);
    expect(p.currentIndex).toBe(1);
    expect(p.stepBackward()).toBe(true);
    expect(p.currentIndex).toBe(0);
    expect(p.stepBackward()).toBe(false);
  });
});

describe('ReplayPlayer: seek', () => {
  it('clamps out-of-range seeks', () => {
    const p = new ReplayPlayer(makeTimeline(3));
    p.seek(-10);
    expect(p.currentIndex).toBe(0);
    p.seek(999);
    expect(p.currentIndex).toBe(2);
  });

  it('rounds fractional seeks down', () => {
    const p = new ReplayPlayer(makeTimeline(5));
    p.seek(2.9);
    expect(p.currentIndex).toBe(2);
  });

  it('does not emit when seeking to current index', () => {
    const onFrame = vi.fn();
    const p = new ReplayPlayer(makeTimeline(3), { onFrame });
    p.seek(0);
    expect(onFrame).not.toHaveBeenCalled();
  });
});

describe('ReplayPlayer: play/pause', () => {
  it('play() advances via scheduler ticks', () => {
    const sched = new FakeScheduler();
    const onFrame = vi.fn();
    const p = new ReplayPlayer(makeTimeline(4), { onFrame, scheduler: sched });
    p.play();
    expect(p.isPlaying).toBe(true);
    sched.tick();
    expect(p.currentIndex).toBe(1);
    sched.tick();
    expect(p.currentIndex).toBe(2);
  });

  it('auto-pauses at end', () => {
    const sched = new FakeScheduler();
    const p = new ReplayPlayer(makeTimeline(3), { scheduler: sched });
    p.play();
    sched.tick(); // 0 -> 1
    sched.tick(); // 1 -> 2
    expect(p.isAtEnd).toBe(true);
    sched.tick(); // triggers pause
    expect(p.isPlaying).toBe(false);
  });

  it('play() after end rewinds to start', () => {
    const sched = new FakeScheduler();
    const p = new ReplayPlayer(makeTimeline(3), { scheduler: sched });
    p.seek(2);
    p.play();
    expect(p.currentIndex).toBe(0);
  });

  it('togglePlay flips play/pause state', () => {
    const sched = new FakeScheduler();
    const p = new ReplayPlayer(makeTimeline(3), { scheduler: sched });
    p.togglePlay();
    expect(p.isPlaying).toBe(true);
    p.togglePlay();
    expect(p.isPlaying).toBe(false);
  });

  it('dispose() stops the timer', () => {
    const sched = new FakeScheduler();
    const p = new ReplayPlayer(makeTimeline(3), { scheduler: sched });
    p.play();
    expect(sched.activeCount).toBe(1);
    p.dispose();
    expect(sched.activeCount).toBe(0);
  });

  it('double-play is a no-op', () => {
    const sched = new FakeScheduler();
    const p = new ReplayPlayer(makeTimeline(3), { scheduler: sched });
    p.play();
    p.play();
    expect(sched.activeCount).toBe(1);
  });
});
