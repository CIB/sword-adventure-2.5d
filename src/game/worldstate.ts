import { MAP_W, MAP_H, Tile, RNG } from './constants';
import type { World, EnemyKind, Biome } from './world';

/**
 * World state: the persistent, low-resolution model of everything that exists outside the active
 * simulation region around the player.
 *
 * The full game world is far too big to simulate every soldier at entity resolution, so the world is
 * split into chunks of CHUNK_T x CHUNK_T tiles. Each chunk stores cheap aggregates of the terrain
 * (dominant ground, water/tree/walkable fractions, biome) plus a chunk-level *road graph* — which of
 * its 4 neighbours a road physically connects to — and a *road anchor*: the road tile nearest the
 * chunk centre, the waypoint squads march through.
 *
 * Soldiers are organised into SQUADS that live entirely in world state. A squad marches the road
 * graph chunk-to-chunk, rests at camps, and NEVER RESPAWNS: when the player kills a soldier its
 * record is marked dead for good, and a squad whose members are all dead is gone from the world.
 * The old per-region spawn tables and the 22-second respawn timer are g o n e — the world map's
 * red dots are the actual, only soldiers in the world.
 *
 * The map generation is chunk-aligned by design: roads keep their 3-tile corridor mid-chunk on long
 * straights (see the NOTE in world.ts), so a road chunk means "the road runs through me", never
 * "half a road hugs my border" — that is what keeps this graph free of parallel ghost routes.
 *
 * Everything in here is plain data (no THREE, no DOM), deliberately structured-clone friendly:
 * the tick in worldsim.ts is a pure function over this state so it can move into a Web Worker
 * at a low tick rate without changes.
 */

/** tiles per world-state chunk side (MAP_W and MAP_H are multiples of this) */
export const CHUNK_T = 8;
export const CHUNKS_X = MAP_W / CHUNK_T; // 26
export const CHUNKS_Z = MAP_H / CHUNK_T; // 22

/** tiles that count as "road" for the chunk road graph (squad patrol network) */
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
  /** road anchor: centre of the road tile nearest the chunk centre (chunk centre if no road) */
  ax: number;
  az: number;
  /** chunk overlaps the village bounds */
  village: boolean;
  /** chunk holds a camp (squad rest stop) */
  camp: boolean;
  /** dominant biome at the chunk centre */
  biome: Biome;
}

/** Camps: knightly rest stops on the road network. Squads arriving here may halt for a while. */
export interface CampSpec { x: number; z: number; name: string }
export const CAMPS: CampSpec[] = [
  { x: 156.5, z: 108.5, name: 'KNIGHTS CAMP' },   // tents + campfire on the Grey Moor
  { x: 190.5, z: 5.5, name: 'WATCHTOWER' },       // ruined tower on the Amber Highland
  { x: 178.5, z: 142.5, name: 'SHRINE' },         // the Drowned Field shrine
  { x: 198.5, z: 92.5, name: 'CROWN HOLLOW' },    // the pillared hollow at the east edge
];

export type SquadState = 'march' | 'rest';

export interface SquadMember {
  id: number;
  kind: EnemyKind;
  alive: boolean;
  /** formation offset from the squad position (tiles) */
  ox: number;
  oz: number;
  /** world position in tiles. Mirrors the live entity while the squad is materialised. */
  x: number;
  z: number;
}

export interface Squad {
  id: number;
  members: SquadMember[];
  /** squad position in world tiles (the column leader) */
  x: number;
  z: number;
  state: SquadState;
  /** seconds of rest left (state 'rest') */
  restT: number;
  /** chunk index the squad last arrived at */
  cur: number;
  /** chunk index it is marching toward (== cur while resting) */
  target: number;
  /** chunk index it came from (avoids immediate backtracking at junctions) */
  prev: number;
  /**
   * true while the squad is materialised as live Enemy entities in the active region.
   * The world sim does not move active squads — the entity sim owns them; their members'
   * x/z are mirrored back every frame instead.
   */
  active: boolean;
}

/** marching formation offsets (tiles), up to 5 members */
export const FORMATION: readonly [number, number][] = [[0, 0], [1.0, 0.6], [-1.0, 0.6], [0.6, -1.0], [-0.6, -1.0]];

