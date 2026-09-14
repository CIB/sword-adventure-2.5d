import * as THREE from 'three';
import { getGradientMap as getGradientMapRef } from './models';
import { MAP_W, MAP_H, TEX_PX, Tile, RNG, hash2, LEVEL_H, MAX_WALK_SLOPE, WATER_DEPTH, BRIDGE_H } from './constants';

export type EnemyKind = 'sword' | 'spear' | 'javelin' | 'archer';
export interface TreeSpec { x: number; z: number; scale: number; y?: number; kind?: 'oak' | 'pine' | 'autumn' | 'birch' | 'blossom' }
export interface TileObj { tx: number; tz: number; v?: number }
export interface HouseSpec { x: number; z: number; w: number; d: number; roof?: string; wall?: string; door?: 'S' | 'E' | 'W'; sign?: 'shop' | 'inn' | 'none' }
export type PropKind = 'well' | 'sign' | 'stall' | 'bench' | 'weathercock' | 'lamp' | 'barrel' | 'crate' | 'flowerpot' | 'hedge'
  | 'log' | 'menhir' | 'cart' | 'hay' | 'scarecrow' | 'campfire' | 'tent' | 'banner' | 'tower' | 'ruinwall' | 'pillar' | 'crown'
  | 'windmill' | 'anvil' | 'forge' | 'cauldron' | 'grave' | 'deadtree' | 'reeds' | 'rosebush' | 'beehive' | 'wheelbarrow' | 'statue' | 'mushroom' | 'amberrock';
export interface PropSpec { kind: PropKind; x: number; z: number; rot?: number }
export interface NpcSpec { id: string; x: number; z: number; facing?: 0 | 1 | 2 | 3; wander?: number }
/** how tightly a post's guards hold their ground */
export type PostStyle = 'cluster' | 'spread';
/**
 * A guard post: a patch of the world a handful of soldiers hold. They don't march routes — they
 * stand guard and wander their own area (tightly on a bridge, loosely through a wood), and when one
 * falls the post recruits a replacement, who walks in from off the map along the roads.
 * WorldState resolves the area into guard spots and pathfinds the reinforcement route.
 */
export interface PostSpec {
  name: string;
  /** area centre in tile coords */
  at: [number, number];
  /** area radii in tiles (an ellipse) */
  rx: number;
  rz: number;
  /** 'cluster' holds a tight knot (bridges, camps); 'spread' roams the patch, 2D-Zelda style */
  style: PostStyle;
  kinds: EnemyKind[];
  /** map-edge entry (see World.edgeEntries) that reinforcements arrive at; null = no replacements */
  entry: string | null;
  /** seconds between replacements while the post is under strength */
  reinforce?: number;
}
export interface BridgeSpec { x0: number; z0: number; x1: number; z1: number; y: number; deadEnd?: boolean } // tile-inclusive rect + deck height; deadEnd = jetty (far end over water)
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

/**
 * Per-biome ground + path hues (DF-style: every region has its own soil and grass).
 * IMPORTANT: brightness is deliberately kept constant across biomes (all grass ≈ L*150, all paths ≈ L*175)
 * — only the hue changes, so no biome reads as a "darker" zone.
 */
export interface GroundPal {
  grass: string;
  path: string;
}

/** A fully resolved ground palette: base hues lerped per-tile between neighbouring biomes,
 *  with shading variants derived at fixed contrast. */
export interface MixedColors {
  grass: string; grassL: string; grassD: string;
  path: string; pathD: string; pathL: string; pathE: string;
  daisies: boolean; pebbly: boolean;
}

