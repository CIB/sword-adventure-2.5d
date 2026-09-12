/**
 * The leaf atlas: one small procedural texture holding every foliage "particle" the game draws.
 *
 * BotW builds its canopies out of many small leaf cards — a handful of leaves painted on a quad —
 * rather than one smooth blob. This is that texture: a 4×4 grid of 24px cells, each a clump of
 * leaves (broadleaf, needle, blossom) or a cluster of berries. Every card picks a cell per
 * instance, so a canopy of forty cards shows forty ragged, overlapping leaf silhouettes.
 *
 * The texel function is pure arithmetic (no canvas, no THREE), so `tools/preview-foliage.mts` can
 * rasterise the very same atlas on the CPU and show what a design will look like before it reaches
 * the GPU.
 *
 * Cells hold *value* detail, not hue: RGB is near-neutral (a whisper warm in the light, cool in the
 * shadow) and the per-instance colour supplies the species palette. Berries are the exception —
 * their red is baked in and those cards are tinted white.
 */
import * as THREE from 'three';
import { RNG } from './constants';

export const LEAF_CELL = 24;                 // px per cell
export const LEAF_GRID = 4;                  // cells per row/column
export const LEAF_TEX = LEAF_CELL * LEAF_GRID;

// cell roles (indices into the atlas)
export const CELL_BROAD = [0, 1, 2, 3];      // oak / autumn / birch / bush clumps
export const CELL_CHUNKY = [3, 0, 1];        // fewer, fatter leaves: small trees & canopy fringe
export const CELL_NEEDLE = [4, 5];           // pines
export const CELL_BLOSSOM = [6, 7];          // blossom trees
export const CELL_BERRY = 8;                 // berry bushes
export const CELL_SPRIG = 9;                 // a lone pair of leaves (silhouette breakers)

type Hue = 'leaf' | 'needle' | 'petal' | 'berry';
interface Leaflet {
  cx: number; cy: number;   // centre, in cell units (0..1, y down like the canvas)
  ang: number;              // direction the leaf points (radians)
  L: number; W: number;     // half length / half width, cell units
  exp: number;              // width taper: 0.5 = lens, 1 = pointed ellipse
  v0: number; v1: number;   // value at the base -> at the tip
  hue: Hue;
  round?: boolean;          // a round blob (berry / flower head) instead of a leaf
}

const TEXEL = 1 / LEAF_CELL;

