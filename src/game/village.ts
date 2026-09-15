import { MAP_W, MAP_H, Tile, RNG, facingFrom, type Facing } from './constants';
import type { World, Vec2 } from './world';

/**
 * Village state: the persistent, plain-data model of village life — the first piece of it being
 * the farm. Like WorldState (the guard posts), everything in here is structured-clone friendly
 * (no THREE, no DOM) and advances in a `tick`, so it can move to a worker later; the live
 * entities and meshes in the game are *views* of this data, never the authority.
 *
 * THE FARM. The fields south of the plaza are a grid of FARM TILES. Each plot grows a fixed crop
 * (turnips in some rows, cabbages in others) through a Stardew-style life cycle:
 *
 *   bare tilled soil  --sow-->  seeded -> sprout -> leafy -> RIPE  --harvest-->  bare soil ...
 *
 * A crop only grows while its soil is wet. Watered soil dries out slowly, so the farmer has to
 * keep coming round with the can; a crop on dry soil doesn't die, it just stalls.
 *
 * THE FARMER walks the rows doing whatever is most pressing and closest: pulling ripe crops,
 * sowing empty plots (a quick hoe stroke then a broadcast of seed) and watering the dry ones.
 * Jobs are scored by path distance plus a priority offset, which naturally makes him sweep along
 * a row rather than zig-zag across the field. He can walk over the beds themselves (between the
 * rows) but prefers the paths and the bare plots to trampling ripe crops. When there is nothing
 * to do he goes and leans on his hoe by the wheelbarrow.
 *
 * The sim owns his movement outright (he never fights, so there is no hot/cold split as with the
 * soldiers); the Farmer entity mirrors his position and plays the animation for his current task.
 * Moments that need a splash of particles or a sound are queued as VillageEvents for the game.
 */

export type CropKind = 'turnip' | 'cabbage';

export interface CropSpec {
  name: string;
  /** seconds of watered time from seed to ripe */
  grow: number;
}
export const CROPS: Record<CropKind, CropSpec> = {
  turnip: { name: 'turnip', grow: 360 },
  cabbage: { name: 'cabbage', grow: 480 },
};
export const CROP_KINDS: CropKind[] = ['turnip', 'cabbage'];

/** growth stages: 0 seeded, 1 sprout, 2 leafy, 3 ripe */
export const CROP_STAGES = 4;
const STAGE_AT = [0.2, 0.5, 1];

/** seconds for fully watered soil to dry out completely */
export const DRY_TIME = 480;
/** the farmer waters a growing plot once its moisture falls below this */
export const THIRSTY = 0.3;

export interface FarmTile {
  x: number;
  z: number;
  /** what this plot grows (fixed per plot: the rows are laid out by crop) */
  crop: CropKind;
  /** false = bare tilled soil waiting for seed */
  planted: boolean;
  /** 0..1 from seed to ripe (only meaningful while planted) */
  growth: number;
  /** soil moisture 0 (dry) .. 1 (just watered) */
  water: number;
}

/** growth stage of a plot: -1 bare soil, 0..CROP_STAGES-1 otherwise */
export function cropStage(t: FarmTile): number {
  if (!t.planted) return -1;
  for (let s = 0; s < STAGE_AT.length; s++) if (t.growth < STAGE_AT[s]) return s;
  return CROP_STAGES - 1;
}
export const isRipe = (t: FarmTile) => t.planted && t.growth >= 1;

export type FarmJob = 'sow' | 'water' | 'harvest';
export type FarmerTask = 'idle' | 'walk' | 'rest' | FarmJob;

/** the timing of each job: how long it takes, and when along it the visible moments happen */
export interface ActionSpec { dur: number; marks: { t: number; ev: VillageEvent['kind'] }[] }
export const ACTIONS: Record<FarmJob, ActionSpec> = {
  // a hoe stroke to open the soil, then two casts of seed
  sow: { dur: 1.9, marks: [{ t: 0.5, ev: 'hoe' }, { t: 1.1, ev: 'sow' }, { t: 1.5, ev: 'sow' }] },
  water: { dur: 1.6, marks: [{ t: 0.3, ev: 'water' }] },
  // bend, pull, and hold the prize up
  harvest: { dur: 1.4, marks: [{ t: 0.6, ev: 'harvest' }] },
};

