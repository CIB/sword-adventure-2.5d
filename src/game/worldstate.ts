import { MAP_W, MAP_H, Tile, RNG } from './constants';
import type { World, EnemyKind, Vec2, Biome } from './world';

/**
 * World state: the persistent, low-resolution model of everything that exists outside the active
 * simulation region around the player.
 *
 * The full game world is far too big to simulate every soldier at entity resolution, so the world
 * is split into chunks of CHUNK_T x CHUNK_T tiles. Each chunk stores cheap aggregates of the
 * terrain (dominant ground, water/tree/walkable fractions, biome) plus a chunk-level *road graph* —
 * which of its 4 neighbours a road physically connects to. The terrain is generated so that roads
 * and rivers only ever CROSS chunk borders, never run along them (see the alignment tests), which
 * keeps the chunk model a faithful picture of the world.
 *
 * Soldiers live here as GUARD POSTS, not spawn points and not marching columns. Each post is a
 * named patch of the world — a bridge, a wood, a hill fort — that a handful of soldiers hold. Every
 * member has a spot inside the patch; while nothing is happening they stand guard and wander about
 * their own ground at random (tightly on a bridge deck, loosely across a wood), the way the old
 * hand-placed soldiers did. Nobody patrols a road.
 *
 * A post that loses a man recruits: after a delay a replacement appears on the map's edge, where
 * the roads run off the world, and walks the road network in to take up the fallen guard's spot.
 * The fallen soldier himself never comes back.
 *
 * The Game only *materialises* the soldiers near the player into live Enemy entities; those
 * entities wander their post's patch (or march their reinforcement route) on their own, and their
 * positions are mirrored back here every frame. Everything in here is plain data (no THREE, no
 * DOM), deliberately structured-clone friendly: the next step is to run the simulation tick in a
 * Web Worker at a low tick rate and ship snapshots/diffs across the thread boundary.
 */

/** tiles per world-state chunk side (MAP_W and MAP_H are multiples of this) */
export const CHUNK_T = 8;
export const CHUNKS_X = MAP_W / CHUNK_T; // 26
export const CHUNKS_Z = MAP_H / CHUNK_T; // 22

/** tiles that count as "road" for the chunk road graph and the reinforcement network */
const ROAD_TILES = new Set<number>([Tile.Path, Tile.Bridge, Tile.Cobble]);

export interface ChunkInfo {
  cx: number;
  cz: number;
  /** most common tile type in the chunk (ties broken by first-seen) */
  ground: Tile;
  /** fraction of tiles that are water */
  water: number;
  /** fraction of tiles carrying a tree */
  trees: number;
  /** fraction of tiles that are walkable (not solid) */
  walkable: number;
  /** chunk contains at least one road tile (path / bridge / cobble) */
  road: boolean;
  /** road physically continues into the neighbouring chunk (chunk-level road graph edges) */
  roadN: boolean;
  roadE: boolean;
  roadS: boolean;
  roadW: boolean;
  /** chunk overlaps the village bounds */
  village: boolean;
  /** dominant biome at the chunk centre */
  biome: Biome;
}

/** 'post' = holding ground in the patch, 'enroute' = a replacement walking in, 'down' = fallen */
export type SoldierState = 'post' | 'enroute' | 'down';

export interface WorldSoldier {
  id: number;
  kind: EnemyKind;
  /** position in world tiles (float). While materialised this mirrors the live entity. */
  x: number;
  z: number;
  state: SoldierState;
  /** the spot in the post's patch this guard holds (wander centre; where a recruit ends up) */
  hx: number;
  hz: number;
  /** where the guard is walking to: a wander target on post, the current waypoint when enroute */
  tx: number;
  tz: number;
  /** index of the next route waypoint (enroute only) */
  wp: number;
  /** seconds of standing about left before the next wander target (cold simulation) */
  idle: number;
  /** seconds spent failing to make progress toward the current target (stuck detector) */
  stuck: number;
  /** materialised as a live entity near the player (the entity owns this soldier's movement) */
  hot: boolean;
}

