import { MAP_W, MAP_H, Tile } from './constants';
import type { World, EnemyKind, Vec2, Biome } from './world';

/**
 * World state: the persistent, low-resolution model of everything that exists outside the active
 * simulation region around the player.
 *
 * The full game world is far too big to simulate every soldier at entity resolution, so the world is
 * split into chunks of CHUNK_T x CHUNK_T tiles. Each chunk stores cheap aggregates of the terrain
 * (dominant ground, water/tree/walkable fractions, biome) plus a chunk-level *road graph* — which of
 * its 4 neighbours a road physically connects to. That graph is the network the background world
 * simulation will patrol soldiers along: a soldier "off screen" only needs a chunk position and an
 * edge to walk, not pathfinding over tiles.
 *
 * Soldiers are world-state records, not spawn points: the world seeds one record per hand-placed
 * spawn, and these records are intended to become the single source of truth (enemies will be
 * *materialised* from world state when their chunk enters the active region, instead of respawning
 * from static spawn tables).
 *
 * Everything in here is plain data (no THREE, no DOM), deliberately structured-clone friendly:
 * the next step is to run the simulation tick in a Web Worker at a low tick rate and ship
 * snapshots/diffs across the thread boundary.
 */

/** tiles per world-state chunk side (MAP_W and MAP_H are multiples of this) */
export const CHUNK_T = 8;
export const CHUNKS_X = MAP_W / CHUNK_T; // 26
export const CHUNKS_Z = MAP_H / CHUNK_T; // 22

/** tiles that count as "road" for the chunk road graph (soldier patrol network) */
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

export type SoldierState = 'patrol' | 'idle' | 'down';

export interface WorldSoldier {
  id: number;
  kind: EnemyKind;
  /** position in world tiles (float). While the soldier is inside the active region this mirrors the live entity. */
  x: number;
  z: number;
  state: SoldierState;
  /**
   * Home anchor (the original spawn point). Doubles as the key that links this record to an active
   * Enemy instance in the high-resolution simulation (enemies carry the same spawn Vec2).
   */
  home: Vec2;
}

/** chunk-coordinate bounding box (inclusive) */
export interface ChunkBox { cx0: number; cz0: number; cx1: number; cz1: number }

export class WorldState {
  chunks: ChunkInfo[] = [];
  soldiers: WorldSoldier[] = [];
  /** village bounds in chunk coordinates (drawn on the map, and later a no-go area for the world sim) */
  village: ChunkBox;

  constructor(world: World) {
    this.village = {
      cx0: Math.floor(world.village.x0 / CHUNK_T), cz0: Math.floor(world.village.z0 / CHUNK_T),
      cx1: Math.floor(world.village.x1 / CHUNK_T), cz1: Math.floor(world.village.z1 / CHUNK_T),
    };
    this.analyzeChunks(world);
    this.seedSoldiers(world);
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
  private analyzeChunks(world: World) {
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

  // ---------------------------------------------------------------- soldiers
  /**
   * Seed one persistent soldier record per hand-placed spawn. Once the background world simulation
   * lands, this seeding happens once per save — soldiers then live and move in world state, and the
   * spawn tables stop being the authority.
   */
  private seedSoldiers(world: World) {
    this.soldiers = world.spawns.map((s, i) => ({
      id: i, kind: s.kind, x: s.x, z: s.z, state: 'patrol' as SoldierState, home: { x: s.x, z: s.z },
    }));
  }

  /**
   * Mirror the live (high-resolution) enemies back into world state. Records without a live entity
   * are marked 'down' (dead / waiting to respawn). Matching is by home anchor — the spawn Vec2 an
   * Enemy carries. This is the active-region half of the sync; the background half (worker sim
   * moving off-screen soldiers along the road graph) comes next.
   */
  syncActive(active: { home: Vec2; x: number; z: number }[]) {
    const byHome = new Map<string, { x: number; z: number }>();
    for (const a of active) byHome.set(a.home.x + ',' + a.home.z, a);
    for (const s of this.soldiers) {
      const live = byHome.get(s.home.x + ',' + s.home.z);
      if (live) { s.x = live.x; s.z = live.z; s.state = 'patrol'; }
      else s.state = 'down';
    }
  }

  /** Plain-data snapshot — the payload shape that will cross the worker boundary. */
  snapshot(): { chunks: ChunkInfo[]; soldiers: WorldSoldier[]; village: ChunkBox } {
    return { chunks: this.chunks, soldiers: this.soldiers, village: this.village };
  }
}
