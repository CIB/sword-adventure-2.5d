/**
 * Breath of the Wild-style trees and bushes: canopies built out of leaf *cards* instead of blobs.
 *
 * The old renderer drew every tree as five merged spheres (≈840 triangles) and every bush as a
 * Group of five spheres and a cylinder — six draw calls each, all of it submitted every frame no
 * matter how far away it was (3123 trees ≈ 2.6M triangles). It also read as smooth plastic: one
 * silhouette per tree, no wind, no interior.
 *
 * BotW does the opposite. A canopy is a cloud of small leaf cards — a quad carrying a handful of
 * painted leaves — scattered through the crown volume, each one catching the wind on its own. That
 * is what this file builds, with the same trick that makes the grass affordable:
 *
 *  - ONE quad (2 triangles) per leaf card, instanced. A big oak is ~34 cards = 68 triangles, so the
 *    whole map's foliage is ~130k triangles instead of 2.6M, and only the chunks near the camera
 *    are ever uploaded.
 *  - Cards are *billboards*, but billboards for THIS projection: `uRight`/`uUp` (see wind.ts) are
 *    the exact world-space screen axes of the sheared orthographic camera, so a card is always
 *    square on screen and never collapses to a sliver as the view turns in 45° steps.
 *  - One shared wind field (wind.ts) drives grass, canopies, bushes and ferns. Cards read it at
 *    `uCanopyScale` — a coarser feature size than grass — so a whole tree sways as one body while
 *    each card flutters on its own phase. Gusts brighten the crown as they roll through, exactly
 *    like the grass shimmer.
 *  - Shading is baked, not lit: each card carries a species palette tone picked from how deep in
 *    the crown it sits (dark interior → sunlit top) plus a quantised toon band, so a canopy reads
 *    as a mosaic of green shades without a single normal vector.
 *  - Cutting a bush stamps its cards with a timestamp and they detach, tumble and fade in the
 *    vertex shader — the same language the cut grass tufts use.
 *
 * Per-instance data:
 *   aData0 = (anchor.x, anchor.y, anchor.z, cardSize)
 *   aData1 = (roll, phase, bend, ao)
 *   aData2 = (tint.r, tint.g, tint.b, atlasCell)   tint is linear; cell is a small integer
 *   aCut   = game time the bush was cut (-1 while standing; trees are never cut)
 *
 * Trees and bushes share one instanced geometry per chunk, so a chunk is exactly three draw calls:
 * leaf cards, trunks, shadows — whatever the species mix inside it.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, hash2, MAP_W, MAP_H, RNG } from './constants';
import type { World, TreeSpec } from './world';
import {
  vegUniforms, windTexture, setWindTime, setWindView, WIND_GLSL, swayMaterial,
} from './wind';
import {
  leafAtlas, LEAF_GRID, LEAF_CELL, CELL_BROAD, CELL_CHUNKY, CELL_NEEDLE, CELL_BLOSSOM, CELL_BERRY, CELL_SPRIG,
} from './leaftex';
import { shadowMaterial, getGradientMap } from './models';

export type TreeKind = 'oak' | 'pine' | 'autumn' | 'birch' | 'blossom';
export const TREE_KINDS: TreeKind[] = ['oak', 'pine', 'autumn', 'birch', 'blossom'];

export const FOLIAGE_CHUNK = 16;    // tiles per chunk side (same grid as the grass)
const BUILD_PER_FRAME = 3;          // chunk budget per frame
const BUILD_MS_BUDGET = 2;          // ... and a wall-clock ceiling: a dense-forest chunk must not hitch
const MAX_CARDS_PER_CHUNK = 9000;   // the dense border forest is the worst case; caps build hitches
export const BUSH_FLY = 0.8;        // seconds a cut bush's leaves are airborne
const BIG_SCALE = 0.85;             // small trees are 0.6 of a big one: sway less in world units

// ------------------------------------------------------------------ species
/** One leaf card: local to the plant's base, in world units at scale 1. */
export interface LeafCard {
  x: number; y: number; z: number;
  s: number;      // card size (world units == screen units)
  roll: number;   // screen-space roll
  bend: number;   // wind weight: 0 = nailed to the trunk, 1 = out on a twig
  ao: number;     // 0..1 self-shadowing (deep inside / low down = darker)
  tone: number;   // 0..1 position in the species palette
  cell: number;   // leaf atlas cell
  phase: number;  // flutter phase
}

interface Species {
  pal: [string, string, string, string]; // sRGB, deep shade -> sunlit
  cells: number[];
  shape: 'blob' | 'pine';
  cy: number;                            // crown centre height
  rx: number; ry: number; rz: number;    // crown radii
  bottom: number;                        // nothing grows below this (a canopy has a flat underside)
  lobes?: [number, number, number, number][];
  cards: number; cardsSmall: number;
  size: [number, number]; sizeSmall: [number, number];
  trunk: { sx: number; sy: number; color: string };
  shadowR: number;
  sway: number;                          // species stiffness (birches whip, pines barely move)
  fringe?: number;                       // the lone-leaf cell used out on the silhouette edge
  /** tiers for pines: [baseY, radius, height] */
  tiers?: [number, number, number][];
}

