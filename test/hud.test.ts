// Node-side validation of the HUD frametime graph: sample ring, rejection of bogus samples, band colours,
// plot geometry. Stubs the canvas 2D context — the Hud only touches fillStyle/fillRect/clearRect and
// canvas.width/height — and inspects the recorded draw calls.
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

/** bar bodies: 1px-wide rects that stand on the plot's bottom row (y 37), excluding tips/dots/baseline */
const bars = () => ops.filter((o) => o.w === 1 && o.h > 1 && o.y + o.h - 1 === 37);
const barAt = (x: number) => bars().find((o) => o.x === x);

const W = 417, H = 235; // 1920x1080 window → HUD at vw/HUD_SCALE
const PLOT_W = W - 92 - 182;
const hud = new Hud(canvas);
hud.resize(W, H);
const state = { hp: 6, rupees: 0, kills: 0, charge: 0, charged: false, blocking: false, attacking: false, time: 0 };

/** draw ops inside the graph strip (x 180..327, y 6..40) — nothing else of the HUD draws in there at this width */
const graphOps = () => ops.filter((o) => o.x >= 180 && o.x + o.w <= 327 && o.y >= 6 && o.y + o.h <= 40);

// nothing is plotted before the first recorded frame
ops.length = 0;
hud.draw(state);
check('empty history draws no graph', graphOps().length === 0, `${graphOps().length} ops`);

// one column per frame, right-aligned to the strip's last column
ops.length = 0;
for (let i = 0; i < 10; i++) hud.pushFrameTime(16.7);
hud.draw(state);
check('one bar per sample', bars().length === 10, `${bars().length} bars`);
check('newest bar on the right edge', !!barAt(182 + PLOT_W - 1));

// history saturates at the strip width: extra frames scroll off the left instead of stretching it
ops.length = 0;
for (let i = 0; i < 400; i++) hud.pushFrameTime(16.7);
hud.draw(state);
check('bars capped at plot width', bars().length === PLOT_W, `${bars().length} of ${PLOT_W}`);

// a vsync-locked 60fps (16.6-16.8ms) stays in the good band; dropped frames warn; stalls go red
const lastBar = (ms: number) => {
  ops.length = 0;
  hud.pushFrameTime(ms);
  hud.draw(state);
  return barAt(182 + PLOT_W - 1);
};
const good = lastBar(16.7), warn = lastBar(25), bad = lastBar(45);
check('16.7ms plots cyan (good)', good?.style === '#38c8f0', String(good?.style));
check('25ms plots yellow (warn)', warn?.style === '#e8c020', String(warn?.style));
check('45ms plots red (bad)', bad?.style === '#f04838', String(bad?.style));

// height mapping: 50ms pegs the top plot row (15), 16.7ms sits on the 60fps line (row 30)
check('50ms pegs the top', lastBar(50)?.y === 15, String(lastBar(50)?.y));
check('16.7ms sits on the 60fps line', lastBar(16.7)?.y === 30, String(lastBar(16.7)?.y));

// rAF pauses and garbage samples are dropped: the plotted pattern must not change at all
ops.length = 0;
hud.draw(state);
const before = bars().map((b) => `${b.x}:${b.y}`).join(',');
for (const ms of [4200, 0, -5, NaN, Infinity]) hud.pushFrameTime(ms);
ops.length = 0;
hud.draw(state);
check('bogus samples dropped', bars().map((b) => `${b.x}:${b.y}`).join(',') === before, `${bars().length} bars`);

console.log(failures ? `\n${failures} FAILURES` : '\nall hud frametime checks passed');
process.exit(failures ? 1 : 0);