export interface Farmer {
  /** position in world tiles (float) */
  x: number;
  z: number;
  facing: Facing;
  task: FarmerTask;
  /** the plot the current job is for: index into farm[] (-1 none) */
  job: number;
  jobKind: FarmJob | null;
  /** tile-centre waypoints to the standing spot, and the next one */
  path: Vec2[];
  wp: number;
  /** seconds into the current job's action */
  t: number;
  /** how many of the action's marks have fired */
  fired: number;
  /** seconds spent waiting for someone standing in the way */
  wait: number;
  /** seconds of rest left */
  idle: number;
  /** the spot he rests at when the field needs nothing */
  hx: number;
  hz: number;
  /** running tally of what he has pulled */
  harvested: Record<CropKind, number>;
}

export interface VillageEvent {
  kind: 'hoe' | 'sow' | 'water' | 'harvest';
  /** where the farmer stands */
  x: number;
  z: number;
  facing: Facing;
  /** the plot being worked (tile coords) */
  tx: number;
  tz: number;
  crop: CropKind;
}

/** walking pace, tiles per second */
const PACE = 1.25;
/** how close someone has to stand to the farmer's next step for him to wait */
const BLOCK_R = 0.6;
/** job priority in "extra tiles of walking": harvests come first, the can last */
const PRIORITY: Record<FarmJob, number> = { harvest: 0, sow: 2, water: 4 };

export class VillageState {
  farm: FarmTile[] = [];
  farmer!: Farmer;
  /** bumped whenever a plot's stage changes (the crop meshes re-sync on it) */
  rev = 0;
  /** visible moments since the last drain */
  events: VillageEvent[] = [];

  /** the walkable region: the village bounds (inclusive tile coords) */
  private x0: number; private z0: number; private rw: number; private rh: number;
  /** tile index -> farm[] index (+1; 0 = not a farm tile) */
  private farmAt = new Int32Array(MAP_W * MAP_H);
  private rng = new RNG(0xfa12);

  constructor(private world: World) {
    const v = world.village;
    this.x0 = v.x0; this.z0 = v.z0; this.rw = v.x1 - v.x0 + 1; this.rh = v.z1 - v.z0 + 1;
    this.build();
  }

  // ---------------------------------------------------------------- setup
  private build() {
    this.rng = new RNG(0xfa12);
    this.farm = [];
    this.farmAt.fill(0);
    const world = this.world;
    for (const p of world.farmPlots) {
      for (let z = p.z0; z <= p.z1; z++) for (let x = p.x0; x <= p.x1; x++) {
        if (world.tile(x, z) !== Tile.Bed) continue;
        if (world.tall[world.idx(x, z)]) continue; // the scarecrow's tile stays a scarecrow
        // rows by crop: two rows of turnips, two of cabbages, and so on down the field
        const crop: CropKind = Math.floor((z - p.z0) / 2) % 2 === 0 ? 'turnip' : 'cabbage';
        // a field mid-season: most plots planted at some stage, a few waiting for seed
        const r = this.rng.next();
        const planted = r > 0.15;
        const growth = !planted ? 0 : r > 0.82 ? 1 : this.rng.next() * 0.95;
        this.farm.push({ x, z, crop, planted, growth, water: 0.2 + this.rng.next() * 0.8 });
        this.farmAt[world.idx(x, z)] = this.farm.length;
      }
    }
    const home = world.npcs.find((n) => n.id === 'farmer');
    const hx = home?.x ?? 8.5, hz = home?.z ?? 22.5;
    this.farmer = {
      x: hx, z: hz, facing: 6, task: 'idle', job: -1, jobKind: null, path: [], wp: 0,
      t: 0, fired: 0, wait: 0, idle: 0, hx, hz, harvested: { turnip: 0, cabbage: 0 },
    };
    this.rev++;
  }

