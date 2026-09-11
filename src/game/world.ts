import * as THREE from 'three';
import { getGradientMap as getGradientMapRef } from './models';
import { MAP_W, MAP_H, TEX_PX, Tile, RNG, hash2, LEVEL_H, MAX_WALK_SLOPE, WATER_DEPTH, BRIDGE_H } from './constants';

export type EnemyKind = 'sword' | 'spear' | 'javelin' | 'archer';
export interface TreeSpec { x: number; z: number; scale: number; y?: number }
export interface TileObj { tx: number; tz: number }
export interface HouseSpec { x: number; z: number; w: number; d: number; roof?: string; wall?: string; door?: 'S' | 'E' | 'W'; sign?: 'shop' | 'inn' | 'none' }
export interface PropSpec { kind: 'well' | 'sign' | 'stall' | 'bench' | 'weathercock' | 'lamp' | 'barrel' | 'crate' | 'flowerpot' | 'hedge'; x: number; z: number; rot?: number }
export interface NpcSpec { id: string; x: number; z: number; facing?: 0 | 1 | 2 | 3; wander?: number }
export interface SpawnSpec { x: number; z: number; kind: EnemyKind }
export interface BridgeSpec { x0: number; z0: number; x1: number; z1: number; y: number } // tile-inclusive rect + deck height
export interface Vec2 { x: number; z: number }

function distToSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + dx * t, cz = az + dz * t;
  return Math.hypot(px - cx, pz - cz);
}
function polyDist(px: number, pz: number, pts: number[][]): number {
  let d = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    d = Math.min(d, distToSeg(px, pz, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
  }
  return d;
}

export class World {
  readonly w = MAP_W;
  readonly h = MAP_H;
  tiles = new Uint8Array(MAP_W * MAP_H);
  solid = new Uint8Array(MAP_W * MAP_H);
  tall = new Uint8Array(MAP_W * MAP_H); // blocks projectiles
  treeCell = new Uint8Array(MAP_W * MAP_H);
  houseCell = new Uint8Array(MAP_W * MAP_H);
  /** Terrain heights at tile corners, (MAP_W+1) x (MAP_H+1), in world units */
  hmap = new Float32Array((MAP_W + 1) * (MAP_H + 1));
  trees: TreeSpec[] = [];
  bushes: TileObj[] = [];
  rocks: TileObj[] = [];
  fences: TileObj[] = [];
  houses: HouseSpec[] = [
    { x: 4, z: 3, w: 5, d: 3, roof: '#b73c3c', wall: '#e8d6a8', sign: 'none' },       // elder's house
    { x: 12, z: 2, w: 5, d: 3, roof: '#3a5fd0', wall: '#e8d6a8', sign: 'none' },      // Marin & Tarin style cottage
    { x: 2, z: 9, w: 4, d: 3, roof: '#8a3fc4', wall: '#f0e2c0', sign: 'none' },       // library-ish
    { x: 15, z: 8, w: 4, d: 3, roof: '#c82828', wall: '#f4ecd8', sign: 'shop' },      // shop
    { x: 14, z: 13, w: 4, d: 3, roof: '#2f8f5a', wall: '#e8d6a8', sign: 'none' },     // granny
  ];
  props: PropSpec[] = [];
  npcs: NpcSpec[] = [];
  spawns: SpawnSpec[] = [];
  playerStart: Vec2 = { x: 9.5, z: 9.5 };
  /** Village bounds (tiles, inclusive) - enemies stay out */
  village = { x0: 1, z0: 1, x1: 20, z1: 17 };
  private rng = new RNG(20240607);

  constructor() {
    this.generate();
  }

  idx(x: number, z: number) { return z * this.w + x; }
  tile(x: number, z: number): Tile {
    if (x < 0 || z < 0 || x >= this.w || z >= this.h) return Tile.Grass;
    return this.tiles[z * this.w + x] as Tile;
  }
  isSolidTile(tx: number, tz: number): boolean {
    if (tx < 0 || tz < 0 || tx >= this.w || tz >= this.h) return true;
    return this.solid[tz * this.w + tx] === 1;
  }
  blocksProjectile(x: number, z: number): boolean {
    const tx = Math.floor(x), tz = Math.floor(z);
    if (tx < 0 || tz < 0 || tx >= this.w || tz >= this.h) return true;
    return this.tall[tz * this.w + tx] === 1;
  }
  setSolid(tx: number, tz: number, v: boolean) {
    this.solid[this.idx(tx, tz)] = v ? 1 : 0;
    this.tall[this.idx(tx, tz)] = v ? 1 : 0;
  }
  isWalkable(x: number, z: number): boolean {
    return !this.isSolidTile(Math.floor(x), Math.floor(z));
  }

  // ---------------------------------------------------------------- terrain height
  private hIdx(cx: number, cz: number) { return Math.min(this.h, Math.max(0, cz)) * (this.w + 1) + Math.min(this.w, Math.max(0, cx)); }
  cornerH(cx: number, cz: number): number { return this.hmap[this.hIdx(cx, cz)]; }
  /** Bilinear terrain height at a world position */
  heightAt(x: number, z: number): number {
    const tx = Math.floor(x), tz = Math.floor(z);
    const fx = x - tx, fz = z - tz;
    const h00 = this.cornerH(tx, tz), h10 = this.cornerH(tx + 1, tz), h01 = this.cornerH(tx, tz + 1), h11 = this.cornerH(tx + 1, tz + 1);
    return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
  }
  /** Average height of a tile (used to place props/houses) */
  tileH(tx: number, tz: number): number {
    return (this.cornerH(tx, tz) + this.cornerH(tx + 1, tz) + this.cornerH(tx, tz + 1) + this.cornerH(tx + 1, tz + 1)) / 4;
  }
  /** Is the step from one point to another walkable (not a cliff face)? */
  canStep(x0: number, z0: number, x1: number, z1: number): boolean {
    return Math.abs(this.heightAt(x1, z1) - this.heightAt(x0, z0)) <= MAX_WALK_SLOPE * Math.max(0.05, Math.hypot(x1 - x0, z1 - z0)) / 0.5;
  }

  boxCollides(x: number, z: number, hw: number, hh: number): boolean {
    const x0 = Math.floor(x - hw + 1e-4), x1 = Math.floor(x + hw - 1e-4);
    const z0 = Math.floor(z - hh + 1e-4), z1 = Math.floor(z + hh - 1e-4);
    for (let tz = z0; tz <= z1; tz++) for (let tx = x0; tx <= x1; tx++) if (this.isSolidTile(tx, tz)) return true;
    return false;
  }

  /** Move an AABB through the tile map with axis separation + Zelda-style corner nudging. */
  /** Would moving the box centre from (x0,z0) to (x1,z1) climb/drop a cliff face? Samples the box corners. */
  private cliffBlocked(x0: number, z0: number, x1: number, z1: number, hw: number, hh: number): boolean {
    const h0 = this.surfaceAt(x0, z0);
    for (const [ox, oz] of [[0, 0], [-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]]) {
      if (Math.abs(this.surfaceAt(x1 + ox, z1 + oz) - h0) > MAX_WALK_SLOPE) return true;
    }
    return false;
  }

  moveBox(p: Vec2, dx: number, dz: number, hw: number, hh: number, nudge = 0): { bx: boolean; bz: boolean } {
    let bx = false, bz = false;
    if (dx !== 0) {
      if (!this.boxCollides(p.x + dx, p.z, hw, hh) && !this.cliffBlocked(p.x, p.z, p.x + dx, p.z, hw, hh)) p.x += dx;
      else {
        bx = true;
        const target = dx > 0 ? Math.floor(p.x + dx + hw) - hw - 0.002 : Math.ceil(p.x + dx - hw) + hw + 0.002;
        if (Math.abs(target - p.x) <= Math.abs(dx) + 0.01 && !this.boxCollides(target, p.z, hw, hh)) p.x = target;
        if (nudge > 0 && dz === 0) {
          const tx = dx > 0 ? Math.floor(p.x + hw + 0.05) : Math.floor(p.x - hw - 0.05);
          const zTop = Math.floor(p.z - hh + 1e-4), zBot = Math.floor(p.z + hh - 1e-4);
          if (zTop !== zBot) {
            const ts = this.isSolidTile(tx, zTop), bs = this.isSolidTile(tx, zBot);
            if (ts !== bs) {
              const dir = ts ? 1 : -1;
              const overlap = ts ? zTop + 1 - (p.z - hh) : p.z + hh - zBot;
              if (overlap < hh * 1.4) {
                const step = Math.min(nudge, overlap + 0.01) * dir;
                if (!this.boxCollides(p.x, p.z + step, hw, hh)) p.z += step;
              }
            }
          }
        }
      }
    }
    if (dz !== 0) {
      if (!this.boxCollides(p.x, p.z + dz, hw, hh) && !this.cliffBlocked(p.x, p.z, p.x, p.z + dz, hw, hh)) p.z += dz;
      else {
        bz = true;
        const target = dz > 0 ? Math.floor(p.z + dz + hh) - hh - 0.002 : Math.ceil(p.z + dz - hh) + hh + 0.002;
        if (Math.abs(target - p.z) <= Math.abs(dz) + 0.01 && !this.boxCollides(p.x, target, hw, hh)) p.z = target;
        if (nudge > 0 && dx === 0) {
          const tz = dz > 0 ? Math.floor(p.z + hh + 0.05) : Math.floor(p.z - hh - 0.05);
          const xL = Math.floor(p.x - hw + 1e-4), xR = Math.floor(p.x + hw - 1e-4);
          if (xL !== xR) {
            const ls = this.isSolidTile(xL, tz), rs = this.isSolidTile(xR, tz);
            if (ls !== rs) {
              const dir = ls ? 1 : -1;
              const overlap = ls ? xL + 1 - (p.x - hw) : p.x + hw - xR;
              if (overlap < hw * 1.4) {
                const step = Math.min(nudge, overlap + 0.01) * dir;
                if (!this.boxCollides(p.x + step, p.z, hw, hh)) p.x += step;
              }
            }
          }
        }
      }
    }
    return { bx, bz };
  }

  /** Find the nearest tile center that is free (not solid, not water) */
  nearestFree(x: number, z: number): Vec2 {
    const sx = Math.floor(x), sz = Math.floor(z);
    for (let r = 0; r < 6; r++) {
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const tx = sx + dx, tz = sz + dz;
        if (tx < 2 || tz < 2 || tx >= this.w - 2 || tz >= this.h - 2) continue;
        if (!this.isSolidTile(tx, tz) && this.tile(tx, tz) !== Tile.Water) return { x: tx + 0.5, z: tz + 0.5 };
      }
    }
    return { x, z };
  }

  // ---------------------------------------------------------------- generation
  bridges: BridgeSpec[] = [];
  /** distance from each tile centre to the nearest water polyline centre-line (for banks) */
  private riverDist = new Float32Array(MAP_W * MAP_H).fill(1e9);
  private riverHalfW = new Float32Array(MAP_W * MAP_H);

  private generate() {
    const { w, h, rng } = this;
    const set = (x: number, z: number, t: Tile) => { if (x >= 0 && z >= 0 && x < w && z < h) this.tiles[z * w + x] = t; };
    const get = (x: number, z: number) => this.tile(x, z);

    // 1. water ------------------------------------------------------------------------------------------
    // main river: enters at the top around x=120, wanders south, exits at the bottom around x=140
    const river = [[118, -6], [116, 22], [124, 44], [122, 68], [130, 92], [128, 118], [136, 142], [134, 160], [140, 182]];
    // tributary from the western lake into the river
    const brook = [[48, 122], [70, 118], [92, 112], [110, 100], [124, 96]];
    // eastern stream from the highland
    const stream = [[206, 40], [186, 48], [170, 58], [150, 66], [128, 72]];
    const waters: { pts: number[][]; w: number }[] = [{ pts: river, w: 3.4 }, { pts: brook, w: 1.9 }, { pts: stream, w: 1.6 }];
    const lake = { x: 40, z: 126, rx: 13, rz: 8 };
    const pond = { x: 24, z: 62, rx: 6, rz: 4 };
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
      const cx = x + 0.5, cz = z + 0.5;
      const i = this.idx(x, z);
      let best = 1e9, bw = 0;
      for (const wt of waters) { const d = polyDist(cx, cz, wt.pts); if (d - wt.w < best - bw) { best = d; bw = wt.w; } }
      for (const el of [lake, pond]) {
        const ex = (cx - el.x) / el.rx, ez = (cz - el.z) / el.rz;
        const r = Math.hypot(ex, ez); // 1 at the shore
        const d = (r - 1) * Math.min(el.rx, el.rz); // approx distance to shore (negative inside)
        if (d + 0 < best - bw) { best = d + 0; bw = 0; }
      }
      const wobble = (hash2(x, z, 3) - 0.5) * 0.6;
      this.riverDist[i] = best - bw + wobble; // <0 = water, 0..~3 = bank
      this.riverHalfW[i] = bw;
      if (this.riverDist[i] < 0) set(x, z, Tile.Water);
    }

    // 2. roads ------------------------------------------------------------------------------------------
    const roads = [
      // from the village south gate down to the crossroads, then east to the great bridge
      [[9.5, 17], [9.5, 30.5], [40.5, 30.5], [40.5, 46.5], [96.5, 46.5], [121.5, 46.5]],
      // east gate road to the north bridge
      [[21, 8.5], [60.5, 8.5], [60.5, 20.5], [114.5, 20.5]],
      // beyond the great bridge to the highland ramp and the far east
      [[125.5, 46.5], [160.5, 46.5], [160.5, 80.5], [190.5, 80.5]],
      // south road: crossroads -> lake -> brook bridge -> southern bridge
      [[40.5, 46.5], [40.5, 100.5], [62.5, 100.5], [62.5, 140.5], [100.5, 140.5], [100.5, 128.5], [132.5, 128.5]],
      // east bank south
      [[140.5, 128.5], [170.5, 128.5], [170.5, 150.5]],
      [[160.5, 80.5], [160.5, 110.5], [140.5, 110.5]],
    ];
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
      if (get(x, z) !== Tile.Grass) continue;
      const cx = x + 0.5, cz = z + 0.5;
      if (x >= this.village.x0 && x <= this.village.x1 && z >= this.village.z0 && z <= this.village.z1 - 1) continue;
      for (const p of roads) if (polyDist(cx, cz, p) < 1.1) { set(x, z, Tile.Path); break; }
    }

    // 3. bridges (raised wooden decks; the terrain underneath stays sunk) --------------------------------
    const bridgeAt = (x: number, z: number, along: 'x' | 'z') => {
      // find the water crossing on this row/column nearest to (x,z), then span it with 1 tile of abutment each side
      const isW = (k: number) => along === 'x' ? get(k, z) === Tile.Water : get(x, k) === Tile.Water;
      let start = along === 'x' ? x : z;
      if (!isW(start)) { let f = -1; for (let d = 1; d < 30 && f < 0; d++) { if (isW(start + d)) f = start + d; else if (isW(start - d)) f = start - d; } if (f < 0) return; start = f; }
      let a = start, b = start;
      while (isW(a - 1)) a--;
      while (isW(b + 1)) b++;
      a -= 1; b += 1;
      const spec: BridgeSpec = along === 'x' ? { x0: a, z0: z - 1, x1: b, z1: z + 1, y: BRIDGE_H } : { x0: x - 1, z0: a, x1: x + 1, z1: b, y: BRIDGE_H };
      this.bridges.push(spec);
      for (let bz = spec.z0; bz <= spec.z1; bz++) for (let bx = spec.x0; bx <= spec.x1; bx++) set(bx, bz, Tile.Bridge);
    };
    bridgeAt(122, 46, 'x');  // great bridge (east road)
    bridgeAt(116, 20, 'x');  // north bridge
    bridgeAt(134, 128, 'x'); // south bridge
    bridgeAt(62, 118, 'z');  // brook bridge (south road)
    bridgeAt(160, 62, 'z');  // eastern stream bridge

    // 4. terrain heights ------------------------------------------------------------------------------
    this.generateHeights();

    // 5. village ---------------------------------------------------------------------------------------
    for (const hs of this.houses) for (let z = hs.z; z < hs.z + hs.d; z++) for (let x = hs.x; x < hs.x + hs.w; x++) {
      set(x, z, Tile.Grass); this.houseCell[this.idx(x, z)] = 1;
    }
    this.generateVillage(set);

    // 6. trees -----------------------------------------------------------------------------------------
    const v = this.village;
    const inYard = (x: number, z: number) => x >= v.x0 && x <= v.x1 && z >= v.z0 && z <= v.z1;
    const nearSpawn = (x: number, z: number) => Math.hypot(x + 0.5 - this.playerStart.x, z + 0.5 - this.playerStart.z) < 3;
    const nearRoad = (x: number, z: number) => { for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { const t = get(x + dx, z + dz); if (t === Tile.Path || t === Tile.Bridge) return true; } return false; };
    const flat = (x: number, z: number) => {
      const hs = [this.cornerH(x, z), this.cornerH(x + 1, z), this.cornerH(x, z + 1), this.cornerH(x + 1, z + 1)];
      return Math.max(...hs) - Math.min(...hs) < 0.3;
    };
    const treeOK = (x: number, z: number) => get(x, z) === Tile.Grass && !this.houseCell[this.idx(x, z)] && !inYard(x, z) && !nearSpawn(x, z) && !nearRoad(x, z) && flat(x, z) && this.riverDist[this.idx(x, z)] > 1.5;
    // border forest
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
      const ring = Math.min(x, z, w - 1 - x, h - 1 - z);
      if (ring < 2) { if (get(x, z) !== Tile.Water) this.treeCell[this.idx(x, z)] = 1; continue; }
      if (ring <= 6 && treeOK(x, z)) {
        const p = [0.7, 0.5, 0.35, 0.22, 0.12][ring - 2] ?? 0.08;
        if (rng.next() < p) this.treeCell[this.idx(x, z)] = 1;
      }
    }
    // forests: low-frequency value noise decides woodland regions, groves add dense clumps
    const noise = (x: number, z: number, f: number, seed: number) => {
      const gx = x / f, gz = z / f, x0 = Math.floor(gx), z0 = Math.floor(gz), fx = gx - x0, fz = gz - z0;
      const sm = (t: number) => t * t * (3 - 2 * t);
      const n00 = hash2(x0, z0, seed), n10 = hash2(x0 + 1, z0, seed), n01 = hash2(x0, z0 + 1, seed), n11 = hash2(x0 + 1, z0 + 1, seed);
      return (n00 * (1 - sm(fx)) + n10 * sm(fx)) * (1 - sm(fz)) + (n01 * (1 - sm(fx)) + n11 * sm(fx)) * sm(fz);
    };
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
      if (!treeOK(x, z)) continue;
      const n = noise(x, z, 18, 11) * 0.7 + noise(x, z, 7, 12) * 0.3;
      if (n > 0.62 && rng.next() < (n - 0.62) * 3.2) this.treeCell[this.idx(x, z)] = 1;
      else if (rng.next() < 0.012) this.treeCell[this.idx(x, z)] = 1; // lone trees
    }
    const groves = [
      { x: 84, z: 92, r: 9, p: 0.55 }, { x: 172, z: 148, r: 8, p: 0.55 }, { x: 96, z: 20, r: 7, p: 0.5 }, { x: 24, z: 88, r: 7, p: 0.55 },
      { x: 64, z: 160, r: 8, p: 0.5 }, { x: 136, z: 88, r: 6, p: 0.4 }, { x: 180, z: 20, r: 7, p: 0.5 }, { x: 150, z: 160, r: 7, p: 0.5 }, { x: 30, z: 40, r: 5, p: 0.5 },
    ];
    for (const g of groves) for (let z = g.z - g.r - 2; z <= g.z + g.r + 2; z++) for (let x = g.x - g.r - 2; x <= g.x + g.r + 2; x++) {
      const d = Math.hypot(x - g.x, z - g.z) + (rng.next() - 0.5) * 1.5;
      if (d < g.r && treeOK(x, z) && rng.next() < g.p) this.treeCell[this.idx(x, z)] = 1;
    }
    // village trees: framing corners + a big one by the plaza
    for (const [x, z] of [[2, 2], [3, 2], [2, 3], [3, 3], [18, 14], [19, 14], [18, 15], [19, 15], [19, 1], [1, 16], [2, 16], [17, 1], [12, 16], [1, 6], [1, 7]]) if (get(x, z) === Tile.Grass && !this.houseCell[this.idx(x, z)]) this.treeCell[this.idx(x, z)] = 1;
    // group into 2x2 big trees
    const claimed = new Uint8Array(w * h);
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
      const i = this.idx(x, z);
      if (!this.treeCell[i] || claimed[i]) continue;
      const canBig = x + 1 < w && z + 1 < h && this.treeCell[this.idx(x + 1, z)] && this.treeCell[this.idx(x, z + 1)] && this.treeCell[this.idx(x + 1, z + 1)]
        && !claimed[this.idx(x + 1, z)] && !claimed[this.idx(x, z + 1)] && !claimed[this.idx(x + 1, z + 1)];
      if (canBig) {
        claimed[i] = claimed[this.idx(x + 1, z)] = claimed[this.idx(x, z + 1)] = claimed[this.idx(x + 1, z + 1)] = 1;
        this.trees.push({ x: x + 1, z: z + 1.55, scale: 1, y: this.heightAt(x + 1, z + 1) });
      } else {
        claimed[i] = 1;
        this.trees.push({ x: x + 0.5, z: z + 0.8, scale: 0.6, y: this.heightAt(x + 0.5, z + 0.5) });
      }
    }

    // 7. bushes / rocks ---------------------------------------------------------------------------------
    const objFree = (x: number, z: number) => (get(x, z) === Tile.Grass || get(x, z) === Tile.Flowers) && !this.treeCell[this.idx(x, z)] && !this.houseCell[this.idx(x, z)] && !nearSpawn(x, z) && flat(x, z) && this.riverDist[this.idx(x, z)] > 1.2;
    const occupied = new Uint8Array(w * h);
    const patterns = [[[0, 0], [1, 0], [2, 0]], [[0, 0], [0, 1], [0, 2]], [[0, 0], [1, 0], [0, 1], [1, 1]], [[0, 0], [1, 0], [2, 0], [0, 1]], [[0, 0], [2, 0], [1, 1]]];
    for (let i = 0; i < 190; i++) {
      const bx = rng.int(3, w - 6), bz = rng.int(3, h - 6);
      if (inYard(bx, bz)) continue;
      const pat = rng.pick(patterns);
      for (const [ox, oz] of pat) {
        const x = bx + ox, z = bz + oz;
        if (objFree(x, z) && !inYard(x, z) && !occupied[this.idx(x, z)]) { this.bushes.push({ tx: x, tz: z }); occupied[this.idx(x, z)] = 1; }
      }
    }
    // a few guaranteed bushes near the village for Granny's quest
    for (const [x, z] of [[6, 20], [7, 20], [13, 21], [14, 21], [15, 21], [4, 25], [5, 25], [16, 25], [17, 26], [11, 27], [12, 27]]) if (objFree(x, z) && !occupied[this.idx(x, z)]) { this.bushes.push({ tx: x, tz: z }); occupied[this.idx(x, z)] = 1; }
    for (let i = 0; i < 380; i++) {
      const x = rng.int(3, w - 4), z = rng.int(3, h - 4);
      if (objFree(x, z) && !occupied[this.idx(x, z)] && !inYard(x, z)) { this.rocks.push({ tx: x, tz: z }); occupied[this.idx(x, z)] = 1; }
    }

    // 8. village fence ring with gates ------------------------------------------------------------------
    const fenceAt = (x: number, z: number) => { if (objFree(x, z) && !occupied[this.idx(x, z)]) { this.fences.push({ tx: x, tz: z }); occupied[this.idx(x, z)] = 1; } };
    for (let x = v.x0; x <= v.x1; x++) { if (x < 8 || x > 10) fenceAt(x, v.z1); }
    for (let z = v.z0 + 1; z <= v.z1; z++) { if (z < 8 || z > 9) fenceAt(v.x1, z); }
    for (const b of this.beds()) { const i = this.idx(b[0], b[1]); if (!occupied[i]) occupied[i] = 2; }
    for (const pr of this.props) {
      if (pr.kind === 'lamp' || pr.kind === 'sign' || pr.kind === 'flowerpot') continue;
      const tx = Math.floor(pr.x), tz = Math.floor(pr.z);
      if (!this.houseCell[this.idx(tx, tz)]) occupied[this.idx(tx, tz)] = 1;
      if (pr.kind === 'stall') { occupied[this.idx(tx - 1, tz)] = 1; occupied[this.idx(tx + 1, tz)] = 1; }
    }

    // 9. flowers ---------------------------------------------------------------------------------------
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
      if (get(x, z) === Tile.Grass && !this.treeCell[this.idx(x, z)] && !occupied[this.idx(x, z)] && rng.next() < 0.05) set(x, z, Tile.Flowers);
    }

    // solidity ----------------------------------------------------------------------------------------
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
      const i = this.idx(x, z);
      const t = this.tiles[i];
      const s = t === Tile.Water || t === Tile.Cliff || this.treeCell[i] === 1 || this.houseCell[i] === 1 || occupied[i] >= 1;
      this.solid[i] = s ? 1 : 0;
      this.tall[i] = (t === Tile.Cliff || this.treeCell[i] === 1 || this.houseCell[i] === 1 || occupied[i] >= 1) ? 1 : 0;
    }

    // 10. enemy spawns: procedural, denser further from the village ---------------------------------------
    const kinds: EnemyKind[] = ['sword', 'sword', 'sword', 'spear', 'spear', 'javelin', 'archer'];
    let tries = 0;
    while (this.spawns.length < 110 && tries++ < 20000) {
      const x = rng.int(4, w - 5), z = rng.int(4, h - 5);
      const dv = Math.hypot(x - 10, z - 9);
      if (dv < 26) continue;
      if (this.isSolidTile(x, z) || get(x, z) === Tile.Water || get(x, z) === Tile.Bridge) continue;
      if (this.spawns.some((s) => Math.hypot(s.x - x, s.z - z) < 7)) continue;
      const far = Math.min(1, (dv - 26) / 120);
      const kind = far > rng.next() * 1.4 ? rng.pick(kinds) : rng.pick(['sword', 'sword', 'spear'] as EnemyKind[]);
      this.spawns.push({ x: x + 0.5, z: z + 0.5, kind });
    }
  }

  private generateHeights() {
    const W = this.w + 1, H = this.h + 1;
    const lvl = new Float32Array(W * H); // in levels
    const rng = new RNG(777);
    const smoothstep = (a: number, b: number, v: number) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
    const plateau = (x0: number, z0: number, x1: number, z1: number, levels: number, fall: number) => {
      for (let cz = Math.max(0, z0 - fall - 2); cz < Math.min(H, z1 + fall + 3); cz++) for (let cx = Math.max(0, x0 - fall - 2); cx < Math.min(W, x1 + fall + 3); cx++) {
        const dx = Math.max(x0 - cx, 0, cx - x1), dz = Math.max(z0 - cz, 0, cz - z1);
        const d = Math.hypot(dx, dz);
        lvl[cz * W + cx] = Math.max(lvl[cz * W + cx], levels * (1 - smoothstep(0, fall, d)));
      }
    };
    const hill = (x: number, z: number, rx: number, rz: number, levels: number) => {
      for (let cz = Math.max(0, z - rz - 2); cz < Math.min(H, z + rz + 3); cz++) for (let cx = Math.max(0, x - rx - 2); cx < Math.min(W, x + rx + 3); cx++) {
        const d = Math.hypot((cx - x) / rx, (cz - z) / rz);
        lvl[cz * W + cx] = Math.max(lvl[cz * W + cx], levels * (1 - smoothstep(0.45, 1.05, d)));
      }
    };
    // NE highland: broad terraces with cliff faces; the road climbs it at x~160 (ramp carved below)
    plateau(150, 0, 208, 40, 2, 1.4);
    plateau(168, 0, 208, 24, 3.5, 1.4);
    plateau(186, 0, 208, 12, 5, 1.4);
    // SE ridge and south hills
    plateau(150, 160, 208, 176, 2, 1.6);
    hill(28, 158, 14, 7, 2); hill(96, 166, 12, 6, 1.5); hill(120, 158, 8, 5, 1.2);
    // western hills
    hill(18, 44, 7, 5, 1.6); hill(70, 70, 10, 7, 1.4); hill(20, 100, 8, 6, 1.6); hill(84, 34, 8, 5, 1.2);
    // mid-map mesa (between the roads)
    plateau(76, 56, 96, 68, 1.5, 2.2);
    // rolling meadow noise
    for (let cz = 0; cz < H; cz++) for (let cx = 0; cx < W; cx++) {
      lvl[cz * W + cx] += 0.22 * Math.sin(cx * 0.31 + 1.3) * Math.cos(cz * 0.27 + 0.4) + 0.12 * Math.sin(cx * 0.9) * Math.cos(cz * 0.8) + (rng.next() - 0.5) * 0.05;
    }
    // village terrace
    const v = this.village;
    for (let cz = 0; cz < H; cz++) for (let cx = 0; cx < W; cx++) {
      const i = cz * W + cx;
      const inside = cx >= v.x0 && cx <= v.x1 + 1 && cz >= v.z0 && cz <= v.z1 + 1;
      if (inside) { lvl[i] = 1.6; continue; }
      const dx = Math.max(v.x0 - cx, 0, cx - (v.x1 + 1)), dz = Math.max(v.z0 - cz, 0, cz - (v.z1 + 1));
      const d = Math.hypot(dx, dz);
      if (d > 8) continue;
      const southGate = cx >= 8 && cx <= 11 && cz > v.z1 + 1;
      const eastGate = cz >= 8 && cz <= 10 && cx > v.x1 + 1;
      const fall = southGate || eastGate ? 4.5 : 1.3;
      lvl[i] = Math.max(lvl[i], 1.6 * (1 - smoothstep(0, fall, d)));
    }
    // ramp for the NE highland where the road climbs (x 158..163, z 40..48)
    for (let cz = 40; cz <= 48; cz++) for (let cx = 157; cx <= 164; cx++) lvl[cz * W + cx] = 2 * smoothstep(48.5, 40, cz);
    // roads: keep them gentle (relax steep local bumps) by blending toward the neighbourhood average
    // (a cheap smoothing pass on corners adjacent to path tiles)
    for (let pass = 0; pass < 2; pass++) for (let cz = 1; cz < H - 1; cz++) for (let cx = 1; cx < W - 1; cx++) {
      const onRoad = [[cx - 1, cz - 1], [cx, cz - 1], [cx - 1, cz], [cx, cz]].some(([x, z]) => this.tile(x, z) === Tile.Path);
      if (!onRoad) continue;
      const i = cz * W + cx;
      const avg = (lvl[i - 1] + lvl[i + 1] + lvl[i - W] + lvl[i + W]) / 4;
      lvl[i] = lvl[i] * 0.4 + avg * 0.6;
    }
    // convert to world units
    for (let i = 0; i < lvl.length; i++) this.hmap[i] = lvl[i] * LEVEL_H;
    // river banks: carve a smooth channel. Corners near water slope down to the river bed over ~3 tiles.
    const bankW = 3.0;
    for (let cz = 0; cz < H; cz++) for (let cx = 0; cx < W; cx++) {
      // corner distance = min of the 4 adjacent tile centre distances (+0.5 tile offset compensation)
      let d = 1e9;
      for (const [x, z] of [[cx - 1, cz - 1], [cx, cz - 1], [cx - 1, cz], [cx, cz]]) if (x >= 0 && z >= 0 && x < this.w && z < this.h) d = Math.min(d, this.riverDist[this.idx(x, z)]);
      if (d > bankW) continue;
      const i = cz * W + cx;
      const t = smoothstep(-0.6, bankW, d); // 0 in the water, 1 at the top of the bank
      const bed = -WATER_DEPTH - 0.15;
      const eased = t * t * (3 - 2 * t);
      // bank height eases from the local meadow height down to the bed; extra dip in the middle of the river
      const meadow = Math.min(this.hmap[i], 0.6); // banks never start higher than a low meadow level
      this.hmap[i] = Math.min(this.hmap[i], bed + (meadow - bed) * eased);
    }
    // bridges: the deck is a separate mesh, so terrain under the deck stays sunk. The abutment tiles and a short
    // causeway on each side are raised so the road climbs gently out of the bank onto the deck.
    for (const b of this.bridges) {
      const alongX = b.x1 - b.x0 > b.z1 - b.z0;
      const lo = alongX ? b.x0 : b.z0, hi = alongX ? b.x1 + 1 : b.z1 + 1;
      const cLo = alongX ? b.z0 : b.x0, cHi = alongX ? b.z1 + 1 : b.x1 + 1;
      for (let a = lo - 4; a <= hi + 4; a++) for (let c = cLo; c <= cHi; c++) {
        const cx = alongX ? a : c, cz = alongX ? c : a;
        if (cx < 0 || cz < 0 || cx > W - 1 || cz > H - 1) continue;
        const i = cz * W + cx;
        if (a > lo + 1 && a < hi - 1) continue; // corners over the water span: leave sunk
        const dist = Math.max(0, lo - a, a - hi);   // tiles away from the abutment (approach ramp)
        const under = a === lo + 1 || a === hi - 1; // water-edge corner: bank keeps sloping down beneath the deck
        const lift = under ? -WATER_DEPTH * 0.6 : -dist * 0.18;
        this.hmap[i] = Math.max(this.hmap[i], Math.min(lift, 0));
      }
    }
    // tiles on steep flanks become Cliff (rock texture, unwalkable); banks stay grass unless very steep
    for (let z = 0; z < this.h; z++) for (let x = 0; x < this.w; x++) {
      const h00 = this.cornerH(x, z), h10 = this.cornerH(x + 1, z), h01 = this.cornerH(x, z + 1), h11 = this.cornerH(x + 1, z + 1);
      const steep = Math.max(Math.abs(h10 - h00), Math.abs(h11 - h01), Math.abs(h01 - h00), Math.abs(h11 - h10)) > MAX_WALK_SLOPE;
      const t = this.tile(x, z);
      if (steep && t !== Tile.Water && t !== Tile.Bridge) this.tiles[this.idx(x, z)] = Tile.Cliff;
    }
  }

  isWaterUnder(tx: number, tz: number): boolean { return this.riverDist[this.idx(tx, tz)] < 0; }

  /** Height of the walkable surface (terrain, or the bridge deck when standing on a bridge) */
  surfaceAt(x: number, z: number): number {
    const tx = Math.floor(x), tz = Math.floor(z);
    if (this.tile(tx, tz) === Tile.Bridge) {
      for (const b of this.bridges) if (tx >= b.x0 && tx <= b.x1 && tz >= b.z0 && tz <= b.z1) {
        // ramp up over the abutment tile
        const alongX = b.x1 - b.x0 > b.z1 - b.z0;
        const p = alongX ? x : z, p0 = alongX ? b.x0 : b.z0, p1 = alongX ? b.x1 + 1 : b.z1 + 1;
        const ramp = Math.min(1, Math.min(p - p0, p1 - p));
        const ground0 = this.heightAt(alongX ? p0 : x, alongX ? z : p0), ground1 = this.heightAt(alongX ? p1 : x, alongX ? z : p1);
        const ground = p - p0 < p1 - p ? ground0 : ground1;
        return ground + (b.y - ground + 0.0) * ramp + (ramp >= 1 ? 0 : 0);
      }
    }
    return this.heightAt(x, z);
  }

  private beds(): [number, number][] {
    const out: [number, number][] = [];
    for (let z = 0; z < this.h; z++) for (let x = 0; x < this.w; x++) if (this.tile(x, z) === Tile.Bed) out.push([x, z]);
    return out;
  }

  private generateVillage(set: (x: number, z: number, t: Tile) => void) {
    // central cobblestone plaza around the well
    for (let z = 6; z <= 11; z++) for (let x = 7; x <= 12; x++) set(x, z, Tile.Cobble);
    // cobbled lanes from plaza to each doorstep and to the south gate
    const lane = (x0: number, z0: number, x1: number, z1: number) => {
      let x = x0, z = z0;
      set(x, z, Tile.Cobble);
      while (x !== x1) { x += Math.sign(x1 - x); set(x, z, Tile.Cobble); }
      while (z !== z1) { z += Math.sign(z1 - z); set(x, z, Tile.Cobble); }
    };
    lane(9, 12, 9, 16);           // south gate
    lane(6, 6, 6, 6); lane(7, 7, 6, 6);
    lane(13, 5, 14, 5); lane(12, 6, 14, 5);
    lane(6, 12, 4, 12); lane(7, 11, 4, 12);
    lane(13, 11, 17, 11); lane(16, 11, 16, 12);
    lane(15, 16, 16, 16);
    lane(12, 9, 20, 9); lane(13, 8, 20, 8);
    // flower beds / vegetable patches
    for (let z = 13; z <= 15; z++) for (let x = 3; x <= 6; x++) set(x, z, Tile.Bed);
    for (let z = 2; z <= 3; z++) for (let x = 9; x <= 10; x++) set(x, z, Tile.Bed);
    for (let x = 10; x <= 12; x++) set(x, 13, Tile.Bed);
    set(3, 7, Tile.Flowers); set(3, 6, Tile.Flowers); set(18, 3, Tile.Flowers); set(19, 4, Tile.Flowers); set(18, 6, Tile.Flowers);
    this.props = [
      { kind: 'well', x: 9.5, z: 8.5 },
      { kind: 'weathercock', x: 11.5, z: 6.5 },
      { kind: 'bench', x: 7.5, z: 9.5, rot: Math.PI / 2 }, { kind: 'bench', x: 11.5, z: 9.5, rot: -Math.PI / 2 },
      { kind: 'lamp', x: 7.5, z: 6.5 }, { kind: 'lamp', x: 12.5, z: 11.5 }, { kind: 'lamp', x: 7.5, z: 12.5 },
      { kind: 'sign', x: 10.5, z: 15.5 }, { kind: 'sign', x: 12.5, z: 5.5 },
      { kind: 'stall', x: 17.5, z: 5.5, rot: Math.PI },
      { kind: 'barrel', x: 19.5, z: 6.5 }, { kind: 'barrel', x: 19.5, z: 10.5 }, { kind: 'crate', x: 13.5, z: 14.5 }, { kind: 'crate', x: 2.5, z: 5.5 },
      { kind: 'flowerpot', x: 3.5, z: 12.5 }, { kind: 'flowerpot', x: 18.5, z: 11.5 }, { kind: 'flowerpot', x: 12.5, z: 4.5 },
    ];
    this.npcs = [
      { id: 'elder', x: 6.5, z: 7.5, facing: 0, wander: 0 },
      { id: 'shopkeeper', x: 17.5, z: 6.6, facing: 0, wander: 0 },
      { id: 'kid', x: 10.5, z: 10.5, facing: 1, wander: 2.5 },
      { id: 'granny', x: 5.5, z: 12.5, facing: 1, wander: 0 },
      { id: 'bard', x: 8.5, z: 11.0, facing: 1, wander: 0 },
      { id: 'farmer', x: 11.5, z: 3.5, facing: 3, wander: 1.5 },
      { id: 'dog', x: 12.5, z: 9.5, facing: 3, wander: 3 },
    ];
  }

  // ---------------------------------------------------------------- textures
  private static C = {
    grass: '#5fae4c', grassL: '#7bc65f', grassD: '#4a9440',
    path: '#d9ab6c', pathD: '#b9884c', pathL: '#ebc890', pathE: '#a67640',
    water: '#3f7ad8', waterL: '#8ec0f5', waterD: '#2d5fc2', shore: '#1e3d8c',
    plank: '#b98450', plankD: '#7e5230', plankL: '#dba86e',
    cliff: '#5c3d22',
    cobble: '#c9b79a', cobbleL: '#e2d4bb', cobbleD: '#a6937a', cobbleE: '#7f6c58',
    soil: '#7a5230', soilL: '#9a6e46', leaf: '#4cbf4c', leafL: '#8ce070',
  };

  private paintGrass(g: CanvasRenderingContext2D, ox: number, oz: number, tx: number, tz: number, flowers: boolean) {
    const C = World.C, T = TEX_PX;
    g.fillStyle = C.grass; g.fillRect(ox, oz, T, T);
    for (let i = 0; i < 6; i++) {
      const x = ox + Math.floor(hash2(tx, tz, i) * T), y = oz + Math.floor(hash2(tx, tz, i + 10) * T);
      g.fillStyle = i % 2 ? C.grassL : C.grassD; g.fillRect(x, y, 1, 1);
    }
    if (hash2(tx, tz, 99) < 0.25) {
      const x = ox + 3 + Math.floor(hash2(tx, tz, 98) * (T - 7)), y = oz + 3 + Math.floor(hash2(tx, tz, 97) * (T - 7));
      g.fillStyle = C.grassD; g.fillRect(x, y, 1, 1); g.fillRect(x + 2, y, 1, 1); g.fillRect(x + 1, y + 1, 1, 1); g.fillRect(x + 1, y - 1, 1, 1);
      g.fillStyle = C.grassL; g.fillRect(x + 3, y - 1, 1, 1);
    }
    if (flowers) {
      const petals = ['#f8f8f8', '#f8d848', '#f07070', '#8aa0f8'];
      for (let k = 0; k < 2; k++) {
        const x = ox + 3 + Math.floor(hash2(tx, tz, 50 + k) * (T - 7)), y = oz + 3 + Math.floor(hash2(tx, tz, 60 + k) * (T - 7));
        const pc = petals[Math.floor(hash2(tx, tz, 70 + k) * petals.length)];
        g.fillStyle = pc; g.fillRect(x - 1, y, 1, 1); g.fillRect(x + 1, y, 1, 1); g.fillRect(x, y - 1, 1, 1); g.fillRect(x, y + 1, 1, 1);
        g.fillStyle = pc === '#f8d848' ? '#e05030' : '#f8d848'; g.fillRect(x, y, 1, 1);
        g.fillStyle = C.grassD; g.fillRect(x - 1, y + 2, 1, 1); g.fillRect(x + 2, y + 1, 1, 1);
      }
    }
  }

  createGroundTexture(): THREE.CanvasTexture {
    const T = TEX_PX, C = World.C;
    const cv = document.createElement('canvas');
    cv.width = this.w * T; cv.height = this.h * T;
    const g = cv.getContext('2d')!;
    const grassy = (t: Tile) => t === Tile.Grass || t === Tile.Flowers;
    const land = (t: Tile) => t !== Tile.Water && t !== Tile.Bridge;
    for (let tz = 0; tz < this.h; tz++) for (let tx = 0; tx < this.w; tx++) {
      const t = this.tile(tx, tz);
      const ox = tx * T, oz = tz * T;
      const N = this.tile(tx, tz - 1), S = this.tile(tx, tz + 1), E = this.tile(tx + 1, tz), W = this.tile(tx - 1, tz);
      if ((t === Tile.Grass || t === Tile.Flowers) && this.riverDist[tz * this.w + tx] < 0.9) {
        // sandy river bank strip
        g.fillStyle = '#d9c48c'; g.fillRect(ox, oz, T, T);
        for (let i = 0; i < 6; i++) { g.fillStyle = i % 2 ? '#e8d6a2' : '#bfa66c'; g.fillRect(ox + Math.floor(hash2(tx, tz, i) * T), oz + Math.floor(hash2(tx, tz, i + 20) * T), 1, 1); }
        if (hash2(tx, tz, 44) < 0.3) { g.fillStyle = '#9aa0a8'; const x = ox + Math.floor(hash2(tx, tz, 45) * (T - 3)), y = oz + Math.floor(hash2(tx, tz, 46) * (T - 2)); g.fillRect(x, y, 3, 2); g.fillStyle = '#c9ced4'; g.fillRect(x, y, 1, 1); }
      } else if (t === Tile.Grass || t === Tile.Flowers) {
        this.paintGrass(g, ox, oz, tx, tz, t === Tile.Flowers);
      } else if (t === Tile.Path) {
        g.fillStyle = C.path; g.fillRect(ox, oz, T, T);
        for (let i = 0; i < 7; i++) {
          const x = ox + Math.floor(hash2(tx, tz, i) * (T - 1)), y = oz + Math.floor(hash2(tx, tz, i + 20) * T);
          g.fillStyle = i % 3 === 0 ? C.pathL : C.pathD; g.fillRect(x, y, hash2(tx, tz, i + 40) < 0.4 ? 2 : 1, 1);
        }
        const depth = (k: number, s: number) => 1 + (hash2(k, s, 5) < 0.45 ? 1 : 0) + (hash2(k, s, 6) < 0.15 ? 1 : 0);
        if (grassy(N)) for (let x = 0; x < T; x++) { const d = depth(tx * T + x, tz * 7 + 1); g.fillStyle = C.grass; g.fillRect(ox + x, oz, 1, d); g.fillStyle = C.pathE; g.fillRect(ox + x, oz + d, 1, 1); }
        if (grassy(S)) for (let x = 0; x < T; x++) { const d = depth(tx * T + x, tz * 7 + 2); g.fillStyle = C.grass; g.fillRect(ox + x, oz + T - d, 1, d); g.fillStyle = C.pathE; g.fillRect(ox + x, oz + T - d - 1, 1, 1); }
        if (grassy(W)) for (let y = 0; y < T; y++) { const d = depth(tz * T + y, tx * 7 + 3); g.fillStyle = C.grass; g.fillRect(ox, oz + y, d, 1); g.fillStyle = C.pathE; g.fillRect(ox + d, oz + y, 1, 1); }
        if (grassy(E)) for (let y = 0; y < T; y++) { const d = depth(tz * T + y, tx * 7 + 4); g.fillStyle = C.grass; g.fillRect(ox + T - d, oz + y, d, 1); g.fillStyle = C.pathE; g.fillRect(ox + T - d - 1, oz + y, 1, 1); }
        g.fillStyle = C.grass;
        if (!grassy(N) && !grassy(W) && grassy(this.tile(tx - 1, tz - 1))) g.fillRect(ox, oz, 2, 2);
        if (!grassy(N) && !grassy(E) && grassy(this.tile(tx + 1, tz - 1))) g.fillRect(ox + T - 2, oz, 2, 2);
        if (!grassy(S) && !grassy(W) && grassy(this.tile(tx - 1, tz + 1))) g.fillRect(ox, oz + T - 2, 2, 2);
        if (!grassy(S) && !grassy(E) && grassy(this.tile(tx + 1, tz + 1))) g.fillRect(ox + T - 2, oz + T - 2, 2, 2);
      } else if (t === Tile.Water) {
        g.fillStyle = C.water; g.fillRect(ox, oz, T, T);
        for (let i = 0; i < 3; i++) {
          const x = ox + Math.floor(hash2(tx, tz, i) * (T - 6)), y = oz + 2 + Math.floor(hash2(tx, tz, i + 30) * (T - 4));
          const len = 3 + Math.floor(hash2(tx, tz, i + 60) * 3);
          g.fillStyle = i === 0 ? C.waterL : C.waterD; g.fillRect(x, y, len, 1);
          if (i === 0) g.fillRect(x + 1, y + 1, 1, 1);
        }
        if (land(N)) { g.fillStyle = C.shore; g.fillRect(ox, oz, T, 1); g.fillStyle = C.waterL; g.fillRect(ox, oz + 1, T, 1); }
        if (land(S)) { g.fillStyle = C.shore; g.fillRect(ox, oz + T - 1, T, 1); g.fillStyle = C.waterL; g.fillRect(ox, oz + T - 2, T, 1); }
        if (land(W)) { g.fillStyle = C.shore; g.fillRect(ox, oz, 1, T); g.fillStyle = C.waterL; g.fillRect(ox + 1, oz, 1, T); }
        if (land(E)) { g.fillStyle = C.shore; g.fillRect(ox + T - 1, oz, 1, T); g.fillStyle = C.waterL; g.fillRect(ox + T - 2, oz, 1, T); }
        g.fillStyle = C.shore;
        if (!land(N) && !land(W) && land(this.tile(tx - 1, tz - 1))) g.fillRect(ox, oz, 2, 2);
        if (!land(N) && !land(E) && land(this.tile(tx + 1, tz - 1))) g.fillRect(ox + T - 2, oz, 2, 2);
        if (!land(S) && !land(W) && land(this.tile(tx - 1, tz + 1))) g.fillRect(ox, oz + T - 2, 2, 2);
        if (!land(S) && !land(E) && land(this.tile(tx + 1, tz + 1))) g.fillRect(ox + T - 2, oz + T - 2, 2, 2);
      } else if (t === Tile.Bridge && this.riverDist[tz * this.w + tx] >= 0) {
        // bridge abutment on land: packed earth
        g.fillStyle = C.pathD; g.fillRect(ox, oz, T, T);
        for (let i = 0; i < 5; i++) { g.fillStyle = i % 2 ? C.path : C.pathE; g.fillRect(ox + Math.floor(hash2(tx, tz, i) * T), oz + Math.floor(hash2(tx, tz, i + 20) * T), 2, 1); }
      } else if (t === Tile.Bridge) {
        // over water: the deck is a separate mesh, the ground below is river bed
        g.fillStyle = C.waterD; g.fillRect(ox, oz, T, T);
      } else if (t === Tile.Cliff) {
        // rocky slope face
        g.fillStyle = '#a97a4c'; g.fillRect(ox, oz, T, T);
        for (let i = 0; i < 7; i++) {
          const x = ox + Math.floor(hash2(tx, tz, i) * T), y = oz + Math.floor(hash2(tx, tz, i + 2) * (T - 2)), len = 2 + Math.floor(hash2(tx, tz, i + 3) * 5);
          g.fillStyle = '#7d5030'; g.fillRect(x, y, len, 1); g.fillRect(x + len, y + 1, 1, 1);
          g.fillStyle = '#cf9e6c'; g.fillRect(x, y - 1, 1, 1);
        }
        for (let i = 0; i < 4; i++) { g.fillStyle = '#5a3a1e'; g.fillRect(ox + Math.floor(hash2(tx, tz, i + 8) * T), oz + Math.floor(hash2(tx, tz, i + 9) * T), 1, 1); }
        if (hash2(tx, tz, 55) < 0.35) { g.fillStyle = C.grassD; const x = ox + Math.floor(hash2(tx, tz, 56) * (T - 3)), y = oz + Math.floor(hash2(tx, tz, 57) * (T - 3)); g.fillRect(x, y, 1, 2); g.fillRect(x + 2, y + 1, 1, 1); }
      } else if (t === Tile.Cobble) {
        // large flagstones with darker grout, LA-style plaza
        g.fillStyle = C.cobbleE; g.fillRect(ox, oz, T, T);
        const stones = [[0, 0, 9, 9], [10, 0, 10, 6], [10, 7, 10, 6], [0, 10, 6, 10], [7, 10, 13, 10]];
        stones.forEach(([sx, sy, sw, sh], i) => {
          g.fillStyle = hash2(tx, tz, i) < 0.5 ? C.cobble : C.cobbleL; g.fillRect(ox + sx + 1, oz + sy + 1, sw - 1, sh - 1);
          g.fillStyle = C.cobbleD; g.fillRect(ox + sx + 1, oz + sy + sh - 1, sw - 1, 1); g.fillRect(ox + sx + sw - 1, oz + sy + 1, 1, sh - 1);
          g.fillStyle = '#f2e8d4'; g.fillRect(ox + sx + 1, oz + sy + 1, sw - 2, 1);
        });
        if (hash2(tx, tz, 77) < 0.3) { g.fillStyle = C.grassD; g.fillRect(ox + Math.floor(hash2(tx, tz, 78) * (T - 2)), oz + Math.floor(hash2(tx, tz, 79) * (T - 2)), 1, 2); }
      } else if (t === Tile.Bed) {
        // tilled soil rows with little plants
        g.fillStyle = C.soil; g.fillRect(ox, oz, T, T);
        for (let y = 2; y < T; y += 5) { g.fillStyle = C.soilL; g.fillRect(ox, oz + y, T, 1); g.fillStyle = '#5a3a1e'; g.fillRect(ox, oz + y + 3, T, 1); }
        for (let i = 0; i < 4; i++) {
          const x = ox + 2 + (i * 5) % (T - 3), y = oz + 3 + Math.floor(hash2(tx, tz, i) * 3) * 5;
          const c = hash2(tx, tz, i + 8) < 0.5 ? C.leaf : C.leafL;
          g.fillStyle = c; g.fillRect(x - 1, y, 3, 1); g.fillRect(x, y - 1, 1, 3);
          if (hash2(tx, tz, i + 16) < 0.3) { g.fillStyle = '#ff6a3d'; g.fillRect(x, y, 1, 1); }
        }
        g.fillStyle = '#5a3a1e'; g.fillRect(ox, oz, T, 1); g.fillRect(ox, oz, 1, T);
      }
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /** Heightmapped ground mesh (one quad per tile, split along the shorter diagonal, UVs into the ground atlas) */
  createGroundGeometry(): THREE.BufferGeometry {
    const w = this.w, h = this.h;
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
      const base = pos.length / 3;
      const cs = [[x, z], [x + 1, z], [x, z + 1], [x + 1, z + 1]];
      for (const [cx, cz] of cs) { pos.push(cx, this.cornerH(cx, cz), cz); uv.push(cx / w, 1 - cz / h); }
      const d1 = Math.abs(this.cornerH(x, z) - this.cornerH(x + 1, z + 1)), d2 = Math.abs(this.cornerH(x + 1, z) - this.cornerH(x, z + 1));
      if (d1 <= d2) idx.push(base, base + 2, base + 3, base, base + 3, base + 1);
      else idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  /** Wooden bridge decks with side rails, built as one merged geometry per material */
  createBridgeMeshes(): THREE.Object3D[] {
    const plank = new THREE.MeshToonMaterial({ color: '#b98450', gradientMap: getGradientMapRef() });
    const dark = new THREE.MeshToonMaterial({ color: '#7e5230', gradientMap: getGradientMapRef() });
    const group = new THREE.Group();
    for (const b of this.bridges) {
      const alongX = b.x1 - b.x0 > b.z1 - b.z0;
      const len = alongX ? b.x1 - b.x0 + 1 : b.z1 - b.z0 + 1;
      const wid = alongX ? b.z1 - b.z0 + 1 : b.x1 - b.x0 + 1;
      const cx = (b.x0 + b.x1 + 1) / 2, cz = (b.z0 + b.z1 + 1) / 2;
      const g = new THREE.Group();
      g.position.set(cx, 0, cz);
      g.rotation.y = alongX ? 0 : Math.PI / 2;
      // deck: slightly arched (3 segments), planks across
      const segs = 3;
      for (let i = 0; i < segs; i++) {
        const t0 = i / segs, t1 = (i + 1) / segs;
        const x0 = -len / 2 + len * t0, x1 = -len / 2 + len * t1;
        const arch = (t: number) => b.y + Math.sin(t * Math.PI) * 0.12;
        const y0 = arch(t0), y1 = arch(t1);
        const segLen = Math.hypot(x1 - x0, y1 - y0);
        const deck = new THREE.Mesh(new THREE.BoxGeometry(segLen, 0.12, wid - 0.1), plank);
        deck.position.set((x0 + x1) / 2, (y0 + y1) / 2 - 0.06, 0);
        deck.rotation.z = Math.atan2(y1 - y0, x1 - x0);
        g.add(deck);
        // plank grooves
        for (let k = 0; k < Math.floor(segLen / 0.5); k++) {
          const groove = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.02, wid - 0.1), dark);
          const t = (k + 0.5) / Math.floor(segLen / 0.5);
          groove.position.set(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t + 0.005, 0);
          groove.rotation.z = deck.rotation.z;
          g.add(groove);
        }
      }
      // rails & posts on both sides
      for (const side of [-1, 1]) {
        const zr = side * (wid / 2 - 0.12);
        const n = Math.round(len / 1.5);
        for (let k = 0; k <= n; k++) {
          const t = k / n, x = -len / 2 + 0.15 + (len - 0.3) * t;
          const y = b.y + Math.sin(t * Math.PI) * 0.12;
          const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.55, 0.12), dark);
          post.position.set(x, y + 0.27, zr);
          g.add(post);
        }
        for (let i = 0; i < segs; i++) {
          const t0 = i / segs, t1 = (i + 1) / segs;
          const x0 = -len / 2 + 0.15 + (len - 0.3) * t0, x1 = -len / 2 + 0.15 + (len - 0.3) * t1;
          const y0 = b.y + Math.sin(t0 * Math.PI) * 0.12 + 0.5, y1 = b.y + Math.sin(t1 * Math.PI) * 0.12 + 0.5;
          const rail = new THREE.Mesh(new THREE.BoxGeometry(Math.hypot(x1 - x0, y1 - y0), 0.07, 0.1), plank);
          rail.position.set((x0 + x1) / 2, (y0 + y1) / 2, zr);
          rail.rotation.z = Math.atan2(y1 - y0, x1 - x0);
          g.add(rail);
        }
      }
      // support pillars into the water
      for (let k = 1; k < Math.round(len / 3); k++) {
        const x = -len / 2 + (len / Math.round(len / 3)) * k;
        for (const side of [-1, 1]) {
          const px = alongX ? cx + x : cx + side * (wid / 2 - 0.3), pz = alongX ? cz + side * (wid / 2 - 0.3) : cz + x;
          const ground = this.heightAt(px, pz);
          const pil = new THREE.Mesh(new THREE.BoxGeometry(0.2, b.y - ground + 0.3, 0.2), dark);
          pil.position.set(x, (b.y + ground) / 2 - 0.05, side * (wid / 2 - 0.3));
          g.add(pil);
        }
      }
      group.add(g);
    }
    return [group];
  }

  createGrassTileTexture(): THREE.CanvasTexture {
    const cv = document.createElement('canvas'); cv.width = TEX_PX; cv.height = TEX_PX;
    const g = cv.getContext('2d')!;
    this.paintGrass(g, 0, 0, 7, 7, false);
    const tex = new THREE.CanvasTexture(cv);
    tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false; tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  createCliffSideTexture(): THREE.CanvasTexture {
    const T = TEX_PX;
    const cv = document.createElement('canvas'); cv.width = T; cv.height = T;
    const g = cv.getContext('2d')!;
    g.fillStyle = '#b57e4c'; g.fillRect(0, 0, T, T);
    g.fillStyle = '#d6a678'; g.fillRect(0, 0, T, 2);
    g.fillStyle = '#5a3a1e'; g.fillRect(0, T - 3, T, 3);
    g.fillStyle = '#3a2410'; g.fillRect(0, T - 1, T, 1);
    for (let i = 0; i < 7; i++) {
      const x = Math.floor(hash2(i, 1) * T), y = 3 + Math.floor(hash2(i, 2) * (T - 8)), len = 2 + Math.floor(hash2(i, 3) * 4);
      g.fillStyle = '#7d5030'; g.fillRect(x, y, len, 1); g.fillRect(x + len, y + 1, 1, 1);
      g.fillStyle = '#c99a66'; g.fillRect(x, y - 1, 1, 1);
    }
    for (let i = 0; i < 5; i++) { g.fillStyle = '#c99060'; g.fillRect(Math.floor(hash2(i, 8) * T), 3 + Math.floor(hash2(i, 9) * (T - 7)), 1, 1); }
    const tex = new THREE.CanvasTexture(cv);
    tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false; tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  createWaveTexture(): THREE.CanvasTexture {
    const S = 40;
    const cv = document.createElement('canvas'); cv.width = S; cv.height = S;
    const g = cv.getContext('2d')!;
    g.clearRect(0, 0, S, S);
    for (let k = 0; k < 4; k++) {
      const y0 = 4 + k * 10;
      for (let x = 0; x < S; x++) {
        if ((x + k * 5) % 13 >= 8) continue;
        const y = y0 + Math.round(Math.sin(((x + k * 7) / S) * Math.PI * 4) * 1.5);
        g.fillStyle = 'rgba(190,225,255,0.95)'; g.fillRect(x, y, 1, 1);
        g.fillStyle = 'rgba(30,70,170,0.6)'; g.fillRect(x, y + 1, 1, 1);
      }
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false;
    tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping; tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
}