const SPECIES: Record<TreeKind, Species> = {
  oak: {
    pal: ['#3a7a37', '#4d9a42', '#68b851', '#93d266'],
    cells: CELL_BROAD, shape: 'blob',
    cy: 1.16, rx: 1.32, ry: 0.72, rz: 1.12, bottom: 0.36,
    lobes: [[-0.62, 1.42, -0.1, 0.52], [0.62, 1.42, -0.1, 0.52], [0.05, 1.6, 0.28, 0.5], [0.05, 1.5, -0.4, 0.46]],
    cards: 44, cardsSmall: 26, size: [0.58, 0.9], sizeSmall: [0.46, 0.7],
    trunk: { sx: 1, sy: 1, color: '#6b4226' }, shadowR: 1.2, sway: 1.0,
  },
  autumn: {
    pal: ['#9a5422', '#c4732a', '#e09634', '#f2c054'],
    cells: CELL_BROAD, shape: 'blob',
    cy: 1.16, rx: 1.3, ry: 0.74, rz: 1.1, bottom: 0.36,
    lobes: [[-0.6, 1.44, -0.12, 0.52], [0.6, 1.4, -0.08, 0.5], [0.0, 1.62, 0.24, 0.48]],
    cards: 44, cardsSmall: 26, size: [0.58, 0.92], sizeSmall: [0.46, 0.72],
    trunk: { sx: 1, sy: 1, color: '#5e3c22' }, shadowR: 1.2, sway: 1.1,
  },
  birch: {
    pal: ['#5f8a38', '#7fa845', '#a0c557', '#c6df7e'],
    cells: CELL_CHUNKY, shape: 'blob',
    cy: 1.52, rx: 0.86, ry: 0.86, rz: 0.78, bottom: 0.66,
    lobes: [[-0.34, 1.94, 0.06, 0.4], [0.36, 1.86, -0.1, 0.38]],
    cards: 38, cardsSmall: 24, size: [0.46, 0.7], sizeSmall: [0.4, 0.6],
    trunk: { sx: 0.68, sy: 1.5, color: '#e6ded0' }, shadowR: 0.85, sway: 1.35,
  },
  blossom: {
    pal: ['#aa5c82', '#cb7ba2', '#e59cbd', '#f8cade'],
    cells: [...CELL_BLOSSOM, CELL_BROAD[1]], shape: 'blob',
    fringe: CELL_BLOSSOM[0],
    cy: 1.2, rx: 1.18, ry: 0.72, rz: 1.02, bottom: 0.4,
    lobes: [[-0.56, 1.44, 0.0, 0.48], [0.56, 1.4, 0.04, 0.46], [0.0, 1.58, -0.3, 0.44]],
    cards: 52, cardsSmall: 30, size: [0.54, 0.84], sizeSmall: [0.46, 0.68],
    trunk: { sx: 0.95, sy: 1.0, color: '#7a5236' }, shadowR: 1.1, sway: 1.0,
  },
  pine: {
    pal: ['#2b5c41', '#38794f', '#4a9560', '#67b277'],
    cells: CELL_NEEDLE, shape: 'pine',
    fringe: CELL_NEEDLE[1],
    cy: 1.9, rx: 1.0, ry: 1.3, rz: 1.0, bottom: 0.7,
    tiers: [[0.58, 1.04, 1.56], [1.42, 0.8, 1.36], [2.1, 0.56, 1.16]],
    cards: 56, cardsSmall: 32, size: [0.6, 0.88], sizeSmall: [0.52, 0.76],
    trunk: { sx: 0.8, sy: 1.3, color: '#4a2f1c' }, shadowR: 1.0, sway: 0.72,
  },
};

const BUSH_SPECIES: Species = {
  pal: ['#336534', '#458340', '#5ba04a', '#7fbd5a'],
  cells: CELL_CHUNKY, shape: 'blob',
  cy: 0.36, rx: 0.4, ry: 0.3, rz: 0.37, bottom: 0.05,
  cards: 26, cardsSmall: 26, size: [0.26, 0.4], sizeSmall: [0.26, 0.4],
  fringe: CELL_CHUNKY[0],
  trunk: { sx: 1, sy: 1, color: '#4a3018' }, shadowR: 0.44, sway: 1.5,
};
/** berry bushes: ~20% of them, a red fleck in the undergrowth (same rule the game always used) */
export const isBerryBush = (tx: number, tz: number) => (tx * 31 + tz * 17) % 5 === 0;

// ------------------------------------------------------------------ layout (pure, cached)
const layoutCache = new Map<string, LeafCard[]>();

/** Deterministic 0..1 stream for a layout (one RNG per archetype, so builds stay cheap). */
function rngFor(seed: number) { return new RNG(seed >>> 0); }

function pick<T>(rng: RNG, arr: T[]): T { return arr[Math.floor(rng.next() * arr.length)]; }

/** How far a point is from the crown's heart, 0 = centre, 1 = surface (drives shade and sway). */
function radial(sp: Species, x: number, y: number, z: number): number {
  const dx = x / sp.rx, dy = (y - sp.cy) / sp.ry, dz = z / sp.rz;
  return clamp(Math.sqrt(dx * dx + dy * dy + dz * dz), 0, 1.4);
}

/** Finish a card: shade, sway weight, palette tone and atlas cell from where it sits in the crown. */
function finish(sp: Species, c: LeafCard, rng: RNG): LeafCard {
  const r = radial(sp, c.x, c.y, c.z);
  const hN = clamp((c.y - sp.cy) / sp.ry * 0.5 + 0.5, 0, 1);   // 0 = underside, 1 = crown top
  c.ao = clamp(0.55 + 0.34 * Math.min(1, r) + 0.18 * hN, 0, 1);
  c.bend = clamp((0.2 + 0.5 * Math.min(1, r) + 0.4 * hN) * sp.sway, 0, 1.3);
  // Seen from this camera a crown is a dome: the sunlit face is the middle of the disc, the rim
  // curves away into shade. That gradient (plus the depth shade) is what makes a card cloud read as
  // a rounded tree top instead of a flat scatter, so the tone leans hard on `dome`.
  const domeN = sp.shape === 'pine'
    ? clamp((c.y - sp.bottom) / Math.max(0.1, sp.cy * 2 - sp.bottom), 0, 1)  // tier tops catch the sun
    : 1 - clamp(Math.hypot(c.x / sp.rx, c.z / sp.rz), 0, 1);                 // crown disc: lit middle
  c.tone = clamp(0.58 * c.ao + 0.22 * domeN + 0.08 * hN + 0.08 + (rng.next() - 0.5) * 0.32, 0, 1);
  // cards out on the fringe often get a lone-sprig cell: that is what breaks the silhouette up
  c.cell = r > 0.82 && rng.next() < 0.22 ? (sp.fringe ?? CELL_SPRIG) : pick(rng, sp.cells);
  return c;
}

/** A broadleaf crown: cards scattered through an ellipsoid (plus its lobes), hugging the surface. */
function blobCards(sp: Species, count: number, rng: RNG): LeafCard[] {
  const out: LeafCard[] = [];
  for (let i = 0; i < count; i++) {
    // a direction on the sphere, biased upward: crowns are fuller on top than underneath
    const a = rng.next() * Math.PI * 2;
    let dy = rng.next() * 2 - 1;
    dy = clamp(dy * 0.75 + 0.25, -1, 1);
    const flat = Math.sqrt(Math.max(0, 1 - dy * dy));
    const dx = Math.cos(a) * flat, dz = Math.sin(a) * flat;
    // shell-biased radius: most cards sit on the surface, a few fill the interior so the crown
    // never goes see-through. Every fifth card caps the top: from above, that is the middle of the
    // disc, and without it crowns get a hole in the head.
    const topCap = i % 5 === 4;
    if (topCap) { dy = 0.68 + rng.next() * 0.32; }
    const r = topCap ? 0.78 + rng.next() * 0.22 : 0.4 + 0.6 * Math.pow(rng.next(), 0.62);
    let x = dx * sp.rx * r, y = dy * sp.ry * r + sp.cy, z = dz * sp.rz * r;
    if (sp.lobes && rng.next() < 0.34) {
      const [lx, ly, lz, lr] = pick(rng, sp.lobes);
      const rr = lr * (0.55 + 0.45 * rng.next());
      x = lx + dx * rr; y = ly + dy * rr * 0.9; z = lz + dz * rr;
    }
    if (y < sp.bottom) y = sp.bottom + rng.next() * 0.08;   // a canopy's underside is flat-ish
    const [s0, s1] = sp.size;
    out.push(finish(sp, {
      x, y, z,
      s: (s0 + rng.next() * (s1 - s0)) * (1 + 0.28 * (1 - Math.min(1, r))), // interior cards are fatter: they plug gaps
      roll: rng.next() * Math.PI * 2,
      bend: 0, ao: 0, tone: 0, cell: 0, phase: rng.next() * Math.PI * 2,
    }, rng));
  }
  return out;
}

