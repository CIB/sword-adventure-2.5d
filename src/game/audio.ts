type OscType = OscillatorType;

const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

// --- Original overworld theme (16 bars, 4/4, eighth-note grid) ---
// [midi, length in eighths]; 0 = rest
const LEAD: number[][][] = [
  [[76, 2], [79, 1], [76, 1], [74, 2], [72, 2]],
  [[74, 3], [76, 1], [72, 4]],
  [[81, 2], [79, 1], [77, 1], [76, 2], [77, 2]],
  [[79, 6], [0, 2]],
  [[76, 2], [81, 1], [76, 1], [72, 2], [74, 2]],
  [[77, 2], [81, 1], [77, 1], [72, 2], [69, 2]],
  [[71, 2], [74, 1], [71, 1], [79, 2], [77, 2]],
  [[76, 4], [0, 1], [67, 1], [69, 1], [71, 1]],
  [[72, 1], [72, 1], [76, 2], [79, 2], [84, 2]],
  [[83, 2], [81, 2], [79, 2], [76, 2]],
  [[77, 2], [81, 2], [84, 3], [81, 1]],
  [[79, 2], [83, 2], [86, 2], [83, 1], [81, 1]],
  [[81, 3], [79, 1], [76, 2], [72, 2]],
  [[77, 3], [76, 1], [74, 2], [77, 2]],
  [[76, 2], [74, 2], [71, 2], [74, 2]],
  [[72, 6], [0, 2]],
];
// chord roots (octave 3) and quality per bar
const CHORDS: [number, boolean][] = [
  [48, true], [48, true], [53, true], [55, true], [57, false], [53, true], [55, true], [48, true],
  [48, true], [57, false], [53, true], [55, true], [57, false], [53, true], [55, true], [48, true],
];

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private musicBus!: GainNode;
  private noiseBuf!: AudioBuffer;
  private timer: number | null = null;
  private step = 0;
  private nextTime = 0;
  private leadEvents: { step: number; midi: number; len: number }[] = [];
  muted = false;
  musicOn = false;

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(ctx.destination);
    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = 0.7;
    this.sfxBus.connect(this.master);
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0.42;
    // light echo on the music bus for an SNES-ish ambience
    const delay = ctx.createDelay(0.5);
    delay.delayTime.value = 0.23;
    const fb = ctx.createGain();
    fb.gain.value = 0.22;
    const wet = ctx.createGain();
    wet.gain.value = 0.25;
    this.musicBus.connect(this.master);
    this.musicBus.connect(delay);
    delay.connect(fb);
    fb.connect(delay);
    delay.connect(wet);
    wet.connect(this.master);
    // noise buffer
    const len = ctx.sampleRate;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    // flatten melody into events
    let s = 0;
    for (const bar of LEAD) for (const [midi, len] of bar) { if (midi > 0) this.leadEvents.push({ step: s, midi, len }); s += len; }
  }

  resume() { if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume(); }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.02);
  }

  // ------------------------------------------------------------ primitives
  private tone(type: OscType, f0: number, dur: number, vol: number, opts: { f1?: number; when?: number; bus?: GainNode; attack?: number; lp?: number; sustain?: boolean; vibrato?: number } = {}) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = opts.when ?? ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    if (opts.f1) osc.frequency.exponentialRampToValueAtTime(opts.f1, t + dur);
    if (opts.vibrato) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 5.5;
      const lg = ctx.createGain();
      lg.gain.value = opts.vibrato;
      lfo.connect(lg);
      lg.connect(osc.frequency);
      lfo.start(t);
      lfo.stop(t + dur + 0.05);
    }
    const g = ctx.createGain();
    const a = opts.attack ?? 0.005;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + a);
    if (opts.sustain && dur > a + 0.08) {
      g.gain.setValueAtTime(vol, t + a);
      g.gain.linearRampToValueAtTime(vol * 0.75, t + dur - 0.06);
    }
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node: AudioNode = osc;
    if (opts.lp) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = opts.lp; osc.connect(f); node = f; }
    node.connect(g);
    g.connect(opts.bus ?? this.sfxBus);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  private noise(dur: number, vol: number, filter: BiquadFilterType, f0: number, opts: { f1?: number; q?: number; when?: number; bus?: GainNode; attack?: number } = {}) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = opts.when ?? ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.playbackRate.value = 1;
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.setValueAtTime(f0, t);
    if (opts.f1) f.frequency.exponentialRampToValueAtTime(opts.f1, t + dur);
    f.Q.value = opts.q ?? 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + (opts.attack ?? 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(opts.bus ?? this.sfxBus);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }

  // ------------------------------------------------------------ sfx
  swing() { this.noise(0.13, 0.35, 'highpass', 1800, { f1: 600 }); this.tone('square', 1300, 0.09, 0.06, { f1: 350 }); }
  hit() { this.tone('square', 240, 0.09, 0.22, { f1: 90 }); this.noise(0.06, 0.25, 'bandpass', 900, { q: 1.5 }); }
  enemyDie() {
    this.noise(0.4, 0.32, 'lowpass', 3500, { f1: 150 });
    const t = this.ctx?.currentTime ?? 0;
    [660, 520, 380, 250].forEach((f, i) => this.tone('square', f, 0.08, 0.1, { when: t + i * 0.07 }));
  }
  hurt() { this.tone('sawtooth', 210, 0.12, 0.22, { f1: 140, lp: 1200 }); this.tone('square', 150, 0.18, 0.16, { f1: 90, when: (this.ctx?.currentTime ?? 0) + 0.1 }); }
  rupee() { const t = this.ctx?.currentTime ?? 0; this.tone('square', 1568, 0.07, 0.11, { when: t }); this.tone('square', 2093, 0.14, 0.11, { when: t + 0.07 }); }
  heart() { const t = this.ctx?.currentTime ?? 0; [988, 1319, 1976].forEach((f, i) => this.tone('triangle', f, 0.1, 0.18, { when: t + i * 0.08 })); }
  arrow() { this.noise(0.09, 0.22, 'highpass', 3000); this.tone('square', 900, 0.06, 0.05, { f1: 1600 }); }
  throwJav() { this.noise(0.18, 0.22, 'bandpass', 500, { f1: 1200, q: 1.2 }); }
  block() { this.tone('square', 2400, 0.05, 0.13); this.tone('square', 1700, 0.1, 0.1, { when: (this.ctx?.currentTime ?? 0) + 0.03 }); this.noise(0.04, 0.2, 'highpass', 4000); }
  grassCut() { this.noise(0.09, 0.16, 'bandpass', 2600, { q: 0.8, attack: 0.005 }); }
  bushCut() { this.noise(0.16, 0.32, 'bandpass', 1300, { q: 1, attack: 0.01 }); }
  charged() { const t = this.ctx?.currentTime ?? 0; [880, 1108, 1318, 1760].forEach((f, i) => this.tone('square', f, 0.06, 0.09, { when: t + i * 0.045 })); }
  spin() { this.noise(0.38, 0.3, 'highpass', 700, { f1: 3500 }); this.tone('square', 300, 0.32, 0.07, { f1: 950 }); }
  alert() { const t = this.ctx?.currentTime ?? 0; this.tone('square', 1200, 0.05, 0.09, { when: t }); this.tone('square', 1600, 0.09, 0.09, { when: t + 0.05 }); }
  talk() { const t = this.ctx?.currentTime ?? 0; this.tone('square', 880, 0.05, 0.08, { when: t }); this.tone('square', 1320, 0.07, 0.08, { when: t + 0.05 }); }
  blip() { this.tone('square', 1500 + Math.random() * 300, 0.03, 0.035); }
  // ---- the ladybugs
  /** wing covers scraping open: a dry papery rustle that swells over the whole wind-up */
  wingCharge(dur: number) { this.noise(dur, 0.07, 'bandpass', 900, { f1: 2400, q: 1.1, attack: dur * 0.55 }); }
  /** the wing-clap: one hard rush of wind, with a low thump of air behind it */
  gust() {
    this.noise(0.5, 0.32, 'lowpass', 1200, { f1: 260, attack: 0.04 });
    this.noise(0.32, 0.14, 'bandpass', 2600, { f1: 700, q: 0.7 });
    this.tone('sine', 95, 0.22, 0.28, { f1: 42 });
  }
  // ---- the spitflower
  /** the mouth charging: a rising, wobbling whine that swells over the whole glow */
  spitCharge(dur: number) { this.tone('sine', 320, dur, 0.09, { f1: 980, attack: dur * 0.6 }); this.tone('triangle', 160, dur, 0.05, { f1: 490, attack: dur * 0.6 }); }
  /** the spit: a wet pop and the ball whistling off */
  spit() { const t = this.ctx?.currentTime ?? 0; this.noise(0.08, 0.22, 'bandpass', 700, { q: 1.4 }); this.tone('square', 1100, 0.18, 0.09, { f1: 500, when: t + 0.02 }); this.tone('sine', 1700, 0.25, 0.05, { f1: 700, when: t + 0.02 }); }
  lowHp() { this.tone('square', 1046, 0.06, 0.07); }
  // ---- the farm
  /** the hoe biting into soil: a dull thud with a little grit */
  hoe() { this.tone('triangle', 140, 0.1, 0.16, { f1: 60 }); this.noise(0.09, 0.14, 'lowpass', 900, { f1: 300 }); }
  /** a cast of seed pattering onto the earth */
  sow() { const t = this.ctx?.currentTime ?? 0; for (let i = 0; i < 5; i++) this.noise(0.025, 0.07, 'bandpass', 2600 + i * 350, { q: 3, when: t + 0.12 + i * 0.045 + Math.random() * 0.02 }); }
  /** water pouring from the can for `dur` seconds */
  water(dur: number) { this.noise(dur, 0.1, 'bandpass', 1400, { f1: 900, q: 0.6, attack: 0.08 }); this.noise(dur * 0.8, 0.05, 'highpass', 3200, { attack: 0.1 }); }
  /** a root tearing out of the ground, then a happy little pop */
  harvest() { const t = this.ctx?.currentTime ?? 0; this.noise(0.12, 0.16, 'lowpass', 700, { f1: 250 }); this.tone('square', 520, 0.06, 0.08, { f1: 1040, when: t + 0.1 }); }
  start() { const t = this.ctx?.currentTime ?? 0; [523, 659, 784, 1047].forEach((f, i) => this.tone('square', f, 0.12, 0.12, { when: t + i * 0.1 })); this.tone('square', 1047, 0.4, 0.12, { when: t + 0.4 }); this.tone('triangle', 523, 0.5, 0.15, { when: t + 0.4 }); }
  gameOver() { const t = this.ctx?.currentTime ?? 0; [392, 349, 330, 262].forEach((f, i) => this.tone('sawtooth', f, 0.32, 0.14, { when: t + i * 0.3, lp: 900 })); }

  // ------------------------------------------------------------ music
  startMusic() {
    if (!this.ctx || this.musicOn) return;
    this.musicOn = true;
    this.step = 0;
    this.nextTime = this.ctx.currentTime + 0.1;
    this.timer = window.setInterval(() => this.schedule(), 40);
  }
  stopMusic() {
    this.musicOn = false;
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
  }

  private schedule() {
    if (!this.ctx) return;
    const eighth = 60 / 132 / 2;
    while (this.nextTime < this.ctx.currentTime + 0.2) {
      this.playStep(this.step, this.nextTime, eighth);
      this.step = (this.step + 1) % 128;
      this.nextTime += eighth;
    }
  }

  private playStep(step: number, t: number, eighth: number) {
    const bus = this.musicBus;
    const bar = Math.floor(step / 8), sub = step % 8;
    const [root, major] = CHORDS[bar];
    // lead (brassy saw through lowpass, slight vibrato)
    for (const ev of this.leadEvents) {
      if (ev.step !== step) continue;
      const dur = ev.len * eighth * 0.92;
      this.tone('sawtooth', midiHz(ev.midi), dur, 0.15, { when: t, bus, attack: 0.02, lp: 2200, sustain: true, vibrato: ev.len >= 3 ? 4 : 0 });
      this.tone('square', midiHz(ev.midi) * 0.5, dur, 0.03, { when: t, bus, attack: 0.02, sustain: true });
    }
    // bass: root / fifth march
    if (sub % 2 === 0) {
      const b = root - 12 + (sub === 2 || sub === 6 ? 7 : 0);
      this.tone('triangle', midiHz(b), eighth * 1.6, 0.32, { when: t, bus, attack: 0.01, sustain: true });
    }
    // arpeggio
    const arp = [0, major ? 4 : 3, 7, major ? 4 : 3][sub % 4];
    this.tone('square', midiHz(root + arp), eighth * 0.7, 0.035, { when: t, bus });
    // drums
    if (sub === 0 || sub === 4 || (sub === 7 && bar % 2 === 1)) this.tone('sine', 160, 0.14, 0.5, { when: t, bus, f1: 45 });
    if (sub === 2 || sub === 6) { this.noise(0.12, 0.22, 'bandpass', 1900, { when: t, bus, q: 0.7 }); this.tone('triangle', 220, 0.06, 0.2, { when: t, bus, f1: 120 }); }
    this.noise(sub % 2 ? 0.03 : 0.05, 0.05, 'highpass', 7500, { when: t, bus });
  }
}
