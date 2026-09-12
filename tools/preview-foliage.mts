/**
 * Software preview of the foliage renderer (dev tool, like check-blend.mts).
 *
 * There is no browser in CI, so this rasterises a patch of the real map on the CPU with the SAME
 * maths the GPU uses — the oblique projection, the billboard basis, the shared gust field, the baked
 * card shading, the leaf atlas, and the game's depth-outline + 5-bit post pass — and writes a PNG.
 * It is how a foliage design gets checked before it ships.
 *
 *   node tools/preview-foliage.mts --scene grove --time 3 --out .preview/grove.png
 *
 * Scenes: grove | forest | pines | bushes | orchard | village | meadow
 * Options: --at X,Z  --angle DEG  --size WxH  --time T  --zoom N  --wind 0|1  --out PATH
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname } from 'node:path';
import { World } from '../src/game/world';
import { crownCards, tintFor, foliageDryCell, isBerryBush, type TreeKind } from '../src/game/foliage';
import { leafTexel, LEAF_GRID, LEAF_CELL, LEAF_TEX } from '../src/game/leaftex';
import { hash2, SHEAR, PX_PER_TILE, clamp } from '../src/game/constants';

// ------------------------------------------------------------------ args
const argv = process.argv.slice(2);
const arg = (name: string, dflt: string) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const scene = arg('scene', 'grove');
const time = parseFloat(arg('time', '2.5'));
const angleDeg = parseFloat(arg('angle', '0'));
const [sizeW, sizeH] = arg('size', '320x240').split('x').map(Number);
const zoom = parseFloat(arg('zoom', '1'));
const pxOverride = parseFloat(arg('px', String(PX_PER_TILE)));
const windOn = arg('wind', '1') !== '0';
const outPath = arg('out', `.preview/foliage-${scene}.png`);

const SCENES: Record<string, { at: [number, number]; r: number; label: string }> = {
  grove: { at: [90, 20], r: 9, label: 'Willowmere Woods (oak + autumn)' },
  forest: { at: [4, 4], r: 8, label: 'border forest (small trees, dense)' },
  pines: { at: [180, 30], r: 9, label: 'Amber Highland pines' },
  bushes: { at: [44, 33], r: 7, label: 'bush clusters east of the village' },
  orchard: { at: [14, 111], r: 7, label: 'hermit orchard (blossom)' },
  village: { at: [16, 14], r: 9, label: 'village edge' },
  meadow: { at: [60, 60], r: 9, label: 'open meadow / birch' },
};
const sc = SCENES[scene] ?? SCENES.grove;
const [camX, camZ] = argv.includes('--at') ? arg('at', '').split(',').map(Number) : sc.at;

// ------------------------------------------------------------------ projection
const viewAngle = angleDeg * Math.PI / 180;
const CA = Math.cos(viewAngle), SA = Math.sin(viewAngle);
const RIGHT: [number, number, number] = [CA, 0, -SA];              // screen +x, world units
const UPQ: [number, number, number] = [-SA, SHEAR, -CA];           // screen +y per world unit
const D2 = 1 + SHEAR * SHEAR;
const W = Math.round(sizeW / zoom), H = Math.round(sizeH / zoom);
const PX = pxOverride;

const world = new World();
const camY = world.drawnGroundY(camX, camZ);

/** world -> screen px (y down) + view depth (larger = farther, exactly like the post pass) */
function project(x: number, y: number, z: number): [number, number, number] {
  const dx = x - camX, dy = y - camY, dz = z - camZ;
  const sx = W / 2 + (dx * RIGHT[0] + dz * RIGHT[2]) * PX;
  const sy = H / 2 - (dx * UPQ[0] + dy * UPQ[1] + dz * UPQ[2]) * PX;
  return [sx, sy, camY + 40 - y];
}