/** A conifer: skirts of cards wrapped around each tier's cone, plus a few at the apex. */
function pineCards(sp: Species, count: number, rng: RNG): LeafCard[] {
  const out: LeafCard[] = [];
  const tiers = sp.tiers!;
  const weights = tiers.map(([, r, h]) => r * h);
  const total = weights.reduce((a, b) => a + b, 0);
  let placed = 0;
  tiers.forEach(([y0, rad, h], ti) => {
    const n = ti === tiers.length - 1 ? count - placed : Math.round(count * weights[ti] / total);
    placed += n;
    for (let i = 0; i < n; i++) {
      const a = rng.next() * Math.PI * 2;
      const ty = Math.pow(rng.next(), 0.8);              // 0 at the skirt hem, 1 at the tier top
      const rr = rad * (1 - ty * 0.86) * (0.7 + rng.next() * 0.35);
      const y = y0 + ty * h - (rr / rad) * 0.12;         // the hem droops
      const [s0, s1] = sp.size;
      out.push(finish(sp, {
        x: Math.cos(a) * rr, y, z: Math.sin(a) * rr,
        s: (s0 + rng.next() * (s1 - s0)) * (1.1 - ty * 0.25),
        roll: rng.next() * Math.PI * 2,
        bend: 0, ao: 0, tone: 0, cell: 0, phase: rng.next() * Math.PI * 2,
      }, rng));
    }
  });
  return out;
}

/**
 * The card cloud of one plant, in its own local space. Cached per (species, size class, variant):
 * every tree of a kind reuses one of three hand-rolled layouts, so building a chunk is just a
 * rotate-and-copy of arrays that already exist.
 */
export function crownCards(kind: TreeKind | 'bush', small: boolean, variant: number, berry = false): LeafCard[] {
  const key = `${kind}|${small ? 1 : 0}|${variant}|${berry ? 1 : 0}`;
  const hit = layoutCache.get(key);
  if (hit) return hit;
  const sp = kind === 'bush' ? BUSH_SPECIES : SPECIES[kind];
  const rng = rngFor(hashSeed(kind, small, variant));
  const count = (small ? sp.cardsSmall : sp.cards);
  const cards = sp.shape === 'pine' ? pineCards(sp, count, rng) : blobCards(sp, count, rng);
  if (kind === 'bush') {
    // a dark skirt at the base hides the gap where the bush meets the ground
    for (let i = 0; i < 3; i++) {
      const a = rng.next() * Math.PI * 2;
      cards.push(finish(sp, {
        x: Math.cos(a) * 0.2, y: 0.1 + rng.next() * 0.06, z: Math.sin(a) * 0.18,
        s: 0.26 + rng.next() * 0.08, roll: rng.next() * Math.PI * 2,
        bend: 0, ao: 0, tone: 0, cell: CELL_BROAD[0], phase: rng.next() * Math.PI * 2,
      }, rng));
      cards[cards.length - 1].tone = Math.min(cards[cards.length - 1].tone, 0.12);
      cards[cards.length - 1].ao *= 0.7;
    }
    if (berry) {
      for (let i = 0; i < 5; i++) {
        const a = rng.next() * Math.PI * 2, r = 0.3 + rng.next() * 0.16;
        cards.push({
          x: Math.cos(a) * r, y: 0.26 + rng.next() * 0.3, z: Math.sin(a) * r * 0.9,
          s: 0.13 + rng.next() * 0.04, roll: rng.next() * Math.PI * 2,
          bend: clamp(0.8 + rng.next() * 0.4, 0, 1.3), ao: 1, tone: -1, // tone < 0 = "use the atlas hue"
          cell: CELL_BERRY, phase: rng.next() * Math.PI * 2,
        });
      }
    }
  }
  // small plants move less in absolute terms (they are drawn 0.6× down)
  if (small && kind !== 'bush') for (const c of cards) c.bend *= BIG_SCALE;
  layoutCache.set(key, cards);
  return cards;
}

function hashSeed(kind: string, small: boolean, variant: number): number {
  let h = 2166136261;
  for (let i = 0; i < kind.length; i++) h = Math.imul(h ^ kind.charCodeAt(i), 16777619);
  return (h ^ (variant * 2654435761) ^ (small ? 0x9e37 : 0x7f31)) >>> 0;
}

/** How many variants of each crown exist (more variants = a less repetitive forest). */
export const CROWN_VARIANTS = 3;

/**
 * Precompute every crown layout (~7 ms once) and warm the JIT paths that build them. The layouts are
 * cached for the life of the page, so without this the first streamed chunk -- i.e. the first frame
 * of gameplay -- pays for all of it at once. The constructor calls it; world generation is the right
 * place for that cost.
 */
export function warmCrownLayouts(): void {
  for (const kind of [...TREE_KINDS, 'bush'] as (TreeKind | 'bush')[]) {
    for (const small of [false, true]) {
      for (let v = 0; v < CROWN_VARIANTS; v++) {
        crownCards(kind, small, v);
        if (kind === 'bush') crownCards(kind, small, v, true);
      }
    }
  }
}

// ------------------------------------------------------------------ palette
// Exactly grass.ts's `lin()` convention, on purpose: THREE.Color already linearises a hex string and
// we take the sRGB transfer once more on top. It is a quirk inherited from the existing vegetation
// code, but grass and foliage stand side by side in every scene and were tuned against the same
// response curve, so they must keep sharing it -- normalise both together or neither.
const lin = (hex: string) => new THREE.Color(hex).convertSRGBToLinear();
const PAL_LINEAR: Record<TreeKind | 'bush', [THREE.Color, THREE.Color, THREE.Color, THREE.Color]> = {} as never;
for (const k of [...TREE_KINDS, 'bush'] as (TreeKind | 'bush')[]) {
  const sp = k === 'bush' ? BUSH_SPECIES : SPECIES[k as TreeKind];
  (PAL_LINEAR as Record<string, THREE.Color[]>)[k] = sp.pal.map(lin);
}
const _c = new THREE.Color();
/** Bark per species, already linear, so a trunk costs a copy rather than a parse. */
const TRUNK_LINEAR: Record<TreeKind, THREE.Color> = {} as never;
for (const k of TREE_KINDS) (TRUNK_LINEAR as Record<string, THREE.Color>)[k] = lin(SPECIES[k].trunk.color);