  /** a fresh field and a fresh farmer (a restart is a new world) */
  reset() { this.build(); this.events = []; }

  /** the plot at a tile, if it is one */
  plotAt(tx: number, tz: number): FarmTile | null {
    if (tx < 0 || tz < 0 || tx >= this.world.w || tz >= this.world.h) return null;
    const i = this.farmAt[this.world.idx(tx, tz)];
    return i ? this.farm[i - 1] : null;
  }

  // ---------------------------------------------------------------- pathfinding
  /** can the farmer step on this tile? He walks between the rows, so beds count; real obstacles don't */
  passable(tx: number, tz: number): boolean {
    if (tx < this.x0 || tz < this.z0 || tx >= this.x0 + this.rw || tz >= this.z0 + this.rh) return false;
    const i = this.world.idx(tx, tz);
    if (this.world.tall[i]) return false;
    const t = this.world.tiles[i];
    return t !== Tile.Water && t !== Tile.Cliff;
  }

  /** what a step onto a tile costs: paths are cheap, trampling a ripe crop is not */
  private stepCost(tx: number, tz: number): number {
    const p = this.plotAt(tx, tz);
    if (!p) return 1;
    if (!p.planted) return 1.2;
    return 1.5 + cropStage(p) * 0.6;
  }

  private rIdx(tx: number, tz: number) { return (tz - this.z0) * this.rw + (tx - this.x0); }