// ------------------------------------------------------------------ wind (mirror of wind.ts + the shaders)
const WIND_TEX = 64, WIND_GRID = 16;
const windLattice = (() => {
  const a = new Float32Array(WIND_TEX * WIND_TEX);
  const h = (x: number, z: number) => hash2(((x % WIND_GRID) + WIND_GRID) % WIND_GRID, ((z % WIND_GRID) + WIND_GRID) % WIND_GRID, 77);
  for (let y = 0; y < WIND_TEX; y++) for (let x = 0; x < WIND_TEX; x++) {
    const gx = x / WIND_TEX * WIND_GRID, gz = y / WIND_TEX * WIND_GRID;
    const x0 = Math.floor(gx), z0 = Math.floor(gz);
    let fx = gx - x0, fz = gz - z0;
    fx = fx * fx * (3 - 2 * fx); fz = fz * fz * (3 - 2 * fz);
    a[y * WIND_TEX + x] = (h(x0, z0) * (1 - fx) + h(x0 + 1, z0) * fx) * (1 - fz) + (h(x0, z0 + 1) * (1 - fx) + h(x0 + 1, z0 + 1) * fx) * fz;
  }
  return a;
})();
const WIND_SCALE = 13, CANOPY_SCALE = 34, GUST = 0.34, LEAN = 0.16;
const WDIR = (() => { const l = Math.hypot(1, 0.35); return [1 / l, 0.35 / l] as [number, number]; })();
const CANOPY_GUST = 1.5, CANOPY_SWAY = 0.13, FLUTTER = 0.075;
const AMBIENT = 0.6, SUN = 0.42;

function gustAt(x: number, z: number, scale: number, t: number): number {
  let u = x / scale + WDIR[0] * (t * 0.13), v = z / scale + WDIR[1] * (t * 0.13);
  u = ((u % 1) + 1) % 1; v = ((v % 1) + 1) % 1;
  const gx = u * WIND_TEX, gz = v * WIND_TEX;
  const x0 = Math.floor(gx) % WIND_TEX, z0 = Math.floor(gz) % WIND_TEX;
  const x1 = (x0 + 1) % WIND_TEX, z1 = (z0 + 1) % WIND_TEX;
  const fx = gx - Math.floor(gx), fz = gz - Math.floor(gz);
  const s = (a: number, b: number) => windLattice[b * WIND_TEX + a];
  return (s(x0, z0) * (1 - fx) + s(x1, z0) * fx) * (1 - fz) + (s(x0, z1) * (1 - fx) + s(x1, z1) * fx) * fz;
}

// ------------------------------------------------------------------ colour helpers
const s2l = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const l2s = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(0, c), 1 / 2.4) - 0.055);
/** sRGB string -> linear [r,g,b]; the world hands out rgb() strings, the palette hex strings. */
const hex2lin = (css: string): [number, number, number] => {
  let r: number, g: number, b: number;
  if (css.startsWith('#')) {
    const n = parseInt(css.slice(1), 16);
    r = ((n >> 16) & 255) / 255; g = ((n >> 8) & 255) / 255; b = (n & 255) / 255;
  } else {
    const m = css.match(/\d+/g)!.map(Number);
    r = m[0] / 255; g = m[1] / 255; b = m[2] / 255;
  }
  return [s2l(r), s2l(g), s2l(b)];
};
/** the game's toon ramp (models.getGradientMap) */
const RAMP = [0.22, 0.38, 0.58, 0.78, 1.0];
const ramp = (x: number) => RAMP[clamp(Math.round(x * (RAMP.length - 1)), 0, RAMP.length - 1)];

// ------------------------------------------------------------------ frame buffers
const rgb = new Float32Array(W * H * 3);   // linear
const depth = new Float32Array(W * H);     // view depth (far = big)
function clear() {
  for (let i = 0; i < W * H; i++) { depth[i] = 200; }
}
function put(x: number, y: number, r: number, g: number, b: number, d: number) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = y * W + x;
  if (d >= depth[i]) return;
  depth[i] = d;
  rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
}