/** chunk-coordinate bounding box (inclusive) */
export interface ChunkBox { cx0: number; cz0: number; cx1: number; cz1: number }

export class WorldState {
  chunks: ChunkInfo[] = [];
  squads: Squad[] = [];
  /** village bounds in chunk coordinates (drawn on the map; squads route around these chunks) */
  village: ChunkBox;

  constructor(world: World) {
    this.village = {
      cx0: Math.floor(world.village.x0 / CHUNK_T), cz0: Math.floor(world.village.z0 / CHUNK_T),
      cx1: Math.floor(world.village.x1 / CHUNK_T), cz1: Math.floor(world.village.z1 / CHUNK_T),
    };
    this.analyzeChunks(world);
    this.seedSquads();
  }

  idx(cx: number, cz: number) { return cz * CHUNKS_X + cx; }
  chunk(cx: number, cz: number): ChunkInfo { return this.chunks[this.idx(cx, cz)]; }
  /** the chunk containing a world-tile position */
  chunkAt(x: number, z: number): ChunkInfo | null {
    const cx = Math.floor(x / CHUNK_T), cz = Math.floor(z / CHUNK_T);
    if (cx < 0 || cz < 0 || cx >= CHUNKS_X || cz >= CHUNKS_Z) return null;
    return this.chunks[this.idx(cx, cz)];
  }

  /** all living soldiers (for the map and the HUD) */
  soldiersAlive(): number {
    let n = 0;
    for (const sq of this.squads) for (const m of sq.members) if (m.alive) n++;
    return n;
  }

