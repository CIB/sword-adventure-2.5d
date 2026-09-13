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
 * Soldiers live here as SQUADS, not spawn points. Each squad is a named patrol with a route built
 * once by pathfinding over the actual road tiles (paths, bridges and camp plazas — never through
 * the village, never through solid props). Squads march their route forever: road patrols walk
 * out to a camp and back, garrisons circuit their landmark, and every squad rests at its stops.
 * There is no respawning — when a member falls it stays down.
 *
 * The Game only *materialises* the members of squads near the player into live Enemy entities;
 * those entities follow their squad's formation slot unless they have spotted the player. While a
 * squad is materialised its members' positions mirror the live entities; otherwise the world sim
 * itself advances them along the route. Everything in here is plain data (no THREE, no DOM),
 * deliberately structured-clone friendly: the next step is to run the simulation tick in a Web
 * Worker at a low tick rate and ship snapshots/diffs across the thread boundary.
 */

/** tiles per world-state chunk side (MAP_W and MAP_H are multiples of this) */
export const CHUNK_T = 8;
export const CHUNKS_X = MAP_W / CHUNK_T; // 26
export const CHUNKS_Z = MAP_H / CHUNK_T; // 22

/** tiles that count as "road" for the chunk road graph and the squad patrol network */
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

export type SoldierState = 'march' | 'rest' | 'down';

export interface WorldSoldier {
  id: number;
  kind: EnemyKind;
  /** position in world tiles (float). While the squad is materialised this mirrors the live entity. */
  x: number;
  z: number;
  state: SoldierState;
}

/** a rest stop along a squad's route, at a distance into the route polyline */
export interface SquadStop { d: number; rest: number; x: number; z: number }

export type SquadState = 'march' | 'rest';

export interface Squad {
  id: number;
  name: string;
  members: WorldSoldier[];
  /** closed patrol loop through road tile centres (last point connects back to the first) */
  route: Vec2[];
  /** cumulative length at each route point; cum[0] = 0, cum[n-1] = total */
  cum: number[];
  total: number;
  /** rest stops along the route (distances into the loop) */
  stops: SquadStop[];
  /** distance travelled into the route loop */
  dist: number;
  /** march speed in tiles per second */
  speed: number;
  state: SquadState;
  restT: number;
  /** current formation slot per member (march column / rest ring), recomputed every tick */
  slots: Vec2[];
  /** current march heading (unit vector along the route) */
  heading: Vec2;
  /** the squad is materialised in the active region around the player (live entities exist) */
  hot: boolean;
}

/** chunk-coordinate bounding box (inclusive) */
export interface ChunkBox { cx0: number; cz0: number; cx1: number; cz1: number }

/** squad marching formation: [lateral, behind] offsets from the leader, in squad space */
const FORMATION: [number, number][] = [
  [0, 0], [0.85, 0.75], [-0.85, 0.75], [0, 1.6], [1.5, 1.6], [-1.5, 1.6],
];

export class WorldState {
  chunks: ChunkInfo[] = [];
  /** village bounds in chunk coordinates (drawn on the map, and a no-go area for the world sim) */
  village: ChunkBox;
  /** resolved stop points (tile coords) the squad routes are built from */
  stops: Record<string, Vec2> = {};
  /** the rest stops that are proper camps (landmarks with a rest >= 15s), for the map */
  camps: Vec2[] = [];
  squads: Squad[] = [];

  /** per-tile squad road network: 1 = road tile, walkable, outside the village */
  private net = new Uint8Array(MAP_W * MAP_H);