export interface Post {
  id: number;
  name: string;
  /** patch the post holds: centre + radii in tiles (an ellipse) */
  cx: number;
  cz: number;
  rx: number;
  rz: number;
  /** a tight knot of guards (bridges, camps) instead of a loose roam */
  tight: boolean;
  /** the guard spots in the patch: one per soldier the post fields */
  homes: Vec2[];
  members: WorldSoldier[];
  /** road route a replacement walks in on (map edge -> near the patch), tile centres */
  route: Vec2[];
  /** the road tile on the map's edge replacements appear on (null when the post recruits nobody) */
  entry: Vec2 | null;
  /** replacements owed (one per fall not yet answered), by the kind that fell */
  queue: EnemyKind[];
  /** falls already counted into the queue */
  fallen: number;
  /** countdown to the next replacement */
  recruitT: number;
  /** seconds between replacements */
  reinforce: number;
}

/** chunk-coordinate bounding box (inclusive) */
export interface ChunkBox { cx0: number; cz0: number; cx1: number; cz1: number }

/** how far a guard wanders from its spot, in tiles (tight knots barely shift their feet) */
const WANDER_TIGHT = 1.5;
/** stroll speed on post / marching speed on the reinforcement road, tiles per second */
const STROLL_TIGHT = 0.4;
const STROLL = 0.85;
const MARCH = 1.6;

export class WorldState {
  chunks: ChunkInfo[] = [];
  /** village bounds in chunk coordinates (drawn on the map, and a no-go area for the world sim) */
  village: ChunkBox;
  /** resolved map-edge road points that replacements march in from (world positions) */
  entries: Record<string, Vec2> = {};
  /** the same entries as tile indices (what the route pathfinding works in) */
  private entryTiles: Record<string, Vec2> = {};
  /** the guard posts: centres of the 'cluster' ones are drawn as camps on the map */
  camps: Vec2[] = [];
  posts: Post[] = [];

  /** per-tile road network: 1 = road tile, walkable, outside the village */
  private net = new Uint8Array(MAP_W * MAP_H);
  private rng = new RNG(0x5eed);
  private nextId = 0;

  constructor(private world: World) {
    this.village = {
      cx0: Math.floor(world.village.x0 / CHUNK_T), cz0: Math.floor(world.village.z0 / CHUNK_T),
      cx1: Math.floor(world.village.x1 / CHUNK_T), cz1: Math.floor(world.village.z1 / CHUNK_T),
    };
    this.analyzeChunks();
    this.buildNetwork();
    this.buildPosts();
  }

  idx(cx: number, cz: number) { return cz * CHUNKS_X + cx; }
  chunk(cx: number, cz: number): ChunkInfo { return this.chunks[this.idx(cx, cz)]; }
  /** the chunk containing a world-tile position */
  chunkAt(x: number, z: number): ChunkInfo | null {
    const cx = Math.floor(x / CHUNK_T), cz = Math.floor(z / CHUNK_T);
    if (cx < 0 || cz < 0 || cx >= CHUNKS_X || cz >= CHUNKS_Z) return null;
    return this.chunks[this.idx(cx, cz)];
  }