  // ---------------------------------------------------------------- chunk analysis
  private analyzeChunks(world: World) {
    const isRoad = (x: number, z: number) =>
      x >= 0 && z >= 0 && x < MAP_W && z < MAP_H && ROAD_TILES.has(world.tile(x, z));

    for (let cz = 0; cz < CHUNKS_Z; cz++) for (let cx = 0; cx < CHUNKS_X; cx++) {
      const x0 = cx * CHUNK_T, z0 = cz * CHUNK_T;
      const counts = new Map<Tile, number>();
      let water = 0, trees = 0, walkable = 0, road = false;
      // road anchor: road tile nearest the chunk centre
      const mx = x0 + CHUNK_T / 2 - 0.5, mz = z0 + CHUNK_T / 2 - 0.5;
      let ax = x0 + CHUNK_T / 2, az = z0 + CHUNK_T / 2, ad = Infinity;
      for (let dz = 0; dz < CHUNK_T; dz++) for (let dx = 0; dx < CHUNK_T; dx++) {
        const x = x0 + dx, z = z0 + dz;
        const t = world.tile(x, z);
        counts.set(t, (counts.get(t) ?? 0) + 1);
        if (t === Tile.Water) water++;
        if (world.treeCell[world.idx(x, z)]) trees++;
        if (!world.isSolidTile(x, z)) walkable++;
        if (ROAD_TILES.has(t)) {
          road = true;
          const d = Math.hypot(x - mx, z - mz);
          if (d < ad) { ad = d; ax = x + 0.5; az = z + 0.5; }
        }
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
      const camp = CAMPS.some((c) => Math.floor(c.x / CHUNK_T) === cx && Math.floor(c.z / CHUNK_T) === cz);
      this.chunks.push({
        cx, cz, ground, water: water / n, trees: trees / n, walkable: walkable / n,
        road, roadN: false, roadE: false, roadS: false, roadW: false, ax, az, village, camp, biome,
      });
    }

    // road graph edges: a road tile on this chunk's border row must meet a road tile on the
    // neighbour's adjacent row (±1 tile of slack so diagonal-ish road crossings still connect)
    const meets = (ax2: (i: number) => number, az2: (i: number) => number, bx: (i: number) => number, bz: (i: number) => number) => {
      for (let i = 0; i < CHUNK_T; i++) {
        if (!isRoad(ax2(i), az2(i))) continue;
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

  /** road-graph neighbours of a chunk (never routes into village chunks) */
  neighbours(c: ChunkInfo): ChunkInfo[] {
    const out: ChunkInfo[] = [];
    if (c.roadN) { const n = this.chunk(c.cx, c.cz - 1); if (!n.village) out.push(n); }
    if (c.roadS) { const n = this.chunk(c.cx, c.cz + 1); if (!n.village) out.push(n); }
    if (c.roadW) { const n = this.chunk(c.cx - 1, c.cz); if (!n.village) out.push(n); }
    if (c.roadE) { const n = this.chunk(c.cx + 1, c.cz); if (!n.village) out.push(n); }
    return out;
  }

  /** nearest road chunk (non-village) to a world-tile position — used to put a squad back on the network */
  nearestRoadChunk(x: number, z: number): ChunkInfo {
    let best: ChunkInfo | null = null, bd = Infinity;
    for (const c of this.chunks) {
      if (!c.road || c.village) continue;
      const d = Math.hypot(c.ax - x, c.az - z);
      if (d < bd) { bd = d; best = c; }
    }
    return best!;
  }

  // ---------------------------------------------------------------- squads
  /**
   * Seed the world's soldiers: patrol squads spread over the road network plus one garrison squad
   * resting at each camp. Deterministic (fixed seed). Squads further from Thistledown get more of
   * the nastier kinds — the difficulty gradient the old spawn tables encoded now lives here.
   */
  private seedSquads() {
    const rng = new RNG(20240613);
    let soldierId = 0, squadId = 0;

    // candidate nodes: connected road chunks outside the village, not too close to it
    const vcx = (this.village.cx0 + this.village.cx1) / 2, vcz = (this.village.cz0 + this.village.cz1) / 2;
    const nodes = this.chunks.filter((c) =>
      c.road && !c.village && this.neighbours(c).length > 0 && Math.hypot(c.cx - vcx, c.cz - vcz) >= 4);

    const pickKind = (dist01: number): EnemyKind => {
      // dist01: 0 near the village .. 1 far corner. Ranged kinds get common far out.
      const r = rng.next();
      if (r < 0.42 - dist01 * 0.14) return 'sword';
      if (r < 0.68 - dist01 * 0.10) return 'spear';
      if (r < 0.85) return 'javelin';
      return 'archer';
    };
    const maxD = Math.hypot(CHUNKS_X, CHUNKS_Z);
    const makeSquad = (at: ChunkInfo, resting: boolean) => {
      const dist01 = Math.min(1, Math.hypot(at.cx - vcx, at.cz - vcz) / maxD * 1.6);
      const size = 3 + (rng.next() < 0.5 ? 1 : 0) + (rng.next() < 0.25 ? 1 : 0); // 3..5
      const members: SquadMember[] = [];
      for (let i = 0; i < size; i++) {
        const [ox, oz] = FORMATION[i];
        // the first member is always a melee anchor so every squad can hold a line
        const kind = i === 0 ? (rng.next() < 0.5 ? 'sword' : 'spear') : pickKind(dist01);
        members.push({ id: soldierId++, kind, alive: true, ox, oz, x: at.ax + ox, z: at.az + oz });
      }
      const ci = this.idx(at.cx, at.cz);
      this.squads.push({
        id: squadId++, members, x: at.ax, z: at.az,
        state: resting ? 'rest' : 'march', restT: resting ? 10 + rng.next() * 25 : 0,
        cur: ci, target: ci, prev: -1, active: false,
      });
    };

    // one garrison squad per camp (they start resting, then join the patrol rotation)
    for (const camp of CAMPS) {
      const c = this.chunkAt(camp.x, camp.z);
      if (c && c.road) makeSquad(c, true);
    }
    // patrol squads spread across the network with a minimum spacing
    const taken: ChunkInfo[] = this.squads.map((s) => this.chunks[s.cur]);
    const WANT = 12, MIN_SPACING = 3;
    for (let tries = 0; tries < 400 && this.squads.length < WANT + CAMPS.length; tries++) {
      const c = nodes[Math.floor(rng.next() * nodes.length)];
      if (taken.some((t) => Math.hypot(t.cx - c.cx, t.cz - c.cz) < MIN_SPACING)) continue;
      makeSquad(c, false);
      taken.push(c);
    }
  }

  /** Plain-data snapshot — the payload shape that will cross the worker boundary. */
  snapshot(): { chunks: ChunkInfo[]; squads: Squad[]; village: ChunkBox } {
    return { chunks: this.chunks, squads: this.squads, village: this.village };
  }
}
