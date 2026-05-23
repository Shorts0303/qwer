/**
 * Engine runtime — main-thread proxy for the Pyodide WebWorker.
 *
 * The worker handles all Python execution (download, FS setup, GameEngine
 * lifecycle, streaming generator pump) so the main thread stays free for
 * PIXI rendering, audio, and input. We multiplex requests over a single
 * MessageChannel using monotonically-increasing request ids.
 *
 * The exposed API (loadEngineRuntime / EngineRuntime) is identical to the
 * pre-worker version so callers don't need to know about the worker layer.
 */

import { parseReplay, parseSingleEvent } from '../replay/parse';
import type { Replay, ReplayEvent, TeamId } from '../replay/types';
import type { OpponentOption } from './engineSources';
import type { MainMessage, WorkerMessage } from './worker';

export type ProgressListener = (message: string) => void;

export interface EngineRuntime {
  runMatch(options: RunMatchOptions): Promise<Replay>;
  runMatchStreaming(
    options: RunMatchOptions,
    handlers: StreamingHandlers,
  ): StreamingHandle;
  /** Tournament leg with both sides as uploaded sources, streamed live. */
  runTournamentLive(
    options: TournamentMatchOptions,
    handlers: StreamingHandlers,
  ): StreamingHandle;
  /** Tournament leg run to completion in the worker — returns the final replay only. */
  runTournamentBatch(options: TournamentMatchOptions): Promise<Replay>;
}

export interface TournamentMatchOptions {
  readonly aSource: string;
  readonly bSource: string;
  readonly firstTeam: TeamId;
  readonly aLabel: string;
  readonly bLabel: string;
}

export interface TutorialOverride {
  /** 좁은 디오라마 맵 — engine/maps/default.txt 와 같은 ASCII 문법. */
  readonly mapText: string;
  /**
   * 슬롯별 시작 좌표. 양 팀 모두 5개 슬롯(dmr/rifle_1/shield/rifle_2/medic) 를
   * 채워야 한다 — 엔진이 항상 5명을 스폰하기 때문.
   */
  readonly startPositions: {
    readonly A: Readonly<Record<string, readonly [number, number]>>;
    readonly B: Readonly<Record<string, readonly [number, number]>>;
  };
  /** 본 게임 30라운드 max 를 시나리오 단위로 단축. */
  readonly maxRounds?: number;
}

export interface RunMatchOptions {
  readonly studentSource: string;
  readonly studentClassName: string;
  readonly opponent: OpponentOption;
  readonly studentTeam: TeamId;
  readonly firstTeam?: TeamId;
  /**
   * 튜토리얼 시나리오에서만 사용. 지정 시 워커가 이 맵·시작배치로 patched
   * balance·map 파일을 만들어 GameEngine 에 넘기고, 결과 리플레이의
   * `meta.tutorial_map` 에 mapText 를 박아 viewer 가 맵을 swap 할 수 있게 한다.
   */
  readonly tutorialOverride?: TutorialOverride;
}

export interface StreamingHandlers {
  onEvent: (event: ReplayEvent) => void;
  onComplete: (replay: Replay) => void;
  onError: (err: Error) => void;
}

export interface StreamingHandle {
  stop(): void;
  readonly stopped: boolean;
}

interface PendingMatch {
  type: 'runMatch';
  resolve: (replay: Replay) => void;
  reject: (err: Error) => void;
  onProgress?: ProgressListener;
}

interface PendingStream {
  type: 'runMatchStreaming';
  handlers: StreamingHandlers;
  stopped: boolean;
}

interface PendingInit {
  type: 'init';
  resolve: () => void;
  reject: (err: Error) => void;
  onProgress?: ProgressListener;
}

type Pending = PendingMatch | PendingStream | PendingInit;

export async function loadEngineRuntime(
  onProgress?: ProgressListener,
): Promise<EngineRuntime> {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
  });
  const proxy = new RuntimeProxy(worker);
  await proxy.init(onProgress);
  return {
    runMatch: (opts) => proxy.runMatch(opts),
    runMatchStreaming: (opts, handlers) => proxy.runMatchStreaming(opts, handlers),
    runTournamentLive: (opts, handlers) => proxy.runTournamentLive(opts, handlers),
    runTournamentBatch: (opts) => proxy.runTournamentBatch(opts),
  };
}

