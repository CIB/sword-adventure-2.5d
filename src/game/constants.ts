// Internal rendering resolution (SNES-like, 4:3) and world scale
export const VIEW_W = 320;
export const VIEW_H = 240;
export const PX_PER_TILE = 20;
export const VIEW_TILES_X = VIEW_W / PX_PER_TILE; // 16 tiles wide
export const VIEW_TILES_Y = VIEW_H / PX_PER_TILE; // 12 tiles tall
/**
 * On small windows (handhelds, phones) the 3D view is rendered at `1/zoom` of the window-filling resolution and
 * magnified by the CSS `pixelated` upscale, instead of growing the internal resolution. These are the two knobs
 * the app balances: `ZOOM_TARGET_CSS_PX` is how large one world pixel should end up on screen — 4 is what a
 * 1080p desktop already gets at zoom 1, so desktops keep it bit-identical — and `ZOOM_MIN_TILES_X` is the most
 * the world may be magnified before the view gets too tight (horizontal tiles that must stay visible).
 */
export const ZOOM_TARGET_CSS_PX = 4;
export const ZOOM_MIN_TILES_X = 12;
export const CAM_HEIGHT = 40;
export const SHEAR = 0.85; // oblique projection factor: 1 unit of height = 0.85 tiles of screen space
export const LEVEL_H = 0.5;   // world units per terrain level
export const MAX_WALK_SLOPE = 0.45; // max height difference per tile step that can be walked (steeper = cliff)
export const MAP_W = 208;
export const MAP_H = 176;
export const TEX_PX = 20; // ground texture pixels per tile
export const WATER_DEPTH = 0.75; // how far the river bed sits below the meadow (world units)
export const BRIDGE_H = 0.22;    // bridge deck height above the meadow level

export const MAX_HP = 12; // 6 hearts, 2 hp per heart

export enum Tile {
  Grass = 0,
  Path = 1,
  Water = 2,
  Bridge = 3,
  Cliff = 4,
  Flowers = 5,
  Cobble = 6,
  Bed = 7, // flower bed / crops (village)
}

/** 8-way facing: 0 south, then clockwise (seen from above) in 45° steps: 1 SE, 2 east, 3 NE, 4 north, 5 NW, 6 west, 7 SW */
export type Facing = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const FACING_ANGLE = [0, 1, 2, 3, 4, 5, 6, 7].map(i => normAngle(i * Math.PI / 4));
export const FACING_VEC: [number, number][] = FACING_ANGLE.map(a => {
  const r = (v: number) => Math.abs(v) < 1e-9 ? 0 : Math.abs(Math.abs(v) - 1) < 1e-9 ? Math.sign(v) : v;
  return [r(Math.sin(a)), r(Math.cos(a))] as [number, number];
});
/**
 * How finely characters (player, NPCs, enemies) may turn: 4 = classic Zelda-style cardinal lock,
 * 8 = 45° headings. The facing representation is always 8-way; this only restricts which values get picked.
 */
export const FACING_DIRS: 4 | 8 = 4;
/** half the angular width of one facing sector — the turn threshold used for hysteresis */
export const FACING_HALF_STEP = Math.PI / FACING_DIRS;
/** nearest allowed facing for a direction vector */
export function facingFrom(dx: number, dz: number): Facing {
  const step = (Math.PI * 2) / FACING_DIRS, per = 8 / FACING_DIRS;
  return ((Math.round(Math.atan2(dx, dz) / step) * per % 8) + 8) % 8 as Facing;
}
/** a random allowed facing */
export function randomFacing(rand01: number): Facing {
  return (Math.floor(rand01 * FACING_DIRS) * (8 / FACING_DIRS)) as Facing;
}
/** angular distance (0..π) between a facing and a direction vector */
export function facingDelta(f: Facing, dx: number, dz: number): number {
  return Math.abs(normAngle(Math.atan2(dx, dz) - FACING_ANGLE[f]));
}

/** Small deterministic PRNG (mulberry32) */
export class RNG {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number): number {
    return Math.floor(this.range(a, b + 1));
  }
  pick<T>(arr: T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
}

/** Deterministic per-coordinate hash in [0,1) */
export function hash2(x: number, z: number, s = 0): number {
  let h = (Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(s, 982451653)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function normAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a <= -Math.PI) a += Math.PI * 2;
  return a;
}

/** Is angle `a` inside the arc swept from `from` to `to` (shortest direction), with padding */
export function inArc(a: number, from: number, to: number, pad: number): boolean {
  const d = normAngle(to - from);
  const t = normAngle(a - from);
  if (d >= 0) return t >= -pad && t <= d + pad;
  return t <= pad && t >= d - pad;
}

export function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
