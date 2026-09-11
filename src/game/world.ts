import * as THREE from 'three';
import { MAP_W, MAP_H, TEX_PX, Tile, RNG, hash2 } from './constants';

export type EnemyKind = 'sword' | 'spear' | 'javelin' | 'archer';
export interface TreeSpec { x: number; z: number; scale: number }
export interface TileObj { tx: number; tz: number }
export interface HouseSpec { x: number; z: number; w: number; d: number }
export interface SpawnSpec { x: number; z: number; kind: EnemyKind }
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
  trees: TreeSpec[] = [];
  bushes: TileObj[] = [];
  rocks: TileObj[] = [];
  fences: TileObj[] = [];
  houses: HouseSpec[] = [{ x: 7, z: 5, w: 5, d: 3 }];
  spawns: SpawnSpec[] = [];
  playerStart: Vec2 = { x: 9.5, z: 10.5 };
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

  boxCollides(x: number, z: number, hw: number, hh: number): boolean {
    const x0 = Math.floor(x - hw + 1e-4), x1 = Math.floor(x + hw - 1e-4);
    const z0 = Math.floor(z - hh + 1e-4), z1 = Math.floor(z + hh - 1e-4);
    for (let tz = z0; tz <= z1; tz++) for (let tx = x0; tx <= x1; tx++) if (this.isSolidTile(tx, tz)) return true;
    return false;
  }

  /** Move an AABB through the tile map with axis separation + Zelda-style corner nudging. */
  moveBox(p: Vec2, dx: number, dz: number, hw: number, hh: number, nudge = 0): { bx: boolean; bz: boolean } {
    let bx = false, bz = false;
    if (dx !== 0) {
      if (!this.boxCollides(p.x + dx, p.z, hw, hh)) p.x += dx;
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
      if (!this.boxCollides(p.x, p.z + dz, hw, hh)) p.z += dz;
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
  private generate() {
    const { w, h, rng } = this;
    const set = (x: number, z: number, t: Tile) => { if (x >= 0 && z >= 0 && x < w && z < h) this.tiles[z * w + x] = t; };
    const get = (x: number, z: number) => this.tile(x, z);

    // 1. water: river + pond
    const river = [[30, -3], [29, 7], [33, 13], [31, 21], [35, 29], [33, 38], [36, 47]];
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
      const cx = x + 0.5, cz = z + 0.5;
      const d = polyDist(cx, cz, river) + (rng.next() - 0.5) * 0.5;
      if (d < 1.7) set(x, z, Tile.Water);
      const ex = (cx - 10.5) / 4.3, ez = (cz - 30.5) / 3.1;
      if (ex * ex + ez * ez < 1 + (rng.next() - 0.5) * 0.3) set(x, z, Tile.Water);
    }
    // 2. paths
    const paths = [
      [[9.5, 8], [9.5, 15.5], [32.5, 15.5]],
      [[33, 15.5], [45.5, 15.5], [45.5, 26.5], [40.5, 31.5], [37, 31.5]],
      [[34, 31.5], [20.5, 31.5], [20.5, 38.5]],
      [[9.5, 15.5], [9.5, 22.5], [15.5, 26.5]],
      [[20.5, 31.5], [18.5, 24.5]],
    ];
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
      if (get(x, z) !== Tile.Grass) continue;
      const cx = x + 0.5, cz = z + 0.5;
      for (const p of paths) if (polyDist(cx, cz, p) < 1.1) { set(x, z, Tile.Path); break; }
    }
    // 3. bridges
    for (const z of [14, 15, 16]) for (let x = 26; x < 40; x++) if (get(x, z) === Tile.Water) set(x, z, Tile.Bridge);
    for (const z of [30, 31, 32]) for (let x = 28; x < 44; x++) if (get(x, z) === Tile.Water) set(x, z, Tile.Bridge);
    // 4. cliffs
    const cliffRects = [[40, 2, 10, 5], [46, 7, 4, 4], [2, 36, 12, 6], [22, 40, 6, 2], [39, 40, 5, 2]];
    for (const [rx, rz, rw, rd] of cliffRects) for (let z = rz; z < rz + rd; z++) for (let x = rx; x < rx + rw; x++) set(x, z, Tile.Cliff);
    // 5. house
    for (const hs of this.houses) for (let z = hs.z; z < hs.z + hs.d; z++) for (let x = hs.x; x < hs.x + hs.w; x++) {
      set(x, z, Tile.Grass); this.houseCell[this.idx(x, z)] = 1;
    }
    // 6. trees
    const inYard = (x: number, z: number) => x >= 4 && x <= 15 && z >= 2 && z <= 13;
    const nearSpawn = (x: number, z: number) => Math.hypot(x + 0.5 - this.playerStart.x, z + 0.5 - this.playerStart.z) < 3;
    const treeOK = (x: number, z: number) => get(x, z) === Tile.Grass && !this.houseCell[this.idx(x, z)] && !inYard(x, z) && !nearSpawn(x, z);
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
      const ring = Math.min(x, z, w - 1 - x, h - 1 - z);
      if (ring < 2) { if (get(x, z) !== Tile.Water) this.treeCell[this.idx(x, z)] = 1; continue; }
      if (ring <= 4 && treeOK(x, z)) {
        const p = [0.6, 0.32, 0.12][ring - 2];
        if (rng.next() < p) this.treeCell[this.idx(x, z)] = 1;
      }
    }
    const groves = [
      { x: 21, z: 23, r: 5.5, p: 0.55 }, { x: 43, z: 37, r: 4.5, p: 0.55 }, { x: 24, z: 5, r: 4, p: 0.5 },
      { x: 6, z: 22, r: 3.5, p: 0.55 }, { x: 16, z: 40, r: 3, p: 0.5 }, { x: 34, z: 22, r: 3, p: 0.4 },
    ];
    for (const g of groves) for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - g.x, z - g.z) + (rng.next() - 0.5) * 1.5;
      if (d < g.r && treeOK(x, z) && rng.next() < g.p) this.treeCell[this.idx(x, z)] = 1;
    }
    for (let i = 0; i < 30; i++) {
      const x = rng.int(3, w - 4), z = rng.int(3, h - 4);
      if (treeOK(x, z)) this.treeCell[this.idx(x, z)] = 1;
    }
    // group into 2x2 big trees
    const claimed = new Uint8Array(w * h);
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
      const i = this.idx(x, z);
      if (!this.treeCell[i] || claimed[i]) continue;
      const canBig = x + 1 < w && z + 1 < h && this.treeCell[this.idx(x + 1, z)] && this.treeCell[this.idx(x, z + 1)] && this.treeCell[this.idx(x + 1, z + 1)]
        && !claimed[this.idx(x + 1, z)] && !claimed[this.idx(x, z + 1)] && !claimed[this.idx(x + 1, z + 1)];
      if (canBig) {
        claimed[i] = claimed[this.idx(x + 1, z)] = claimed[this.idx(x, z + 1)] = claimed[this.idx(x + 1, z + 1)] = 1;
        this.trees.push({ x: x + 1, z: z + 1.55, scale: 1 });
      } else {
        claimed[i] = 1;
        this.trees.push({ x: x + 0.5, z: z + 0.8, scale: 0.6 });
      }
    }
    // 7. bushes
    const bushClusters = [[16, 9], [27, 19], [40, 21], [27, 35], [15, 33], [37, 8], [8, 17], [30, 25], [20, 12], [44, 29], [12, 24], [33, 5]];
    const patterns = [[[0, 0], [1, 0], [2, 0]], [[0, 0], [0, 1], [0, 2]], [[0, 0], [1, 0], [0, 1], [1, 1]], [[0, 0], [1, 0], [2, 0], [0, 1]], [[0, 0], [2, 0], [1, 1]]];
    const objFree = (x: number, z: number) => (get(x, z) === Tile.Grass || get(x, z) === Tile.Flowers) && !this.treeCell[this.idx(x, z)] && !this.houseCell[this.idx(x, z)] && !nearSpawn(x, z);
    const occupied = new Uint8Array(w * h);
    for (const [bx, bz] of bushClusters) {
      const pat = rng.pick(patterns);
      for (const [ox, oz] of pat) {
        const x = bx + ox, z = bz + oz;
        if (objFree(x, z) && !occupied[this.idx(x, z)]) { this.bushes.push({ tx: x, tz: z }); occupied[this.idx(x, z)] = 1; }
      }
    }
    // 8. rocks
    for (let i = 0; i < 26; i++) {
      const x = rng.int(3, w - 4), z = rng.int(3, h - 4);
      if (objFree(x, z) && !occupied[this.idx(x, z)] && !inYard(x, z)) { this.rocks.push({ tx: x, tz: z }); occupied[this.idx(x, z)] = 1; }
    }
    // 9. fences around the yard
    const fenceAt = (x: number, z: number) => { if (objFree(x, z) && !occupied[this.idx(x, z)]) { this.fences.push({ tx: x, tz: z }); occupied[this.idx(x, z)] = 1; } };
    for (let x = 5; x <= 14; x++) if (x < 8 || x > 10) fenceAt(x, 12);
    for (let z = 4; z <= 12; z++) { fenceAt(5, z); fenceAt(14, z); }
    // 10. flowers
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
      if (get(x, z) === Tile.Grass && !this.treeCell[this.idx(x, z)] && !occupied[this.idx(x, z)] && rng.next() < 0.05) set(x, z, Tile.Flowers);
    }
    // solidity
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
      const i = this.idx(x, z);
      const t = this.tiles[i];
      const s = t === Tile.Water || t === Tile.Cliff || this.treeCell[i] === 1 || this.houseCell[i] === 1 || occupied[i] === 1;
      this.solid[i] = s ? 1 : 0;
      this.tall[i] = (t === Tile.Cliff || this.treeCell[i] === 1 || this.houseCell[i] === 1 || occupied[i] === 1) ? 1 : 0;
    }
    // 11. enemy spawns
    const raw: SpawnSpec[] = [
      { x: 22.5, z: 13.5, kind: 'sword' }, { x: 28.5, z: 20.5, kind: 'sword' }, { x: 14.5, z: 23.5, kind: 'sword' },
      { x: 24.5, z: 33.5, kind: 'sword' }, { x: 44.5, z: 19.5, kind: 'sword' }, { x: 36.5, z: 18.5, kind: 'sword' },
      { x: 37.5, z: 11.5, kind: 'spear' }, { x: 43.5, z: 24.5, kind: 'spear' }, { x: 30.5, z: 36.5, kind: 'spear' }, { x: 16.5, z: 20.5, kind: 'spear' },
      { x: 18.5, z: 29.5, kind: 'javelin' }, { x: 40.5, z: 27.5, kind: 'javelin' }, { x: 13.5, z: 17.5, kind: 'javelin' },
      { x: 43.5, z: 12.5, kind: 'archer' }, { x: 38.5, z: 35.5, kind: 'archer' }, { x: 26.5, z: 39.5, kind: 'archer' }, { x: 47.5, z: 33.5, kind: 'archer' },
    ];
    for (const s of raw) { const p = this.nearestFree(s.x, s.z); this.spawns.push({ x: p.x, z: p.z, kind: s.kind }); }
  }

  // ---------------------------------------------------------------- textures
  private static C = {
    grass: '#5fae4c', grassL: '#7bc65f', grassD: '#4a9440',
    path: '#d9ab6c', pathD: '#b9884c', pathL: '#ebc890', pathE: '#a67640',
    water: '#3f7ad8', waterL: '#8ec0f5', waterD: '#2d5fc2', shore: '#1e3d8c',
    plank: '#b98450', plankD: '#7e5230', plankL: '#dba86e',
    cliff: '#5c3d22',
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
      if (t === Tile.Grass || t === Tile.Flowers) {
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
      } else if (t === Tile.Bridge) {
        g.fillStyle = C.plank; g.fillRect(ox, oz, T, T);
        for (let x = 0; x < T; x += 5) { g.fillStyle = C.plankD; g.fillRect(ox + x, oz, 1, T); g.fillStyle = C.plankL; g.fillRect(ox + x + 1, oz, 1, T); }
        for (let i = 0; i < 3; i++) { g.fillStyle = C.plankD; g.fillRect(ox + Math.floor(hash2(tx, tz, i) * T), oz + Math.floor(hash2(tx, tz, i + 9) * T), 1, 1); }
        if (N === Tile.Water) { g.fillStyle = C.plankD; g.fillRect(ox, oz, T, 2); g.fillStyle = C.plankL; g.fillRect(ox, oz + 2, T, 1); }
        if (S === Tile.Water) { g.fillStyle = C.plankD; g.fillRect(ox, oz + T - 2, T, 2); g.fillStyle = C.plankL; g.fillRect(ox, oz + T - 3, T, 1); }
      } else if (t === Tile.Cliff) {
        g.fillStyle = C.cliff; g.fillRect(ox, oz, T, T);
      }
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
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