  constructor(private world: World) {
    this.village = {
      cx0: Math.floor(world.village.x0 / CHUNK_T), cz0: Math.floor(world.village.z0 / CHUNK_T),
      cx1: Math.floor(world.village.x1 / CHUNK_T), cz1: Math.floor(world.village.z1 / CHUNK_T),
    };
    this.analyzeChunks();
    this.buildNetwork();
    this.buildSquads();
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

  // ---------------------------------------------------------------- squad road network
  /**
   * The tile-level network squads patrol on: every road tile (path / bridge / cobble) that is
   * walkable (no tents, menhirs, crates... standing on it) and outside the village (expanded by a
   * tile, so patrols never squeeze past the fence).
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

  /** nearest network tile to a world position (spiral search, ~4 tile radius) */
  private snapToNet(x: number, z: number): Vec2 | null {
    const tx = Math.floor(x), tz = Math.floor(z);
    for (let r = 0; r <= 4; r++) {
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

  // ---------------------------------------------------------------- squads
  /**
   * Build every squad's route from the world's squad specs. Each leg is pathfound over the road
   * network and corner-compressed; road patrols (`loop: false`) get the return leg appended so
   * every route is a closed loop the squad walks forever. Throws on an unresolvable stop or an
   * unreachable leg — that's a world-generation bug, and the tests catch it.
   */
  private buildSquads() {
    this.stops = {};
    for (const [id, [x, z]] of Object.entries(this.world.squadStops)) {
      const p = this.snapToNet(x, z);
      if (!p) throw new Error(`squad stop '${id}' at ${x},${z} is not on the road network`);
      this.stops[id] = p;
    }
    // camps for the map: long-rest stops (the landmarks), de-duplicated by proximity
    const campStops: Vec2[] = [];
    for (const spec of this.world.squads) for (const s of spec.stops) {
      if (s.rest < 15) continue;
      const p = this.stops[s.at];
      if (!campStops.some((c) => Math.hypot(c.x - p.x, c.z - p.z) < 3)) campStops.push(p);
    }
    this.camps = campStops;

    const rng = new RNG(0x5eed);
    let soldierId = 0;
    this.squads = this.world.squads.map((spec, id) => {
      const tiles = spec.stops.map((s) => this.stops[s.at]);
      // forward legs between consecutive stops
      const legs: Vec2[][] = [];
      for (let i = 0; i < tiles.length - 1; i++) {
        const p = this.pathfind(tiles[i].x, tiles[i].z, tiles[i + 1].x, tiles[i + 1].z);
        if (!p) throw new Error(`squad '${spec.name}': no road path from ${spec.stops[i].at} to ${spec.stops[i + 1].at}`);
        legs.push(this.compress(p));
      }
      if (spec.loop) {
        const p = this.pathfind(tiles[tiles.length - 1].x, tiles[tiles.length - 1].z, tiles[0].x, tiles[0].z);
        if (!p) throw new Error(`squad '${spec.name}': no road path closing its loop`);
        legs.push(this.compress(p));
      } else {
        // out-and-back: walk the whole route in reverse to get home
        for (let i = legs.length - 1; i >= 0; i--) legs.push(legs[i].slice().reverse());
      }
      // stitch the legs into one closed loop, dropping the duplicated junction points
      const route: Vec2[] = [];
      const lengthSoFar = () => {
        let L = 0;
        for (let i = 1; i < route.length; i++) L += Math.hypot(route[i].x - route[i - 1].x, route[i].z - route[i - 1].z);
        return L;
      };
      const stopDist: number[] = [0];   // distance of each spec stop into the route
      for (let li = 0; li < legs.length; li++) {
        const leg = legs[li];
        if (li === 0) route.push(...leg);
        else {
          const last = route[route.length - 1];
          if (Math.hypot(leg[0].x - last.x, leg[0].z - last.z) > 1e-6) route.push(leg[0]);
          route.push(...leg.slice(1));
        }
        // spec stop li+1 sits where the next leg begins (the current end of the stitched route)
        if (li + 1 < tiles.length) stopDist[li + 1] = lengthSoFar();
      }
      // cumulative lengths over the closed loop
      const cumArr: number[] = [0];
      for (let i = 1; i < route.length; i++) cumArr.push(cumArr[i - 1] + Math.hypot(route[i].x - route[i - 1].x, route[i].z - route[i - 1].z));
      const total = cumArr[cumArr.length - 1];
      // rest stops: each spec stop on the way out, and (out-and-back) again on the way home
      const stops: SquadStop[] = [];
      const stopAt = (d: number, rest: number) => {
        const p = this.pointOnRoute(route, cumArr, total, d);
        stops.push({ d, rest, x: p.x, z: p.z });
      };
      for (let i = 0; i < spec.stops.length; i++) stopAt(stopDist[i] ?? 0, spec.stops[i].rest);
      if (!spec.loop) {
        for (let i = spec.stops.length - 2; i >= 1; i--) stopAt(total - (stopDist[i] ?? 0), spec.stops[i].rest);
      }
      stops.sort((a, b) => a.d - b.d);
      const sq: Squad = {
        id, name: spec.name,
        members: spec.kinds.map((kind) => ({ id: soldierId++, kind, x: 0, z: 0, state: 'march' as SoldierState })),
        route, cum: cumArr, total, stops,
        dist: 0, speed: 1.3 + rng.next() * 0.15,
        state: 'march', restT: 0,
        slots: spec.kinds.map(() => ({ x: 0, z: 0 })),
        heading: { x: 0, z: 1 },
        hot: false,
      };
      // spread the squads out along their routes so the world starts in motion
      sq.dist = total * rng.next();
      this.updateSlots(sq);
      for (let i = 0; i < sq.members.length; i++) { sq.members[i].x = sq.slots[i].x; sq.members[i].z = sq.slots[i].z; }
      return sq;
    });
  }

  /** position on a route polyline at distance d (wrapping around the closed loop) */
  private pointOnRoute(route: Vec2[], cum: number[], total: number, d: number): Vec2 {
    let dd = ((d % total) + total) % total;
    for (let i = 1; i < route.length; i++) {
      if (dd <= cum[i] || i === route.length - 1) {
        const t = cum[i] > cum[i - 1] ? (dd - cum[i - 1]) / (cum[i] - cum[i - 1]) : 0;
        return { x: route[i - 1].x + (route[i].x - route[i - 1].x) * t, z: route[i - 1].z + (route[i].z - route[i - 1].z) * t };
      }
    }
    return { ...route[0] };
  }

  /** did a march from `prev` to `cur` (possibly wrapping) cross distance `d`? */
  private crossed(prev: number, cur: number, d: number): boolean {
    if (prev === cur) return false;
    if (prev < cur) return d > prev && d <= cur;
    return d > prev || d <= cur; // wrapped past the loop start
  }

  /** recompute the squad's formation slots (march column or rest ring) from its route state */
  private updateSlots(sq: Squad) {
    const n = sq.members.length;
    if (sq.state === 'rest') {
      const stop = sq.stops.find((s) => Math.abs(s.d - sq.dist) < 1e-6) ?? { x: sq.slots[0].x, z: sq.slots[0].z };
      for (let i = 0; i < n; i++) {
        const a = (i + 0.35) * Math.PI * 2 / n;
        const r = 0.95 + (i % 2) * 0.4;
        sq.slots[i].x = stop.x + Math.cos(a) * r;
        sq.slots[i].z = stop.z + Math.sin(a) * r;
      }
    } else {
      const p = this.pointOnRoute(sq.route, sq.cum, sq.total, sq.dist);
      // heading from the segment ahead
      let h = { x: 0, z: 1 };
      let dd = ((sq.dist % sq.total) + sq.total) % sq.total;
      for (let i = 1; i < sq.route.length; i++) {
        if (dd <= sq.cum[i] || i === sq.route.length - 1) {
          const dx = sq.route[i].x - sq.route[i - 1].x, dz = sq.route[i].z - sq.route[i - 1].z;
          const l = Math.hypot(dx, dz) || 1;
          h = { x: dx / l, z: dz / l };
          break;
        }
      }
      sq.heading = h;
      for (let i = 0; i < n; i++) {
        const [lat, behind] = FORMATION[i % FORMATION.length];
        const k = Math.floor(i / FORMATION.length); // extra ranks trail further back
        const b = behind + k * 2.2;
        sq.slots[i].x = p.x - h.x * b + h.z * lat;
        sq.slots[i].z = p.z - h.z * b - h.x * lat;
      }
    }
  }

  /** living members of a squad */
  static living(sq: Squad): WorldSoldier[] { return sq.members.filter((m) => m.state !== 'down'); }

  /**
   * The world simulation tick: every squad marches its route or rests at a stop. While a squad is
   * materialised (hot) the live entities are the authority for its members' positions, so their
   * records are left alone; cold squads advance their members to the formation slots here.
   */
  tick(dt: number) {
    for (const sq of this.squads) {
      if (!WorldState.living(sq).length) continue;
      if (sq.state === 'rest') {
        sq.restT -= dt;
        if (sq.restT <= 0) sq.state = 'march';
      } else {
        const prev = sq.dist;
        sq.dist += sq.speed * dt;
        if (sq.dist >= sq.total) sq.dist -= sq.total;
        for (const s of sq.stops) {
          if (this.crossed(prev, sq.dist, s.d)) {
            sq.dist = s.d;
            sq.state = 'rest';
            sq.restT = s.rest;
            break;
          }
        }
      }
      this.updateSlots(sq);
      if (!sq.hot) {
        for (let i = 0; i < sq.members.length; i++) {
          const m = sq.members[i];
          if (m.state === 'down') continue;
          m.x = sq.slots[i].x;
          m.z = sq.slots[i].z;
          m.state = sq.state === 'rest' ? 'rest' : 'march';
        }
      } else {
        // materialised: live entities are the authority for positions (the Game mirrors them
        // back), but the squad state still tells the map whether the squad is resting
        for (const m of sq.members) if (m.state !== 'down') m.state = sq.state === 'rest' ? 'rest' : 'march';
      }
    }
  }

  /**
   * Re-seed every squad from the world's specs (fresh soldiers, spread along their routes).
   * Called when a run starts over — a restart is a new world, not a respawn of the old one.
   */
  reset() {
    this.buildSquads(); // fresh squads come in cold (hot: false) and spread along their routes
  }

  /** Plain-data snapshot — the payload shape that will cross the worker boundary. */
  snapshot(): { chunks: ChunkInfo[]; squads: Squad[]; camps: Vec2[]; village: ChunkBox } {
    return { chunks: this.chunks, squads: this.squads, camps: this.camps, village: this.village };
  }
}
