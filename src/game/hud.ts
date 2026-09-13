import { VIEW_W, VIEW_H, MAX_HP } from './constants';

const FONT: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'], '1': ['010', '110', '010', '010', '111'], '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'], '4': ['101', '101', '111', '001', '001'], '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'], '7': ['111', '001', '001', '010', '010'], '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  A: ['010', '101', '111', '101', '101'], B: ['110', '101', '110', '101', '110'], C: ['011', '100', '100', '100', '011'],
  D: ['110', '101', '101', '101', '110'], E: ['111', '100', '111', '100', '111'], F: ['111', '100', '111', '100', '100'],
  G: ['011', '100', '101', '101', '011'], H: ['101', '101', '111', '101', '101'], I: ['111', '010', '010', '010', '111'],
  J: ['111', '001', '001', '101', '111'], K: ['101', '101', '110', '101', '101'], L: ['100', '100', '100', '100', '111'],
  M: ['101', '111', '111', '101', '101'], N: ['110', '101', '101', '101', '101'], O: ['010', '101', '101', '101', '010'],
  P: ['110', '101', '110', '100', '100'], Q: ['010', '101', '101', '011', '001'], R: ['110', '101', '110', '101', '101'],
  S: ['011', '100', '010', '001', '110'], T: ['111', '010', '010', '010', '010'], U: ['101', '101', '101', '101', '111'],
  V: ['101', '101', '101', '101', '010'], W: ['101', '101', '111', '111', '101'], X: ['101', '101', '010', '101', '101'],
  Y: ['101', '101', '010', '010', '010'], Z: ['111', '001', '010', '100', '111'],
  '-': ['000', '000', '111', '000', '000'], ' ': ['000', '000', '000', '000', '000'], '.': ['000', '000', '000', '000', '010'],
  ',': ['000', '000', '000', '010', '100'], '!': ['010', '010', '010', '000', '010'], '?': ['110', '001', '010', '000', '010'],
  "'": ['010', '010', '000', '000', '000'], ':': ['000', '010', '000', '010', '000'], '~': ['000', '010', '101', '000', '000'],
  '+': ['000', '010', '111', '010', '000'], '(': ['010', '100', '100', '100', '010'], ')': ['010', '001', '001', '001', '010'],
  '/': ['001', '001', '010', '100', '100'],
};

const HEART = ['0110110', '1111111', '1111111', '0111110', '0011100', '0001000'];

/**
 * Frametime graph — a transparent strip across the top of the HUD. It fills the empty middle of the top row:
 * the kill counter ends at x=176 and the life hearts start at `w-88`, so the plot runs from `FT_X0` to
 * `w - FT_RIGHT_GAP`. Nothing is drawn behind the bars (no panel), so the game shows straight through.
 */
const FT_X0 = 182;         // left edge: clear of the 000 kill counter
const FT_RIGHT_GAP = 92;   // right edge = w - FT_RIGHT_GAP: 4px clear of the life hearts
const FT_TEXT_Y = 8;       // ms readout row
const FT_PLOT_Y = 15;      // first plot row
const FT_PLOT_H = 23;      // plot rows — keeps the strip inside the top HUD row (y 7..46)
/** Below this width the top row is too crowded to plot anything (a ~320px window) — the graph is skipped. */
const FT_MIN_W = 8;
/** The readout is 6 glyphs (e.g. `16.7MS`) at 4px each; narrower strips get the bars alone. */
const FT_TEXT_W = 24;
/** Frames of history kept — more than the widest layout plots (an ultrawide HUD plots ~230 columns). */
const FT_HISTORY = 256;
/** Full-scale frametime in ms: a 50ms (20fps) frame pegs the top of the plot, longer ones clamp to it. */
const FT_MAX_MS = 50;
/** Dotted reference lines: 60fps and 30fps. */
const FT_60 = 1000 / 60;
const FT_30 = 1000 / 30;
/**
 * Bar/readout band edges. A vsync-locked 60fps reports 16.6–16.8ms (and a locked 30fps 33.2–33.5), so the
 * thresholds sit 10% above the reference lines: a bar only turns yellow when a frame genuinely missed its
 * vsync window, and red when it missed two.
 */