  // ---------------------------------------------------------------- chunk analysis
  private analyzeChunks() {
    const world = this.world;
    const isRoad = (x: number, z: number) =>
      x >= 0 && z >= 0 && x < MAP_W && z < MAP_H && ROAD_TILES.has(world.tile(x, z));

    for (let cz = 0; cz < CHUNKS_Z; cz++) for (let cx = 0; cx < CHUNKS_X; cx++) {
      const x0 = cx * CHUNK_T, z0 = cz * CHUNK_T;
      const counts = new Map<Tile, number>();
      let water = 0, trees = 0, walkable = 0, road = false;
      for (let dz = 0; dz < CHUNK_T; dz++) for (let dx = 0; dx < CHUNK_T; dx++) {
        const x = x0 + dx, z = z0 + dz;
        const t = world.tile(x, z);
        counts.set(t, (counts.get(t) ?? 0) + 1);
        if (t === Tile.Water) water++;
        if (world.treeCell[world.idx(x, z)]) trees++;
        if (!world.isSolidTile(x, z)) walkable++;
        if (ROAD_TILES.has(t)) road = true;
      }
      let ground: Tile = Tile.Grass, best = -1;
      for (const [t, n] of counts) if (n > best) { best = n; ground = t; }
      const n = CHUNK_T * CHUNK_T;
      // dominant biome at the chunk centre
      const bw = world.biomeWeights(x0 + CHUNK_T / 2, z0 + CHUNK_T / 2);
      let biome: Biome = 'meadow', bb = -1;
      for (const k of Object.keys(bw) as Biome[]) if (bw[k] > bb) { bb = bw[k]; biome = k; }
      const v = world.village;
      const village = x0 <= v.x1 && x0 + CHUNK_T - 1 >= v.x0 && z0 <= v.z1 && z0 + CHUNK_T - 1 >= v.z0;
      this.chunks.push({
        cx, cz, ground, water: water / n, trees: trees / n, walkable: walkable / n,
        road, roadN: false, roadE: false, roadS: false, roadW: false, village, biome,
      });
    }

    // road graph edges: a road tile on this chunk's border row must meet a road tile on the
    // neighbour's adjacent row (±1 tile of slack so diagonal-ish road crossings still connect)
    const meets = (ax: (i: number) => number, az: (i: number) => number, bx: (i: number) => number, bz: (i: number) => number) => {
      for (let i = 0; i < CHUNK_T; i++) {
        if (!isRoad(ax(i), az(i))) continue;
        for (let o = -1; o <= 1; o++) if (isRoad(bx(i + o), bz(i + o))) return true;
      }
      return false;
    };
    for (let cz = 0; cz < CHUNKS_Z; cz++) for (let cx = 0; cx < CHUNKS_X; cx++) {
      const c = this.chunk(cx, cz);
      if (!c.road) continue;
      const x0 = cx * CHUNK_T, z0 = cz * CHUNK_T, x1 = x0 + CHUNK_T - 1, z1 = z0 + CHUNK_T - 1;
      if (cz > 0 && this.chunk(cx, cz - 1).road) c.roadN = meets((i) => x0 + i, () => z0, (i) => x0 + i, () => z0 - 1);
      if (cz < CHUNKS_Z - 1 && this.chunk(cx, cz + 1).road) c.roadS = meets((i) => x0 + i, () => z1, (i) => x0 + i, () => z1 + 1);
      if (cx > 0 && this.chunk(cx - 1, cz).road) c.roadW = meets(() => x0, (i) => z0 + i, () => x0 - 1, (i) => z0 + i);
      if (cx < CHUNKS_X - 1 && this.chunk(cx + 1, cz).road) c.roadE = meets(() => x1, (i) => z0 + i, () => x1 + 1, (i) => z0 + i);
    }
  }

  // ---------------------------------------------------------------- road network
  /**
   * The tile-level network reinforcements march in on: every road tile (path / bridge / cobble)
   * that is walkable (no tents, menhirs, crates... standing on it) and outside the village
   * (expanded by a tile, so a column never squeezes past the fence).
   */
  private buildNetwork() {
    const world = this.world;
    const v = world.village;
    for (let z = 0; z < MAP_H; z++) for (let x = 0; x < MAP_W; x++) {
      const inVillage = x >= v.x0 - 1 && x <= v.x1 + 1 && z >= v.z0 - 1 && z <= v.z1 + 1;
      if (inVillage) continue;
      const i = world.idx(x, z);
      this.net[i] = ROAD_TILES.has(world.tiles[i]) && !world.solid[i] ? 1 : 0;
    }
  }