/**
 * Card tint: the species palette at `tone` (0 = deepest shade, 1 = sunlit), nudged per plant so a
 * forest is not one flat green. `dry` bleaches it toward the moor/highland steppe, the same way the
 * grass carpet bleaches, so trees and ground agree about where they are.
 */
export function tintFor(kind: TreeKind | 'bush', tone: number, plantShift: number, dry: number, out: THREE.Color = _c): THREE.Color {
  if (tone < 0) return out.setRGB(1, 0.97, 0.95);   // berries: the atlas carries the red
  const pal = (PAL_LINEAR as Record<string, THREE.Color[]>)[kind];
  const t = clamp(tone, 0, 1) * (pal.length - 1);
  const i = Math.min(pal.length - 2, Math.floor(t)), f = t - i;
  out.copy(pal[i]).lerp(pal[i + 1], f);
  // per-plant hue jitter: a touch warmer or cooler, never enough to look sick
  out.offsetHSL(plantShift * 0.018, plantShift * 0.035, plantShift * 0.025);
  if (dry > 0) {
    out.lerp(DRY_TINT, dry * 0.55);
  }
  return out;
}
const DRY_TINT = lin('#9aa24e');

/** How bleached the foliage is at a tile (soft biome weights, like the grass's dryness). */
const BIOME_DRY: Record<string, number> = { meadow: 0, lake: 0, farm: 0.03, marsh: 0.16, moor: 0.26, mesa: 0.4, highland: 0.5 };
export function foliageDry(w: World, x: number, z: number): number {
  const bw = w.biomeWeights(Math.floor(x), Math.floor(z));
  let dry = 0;
  for (const b of Object.keys(BIOME_DRY)) {
    const wt = (bw as Record<string, number>)[b];
    if (wt) dry += wt * BIOME_DRY[b];
  }
  return clamp(dry, 0, 1);
}

/** Side of the dryness cache cell, in tiles. */
export const DRY_CELL = 4;
const DRY_STRIDE = Math.ceil(MAP_W / DRY_CELL) + 1;

/**
 * `foliageDry` read through a memoised coarse grid. One biome weight costs about 4 us (twelve noise
 * samples plus a distance falloff) and per plant that was the single biggest cost of building a
 * chunk, so the exact field is only ever evaluated at 4-tile cell centres and bilinearly blended in
 * between: ~16x fewer queries, and within ~0.03 of the per-plant value everywhere on the map (the
 * biome blend itself only changes over ~20 tiles). The caller owns the cache, so a fresh World never
 * inherits stale numbers.
 */
export function foliageDryCell(w: World, x: number, z: number, cache: Map<number, number>): number {
  const dryAt = (cx: number, cz: number) => {
    const key = cz * DRY_STRIDE + cx;
    let v = cache.get(key);
    if (v === undefined) {
      v = foliageDry(w, clamp(cx * DRY_CELL + DRY_CELL * 0.5, 0, MAP_W - 1), clamp(cz * DRY_CELL + DRY_CELL * 0.5, 0, MAP_H - 1));
      cache.set(key, v);
    }
    return v;
  };
  // cell centres sit at (i + 0.5) * DRY_CELL, so shift into grid space before interpolating
  const gx = x / DRY_CELL - 0.5, gz = z / DRY_CELL - 0.5;
  const x0 = Math.floor(gx), z0 = Math.floor(gz), fx = gx - x0, fz = gz - z0;
  const a = dryAt(x0, z0) + (dryAt(x0 + 1, z0) - dryAt(x0, z0)) * fx;
  const b = dryAt(x0, z0 + 1) + (dryAt(x0 + 1, z0 + 1) - dryAt(x0, z0 + 1)) * fx;
  return a + (b - a) * fz;
}

// ------------------------------------------------------------------ shaders
const LEAF_VERT = /* glsl */ `
${WIND_GLSL}
uniform float uGrid;
uniform float uCellInset;
uniform float uCanopyGust;
uniform float uCanopySway;
uniform float uFlutter;
uniform float uCutFly;
attribute vec4 aData0;  // xyz = card anchor (world), w = card size
attribute vec4 aData1;  // x = roll, y = phase, z = bend, w = ao
attribute vec4 aData2;  // rgb = tint (linear), w = atlas cell
attribute float aCut;   // game time this bush was cut, or -1 while it stands
varying vec2 vUv;
varying vec3 vCol;
varying float vShade;

void main() {
  float age = aCut < 0.0 ? -1.0 : uTime - aCut;
  if (age >= uCutFly) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0); // degenerate, off-screen
    vUv = vec2(-1.0); vCol = vec3(0.0); vShade = 0.0;
    return;
  }
  vec3 p = aData0.xyz;
  float size = aData0.w;
  float roll = aData1.x, phase = aData1.y, bend = aData1.z, ao = aData1.w;
  float cell = floor(aData2.w + 0.5);

  float flying = 0.0, rise = 0.0, shrink = 1.0, spin = 0.0;
  vec2 scatter = vec2(0.0);
  if (age >= 0.0) {
    // the bush lets go: every card pops off its stem, tumbles, drifts and shrinks away
    flying = 1.0;
    float f = age / uCutFly;
    float e = 1.0 - (1.0 - f) * (1.0 - f);
    spin = (fract(phase * 0.618) - 0.5) * 11.0 * f;
    shrink = 1.0 - smoothstep(0.45, 1.0, f);
    rise = 0.2 + e * 1.2;
    scatter = vec2(cos(phase * 3.1), sin(phase * 3.1)) * e * 0.55;
    bend = 1.0;
  }

  // the shared gust field at canopy scale, plus a slow idle sway of the whole crown
  float gust = gustAt(p.xz, uCanopyScale);
  vec2 off = gustPush(gust) * uCanopyGust * bend;
  off += vec2(sin(uTime * 1.15 + phase * 0.7 + p.z * 0.32), cos(uTime * 0.93 + phase * 1.1 + p.x * 0.28))
       * uCanopySway * bend;
  p.xz += off + scatter;
  p.y  += rise - length(off) * 0.3;   // the branch droops as it leans: the crown keeps its length

  // per-card flutter: each leaf twists and bobs on its own stem
  float fl = sin(uTime * 2.7 + phase) * uFlutter * (0.3 + bend);
  roll += fl;
  size *= 1.0 + fl * 0.1;

  // an exact screen-aligned quad (uRight/uUp are this projection's world-space screen axes)
  vec2 q = position.xy;
  float cr = cos(roll + spin), sr = sin(roll + spin);
  vec2 rq = vec2(q.x * cr - q.y * sr, q.x * sr + q.y * cr) * (size * shrink);
  vec3 wp = p + uRight * rq.x + uUp * rq.y;

  // shade: quantised toon bands like the grass, a whisper of baked AO, and a shimmer in the gust
  float qv = fract(phase * 2.399);
  float band = qv > 0.7 ? 1.0 : qv > 0.4 ? 0.78 : 0.58;
  vCol = aData2.rgb;
  vShade = (uAmbient + uSun * band) * (0.9 + 0.1 * ao) * (1.0 + gust * 0.2 * bend) * (1.0 + flying * 0.2);

  vec2 cc = vec2(mod(cell, uGrid), floor(cell / uGrid));
  vUv = (vec2(cc.x, (uGrid - 1.0) - cc.y) + mix(uCellInset, 1.0 - uCellInset, uv)) / uGrid;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(wp, 1.0);
}
`;