class RuntimeProxy {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly worker: Worker) {
    worker.onmessage = (e: MessageEvent<WorkerMessage>) => this.dispatch(e.data);
    worker.onerror = (e: ErrorEvent) => {
      const err = new Error(`worker error: ${e.message}`);
      // Surface to all in-flight requests so callers don't hang.
      for (const [id, p] of this.pending) {
        this.failPending(id, p, err);
      }
    };
  }

  init(onProgress?: ProgressListener): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const id = this.nextId++;
      const opts: PendingInit = { type: 'init', resolve, reject };
      if (onProgress !== undefined) opts.onProgress = onProgress;
      this.pending.set(id, opts);
      this.send({ type: 'init', id });
    });
  }

  runMatch(options: RunMatchOptions): Promise<Replay> {
    return new Promise<Replay>((resolve, reject) => {
      const id = this.nextId++;
      const entry: PendingMatch = { type: 'runMatch', resolve, reject };
      this.pending.set(id, entry);
      this.send({
        type: 'runMatch',
        id,
        options: serializeOptions(options),
      });
    });
  }

  runMatchStreaming(
    options: RunMatchOptions,
    handlers: StreamingHandlers,
  ): StreamingHandle {
    const id = this.nextId++;
    const entry: PendingStream = {
      type: 'runMatchStreaming',
      handlers,
      stopped: false,
    };
    this.pending.set(id, entry);
    this.send({
      type: 'runMatchStreaming',
      id,
      options: serializeOptions(options),
    });
    return {
      stop: () => {
        entry.stopped = true;
        this.send({ type: 'stop', id });
      },
      get stopped() { return entry.stopped; },
    };
  }

  runTournamentLive(
    options: TournamentMatchOptions,
    handlers: StreamingHandlers,
  ): StreamingHandle {
    const id = this.nextId++;
    const entry: PendingStream = {
      type: 'runMatchStreaming',
      handlers,
      stopped: false,
    };
    this.pending.set(id, entry);
    this.send({ type: 'runTournamentLive', id, options });
    return {
      stop: () => {
        entry.stopped = true;
        this.send({ type: 'stop', id });
      },
      get stopped() { return entry.stopped; },
    };
  }

  runTournamentBatch(options: TournamentMatchOptions): Promise<Replay> {
    return new Promise<Replay>((resolve, reject) => {
      const id = this.nextId++;
      const entry: PendingMatch = { type: 'runMatch', resolve, reject };
      this.pending.set(id, entry);
      this.send({ type: 'runTournamentBatch', id, options });
    });
  }

  private send(msg: MainMessage): void {
    this.worker.postMessage(msg);
  }

  private dispatch(msg: WorkerMessage): void {
    const entry = this.pending.get(msg.id);
    if (entry === undefined) return;
    switch (msg.type) {
      case 'progress':
        if ('onProgress' in entry && entry.onProgress) entry.onProgress(msg.message);
        break;
      case 'ready':
        if (entry.type === 'init') {
          entry.resolve();
          this.pending.delete(msg.id);
        }
        break;
      case 'match-replay':
        if (entry.type === 'runMatch') {
          try {
            entry.resolve(parseReplay(JSON.parse(msg.replayJson)));
          } catch (err) {
            entry.reject(err instanceof Error ? err : new Error(String(err)));
          }
          this.pending.delete(msg.id);
        }
        break;
      case 'stream-event':
        if (entry.type === 'runMatchStreaming') {
          try {
            entry.handlers.onEvent(parseSingleEvent(JSON.parse(msg.eventJson)));
          } catch (err) {
            entry.handlers.onError(err instanceof Error ? err : new Error(String(err)));
          }
        }
        break;
      case 'stream-complete':
        if (entry.type === 'runMatchStreaming') {
          try {
            entry.handlers.onComplete(parseReplay(JSON.parse(msg.replayJson)));
          } catch (err) {
            entry.handlers.onError(err instanceof Error ? err : new Error(String(err)));
          }
          this.pending.delete(msg.id);
        }
        break;
      case 'error':
        this.failPending(msg.id, entry, new Error(msg.message));
        break;
    }
  }

  private failPending(id: number, entry: Pending, err: Error): void {
    if (entry.type === 'init') entry.reject(err);
    else if (entry.type === 'runMatch') entry.reject(err);
    else entry.handlers.onError(err);
    this.pending.delete(id);
  }
}

function serializeOptions(options: RunMatchOptions): {
  studentSource: string;
  studentClassName: string;
  opponent: OpponentOption;
  studentTeam: TeamId;
  firstTeam?: TeamId;
  tutorialOverride?: TutorialOverride;
} {
  const out: {
    studentSource: string;
    studentClassName: string;
    opponent: OpponentOption;
    studentTeam: TeamId;
    firstTeam?: TeamId;
    tutorialOverride?: TutorialOverride;
  } = {
    studentSource: options.studentSource,
    studentClassName: options.studentClassName,
    opponent: options.opponent,
    studentTeam: options.studentTeam,
  };
  if (options.firstTeam !== undefined) out.firstTeam = options.firstTeam;
  if (options.tutorialOverride !== undefined) out.tutorialOverride = options.tutorialOverride;
  return out;
}
