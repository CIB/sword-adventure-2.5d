// Node-side validation of the HUD frametime graph: sample ring, rejection of bogus samples, band colours,
// plot geometry, and Thor (wide) layout. Stubs the canvas 2D context — the Hud only touches
// fillStyle/fillRect/clearRect and canvas.width/height — and inspects the recorded draw calls.
// Run: npx esbuild test/hud.test.ts --bundle --platform=node --format=esm | node --input-type=module
interface Op { style: string; x: number; y: number; w: number; h: number }

const ops: Op[] = [];
const g2d = () => ({
  imageSmoothingEnabled: false,
  fillStyle: '#000',
  clearRect() {},
  fillRect(x: number, y: number, w: number, h: number) { ops.push({ style: this.fillStyle, x, y, w, h }); },
});
const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
const ctx = g2d() as ReturnType<typeof g2d> & { canvas: unknown };
ctx.canvas = canvas;

import { Hud } from '../src/game/hud';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

/** bar bodies: 1px-wide rects that stand on the plot's bottom row, excluding tips/dots/baseline */
const barsAtBottom = (yBot: number) => ops.filter((o) => o.w === 1 && o.h > 1 && o.y + o.h - 1 === yBot);
const barAt = (x: number, yBot: number) => barsAtBottom(yBot).find((o) => o.x === x);

const state = { hp: 6, rupees: 0, kills: 0, charge: 0, charged: false, blocking: false, attacking: false, time: 0 };

// ------------------------------------------------------------------ normal (narrow) layout
{
  const W = 417, H = 235; // 1920x1080 window → HUD at vw/HUD_SCALE
  const PLOT_W = 256;      // FT_COLS: the plot is a fixed 256 columns wide at every HUD size
  const X0 = 8;
  const Y_BOT = 72; // FT_PLOT_Y(54)+FT_PLOT_H(19)-1
  const hud = new Hud(canvas);
  hud.resize(W, H, false);

  /** draw ops inside the graph's row (x 7..265, y 47..74) — nothing else of the HUD draws in there */
  const graphOps = () => ops.filter((o) => o.x >= 7 && o.x + o.w <= 265 && o.y >= 47 && o.y + o.h <= 74);

  // nothing is plotted before the first recorded frame
  ops.length = 0;
  hud.draw(state);
  check('normal: empty history draws no graph', graphOps().length === 0, `${graphOps().length} ops`);

  // one column per frame, right-aligned to the strip's last column
  ops.length = 0;
  for (let i = 0; i < 10; i++) hud.pushFrameTime(16.7);
  hud.draw(state);
  check('normal: one bar per sample', barsAtBottom(Y_BOT).length === 10, `${barsAtBottom(Y_BOT).length} bars`);
  check('normal: newest bar on the right edge', !!barAt(X0 + PLOT_W - 1, Y_BOT));

  // history saturates at the strip width: extra frames scroll off the left instead of stretching it
  ops.length = 0;
  for (let i = 0; i < 400; i++) hud.pushFrameTime(16.7);
  hud.draw(state);
  check('normal: bars capped at plot width', barsAtBottom(Y_BOT).length === PLOT_W, `${barsAtBottom(Y_BOT).length} of ${PLOT_W}`);

  // a vsync-locked 60fps (16.6-16.8ms) stays in the good band; dropped frames warn; stalls go red
  const lastBar = (ms: number) => {
    ops.length = 0;
    hud.pushFrameTime(ms);
    hud.draw(state);
    return barAt(X0 + PLOT_W - 1, Y_BOT);
  };
  const good = lastBar(16.7), warn = lastBar(25), bad = lastBar(45);
  check('normal: 16.7ms plots cyan (good)', good?.style === '#38c8f0', String(good?.style));
  check('normal: 25ms plots yellow (warn)', warn?.style === '#e8c020', String(warn?.style));
  check('normal: 45ms plots red (bad)', bad?.style === '#f04838', String(bad?.style));

  // height mapping: 50ms pegs the top plot row (15), 16.7ms sits on the 60fps line (row 30)
  check('normal: 50ms pegs the top', lastBar(50)?.y === 54, String(lastBar(50)?.y));
  check('normal: 16.7ms sits on the 60fps line', lastBar(16.7)?.y === 66, String(lastBar(16.7)?.y));

  // rAF pauses and garbage samples are dropped: the plotted pattern must not change at all
  ops.length = 0;
  hud.draw(state);
  const before = barsAtBottom(Y_BOT).map((b) => `${b.x}:${b.y}`).join(',');
  for (const ms of [4200, 0, -5, NaN, Infinity]) hud.pushFrameTime(ms);
  ops.length = 0;
  hud.draw(state);
  check('normal: bogus samples dropped', barsAtBottom(Y_BOT).map((b) => `${b.x}:${b.y}`).join(',') === before, `${barsAtBottom(Y_BOT).length} bars`);
}

// ------------------------------------------------------------------ Thor / wide layout
{
  const W = 376, H = 158; // Thor: vw~640 / HUD_SCALE_THOR 1.7
  const PLOT_W_THOR = 96;
  const X0_THOR = 184;
  const Y_BOT_THOR = 31; // 16+16-1
  const hud = new Hud(canvas);
  hud.resize(W, H, true);

  const graphOpsThor = () => ops.filter((o) => o.x >= X0_THOR - 1 && o.x <= X0_THOR + PLOT_W_THOR + 1 && o.y >= 8 && o.y <= 32);

  ops.length = 0;
  hud.draw(state);
  check('thor: empty history draws no graph', graphOpsThor().length === 0, `${graphOpsThor().length} ops`);

  ops.length = 0;
  for (let i = 0; i < 10; i++) hud.pushFrameTime(16.7);
  hud.draw(state);
  check('thor: one bar per sample', barsAtBottom(Y_BOT_THOR).length === 10, `${barsAtBottom(Y_BOT_THOR).length} bars`);
  check('thor: newest bar on right edge of short strip', !!barAt(X0_THOR + PLOT_W_THOR - 1, Y_BOT_THOR));

  ops.length = 0;
  for (let i = 0; i < 400; i++) hud.pushFrameTime(16.7);
  hud.draw(state);
  check('thor: bars capped at thor plot width', barsAtBottom(Y_BOT_THOR).length === PLOT_W_THOR, `${barsAtBottom(Y_BOT_THOR).length} of ${PLOT_W_THOR}`);

  // ensure it does NOT draw in the old below row
  const belowOps = ops.filter((o) => o.x >= 7 && o.x + o.w <= 265 && o.y >= 47 && o.y + o.h <= 74);
  check('thor: no graph in old below row', belowOps.length === 0, `${belowOps.length} ops`);

  // colour bands still work in thor mode
  const lastBarThor = (ms: number) => {
    ops.length = 0;
    hud.pushFrameTime(ms);
    hud.draw(state);
    return barAt(X0_THOR + PLOT_W_THOR - 1, Y_BOT_THOR);
  };
  const good = lastBarThor(16.7), warn = lastBarThor(25), bad = lastBarThor(45);
  check('thor: 16.7ms plots cyan', good?.style === '#38c8f0', String(good?.style));
  check('thor: 25ms plots yellow', warn?.style === '#e8c020', String(warn?.style));
  check('thor: 45ms plots red', bad?.style === '#f04838', String(bad?.style));
}

console.log(failures ? `\n${failures} FAILURES` : '\nall hud frametime checks passed');
process.exit(failures ? 1 : 0);