const FT_GOOD_MAX = FT_60 * 1.1;
const FT_WARN_MAX = FT_30 * 1.1;
/** Frames averaged for the ms readout (~1s at 60fps). */
const FT_AVG = 60;
/** Gaps longer than this are rAF pauses (backgrounded tab), not frametimes — they are dropped. */
const FT_SKIP_MS = 1000;
/** Bar colours as [body, tip]. Cyan/yellow/red rather than the usual green: green bars vanish on the meadow. */
const FT_GOOD: [string, string] = ['#38c8f0', '#d8f8ff'];
const FT_WARN: [string, string] = ['#e8c020', '#fff8a8'];
const FT_BAD: [string, string] = ['#f04838', '#ffb0a0'];

export interface HudState {
  hp: number;
  rupees: number;
  kills: number;
  charge: number;
  charged: boolean;
  blocking: boolean;
  attacking: boolean;
  time: number;
  /** true while the dialogue overlay is open (HUD hides the talk hint) */
  dialogue?: boolean;
  toast?: string;
  canTalk?: boolean;
  /** true when a gamepad is in use — button labels replace key labels */
  gamepad?: boolean;
}

export class Hud {
  private g: CanvasRenderingContext2D;
  /** internal resolution in game pixels — updated by resize() so the layout follows the viewport */
  private w = VIEW_W;
  private h = VIEW_H;
  /** frametime history in ms (ring buffer), fed by pushFrameTime() */
  private ftBuf = new Float32Array(FT_HISTORY);
  private ftHead = 0;  // slot the next sample goes into
  private ftCount = 0; // samples recorded, saturating at FT_HISTORY
  constructor(canvas: HTMLCanvasElement) {
    canvas.width = VIEW_W;
    canvas.height = VIEW_H;
    this.g = canvas.getContext('2d')!;
    this.g.imageSmoothingEnabled = false;
  }

  /** Resize the HUD backing store to the game's new internal resolution. */
  resize(w: number, h: number) {
    const nw = Math.max(1, Math.round(w)), nh = Math.max(1, Math.round(h));
    if (nw === this.w && nh === this.h) return; // assigning canvas.width clears the canvas — only do it on a real change
    this.w = nw;
    this.h = nh;
    this.g.canvas.width = this.w;
    this.g.canvas.height = this.h;
    this.g.imageSmoothingEnabled = false; // resizing the canvas resets context state
  }

  /**
   * Record one frame's duration for the frametime graph. The game loop passes the raw rAF delta (not the
   * clamped simulation step), so a vsync-locked 60fps plots as a flat line on the 60fps reference and every
   * hitch spikes above it.
   */
  pushFrameTime(ms: number) {
    if (!Number.isFinite(ms) || ms <= 0 || ms > FT_SKIP_MS) return;
    this.ftBuf[this.ftHead] = ms;
    this.ftHead = (this.ftHead + 1) % FT_HISTORY;
    if (this.ftCount < FT_HISTORY) this.ftCount++;
  }

  /** Mean frametime in ms over the last `n` recorded frames (0 before the first frame). */
  private avgFrameTime(n: number) {
    const c = Math.min(n, this.ftCount);
    if (!c) return 0;
    let sum = 0;
    for (let i = 0; i < c; i++) sum += this.ftBuf[(this.ftHead - 1 - i + FT_HISTORY) % FT_HISTORY];
    return sum / c;
  }

  private px(x: number, y: number, c: string, s = 1) { this.g.fillStyle = c; this.g.fillRect(x, y, s, s); }

  private glyph(ch: string, x: number, y: number, c: string, s: number) {
    const rows = FONT[ch];
    if (!rows) return;
    for (let r = 0; r < 5; r++) for (let k = 0; k < 3; k++) if (rows[r][k] === '1') this.px(x + k * s, y + r * s, c, s);
  }

