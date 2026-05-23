/**
 * Sound effects via Web Audio synthesis — no external assets.
 *
 * The AudioContext cannot be created or resumed until a user gesture (browser
 * autoplay policy). `primeOnUserGesture()` wires click/keydown listeners that
 * resume the context the first time the user interacts, so later play*() calls
 * produce audio without error.
 *
 * Gunshot = low body thump (triangle) + lowpassed noise crack layered together.
 * Class-specific body frequency + duration give each unit class a distinct feel.
 * Heal = rising sine pling. Step = short lowpassed noise thud.
 */

import type { UnitClass } from '../replay/types';

export interface SfxHandle {
  playAttack(unitClass: UnitClass): void;
  playHeal(): void;
  playStep(unitClass: UnitClass): void;
  primeOnUserGesture(): void;
  dispose(): void;
}

interface AttackTuning {
  readonly bodyFreq: number;       // starting triangle freq for body thump (Hz)
  readonly bodyDecaySec: number;
  readonly crackDurSec: number;    // noise burst duration
  readonly crackCutoff: number;    // lowpass cutoff for noise (Hz)
  readonly gain: number;           // overall loudness
}

const ATTACK_TUNING: Record<UnitClass, AttackTuning> = {
  shield: { bodyFreq: 140, bodyDecaySec: 0.07, crackDurSec: 0.08, crackCutoff: 1400, gain: 0.55 },
  // Rifle is fired in 3-burst from the orchestrator, so each shot is shorter
  // and slightly tighter than a single-shot to keep the burst from smearing.
  rifle:  { bodyFreq: 200, bodyDecaySec: 0.05, crackDurSec: 0.07, crackCutoff: 2600, gain: 0.55 },
  // DMR sniper "boom": low body, longer tail, big sub-bass drop, louder.
  dmr:    { bodyFreq:  95, bodyDecaySec: 0.22, crackDurSec: 0.20, crackCutoff: 1500, gain: 0.95 },
  medic:  { bodyFreq: 180, bodyDecaySec: 0.08, crackDurSec: 0.10, crackCutoff: 2400, gain: 0.60 }, // unused
};

interface StepTuning {
  readonly thumpFreq: number;       // starting pitch of the body kick
  readonly thumpDecaySec: number;
  readonly clickCutoff: number;     // lowpass cutoff for the noise click
  readonly gain: number;
}

const STEP_TUNING: Record<UnitClass, StepTuning> = {
  shield: { thumpFreq:  95, thumpDecaySec: 0.09, clickCutoff:  900, gain: 0.32 }, // heavier
  rifle:  { thumpFreq: 110, thumpDecaySec: 0.07, clickCutoff: 1200, gain: 0.26 },
  dmr:    { thumpFreq: 105, thumpDecaySec: 0.08, clickCutoff: 1100, gain: 0.28 },
  medic:  { thumpFreq: 125, thumpDecaySec: 0.06, clickCutoff: 1400, gain: 0.24 }, // lighter
};

