/**
 * Procedural audio — no assets, everything synthesized with WebAudio.
 *
 * A small noir score rather than an ambience of noise:
 *  - Pad: a slow A-minor-seventh chord (sine/triangle voices), each voice
 *    breathing on its own LFO, the whole chord behind a gently sweeping
 *    lowpass — the "empty office at 2am" bed.
 *  - Keys: sparse pentatonic plucks with a feedback-delay tail, like someone
 *    touching a piano two rooms away. Never on a grid; every few seconds.
 *  - Tension: a low detuned fifth whose level follows the investigation
 *    (set by the app as the case heats up).
 */

export class AudioDirector {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private tensionGain: GainNode | null = null;
  private pluckTimer: number | null = null;
  private delaySend: DelayNode | null = null;
  private enabled = false;

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Must be called from a user gesture. */
  toggle(): boolean {
    if (this.enabled) {
      this.stop();
    } else {
      this.start();
    }
    return this.enabled;
  }

  private start(): void {
    try {
      this.ctx = new AudioContext();
      const ctx = this.ctx;
      this.master = ctx.createGain();
      this.master.gain.value = 0.0;
      this.master.connect(ctx.destination);
      // Gentle fade-in.
      this.master.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 3);

      // --- Shared space: a feedback delay both pad swells and plucks feed.
      this.delaySend = ctx.createDelay(2);
      this.delaySend.delayTime.value = 0.46;
      const feedback = ctx.createGain();
      feedback.gain.value = 0.34;
      const delayTone = ctx.createBiquadFilter();
      delayTone.type = "lowpass";
      delayTone.frequency.value = 1600;
      const wet = ctx.createGain();
      wet.gain.value = 0.35;
      this.delaySend.connect(delayTone).connect(feedback).connect(this.delaySend);
      this.delaySend.connect(wet).connect(this.master);

      // --- The pad: Am7 voicing, low and slow.
      const padFilter = ctx.createBiquadFilter();
      padFilter.type = "lowpass";
      padFilter.frequency.value = 650;
      padFilter.Q.value = 0.4;
      const padBus = ctx.createGain();
      padBus.gain.value = 0.9;
      padFilter.connect(padBus).connect(this.master);
      // Filter breathes over ~40 seconds.
      const sweep = ctx.createOscillator();
      sweep.frequency.value = 0.025;
      const sweepAmt = ctx.createGain();
      sweepAmt.gain.value = 220;
      sweep.connect(sweepAmt).connect(padFilter.frequency);
      sweep.start();

      const voices: Array<{ freq: number; type: OscillatorType; level: number; lfoRate: number }> = [
        { freq: 110.0, type: "sine", level: 0.11, lfoRate: 0.031 },   // A2 root
        { freq: 164.81, type: "sine", level: 0.075, lfoRate: 0.047 }, // E3 fifth
        { freq: 196.0, type: "triangle", level: 0.05, lfoRate: 0.038 },  // G3 seventh
        { freq: 261.63, type: "triangle", level: 0.038, lfoRate: 0.056 }, // C4 third
      ];
      for (const v of voices) {
        const osc = ctx.createOscillator();
        osc.type = v.type;
        osc.frequency.value = v.freq;
        osc.detune.value = (Math.random() - 0.5) * 6; // gentle chorusing between voices
        const g = ctx.createGain();
        g.gain.value = v.level * 0.6;
        // Each voice swells and recedes on its own slow cycle. An LFO has no
        // settable phase, so desync voices by delaying each one's start by
        // a random fraction of its own period.
        const lfo = ctx.createOscillator();
        lfo.frequency.value = v.lfoRate;
        const lfoAmt = ctx.createGain();
        lfoAmt.gain.value = v.level * 0.4;
        lfo.connect(lfoAmt).connect(g.gain);
        osc.connect(g).connect(padFilter);
        g.connect(this.delaySend);
        osc.start();
        lfo.start(ctx.currentTime + Math.random() * (1 / v.lfoRate));
      }

      // --- Tension: low A + E fifth, detuned, rises with the case.
      this.tensionGain = ctx.createGain();
      this.tensionGain.gain.value = 0;
      for (const f of [55, 82.41, 55 * 1.01]) {
        const d = ctx.createOscillator();
        d.type = "sine";
        d.frequency.value = f;
        d.connect(this.tensionGain);
        d.start();
      }
      this.tensionGain.connect(this.master);

      // --- The distant piano: sparse pentatonic plucks.
      this.schedulePlucks();

      this.enabled = true;
    } catch {
      this.enabled = false;
    }
  }

  /** Sparse, un-gridded plucks from A-minor pentatonic. */
  private schedulePlucks(): void {
    if (!this.ctx) return;
    const scale = [220.0, 261.63, 293.66, 329.63, 392.0, 440.0, 523.25];
    let next = this.ctx.currentTime + 2 + Math.random() * 3;
    this.pluckTimer = window.setInterval(() => {
      const ctx = this.ctx;
      if (!ctx || !this.master || !this.delaySend) return;
      if (ctx.currentTime < next) return;
      // Sometimes a single note, sometimes a soft two-note phrase.
      const notes = Math.random() < 0.3 ? 2 : 1;
      for (let i = 0; i < notes; i++) {
        const when = ctx.currentTime + i * (0.35 + Math.random() * 0.25);
        const freq = scale[Math.floor(Math.random() * scale.length)]!;
        this.pluck(freq, when);
      }
      next = ctx.currentTime + 4 + Math.random() * 7;
    }, 250);
  }

  /** One piano-ish note: fundamental + quiet octave, sharp attack, long decay. */
  private pluck(freq: number, when: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.delaySend) return;
    for (const [mult, level] of [[1, 0.045], [2, 0.014], [3.01, 0.004]] as const) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq * mult;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(level, when + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 2.8);
      osc.connect(g);
      g.connect(this.master);
      g.connect(this.delaySend);
      osc.start(when);
      osc.stop(when + 3);
    }
  }

  private stop(): void {
    if (this.pluckTimer !== null) {
      clearInterval(this.pluckTimer);
      this.pluckTimer = null;
    }
    if (this.ctx && this.master) {
      const ctx = this.ctx;
      this.master.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.6);
      setTimeout(() => ctx.close().catch(() => {}), 800);
    }
    this.ctx = null;
    this.master = null;
    this.tensionGain = null;
    this.delaySend = null;
    this.enabled = false;
  }

  /** 0..1 — how hot the case is. */
  setTension(v: number): void {
    if (!this.ctx || !this.tensionGain) return;
    const clamped = Math.max(0, Math.min(1, v));
    this.tensionGain.gain.linearRampToValueAtTime(clamped * 0.05, this.ctx.currentTime + 1.5);
  }

  /** Short confirmation blip for actions. */
  blip(kind: "act" | "find" | "bad" = "act"): void {
    if (!this.ctx || !this.master || !this.enabled) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.value = kind === "find" ? 660 : kind === "bad" ? 180 : 440;
    g.gain.value = 0;
    g.gain.linearRampToValueAtTime(0.07, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    osc.connect(g).connect(this.master);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  }
}