export type Biome = 'meadow' | 'lake' | 'farm' | 'mesa' | 'highland' | 'moor' | 'marsh';

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
  rocks: TileObj[] = []; // v: 0 plain, 1 mossy, 2 crystal
  fences: TileObj[] = [];
  /** undergrowth scatters (rendered as instanced vegetation) */
  ferns: TileObj[] = [];
  tallgrass: TileObj[] = [];
  briars: TileObj[] = [];
  boulders: TileObj[] = [];
  lilies: TileObj[] = [];
  /** tiles carrying undergrowth: ferns / tall grass / briars / boulders (keeps flowers & co. clear) */
  vegCell = new Uint8Array(MAP_W * MAP_H);
  houses: HouseSpec[] = [
    { x: 4, z: 3, w: 5, d: 3, roof: '#b73c3c', wall: '#e8d6a8', sign: 'none' },       // elder's house
    { x: 12, z: 2, w: 5, d: 3, roof: '#3a5fd0', wall: '#e8d6a8', sign: 'none' },      // Marin & Tarin style cottage
    { x: 2, z: 9, w: 4, d: 3, roof: '#8a3fc4', wall: '#f0e2c0', sign: 'none' },       // library-ish
    { x: 18, z: 4, w: 4, d: 3, roof: '#c82828', wall: '#f4ecd8', sign: 'shop' },      // shop (faces the main street)
    // east district
    { x: 23, z: 2, w: 5, d: 3, roof: '#c8862a', wall: '#f0e2c0', sign: 'inn' },       // the inn
    { x: 26, z: 12, w: 4, d: 3, roof: '#5a5a66', wall: '#d8c8a8', sign: 'none' },     // smithy
    // south district
    { x: 13, z: 21, w: 4, d: 3, roof: '#b73c3c', wall: '#e8d6a8', sign: 'none' },     // cottage
    { x: 23, z: 22, w: 4, d: 3, roof: '#3a5fd0', wall: '#f4ecd8', sign: 'none' },     // cottage
  ];
  props: PropSpec[] = [];
  npcs: NpcSpec[] = [];
  /** named road points on the map's edge (tile coords) that reinforcements march in from */
  edgeEntries: Record<string, [number, number]> = {};
  /** the world system's guard posts (see PostSpec) */
  posts: PostSpec[] = [];
  playerStart: Vec2 = { x: 9.5, z: 9.5 };
  /** Village bounds (tiles, inclusive) - enemies stay out */
  village = { x0: 1, z0: 1, x1: 32, z1: 29 };
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

  /** Hand-designed points of interest (flattened terrain pads) */
  private pads: { x0: number; z0: number; x1: number; z1: number }[] = [];

  private generate() {
    const { w, h, rng } = this;
    const set = (x: number, z: number, t: Tile) => { if (x >= 0 && z >= 0 && x < w && z < h) this.tiles[z * w + x] = t; };
    const get = (x: number, z: number) => this.tile(x, z);
    const v = this.village;

    // ---------------------------------------------------------------------------------------------------
    // REGIONS (208 x 176)
    //  NW  Thistledown & the home meadow      (x 0-60,   z 0-50)   village, pond, first knights
    //  N   Willowmere Woods                   (x 60-115, z 0-50)   forest trail to the north bridge, woodcutter
    //  |   The Great River                     (x ~118-140, N -> S) three bridges
    //  NE  Amber Highland                     (x 150+,   z 0-60)   terraces, ruined watchtower, archers
    //  E   Grey Moor & the Knights' camp      (x 140+,   z 60-120) stream, camp, the Crown hollow at the east edge
    //  C   Standing Stones mesa               (x 76-96,  z 56-68)
    //  SW  Mirror Lake & the orchard          (x 0-60,   z 50-176) hermit, fisher, second pond
    //  S   Millbrook hamlet                   (x 66-105, z 118-150) farms, mill, brook bridge
    //  SE  The Drowned Field                  (x 140+,   z 120-176) bog pools, old battlefield, ridge
    // ---------------------------------------------------------------------------------------------------

    // 1. water ------------------------------------------------------------------------------------------
    // Chunk alignment: the world-state grid is 8x8-tile chunks, and linear water must CROSS chunk
    // borders, never run along them. So every predominantly N-S stretch of the great river sits
    // exactly on a chunk-column middle (x = 8k+4: 116, 124, 132, 140) with its banks clear of the
    // border-adjacent tile columns, and the stretches are joined by 45-degree crossings. The brook
    // and the stream cross diagonally or run along a chunk-row middle (z = 8k+4).
    const river = [[116, -6], [116, 22], [124, 30], [124, 60], [132, 68], [132, 122], [140, 130], [140, 182]];
    const brook = [[50, 124], [58, 116], [70, 108], [94, 108], [106, 100], [129, 100]];
    const stream = [[206, 40], [186, 48], [170, 58], [156, 72], [148, 80], [140, 88], [132.5, 95.5]];
    const waters: { pts: number[][]; w: number }[] = [{ pts: river, w: 3.0 }, { pts: brook, w: 1.9 }, { pts: stream, w: 1.6 }];
    const lakes = [
      { x: 40, z: 126, rx: 13, rz: 8 },   // Mirror Lake
      { x: 14.5, z: 44, rx: 4.3, rz: 3.1 }, // home pond (the kid's rupee bush is nearby)
      { x: 24, z: 62, rx: 6, rz: 4 },     // heron pond
      { x: 168, z: 150, rx: 5, rz: 3 }, { x: 182, z: 160, rx: 4, rz: 2.5 }, { x: 156, z: 162, rx: 3.5, rz: 2.2 }, // bog pools
    ];
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
      const cx = x + 0.5, cz = z + 0.5;
      const i = this.idx(x, z);
      let best = 1e9, bw = 0;
      for (const wt of waters) { const d = polyDist(cx, cz, wt.pts); if (d - wt.w < best - bw) { best = d; bw = wt.w; } }
      for (const el of lakes) {
        const ex = (cx - el.x) / el.rx, ez = (cz - el.z) / el.rz;
        const d = (Math.hypot(ex, ez) - 1) * Math.min(el.rx, el.rz);
        if (d < best - bw) { best = d; bw = 0; }
      }
      const wobble = (hash2(x, z, 3) - 0.5) * 0.6;
      this.riverDist[i] = best - bw + wobble;
      this.riverHalfW[i] = bw;
      if (this.riverDist[i] < 0) set(x, z, Tile.Water);
    }

    // 2. roads ------------------------------------------------------------------------------------------
    // Same chunk-alignment discipline as the water: axis-parallel segments keep their ~3-tile-wide
    // painted band fully inside one chunk row/column (centres at 8k+2.5..8k+5.5), so a road only
    // ever touches a chunk border where it actually crosses it. The old east-road corridor ran 34
    // tiles exactly along the x=160 border; it now runs along the chunk-20 middle at x=164.5.
    // Four of the roads deliberately run OFF THE MAP (north through Willowmere, west along the
    // orchard lane, east past the Crown hollow, east across the Drowned Field): they are where the
    // world beyond the map is, and where a guard post's replacements march in from (see edgeEntries).
    const roads = [
      // south gate -> meadow crossroads -> great bridge (bends around the pond and the heron woods)
      [[10.5, 29], [10.5, 34.5], [26.5, 34.5], [26.5, 42.5], [42.5, 42.5], [58.5, 52.5], [82.5, 52.5], [98.5, 44.5], [121.5, 44.5]],
      // east gate -> forest trail through Willowmere -> north bridge
      [[33, 10.5], [44.5, 10.5], [44.5, 13.5], [60.5, 13.5], [60.5, 20.5], [78.5, 20.5], [84.5, 26.5], [98.5, 26.5], [104.5, 20.5], [114.5, 20.5]],
      // the Willowmere road: north out of the woods and off the top of the map
      [[84.5, 26.5], [84.5, -2.5]],
      // beyond the great bridge: east road and the moor road to the Crown hollow, which carries on
      // east off the map
      [[125.5, 44.5], [164.5, 44.5], [164.5, 82.5], [190.5, 82.5], [198.5, 92.5], [210.5, 92.5]],
      // the highland climb (off the corridor, up the terraces toward the watchtower)
      [[164.5, 44.5], [164.5, 28.5], [176.5, 22.5], [188.5, 12.5]],
      // north bridge -> highland foot (joins the climb road)
      [[120.5, 20.5], [140.5, 20.5], [146.5, 28.5], [164.5, 28.5]],
      // south road: crossroads -> heron pond -> Mirror Lake -> brook bridge -> Millbrook -> south bridge
      [[42.5, 42.5], [42.5, 74.5], [34.5, 84.5], [34.5, 100.5], [48.5, 108.5], [61.5, 108.5], [61.5, 133.5], [100.5, 133.5], [100.5, 125.5], [130.5, 125.5]],
      // east bank south -> the Drowned Field shrine, and on east off the map; camp track
      [[138.5, 125.5], [162.5, 125.5], [176.5, 141.5], [210.5, 141.5]],
      [[164.5, 82.5], [164.5, 104.5], [152.5, 110.5]],
      // orchard lane (hermit hill), and the west road running off the map past it
      [[34.5, 84.5], [20.5, 84.5], [14.5, 96.5]],
      [[20.5, 84.5], [-2.5, 84.5]],
      // mesa spur: the standing stones down to the meadow road
      [[82.5, 52.5], [85.5, 59.5]],
    ];
    const onRoad = (x: number, z: number) => x >= v.x0 && x <= v.x1 && z >= v.z0 && z <= v.z1 - 1 ? false : roads.some((p) => polyDist(x + 0.5, z + 0.5, p) < 1.1);
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) if (get(x, z) === Tile.Grass && onRoad(x, z)) set(x, z, Tile.Path);

    // 3. bridges (raised wooden decks; the terrain underneath stays sunk) --------------------------------
    const bridgeAt = (x: number, z: number, along: 'x' | 'z') => {
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
    bridgeAt(122, 44, 'x');  // great bridge (east road)
    bridgeAt(116, 20, 'x');  // north bridge
    bridgeAt(134, 125, 'x'); // south bridge
    bridgeAt(61, 113, 'z');  // brook bridge (south road)
    bridgeAt(164, 63, 'z');  // eastern stream bridge
    // the fisher's jetty on Mirror Lake: a 1-wide dead-end deck running south into the water
    { const j: BridgeSpec = { x0: 45, z0: 117, x1: 45, z1: 121, y: 0.12, deadEnd: true }; this.bridges.push(j); for (let z = j.z0; z <= j.z1; z++) set(j.x0, z, Tile.Bridge); }

    // 4. outposts: houses outside the village, terrain pads for points of interest ------------------------
    this.houses.push(
      { x: 88, z: 30, w: 4, d: 3, roof: '#6b4a2c', wall: '#c9b088', sign: 'none' },      // woodcutter's lodge (Willowmere)
      { x: 74, z: 138, w: 5, d: 3, roof: '#b73c3c', wall: '#e8d6a8', sign: 'none' },     // Millbrook farmhouse
      { x: 84, z: 126, w: 4, d: 3, roof: '#3a5fd0', wall: '#f0e2c0', sign: 'none' },     // the mill
      { x: 92, z: 140, w: 4, d: 3, roof: '#2f8f5a', wall: '#e8d6a8', sign: 'none' },     // shepherd's cottage
      { x: 12, z: 100, w: 4, d: 3, roof: '#8a3fc4', wall: '#c9b088', sign: 'none' },     // hermit's hut (orchard hill)
      { x: 46, z: 112, w: 4, d: 3, roof: '#c82828', wall: '#f4ecd8', sign: 'none' },     // fisher's house (Mirror Lake)
    );
    for (const hs of this.houses) if (hs.x > v.x1) this.pads.push({ x0: hs.x - 1, z0: hs.z - 1, x1: hs.x + hs.w, z1: hs.z + hs.d + 1 });
    this.pads.push(
      { x0: 84, z0: 58, x1: 90, z1: 64 },     // standing stones (mesa top)
      { x0: 150, z0: 100, x1: 160, z1: 112 }, // knights' camp
      { x0: 194, z0: 88, x1: 203, z1: 96 },   // the Crown hollow
      { x0: 186, z0: 4, x1: 194, z1: 11 },    // watchtower ruin
      { x0: 174, z0: 138, x1: 182, z1: 146 }, // the Drowned Field shrine
      { x0: 88, z0: 122, x1: 93, z1: 126 },   // the windmill
    );

    // 5. terrain heights ------------------------------------------------------------------------------
    this.generateHeights();

    // 6. village + outpost buildings ---------------------------------------------------------------------
    for (const hs of this.houses) for (let z = hs.z; z < hs.z + hs.d; z++) for (let x = hs.x; x < hs.x + hs.w; x++) {
      set(x, z, Tile.Grass); this.houseCell[this.idx(x, z)] = 1;
    }
    this.generateVillage(set);
    // Millbrook fields, mill yard and the hermit's orchard beds
    for (let z = 128; z <= 131; z++) for (let x = 68; x <= 79; x++) set(x, z, Tile.Bed);
    for (let z = 143; z <= 145; z++) for (let x = 80; x <= 90; x++) set(x, z, Tile.Bed);
    for (let z = 136; z <= 137; z++) for (let x = 84; x <= 88; x++) set(x, z, Tile.Bed);
    for (let z = 130; z <= 131; z++) for (let x = 84; x <= 89; x++) set(x, z, Tile.Cobble);
    for (let z = 104; z <= 105; z++) for (let x = 12; x <= 17; x++) set(x, z, Tile.Bed);
    // the knights' camp is trampled earth, the shrines and the tower are cobbled
    for (let z = 102; z <= 110; z++) for (let x = 151; x <= 159; x++) if (Math.hypot(x - 155, z - 106) < 4.2) set(x, z, Tile.Path);
    for (let z = 90; z <= 94; z++) for (let x = 196; x <= 201; x++) set(x, z, Tile.Cobble);
    for (let z = 5; z <= 10; z++) for (let x = 187; x <= 193; x++) set(x, z, Tile.Cobble);
    for (let z = 140; z <= 144; z++) for (let x = 176; x <= 180; x++) set(x, z, Tile.Cobble);
    for (let z = 59; z <= 63; z++) for (let x = 85; x <= 89; x++) if (Math.hypot(x - 87, z - 61) < 2.6) set(x, z, Tile.Cobble);

    // 7. trees -----------------------------------------------------------------------------------------
    const inYard = (x: number, z: number) => x >= v.x0 && x <= v.x1 && z >= v.z0 && z <= v.z1;
    const inPad = (x: number, z: number) => this.pads.some((p) => x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1);
    const nearSpawn = (x: number, z: number) => Math.hypot(x + 0.5 - this.playerStart.x, z + 0.5 - this.playerStart.z) < 3;
    const nearRoad = (x: number, z: number) => { for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { const t = get(x + dx, z + dz); if (t === Tile.Path || t === Tile.Bridge || t === Tile.Cobble || t === Tile.Bed) return true; } return false; };
    const flat = (x: number, z: number) => {
      const hs = [this.cornerH(x, z), this.cornerH(x + 1, z), this.cornerH(x, z + 1), this.cornerH(x + 1, z + 1)];
      return Math.max(...hs) - Math.min(...hs) < 0.3;
    };
    const treeOK = (x: number, z: number) => get(x, z) === Tile.Grass && !this.houseCell[this.idx(x, z)] && !inYard(x, z) && !inPad(x, z) && !nearSpawn(x, z) && !nearRoad(x, z) && flat(x, z) && this.riverDist[this.idx(x, z)] > 1.5;
    const plant = (x: number, z: number) => { if (treeOK(x, z)) this.treeCell[this.idx(x, z)] = 1; };
    // border forest (the world's edge) — except where a road runs off the map: those tiles stay
    // clear, so the road reads as leaving the world instead of dying in a wall of trees
    const offMapRoad = (x: number, z: number) => { const t = get(x, z); return t === Tile.Path || t === Tile.Bridge; };
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
      const ring = Math.min(x, z, w - 1 - x, h - 1 - z);
      if (ring < 2) { if (get(x, z) !== Tile.Water && !offMapRoad(x, z)) this.treeCell[this.idx(x, z)] = 1; continue; }
      if (ring <= 5 && treeOK(x, z)) { const p = [0.65, 0.4, 0.22, 0.1][ring - 2]; if (rng.next() < p) this.treeCell[this.idx(x, z)] = 1; }
    }
    // woodlands: hand-placed ellipses (x, z, rx, rz, density). Willowmere is the big one.
    const woods = [
      [88, 12, 30, 12, 0.5], [70, 36, 16, 9, 0.45], [100, 38, 12, 8, 0.45], [108, 8, 8, 6, 0.5],  // Willowmere Woods
      [26, 46, 9, 5, 0.4], [50, 60, 9, 7, 0.4], [14, 62, 8, 6, 0.42],                           // heron woods, west copses
      [104, 72, 14, 9, 0.42], [120, 86, 7, 5, 0.4],                                              // riverside woods (west bank)
      [30, 150, 16, 8, 0.45], [12, 130, 7, 9, 0.42], [60, 162, 14, 6, 0.45],                     // the southern forest
      [110, 158, 14, 8, 0.42], [90, 165, 10, 5, 0.4],                                            // Millbrook's southern woods
      [178, 26, 10, 6, 0.36], [200, 30, 6, 8, 0.4],                                              // highland pines
      [150, 84, 8, 5, 0.32], [188, 66, 10, 5, 0.34], [196, 118, 8, 8, 0.36],                     // moor copses
      [150, 170, 14, 4, 0.5], [196, 150, 8, 6, 0.4],                                              // SE ridge woods
    ];
    for (const [x, z, rx, rz, p] of woods) for (let tz = z - rz - 1; tz <= z + rz + 1; tz++) for (let tx = x - rx - 1; tx <= x + rx + 1; tx++) {
      const d = Math.hypot((tx - x) / rx, (tz - z) / rz) + (rng.next() - 0.5) * 0.25;
      if (d < 1 && rng.next() < p * (d < 0.6 ? 1 : 0.6)) plant(tx, tz);
    }
    // groves: tight clumps that frame roads, ponds and clearings
    const groves = [
      [32, 40, 5.5, 0.55], [48, 34, 4.5, 0.55], [42, 4, 4, 0.5], [4, 38, 3.5, 0.55], [22, 62, 3, 0.5], [40, 24, 3, 0.4], [52, 22, 4, 0.5], [6, 48, 3, 0.5], // home meadow
      [66, 56, 4, 0.5], [78, 44, 4, 0.5], [96, 58, 5, 0.45], [56, 92, 5, 0.5], [40, 98, 3.5, 0.5], [26, 112, 4, 0.5],
      [70, 126, 3, 0.5], [104, 122, 4, 0.5], [110, 140, 4, 0.5], [84, 150, 5, 0.5], [50, 140, 4, 0.5],
      [140, 56, 4, 0.5], [146, 36, 5, 0.5], [170, 48, 3, 0.5], [176, 96, 4, 0.5], [188, 104, 3.5, 0.45], [166, 118, 4, 0.5],
      [150, 140, 4, 0.45], [190, 130, 4, 0.45], [174, 166, 5, 0.5],
    ];
    for (const [x, z, r, p] of groves) for (let tz = z - r - 2; tz <= z + r + 2; tz++) for (let tx = x - r - 2; tx <= x + r + 2; tx++) {
      const d = Math.hypot(tx - x, tz - z) + (rng.next() - 0.5) * 1.5;
      if (d < r && rng.next() < p) plant(tx, tz);
    }
    // orchard rows on the hermit's hill and a willow line along the brook
    for (let x = 6; x <= 22; x += 3) for (let z = 108; z <= 114; z += 3) plant(x, z);
    for (let x = 72; x <= 110; x += 4) {
      const zb = x <= 94 ? 108 : x <= 106 ? 108 - (x - 94) * (8 / 12) : 100;
      plant(x, Math.round(zb) - 4); plant(x + 2, Math.round(zb) + 4);
    }
    // scattered lone trees, region-weighted (fewer on the moor, none on the highland top)
    for (let i = 0; i < 260; i++) {
      const x = rng.int(3, w - 4), z = rng.int(3, h - 4);
      const moor = x > 140 && z > 60 && z < 120, high = x > 150 && z < 40;
      if (high || (moor && rng.next() < 0.6)) continue;
      plant(x, z);
    }
    // village trees: framing corners + a big one by the plaza
    const villageTrees = [[2, 2], [3, 2], [2, 3], [3, 3], [18, 14], [19, 14], [18, 15], [19, 15], [19, 1], [1, 16], [2, 16], [17, 1], [12, 16], [1, 6], [1, 7],
      [30, 1], [31, 1], [30, 2], [31, 2], [31, 27], [30, 27], [31, 28], [30, 28], [1, 27], [2, 27], [1, 28], [2, 28], [21, 17], [22, 17], [21, 18], [22, 18], [31, 12], [31, 13], [1, 12], [10, 18]];
    for (let x = 26; x <= 31; x += 2) for (let z = 19; z <= 21; z += 2) villageTrees.push([x, z]); // orchard behind the smithy
    for (const [x, z] of villageTrees) if (get(x, z) === Tile.Grass && !this.houseCell[this.idx(x, z)]) this.treeCell[this.idx(x, z)] = 1;
    // how many trees in the 3x3 neighbourhood (drives forest-floor ground & species)
    const treeDensity = new Uint8Array(w * h);
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
      let c = 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, nz = z + dz;
        if (nx >= 0 && nz >= 0 && nx < w && nz < h) c += this.treeCell[this.idx(nx, nz)];
      }
      treeDensity[this.idx(x, z)] = c;
    }
    // species: pines on the highland, an autumn drift through Willowmere, blossoms in the orchards,
    // scattered birches in the open meadows
    const treeKind = (x: number, z: number): 'oak' | 'pine' | 'autumn' | 'birch' | 'blossom' => {
      if (x > 148 && z < 44) return 'pine';
      if (x >= 62 && x <= 112 && z >= 2 && z <= 48 && hash2(x, z, 91) < 0.24) return 'autumn';
      const orch = (x >= 6 && x <= 22 && z >= 108 && z <= 114) || (x >= 26 && x <= 31 && z >= 19 && z <= 21);
      if (orch && hash2(x, z, 55) < 0.7) return 'blossom';
      if (treeDensity[this.idx(x, z)] <= 2 && (x < 62 || (x >= 66 && x <= 105 && z >= 118 && z <= 150)) && hash2(x, z, 73) < 0.3) return 'birch';
      return 'oak';
    };
    // group into 2x2 big trees
    const claimed = new Uint8Array(w * h);
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
      const i = this.idx(x, z);
      if (!this.treeCell[i] || claimed[i]) continue;
      const canBig = x + 1 < w && z + 1 < h && this.treeCell[this.idx(x + 1, z)] && this.treeCell[this.idx(x, z + 1)] && this.treeCell[this.idx(x + 1, z + 1)]
        && !claimed[this.idx(x + 1, z)] && !claimed[this.idx(x + 1, z + 1)] && !claimed[this.idx(x + 1, z + 1)];
      if (canBig) {
        claimed[i] = claimed[this.idx(x + 1, z)] = claimed[this.idx(x, z + 1)] = claimed[this.idx(x + 1, z + 1)] = 1;
        this.trees.push({ x: x + 1, z: z + 1.55, scale: 1, y: this.heightAt(x + 1, z + 1), kind: treeKind(x + 1, z + 1) });
      } else {
        claimed[i] = 1;
        this.trees.push({ x: x + 0.5, z: z + 0.8, scale: 0.6, y: this.heightAt(x + 0.5, z + 0.5), kind: treeKind(x, z) });
      }
    }

    // 8. bushes / rocks ---------------------------------------------------------------------------------
    const objFree = (x: number, z: number) => (get(x, z) === Tile.Grass || get(x, z) === Tile.Flowers) && !this.treeCell[this.idx(x, z)] && !this.houseCell[this.idx(x, z)] && !nearSpawn(x, z) && flat(x, z) && this.riverDist[this.idx(x, z)] > 1.2;
    const occupied = new Uint8Array(w * h);
    const patterns = [[[0, 0], [1, 0], [2, 0]], [[0, 0], [0, 1], [0, 2]], [[0, 0], [1, 0], [0, 1], [1, 1]], [[0, 0], [1, 0], [2, 0], [0, 1]], [[0, 0], [2, 0], [1, 1]]];
    const bushAt = (x: number, z: number) => { if (objFree(x, z) && !inYard(x, z) && !inPad(x, z) && !occupied[this.idx(x, z)]) { this.bushes.push({ tx: x, tz: z }); occupied[this.idx(x, z)] = 1; } };
    const rockAt = (x: number, z: number) => {
      if (objFree(x, z) && !inYard(x, z) && !inPad(x, z) && !occupied[this.idx(x, z)]) {
        const reg = this.groundRegion(x, z);
        const v = reg === 'mesa' || reg === 'highland' ? (hash2(x, z, 83) < 0.3 ? 2 : 0)
          : treeDensity[this.idx(x, z)] >= 4 || reg === 'lake' ? (hash2(x, z, 84) < 0.45 ? 1 : 0)
            : 0; // mossy rocks in the woods
        this.rocks.push({ tx: x, tz: z, v });
        occupied[this.idx(x, z)] = 1;
      }
    };
    const cluster = (x: number, z: number, place: (x: number, z: number) => void) => { for (const [ox, oz] of rng.pick(patterns)) place(x + ox, z + oz); };
    // Granny's bushes around the village and the pond (the kid's rupee bush is by the pond)
    const homeBushes = [[6, 35], [7, 35], [13, 36], [14, 36], [15, 36], [4, 38], [5, 38], [16, 38], [17, 39], [11, 39], [12, 39], [6, 46], [7, 46], [20, 44], [21, 44], [13, 49], [17, 49], [18, 49], [37, 18], [38, 18], [40, 30], [41, 30], [36, 12], [37, 12], [22, 38], [23, 38]];
    for (const [x, z] of homeBushes) bushAt(x, z);
    const bushClusters = [
      [37, 26], [44, 33], [55, 42], [63, 48], [72, 50], [90, 49], [104, 44], [112, 50],                 // along the east road
      [36, 12], [44, 16], [58, 12], [66, 22], [80, 18], [94, 24], [100, 30], [108, 18],                 // forest trail
      [34, 60], [44, 70], [46, 78], [30, 88], [38, 96], [52, 104], [58, 114], [66, 130], [96, 136],     // south road
      [26, 68], [18, 74], [30, 74],                                                                      // heron pond
      [30, 118], [34, 136], [50, 134], [54, 120],                                                         // Mirror Lake shore
      [134, 44], [140, 50], [148, 48], [156, 52], [164, 74], [170, 84], [182, 78], [186, 86],             // east road
      [144, 118], [150, 124], [160, 124], [166, 134], [176, 130],                                         // Drowned Field
      [98, 60], [110, 64], [118, 82], [124, 104], [112, 110],                                             // riverside
    ];
    for (const [x, z] of bushClusters) cluster(x, z, bushAt);
    for (let i = 0; i < 40; i++) cluster(rng.int(4, w - 6), rng.int(4, h - 6), bushAt);
    // rock fields: the highland, the moor and the river shingle; a few boulders elsewhere
    const rockFields = [
      [178, 34, 12, 6, 0.12], [196, 20, 8, 10, 0.1], [160, 14, 8, 8, 0.1],   // highland
      [176, 100, 22, 12, 0.07], [196, 70, 8, 6, 0.1],                        // moor
      [128, 60, 6, 10, 0.08], [126, 110, 6, 8, 0.08],                        // shingle
      [20, 46, 8, 4, 0.08], [10, 150, 8, 6, 0.08], [150, 156, 10, 5, 0.1],  // hills
    ];
    for (const [x, z, rx, rz, p] of rockFields) for (let tz = z - rz; tz <= z + rz; tz++) for (let tx = x - rx; tx <= x + rx; tx++) {
      if (Math.hypot((tx - x) / rx, (tz - z) / rz) < 1 && rng.next() < p) rockAt(tx, tz);
    }
    for (let i = 0; i < 90; i++) rockAt(rng.int(3, w - 4), rng.int(3, h - 4));
    for (const [x, z] of [[37, 19], [40, 21], [30, 45], [15, 52], [37, 8], [6, 33], [34, 28], [36, 4], [44, 29], [24, 46], [46, 5]]) cluster(x, z, bushAt);

    // 8b. ground character per biome (DF-style): the same Grass tile gets a regional face -------------
    // Soft biome weights make the ground type blend gradually across ~20 tiles at every biome border.
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
      const i = this.idx(x, z);
      if (this.tiles[i] !== Tile.Grass) continue; // never touch water/roads/beds/cliffs/houses
      const bw = this.biomeWeights(x, z);
      // forest floor under the woods — except on the highland core, where the pines keep their steppe floor
      if (treeDensity[i] >= 4 && !inYard(x, z) && bw.highland < 0.6) { set(x, z, Tile.ForestFloor); continue; }
      if (bw.meadow + bw.lake + bw.farm > 0.98) continue; // pure open meadow: stay grass
      const h1 = hash2(x, z, 51), h2 = hash2(x, z, 52);
      let heather = 0, mud = 0, gravel = 0, dry = 0;
      if (bw.highland > 0.02) {
        const g = h1 < 0.45;
        gravel += bw.highland * (g ? 1 : 0.22);
        dry += bw.highland * (g ? 0.22 : 1);
      }
      if (bw.mesa > 0.02) gravel += bw.mesa;
      if (bw.moor > 0.02) {
        heather += bw.moor * (h1 < 0.55 ? 1 : 0.18);
        if (this.riverDist[i] < 3.5) mud += bw.moor * 0.8; // wet ground by the moor stream
      }
      if (bw.marsh > 0.02) {
        if (this.riverDist[i] < 4.5) mud += bw.marsh * 1.2; // bog flats around the pools
        else if (h2 < 0.55) mud += bw.marsh;
        else if (h2 < 0.75) heather += bw.marsh;
        else dry += bw.marsh;
      }
      // per-tile hash jitter (±0.15): breaks straight lines and dapples the blend band
      heather += (h1 - 0.5) * 0.3; mud += (h2 - 0.5) * 0.3;
      gravel += (hash2(x, z, 53) - 0.5) * 0.3; dry += (hash2(x, z, 54) - 0.5) * 0.3;
      const grassW = bw.meadow + bw.lake + bw.farm + (h1 - 0.5) * 0.3;
      const best = Math.max(grassW, heather, mud, gravel, dry);
      if (best !== grassW) set(x, z, best === heather ? Tile.Heather : best === mud ? Tile.Mud : best === gravel ? Tile.Gravel : Tile.DryGrass);
    }

    // 9. props: village + outposts -----------------------------------------------------------------------
    this.props.push(
      // woodcutter's clearing
      { kind: 'log', x: 86.5, z: 35.5 }, { kind: 'log', x: 93.5, z: 34.5, rot: 0.8 }, { kind: 'crate', x: 92.5, z: 30.5 }, { kind: 'barrel', x: 87.5, z: 30.5 }, { kind: 'sign', x: 90.5, z: 36.5 },
      // standing stones on the mesa
      { kind: 'menhir', x: 87.5, z: 58.5 }, { kind: 'menhir', x: 89.8, z: 60.2, rot: 0.6 }, { kind: 'menhir', x: 89.6, z: 62.6, rot: 1.2 }, { kind: 'menhir', x: 87.4, z: 63.8, rot: 0.3 }, { kind: 'menhir', x: 85.2, z: 62.5, rot: 0.9 }, { kind: 'menhir', x: 84.4, z: 60.8, rot: 0.2 },
      // Millbrook
      { kind: 'weathercock', x: 86.5, z: 125.5 }, { kind: 'cart', x: 82.5, z: 130.5, rot: 0.4 }, { kind: 'hay', x: 72.5, z: 136.5 }, { kind: 'hay', x: 71.5, z: 138.5 }, { kind: 'hay', x: 89.5, z: 141.5 },
      { kind: 'scarecrow', x: 74.5, z: 129.5 }, { kind: 'barrel', x: 79.5, z: 141.5 }, { kind: 'sign', x: 64.5, z: 131.5 }, { kind: 'lamp', x: 80.5, z: 136.5 }, { kind: 'bench', x: 86.5, z: 143.5 },
      // Mirror Lake: fisher's jetty
      { kind: 'barrel', x: 50.5, z: 114.5 }, { kind: 'crate', x: 43.5, z: 112.5 }, { kind: 'sign', x: 50.5, z: 111.5 },
      // hermit's orchard hill
      { kind: 'bench', x: 16.5, z: 102.5, rot: Math.PI }, { kind: 'flowerpot', x: 11.5, z: 103.5 }, { kind: 'menhir', x: 8.5, z: 96.5, rot: 0.4 },
      // knights' camp
      { kind: 'campfire', x: 155.5, z: 106.5 }, { kind: 'tent', x: 152.5, z: 103.5, rot: 0.7 }, { kind: 'tent', x: 158.5, z: 103.5, rot: -0.7 }, { kind: 'tent', x: 158.5, z: 109.5, rot: -2.4 },
      { kind: 'banner', x: 152.5, z: 109.5 }, { kind: 'crate', x: 154.5, z: 110.5 }, { kind: 'barrel', x: 156.5, z: 102.5 }, { kind: 'log', x: 155.5, z: 108.5, rot: Math.PI / 2 },
      // watchtower ruin on the highland
      { kind: 'tower', x: 190.5, z: 7.5 }, { kind: 'ruinwall', x: 187.5, z: 10.5 }, { kind: 'ruinwall', x: 193.5, z: 9.5, rot: Math.PI / 2 }, { kind: 'banner', x: 189.5, z: 4.5 }, { kind: 'campfire', x: 192.5, z: 10.5 },
      // the Crown hollow at the east edge
      { kind: 'pillar', x: 196.5, z: 90.5 }, { kind: 'pillar', x: 196.5, z: 94.5 }, { kind: 'pillar', x: 199.5, z: 89.5 }, { kind: 'pillar', x: 199.5, z: 95.5 }, { kind: 'crown', x: 201.5, z: 92.5 }, { kind: 'ruinwall', x: 201.5, z: 89.5 }, { kind: 'ruinwall', x: 201.5, z: 95.5 },
      // Drowned Field shrine + grave stakes
      { kind: 'pillar', x: 176.5, z: 140.5 }, { kind: 'pillar', x: 180.5, z: 140.5 }, { kind: 'menhir', x: 178.5, z: 141.5 }, { kind: 'ruinwall', x: 178.5, z: 144.5 },
      { kind: 'banner', x: 150.5, z: 132.5 }, { kind: 'banner', x: 158.5, z: 138.5, rot: 0.5 }, { kind: 'log', x: 154.5, z: 136.5, rot: 1.1 },
      // road signs at the crossroads and bridges
      { kind: 'sign', x: 44.5, z: 48.5 }, { kind: 'sign', x: 118.5, z: 48.5 }, { kind: 'sign', x: 162.5, z: 82.5 }, { kind: 'sign', x: 42.5, z: 32.5 }, { kind: 'lamp', x: 128.5, z: 46.5 }, { kind: 'lamp', x: 119.5, z: 46.5 },
      // Millbrook: the windmill by the mill
      { kind: 'windmill', x: 90.5, z: 124.5 },
      // woodcutter's clearing: another cut log and a mushroom cluster
      { kind: 'log', x: 88.5, z: 33.5, rot: 0.3 }, { kind: 'mushroom', x: 94.5, z: 36.5 },
      // hermit's orchard hill: the alchemical cauldron
      { kind: 'cauldron', x: 12.5, z: 103.5 }, { kind: 'mushroom', x: 10.5, z: 98.5 },
      // water's edge: cattail reeds by the ponds and Mirror Lake
      { kind: 'reeds', x: 31.5, z: 133.5 }, { kind: 'reeds', x: 42.5, z: 117.5 }, { kind: 'reeds', x: 19.5, z: 65.5 }, { kind: 'reeds', x: 19.5, z: 41.5 }, { kind: 'reeds', x: 28.5, z: 67.5 },
      // the Crown hollow: a fallen knight's statue
      { kind: 'statue', x: 194.5, z: 89.5 },
      // the Drowned Field: battlefield graves, dead trees, bog reeds
      { kind: 'grave', x: 158.5, z: 142.5 }, { kind: 'grave', x: 175.5, z: 146.5 }, { kind: 'grave', x: 184.5, z: 131.5 }, { kind: 'grave', x: 156.5, z: 158.5 }, { kind: 'grave', x: 190.5, z: 163.5 },
      { kind: 'deadtree', x: 148.5, z: 131.5 }, { kind: 'deadtree', x: 160.5, z: 138.5 }, { kind: 'deadtree', x: 188.5, z: 150.5 }, { kind: 'deadtree', x: 194.5, z: 138.5 },
      { kind: 'reeds', x: 164.5, z: 153.5 }, { kind: 'reeds', x: 154.5, z: 164.5 },
      // Millbrook's southern woods
      { kind: 'mushroom', x: 104.5, z: 156.5 },
      // the Amber Highland: glowing amber chunks in the rock
      { kind: 'amberrock', x: 165.5, z: 10.5 }, { kind: 'amberrock', x: 192.5, z: 30.5 }, { kind: 'amberrock', x: 198.5, z: 16.5 },
      { kind: 'amberrock', x: 186.5, z: 42.5 }, { kind: 'amberrock', x: 185.5, z: 3.5 }, { kind: 'amberrock', x: 202.5, z: 8.5 },
      { kind: 'amberrock', x: 168.5, z: 24.5 }, { kind: 'amberrock', x: 195.5, z: 38.5 },
    );
    // scattered stakes along the Drowned Field (old battle lines)
    for (let i = 0; i < 18; i++) { const x = 144 + rng.int(0, 30), z = 122 + rng.int(0, 30); if (objFree(x, z) && !occupied[this.idx(x, z)] && get(x, z) === Tile.Grass) this.fences.push({ tx: x, tz: z }); }
    // outpost NPCs
    this.npcs.push(
      { id: 'woodcutter', x: 89.5, z: 34.5, facing: 0, wander: 1.5 },
      { id: 'miller', x: 86.5, z: 129.5, facing: 0, wander: 1.5 },
      { id: 'shepherd', x: 93.5, z: 143.5, facing: 3, wander: 2 },
      { id: 'fisher', x: 46.5, z: 115.5, facing: 0, wander: 0 },
      { id: 'hermit', x: 14.5, z: 103.5, facing: 0, wander: 1 },
      { id: 'squire', x: 118.5, z: 50.5, facing: 1, wander: 0 },
    );

    // 10. village fence ring with gates; solid props -----------------------------------------------------
    const fenceAt = (x: number, z: number) => { if (objFree(x, z) && !occupied[this.idx(x, z)]) { this.fences.push({ tx: x, tz: z }); occupied[this.idx(x, z)] = 1; } };
    for (let x = v.x0; x <= v.x1; x++) { if (x < 8 || x > 10) fenceAt(x, v.z1); }
    for (let z = v.z0 + 1; z <= v.z1; z++) { if (z < 9 || z > 11) fenceAt(v.x1, z); }
    // Millbrook paddock fence
    for (let x = 80; x <= 91; x++) if (x !== 85 && x !== 86) fenceAt(x, 146);
    for (let z = 143; z <= 146; z++) { fenceAt(79, z); fenceAt(91, z); }
    for (const f of this.fences) occupied[this.idx(f.tx, f.tz)] = 1;
    for (const b of this.beds()) { const i = this.idx(b[0], b[1]); if (!occupied[i]) occupied[i] = 2; }
    for (const pr of this.props) {
      if (pr.kind === 'lamp' || pr.kind === 'sign' || pr.kind === 'flowerpot' || pr.kind === 'campfire' || pr.kind === 'crown' || pr.kind === 'reeds' || pr.kind === 'mushroom') continue;
      const tx = Math.floor(pr.x), tz = Math.floor(pr.z);
      if (!this.houseCell[this.idx(tx, tz)]) occupied[this.idx(tx, tz)] = 1;
      if (pr.kind === 'stall') { occupied[this.idx(tx - 1, tz)] = 1; occupied[this.idx(tx + 1, tz)] = 1; }
      if (pr.kind === 'tower' || pr.kind === 'windmill') for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) occupied[this.idx(tx + dx, tz + dz)] = 1;
    }

    // 10b. undergrowth (CDDA-style): ferns in the woods, tall grass in the meadows, briars on the moor,
    // boulders on the rock, lily pads in still water
    const vegFree = (x: number, z: number, minRiver: number) => {
      const t = this.tiles[this.idx(x, z)];
      if (t !== Tile.Grass && t !== Tile.Flowers && t !== Tile.Heather && t !== Tile.Mud && t !== Tile.ForestFloor && t !== Tile.Gravel && t !== Tile.DryGrass) return false;
      const i = this.idx(x, z);
      return !this.treeCell[i] && !this.houseCell[i] && !this.vegCell[i] && !inYard(x, z) && !nearSpawn(x, z) && !nearRoad(x, z) && flat(x, z)
        && this.riverDist[i] > minRiver && !occupied[i];
    };
    const placeVeg = (x: number, z: number, list: TileObj[], blocking: boolean) => {
      const i = this.idx(x, z);
      if (!vegFree(x, z, blocking ? 1.2 : 0.9)) return;
      list.push({ tx: x, tz: z });
      this.vegCell[i] = 1;
      if (blocking) occupied[i] = 1;
    };
    for (let z = 2; z < h - 2; z++) for (let x = 2; x < w - 2; x++) {
      const i = this.idx(x, z);
      const reg = this.groundRegion(x, z);
      const hd = hash2(x, z, 57);
      if (this.tiles[i] === Tile.ForestFloor && hd < 0.09) placeVeg(x, z, this.ferns, false);
      else if ((reg === 'meadow' || reg === 'lake' || reg === 'farm') && (this.tiles[i] === Tile.Grass || this.tiles[i] === Tile.Flowers) && hd < 0.045) placeVeg(x, z, this.tallgrass, false);
      else if ((reg === 'moor' || reg === 'marsh' || this.tiles[i] === Tile.ForestFloor) && hd >= 0.6 && hd < 0.622) placeVeg(x, z, this.briars, true);
    }
    const boulderFields = [
      [178, 30, 12, 7, 0.05], [196, 18, 8, 10, 0.04], [160, 12, 8, 8, 0.04], // highland
      [87, 61, 7, 5, 0.14], // mesa top
      [28, 158, 12, 6, 0.035], [96, 166, 9, 5, 0.035], // southern hills
      [128, 100, 6, 8, 0.03], // river shingle
    ];
    for (const [bx, bz, rx, rz, p] of boulderFields) for (let tz = bz - rz; tz <= bz + rz; tz++) for (let tx = bx - rx; tx <= bx + rx; tx++) {
      if (Math.hypot((tx - bx) / rx, (tz - bz) / rz) < 1 && rng.next() < p) placeVeg(tx, tz, this.boulders, true);
    }
    for (let z = 1; z < h - 1; z++) for (let x = 1; x < w - 1; x++) {
      const i = this.idx(x, z);
      if (this.tiles[i] !== Tile.Water || this.riverHalfW[i] > 0.01) continue; // still water only (no lilies on the river)
      let land = false;
      for (let dz = -2; dz <= 2 && !land; dz++) for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
        if (this.tiles[this.idx(nx, nz)] !== Tile.Water) { land = true; break; }
      }
      if (land && hash2(x, z, 61) < 0.12) this.lilies.push({ tx: x, tz: z });
    }

    // 11. flowers: meadows bloom, the moor and highland barely -------------------------------------------
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
      if (get(x, z) !== Tile.Grass || this.treeCell[this.idx(x, z)] || occupied[this.idx(x, z)] || this.vegCell[this.idx(x, z)]) continue;
      const moor = x > 140 && z > 60, high = x > 150 && z < 40;
      const p = high ? 0.01 : moor ? 0.02 : (x < 60 && z < 50) ? 0.07 : 0.045;
      if (rng.next() < p) set(x, z, Tile.Flowers);
    }

    // solidity ----------------------------------------------------------------------------------------
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
      const i = this.idx(x, z);
      const t = this.tiles[i];
      const s = t === Tile.Water || t === Tile.Cliff || this.treeCell[i] === 1 || this.houseCell[i] === 1 || occupied[i] >= 1;
      this.solid[i] = s ? 1 : 0;
      this.tall[i] = (t === Tile.Cliff || this.treeCell[i] === 1 || this.houseCell[i] === 1 || occupied[i] === 1) ? 1 : 0;
    }

    for (const np of this.npcs) if (this.isSolidTile(Math.floor(np.x), Math.floor(np.z))) { const p = this.nearestFree(np.x, np.z); np.x = p.x; np.z = p.z; }

    // 12. guard posts: the world system's soldiers ----------------------------------------------------------
    // Soldiers are no longer hand-placed spawn points that the game materialises all at once. They
    // belong to the WORLD SYSTEM: named POSTS — an area of the world a handful of soldiers hold.
    // They stand guard and wander their own patch (tightly on a bridge, loosely through a wood), and
    // when one falls the post recruits a replacement, who marches in from off the map along the
    // roads. WorldState resolves each post's area and its reinforcement route; see worldstate.ts.
    //
    // Entries are the road points on the map's edge (tile coords; snapped to the nearest usable road
    // tile) that reinforcements arrive at.
    this.edgeEntries = {
      northRoad: [84.5, 0.5],      // the Willowmere road, off the top of the map
      westRoad: [0.5, 84.5],       // the orchard lane, off the west edge
      crownRoad: [207.5, 92.5],    // the Crown road, off the east edge
      drownedRoad: [207.5, 141.5], // the Drowned Field road, off the east edge
    };
    // `at` is the area's centre, rx/rz its radii in tiles; 'cluster' holds a tight knot, 'spread'
    // roams the patch the way the old hand-placed soldiers did. `entry` is where its replacements
    // come from, `reinforce` the seconds between them.
    const post = (name: string, at: [number, number], rx: number, rz: number, style: PostStyle,
      kinds: EnemyKind[], entry: string | null, reinforce?: number): PostSpec =>
      ({ name, at, rx, rz, style, kinds, entry, reinforce });
    // A bridge guard doesn't stand on the planks: it groups on the road just off one end of the
    // bridge — the far end, away from the village — so the knot stands between home and whatever
    // comes over the river, on solid road with the bridge at its back. Worked out from the deck
    // itself, so it always matches the bridge it guards.
    const bridgePost = (name: string, at: [number, number], kinds: EnemyKind[], entry: string | null,
      reinforce?: number): PostSpec => {
      const b = this.bridges.find((b) => at[0] >= b.x0 && at[0] <= b.x1 && at[1] >= b.z0 && at[1] <= b.z1);
      if (!b) throw new Error(`no bridge at ${at[0]},${at[1]} for post '${name}'`);
      const vx = (this.village.x0 + this.village.x1) / 2, vz = (this.village.z0 + this.village.z1) / 2;
      const alongX = b.x1 - b.x0 >= b.z1 - b.z0; // which way the deck runs
      const dirX = Math.abs(b.x1 - vx) >= Math.abs(b.x0 - vx) ? 1 : -1; // the end away from town
      const dirZ = Math.abs(b.z1 - vz) >= Math.abs(b.z0 - vz) ? 1 : -1;
      const endX = dirX > 0 ? b.x1 : b.x0, endZ = dirZ > 0 ? b.z1 : b.z0;
      return {
        name,
        // two tiles clear of the last plank, centred on the road that runs on from the bridge
        at: alongX ? [endX + dirX * 2 + 0.5, (b.z0 + b.z1 + 1) / 2] : [(b.x0 + b.x1 + 1) / 2, endZ + dirZ * 2 + 0.5],
        rx: alongX ? 2.5 : 2, rz: alongX ? 2 : 2.5,
        style: 'cluster', kinds, entry, reinforce,
      };
    };
    this.posts = [
      // the home meadow: the first, gentlest patch (and the one the player clears first)
      post('Meadow Watch', [44, 38], 14, 10, 'spread', ['sword', 'sword', 'javelin', 'spear', 'sword'], 'westRoad', 40),
      post('Heron Pond Watch', [26, 64], 11, 8, 'spread', ['sword', 'spear', 'sword', 'archer'], 'westRoad'),
      post('Orchard Watch', [16, 98], 8, 7, 'spread', ['sword', 'archer'], 'westRoad'),
      post('Mirror Lake Watch', [58, 116], 10, 8, 'spread', ['sword', 'spear', 'archer', 'sword'], 'westRoad'),
      post('Millbrook Watch', [86, 142], 14, 9, 'spread', ['sword', 'spear', 'sword', 'javelin', 'archer'], 'westRoad'),
      // the bridges: a thick knot of soldiers holding one exit of the deck — the far one, away from
      // the village, so they stand between home and whatever comes over the water
      bridgePost('Brook Bridge Guard', [61, 113], ['sword', 'spear', 'sword'], 'westRoad'),
      bridgePost('North Bridge Guard', [116, 20], ['sword', 'spear', 'spear', 'archer', 'sword'], 'northRoad'),
      bridgePost('Great Bridge Guard', [122, 44], ['sword', 'sword', 'spear', 'archer', 'spear'], 'crownRoad'),
      bridgePost('South Bridge Guard', [134, 125], ['sword', 'spear', 'archer', 'sword'], 'drownedRoad'),
      // the woods and the wilds: wide, loose patches
      post('Willowmere Patrol', [86, 24], 21, 13, 'spread', ['sword', 'spear', 'sword', 'archer', 'sword', 'javelin', 'spear', 'sword'], 'northRoad'),
      post('Mesa Watch', [87, 61], 9, 6, 'spread', ['sword', 'spear', 'archer', 'sword'], 'crownRoad'),
      post('Riverside Watch', [100, 72], 14, 10, 'spread', ['sword', 'spear', 'archer', 'sword', 'javelin'], 'crownRoad'),
      post('Highland Guard', [178, 22], 13, 9, 'spread', ['archer', 'spear', 'archer', 'spear', 'archer'], 'northRoad'),
      post('Moor Patrol', [172, 84], 19, 13, 'spread', ['sword', 'spear', 'javelin', 'sword', 'archer', 'spear'], 'crownRoad'),
      post('Drowned Field Patrol', [170, 146], 21, 15, 'spread', ['spear', 'javelin', 'archer', 'sword', 'spear', 'sword', 'archer'], 'drownedRoad'),
      // the garrisons: landmarks held in force
      post('Watchtower Guard', [190, 8], 7, 5, 'cluster', ['archer', 'spear', 'archer', 'sword'], 'northRoad'),
      post("Knights' Camp Garrison", [155, 106], 5.5, 5, 'cluster', ['sword', 'spear', 'sword', 'javelin'], 'crownRoad'),
      post('Crown Hollow Guard', [198, 92], 6, 6, 'cluster', ['archer', 'sword', 'archer', 'spear'], 'crownRoad'),
    ];
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
    // NE Amber Highland: broad terraces with cliff faces; the road climbs it at x~160 (ramp carved below)
    plateau(150, 0, 208, 40, 2, 1.4);
    plateau(168, 0, 208, 24, 3.5, 1.4);
    plateau(186, 0, 208, 12, 5, 1.4);
    // Crown hollow: a raised shelf at the east edge, reached by the moor road
    plateau(192, 84, 208, 100, 1.2, 3);
    // SE ridge and the Drowned Field's low mounds
    plateau(150, 166, 208, 176, 2, 1.6);
    hill(176, 142, 6, 4, 0.8); hill(154, 136, 5, 3, 0.6);
    // southern hills and Millbrook's mill knoll
    hill(28, 158, 14, 7, 2); hill(96, 166, 12, 6, 1.5); hill(120, 158, 8, 5, 1.2); hill(86, 127, 5, 3.5, 0.6);
    // western hills: SW hill by the pond (as in the original meadow), orchard hill, heron ridge
    hill(8, 54, 6, 3.2, 2); hill(22, 56, 7, 4, 1.4); hill(14, 100, 9, 8, 1.6); hill(20, 74, 8, 4, 1.2); hill(70, 70, 10, 7, 1.4); hill(84, 34, 8, 5, 1.2);
    // mid-map mesa with the standing stones on top
    plateau(78, 56, 96, 68, 1.5, 2.2);
    // gentle village rise
    hill(16, 14, 22, 20, 0.8);
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
    // points of interest: flatten a pad to its mean level, blending out over 3 tiles
    for (const p of this.pads) {
      let sum = 0, n = 0;
      for (let cz = p.z0; cz <= p.z1 + 1; cz++) for (let cx = p.x0; cx <= p.x1 + 1; cx++) { sum += lvl[cz * W + cx]; n++; }
      const mean = sum / n;
      for (let cz = Math.max(0, p.z0 - 3); cz <= Math.min(H - 1, p.z1 + 4); cz++) for (let cx = Math.max(0, p.x0 - 3); cx <= Math.min(W - 1, p.x1 + 4); cx++) {
        const dx = Math.max(p.x0 - cx, 0, cx - (p.x1 + 1)), dz = Math.max(p.z0 - cz, 0, cz - (p.z1 + 1));
        const t = 1 - smoothstep(0, 3, Math.hypot(dx, dz));
        const i = cz * W + cx;
        lvl[i] = lvl[i] * (1 - t) + mean * t;
      }
    }
    // ramp for the NE highland where the road climbs (the corridor at x=164.5, z 40..48)
    for (let cz = 40; cz <= 48; cz++) for (let cx = 160; cx <= 167; cx++) lvl[cz * W + cx] = 2 * smoothstep(48.5, 40, cz);
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
        if (b.deadEnd && a > lo + 1) continue;
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

  /**
   * Is this tile water from a POLYLINE (river / brook / stream), as opposed to a lake or pond?
   * Linear water must cross chunk borders cleanly (never run along them); lake blobs are exempt
   * from that rule, so the alignment tests use this to tell them apart.
   */
  isRiverWater(tx: number, tz: number): boolean {
    const i = this.idx(tx, tz);
    return this.riverDist[i] < 0 && this.riverHalfW[i] > 0.01;
  }

  /** May decorative grass blades grow here? (grass-like tile, walkable, not on the wet shore strip) */
  canGrowGrass(tx: number, tz: number): boolean {
    if (tx < 0 || tz < 0 || tx >= this.w || tz >= this.h) return false;
    const t = this.tile(tx, tz);
    if (t !== Tile.Grass && t !== Tile.Flowers && t !== Tile.DryGrass && t !== Tile.Heather) return false;
    const i = this.idx(tx, tz);
    if (this.solid[i]) return false; // trees, houses, props, rocks...
    return this.riverDist[i] > 1.0;  // keep the sand/mud/gravel banks clean
  }


  /** Height of the walkable surface (terrain, or the bridge deck when standing on a bridge) */
  surfaceAt(x: number, z: number): number {
    const tx = Math.floor(x), tz = Math.floor(z);
    if (this.tile(tx, tz) === Tile.Bridge) {
      for (const b of this.bridges) if (tx >= b.x0 && tx <= b.x1 && tz >= b.z0 && tz <= b.z1) {
        // ramp up over the abutment tile
        const alongX = b.x1 - b.x0 > b.z1 - b.z0;
        const p = alongX ? x : z, p0 = alongX ? b.x0 : b.z0, p1 = alongX ? b.x1 + 1 : b.z1 + 1;
        const ramp = b.deadEnd ? Math.min(1, p - p0) : Math.min(1, Math.min(p - p0, p1 - p));
        const ground0 = this.heightAt(alongX ? p0 : x, alongX ? z : p0), ground1 = this.heightAt(alongX ? p1 : x, alongX ? z : p1);
        const ground = b.deadEnd || p - p0 < p1 - p ? ground0 : ground1;
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
    lane(20, 7, 20, 7);           // shop doorstep
    lane(12, 9, 32, 9); lane(13, 8, 32, 8);
    // --- east district: inn + smithy
    lane(25, 5, 25, 7); lane(26, 5, 26, 7);
    for (let z = 15; z <= 16; z++) for (let x = 26; x <= 29; x++) set(x, z, Tile.Cobble); // smithy yard
    lane(25, 10, 25, 16); // lane from the main street down the west side of the smithy into its yard
    // --- south district: lane down to the new south gate, two cottages, fields and an orchard
    lane(9, 17, 9, 28);
    lane(14, 24, 10, 24); lane(15, 24, 15, 24);
    lane(24, 25, 24, 26); lane(24, 26, 10, 26); lane(25, 25, 25, 25);
    for (let z = 19; z <= 27; z++) for (let x = 2; x <= 7; x++) if (z !== 23) set(x, z, Tile.Bed);   // fields with a path through
    for (let x = 2; x <= 7; x++) set(x, 23, Tile.Path);
    for (let z = 18; z <= 20; z++) for (let x = 12; x <= 19; x++) set(x, z, Tile.Bed);            // vegetable patch
    set(21, 19, Tile.Flowers); set(22, 20, Tile.Flowers); set(30, 20, Tile.Flowers); set(3, 17, Tile.Flowers); set(28, 26, Tile.Flowers);
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
      { kind: 'sign', x: 10.5, z: 27.5 }, { kind: 'sign', x: 12.5, z: 5.5 }, { kind: 'sign', x: 29.5, z: 10.5 },
      // east district
      { kind: 'lamp', x: 22.5, z: 10.5 }, { kind: 'lamp', x: 30.5, z: 7.5 }, { kind: 'bench', x: 22.5, z: 5.5, rot: Math.PI / 2 }, { kind: 'barrel', x: 29.5, z: 4.5 }, { kind: 'barrel', x: 29.5, z: 5.5 }, { kind: 'crate', x: 21.5, z: 13.5 },
      { kind: 'campfire', x: 27.5, z: 17.5 }, { kind: 'barrel', x: 30.5, z: 15.5 }, { kind: 'crate', x: 30.5, z: 16.5 }, { kind: 'log', x: 23.5, z: 14.5, rot: Math.PI / 2 }, { kind: 'flowerpot', x: 22.5, z: 3.5 },
      // south district
      { kind: 'lamp', x: 10.5, z: 20.5 }, { kind: 'lamp', x: 8.5, z: 26.5 }, { kind: 'scarecrow', x: 4.5, z: 21.5 }, { kind: 'hay', x: 5.5, z: 28.5 }, { kind: 'hay', x: 3.5, z: 28.5 }, { kind: 'cart', x: 11.5, z: 27.5, rot: 0.2 },
      { kind: 'bench', x: 20.5, z: 24.5 }, { kind: 'flowerpot', x: 12.5, z: 24.5 }, { kind: 'flowerpot', x: 22.5, z: 25.5 }, { kind: 'barrel', x: 28.5, z: 23.5 },
      { kind: 'stall', x: 15.5, z: 6.5, rot: Math.PI },
      { kind: 'barrel', x: 19.5, z: 6.5 }, { kind: 'barrel', x: 19.5, z: 10.5 }, { kind: 'crate', x: 13.5, z: 14.5 }, { kind: 'crate', x: 2.5, z: 5.5 },
      { kind: 'flowerpot', x: 3.5, z: 12.5 }, { kind: 'flowerpot', x: 18.5, z: 11.5 }, { kind: 'flowerpot', x: 12.5, z: 4.5 },
      // smithy yard: anvil and forge
      { kind: 'anvil', x: 26.5, z: 15.5 }, { kind: 'forge', x: 29.5, z: 16.5 },
      // rose bushes by the inn and the south gate
      { kind: 'rosebush', x: 22.5, z: 6.5 }, { kind: 'rosebush', x: 27.5, z: 6.5 }, { kind: 'rosebush', x: 13.5, z: 27.5 },
      // farm yard: wheelbarrow and beehive by the home meadow
      { kind: 'wheelbarrow', x: 10.5, z: 22.5 }, { kind: 'beehive', x: 22.5, z: 39.5 },
    ];
    this.npcs = [
      { id: 'elder', x: 6.5, z: 7.5, facing: 0, wander: 0 },
      { id: 'shopkeeper', x: 15.5, z: 7.6, facing: 0, wander: 0 },
      { id: 'kid', x: 10.5, z: 10.5, facing: 1, wander: 2.5 },
      { id: 'granny', x: 5.5, z: 12.5, facing: 1, wander: 0 },
      { id: 'bard', x: 8.5, z: 11.0, facing: 1, wander: 0 },
      { id: 'farmer', x: 11.5, z: 3.5, facing: 3, wander: 1.5 },
      { id: 'dog', x: 12.5, z: 9.5, facing: 3, wander: 3 },
      { id: 'innkeeper', x: 25.5, z: 6.6, facing: 0, wander: 0 },
      { id: 'smith', x: 27.5, z: 16.5, facing: 3, wander: 1 },
      { id: 'goodwife', x: 15.5, z: 25.5, facing: 0, wander: 2 },
      { id: 'boy', x: 26.5, z: 19.5, facing: 1, wander: 3 },
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

  /** Per-biome ground + path hues (equal brightness, different character). */
  private static PAL: Record<Biome, GroundPal> = {
    meadow:   { grass: '#5fae4c', path: '#d9ab6c' },
    lake:     { grass: '#62b14f', path: '#d7a96c' },
    farm:     { grass: '#63ae4d', path: '#d9ab6c' },
    mesa:     { grass: '#81a357', path: '#c2b190' },
    highland: { grass: '#a89a4e', path: '#c2b190' },
    moor:     { grass: '#7aa555', path: '#c8af76' },
    marsh:    { grass: '#73a752', path: '#d4a97c' },
  };

  /** Core box of each biome (tile coords, inclusive); boundaries blend over ~20 tiles with a smooth wander. */
  private static BIOME_BOX: Record<Biome, readonly [number, number, number, number]> = {
    highland: [149, 0, 207, 43],
    moor:     [141, 44, 207, 119],
    marsh:    [141, 120, 207, 175],
    mesa:     [76, 54, 96, 70],
    farm:     [66, 118, 105, 150],
    lake:     [0, 50, 61, 175],
    meadow:   [0, 0, 139, 175],
  };

  /** Smooth low-frequency noise in 0..1 (bilinear hash, ~9-tile cells) — used to wander biome borders. */
  private static snoise(x: number, z: number, seed: number): number {
    const c = 9;
    const x0 = Math.floor(x / c), z0 = Math.floor(z / c);
    const fx = x / c - x0, fz = z / c - z0;
    const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
    const v00 = hash2(x0, z0, seed), v10 = hash2(x0 + 1, z0, seed), v01 = hash2(x0, z0 + 1, seed), v11 = hash2(x0 + 1, z0 + 1, seed);
    return v00 * (1 - sx) * (1 - sz) + v10 * sx * (1 - sz) + v01 * (1 - sx) * sz + v11 * sx * sz;
  }

  /**
   * Soft biome weights per tile (sum to 1). Inside a biome's core its weight is exactly 1;
   * across ~13 tiles the field blends into the neighbour over ~20 tiles, with a smooth wobble so no border is straight.
   */
  biomeWeights(x: number, z: number): Record<Biome, number> {
    const seeds: [Biome, number][] = [['highland', 11], ['moor', 23], ['marsh', 37], ['mesa', 49], ['farm', 61], ['lake', 73]];
    const w: Record<Biome, number> = { meadow: 0, lake: 0, farm: 0, mesa: 0, highland: 0, moor: 0, marsh: 0 };
    let maxOther = 0;
    for (const [b, seed] of seeds) {
      const [x0, z0, x1, z1] = World.BIOME_BOX[b];
      // wander each edge ±6 tiles with smooth noise (deep interiors stay pure)
      const nx = (World.snoise(x, z, seed) - 0.5) * 12, nz = (World.snoise(x, z, seed + 5) - 0.5) * 12;
      const dx = x < x0 - nx ? x0 - nx - x : x > x1 + nx ? x - x1 - nx : 0;
      const dz = z < z0 - nz ? z0 - nz - z : z > z1 + nz ? z - z1 - nz : 0;
      const t = Math.min(1, Math.hypot(dx, dz) / 20);
      w[b] = 1 - t * t * (3 - 2 * t); // 1 in the core, 0 beyond 20 tiles, smooth in between
      if (w[b] > maxOther) maxOther = w[b];
    }
    w.meadow = Math.max(0, 1 - maxOther); // meadow is the base biome: whatever no other biome claims
    // dapple the blend band (zero in pure cores, up to ±0.25 where two biomes share the ground)
    const mixiness = 1 - Math.max(maxOther, w.meadow);
    if (mixiness > 0.02) {
      for (const [b, seed] of seeds) w[b] = Math.max(0, w[b] + (hash2(x, z, seed + 99) - 0.5) * 0.5 * mixiness);
      w.meadow = Math.max(0, w.meadow + (hash2(x, z, 88) - 0.5) * 0.5 * mixiness);
    }
    const sum = w.meadow + w.lake + w.farm + w.mesa + w.highland + w.moor + w.marsh;
    for (const b of Object.keys(w) as Biome[]) w[b] /= sum;
    return w;
  }

  /** Dominant biome (for discrete decisions like path style, wheat, rock variants). */
  groundRegion(x: number, z: number): Biome {
    const bw = this.biomeWeights(x, z);
    let best: Biome = 'meadow', bwMax = -1;
    for (const b of ['highland', 'moor', 'marsh', 'mesa', 'farm', 'lake', 'meadow'] as Biome[]) {
      if (bw[b] > bwMax) { bwMax = bw[b]; best = b; }
    }
    return best;
  }

  private static hex(h: string): [number, number, number] {
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }

  /** Parse a colour that may be '#rrggbb' or 'rgb(r,g,b)'. */
  private static parseColor(c: string): [number, number, number] {
    if (c[0] === '#') return World.hex(c);
    const m = c.match(/\d+/g)!;
    return [+m[0], +m[1], +m[2]];
  }

  /** Ground types that get a soft blended natural surface (and edge feathering). */
  private static isNatural(t: Tile): boolean {
    return t === Tile.Grass || t === Tile.Flowers || t === Tile.Heather || t === Tile.Mud || t === Tile.ForestFloor || t === Tile.Gravel || t === Tile.DryGrass;
  }

  /** Water's-edge tile: a natural tile right by water, painted as the sand/mud/gravel strip. */
  private isShore(x: number, z: number): boolean {
    return World.isNatural(this.tile(x, z)) && this.riverDist[z * this.w + x] < 0.9;
  }

  /** Water's-edge blend weights: sand by the meadows, mud by the marsh, gravel on the highland. */
  private shoreWeights(x: number, z: number, bw?: Record<Biome, number>) {
    const w = bw ?? this.biomeWeights(x, z);
    const sandW0 = w.meadow + w.lake + w.farm, mudW0 = w.marsh + w.moor * 0.3, gravW0 = w.highland + w.mesa;
    const bsum = sandW0 + mudW0 + gravW0 || 1;
    return { sandW: sandW0 / bsum, mudW: mudW0 / bsum, gravW: gravW0 / bsum };
  }

  /** The colour actually painted on a water's-edge tile; natBase must report this or the feather pass grouts shore tiles with grass. */
  private shoreBase(x: number, z: number, bw?: Record<Biome, number>): string {
    const { sandW, mudW, gravW } = this.shoreWeights(x, z, bw);
    const s = [217, 196, 140], mu = [74, 58, 40], gr = [160, 154, 138];
    return `rgb(${Math.round(sandW * s[0] + mudW * mu[0] + gravW * gr[0])},${Math.round(sandW * s[1] + mudW * mu[1] + gravW * gr[1])},${Math.round(sandW * s[2] + mudW * gr[2])})`;
  }

  /** Mix the biome palettes at (x,z) into concrete [r,g,b] grass + path colours (numeric, no CSS strings). */
  private mixRGB(x: number, z: number, bw?: Record<Biome, number>): { grass: [number, number, number]; path: [number, number, number] } {
    const w = bw ?? this.biomeWeights(x, z);
    const lerp3 = (pick: (p: GroundPal) => [number, number, number]) => {
      let r = 0, g = 0, b = 0;
      for (const bnm of Object.keys(World.PAL) as Biome[]) {
        const wt = w[bnm];
        if (!wt) continue;
        const [pr, pg, pb] = pick(World.PAL[bnm]);
        r += pr * wt; g += pg * wt; b += pb * wt;
      }
      return [Math.min(255, Math.round(r)), Math.min(255, Math.round(g)), Math.min(255, Math.round(b))] as [number, number, number];
    };
    return { grass: lerp3((p) => World.hex(p.grass)), path: lerp3((p) => World.hex(p.path)) };
  }

  /** Mix the biome palettes at (x,z) into concrete colours; shading variants come off one base at fixed contrast. */
  private mixColors(x: number, z: number, bw?: Record<Biome, number>): MixedColors {
    const w = bw ?? this.biomeWeights(x, z);
    const { grass: gc, path: pc } = this.mixRGB(x, z, w);
    const css = (c: [number, number, number], k: number) =>
      `rgb(${Math.min(255, Math.round(c[0] * k))},${Math.min(255, Math.round(c[1] * k))},${Math.min(255, Math.round(c[2] * k))})`;
    return {
      grass: css(gc, 1), grassL: css(gc, 1.17), grassD: css(gc, 0.8),
      path: css(pc, 1), pathL: css(pc, 1.16), pathD: css(pc, 0.78), pathE: css(pc, 0.66),
      daisies: w.meadow + w.lake + w.farm > 0.5,
      pebbly: w.highland + w.mesa > 0.45,
    };
  }

  /**
   * Paint the full-world minimap for the map screen: one pixel per tile, actual terrain colours
   * (biome-mixed ground, real water/road/bridge tiles, trees, houses, shore strips) with a light
   * height-based shading so the relief reads. Fills `img` (MAP_W x MAP_H, RGBA) — the map screen
   * blits this at an integer scale and draws the live world-state overlay on top.
   */
  paintMinimap(img: ImageData) {
    const d = img.data;
    const put = (i: number, r: number, g: number, b: number) => { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; };
    for (let z = 0; z < this.h; z++) for (let x = 0; x < this.w; x++) {
      const i = this.idx(x, z);
      const t = this.tiles[i];
      let r: number, g: number, b: number;
      if (t === Tile.Water) {
        // the Drowned Field's water fades into murky green-brown as the marsh takes over
        const m = this.biomeWeights(x, z).marsh;
        r = 47 + m * 17; g = 96 - m * 4; b = 196 - m * 76;
      } else if (t === Tile.Bridge) {
        r = 185; g = 133; b = 82;
      } else if (t === Tile.Cobble) {
        r = 178; g = 166; b = 142;
      } else if (t === Tile.Bed) {
        r = 130; g = 90; b = 54;
      } else if (t === Tile.Cliff) {
        r = 130; g = 96; b = 64;
      } else {
        // natural ground: the biome-blended grass/path hue, with regional ground types over it
        const c = this.mixRGB(x, z);
        if (t === Tile.Path) { r = c.path[0]; g = c.path[1]; b = c.path[2]; }
        else if (t === Tile.ForestFloor) { r = c.grass[0] * 0.72; g = c.grass[1] * 0.78; b = c.grass[2] * 0.68; }
        else if (t === Tile.Heather) { r = 118; g = 138; b = 90; }
        else if (t === Tile.Mud) { r = 84; g = 69; b = 46; }
        else if (t === Tile.Gravel) { r = 154; g = 148; b = 138; }
        else if (t === Tile.DryGrass) { r = 184; g = 154; b = 74; }
        else if (t === Tile.Flowers) {
          const k = hash2(x, z, 17);
          if (k < 0.28) { r = 232; g = 214; b = 96; }        // bloom speckles
          else { r = c.grass[0] * 1.04; g = c.grass[1] * 1.04; b = c.grass[2] * 1.02; }
        } else { r = c.grass[0]; g = c.grass[1]; b = c.grass[2]; }
        // sand/mud shore strip along the water's edge
        const rd = this.riverDist[i];
        if (rd > 0 && rd < 0.9 && t !== Tile.Path) { r = r * 0.45 + 206 * 0.55; g = g * 0.45 + 186 * 0.55; b = b * 0.45 + 138 * 0.55; }
      }
      // trees: a dithered dark-green canopy over whatever ground is below
      if (this.treeCell[i]) {
        const k = 0.5 + hash2(x, z, 19) * 0.22;
        r = r * (1 - k) + 44 * k; g = g * (1 - k) + 76 * k; b = b * (1 - k) + 40 * k;
      }
      // village houses read as red roofs
      if (this.houseCell[i]) { r = 172; g = 62; b = 54; }
      // gentle relief: higher ground is a touch brighter
      const shade = Math.min(1.14, Math.max(0.68, 0.84 + this.tileH(x, z) * 0.14));
      put(i * 4, Math.min(255, r * shade), Math.min(255, g * shade), Math.min(255, b * shade));
    }
  }

  private paintGrass(g: CanvasRenderingContext2D, ox: number, oz: number, tx: number, tz: number, flowers: boolean, pal: MixedColors) {
    const T = TEX_PX;
    g.fillStyle = pal.grass; g.fillRect(ox, oz, T, T);
    for (let i = 0; i < 6; i++) {
      const x = ox + Math.floor(hash2(tx, tz, i) * T), y = oz + Math.floor(hash2(tx, tz, i + 10) * T);
      g.fillStyle = i % 2 ? pal.grassL : pal.grassD; g.fillRect(x, y, 1, 1);
    }
    if (hash2(tx, tz, 99) < 0.25) {
      const x = ox + 3 + Math.floor(hash2(tx, tz, 98) * (T - 7)), y = oz + 3 + Math.floor(hash2(tx, tz, 97) * (T - 7));
      g.fillStyle = pal.grassD; g.fillRect(x, y, 1, 1); g.fillRect(x + 2, y, 1, 1); g.fillRect(x + 1, y + 1, 1, 1); g.fillRect(x + 1, y - 1, 1, 1);
      g.fillStyle = pal.grassL; g.fillRect(x + 3, y - 1, 1, 1);
    }
    if (pal.daisies && hash2(tx, tz, 71) < 0.14) {
      // daisy
      const x = ox + 3 + Math.floor(hash2(tx, tz, 68) * (T - 7)), y = oz + 3 + Math.floor(hash2(tx, tz, 69) * (T - 7));
      g.fillStyle = '#f8f8f8'; g.fillRect(x - 1, y, 1, 1); g.fillRect(x + 1, y, 1, 1); g.fillRect(x, y - 1, 1, 1); g.fillRect(x, y + 1, 1, 1);
      g.fillStyle = '#f8d848'; g.fillRect(x, y, 1, 1);
    } else if (pal.daisies && hash2(tx, tz, 72) < 0.1) {
      // dandelion
      const x = ox + 3 + Math.floor(hash2(tx, tz, 73) * (T - 7)), y = oz + 3 + Math.floor(hash2(tx, tz, 74) * (T - 7));
      g.fillStyle = '#f8d848'; g.fillRect(x - 1, y, 3, 1); g.fillRect(x, y - 1, 1, 3);
    }
    if (flowers) {
      const petals = ['#f8f8f8', '#f8d848', '#f07070', '#8aa0f8'];
      for (let k = 0; k < 2; k++) {
        const x = ox + 3 + Math.floor(hash2(tx, tz, 50 + k) * (T - 7)), y = oz + 3 + Math.floor(hash2(tx, tz, 60 + k) * (T - 7));
        const pc = petals[Math.floor(hash2(tx, tz, 70 + k) * petals.length)];
        g.fillStyle = pc; g.fillRect(x - 1, y, 1, 1); g.fillRect(x + 1, y, 1, 1); g.fillRect(x, y - 1, 1, 1); g.fillRect(x, y + 1, 1, 1);
        g.fillStyle = pc === '#f8d848' ? '#e05030' : '#f8d848'; g.fillRect(x, y, 1, 1);
        g.fillStyle = pal.grassD; g.fillRect(x - 1, y + 2, 1, 1); g.fillRect(x + 2, y + 1, 1, 1);
      }
    }
  }

  createGroundTexture(): THREE.CanvasTexture {
    const T = TEX_PX, C = World.C;
    const cv = document.createElement('canvas');
    cv.width = this.w * T; cv.height = this.h * T;
    const g = cv.getContext('2d')!;
    const natural = (t: Tile) => World.isNatural(t);
    const land = (t: Tile) => t !== Tile.Water && t !== Tile.Bridge;
    // base colours of each natural ground type (used for edge feathering)
    const BASE: Record<number, string> = {
      [Tile.Heather]: '#779257', [Tile.Mud]: '#54452e', [Tile.ForestFloor]: '#6b7d43', [Tile.Gravel]: '#9a948a', [Tile.DryGrass]: '#b89a4a',
    };
    const grassBaseCache = new Map<number, string>();
    const natBase = (t: Tile, x: number, z: number): string | null => {
      if (this.isShore(x, z)) {
        // the tile was painted as the water's-edge strip, so that — not its tile type — is its base colour
        const k = x * 1000 + z;
        let v = grassBaseCache.get(k);
        if (!v) { v = this.shoreBase(x, z); grassBaseCache.set(k, v); }
        return v;
      }
      if (t === Tile.Grass || t === Tile.Flowers) {
        const k = x * 1000 + z;
        let v = grassBaseCache.get(k);
        if (!v) { v = this.mixColors(x, z).grass; grassBaseCache.set(k, v); }
        return v;
      }
      return BASE[t] ?? null;
    };
    const blendCss = (a: string, b: string, k: number) => {
      const ca = World.parseColor(a), cb = World.parseColor(b);
      return `rgb(${Math.round(ca[0] + (cb[0] - ca[0]) * k)},${Math.round(ca[1] + (cb[1] - ca[1]) * k)},${Math.round(ca[2] + (cb[2] - ca[2]) * k)})`;
    };
    // feather only where the bases really differ: neighbouring tiles of the same surface (shore→shore,
    // or grass→grass along a biome ramp) vary by a few units per tile, and feathering between them
    // would draw grout lines across an otherwise continuous surface
    const colDiff = (a: string, b: string) => {
      const ca = World.parseColor(a), cb = World.parseColor(b);
      return Math.max(Math.abs(ca[0] - cb[0]), Math.abs(ca[1] - cb[1]), Math.abs(ca[2] - cb[2]));
    };
    const FEATHER_MIN = 4;
    for (let tz = 0; tz < this.h; tz++) for (let tx = 0; tx < this.w; tx++) {
      const t = this.tile(tx, tz);
      const ox = tx * T, oz = tz * T;
      const N = this.tile(tx, tz - 1), S = this.tile(tx, tz + 1), E = this.tile(tx + 1, tz), W = this.tile(tx - 1, tz);
      const bw = this.biomeWeights(tx, tz);
      if (this.isShore(tx, tz)) {
        // water's edge strip: sand by the meadows, mud by the marsh, gravel on the highland — blended by biome weight
        const { sandW, mudW, gravW } = this.shoreWeights(tx, tz, bw);
        g.fillStyle = this.shoreBase(tx, tz, bw);
        g.fillRect(ox, oz, T, T);
        const dotC = mudW > sandW && mudW > gravW ? ['#5c4a34', '#3a2e20'] : gravW >= sandW && gravW >= mudW ? ['#b8b2a2', '#847e70'] : ['#e8d6a2', '#bfa66c'];
        for (let i = 0; i < 6; i++) { g.fillStyle = i % 2 ? dotC[0] : dotC[1]; g.fillRect(ox + Math.floor(hash2(tx, tz, i) * (T - 2)), oz + Math.floor(hash2(tx, tz, i + 20) * T), 2, 1); }
        if (sandW >= mudW && sandW >= gravW && hash2(tx, tz, 44) < 0.3) { g.fillStyle = '#9aa0a8'; const x = ox + Math.floor(hash2(tx, tz, 45) * (T - 3)), y = oz + Math.floor(hash2(tx, tz, 46) * (T - 2)); g.fillRect(x, y, 3, 2); g.fillStyle = '#c9ced4'; g.fillRect(x, y, 1, 1); }
      } else if (t === Tile.Grass || t === Tile.Flowers) {
        this.paintGrass(g, ox, oz, tx, tz, t === Tile.Flowers, this.mixColors(tx, tz, bw));
      } else if (t === Tile.Heather) {
        // heather moor: muted green with purple flower clumps and brown tussocks
        g.fillStyle = BASE[t]; g.fillRect(ox, oz, T, T);
        for (let i = 0; i < 7; i++) { const x = ox + Math.floor(hash2(tx, tz, i) * T), y = oz + Math.floor(hash2(tx, tz, i + 10) * T); g.fillStyle = i % 2 ? '#8aa468' : '#627c46'; g.fillRect(x, y, 1, 1); }
        for (let k = 0; k < (hash2(tx, tz, 66) < 0.6 ? 2 : 1); k++) {
          const x = ox + 3 + Math.floor(hash2(tx, tz, 40 + k) * (T - 7)), y = oz + 3 + Math.floor(hash2(tx, tz, 41 + k) * (T - 7));
          for (let b = 0; b < 4; b++) { g.fillStyle = b % 2 ? '#8a6ab0' : '#7a5aa0'; g.fillRect(x + (b % 2), y + Math.floor(b / 2), 1, 1); }
          g.fillStyle = '#a88ac8'; g.fillRect(x, y, 1, 1);
        }
        if (hash2(tx, tz, 67) < 0.3) {
          const x = ox + 3 + Math.floor(hash2(tx, tz, 64) * (T - 7)), y = oz + 3 + Math.floor(hash2(tx, tz, 65) * (T - 7));
          g.fillStyle = '#7a5c3a'; g.fillRect(x, y, 2, 1); g.fillRect(x + 1, y - 1, 1, 1); g.fillRect(x + 1, y + 1, 1, 1);
        }
      } else if (t === Tile.Mud) {
        // marsh mud: dark, wet-glinted, mossy
        g.fillStyle = BASE[t]; g.fillRect(ox, oz, T, T);
        for (let i = 0; i < 7; i++) { const x = ox + Math.floor(hash2(tx, tz, i) * T), y = oz + Math.floor(hash2(tx, tz, i + 10) * T); g.fillStyle = i % 2 ? '#63523a' : '#443726'; g.fillRect(x, y, 2, 1); }
        if (hash2(tx, tz, 62) < 0.45) {
          const x = ox + 3 + Math.floor(hash2(tx, tz, 60) * (T - 7)), y = oz + 3 + Math.floor(hash2(tx, tz, 63) * (T - 7));
          g.fillStyle = '#7a8a94'; g.fillRect(x, y, 3, 1); g.fillStyle = '#94a4ae'; g.fillRect(x + 1, y, 1, 1);
        }
        if (hash2(tx, tz, 64) < 0.3) {
          const x = ox + 3 + Math.floor(hash2(tx, tz, 65) * (T - 8)), y = oz + 3 + Math.floor(hash2(tx, tz, 66) * (T - 8));
          g.fillStyle = '#4a7a3a'; g.fillRect(x, y, 2, 2); g.fillStyle = '#588a44'; g.fillRect(x + 1, y, 1, 1);
        }
        if (hash2(tx, tz, 68) < 0.2) { g.fillStyle = '#8a8478'; g.fillRect(ox + Math.floor(hash2(tx, tz, 69) * (T - 3)), oz + Math.floor(hash2(tx, tz, 70) * T), 2, 1); }
      } else if (t === Tile.ForestFloor) {
        // mossy forest earth with fallen leaves
        g.fillStyle = BASE[t]; g.fillRect(ox, oz, T, T);
        for (let i = 0; i < 7; i++) { const x = ox + Math.floor(hash2(tx, tz, i) * T), y = oz + Math.floor(hash2(tx, tz, i + 10) * T); g.fillStyle = i % 2 ? '#7a8c50' : '#5a6c38'; g.fillRect(x, y, 1, 1); }
        if (hash2(tx, tz, 62) < 0.3) {
          const x = ox + 3 + Math.floor(hash2(tx, tz, 63) * (T - 8)), y = oz + 3 + Math.floor(hash2(tx, tz, 64) * (T - 8));
          g.fillStyle = '#587a3a'; g.fillRect(x, y, 3, 2); g.fillStyle = '#688a46'; g.fillRect(x + 1, y + 1, 1, 1);
        }
        for (let k = 0; k < (hash2(tx, tz, 65) < 0.5 ? 2 : 1); k++) {
          const x = ox + 2 + Math.floor(hash2(tx, tz, 50 + k) * (T - 5)), y = oz + 2 + Math.floor(hash2(tx, tz, 51 + k) * (T - 5));
          g.fillStyle = k % 2 ? '#c8862a' : '#8a5a2b'; g.fillRect(x, y, 2, 1); g.fillRect(x + 1, y + 1, 1, 1);
        }
        if (hash2(tx, tz, 66) < 0.12) { g.fillStyle = '#9a9488'; g.fillRect(ox + Math.floor(hash2(tx, tz, 67) * (T - 3)), oz + Math.floor(hash2(tx, tz, 68) * T), 2, 2); }
      } else if (t === Tile.Gravel) {
        // rocky gravel with sparse dry grass
        g.fillStyle = BASE[t]; g.fillRect(ox, oz, T, T);
        for (let i = 0; i < 8; i++) {
          const x = ox + Math.floor(hash2(tx, tz, i) * (T - 3)), y = oz + Math.floor(hash2(tx, tz, i + 20) * T);
          g.fillStyle = i % 3 === 0 ? '#b0aaa0' : i % 3 === 1 ? '#7d7870' : '#8a8478'; g.fillRect(x, y, 2, hash2(tx, tz, i + 40) < 0.4 ? 2 : 1);
        }
        if (hash2(tx, tz, 62) < 0.35) {
          const x = ox + 3 + Math.floor(hash2(tx, tz, 63) * (T - 7)), y = oz + 3 + Math.floor(hash2(tx, tz, 64) * (T - 7));
          g.fillStyle = '#a89a4e'; g.fillRect(x, y, 1, 1); g.fillRect(x + 2, y, 1, 1); g.fillRect(x + 1, y - 1, 1, 1);
        }
      } else if (t === Tile.DryGrass) {
        // dry ochre steppe grass
        g.fillStyle = BASE[t]; g.fillRect(ox, oz, T, T);
        for (let i = 0; i < 7; i++) { const x = ox + Math.floor(hash2(tx, tz, i) * T), y = oz + Math.floor(hash2(tx, tz, i + 10) * T); g.fillStyle = i % 2 ? '#c8ac5a' : '#9a803c'; g.fillRect(x, y, 1, 1); }
        if (hash2(tx, tz, 99) < 0.3) {
          const x = ox + 3 + Math.floor(hash2(tx, tz, 98) * (T - 7)), y = oz + 3 + Math.floor(hash2(tx, tz, 97) * (T - 7));
          g.fillStyle = '#9a803c'; g.fillRect(x, y, 1, 1); g.fillRect(x + 2, y, 1, 1); g.fillRect(x + 1, y + 1, 1, 1); g.fillRect(x + 1, y - 1, 1, 1);
        }
        if (hash2(tx, tz, 62) < 0.06) {
          // tumbleweed
          const x = ox + 4 + Math.floor(hash2(tx, tz, 63) * (T - 10)), y = oz + 4 + Math.floor(hash2(tx, tz, 64) * (T - 10));
          g.fillStyle = '#a8885a'; g.fillRect(x - 1, y, 3, 1); g.fillRect(x, y - 1, 1, 3); g.fillRect(x - 1, y - 1, 1, 1); g.fillRect(x + 1, y + 1, 1, 1);
          g.fillStyle = '#8a6c44'; g.fillRect(x, y, 1, 1);
        }
        if (hash2(tx, tz, 65) < 0.15) { g.fillStyle = '#8a5a2b'; g.fillRect(ox + Math.floor(hash2(tx, tz, 66) * (T - 4)), oz + Math.floor(hash2(tx, tz, 67) * T), 3, 1); }
      } else if (t === Tile.Path) {
        const pal = this.mixColors(tx, tz, bw);
        g.fillStyle = pal.path; g.fillRect(ox, oz, T, T);
        for (let i = 0; i < 7; i++) {
          const x = ox + Math.floor(hash2(tx, tz, i) * (T - 1)), y = oz + Math.floor(hash2(tx, tz, i + 20) * T);
          g.fillStyle = i % 3 === 0 ? pal.pathL : pal.pathD; g.fillRect(x, y, hash2(tx, tz, i + 40) < 0.4 ? 2 : 1, 1);
        }
        if (pal.pebbly) for (let i = 0; i < 4; i++) { g.fillStyle = i % 2 ? pal.pathL : pal.pathD; g.fillRect(ox + Math.floor(hash2(tx, tz, i + 30) * (T - 3)), oz + Math.floor(hash2(tx, tz, i + 34) * T), 2, 1); }
        const depth = (k: number, s: number) => 1 + (hash2(k, s, 5) < 0.45 ? 1 : 0) + (hash2(k, s, 6) < 0.15 ? 1 : 0);
        // the ground creeping onto the trail takes the neighbour's actual colour (heather, mud, gravel…)
        const cN = natBase(N, tx, tz - 1) ?? pal.grass, cS = natBase(S, tx, tz + 1) ?? pal.grass;
        const cW = natBase(W, tx - 1, tz) ?? pal.grass, cE = natBase(E, tx + 1, tz) ?? pal.grass;
        if (natural(N)) for (let x = 0; x < T; x++) { const d = depth(tx * T + x, tz * 7 + 1); g.fillStyle = cN; g.fillRect(ox + x, oz, 1, d); g.fillStyle = pal.pathE; g.fillRect(ox + x, oz + d, 1, 1); }
        if (natural(S)) for (let x = 0; x < T; x++) { const d = depth(tx * T + x, tz * 7 + 2); g.fillStyle = cS; g.fillRect(ox + x, oz + T - d, 1, d); g.fillStyle = pal.pathE; g.fillRect(ox + x, oz + T - d - 1, 1, 1); }
        if (natural(W)) for (let y = 0; y < T; y++) { const d = depth(tz * T + y, tx * 7 + 3); g.fillStyle = cW; g.fillRect(ox, oz + y, d, 1); g.fillStyle = pal.pathE; g.fillRect(ox + d, oz + y, 1, 1); }
        if (natural(E)) for (let y = 0; y < T; y++) { const d = depth(tz * T + y, tx * 7 + 4); g.fillStyle = cE; g.fillRect(ox + T - d, oz + y, d, 1); g.fillStyle = pal.pathE; g.fillRect(ox + T - d - 1, oz + y, 1, 1); }
        g.fillStyle = pal.grass;
        if (!natural(N) && !natural(W) && natural(this.tile(tx - 1, tz - 1))) g.fillRect(ox, oz, 2, 2);
        if (!natural(N) && !natural(E) && natural(this.tile(tx + 1, tz - 1))) g.fillRect(ox + T - 2, oz, 2, 2);
        if (!natural(S) && !natural(W) && natural(this.tile(tx - 1, tz + 1))) g.fillRect(ox, oz + T - 2, 2, 2);
        if (!natural(S) && !natural(E) && natural(this.tile(tx + 1, tz + 1))) g.fillRect(ox + T - 2, oz + T - 2, 2, 2);
      } else if (t === Tile.Water) {
        // the Drowned Field's water fades into murky green-brown as the marsh biome takes over
        const murk = bw.marsh;
        const ww = murk > 0.02 ? blendCss(C.water, '#4a6a52', murk) : C.water;
        const wl = murk > 0.02 ? blendCss(C.waterL, '#7a9a78', murk) : C.waterL;
        const wd = murk > 0.02 ? blendCss(C.waterD, '#3a5442', murk) : C.waterD;
        const ws = murk > 0.02 ? blendCss(C.shore, '#2a3a2c', murk) : C.shore;
        g.fillStyle = ww; g.fillRect(ox, oz, T, T);
        for (let i = 0; i < 3; i++) {
          const x = ox + Math.floor(hash2(tx, tz, i) * (T - 6)), y = oz + 2 + Math.floor(hash2(tx, tz, i + 30) * (T - 4));
          const len = 3 + Math.floor(hash2(tx, tz, i + 60) * 3);
          g.fillStyle = i === 0 ? wl : wd; g.fillRect(x, y, len, 1);
          if (i === 0) g.fillRect(x + 1, y + 1, 1, 1);
        }
        if (land(N)) { g.fillStyle = ws; g.fillRect(ox, oz, T, 1); g.fillStyle = wl; g.fillRect(ox, oz + 1, T, 1); }
        if (land(S)) { g.fillStyle = ws; g.fillRect(ox, oz + T - 1, T, 1); g.fillStyle = wl; g.fillRect(ox, oz + T - 2, T, 1); }
        if (land(W)) { g.fillStyle = ws; g.fillRect(ox, oz, 1, T); g.fillStyle = wl; g.fillRect(ox + 1, oz, 1, T); }
        if (land(E)) { g.fillStyle = ws; g.fillRect(ox + T - 1, oz, 1, T); g.fillStyle = wl; g.fillRect(ox + T - 2, oz, 1, T); }
        g.fillStyle = ws;
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
        // tilled soil rows with little plants (Millbrook grows golden wheat)
        const wheat = bw.farm > 0.5;
        g.fillStyle = wheat ? '#7a5230' : C.soil; g.fillRect(ox, oz, T, T);
        for (let y = 2; y < T; y += 5) { g.fillStyle = wheat ? '#9a6e46' : C.soilL; g.fillRect(ox, oz + y, T, 1); g.fillStyle = '#5a3a1e'; g.fillRect(ox, oz + y + 3, T, 1); }
        for (let i = 0; i < 4; i++) {
          const x = ox + 2 + (i * 5) % (T - 3), y = oz + 3 + Math.floor(hash2(tx, tz, i) * 3) * 5;
          const c = hash2(tx, tz, i + 8) < 0.5 ? (wheat ? '#d8b84a' : C.leaf) : (wheat ? '#c8a23f' : C.leafL);
          g.fillStyle = c; g.fillRect(x - 1, y, 3, 1); g.fillRect(x, y - 1, 1, 3);
          if (wheat) { g.fillStyle = '#e8d070'; g.fillRect(x, y - 1, 1, 1); } // grain head
          else if (hash2(tx, tz, i + 16) < 0.3) { g.fillStyle = '#ff6a3d'; g.fillRect(x, y, 1, 1); }
        }
        g.fillStyle = '#5a3a1e'; g.fillRect(ox, oz, T, 1); g.fillRect(ox, oz, 1, T);
      }
      // feather this tile's edges into differently-coloured natural neighbours: a wavy, dithered
      // gradient band (pure neighbour colour at the seam, stepping back into own with dither).
      // ONE-SIDED: only the lower-ranked surface of a pair paints the band, so the seam reads as
      // grass-then-sand-fringe-then-sand instead of grass|sand sliver|grass sliver|sand.
      // Ranks: the meadow background yields to everything, wet/rocky surfaces stay solid longest.
      if (natural(t)) {
        const own = natBase(t, tx, tz);
        if (own) {
          const rank = (tt: Tile, x: number, z: number): number => {
            if (this.isShore(x, z)) return 6;
            switch (tt) {
              case Tile.Mud: return 5;
              case Tile.Gravel: return 4;
              case Tile.Heather: return 3;
              case Tile.DryGrass: return 3;
              case Tile.ForestFloor: return 2;
              default: return 1; // Grass, Flowers: the background, yields to everything
            }
          };
          const ownRank = rank(t, tx, tz);
          const nN = natBase(N, tx, tz - 1), nS = natBase(S, tx, tz + 1), nE = natBase(E, tx + 1, tz), nW = natBase(W, tx - 1, tz);
          const featherEdge = (n: string, seed: number, put: (i: number, d: number) => [number, number]) => {
            const c1 = blendCss(own, n, 0.65), c2 = blendCss(own, n, 0.35), c3 = blendCss(own, n, 0.15);
            const paint = (i: number, d: number, col: string) => {
              if (d < 0 || d >= T) return;
              const [x, y] = put(i, d);
              g.fillStyle = col; g.fillRect(x, y, 1, 1);
            };
            for (let i = 0; i < T; i++) {
              // wavy seam: the band's depth wanders 0..2 px, changing every 3 px along the edge
              const wob = Math.floor(hash2(Math.floor(i / 3) + seed * 131 + tx * 4 + tz * 4, seed + 7, 2) * 3);
              paint(i, 0, n);
              if (wob >= 1) paint(i, 1, n);
              if (wob >= 2) paint(i, 2, n);
              const p = 1 + wob;
              if (hash2(i + seed * 17, tx + tz, 81) < 0.85) paint(i, p, c1);
              if (hash2(i + seed * 17, tx + tz, 82) < 0.6) paint(i, p + 1, c2);
              if (hash2(i + seed * 17, tx + tz, 83) < 0.3) paint(i, p + 2, c3);
            }
          };
          // exactly one tile of each pair paints: the lower rank, ties broken deterministically
          const side = (n: string | null, nt: Tile, nx: number, nz: number, seed: number, put: (i: number, d: number) => [number, number]) => {
            if (!n || colDiff(n, own) <= FEATHER_MIN) return;
            const nr = rank(nt, nx, nz);
            if (ownRank < nr || (ownRank === nr && own < n)) featherEdge(n, seed, put);
          };
          side(nN, N, tx, tz - 1, 0, (i, d) => [ox + i, oz + d]);
          side(nS, S, tx, tz + 1, 1, (i, d) => [ox + i, oz + T - 1 - d]);
          side(nW, W, tx - 1, tz, 2, (i, d) => [ox + d, oz + i]);
          side(nE, E, tx + 1, tz, 3, (i, d) => [ox + T - 1 - d, oz + i]);
        }
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
      if (b.deadEnd) {
        // jetty: flat plank deck on stilts, a mooring post at the far end
        g.add(new THREE.Mesh(new THREE.BoxGeometry(len, 0.1, wid - 0.1), plank).translateY(b.y - 0.05));
        for (let k = 0; k < len * 2; k++) { const gr = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.02, wid - 0.1), dark); gr.position.set(-len / 2 + 0.25 + k * 0.5, b.y, 0); g.add(gr); }
        for (let k = 0; k <= len; k += 2) for (const side of [-1, 1]) { const st = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.3, 0.12), dark); st.position.set(-len / 2 + 0.2 + k, b.y - 0.6, side * (wid / 2 - 0.15)); g.add(st); }
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.7, 0.14), dark); post.position.set(len / 2 - 0.2, b.y + 0.3, wid / 2 - 0.2); g.add(post);
        group.add(g);
        continue;
      }
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
    this.paintGrass(g, 0, 0, 7, 7, false, this.mixColors(60, 20)); // deep meadow: pure palette
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