/** Author every cell once, deterministically (the atlas must be identical between runs). */
function authorCells(): Leaflet[][] {
  const cells: Leaflet[][] = [];
  const at = (n: number) => { while (cells.length <= n) cells.push([]); return cells[n]; };

  /** A broadleaf clump: `n` leaves fanned out of a shared base near the cell's bottom. */
  const broad = (cell: number, n: number, seed: number, lenRange: [number, number], wid: number, exp: number) => {
    const rng = new RNG(seed);
    const out = at(cell);
    const bx = 0.5 + (rng.next() - 0.5) * 0.12, by = 0.74 + (rng.next() - 0.5) * 0.08;
    for (let i = 0; i < n; i++) {
      const spread = (n === 1 ? 0 : i / (n - 1) - 0.5) * (1.5 + rng.next() * 0.7);
      const ang = -Math.PI / 2 + spread + (rng.next() - 0.5) * 0.3;
      const L = rng.range(lenRange[0], lenRange[1]);
      const tone = 0.86 + rng.next() * 0.2;
      out.push({
        cx: bx + Math.cos(ang) * L * 0.42, cy: by + Math.sin(ang) * L * 0.42, ang,
        L, W: wid * (0.85 + rng.next() * 0.35), exp,
        v0: 0.58 * tone, v1: 1.0 * tone, hue: 'leaf',
      });
    }
  };
  broad(0, 6, 101, [0.26, 0.38], 0.15, 0.6);    // classic oak clump
  broad(1, 5, 202, [0.28, 0.4], 0.17, 0.45);    // rounder, fatter leaves
  broad(2, 7, 303, [0.22, 0.34], 0.125, 0.7);   // looser: the canopy fringe
  broad(3, 4, 404, [0.3, 0.42], 0.2, 0.45);     // chunky: still reads clean at 8px

  /** Needles: thin lenses radiating from a point, darker and cooler than broadleaves. */
  const needles = (cell: number, n: number, seed: number, droop: number) => {
    const rng = new RNG(seed);
    const out = at(cell);
    const bx = 0.5, by = 0.8;
    for (let i = 0; i < n; i++) {
      const spread = (i / (n - 1) - 0.5) * 2.5;
      const ang = -Math.PI / 2 + spread + (rng.next() - 0.5) * 0.25;
      const L = rng.range(0.26, 0.4);
      const tone = 0.8 + rng.next() * 0.28;
      out.push({
        cx: bx + Math.cos(ang) * L * 0.5, cy: by + Math.sin(ang) * L * 0.5 + droop * L,
        ang: ang + droop, L, W: 0.04 * (0.8 + rng.next() * 0.5), exp: 0.5,
        v0: 0.5 * tone, v1: 0.95 * tone, hue: 'needle',
      });
    }
  };
  needles(4, 13, 505, 0.06);
  needles(5, 9, 606, 0.22);

  /** Blossom: round pale leaves with a few five-petal-looking flowers on top. */
  const blossom = (cell: number, leaves: number, flowers: number, seed: number) => {
    const rng = new RNG(seed);
    const out = at(cell);
    for (let i = 0; i < leaves; i++) {
      const ang = rng.next() * Math.PI * 2;
      const L = rng.range(0.2, 0.3);
      const tone = 0.9 + rng.next() * 0.14;
      out.push({
        cx: 0.5 + Math.cos(ang) * L * 0.5, cy: 0.58 + Math.sin(ang) * L * 0.4, ang,
        L, W: L * 0.95, exp: 0.45, v0: 0.66 * tone, v1: 1.0 * tone, hue: 'petal',
      });
    }
    for (let i = 0; i < flowers; i++) {
      out.push({
        cx: 0.3 + rng.next() * 0.4, cy: 0.26 + rng.next() * 0.42, ang: rng.next() * Math.PI * 2,
        L: 0.12, W: 0.12, exp: 0.5, v0: 1, v1: 1, hue: 'petal', round: true,
      });
    }
  };
  blossom(6, 5, 2, 707);
  blossom(7, 4, 3, 808);

  /** Berries: two leaves behind four red berries with a highlight. */
  {
    const rng = new RNG(909);
    const out = at(CELL_BERRY);
    for (let i = 0; i < 2; i++) {
      const ang = -Math.PI / 2 + (i ? 0.95 : -0.95);
      out.push({
        cx: 0.5 + Math.cos(ang) * 0.14, cy: 0.64 + Math.sin(ang) * 0.14, ang,
        L: 0.26, W: 0.12, exp: 0.7, v0: 0.5, v1: 0.88, hue: 'leaf',
      });
    }
    for (let i = 0; i < 4; i++) {
      out.push({
        cx: 0.33 + (i % 2) * 0.34 + rng.next() * 0.05, cy: 0.35 + (i >> 1) * 0.28 + rng.next() * 0.05,
        ang: 0, L: 0.115, W: 0.115, exp: 0.5, v0: 1, v1: 1, hue: 'berry', round: true,
      });
    }
  }

  /** A lone pair of leaves — sticks out of the canopy edge and breaks the silhouette up. */
  {
    const rng = new RNG(1010);
    const out = at(CELL_SPRIG);
    for (let i = 0; i < 2; i++) {
      const ang = -Math.PI / 2 + (i ? 0.75 : -0.75) + (rng.next() - 0.5) * 0.2;
      const L = 0.3 + rng.next() * 0.08;
      out.push({
        cx: 0.5 + Math.cos(ang) * L * 0.45, cy: 0.64 + Math.sin(ang) * L * 0.45, ang,
        L, W: 0.145, exp: 0.7, v0: 0.6, v1: 1.0, hue: 'leaf',
      });
    }
  }
  return cells;
}

export const LEAFLETS: Leaflet[][] = authorCells();

export interface Texel { r: number; g: number; b: number; a: number }

/** Colour of one leaflet at a given value (0..1) — the atlas's whole hue story. */
function hueRgb(hue: Hue, val: number, hl: number, out: Texel) {
  if (hue === 'berry') {
    // red body, bright top-left highlight, deeper toward the rim
    const body = Math.min(1.35, 0.55 + 0.34 * val + 0.5 * hl);
    out.r = 255 * Math.min(1, body);
    out.g = 255 * Math.min(1, body * 0.3);
    out.b = 255 * Math.min(1, body * 0.24);
  } else if (hue === 'needle') {
    out.r = 255 * val * 0.88; out.g = 255 * val * 0.99; out.b = 255 * val * 0.9;
  } else if (hue === 'petal') {
    out.r = 255 * val; out.g = 255 * val * 0.97; out.b = 255 * val * 0.99;
  } else {
    out.r = 255 * val * 0.96; out.g = 255 * val; out.b = 255 * val * 0.88;
  }
}