// ------------------------------------------------------------------ ground backdrop
function drawGround() {
  const mix = (world as unknown as { mixColors: (x: number, z: number) => { grass: string; grassL: string; grassD: string } });
  const step = 1 / PX;   // one pixel at a time, inverted through the flat ground plane
  for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
    // screen -> world on the plane y = camY (good enough as a backdrop; tiles are nearly flat)
    const sxw = (px - W / 2) / PX, syw = -(py - H / 2) / PX;
    // syw = dz*UPQ[2] + dx*UPQ[0] (dy = 0) and sxw = dx*RIGHT[0] + dz*RIGHT[2]
    const det = RIGHT[0] * UPQ[2] - RIGHT[2] * UPQ[0];
    const dx = (sxw * UPQ[2] - syw * RIGHT[2]) / det, dz = (RIGHT[0] * syw - UPQ[0] * sxw) / det;
    const wx = camX + dx, wz = camZ + dz;
    void step;
    const tx = Math.floor(wx), tz = Math.floor(wz);
    const gy = world.drawnGroundY(wx, wz);
    const c = mix.mixColors(tx, tz);
    const h = hash2(tx * 4 + Math.floor((wx - tx) * 4), tz * 4 + Math.floor((wz - tz) * 4), 3);
    const col = h > 0.82 ? c.grassL : h < 0.16 ? c.grassD : c.grass;
    const [r, g, b] = hex2lin(col);
    // the ground is lit by the same toon ramp (flat = mostly the mid band)
    const shade = (1.15 + 2.05 * ramp(0.62)) / Math.PI;
    put(px, py, r * shade, g * shade, b * shade, camY + 40 - gy);
  }
}

// ------------------------------------------------------------------ plants
interface Card3 { x: number; y: number; z: number; s: number; roll: number; bend: number; ao: number; cell: number; phase: number; col: [number, number, number] }

function drawCard(c: Card3, t: number) {
  let x = c.x, y = c.y, z = c.z, roll = c.roll, size = c.s;
  const bend = windOn ? c.bend : 0;
  if (windOn) {
    const g = gustAt(x, z, CANOPY_SCALE, t);
    let ox = WDIR[0] * ((g - 0.42) * GUST + LEAN) * CANOPY_GUST * bend;
    let oz = WDIR[1] * ((g - 0.42) * GUST + LEAN) * CANOPY_GUST * bend;
    ox += Math.sin(t * 1.15 + c.phase * 0.7 + z * 0.32) * CANOPY_SWAY * bend;
    oz += Math.cos(t * 0.93 + c.phase * 1.1 + x * 0.28) * CANOPY_SWAY * bend;
    x += ox; z += oz;
    y -= Math.hypot(ox, oz) * 0.3;
    const fl = Math.sin(t * 2.7 + c.phase) * FLUTTER * (0.3 + bend);
    roll += fl; size *= 1 + fl * 0.1;
  }
  const [sx, sy, d] = project(x, y, z);
  const g = windOn ? gustAt(c.x, c.z, CANOPY_SCALE, t) : 0.42;
  const qv = c.phase * 2.399 - Math.floor(c.phase * 2.399);
  const band = qv > 0.7 ? 1.0 : qv > 0.4 ? 0.78 : 0.58;
  const shade = (AMBIENT + SUN * band) * (0.9 + 0.1 * c.ao) * (1 + g * 0.2 * bend);
  const half = size * PX / 2;
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const rad = Math.ceil(half * 1.02);
  const col = Math.floor(sx), row = Math.floor(sy);
  const tex = { r: 0, g: 0, b: 0, a: 0 };
  for (let py = row - rad; py <= row + rad; py++) for (let px = col - rad; px <= col + rad; px++) {
    // screen -> card space (undo the roll), in [-0.5, 0.5]
    const dx = (px + 0.5 - sx) / PX / size, dy = -(py + 0.5 - sy) / PX / size;
    const qx = dx * cr + dy * sr, qy = -dx * sr + dy * cr;
    if (Math.abs(qx) > 0.5 || Math.abs(qy) > 0.5) continue;
    const u = qx + 0.5, v = qy + 0.5;
    // atlas cell (flipY, exactly like the shader's vUv)
    const ccx = c.cell % LEAF_GRID, ccy = (LEAF_GRID - 1) - Math.floor(c.cell / LEAF_GRID);
    const ax = (ccx + u) * LEAF_CELL, ay = (ccy + (1 - v)) * LEAF_CELL;
    const tx0 = clamp(Math.floor(ax), 0, LEAF_TEX - 1), ty0 = clamp(Math.floor(ay), 0, LEAF_TEX - 1);
    leafTexel(c.cell, (tx0 - ccx * LEAF_CELL + 0.5) / LEAF_CELL, (ty0 - ccy * LEAF_CELL + 0.5) / LEAF_CELL, tex);
    if (tex.a < 128) continue;
    const [tr, tg, tb] = [s2l(tex.r / 255), s2l(tex.g / 255), s2l(tex.b / 255)];
    put(px, py, c.col[0] * tr * shade, c.col[1] * tg * shade, c.col[2] * tb * shade, d);
  }
}

