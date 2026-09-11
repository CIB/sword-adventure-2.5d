// Internal rendering resolution (SNES-like, 4:3) and world scale
export const VIEW_W = 320;
export const VIEW_H = 240;
export const PX_PER_TILE = 20;
export const VIEW_TILES_X = VIEW_W / PX_PER_TILE; // 16 tiles wide
export const VIEW_TILES_Y = VIEW_H / PX_PER_TILE; // 12 tiles tall
export const CAM_HEIGHT = 40;
export const SHEAR = 0.85; // oblique projection factor: 1 unit of height = 0.85 tiles of screen space
export const MAP_W = 52;
export const MAP_H = 44;
export const TEX_PX = 20; // ground texture pixels per tile

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

export type Facing = 0 | 1 | 2 | 3; // 0 south, 1 east, 2 north, 3 west
export const FACING_VEC: [number, number][] = [
  [0, 1],
  [1, 0],
  [0, -1],
  [-1, 0],
];
export const FACING_ANGLE = [0, Math.PI / 2, Math.PI, -Math.PI / 2];

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