  /**
   * Dijkstra from a tile over the village: distance to every reachable tile plus the tree to walk
   * back along. One run per decision serves both choosing a job and routing to it.
   */
  private routes(sx: number, sz: number, avoid?: Vec2): { dist: Float64Array; prev: Int32Array } {
    const n = this.rw * this.rh;
    // (doubles: a Float32 store rounds the cost, and the exact double then re-relaxes it forever)
    const dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1);
    const ax = avoid ? Math.floor(avoid.x) : -1, az = avoid ? Math.floor(avoid.z) : -1;
    // binary heap of (cost, region index)
    const hc: number[] = [], hi: number[] = [];
    const push = (c: number, i: number) => {
      hc.push(c); hi.push(i);
      let k = hc.length - 1;
      while (k > 0) { const p = (k - 1) >> 1; if (hc[p] <= hc[k]) break; [hc[p], hc[k]] = [hc[k], hc[p]]; [hi[p], hi[k]] = [hi[k], hi[p]]; k = p; }
    };
    const pop = (): [number, number] => {
      const c = hc[0], i = hi[0];
      const lc = hc.pop()!, li = hi.pop()!;
      if (hc.length) {
        hc[0] = lc; hi[0] = li;
        let k = 0;
        for (;;) {
          const l = k * 2 + 1, r = l + 1;
          let m = k;
          if (l < hc.length && hc[l] < hc[m]) m = l;
          if (r < hc.length && hc[r] < hc[m]) m = r;
          if (m === k) break;
          [hc[m], hc[k]] = [hc[k], hc[m]]; [hi[m], hi[k]] = [hi[k], hi[m]]; k = m;
        }
      }
      return [c, i];
    };
    const s = this.rIdx(sx, sz);
    dist[s] = 0; push(0, s);
    while (hc.length) {
      const [c, i] = pop();
      if (c > dist[i]) continue;
      const tx = this.x0 + (i % this.rw), tz = this.z0 + Math.floor(i / this.rw);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = tx + dx, nz = tz + dz;
        if (!this.passable(nx, nz) || (nx === ax && nz === az)) continue;
        const j = this.rIdx(nx, nz);
        const nc = c + this.stepCost(nx, nz);
        if (nc < dist[j]) { dist[j] = nc; prev[j] = i; push(nc, j); }
      }
    }
    return { dist, prev };
  }

  private unwind(prev: Int32Array, tx: number, tz: number): Vec2[] {
    const out: Vec2[] = [];
    for (let i = this.rIdx(tx, tz); i >= 0; i = prev[i]) out.push({ x: this.x0 + (i % this.rw) + 0.5, z: this.z0 + Math.floor(i / this.rw) + 0.5 });
    return out.reverse();
  }

  /** the tile-centre path from the farmer to a tile (null when unreachable) */
  pathTo(tx: number, tz: number, avoid?: Vec2): Vec2[] | null {
    const f = this.farmer;
    const { dist, prev } = this.routes(Math.floor(f.x), Math.floor(f.z), avoid);
    if (!this.passable(tx, tz) || dist[this.rIdx(tx, tz)] === Infinity) return null;
    return this.unwind(prev, tx, tz);
  }

  // ---------------------------------------------------------------- jobs
  /** what a plot needs right now, if anything */
  static needOf(t: FarmTile): FarmJob | null {
    if (isRipe(t)) return 'harvest';
    if (!t.planted) return 'sow';
    if (t.water < THIRSTY) return 'water';
    return null;
  }

  /**
   * Pick the next job: the plot whose (walking distance + priority) is smallest, and the
   * neighbouring tile to work it from. Returns false when the field needs nothing.
   */
  private pickJob(avoid?: Vec2): boolean {
    const f = this.farmer;
    const { dist, prev } = this.routes(Math.floor(f.x), Math.floor(f.z), avoid);
    let best = -1, bestKind: FarmJob | null = null, bestScore = Infinity, bsx = 0, bsz = 0;
    for (let i = 0; i < this.farm.length; i++) {
      const t = this.farm[i];
      const kind = VillageState.needOf(t);
      if (!kind) continue;
      // the nearest side to stand on
      let sd = Infinity, sx = 0, sz = 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = t.x + dx, nz = t.z + dz;
        if (!this.passable(nx, nz)) continue;
        const d = dist[this.rIdx(nx, nz)];
        if (d < sd) { sd = d; sx = nx; sz = nz; }
      }
      if (sd === Infinity) continue;
      // a stalled crop (bone dry) is more urgent than one that is merely thirsty
      const urgency = kind === 'water' && t.water <= 0 ? -1.5 : 0;
      const score = sd + PRIORITY[kind] + urgency;
      if (score < bestScore) { bestScore = score; best = i; bestKind = kind; bsx = sx; bsz = sz; }
    }
    if (best < 0) return false;
    f.job = best; f.jobKind = bestKind;
    f.path = this.unwind(prev, bsx, bsz); f.wp = 0;
    f.task = 'walk'; f.wait = 0;
    return true;
  }

  /** face the plot being worked */
  private faceJob() {
    const f = this.farmer, t = this.farm[f.job];
    f.facing = facingFrom(t.x + 0.5 - f.x, t.z + 0.5 - f.z);
  }

  private emit(kind: VillageEvent['kind']) {
    const f = this.farmer, t = this.farm[f.job];
    this.events.push({ kind, x: f.x, z: f.z, facing: f.facing, tx: t.x, tz: t.z, crop: t.crop });
  }

  /** the plot changes that go with a job's visible moments / completion */
  private applyMark(kind: VillageEvent['kind']) {
    const t = this.farm[this.farmer.job];
    if (kind === 'harvest') {
      // the crop comes out of the ground the moment he pulls it (the mesh vanishes, the pop shows it)
      this.farmer.harvested[t.crop]++;
      t.planted = false; t.growth = 0;
      this.rev++;
    }
  }

  private finishJob() {
    const f = this.farmer, t = this.farm[f.job];
    if (f.jobKind === 'sow') { t.planted = true; t.growth = 0; this.rev++; }
    else if (f.jobKind === 'water') t.water = 1;
    f.task = 'idle'; f.job = -1; f.jobKind = null; f.t = 0; f.fired = 0;
  }

  // ---------------------------------------------------------------- movement
  /** one step along the path; returns true on arrival at the end of it */
  private walk(dt: number, avoid?: Vec2): boolean {
    const f = this.farmer;
    let left = PACE * dt;
    while (left > 0) {
      if (f.wp >= f.path.length) return true;
      const w = f.path[f.wp];
      const dx = w.x - f.x, dz = w.z - f.z;
      const d = Math.hypot(dx, dz);
      if (d < 1e-3) { f.wp++; continue; }
      const step = Math.min(d, left);
      const nx = f.x + (dx / d) * step, nz = f.z + (dz / d) * step;
      // someone in the way (the player, usually): stand and wait, then find a way round. Only a
      // step that closes in on them counts — if they are standing on top of him he may still leave.
      if (avoid && Math.hypot(avoid.x - nx, avoid.z - nz) < BLOCK_R && Math.hypot(avoid.x - nx, avoid.z - nz) < Math.hypot(avoid.x - f.x, avoid.z - f.z)) {
        f.wait += dt;
        if (f.wait > 1.5) {
          f.wait = 0;
          const end = f.path[f.path.length - 1];
          const p = this.pathTo(Math.floor(end.x), Math.floor(end.z), avoid);
          if (p) { f.path = p; f.wp = 0; }
        }
        return false;
      }
      f.x = nx; f.z = nz; left -= step;
      f.facing = facingFrom(dx, dz);
      if (step >= d - 1e-6) { f.x = w.x; f.z = w.z; f.wp++; }
    }
    return f.wp >= f.path.length;
  }

  // ---------------------------------------------------------------- tick
  /**
   * The village step. Soil dries, wet crops grow, and the farmer gets on with the next thing.
   * `avoid` is someone the farmer must not walk into (the player), if anyone is about.
   */
  tick(dt: number, avoid?: Vec2) {
    for (const t of this.farm) {
      const s0 = cropStage(t);
      if (t.planted && t.water > 0 && t.growth < 1) t.growth = Math.min(1, t.growth + dt / CROPS[t.crop].grow);
      if (t.water > 0) t.water = Math.max(0, t.water - dt / DRY_TIME);
      if (cropStage(t) !== s0) this.rev++;
    }
    const f = this.farmer;
    switch (f.task) {
      case 'idle': {
        if (this.pickJob(avoid)) break;
        // nothing to do: head for the wheelbarrow and lean on the hoe a while
        if (Math.hypot(f.hx - f.x, f.hz - f.z) > 0.6) {
          const p = this.pathTo(Math.floor(f.hx), Math.floor(f.hz), avoid);
          if (p) { f.path = p; f.wp = 0; f.job = -1; f.jobKind = null; f.task = 'walk'; break; }
        }
        f.task = 'rest'; f.idle = 3 + this.rng.next() * 4;
        break;
      }
      case 'rest': {
        f.idle -= dt;
        if (f.idle <= 0) f.task = 'idle';
        break;
      }
      case 'walk': {
        if (!this.walk(dt, avoid)) break;
        if (f.jobKind && f.job >= 0 && VillageState.needOf(this.farm[f.job]) === f.jobKind) {
          f.task = f.jobKind; f.t = 0; f.fired = 0;
          this.faceJob();
        } else if (f.jobKind) {
          f.task = 'idle'; f.job = -1; f.jobKind = null; // the plot no longer needs it
        } else {
          f.facing = 6; // home: face the field
          f.task = 'rest'; f.idle = 3 + this.rng.next() * 4;
        }
        break;
      }
      case 'sow': case 'water': case 'harvest': {
        const a = ACTIONS[f.task];
        f.t += dt;
        while (f.fired < a.marks.length && f.t >= a.marks[f.fired].t) {
          const m = a.marks[f.fired++];
          this.emit(m.ev);
          this.applyMark(m.ev);
        }
        if (f.t >= a.dur) this.finishJob();
        break;
      }
    }
  }

  /** take the queued visible moments (the game turns them into particles and sounds) */
  drain(): VillageEvent[] {
    if (!this.events.length) return this.events;
    const out = this.events;
    this.events = [];
    return out;
  }

  /** Plain-data snapshot — the payload shape that will cross the worker boundary. */
  snapshot(): { farm: FarmTile[]; farmer: Farmer } {
    return { farm: this.farm, farmer: this.farmer };
  }
}