/** The trunk, as the toon-lit cylinder it is (silhouette + ramp shading). */
function drawTrunk(x: number, gy: number, z: number, h: number, r: number, col: [number, number, number], yawShift: number) {
  const [sx, syBase] = project(x, gy, z);
  const [, syTop, dTop] = project(x, gy + h, z);
  const wpx = Math.max(1, r * PX);
  const y0 = Math.floor(Math.min(syTop, syBase)), y1 = Math.ceil(Math.max(syTop, syBase));
  for (let py = y0; py <= y1; py++) {
    const f = (syBase - py) / Math.max(1e-6, syBase - syTop);
    const yy = gy + h * clamp(f, 0, 1);
    const d = camY + 40 - yy;
    const taper = 1 - 0.45 * clamp(f, 0, 1);
    for (let px = Math.floor(sx - wpx * taper); px <= Math.ceil(sx + wpx * taper); px++) {
      const t = (px + 0.5 - sx) / Math.max(1e-6, wpx * taper);
      if (Math.abs(t) > 1) continue;
      // light comes from (-0.15, 1, 0.42): at yaw 0 that is the left of the screen
      const ndl = clamp(0.5 - 0.55 * t * Math.cos(yawShift) + 0.2 * Math.sin(yawShift), 0, 1);
      const shade = (1.15 + 2.05 * ramp(ndl)) / Math.PI;
      put(px, py, col[0] * shade, col[1] * shade, col[2] * shade, d);
    }
  }
  void dTop;
}

function drawShadow(x: number, gy: number, z: number, rx: number, rz: number) {
  const [sx, sy, d] = project(x, gy + 0.02, z);
  const rxp = rx * PX, ryp = rz * PX * Math.hypot(UPQ[0], UPQ[1], UPQ[2]);
  for (let py = Math.floor(sy - ryp); py <= Math.ceil(sy + ryp); py++) for (let px = Math.floor(sx - rxp); px <= Math.ceil(sx + rxp); px++) {
    const nx = (px + 0.5 - sx) / rxp, ny = (py + 0.5 - sy) / Math.max(1e-6, ryp);
    if (nx * nx + ny * ny > 1) continue;
    if (px < 0 || py < 0 || px >= W || py >= H) continue;
    const i = py * W + px;
    if (d >= depth[i]) continue;   // shadows only fall on ground already drawn
    rgb[i * 3] *= 0.68; rgb[i * 3 + 1] *= 0.68; rgb[i * 3 + 2] *= 0.68;
  }
}

// ------------------------------------------------------------------ gather the plants in view
const cards: Card3[] = [];
const trunks: (() => void)[] = [];
const shadows: (() => void)[] = [];
const dryCache = new Map<number, number>();

const pushPlant = (kind: TreeKind | 'bush', x: number, z: number, gy: number, scale: number, variant: number, berry: boolean) => {
  const layout = crownCards(kind, kind !== 'bush' && scale < 0.8, variant, berry);
  const yaw = hash2(Math.floor(x * 8), Math.floor(z * 8), 6) * Math.PI * 2;
  const shift = hash2(Math.floor(x), Math.floor(z), 7) * 2 - 1;
  const dry = foliageDryCell(world, x, z, dryCache);   // same memoised grid the game builds with
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  for (const c of layout) {
    const col = tintFor(kind, c.tone, shift, dry);
    cards.push({
      x: x + (c.x * cy - c.z * sy) * scale, y: gy + c.y * scale, z: z + (c.x * sy + c.z * cy) * scale,
      s: c.s * scale, roll: c.roll, bend: c.bend, ao: c.ao, cell: c.cell, phase: c.phase,
      col: [col.r, col.g, col.b],
    });
  }
  if (kind !== 'bush') {
    const sp = { oak: [1, 1, '#6b4226'], autumn: [1, 1, '#5e3c22'], birch: [0.68, 1.5, '#e6ded0'], blossom: [0.95, 1, '#7a5236'], pine: [0.8, 1.45, '#5d3a20'] }[kind as TreeKind] as [number, number, string];
    const tc = hex2lin(sp[2]);
    trunks.push(() => drawTrunk(x, gy, z, 1.0 * scale * sp[1], 0.2 * scale * sp[0], tc, yaw));
  }
  const sr = (kind === 'bush' ? 0.44 : { oak: 1.2, autumn: 1.2, birch: 0.85, blossom: 1.1, pine: 1.0 }[kind as TreeKind]) * scale;
  shadows.push(() => drawShadow(x, gy, z + sr * 0.12, sr, sr * 0.78));
};