  /** nearest network tile to a world position (spiral search, ~6 tile radius) */
  private snapToNet(x: number, z: number): Vec2 | null {
    const tx = Math.floor(x), tz = Math.floor(z);
    for (let r = 0; r <= 6; r++) {
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const nx = tx + dx, nz = tz + dz;
        if (nx >= 0 && nz >= 0 && nx < MAP_W && nz < MAP_H && this.net[nz * MAP_W + nx]) return { x: nx, z: nz };
      }
    }
    return null;
  }

  /**
   * BFS across the road network from tile (ax,az) to (bx,bz). 8-directional, but a diagonal step
   * is only allowed when both orthogonal neighbours are road too (no cutting corners off-road).
   * Returns tile-centre points; null when the stops aren't connected.
   */
  private pathfind(ax: number, az: number, bx: number, bz: number): Vec2[] | null {
    const start = az * MAP_W + ax, goal = bz * MAP_W + bx;
    if (!this.net[start] || !this.net[goal]) return null;
    const prev = new Int32Array(MAP_W * MAP_H).fill(-2);
    prev[start] = -1;
    const queue = [start];
    for (let qi = 0; qi < queue.length; qi++) {
      const cur = queue[qi];
      if (cur === goal) break;
      const cx = cur % MAP_W, cz = (cur / MAP_W) | 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= MAP_W || nz >= MAP_H) continue;
        const ni = nz * MAP_W + nx;
        if (!this.net[ni] || prev[ni] !== -2) continue;
        if (dx && dz && (!this.net[cz * MAP_W + nx] || !this.net[nz * MAP_W + cx])) continue; // no corner cutting
        prev[ni] = cur;
        queue.push(ni);
      }
    }
    if (prev[goal] === -2) return null;
    const out: Vec2[] = [];
    for (let cur = goal; cur !== -1; cur = prev[cur]) out.push({ x: (cur % MAP_W) + 0.5, z: ((cur / MAP_W) | 0) + 0.5 });
    out.reverse();
    return out;
  }

  /** drop collinear points: keep only corners (and the endpoints) of a tile path */
  private compress(points: Vec2[]): Vec2[] {
    if (points.length < 3) return points.slice();
    const out = [points[0]];
    for (let i = 1; i < points.length - 1; i++) {
      const a = points[i - 1], b = points[i], c = points[i + 1];
      const d1x = Math.sign(b.x - a.x), d1z = Math.sign(b.z - a.z);
      const d2x = Math.sign(c.x - b.x), d2z = Math.sign(c.z - b.z);
      if (d1x !== d2x || d1z !== d2z) out.push(b);
    }
    out.push(points[points.length - 1]);
    return out;
  }

  // ---------------------------------------------------------------- geometry helpers
  /** is (x,z) inside the village's no-go box (with a tile of slack for the fence line)? */
  private inVillage(x: number, z: number): boolean {
    const v = this.world.village;
    return x > v.x0 - 0.5 && x < v.x1 + 1.5 && z > v.z0 - 0.5 && z < v.z1 + 1.5;
  }

  /** normalised distance from a post's centre: 1 = on the edge of its patch */
  private offCentre(p: Post, x: number, z: number): number {
    return Math.hypot((x - p.cx) / p.rx, (z - p.cz) / p.rz);
  }

  /**
   * A tile centre inside the post's patch to stand guard on. `roomy` also wants the eight tiles
   * around it clear, so a guard put here can actually walk about instead of being wedged in a
   * one-tile pocket of forest; `offRoad` keeps it off the paths, so a post guards the land rather
   * than the road through it. Callers relax the two in turn when a patch is too tight to have both.
   */
  private spotInPatch(p: Post, cx: number, cz: number, radius: number, roomy = true, offRoad = true): Vec2 | null {
    for (let tries = 0; tries < 40; tries++) {
      const a = this.rng.next() * Math.PI * 2;
      const r = Math.sqrt(this.rng.next()) * radius;
      let x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      const k = this.offCentre(p, x, z);
      if (k > 0.97) { const s = 0.97 / k; x = p.cx + (x - p.cx) * s; z = p.cz + (z - p.cz) * s; }
      const tx = Math.floor(x), tz = Math.floor(z);
      if (tx < 1 || tz < 1 || tx >= MAP_W - 1 || tz >= MAP_H - 1) continue;
      if (this.inVillage(tx + 0.5, tz + 0.5)) continue;
      // rounding to the tile centre can nudge a clamped point back out of the patch
      if (this.offCentre(p, tx + 0.5, tz + 0.5) > 1) continue;
      let clear = !this.world.isSolidTile(tx, tz);
      if (clear && roomy) {
        for (let dz = -1; dz <= 1 && clear; dz++) for (let dx = -1; dx <= 1; dx++) {
          if (this.world.isSolidTile(tx + dx, tz + dz)) { clear = false; break; }
        }
      }
      if (!clear) continue;
      if (offRoad && ROAD_TILES.has(this.world.tiles[this.world.idx(tx, tz)])) continue;
      return { x: tx + 0.5, z: tz + 0.5 };
    }
    return null;
  }

  /**
   * Every walkable tile in the patch, grouped by how good a standing spot it is: `roomy` ones
   * have their eight neighbours clear, so a guard there can actually turn about; the `Off`
   * groups keep off the roads, so a post guards the land rather than the path through it.
   * Enumerating beats probing at random — a bridge deck only has a handful of roomy tiles, and
   * two guards drawing the same one would stand on top of each other.
   */
  private patchSpots(p: Post, radius: number) {
    const out = { roomyOff: [] as Vec2[], plainOff: [] as Vec2[], roomyRoad: [] as Vec2[], plainRoad: [] as Vec2[] };
    const r = Math.min(radius, Math.max(p.rx, p.rz));
    const x0 = Math.max(1, Math.floor(p.cx - r)), x1 = Math.min(MAP_W - 2, Math.ceil(p.cx + r));
    const z0 = Math.max(1, Math.floor(p.cz - r)), z1 = Math.min(MAP_H - 2, Math.ceil(p.cz + r));
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      if (this.offCentre(p, x + 0.5, z + 0.5) > 1) continue;
      if (this.world.isSolidTile(x, z)) continue;
      if (this.inVillage(x + 0.5, z + 0.5)) continue;
      let roomy = true;
      for (let dz = -1; dz <= 1 && roomy; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (this.world.isSolidTile(x + dx, z + dz)) { roomy = false; break; }
      }
      const v = { x: x + 0.5, z: z + 0.5 };
      if (roomy) (ROAD_TILES.has(this.world.tiles[this.world.idx(x, z)]) ? out.roomyRoad : out.roomyOff).push(v);
      else (ROAD_TILES.has(this.world.tiles[this.world.idx(x, z)]) ? out.plainRoad : out.plainOff).push(v);
    }
    return out;
  }

  private shuffle<T>(list: T[]): T[] {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng.next() * (i + 1));
      const t = list[i]; list[i] = list[j]; list[j] = t;
    }
    return list;
  }

  // ---------------------------------------------------------------- posts
  /**
   * Build every guard post from the world's specs: guard spots scattered through its patch, a
   * reinforcement route pathfound from its map-edge entry to the nearest road tile by the patch,
   * and its first watch. Throws on an unresolvable entry or an empty patch — that's a
   * world-generation bug, and the tests catch it.
   */
  private buildPosts() {
    this.rng = new RNG(0x5eed);
    this.nextId = 0;
    this.entries = {};
    this.entryTiles = {};
    for (const [id, [x, z]] of Object.entries(this.world.edgeEntries)) {
      const tile = this.snapToNet(x, z);
      if (!tile) throw new Error(`edge entry '${id}' at ${x},${z} is not on the road network`);
      this.entryTiles[id] = tile;                       // tile indices, for pathfinding
      this.entries[id] = { x: tile.x + 0.5, z: tile.z + 0.5 }; // world position, like every other point
    }
    // camps for the map: the centres of the tight posts (the garrisons and bridge guards)
    this.camps = this.world.posts.filter((s) => s.style === 'cluster').map((s) => ({ x: s.at[0], z: s.at[1] }));

    this.posts = this.world.posts.map((spec, id) => {
      const p: Post = {
        id, name: spec.name,
        cx: spec.at[0], cz: spec.at[1], rx: spec.rx, rz: spec.rz,
        tight: spec.style === 'cluster',
        homes: [], members: [], route: [], entry: null,
        queue: [], fallen: 0, recruitT: spec.reinforce ?? 55, reinforce: spec.reinforce ?? 55,
      };
      // guard spots: packed near the centre for a tight post, scattered through the patch otherwise.
      // Each soldier gets its own tile, drawn from the best group the patch has enough of.
      const R = Math.max(p.rx, p.rz);
      const tightR = R * (p.tight ? 0.45 : 0.92);
      let spots = this.patchSpots(p, tightR);
      const count = (s: typeof spots) => s.roomyOff.length + s.plainOff.length + s.roomyRoad.length + s.plainRoad.length;
      if (count(spots) < spec.kinds.length && tightR < R) spots = this.patchSpots(p, R);
      const pool = [...this.shuffle(spots.roomyOff), ...this.shuffle(spots.plainOff),
        ...this.shuffle(spots.roomyRoad), ...this.shuffle(spots.plainRoad)];
      for (let i = 0; i < spec.kinds.length; i++) {
        const spot = pool[i] ?? (() => { const f = this.world.nearestFree(p.cx, p.cz); return { x: f.x, z: f.z }; })();
        p.homes.push(spot);
      }
      if (!p.homes.length) throw new Error(`guard post '${spec.name}' has no soldiers`);
      // the reinforcement route: map edge -> the road tile nearest the patch. Soldiers walk the
      // last stretch cross-country to their own spot.
      if (spec.entry) {
        const entry = this.entryTiles[spec.entry];
        if (!entry) throw new Error(`guard post '${spec.name}': unknown entry '${spec.entry}'`);
        const near = this.nearestRoadTo(p.cx, p.cz);
        if (!near) throw new Error(`guard post '${spec.name}': no road near its patch`);
        const path = this.pathfind(entry.x, entry.z, near.x, near.z);
        if (!path) throw new Error(`guard post '${spec.name}': no road path from '${spec.entry}'`);
        p.route = this.compress(path);
        p.entry = this.entries[spec.entry];
      }
      // the first watch: everyone on their spot, glancing about
      p.members = spec.kinds.map((kind, i) => this.newSoldier(kind, p.homes[i]));
      return p;
    });
  }

  /** nearest road-network tile to a world position (spiral search over the whole map, bounded) */
  private nearestRoadTo(x: number, z: number): Vec2 | null {
    const tx = Math.floor(x), tz = Math.floor(z);
    for (let r = 0; r <= 40; r++) {
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const nx = tx + dx, nz = tz + dz;
        if (nx < 0 || nz < 0 || nx >= MAP_W || nz >= MAP_H) continue;
        if (this.net[nz * MAP_W + nx]) return { x: nx, z: nz };
      }
    }
    return null;
  }

  /** a fresh soldier record standing on a guard spot */
  private newSoldier(kind: EnemyKind, home: Vec2): WorldSoldier {
    return {
      id: this.nextId++, kind, x: home.x, z: home.z, state: 'post',
      hx: home.x, hz: home.z, tx: home.x, tz: home.z,
      wp: 0, idle: this.rng.next() * 3, stuck: 0, hot: false,
    };
  }

  /** living (not fallen) members of a post */
  static living(p: Post): WorldSoldier[] { return p.members.filter((m) => m.state !== 'down'); }

  /**
   * The point a materialised soldier is walking to, or null when it is free to wander its patch:
   * the next waypoint of its reinforcement route, then its own guard spot.
   */
  static targetFor(p: Post, index: number): Vec2 | null {
    const m = p.members[index];
    if (!m || m.state !== 'enroute') return null;
    return m.wp < p.route.length ? p.route[m.wp] : { x: m.hx, z: m.hz };
  }

  /** pick the next wander target: somewhere on this guard's own ground */
  private pickWander(p: Post, m: WorldSoldier) {
    const radius = p.tight ? WANDER_TIGHT : Math.max(2.5, Math.min(p.rx, p.rz) * 0.6);
    const spot = this.spotInPatch(p, m.hx, m.hz, radius)
      ?? this.spotInPatch(p, m.hx, m.hz, radius, false)
      ?? this.spotInPatch(p, m.hx, m.hz, radius, false, false);
    if (spot) { m.tx = spot.x; m.tz = spot.z; return; }
    m.tx = m.hx; m.tz = m.hz;
  }

  /**
   * Walk a soldier toward a point with the same box physics the live entities use (so it slides
   * around trees and stops at cliffs instead of walking through them). Returns the distance moved.
   */
  private stepToward(m: WorldSoldier, tx: number, tz: number, speed: number, dt: number): number {
    let dx = tx - m.x, dz = tz - m.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-4) return 0;
    dx /= d; dz /= d;
    const ox = m.x, oz = m.z;
    this.world.moveBox(m, dx * speed * dt, dz * speed * dt, 0.3, 0.25, speed * dt);
    // the village is a safe haven: soldiers never cross the fence line
    if (this.inVillage(m.x, m.z)) { m.x = ox; m.z = oz; }
    return Math.hypot(m.x - ox, m.z - oz);
  }

  /** a guard on its patch: stand about, then stroll to a new spot on its own ground */
  private wander(p: Post, m: WorldSoldier, dt: number) {
    if (m.idle > 0) {
      m.idle -= dt;
      if (m.idle > 0) return;
      this.pickWander(p, m);
    }
    const speed = p.tight ? STROLL_TIGHT : STROLL;
    const moved = this.stepToward(m, m.tx, m.tz, speed, dt);
    m.stuck = moved < speed * dt * 0.4 ? m.stuck + dt : 0;
    if (Math.hypot(m.tx - m.x, m.tz - m.z) < 0.4) {
      // arrived: stand guard for a while (tight posts mostly stand and glance around)
      m.idle = p.tight ? 2 + this.rng.next() * 5 : 0.6 + this.rng.next() * 2.6;
    } else if (m.stuck > 1.2) {
      m.stuck = 0;
      this.pickWander(p, m); // couldn't get there: pick somewhere else
    }
  }

  /** a replacement on the road: follow the route, then walk cross-country to its spot */
  private march(p: Post, m: WorldSoldier, dt: number) {
    while (m.wp < p.route.length && Math.hypot(p.route[m.wp].x - m.x, p.route[m.wp].z - m.z) < 0.75) m.wp++;
    const reachedRoad = m.wp >= p.route.length;
    const tx = reachedRoad ? m.hx : p.route[m.wp].x, tz = reachedRoad ? m.hz : p.route[m.wp].z;
    if (reachedRoad && Math.hypot(tx - m.x, tz - m.z) < 0.6) {
      m.state = 'post'; // arrived: take up the fallen guard's spot
      m.idle = this.rng.next() * 2;
      return;
    }
    if (m.hot) return; // the live entity does the walking; the world sim only advances the route
    const moved = this.stepToward(m, tx, tz, MARCH, dt);
    m.stuck = moved < MARCH * dt * 0.4 ? m.stuck + dt : 0;
    // boxed in by trees or a cliff: sidestep a little and keep trying
    if (m.stuck > 1.5) {
      m.stuck = 0;
      const a = this.rng.next() * Math.PI * 2;
      this.stepToward(m, m.x + Math.cos(a) * 2, m.z + Math.sin(a) * 2, MARCH, dt * 4);
    }
  }

  /** put a replacement on the map's edge, walking in to take a fallen guard's spot */
  private recruit(p: Post, kind: EnemyKind) {
    // take the spot of a fallen guard, so the post keeps its shape
    const taken = new Set(WorldState.living(p).map((m) => m.hx * 1000 + m.hz));
    const home = p.homes.find((h) => !taken.has(h.x * 1000 + h.z)) ?? p.homes[0];
    const m = this.newSoldier(kind, home);
    m.state = 'enroute';
    m.x = p.entry!.x; m.z = p.entry!.z;
    m.tx = m.x; m.tz = m.z;
    p.members.push(m);
  }

  /**
   * The world simulation tick. Every soldier holds its patch (wandering its own ground) or walks
   * its reinforcement route in; posts recruit replacements for the men they've lost, one at a
   * time, from the map's edge. Materialised (hot) soldiers are moved by their live entities, so
   * the world sim leaves their positions alone — it still advances their route, though.
   */
  tick(dt: number) {
    for (const p of this.posts) {
      // 1. account for the fallen and queue a replacement for each (of the same kind)
      const downed: WorldSoldier[] = [];
      for (const m of p.members) if (m.state === 'down') downed.push(m);
      for (let i = p.fallen; i < downed.length; i++) p.queue.push(downed[i].kind);
      p.fallen = downed.length;
      // 2. recruit: one replacement at a time, only while the post is under strength
      if (p.queue.length && p.entry && p.members.length - downed.length < p.homes.length) {
        p.recruitT -= dt;
        if (p.recruitT <= 0) { this.recruit(p, p.queue.shift()!); p.recruitT = p.reinforce; }
      }
      // 3. advance the watch
      for (const m of p.members) {
        if (m.state === 'down') continue;
        if (m.state === 'enroute') this.march(p, m, dt);
        else if (!m.hot) this.wander(p, m, dt);
      }
    }
  }

  /**
   * Re-seed every post from the world's specs (a fresh watch on every spot, nobody fallen).
   * Called when a run starts over — a restart is a new world, not a respawn of the old one.
   */
  reset() {
    this.buildPosts(); // fresh posts come in cold (hot: false) and standing on their spots
  }

  /** Plain-data snapshot — the payload shape that will cross the worker boundary. */
  snapshot(): { chunks: ChunkInfo[]; posts: Post[]; camps: Vec2[]; village: ChunkBox } {
    return { chunks: this.chunks, posts: this.posts, camps: this.camps, village: this.village };
  }
}