export function createSfx(): SfxHandle {
  let ctx: AudioContext | null = null;
  let masterGain: GainNode | null = null;

  function ensureContext(): AudioContext | null {
    if (ctx !== null) return ctx;
    const AC = (globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
      ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (AC === undefined) return null;
    try {
      const c = new AC();
      const g = c.createGain();
      // Drive the pre-comp bus hot; the compressor below catches peaks so
      // overlapping sounds don't clip into digital nastiness.
      g.gain.value = 1.8;
      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.knee.value = 6;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.12;
      g.connect(comp);
      comp.connect(c.destination);
      ctx = c;
      masterGain = g;
      return c;
    } catch {
      return null;
    }
  }

  function tryResume(): void {
    const c = ensureContext();
    if (c && c.state === 'suspended') {
      void c.resume();
    }
  }

  let primed = false;
  function primeOnUserGesture(): void {
    if (primed) return;
    primed = true;
    const handler = (): void => {
      tryResume();
    };
    window.addEventListener('pointerdown', handler);
    window.addEventListener('keydown', handler);
  }

  function makeNoiseBuffer(c: AudioContext, durSec: number): AudioBuffer {
    const len = Math.max(1, Math.floor(c.sampleRate * durSec));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i += 1) {
      // flat white noise; we shape with gain envelope instead of baked decay.
      data[i] = Math.random() * 2 - 1;
    }
    return buf;
  }

  function playAttack(unitClass: UnitClass): void {
    const c = ensureContext();
    if (!c || !masterGain || c.state !== 'running') return;
    const t = ATTACK_TUNING[unitClass] ?? ATTACK_TUNING.rifle;
    const now = c.currentTime;

    // --- Body thump (triangle oscillator, pitch drops for "whump") ---
    const bodyOsc = c.createOscillator();
    bodyOsc.type = 'triangle';
    bodyOsc.frequency.setValueAtTime(t.bodyFreq, now);
    bodyOsc.frequency.exponentialRampToValueAtTime(Math.max(30, t.bodyFreq * 0.4), now + t.bodyDecaySec);
    const bodyGain = c.createGain();
    bodyGain.gain.setValueAtTime(t.gain * 0.9, now);
    bodyGain.gain.exponentialRampToValueAtTime(0.0005, now + t.bodyDecaySec);
    bodyOsc.connect(bodyGain);
    bodyGain.connect(masterGain);
    bodyOsc.start(now);
    bodyOsc.stop(now + t.bodyDecaySec + 0.01);

    // --- Crack (lowpassed white noise) ---
    const src = c.createBufferSource();
    src.buffer = makeNoiseBuffer(c, t.crackDurSec);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = t.crackCutoff;
    lp.Q.value = 0.7;
    const crackGain = c.createGain();
    crackGain.gain.setValueAtTime(t.gain * 0.7, now);
    crackGain.gain.exponentialRampToValueAtTime(0.0005, now + t.crackDurSec);
    src.connect(lp);
    lp.connect(crackGain);
    crackGain.connect(masterGain);
    src.start(now);
    src.stop(now + t.crackDurSec + 0.02);

    // --- DMR sub-bass "boom" tail — adds the chest-thumping low end ---
    if (unitClass === 'dmr') {
      const subDur = 0.32;
      const sub = c.createOscillator();
      sub.type = 'sine';
      sub.frequency.setValueAtTime(60, now);
      sub.frequency.exponentialRampToValueAtTime(28, now + subDur);
      const subGain = c.createGain();
      subGain.gain.setValueAtTime(t.gain * 0.85, now);
      subGain.gain.exponentialRampToValueAtTime(0.0005, now + subDur);
      sub.connect(subGain);
      subGain.connect(masterGain);
      sub.start(now);
      sub.stop(now + subDur + 0.02);
    }
  }

  function playHeal(): void {
    const c = ensureContext();
    if (!c || !masterGain || c.state !== 'running') return;
    const now = c.currentTime;
    const osc = c.createOscillator();
    osc.type = 'sine';
    const gain = c.createGain();
    osc.frequency.setValueAtTime(440, now);
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.18);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.22, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
    osc.connect(gain);
    gain.connect(masterGain);
    osc.start(now);
    osc.stop(now + 0.28);
  }

  function playStep(unitClass: UnitClass): void {
    const c = ensureContext();
    if (!c || !masterGain || c.state !== 'running') return;
    const t = STEP_TUNING[unitClass] ?? STEP_TUNING.rifle;
    const now = c.currentTime;

    // --- Thump body (sine that dives — kick-drum-ish "bup") ---
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(t.thumpFreq, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, t.thumpFreq * 0.55), now + t.thumpDecaySec);
    const thumpGain = c.createGain();
    thumpGain.gain.setValueAtTime(0, now);
    thumpGain.gain.linearRampToValueAtTime(t.gain, now + 0.004);
    thumpGain.gain.exponentialRampToValueAtTime(0.0005, now + t.thumpDecaySec);
    osc.connect(thumpGain);
    thumpGain.connect(masterGain);
    osc.start(now);
    osc.stop(now + t.thumpDecaySec + 0.01);

    // --- Click layer (very short lowpassed noise for "foot hitting tile") ---
    const clickDur = 0.025;
    const src = c.createBufferSource();
    src.buffer = makeNoiseBuffer(c, clickDur);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = t.clickCutoff;
    lp.Q.value = 0.7;
    const clickGain = c.createGain();
    clickGain.gain.setValueAtTime(t.gain * 0.55, now);
    clickGain.gain.exponentialRampToValueAtTime(0.0005, now + clickDur);
    src.connect(lp);
    lp.connect(clickGain);
    clickGain.connect(masterGain);
    src.start(now);
    src.stop(now + clickDur + 0.02);
  }

  function dispose(): void {
    if (ctx) {
      void ctx.close();
      ctx = null;
      masterGain = null;
    }
  }

  return { playAttack, playHeal, playStep, primeOnUserGesture, dispose };
}