for (const t of world.trees) {
  if (Math.hypot(t.x - camX, t.z - camZ) > sc.r + 3) continue;
  const kind = t.kind ?? 'oak';
  pushPlant(kind, t.x, t.z, t.y ?? world.drawnGroundY(t.x, t.z), t.scale, Math.floor(hash2(Math.floor(t.x * 4), Math.floor(t.z * 4), 5) * 3), false);
}
for (const b of world.bushes) {
  const x = b.tx + 0.5, z = b.tz + 0.5;
  if (Math.hypot(x - camX, z - camZ) > sc.r + 2) continue;
  const h = hash2(b.tx, b.tz, 11);
  pushPlant('bush', x + (hash2(b.tx, b.tz, 13) - 0.5) * 0.22, z + (hash2(b.tx, b.tz, 14) - 0.5) * 0.22,
    world.drawnGroundY(x, z), 0.88 + h * 0.26, Math.floor(hash2(b.tx, b.tz, 9) * 3), isBerryBush(b.tx, b.tz));
}

// ------------------------------------------------------------------ render
clear();
drawGround();
for (const s of shadows) s();
for (const t of trunks) t();
// cards sorted far -> near: the depth test does the rest, exactly like the GPU
cards.sort((a, b) => a.y - b.y);
for (const c of cards) drawCard(c, time);

// ------------------------------------------------------------------ post pass (game.ts POST_FS)
const out = new Uint8Array(W * H * 4);
for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
  const i = py * W + px;
  let r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
  const d = depth[i];
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? d : depth[y * W + x]);
  const edge = Math.max(at(px - 1, py) - d, at(px + 1, py) - d, at(px, py - 1) - d, at(px, py + 1) - d);
  if (edge > 0.16) { r *= 0.1; g *= 0.1; b *= 0.1; }
  const q = (c: number) => Math.floor(clamp(l2s(c), 0, 1) * 31 + 0.5) / 31;
  out[i * 4] = Math.round(q(r) * 255);
  out[i * 4 + 1] = Math.round(q(g) * 255);
  out[i * 4 + 2] = Math.round(q(b) * 255);
  out[i * 4 + 3] = 255;
}

// ------------------------------------------------------------------ png
function crc32(buf: Buffer): number {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function writePng(path: string, w: number, h: number, rgba: Uint8Array) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    raw.set(Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4), y * (w * 4 + 1) + 1);
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, png);
}
writePng(outPath, W, H, out);

// ------------------------------------------------------------------ report
let treesInView = 0, bushesInView = 0;
for (const t of world.trees) if (Math.hypot(t.x - camX, t.z - camZ) < sc.r) treesInView++;
for (const b of world.bushes) if (Math.hypot(b.tx + 0.5 - camX, b.tz + 0.5 - camZ) < sc.r) bushesInView++;
console.log(`scene: ${sc.label}`);
console.log(`  camera ${camX.toFixed(1)},${camZ.toFixed(1)} yaw ${angleDeg}°  ${W}x${H}px  t=${time}s wind=${windOn ? 'on' : 'off'}`);
console.log(`  plants in view: ${treesInView} trees, ${bushesInView} bushes -> ${cards.length} leaf cards (${cards.length * 2} triangles), ${trunks.length} trunks`);
console.log(`  wrote ${outPath}`);