/**
 * Sample one cell at (u,v) in cell space (0..1, v down). sRGB bytes out; the alpha carries the leaf
 * silhouette. Leaflets composite front-to-back in authoring order with a plain "over" blend, so
 * overlapping leaves layer instead of adding up to white.
 */
export function leafTexel(cell: number, u: number, v: number, out: Texel = { r: 0, g: 0, b: 0, a: 0 }): Texel {
  const list = LEAFLETS[cell] ?? LEAFLETS[0];
  let A = 0, R = 0, G = 0, B = 0;   // premultiplied accumulators
  const c: Texel = { r: 0, g: 0, b: 0, a: 0 };
  for (let i = 0; i < list.length; i++) {
    const lf = list[i];
    const du = u - lf.cx, dv = v - lf.cy;
    let a: number, val: number, hl = 0;
    if (lf.round) {
      const d = Math.hypot(du, dv);
      if (d > lf.W + TEXEL) continue;
      a = Math.min(1, Math.max(0, 0.5 + (lf.W - d) / TEXEL));
      hl = Math.max(0, 1 - Math.hypot(du + lf.W * 0.35, dv + lf.W * 0.4) / (lf.W * 0.6));
      val = 0.62 + 0.3 * (1 - d / Math.max(1e-6, lf.W));
    } else {
      const ca = Math.cos(lf.ang), sa = Math.sin(lf.ang);
      const t = du * ca + dv * sa;      // along the leaf
      const n = -du * sa + dv * ca;     // across it
      const tt = Math.abs(t) / lf.L;
      if (tt > 1 + TEXEL / lf.L) continue;
      const halfW = lf.W * Math.pow(Math.max(0, 1 - tt * tt), lf.exp);
      const dn = Math.abs(n) - halfW;
      if (dn > 0.5 * TEXEL) continue;
      a = Math.min(1, Math.max(0, 0.5 - dn / TEXEL)) * Math.min(1, Math.max(0, 0.5 - (Math.abs(t) - lf.L) / TEXEL));
      // value: dark at the base, bright at the tip, a shade darker around the rim, lit from above
      const along = 0.5 + 0.5 * (t / lf.L);
      val = lf.v0 + (lf.v1 - lf.v0) * along;
      val *= 0.84 + 0.16 * Math.min(1, Math.max(0, (halfW - Math.abs(n)) / (halfW + 1e-6)));
      val *= 0.92 + 0.08 * (1 - v);
    }
    if (a <= 0) continue;
    hueRgb(lf.hue, val, hl, c);
    const ia = 1 - a;
    R = c.r * a + R * ia; G = c.g * a + G * ia; B = c.b * a + B * ia; A = a + A * ia;
  }
  if (A <= 0) { out.r = out.g = out.b = out.a = 0; return out; }
  out.r = R / A; out.g = G / A; out.b = B / A; out.a = 255 * A;
  return out;
}

/** The whole atlas as raw RGBA (sRGB bytes) — used by the GPU texture and the CPU preview alike. */
export function leafAtlasData(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(LEAF_TEX * LEAF_TEX * 4);
  const t: Texel = { r: 0, g: 0, b: 0, a: 0 };
  for (let y = 0; y < LEAF_TEX; y++) for (let x = 0; x < LEAF_TEX; x++) {
    const col = (x / LEAF_CELL) | 0, row = (y / LEAF_CELL) | 0;
    const u = (x - col * LEAF_CELL + 0.5) / LEAF_CELL;
    // canvas rows run top-down but the shader's v runs bottom-up (flipY upload), so store v flipped:
    // a leaf authored with its stem at v=0 keeps its stem at the bottom of the card on screen
    const v = 1 - (y - row * LEAF_CELL + 0.5) / LEAF_CELL;
    leafTexel(row * LEAF_GRID + col, u, v, t);
    const i = (y * LEAF_TEX + x) * 4;
    data[i] = t.r; data[i + 1] = t.g; data[i + 2] = t.b; data[i + 3] = t.a;
  }
  return data;
}

let atlas: THREE.CanvasTexture | null = null;

/** The GPU atlas (built once, shared by every foliage material). */
export function leafAtlas(): THREE.CanvasTexture {
  if (atlas) return atlas;
  const cv = document.createElement('canvas');
  cv.width = cv.height = LEAF_TEX;
  const g = cv.getContext('2d')!;
  const img = g.createImageData(LEAF_TEX, LEAF_TEX);
  img.data.set(leafAtlasData());
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.magFilter = THREE.NearestFilter;   // magnified (a big card up close): stay chunky
  tex.minFilter = THREE.LinearFilter;    // minified (small trees): no crawling alias
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace; // authored in sRGB, sampled as linear
  atlas = tex;
  return tex;
}