  text(str: string, x: number, y: number, c: string, s = 1, outline = true) {
    str = str.toUpperCase();
    if (outline) for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      let cx = x;
      for (const ch of str) { this.glyph(ch, cx + ox, y + oy, '#000', s); cx += 4 * s; }
    }
    let cx = x;
    for (const ch of str) { this.glyph(ch, cx, y, c, s); cx += 4 * s; }
  }

  private heart(x: number, y: number, fill: 'full' | 'half' | 'empty') {
    const g = this.g;
    // outline
    g.fillStyle = '#000';
    for (let r = 0; r < 6; r++) for (let k = 0; k < 7; k++) if (HEART[r][k] === '1') g.fillRect(x + k - 1, y + r, 3, 1), g.fillRect(x + k, y + r - 1, 1, 3);
    for (let r = 0; r < 6; r++) for (let k = 0; k < 7; k++) {
      if (HEART[r][k] !== '1') continue;
      let c = '#402020';
      if (fill === 'full' || (fill === 'half' && k < 3)) c = '#f83838';
      g.fillStyle = c;
      g.fillRect(x + k, y + r, 1, 1);
    }
    if (fill !== 'empty') { this.px(x + 1, y + 1, '#ffb0b0'); this.px(x + 2, y + 1, '#ffb0b0'); }
  }

  private frame(x: number, y: number, w: number, h: number, border: string, inner: string) {
    const g = this.g;
    g.fillStyle = '#000'; g.fillRect(x - 1, y - 1, w + 2, h + 2);
    g.fillStyle = border; g.fillRect(x, y, w, h);
    g.fillStyle = '#000'; g.fillRect(x + 2, y + 2, w - 4, h - 4);
    g.fillStyle = inner; g.fillRect(x + 3, y + 3, w - 6, h - 6);
  }

  private swordIcon(x: number, y: number) {
    const b = '#dce4f2', h = '#3557c9', o = '#f2c14e';
    for (let i = 0; i < 7; i++) this.px(x + 6 - i, y + i, b);
    this.px(x + 5, y, b); this.px(x + 6, y + 1, b);
    this.px(x + 1, y + 5, h); this.px(x + 2, y + 4, h); this.px(x + 3, y + 7, h); this.px(x + 4, y + 8, h);
    this.px(x, y + 8, o); this.px(x + 1, y + 7, o); this.px(x, y + 9, o);
  }

  private shieldIcon(x: number, y: number) {
    const rim = '#cfd7e6', blue = '#2f57c4', o = '#f2c14e';
    const rows = ['0111110', '1111111', '1111111', '1111111', '0111110', '0111110', '0011100', '0001000'];
    for (let r = 0; r < rows.length; r++) for (let k = 0; k < 7; k++) if (rows[r][k] === '1') this.px(x + k, y + r, r === 0 || k === 0 || k === 6 || r === rows.length - 1 ? rim : blue);
    this.px(x + 3, y + 2, o); this.px(x + 2, y + 3, o); this.px(x + 4, y + 3, o); this.px(x + 3, y + 3, o);
  }

  private rupeeIcon(x: number, y: number) {
    const l = '#7ef07e', m = '#38c838', d = '#1c8a1c';
    const rows = ['0110', '1111', '1111', '1111', '1111', '1111', '0110'];
    for (let r = 0; r < rows.length; r++) for (let k = 0; k < 4; k++) if (rows[r][k] === '1') this.px(x + k, y + r, k < 2 ? l : k > 2 ? d : m);
    this.g.fillStyle = '#000';
    for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) for (let r = 0; r < rows.length; r++) for (let k = 0; k < 4; k++) if (rows[r][k] === '1' && !(rows[r + oy]?.[k + ox] === '1')) this.g.fillRect(x + k + ox, y + r + oy, 1, 1);
  }

  private helmetIcon(x: number, y: number) {
    const s = '#a3adc0', d = '#15151c', e = '#ffe066';
    const rows = ['0111110', '1111111', '1111111', '1000001', '1010101', '1111111', '0111110'];
    for (let r = 0; r < rows.length; r++) for (let k = 0; k < 7; k++) {
      if (rows[r][k] === '1') this.px(x + k, y + r, s);
      else if (r === 3 || r === 4) this.px(x + k, y + r, d);
    }
    this.px(x + 2, y + 4, e); this.px(x + 4, y + 4, e);
    this.g.fillStyle = '#000';
    this.g.fillRect(x - 1, y + 1, 1, 5); this.g.fillRect(x + 7, y + 1, 1, 5); this.g.fillRect(x + 1, y - 1, 5, 1); this.g.fillRect(x + 1, y + 7, 5, 1);
  }

  /**
   * Frametime graph: one 1px column per frame (newest at the right edge) over the dotted 60/30fps reference
   * lines, plus a ~1s ms readout above it. Transparent — only the bars, the two faint reference lines and a
   * soft baseline shadow are drawn, so the world shows straight through behind them.
   */
  private drawFrameGraph() {
    const g = this.g;
    const x0 = FT_X0;
    const plotW = this.w - FT_RIGHT_GAP - x0; // the empty middle of the top row
    if (plotW < FT_MIN_W) return;             // tiny window: no room left for the graph
    if (!this.ftCount) return;                // first frame: nothing recorded yet
    const yBot = FT_PLOT_Y + FT_PLOT_H - 1;   // bottom plot row — bars grow up from here
    const rowOf = (ms: number) => yBot - Math.round(Math.min(ms, FT_MAX_MS) / FT_MAX_MS * (FT_PLOT_H - 1));

    const n = Math.min(plotW, this.ftCount);
    const start = x0 + plotW - n;
    for (let i = 0; i < n; i++) {
      const ms = this.ftBuf[(this.ftHead - n + i + FT_HISTORY) % FT_HISTORY];
      const [body, tip] = ms > FT_WARN_MAX ? FT_BAD : ms > FT_GOOD_MAX ? FT_WARN : FT_GOOD;
      const top = rowOf(ms);
      g.fillStyle = body;
      g.fillRect(start + i, top, 1, yBot - top + 1);
      g.fillStyle = tip;
      g.fillRect(start + i, top, 1, 1); // bright cap: makes 1px spikes easy to spot
    }

    // dotted 60/30fps reference lines, over the bars so the targets stay readable
    g.fillStyle = 'rgba(248,248,248,0.34)';
    for (const ms of [FT_60, FT_30]) {
      const y = rowOf(ms);
      for (let x = x0; x < x0 + plotW; x += 2) g.fillRect(x, y, 1, 1);
    }
    g.fillStyle = 'rgba(0,0,0,0.4)';
    g.fillRect(x0 - 1, yBot + 1, plotW + 2, 1); // baseline shadow, so the bars read on bright ground

    if (plotW >= FT_TEXT_W) {
      const avg = this.avgFrameTime(FT_AVG);
      this.text(`${Math.min(avg, 99.9).toFixed(1)}MS`, x0, FT_TEXT_Y, avg > FT_WARN_MAX ? FT_BAD[1] : avg > FT_GOOD_MAX ? FT_WARN[1] : '#f8f8f8');
    }
  }

  draw(s: HudState) {
    const g = this.g, W = this.w, H = this.h;
    const pad = !!s.gamepad; // gamepad: show button labels instead of key labels
    g.clearRect(0, 0, W, H);
    if (!s.dialogue && s.canTalk && Math.floor(s.time * 2) % 2 === 0) this.text(pad ? 'A - TALK' : 'E - TALK', W / 2 - 16, H - 14, '#f8f8f8');
    if (s.toast) this.text(s.toast, W / 2 - s.toast.length * 4, H / 2 - 30, '#f8d848', 2);
    // charge meter (spin attack)
    this.frame(8, 8, 12, 38, '#f0f0f0', '#101820');
    const fillH = Math.round(s.charge * 30);
    const pulse = s.charged && Math.floor(s.time * 10) % 2 === 0;
    g.fillStyle = pulse ? '#e8ffe8' : '#28d028';
    g.fillRect(11, 11 + (30 - fillH), 6, fillH);
    if (fillH > 0) { g.fillStyle = pulse ? '#ffffff' : '#88f088'; g.fillRect(11, 11 + (30 - fillH), 2, fillH); }
    // item boxes
    this.frame(26, 10, 22, 22, s.attacking ? '#ffffff' : '#f0c040', '#283048');
    this.swordIcon(33, 15);
    this.text(pad ? 'A' : 'J', 34, 34, '#f0f0f0');
    this.frame(52, 10, 22, 22, s.blocking ? '#ffffff' : '#f0c040', '#283048');
    this.shieldIcon(59, 15);
    this.text(pad ? 'B' : 'K', 60, 34, '#f0f0f0');
    // counters
    this.rupeeIcon(96, 12);
    this.text(String(s.rupees).padStart(3, '0'), 104, 12, '#f8f8f8', 2);
    this.helmetIcon(140, 12);
    this.text(String(s.kills).padStart(3, '0'), 152, 12, '#f8f8f8', 2);
    // frametime graph — the transparent strip between the counters and the life readout
    this.drawFrameGraph();
    // life — right-anchored so it keeps the same margin from the edge at any viewport width
    const lx = W - 82;
    this.text('-- LIFE --', lx, 8, '#f8f8f8');
    const hearts = MAX_HP / 2;
    for (let i = 0; i < hearts; i++) {
      const hpForHeart = s.hp - i * 2;
      const fill = hpForHeart >= 2 ? 'full' : hpForHeart === 1 ? 'half' : 'empty';
      const col = i % 8, row = Math.floor(i / 8);
      const blink = s.hp <= 2 && s.hp > 0 && Math.floor(s.time * 4) % 2 === 0 && fill !== 'empty';
      this.heart(lx - 6 + col * 9, 18 + row * 8, blink ? 'empty' : fill);
    }
  }
}