const LEAF_FRAG = /* glsl */ `
uniform sampler2D uLeafTex;
varying vec2 vUv;
varying vec3 vCol;
varying float vShade;
void main() {
  vec4 t = texture2D(uLeafTex, vUv);
  if (t.a < 0.5) discard;          // alpha-tested: opaque pass, no sorting, depth writes on
  gl_FragColor = vec4(vCol * t.rgb * vShade, 1.0);
}
`;

/** Trunk + two branches, one low-poly merged geometry shared by every species (28 triangles). */
function buildTrunkGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(new THREE.CylinderGeometry(0.1, 0.2, 1.0, 6, 1, true).translate(0, 0.5, 0));
  for (const [rz, ry, len, y] of [[0.62, 0.5, 0.52, 0.7], [-0.72, 2.5, 0.46, 0.78], [0.4, 4.2, 0.38, 0.9]] as [number, number, number, number][]) {
    const b = new THREE.CylinderGeometry(0.03, 0.065, len, 4, 1, true);
    b.translate(0, len / 2, 0);
    b.rotateZ(rz); b.rotateY(ry); b.translate(0, y, 0);
    parts.push(b);
  }
  const g = mergeGeometries(parts, false)!;
  g.computeBoundingSphere();
  return g;
}

// ------------------------------------------------------------------ system
interface ChunkData {
  leaves: THREE.Mesh | null;
  trunks: THREE.InstancedMesh | null;
  shadows: THREE.InstancedMesh | null;
}

export interface FoliageStats { chunks: number; cards: number; trunks: number; triangles: number; drawCalls: number }

export class FoliageSystem {
  readonly root = new THREE.Group();
  private world: World;
  private leafMat: THREE.ShaderMaterial;
  private trunkMat: THREE.MeshToonMaterial;
  private trunkGeo: THREE.BufferGeometry;
  private shadowGeo: THREE.BufferGeometry;
  private chunks = new Map<number, ChunkData | null>();
  private queue: number[] = [];
  private queued = new Set<number>();
  private chX = Math.ceil(MAP_W / FOLIAGE_CHUNK);
  private chZ = Math.ceil(MAP_H / FOLIAGE_CHUNK);
  /** trees/bushes bucketed by chunk so a build never scans the whole map */
  private treeBuckets = new Map<number, TreeSpec[]>();
  private bushBuckets = new Map<number, { tx: number; tz: number }[]>();
  /** tile index -> game time the bush was cut (survives chunk streaming) */
  private cuts = new Map<number, number>();
  private now = 0;
  /** running totals for the perf tools/tests */
  private cardTotal = 0;
  private trunkTotal = 0;

  constructor(world: World) {
    this.world = world;
    warmCrownLayouts();   // pay for the layouts here, not on the first gameplay frame
    for (const t of world.trees) {
      const key = this.chunkKey(Math.floor(t.x), Math.floor(t.z));
      const list = this.treeBuckets.get(key);
      if (list) list.push(t); else this.treeBuckets.set(key, [t]);
    }
    for (const b of world.bushes) {
      const key = this.chunkKey(b.tx, b.tz);
      const list = this.bushBuckets.get(key);
      if (list) list.push(b); else this.bushBuckets.set(key, [b]);
    }
    this.trunkGeo = buildTrunkGeometry();
    this.shadowGeo = new THREE.CircleGeometry(1, 10).rotateX(-Math.PI / 2);
    this.leafMat = new THREE.ShaderMaterial({
      uniforms: {
        ...vegUniforms,
        uWindTex: { value: windTexture() },
        uLeafTex: { value: leafAtlas() },
        uGrid: { value: LEAF_GRID },
        uCellInset: { value: 0.5 / LEAF_CELL },
        uCanopyGust: { value: 1.5 },
        uCanopySway: { value: 0.13 },
        uFlutter: { value: 0.075 },
        uCutFly: { value: BUSH_FLY },
      },
      vertexShader: LEAF_VERT,
      fragmentShader: LEAF_FRAG,
      // DoubleSide like the grass: under the sheared ortho projection the billboard winding comes
      // out clockwise in view space, so a one-sided material culls every card (invisible canopies).
      side: THREE.DoubleSide,
    });
    this.trunkMat = new THREE.MeshToonMaterial({ color: '#ffffff', gradientMap: getGradientMap() });
    // trunks ride the same gust field as their crowns (a whole tree bends together)
    swayMaterial(this.trunkMat, { value: 0.55 }, { value: 1.0 });
    this.warmBuildPath();
  }

  /**
   * Build and throw away the densest chunk once, at world load. Without it the first chunk a player
   * ever streams pays a one-off JIT/allocation spike (~8 ms measured) on a gameplay frame; with it
   * the worst streaming frame in the border forest stays near 3 ms.
   */
  private warmBuildPath() {
    let densest = -1, most = 0;
    for (const [key, list] of this.treeBuckets) if (list.length > most) { most = list.length; densest = key; }
    if (densest < 0) return;
    const probe = this.build((densest % this.chX) * FOLIAGE_CHUNK, Math.floor(densest / this.chX) * FOLIAGE_CHUNK, FOLIAGE_CHUNK, FOLIAGE_CHUNK);
    if (!probe) return;
    for (const o of [probe.leaves, probe.trunks, probe.shadows]) if (o) o.geometry.dispose();
  }

