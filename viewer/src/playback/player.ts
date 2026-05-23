/**
 * ReplayPlayer — a minimal frame-stepping state machine over a Timeline.
 *
 * Supports: seek, step, play/pause, playback speed. Emits a single callback
 * when the active frame changes. No timers are created until play() is called,
 * and pause() clears them so the player is side-effect-free while idle.
 */

import type { Frame, Timeline } from './timeline';

export type FrameListener = (frame: Frame, index: number) => void;

export interface PlayerOptions {
  readonly onFrame?: FrameListener;
  /**
   * Frames per second during play() — fallback used when `getFrameDurationMs`
   * is not provided or returns a non-positive value. Defaults to 1 fps.
   */
  readonly playbackFps?: number;
  /**
   * Optional per-frame delay. Called with the upcoming frame; the returned
   * millisecond value is how long play() waits before advancing to the next
   * frame. Use it to let per-tile move tweens (phase frames with long action
   * sequences) finish before the next frame wipes them.
   */
  readonly getFrameDurationMs?: (frame: Frame) => number;
  /**
   * Live mode: when true, play() does not auto-pause at the current end of
   * the timeline. Instead it polls every `livePollMs` for new frames. Used
   * when the timeline is being filled incrementally by a streaming pump.
   */
  readonly liveMode?: boolean;
  /** Poll interval (ms) while waiting for new frames in live mode. Default 250. */
  readonly livePollMs?: number;
  readonly scheduler?: Scheduler;
}

export interface Scheduler {
  setTimeout(cb: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

const defaultScheduler: Scheduler = {
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms) as unknown as number,
  clearTimeout: (h) =>
    globalThis.clearTimeout(h as unknown as ReturnType<typeof globalThis.setTimeout>),
};

export class ReplayPlayer {
  private readonly timeline: Timeline;
  private readonly listeners = new Set<FrameListener>();
  private readonly fps: number;
  private readonly scheduler: Scheduler;
  private readonly getFrameDurationMs: ((frame: Frame) => number) | null;
  private liveMode: boolean;
  private readonly livePollMs: number;
  private idx = 0;
  private timerHandle: number | null = null;

  constructor(timeline: Timeline, options: PlayerOptions = {}) {
    if (timeline.frames.length === 0) {
      throw new Error('ReplayPlayer: timeline has no frames');
    }
    this.timeline = timeline;
    if (options.onFrame !== undefined) {
      this.listeners.add(options.onFrame);
    }
    this.fps = options.playbackFps ?? 1;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.getFrameDurationMs = options.getFrameDurationMs ?? null;
    this.liveMode = options.liveMode ?? false;
    this.livePollMs = options.livePollMs ?? 250;
  }

  /** Toggle live mode at runtime — used when streaming completes and the
   *  timeline becomes "fixed" so the player can auto-pause normally. */
  setLiveMode(live: boolean): void {
    this.liveMode = live;
  }

  subscribe(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getTimeline(): Timeline {
    return this.timeline;
  }

  get frameCount(): number {
    return this.timeline.frames.length;
  }

  get currentIndex(): number {
    return this.idx;
  }

  get currentFrame(): Frame {
    return this.timeline.frames[this.idx]!;
  }

  get isPlaying(): boolean {
    return this.timerHandle !== null;
  }

  get isAtEnd(): boolean {
    return this.idx === this.frameCount - 1;
  }

  get isAtStart(): boolean {
    return this.idx === 0;
  }

  seek(index: number): void {
    const clamped = Math.max(0, Math.min(this.frameCount - 1, Math.floor(index)));
    if (clamped !== this.idx) {
      this.idx = clamped;
      this.emit();
    }
    // seek to current index is a no-op; call emitCurrent() to force re-paint.
  }

  emitCurrent(): void {
    this.emit();
  }

  stepForward(): boolean {
    if (this.isAtEnd) return false;
    this.idx += 1;
    this.emit();
    return true;
  }

  stepBackward(): boolean {
    if (this.isAtStart) return false;
    this.idx -= 1;
    this.emit();
    return true;
  }

  play(): void {
    if (this.isPlaying) return;
    if (this.isAtEnd) {
      this.seek(0);
    }
    this.scheduleNext();
  }

  private scheduleNext(): void {
    if (this.isAtEnd) {
      // In live mode the timeline is still growing — poll for new frames
      // instead of stopping. Once setLiveMode(false) is called, the next
      // poll that finds no new frames will exit the loop.
      if (this.liveMode) {
        this.timerHandle = this.scheduler.setTimeout(() => {
          this.timerHandle = null;
          if (this.isAtEnd) {
            // still nothing new — keep polling
            if (this.liveMode) this.scheduleNext();
            return;
          }
          this.stepForward();
          this.scheduleNext();
        }, this.livePollMs);
        return;
      }
      this.timerHandle = null;
      return;
    }
    // Delay is based on the CURRENT frame — how long we let its animation
    // settle before revealing the next. This way a long phase frame buys
    // its own tween time.
    const current = this.currentFrame;
    const defaultMs = Math.max(1, Math.round(1000 / this.fps));
    let delayMs = defaultMs;
    if (this.getFrameDurationMs) {
      const custom = this.getFrameDurationMs(current);
      if (custom > 0) delayMs = custom;
    }
    this.timerHandle = this.scheduler.setTimeout(() => {
      this.timerHandle = null;
      if (this.isAtEnd) {
        if (this.liveMode) this.scheduleNext();
        return;
      }
      this.stepForward();
      this.scheduleNext();
    }, delayMs);
  }

  pause(): void {
    if (this.timerHandle !== null) {
      this.scheduler.clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
  }

  togglePlay(): void {
    if (this.isPlaying) this.pause();
    else this.play();
  }

  dispose(): void {
    this.pause();
  }

  private emit(): void {
    // Isolate listener errors so a single misbehaving subscriber (renderer,
    // overlay, controls) cannot break the chain — otherwise stepForward looks
    // like it silently stopped working from the outside.
    for (const l of this.listeners) {
      try {
        l(this.currentFrame, this.idx);
      } catch (err) {
        console.error('[ReplayPlayer] listener threw at frame', this.idx, err);
      }
    }
  }
}