  /** Memoised dryness grid (see foliageDryCell); bounded by the map, so it never needs clearing. */
  private dryCache = new Map<number, number>();

  private chunkKey(tx: number, tz: number) { return Math.floor(tz / FOLIAGE_CHUNK) * this.chX + Math.floor(tx / FOLIAGE_CHUNK); }

  /** Stream chunks around the camera and keep the wind clock running. Once per frame. */
  update(time: number, camX: number, camZ: number, radiusTiles: number, viewAngle = 0) {
    setWindTime(time);
    setWindView(viewAngle);
    this.now = time;

    // crowns are tall: the shear drags trees whose base is already off-screen into view, so the
    // foliage streams a little wider than the grass does
    const rad = radiusTiles + 3;
    const ccx = Math.floor(camX / FOLIAGE_CHUNK), ccz = Math.floor(camZ / FOLIAGE_CHUNK);
    const r = Math.max(1, Math.ceil(rad / FOLIAGE_CHUNK) + 1);
    const needed = new Set<number>();
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      const cx = ccx + dx, cz = ccz + dz;
      if (cx < 0 || cz < 0 || cx >= this.chX || cz >= this.chZ) continue;
      const key = cz * this.chX + cx;
      needed.add(key);
      if (!this.chunks.has(key) && !this.queued.has(key)) { this.queued.add(key); this.queue.push(key); }
    }
    if (this.queue.length) {
      const d2 = (k: number) => { const cx = k % this.chX, cz = Math.floor(k / this.chX); return (cx - ccx) ** 2 + (cz - ccz) ** 2; };
      this.queue.sort((a, b) => d2(a) - d2(b));
      // Always build at least one chunk (so the fill can never stall), then stop on whichever
      // budget runs out first: the count keeps fast travel cheap, the clock keeps dense forest cheap.
      let n = BUILD_PER_FRAME;
      const t0 = performance.now();
      while (n-- > 0 && this.queue.length) {
        const key = this.queue.shift()!;
        this.queued.delete(key);
        if (this.chunks.has(key) || !needed.has(key)) continue;
        this.buildChunk(key);
        if (performance.now() - t0 > BUILD_MS_BUDGET) break;
      }
    }
    for (const [key, data] of this.chunks) {
      const cx = key % this.chX, cz = Math.floor(key / this.chX);
      if (Math.max(Math.abs(cx - ccx), Math.abs(cz - ccz)) > r + 1) {
        this.dropChunk(key, data);
      }
    }
  }

  /** Advance the wind clock without streaming (the model viewer). */
  setTime(t: number) { setWindTime(t); this.now = t; }

  // ------------------------------------------------------------------ bushes
  /** Is the bush on this tile still standing? (the sword asks before it swings) */
  hasBush(tx: number, tz: number): boolean {
    if (tx < 0 || tz < 0 || tx >= MAP_W || tz >= MAP_H) return false;
    return !this.cuts.has(tz * MAP_W + tx);
  }

  /**
   * Cut the bush on a tile: its cards detach and fly off in the shader. Returns false if there was
   * nothing standing there.
   */
  cutBush(tx: number, tz: number): boolean {
    if (!this.hasBush(tx, tz)) return false;
    const list = this.bushBuckets.get(this.chunkKey(tx, tz));
    if (!list?.some((b) => b.tx === tx && b.tz === tz)) return false;
    const tileKey = tz * MAP_W + tx;
    this.cuts.set(tileKey, this.now);
    const data = this.chunks.get(this.chunkKey(tx, tz));
    if (data?.leaves) this.writeCut(data.leaves.geometry as THREE.InstancedBufferGeometry, tileKey, this.now);
    return true;
  }

  /** A cut bush grows back (game restart). */
  respawnBush(tx: number, tz: number) {
    const tileKey = tz * MAP_W + tx;
    if (!this.cuts.has(tileKey)) return;
    this.cuts.delete(tileKey);
    const data = this.chunks.get(this.chunkKey(tx, tz));
    if (data?.leaves) this.writeCut(data.leaves.geometry as THREE.InstancedBufferGeometry, tileKey, -1);
  }

  respawnAll() {
    this.cuts.clear();
    for (const data of this.chunks.values()) {
      if (!data?.leaves) continue;
      const attr = data.leaves.geometry.getAttribute('aCut') as THREE.InstancedBufferAttribute;
      (attr.array as Float32Array).fill(-1);
      attr.needsUpdate = true;
    }
  }

  private writeCut(geo: THREE.InstancedBufferGeometry, tileKey: number, t: number) {
    const ranges = geo.userData.bushRanges as Map<number, [number, number]>;
    const range = ranges?.get(tileKey);
    if (!range) return;
    const attr = geo.getAttribute('aCut') as THREE.InstancedBufferAttribute;
    const arr = attr.array as Float32Array;
    for (let i = range[0]; i < range[0] + range[1]; i++) arr[i] = t;
    attr.addUpdateRange(range[0], range[1]);
    attr.needsUpdate = true;
  }

  /** Drop a chunk so it is rebuilt with whatever changed on its tiles. */
  invalidate(tx: number, tz: number) {
    if (tx < 0 || tz < 0 || tx >= MAP_W || tz >= MAP_H) return;
    const key = this.chunkKey(tx, tz);
    const data = this.chunks.get(key);
    if (data === undefined) return;
    this.dropChunk(key, data);
  }

  /** What is resident right now — the perf tools and tests read this. */
  stats(): FoliageStats {
    let chunks = 0, cards = 0, trunks = 0;
    for (const data of this.chunks.values()) {
      if (!data) continue;
      chunks++;
      if (data.leaves) cards += (data.leaves.geometry as THREE.InstancedBufferGeometry).instanceCount;
      if (data.trunks) trunks += data.trunks.count;
    }
    return { chunks, cards, trunks, triangles: cards * 2 + trunks * (this.trunkGeo.index!.count / 3), drawCalls: chunks * 3 };
  }

  dispose() {
    for (const [key, data] of this.chunks) this.dropChunk(key, data);
    this.chunks.clear();
    this.queue = [];
    this.queued.clear();
    this.leafMat.dispose();
    this.trunkMat.dispose();
    this.trunkGeo.dispose();
    this.shadowGeo.dispose();
  }

  // ------------------------------------------------------------------ build
  private dropChunk(key: number, data: ChunkData | null) {
    if (data) {
      for (const o of [data.leaves, data.trunks, data.shadows]) {
        if (!o) continue;
        this.root.remove(o);
        o.geometry.dispose();   // geometries are per-chunk; materials are shared
      }
    }
    this.chunks.delete(key);
  }

  private buildChunk(key: number) {
    const cx = key % this.chX, cz = Math.floor(key / this.chX);
    const data = this.build(cx * FOLIAGE_CHUNK, cz * FOLIAGE_CHUNK, FOLIAGE_CHUNK, FOLIAGE_CHUNK);
    this.chunks.set(key, data);
    if (!data) return;
    for (const o of [data.leaves, data.trunks, data.shadows]) if (o) this.root.add(o);
  }

  /**
   * All the trees and bushes whose base tile falls inside a tile rectangle. Cards are baked straight
   * into world space (the chunk mesh never moves), and each bush's cards are contiguous with its
   * range recorded in `userData.bushRanges` so a sword swing can stamp just that bush.
   */
  private build(tx0: number, tz0: number, wTiles: number, hTiles: number): ChunkData | null {
    const w = this.world;
    // gather the buckets this rectangle covers (one for a chunk, several for a viewer patch)
    const trees: TreeSpec[] = [], bushes: { tx: number; tz: number }[] = [];
    for (let cz = Math.floor(tz0 / FOLIAGE_CHUNK); cz <= Math.floor((tz0 + hTiles - 1) / FOLIAGE_CHUNK); cz++) {
      for (let cx = Math.floor(tx0 / FOLIAGE_CHUNK); cx <= Math.floor((tx0 + wTiles - 1) / FOLIAGE_CHUNK); cx++) {
        if (cx < 0 || cz < 0 || cx >= this.chX || cz >= this.chZ) continue;
        const key = cz * this.chX + cx;
        const t = this.treeBuckets.get(key); if (t) trees.push(...t);
        const b = this.bushBuckets.get(key); if (b) bushes.push(...b);
      }
    }
    const inRect = (x: number, z: number) => x >= tx0 && z >= tz0 && x < tx0 + wTiles && z < tz0 + hTiles;
    const rectTrees = trees.filter((t) => inRect(Math.floor(t.x), Math.floor(t.z)));
    const rectBushes = bushes.filter((b) => inRect(b.tx, b.tz));
    if (!rectTrees.length && !rectBushes.length) return null;

    // Size the card buffers exactly. The crown layouts are cached, so counting them costs a hash and
    // a map lookup per plant, and pre-sized Float32Arrays skip both the growth copies of a JS number[]
    // and its conversion at the end -- worth it in the border forest, where a chunk is ~2600 cards.
    const treeLayout = (t: TreeSpec) =>
      crownCards(t.kind ?? 'oak', t.scale < 0.8, Math.floor(hash2(Math.floor(t.x * 4), Math.floor(t.z * 4), 5) * CROWN_VARIANTS));
    const bushLayout = (b: { tx: number; tz: number }) =>
      crownCards('bush', false, Math.floor(hash2(b.tx, b.tz, 9) * CROWN_VARIANTS), isBerryBush(b.tx, b.tz));
    let want = 0;
    for (const t of rectTrees) want += treeLayout(t).length;
    for (const b of rectBushes) want += bushLayout(b).length;
    const cap = Math.min(want, MAX_CARDS_PER_CHUNK);
    const d0 = new Float32Array(cap * 4), d1 = new Float32Array(cap * 4), d2 = new Float32Array(cap * 4), dc = new Float32Array(cap);
    const bushRanges = new Map<number, [number, number]>();
    const mat = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    let cards = 0;   // write cursor, in cards
    // There is exactly one trunk per tree and one shadow disc per plant, so both InstancedMeshes can
    // be sized up front and filled in place: no per-plant Matrix4/Color garbage, no second pass.
    const trunks = rectTrees.length ? new THREE.InstancedMesh(this.trunkGeo, this.trunkMat, rectTrees.length) : null;
    const shadowN = rectTrees.length + rectBushes.length;
    const shadows = shadowN ? new THREE.InstancedMesh(this.shadowGeo, shadowMaterial(), shadowN) : null;
    let ti = 0, si = 0;

    const emit = (plant: LeafCard[], ox: number, oy: number, oz: number, yaw: number, scale: number,
      kind: TreeKind | 'bush', shift: number, dry: number, cut: number) => {
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      const start = cards;
      for (const c of plant) {
        if (cards >= cap) break;
        const x = ox + (c.x * cy - c.z * sy) * scale;
        const z = oz + (c.x * sy + c.z * cy) * scale;
        tintFor(kind, c.tone, shift, dry, col);
        const o = cards * 4;
        d0[o] = x; d0[o + 1] = oy + c.y * scale; d0[o + 2] = z; d0[o + 3] = c.s * scale;
        d1[o] = c.roll; d1[o + 1] = c.phase; d1[o + 2] = c.bend; d1[o + 3] = c.ao;
        d2[o] = col.r; d2[o + 1] = col.g; d2[o + 2] = col.b; d2[o + 3] = c.cell;
        dc[cards] = cut;
        cards++;
      }
      return [start, cards - start] as [number, number];
    };

    for (const t of rectTrees) {
      const kind = t.kind ?? 'oak';
      const layout = treeLayout(t);
      const yaw = hash2(Math.floor(t.x * 8), Math.floor(t.z * 8), 6) * Math.PI * 2;
      const gy = t.y ?? w.heightAt(t.x, t.z);
      const dry = foliageDryCell(w, t.x, t.z, this.dryCache);
      const shift = hash2(Math.floor(t.x), Math.floor(t.z), 7) * 2 - 1;
      emit(layout, t.x, gy, t.z, yaw, t.scale, kind, shift, dry, -1);

      const sp = SPECIES[kind];
      pos.set(t.x, gy, t.z);
      q.setFromAxisAngle(up, yaw);
      scl.set(t.scale * sp.trunk.sx, t.scale * sp.trunk.sy, t.scale * sp.trunk.sx);
      mat.compose(pos, q, scl);
      trunks!.setMatrixAt(ti, mat);
      trunks!.setColorAt(ti, col.copy(TRUNK_LINEAR[kind]).offsetHSL(shift * 0.01, 0, shift * 0.02));
      ti++;

      const sr = sp.shadowR * t.scale;
      pos.set(t.x, gy + 0.018, t.z + sr * 0.12);
      scl.set(sr, 1, sr * 0.78);
      mat.compose(pos, IDENTITY_Q, scl);
      shadows!.setMatrixAt(si++, mat);
    }

    for (const b of rectBushes) {
      const layout = bushLayout(b);
      const h = hash2(b.tx, b.tz, 11);
      const yaw = hash2(b.tx, b.tz, 12) * Math.PI * 2;
      const scale = 0.88 + h * 0.26;
      const x = b.tx + 0.5 + (hash2(b.tx, b.tz, 13) - 0.5) * 0.22;
      const z = b.tz + 0.5 + (hash2(b.tx, b.tz, 14) - 0.5) * 0.22;
      const gy = w.drawnGroundY(x, z);
      const dry = foliageDryCell(w, x, z, this.dryCache);
      const cut = this.cuts.get(b.tz * MAP_W + b.tx) ?? -1;
      const [start, n] = emit(layout, x, gy, z, yaw, scale, 'bush', hash2(b.tx, b.tz, 15) * 2 - 1, dry, cut);
      bushRanges.set(b.tz * MAP_W + b.tx, [start, n]);
      const sr = BUSH_SPECIES.shadowR * scale;
      pos.set(x, gy + 0.016, z);
      scl.set(sr, 1, sr * 0.85);
      mat.compose(pos, IDENTITY_Q, scl);
      shadows!.setMatrixAt(si++, mat);
    }

    if (!cards) { trunks?.dispose(); shadows?.dispose(); return null; }

    // ---- leaves: one instanced quad cloud
    const g = new THREE.InstancedBufferGeometry();
    g.index = QUAD.index;
    g.setAttribute('position', QUAD.attributes.position);
    g.setAttribute('uv', QUAD.attributes.uv);
    g.setAttribute('aData0', new THREE.InstancedBufferAttribute(d0, 4));
    g.setAttribute('aData1', new THREE.InstancedBufferAttribute(d1, 4));
    g.setAttribute('aData2', new THREE.InstancedBufferAttribute(d2, 4));
    const cutAttr = new THREE.InstancedBufferAttribute(dc, 1);
    cutAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aCut', cutAttr);
    g.instanceCount = cards;
    g.userData.bushRanges = bushRanges;
    g.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(tx0 + wTiles / 2, 1.4, tz0 + hTiles / 2),
      Math.hypot(wTiles, hTiles) / 2 + 3,
    );
    const leaves = new THREE.Mesh(g, this.leafMat);
    leaves.matrixAutoUpdate = false;

    // ---- trunks: one InstancedMesh, per-instance colour carries the species bark
    if (trunks) {
      trunks.instanceMatrix.needsUpdate = true;
      if (trunks.instanceColor) trunks.instanceColor.needsUpdate = true;
      trunks.matrixAutoUpdate = false;
      trunks.computeBoundingSphere();
      this.trunkTotal += ti;
    }

    // ---- shadows: one InstancedMesh of flat discs, grounding every plant
    if (shadows) {
      shadows.instanceMatrix.needsUpdate = true;
      shadows.matrixAutoUpdate = false;
      shadows.computeBoundingSphere();
      shadows.renderOrder = -1;   // lay them down before the transparent pass sorts anything else
    }

    this.cardTotal += cards;
    return { leaves, trunks, shadows };
  }

  // ------------------------------------------------------------------ viewer
  /**
   * A free-standing patch of the real map's plants, centred on the origin (model viewer). One set of
   * draw calls for the whole patch, exactly as a chunk would build it.
   */
  buildPatch(cx: number, cz: number, radiusTiles: number): THREE.Group {
    const g = new THREE.Group();
    const n = Math.ceil(radiusTiles * 2);
    const data = this.build(Math.floor(cx - radiusTiles), Math.floor(cz - radiusTiles), n, n);
    if (data) for (const o of [data.leaves, data.trunks, data.shadows]) if (o) g.add(o);
    g.position.set(-cx, 0, -cz);
    return g;
  }

  /**
   * A single plant centred on the origin, for the model viewer: same code path as a chunk, one
   * instance of it.
   */
  buildSpecimen(opts: { kind?: TreeKind | 'bush'; scale?: number; berry?: boolean; variant?: number }): THREE.Group {
    const kind = opts.kind ?? 'oak';
    const scale = opts.scale ?? 1;
    const small = kind !== 'bush' && scale < 0.8;
    const layout = crownCards(kind === 'bush' ? 'bush' : kind, small, opts.variant ?? 0, opts.berry ?? false);
    const g = new THREE.Group();
    const d0: number[] = [], d1: number[] = [], d2: number[] = [], dc: number[] = [];
    const col = new THREE.Color();
    for (const c of layout) {
      tintFor(kind, c.tone, 0.2, 0, col);
      d0.push(c.x * scale, c.y * scale, c.z * scale, c.s * scale);
      d1.push(c.roll, c.phase, c.bend, c.ao);
      d2.push(col.r, col.g, col.b, c.cell);
      dc.push(-1);
    }
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = QUAD.index;
    geo.setAttribute('position', QUAD.attributes.position);
    geo.setAttribute('uv', QUAD.attributes.uv);
    geo.setAttribute('aData0', new THREE.InstancedBufferAttribute(new Float32Array(d0), 4));
    geo.setAttribute('aData1', new THREE.InstancedBufferAttribute(new Float32Array(d1), 4));
    geo.setAttribute('aData2', new THREE.InstancedBufferAttribute(new Float32Array(d2), 4));
    geo.setAttribute('aCut', new THREE.InstancedBufferAttribute(new Float32Array(dc), 1));
    geo.instanceCount = d0.length / 4;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.4, 0), 4);
    g.add(new THREE.Mesh(geo, this.leafMat));

    if (kind !== 'bush') {
      const sp = SPECIES[kind as TreeKind];
      const trunk = new THREE.InstancedMesh(this.trunkGeo, this.trunkMat, 1);
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(0, 0, 0), new THREE.Quaternion(),
        new THREE.Vector3(scale * sp.trunk.sx, scale * sp.trunk.sy, scale * sp.trunk.sx),
      );
      trunk.setMatrixAt(0, m);
      trunk.setColorAt(0, lin(sp.trunk.color));
      trunk.instanceMatrix.needsUpdate = true;
      if (trunk.instanceColor) trunk.instanceColor.needsUpdate = true;
      g.add(trunk);
    }
    const sr = (kind === 'bush' ? BUSH_SPECIES : SPECIES[kind as TreeKind]).shadowR * scale;
    const shadow = new THREE.InstancedMesh(this.shadowGeo, shadowMaterial(), 1);
    shadow.setMatrixAt(0, new THREE.Matrix4().compose(
      new THREE.Vector3(0, 0.018, sr * 0.12), new THREE.Quaternion(), new THREE.Vector3(sr, 1, sr * 0.78),
    ));
    shadow.instanceMatrix.needsUpdate = true;
    g.add(shadow);
    return g;
  }
}

const IDENTITY_Q = new THREE.Quaternion();
/** The unit card: a quad in the XY plane. The shader throws away its orientation and rebuilds it. */
const QUAD = new THREE.PlaneGeometry(1, 1);
void rngFor;
