import { MAP_W, RNG, Tile, facingFrom, type Facing } from './constants';
import type { Vec2, World } from './world';

/**
 * Village simulation: the living half of Thistledown.
 *
 * The world system (see worldstate.ts) covers everything OUTSIDE the village fence — guard posts
 * and the soldiers holding them. This module is its counterpart INSIDE the fence: the crops in the
 * south field and the farmhand who works them, Stardew-style.
 *
 * What lives here, all of it plain data (no THREE, no DOM — structured-clone friendly, like
 * WorldState, so the simulation can eventually run in a worker or be driven headless in Node):
 *
 *  - the FARM: every tilled bed in the world is flood-filled into plots (a plot being a contiguous
 *    bed of soil — a field, a vegetable patch, a flower bed). Only beds inside the village bounds
 *    and big enough to be worth a day's work become crop land; the rest stay the decorative beds
 *    the terrain generator drew. A plot wider than SPLIT_MIN_W is worked as two strips, so one
 *    field carries two crops, the way a real smallholding does.
 *
 *  - the CROP TILES: fallow -> tilled -> sown (growing in GROWTH_STAGES visual steps, but only
 *    while the soil is damp) -> ripe -> harvested straight back to tilled soil. Moisture is what
 *    drives everything: a watering lasts MOISTURE_SECONDS and growth stops the moment the soil
 *    dries out, so the farmhand's day is a loop of watering, sowing and harvesting.
 *
 *  - the GROUND HE CAN WALK: the walkable tiles are flood-filled into connected components once,
 *    and a bed counts as workable only if the farmhand can actually get to a spot beside it (a bed
 *    ringed by other beds, or by hay bales, is left to the birds). Between two jobs he follows a
 *    BFS route over those tiles rather than pressing himself against the edge of a field.
 *
 *  - the FARMHAND (one per farmhand id, standing in for a villager NPC — 'farmer' by default):
 *    picks the most urgent job on his ground (harvest > water > sow > break new ground), walks to
 *    a spot beside the bed (he reaches over the row rather than trampling the crop), plays the
 *    job's animation and applies it on the animation's contact frame. When his basket fills he
 *    carries the crop to the wheelbarrow and tips it in; when the light goes he finishes his row,
 *    empties the basket and walks home until morning. Working one bed at a time is the point: the
 *    field fills in along a frontier, goes dark with water, and ripens in rows.
 *
 * The Game owns one VillageState, ticks it every frame and mirrors the farmhand into his NPC
 * entity — the same sim/model split the guard posts use, and the reason a crop keeps growing while
 * the player is off fighting knights on the far side of the map. FarmView draws it (soil quads and
 * one instanced crop mesh per crop and stage), and reset() puts the whole thing back to day one so
 * a restart is a fresh morning.
 */

// ---------------------------------------------------------------- tuning
/** seconds in one village day (the clock the crops and the farmhand live on) */
export const DAY_SECONDS = 180;
/** the farmhand knocks off this far into the day (fraction), then does his evening round */
export const WORK_UNTIL = 0.9;
/** how long one watering keeps the soil damp, in seconds */
export const MOISTURE_SECONDS = 110;
/** damp seconds a crop spends in each growth stage */
export const STAGE_SECONDS = 45;
/** growth stages a crop passes through before it is ripe (visual stage 3 = ripe) */
export const GROWTH_STAGES = 3;
/** crop beds one farmhand keeps under cultivation at a time */
export const FARM_CAPACITY = 12;
/** how many crops fit in the basket before it goes to the barrow */
export const BASKET_SIZE = 3;
/** beds smaller than this are decorative (flower beds, window boxes), never crop land */
const MIN_PLOT = 6;
/** a plot at least this many tiles wide is worked as two strips, one crop each */
const SPLIT_MIN_W = 6;
/** a plot must be this big before it is worth giving a farmhand */
const MIN_WORKABLE = 12;
/** walking speeds in tiles/second: on the way out, and carrying a full basket back */
const WALK_SPEED = 1.35;
const LOADED_SPEED = 1.1;
/** how close counts as standing on the spot */
const REACH = 0.4;

/** a job's animation: how long it runs, and when the tool lands (as a fraction of that) */
const TASK: Record<FarmTask, { dur: number; hit: number }> = {
  till: { dur: 1.5, hit: 0.55 },   // hoe up, hoe down
  sow: { dur: 1.35, hit: 0.45 },   // a sweep of the hand, seeds out
  water: { dur: 1.7, hit: 0.6 },   // can up, water down
  harvest: { dur: 1.4, hit: 0.5 }, // stoop, pull, straighten
  stow: { dur: 1.1, hit: 0.5 },    // tip the basket over the barrow
};

const CROP_ROTATION: CropKind[] = ['turnip', 'cabbage', 'pumpkin', 'wheat'];

// ---------------------------------------------------------------- crops
export type CropKind = 'turnip' | 'cabbage' | 'pumpkin' | 'wheat';

export interface CropDef {
  /** what the farmhand is growing, plural, for dialogue and the map screen */
  label: string;
  /** the ripe crop's colour (map markers, harvest effects) */
  colour: string;
}

export const CROPS: Record<CropKind, CropDef> = {
  turnip: { label: 'turnips', colour: '#efe9f6' },
  cabbage: { label: 'cabbages', colour: '#9fdc72' },
  pumpkin: { label: 'pumpkins', colour: '#ef8a28' },
  wheat: { label: 'wheat', colour: '#e6c65a' },
};

/** fallow -> tilled -> sown -> ripe -> (harvested) back to tilled soil */
export type CropTileState = 'fallow' | 'tilled' | 'sown' | 'ripe';
export type FarmTask = 'till' | 'sow' | 'water' | 'harvest' | 'stow';

export interface FarmTile {
  /** tile index (z * MAP_W + x) */
  i: number;
  x: number;
  z: number;
  /** plot this bed belongs to */
  plot: number;
  state: CropTileState;
  crop: CropKind;
  /** growth in stages: 0..GROWTH_STAGES while sown */
  growth: number;
  /** what the renderer draws: 0 sprout, 1 young, 2 grown, 3 ripe */
  visual: 0 | 1 | 2 | 3;
  /** seconds of soil moisture left (0 = dry: growth stops) */
  wetT: number;
  /**
   * Can a farmhand work this bed? Tilled beds are solid ground (you do not walk on a seedbed),
   * so a bed is only workable when it has a walkable neighbour to stand on and reach over from.
   * The interior of a wide field is therefore left to the birds — the rows that get worked are
   * the ones along the lane and the grass verges, which is exactly how a smallholding fills in.
   */
  reach: boolean;
}

export interface FarmPlot {
  id: number;
  /** the field this plot belongs to (a wide field is split into strips, one crop each) */
  region: number;
  name: string;
  crop: CropKind;
  /** inclusive tile bounds */
  x0: number; z0: number; x1: number; z1: number;
  /** tile indices of the plot's beds */
  cells: number[];
  /** inside the village: beds the village simulation tends */
  worked: boolean;
}

// ---------------------------------------------------------------- the farmhand
/** 'idle' stands about, 'walk' is on his way somewhere, 'work' plays a job animation */
export type WorkerState = 'idle' | 'walk' | 'work' | 'rest';

export interface FarmWorker {
  /** the villager NPC this farmhand stands in for */
  id: string;
  /** his doorstep: where he rests when the day's work is done */
  home: Vec2;
  x: number;
  z: number;
  facing: Facing;
  state: WorkerState;
  /** the job being walked to / worked (-1 tile means the barrow, or nothing at all) */
  task: FarmTask | null;
  /** the crop bed the current job is about (-1 when there is none) */
  tile: number;
  /** the point the tool works: the bed's centre, or the barrow when stowing */
  gx: number;
  gz: number;
  /** walk target */
  tx: number;
  tz: number;
  /** the route to the walk target, as tile-centre waypoints (empty when he can head straight there) */
  path: Vec2[];
  /** the waypoint he is walking to */
  pathI: number;
  workT: number;
  workDur: number;
  /** the job's effect has been applied at its contact frame */
  applied: boolean;
  /** crops in the basket */
  basket: number;
  idleT: number;
  /** seconds of failing to make progress toward the current target */
  stuck: number;
  stuckTries: number;
  /** a bed he could not reach: skipped for a while, so he does not grind against a fence */
  blockedTile: number;
  blockedT: number;
  /** the bed he worked last (the follow-up job on it is preferred: till -> sow -> water) */
  lastTile: number;
  /** plots this farmhand tends */
  plots: number[];
}

/** things the simulation wants drawn/sounded this frame (drained by the view) */
export type VillageEventKind = 'dirt' | 'seeds' | 'water' | 'harvest' | 'stow' | 'sprout' | 'ripe';
export interface VillageEvent {
  kind: VillageEventKind;
  x: number;
  z: number;
  crop?: CropKind;
  /** the farmhand it came from, so the view can draw it leaving his hand */
  who?: string;
}

export interface VillageStats {
  day: number;
  phase: string;
  /** beds under the hoe right now, and the most a farmhand will keep that way */
  cultivated: number;
  capacity: number;
  ripe: number;
  damp: number;
  harvested: number;
  harvestedToday: number;
  basket: number;
  workers: number;
}

/** the four cardinal neighbours (bed flood fill, frontier search) */
const N4: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
/** where a farmhand stands to reach a bed: cardinals first, then diagonals */
const STAND_OFFSETS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

export class VillageState {
  /** the village calendar, 1-based */
  day = 1;
  /** fraction of the day elapsed: 0 dawn, WORK_UNTIL knock-off, 1 midnight */
  dayT = 0.04;
  tiles = new Map<number, FarmTile>();
  plots: FarmPlot[] = [];
  workers: FarmWorker[] = [];
  /** crops delivered to the barrow, all-time and today */
  harvested = 0;
  harvestedToday = 0;
  /** all-time job counters (telemetry, and what the tests read) */
  totals = { tilled: 0, sown: 0, watered: 0 };
  /** simulation events for the view; capped, drained once a frame */
  events: VillageEvent[] = [];
  /** connected components of the walkable ground, and the one the village lives on */
  private comp: Int32Array | null = null;
  private main = -1;
  /** bumped when a bed's look changes, so the view knows to rebuild its instances */
  rev = 0;
  /** the barrow the harvest goes in (the world's wheelbarrow prop) */
  readonly barrow: Vec2;
  /** where the farmhand stands to tip the basket into the barrow */
  private readonly stowSpot: Vec2;
  private rng: RNG;
  /** the seed the run started from, so a restart replays it */
  private readonly seed: number;

  constructor(private world: World, opts: { hands?: string[]; seed?: number } = {}) {
    this.seed = opts.seed ?? 0x5a11;
    this.rng = new RNG(this.seed);
    this.buildNav();
    this.analyzeBeds();
    const barrow = world.props.find((p) => p.kind === 'wheelbarrow' && this.inVillage(p.x, p.z));
    this.barrow = barrow ? { x: barrow.x, z: barrow.z } : this.fallbackBarrow();
    this.stowSpot = world.nearestFree(this.barrow.x - 1.2, this.barrow.z);
    for (const id of opts.hands ?? ['farmer']) this.addHand(id);
  }

  // ---------------------------------------------------------------- plots
  /**
   * Flood-fill every tilled bed in the world into plots. Pillows of soil (flower beds by the
   * plaza, window boxes) are left as decoration; the big beds inside the village become crop land,
   * and a wide one is split into two strips so the field carries two crops.
   */
  private analyzeBeds() {
    const world = this.world;
    const seen = new Uint8Array(MAP_W * world.h);
    const isBed = (x: number, z: number) =>
      x >= 0 && z >= 0 && x < MAP_W && z < world.h && world.tile(x, z) === Tile.Bed;

    for (let z = 0; z < world.h; z++) for (let x = 0; x < MAP_W; x++) {
      const i = z * MAP_W + x;
      if (seen[i] || !isBed(x, z)) continue;
      // explicit stack: a field of beds is a few dozen tiles, but the map has several fields
      const cells: number[] = [];
      const stack: number[] = [i];
      seen[i] = 1;
      let x0 = x, x1 = x, z0 = z, z1 = z;
      while (stack.length) {
        const c = stack.pop()!;
        cells.push(c);
        const cx = c % MAP_W, cz = (c - cx) / MAP_W;
        if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
        if (cz < z0) z0 = cz; if (cz > z1) z1 = cz;
        for (const [dx, dz] of N4) {
          const nx = cx + dx, nz = cz + dz;
          if (!isBed(nx, nz)) continue;
          const ni = nz * MAP_W + nx;
          if (seen[ni]) continue;
          seen[ni] = 1;
          stack.push(ni);
        }
      }
      if (cells.length < MIN_PLOT) continue;
      const v = world.village;
      const inVillage = x0 >= v.x0 && x1 <= v.x1 && z0 >= v.z0 && z1 <= v.z1;
      const region = this.plots.length; // one field; its strips become separate plots
      if (x1 - x0 + 1 >= SPLIT_MIN_W) {
        const mid = Math.floor((x0 + x1) / 2);
        const strips: [number[], string][] = [
          [cells.filter((c) => c % MAP_W <= mid), 'West'],
          [cells.filter((c) => c % MAP_W > mid), 'East'],
        ];
        for (const [strip, side] of strips) if (strip.length >= MIN_PLOT / 2) this.addPlot(strip, region, inVillage, side);
      } else {
        this.addPlot(cells, region, inVillage, '');
      }
    }
  }

  /** register a bed of soil as a plot, giving it a crop from the village rotation */
  private addPlot(cells: number[], region: number, inVillage: boolean, side: string) {
    const world = this.world;
    let x0 = MAP_W, x1 = 0, z0 = world.h, z1 = 0;
    for (const c of cells) {
      const x = c % MAP_W, z = (c - x) / MAP_W;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    const id = this.plots.length;
    const crop = CROP_ROTATION[id % CROP_ROTATION.length];
    this.plots.push({
      id, region, crop,
      name: (side ? side + ' ' : '') + (inVillage ? 'field' : 'beds'),
      x0, z0, x1, z1, cells, worked: false,
    });
    for (const c of cells) {
      const x = c % MAP_W, z = (c - x) / MAP_W;
      const reach = STAND_OFFSETS.some(([dx, dz]) => this.inMain(x + dx, z + dz));
      this.tiles.set(c, { i: c, x, z, plot: id, state: 'fallow', crop, growth: 0, visual: 0, wetT: 0, reach });
    }
    if (inVillage && cells.length >= MIN_WORKABLE) this.plots[id].worked = true;
  }

  /** is a world position inside the village? (village props are the ones that matter here) */
  private inVillage(x: number, z: number): boolean {
    const v = this.world.village;
    return x >= v.x0 && x <= v.x1 && z >= v.z0 && z <= v.z1;
  }

  /**
   * The middle of the farm's landmarks — the scarecrow, the hay, the barrow, the cart the terrain
   * generator set out around the south fields. The field a farmhand is given is the one nearest
   * that yard, so "the farm" is the ground the village itself furnishes for farming.
   */
  private yardAnchor(): Vec2 {
    const yard = this.world.props.filter((p) =>
      (p.kind === 'scarecrow' || p.kind === 'hay' || p.kind === 'wheelbarrow' || p.kind === 'cart') && this.inVillage(p.x, p.z));
    if (!yard.length) return this.barrow;
    return {
      x: yard.reduce((n, p) => n + p.x, 0) / yard.length,
      z: yard.reduce((n, p) => n + p.z, 0) / yard.length,
    };
  }

  /** a stand-in barrow for maps with no wheelbarrow prop (headless tests, future worlds) */
  private fallbackBarrow(): Vec2 {
    const p = this.plots.find((pl) => pl.worked) ?? this.plots[0];
    return p ? { x: p.x1 + 1.5, z: (p.z0 + p.z1) / 2 } : { x: 0, z: 0 };
  }

  // ---------------------------------------------------------------- farmhands
  /**
   * Hire the villager with this id as a farmhand. He gets the field nearest the farm yard (see
   * yardAnchor), and his strips are put into the village rotation in order, so the first thing he
   * sows is the turnip the whole village talks about.
   */
  private addHand(id: string) {
    const npc = this.world.npcs.find((n) => n.id === id);
    const home = npc ? this.world.nearestFree(npc.x, npc.z) : this.stowSpot;
    const regions = new Map<number, FarmPlot[]>();
    for (const p of this.plots) {
      if (!p.worked) continue;
      const list = regions.get(p.region) ?? [];
      list.push(p);
      regions.set(p.region, list);
    }
    const yard = this.yardAnchor();
    let best: FarmPlot[] = [], bestScore = Infinity;
    for (const list of regions.values()) {
      const size = list.reduce((n, p) => n + p.cells.length, 0);
      if (size < MIN_WORKABLE) continue;
      const cx = list.reduce((n, p) => n + (p.x0 + p.x1) / 2, 0) / list.length;
      const cz = list.reduce((n, p) => n + (p.z0 + p.z1) / 2, 0) / list.length;
      const score = Math.hypot(cx - yard.x, cz - yard.z) - size * 0.05;
      if (score < bestScore) { bestScore = score; best = list; }
    }
    for (let i = 0; i < best.length; i++) this.setPlotCrop(best[i], CROP_ROTATION[i % CROP_ROTATION.length]);
    const w: FarmWorker = {
      id, home, x: home.x, z: home.z, facing: facingFrom(0, 1),
      state: 'idle', task: null, tile: -1,
      gx: home.x, gz: home.z, tx: home.x, tz: home.z, path: [], pathI: 0,
      workT: 0, workDur: 0, applied: false, basket: 0,
      idleT: 0, stuck: 0, stuckTries: 0, blockedTile: -1, blockedT: 0, lastTile: -1,
      plots: best.map((p) => p.id),
    };
    this.seatHand(w);
    this.workers.push(w);
  }

  /** put a farmhand on his doorstep with a cold tool and an empty basket */
  private seatHand(w: FarmWorker) {
    w.x = w.home.x; w.z = w.home.z;
    w.state = 'idle';
    w.task = null;
    w.tile = -1;
    w.gx = w.home.x; w.gz = w.home.z;
    w.tx = w.home.x; w.tz = w.home.z;
    w.path = []; w.pathI = 0;
    w.workT = 0; w.workDur = 0; w.applied = false; w.basket = 0;
    w.idleT = this.rng.range(0.4, 1.6);
    w.stuck = 0; w.stuckTries = 0;
    w.blockedTile = -1; w.blockedT = 0;
    w.lastTile = -1;
    w.facing = facingFrom(0, 1);
  }

  /**
   * A fresh run on the same ground: the beds go back to bare soil, the calendar to its first
   * morning and the farmhands to their doors, with a fresh RNG so a restart replays the same day
   * as the run before it. The terrain never changes, so the plots and the paths are kept and only
   * what the village did to them is undone.
   */
  reset() {
    this.day = 1;
    this.dayT = 0.04;
    this.harvested = 0;
    this.harvestedToday = 0;
    this.totals = { tilled: 0, sown: 0, watered: 0 };
    this.events.length = 0;
    this.rng = new RNG(this.seed);
    for (const p of this.plots) this.setPlotCrop(p, CROP_ROTATION[p.id % CROP_ROTATION.length]);
    for (const t of this.tiles.values()) {
      t.state = 'fallow';
      t.growth = 0;
      t.visual = 0;
      t.wetT = 0;
    }
    for (const w of this.workers) {
      for (let i = 0; i < w.plots.length; i++) this.setPlotCrop(this.plots[w.plots[i]], CROP_ROTATION[i % CROP_ROTATION.length]);
      this.seatHand(w);
    }
    this.touch();
  }

  /** put a plot — and every bed in it — down to one crop */
  private setPlotCrop(plot: FarmPlot, crop: CropKind) {
    plot.crop = crop;
    for (const c of plot.cells) {
      const t = this.tiles.get(c);
      if (t) t.crop = crop;
    }
  }

  /** the farmhand NPC `id` plays, or null when that villager is not a farmhand */
  workerFor(id: string): FarmWorker | null {
    return this.workers.find((w) => w.id === id) ?? null;
  }

  /** the beds a farmhand tends */
  private handTiles(w: FarmWorker): FarmTile[] {
    const out: FarmTile[] = [];
    for (const id of w.plots) for (const c of this.plots[id].cells) {
      const t = this.tiles.get(c);
      if (t) out.push(t);
    }
    return out;
  }

  /** is the farmhand on the clock? (he works the day and sleeps at home) */
  workHours(): boolean { return this.dayT < WORK_UNTIL; }

  /** rough time of day, for dialogue and the map screen */
  dayPhase(): string {
    const t = this.dayT;
    return t < 0.3 ? 'morning' : t < 0.6 ? 'midday' : t < WORK_UNTIL ? 'afternoon' : t < 0.97 ? 'evening' : 'night';
  }

  stats(): VillageStats {
    let cultivated = 0, ripe = 0, damp = 0;
    for (const t of this.tiles.values()) {
      if (t.state === 'fallow') continue;
      cultivated++;
      if (t.state === 'ripe') ripe++;
      if (t.wetT > 0) damp++;
    }
    return {
      day: this.day, phase: this.dayPhase(), cultivated, capacity: FARM_CAPACITY * this.workers.length,
      ripe, damp, harvested: this.harvested, harvestedToday: this.harvestedToday,
      basket: this.workers.reduce((n, w) => n + w.basket, 0), workers: this.workers.length,
    };
  }

  /** one line for the map screen */
  summary(): string {
    const s = this.stats();
    if (!s.workers) return `DAY ${s.day} ${s.phase.toUpperCase()} - NOBODY WORKS THE FIELDS`;
    const crops = [...new Set(this.workers.flatMap((w) => w.plots.map((id) => this.plots[id].crop)))].map((c) => CROPS[c].label.toUpperCase());
    return `DAY ${s.day} ${s.phase.toUpperCase()} - ${s.cultivated}/${s.capacity} BEDS OF ${crops.join(' + ')} - ${s.ripe} RIPE - ${s.harvestedToday} IN TODAY`;
  }

  // ---------------------------------------------------------------- tick
  /**
   * Advance the village by dt seconds: the calendar, the crops, and every farmhand. `avoid` is the
   * player's position — the farmhand will not walk through her, he waits for her to move on.
   */
  tick(dt: number, avoid?: Vec2) {
    this.dayT += dt / DAY_SECONDS;
    if (this.dayT >= 1) {
      this.dayT -= 1;
      this.day += 1;
      this.harvestedToday = 0;
    }
    this.grow(dt);
    for (const w of this.workers) this.stepHand(w, dt, avoid);
  }

  /** crops grow only while the soil is damp, and moisture dries out on its own */
  private grow(dt: number) {
    for (const t of this.tiles.values()) {
      if (t.state === 'fallow') continue;
      if (t.wetT > 0) {
        t.wetT -= dt;
        if (t.wetT <= 0) { t.wetT = 0; this.touch(); }
      }
      if (t.state !== 'sown' || t.wetT <= 0) continue;
      t.growth += dt / STAGE_SECONDS;
      const stage = Math.floor(t.growth);
      if (stage >= GROWTH_STAGES) {
        t.growth = GROWTH_STAGES;
        t.state = 'ripe';
        t.visual = 3;
        this.push({ kind: 'ripe', x: t.x + 0.5, z: t.z + 0.5, crop: t.crop });
      } else if (stage !== t.visual) {
        t.visual = stage as 0 | 1 | 2;
        this.push({ kind: 'sprout', x: t.x + 0.5, z: t.z + 0.5, crop: t.crop });
      }
    }
  }

  // ---------------------------------------------------------------- the farmhand's day
  private stepHand(w: FarmWorker, dt: number, avoid?: Vec2) {
    if (w.blockedT > 0) w.blockedT -= dt;
    switch (w.state) {
      case 'rest':
        if (this.workHours()) { w.state = 'idle'; w.idleT = 0.3; break; }
        this.idleAt(w, w.home.x, w.home.z, dt, avoid);
        break;
      case 'work':
        this.advanceTask(w, dt);
        break;
      case 'walk':
        if (this.walkTo(w, w.tx, w.tz, dt, avoid)) {
          if (w.task) this.beginTask(w);
          else { w.state = 'idle'; w.idleT = this.rng.range(1.6, 4.4); }
        }
        break;
      case 'idle':
        if (!this.workHours()) { this.sendHome(w); break; }
        w.idleT -= dt;
        if (w.idleT <= 0) this.nextJob(w);
        break;
    }
  }

  /** stand about at a point (night rest, or a breather at the door) */
  private idleAt(w: FarmWorker, x: number, z: number, dt: number, avoid?: Vec2) {
    if (Math.hypot(x - w.x, z - w.z) > 0.55) { this.walkTo(w, x, z, dt, avoid); return; }
    w.task = null;
    w.tile = -1;
    w.idleT -= dt;
    if (w.idleT <= 0) {
      // glance about now and then, so a resting villager does not read as a statue
      w.idleT = this.rng.range(2.5, 6.5);
      const a = this.rng.next() * Math.PI * 2;
      w.facing = facingFrom(Math.sin(a), Math.cos(a));
    }
  }

  /** the most urgent job on the farmhand's ground, or nothing when the field is happy */
  private nextJob(w: FarmWorker) {
    if (w.basket >= BASKET_SIZE) { this.startStow(w); return; }
    if (!this.workHours()) { this.sendHome(w); return; }
    const job = this.findWork(w);
    if (job) { this.startJob(w, job.task, job.tile); return; }
    this.stroll(w);
  }

  /**
   * Pick the next bed to work: harvest before water, water before sowing, sowing before breaking
   * new ground — the order a gardener works in. The bed he just worked is preferred, so a fresh
   * row runs till -> sow -> water in one pass instead of scattering him across the field.
   */
  private findWork(w: FarmWorker): { task: FarmTask; tile: number } | null {
    const beds = this.handTiles(w);
    let cultivated = 0;
    const perPlot = new Map<number, number>();
    for (const t of beds) {
      if (t.state === 'fallow') continue;
      cultivated++;
      perPlot.set(t.plot, (perPlot.get(t.plot) ?? 0) + 1);
    }
    // a field split into strips is meant to carry a crop each: the strip that is behind gets a
    // nudge, so the farmhand breaks new ground in both rather than finishing one row at a time
    const even = cultivated / Math.max(1, w.plots.length);
    // strict priorities: everything ripe is pulled first, then the thirsty beds, then the sowing
    // and only then new ground — the score only orders the beds within one of those jobs
    let best: { task: FarmTask; tile: number; tier: number; score: number } | null = null;
    for (const t of beds) {
      if (!t.reach || (t.i === w.blockedTile && w.blockedT > 0)) continue;
      const d = Math.hypot(t.x + 0.5 - w.x, t.z + 0.5 - w.z);
      const here = t.i === w.lastTile ? -0.8 : 0;
      let task: FarmTask | null = null, tier = 0, score = 0;
      if (t.state === 'ripe') { task = 'harvest'; tier = 0; score = d * 0.06 + here; }
      else if (t.state === 'sown' && t.wetT <= 0) { task = 'water'; tier = 1; score = d * 0.06 + here; }
      else if (t.state === 'tilled') { task = 'sow'; tier = 2; score = d * 0.06 + here; }
      else if (t.state === 'fallow' && cultivated < FARM_CAPACITY) {
        // break new ground beside the beds already under the hoe: the field fills in as a block
        let joined = 0;
        for (const [dx, dz] of N4) {
          const n = this.tiles.get((t.z + dz) * MAP_W + (t.x + dx));
          if (n && n.state !== 'fallow') joined++;
        }
        task = 'till';
        tier = 3;
        score = (4 - joined) * 0.9 + ((perPlot.get(t.plot) ?? 0) - even) * 0.5 + d * 0.06;
      }
      if (task && (!best || tier < best.tier || (tier === best.tier && score < best.score))) best = { task, tile: t.i, tier, score };
    }
    return best ? { task: best.task, tile: best.tile } : null;
  }

  /** take a job: walk to the bed, or start on the spot when already in reach */
  private startJob(w: FarmWorker, task: FarmTask, tile: number) {
    const t = this.tiles.get(tile);
    if (!t) { w.state = 'idle'; w.idleT = 0.3; return; }
    const at = this.standFor(w, t);
    w.task = task;
    w.tile = tile;
    w.applied = false;
    w.workT = 0;
    w.gx = t.x + 0.5;
    w.gz = t.z + 0.5;
    this.setTarget(w, at.x, at.z);
    if (Math.hypot(at.x - w.x, at.z - w.z) <= REACH) this.beginTask(w);
    else w.state = 'walk';
  }

  /** basket's worth of crops: carry it to the barrow */
  private startStow(w: FarmWorker) {
    w.task = 'stow';
    w.tile = -1;
    w.applied = false;
    w.workT = 0;
    w.gx = this.barrow.x;
    w.gz = this.barrow.z;
    this.setTarget(w, this.stowSpot.x, this.stowSpot.z);
    if (Math.hypot(this.stowSpot.x - w.x, this.stowSpot.z - w.z) <= REACH) this.beginTask(w);
    else w.state = 'walk';
  }

  /** knock-off: finish the row, empty the basket, then walk home for the night */
  private sendHome(w: FarmWorker) {
    if (w.state === 'work') return; // let him finish what is in his hands
    if (w.basket > 0) { this.startStow(w); return; }
    w.task = null;
    w.tile = -1;
    this.setTarget(w, w.home.x, w.home.z);
    if (Math.hypot(w.home.x - w.x, w.home.z - w.z) <= 0.6) { w.state = 'rest'; w.idleT = this.rng.range(1.5, 4); }
    else w.state = 'walk';
  }

  /** nothing needs doing: potter about the yard, then look again */
  private stroll(w: FarmWorker) {
    const a = this.rng.next() * Math.PI * 2;
    const r = this.rng.range(1.5, 4);
    const spot = this.world.nearestFree(this.stowSpot.x + Math.cos(a) * r, this.stowSpot.z + Math.sin(a) * r * 0.7);
    w.task = null;
    w.tile = -1;
    this.setTarget(w, spot.x, spot.z);
    w.state = 'walk';
  }

  private beginTask(w: FarmWorker) {
    if (!w.task) { w.state = 'idle'; w.idleT = 0.3; return; }
    w.state = 'work';
    w.workT = 0;
    w.applied = false;
    w.workDur = TASK[w.task].dur;
    w.facing = facingFrom(w.gx - w.x, w.gz - w.z);
  }

  private advanceTask(w: FarmWorker, dt: number) {
    const task = w.task;
    if (!task) { w.state = 'idle'; return; }
    w.workT += dt;
    const { dur, hit } = TASK[task];
    if (!w.applied && w.workT >= dur * hit) {
      w.applied = true;
      this.applyTask(w, task);
    }
    if (w.workT >= dur) {
      w.lastTile = w.tile;
      w.task = null;
      w.workT = 0;
      w.state = 'idle';
      w.idleT = 0.18;
      this.nextJob(w);
    }
  }

  /** the tool lands: change the world (re-checked — the bed may have moved on while he walked) */
  private applyTask(w: FarmWorker, task: FarmTask) {
    if (task === 'stow') {
      if (!w.basket) return;
      this.harvested += w.basket;
      this.harvestedToday += w.basket;
      w.basket = 0;
      this.push({ kind: 'stow', x: this.barrow.x, z: this.barrow.z });
      return;
    }
    const t = this.tiles.get(w.tile);
    if (!t) return;
    const px = t.x + 0.5, pz = t.z + 0.5;
    switch (task) {
      case 'till':
        if (t.state !== 'fallow') return;
        t.state = 'tilled';
        this.totals.tilled++;
        this.push({ kind: 'dirt', x: px, z: pz, who: w.id });
        break;
      case 'sow':
        if (t.state !== 'tilled') return;
        t.state = 'sown';
        t.growth = 0;
        t.visual = 0;
        this.totals.sown++;
        this.push({ kind: 'seeds', x: px, z: pz, crop: t.crop, who: w.id });
        break;
      case 'water':
        if (t.state === 'fallow') return;
        t.wetT = MOISTURE_SECONDS;
        this.totals.watered++;
        this.push({ kind: 'water', x: px, z: pz, crop: t.crop, who: w.id });
        break;
      case 'harvest':
        if (t.state !== 'ripe') return;
        t.state = 'tilled';
        t.growth = 0;
        t.visual = 0;
        w.basket++;
        this.push({ kind: 'harvest', x: px, z: pz, crop: t.crop, who: w.id });
        break;
    }
    this.touch();
  }

  // ---------------------------------------------------------------- movement
  /**
   * Where the farmhand stands to work a bed: the nearest neighbouring tile he can stand on,
   * preferring open ground over another bed (he reaches across the row rather than walking on the
   * crop he is tending).
   */
  private standFor(w: FarmWorker, t: FarmTile): Vec2 {
    let best: Vec2 = { x: t.x + 0.5, z: t.z + 0.5 };
    let bestScore = Infinity;
    for (const [dx, dz] of STAND_OFFSETS) {
      const nx = t.x + dx, nz = t.z + dz;
      if (!this.inMain(nx, nz)) continue;
      const other = this.tiles.get(nz * MAP_W + nx);
      const score = Math.hypot(nx + 0.5 - w.x, nz + 0.5 - w.z) + (other && other.state !== 'fallow' ? 1.4 : 0);
      if (score < bestScore) { bestScore = score; best = { x: nx + 0.5, z: nz + 0.5 }; }
    }
    return best;
  }

  /** walk toward a point; true once he is standing on it (within REACH) */
  /**
   * Connected components of the walkable ground (4-neighbour), worked out once. A bed can have a
   * walkable-looking neighbour that is actually fenced in — a pocket between two hay bales — and
   * that is no place to send a farmhand: he works the beds he can walk to.
   */
  private buildNav() {
    const w = MAP_W, h = this.world.h;
    const comp = new Int32Array(w * h).fill(-1);
    const queue = new Int32Array(w * h);
    const sizes: number[] = [];
    for (let i = 0; i < comp.length; i++) {
      if (comp[i] >= 0) continue;
      const x = i % w, z = (i - x) / w;
      if (!this.world.isWalkable(x + 0.5, z + 0.5)) continue;
      const id = sizes.length;
      let head = 0, tail = 0, size = 0;
      comp[i] = id;
      queue[tail++] = i;
      while (head < tail) {
        const c = queue[head++];
        size++;
        const cx = c % w, cz = (c - cx) / w;
        for (const [dx, dz] of N4) {
          const nx = cx + dx, nz = cz + dz;
          if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
          const ni = nz * w + nx;
          if (comp[ni] >= 0 || !this.world.isWalkable(nx + 0.5, nz + 0.5)) continue;
          comp[ni] = id;
          queue[tail++] = ni;
        }
      }
      sizes.push(size);
    }
    this.comp = comp;
    this.main = sizes.indexOf(Math.max(...sizes));
  }

  /** is this tile part of the ground the village walks on? (not a fenced-off pocket) */
  private inMain(x: number, z: number): boolean {
    if (x < 0 || z < 0 || x >= MAP_W || z >= this.world.h) return false;
    return this.comp !== null && this.comp[z * MAP_W + x] === this.main;
  }

  /** point the farmhand at a walk target and plot a route to it */
  private setTarget(w: FarmWorker, x: number, z: number) {
    w.tx = x;
    w.tz = z;
    this.repath(w);
  }

  /** rebuild the route to the current walk target (a fresh target, or one he has been blocked on) */
  private repath(w: FarmWorker) {
    w.path = this.findPath(w.x, w.z, w.tx, w.tz);
    w.pathI = 0;
  }

  /** the walkable tile nearest a world position, packed as z*MAP_W+x (-1 when there is none) */
  private navTile(x: number, z: number, r = 3): number {
    const world = this.world;
    const tx = Math.floor(x), tz = Math.floor(z);
    for (let ring = 0; ring <= r; ring++) {
      for (let dz = -ring; dz <= ring; dz++) for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
        const nx = tx + dx, nz = tz + dz;
        if (nx < 1 || nz < 1 || nx >= MAP_W - 1 || nz >= world.h - 1) continue;
        if (this.inMain(nx, nz)) return nz * MAP_W + nx;
      }
    }
    return -1;
  }

  /**
   * BFS over the walkable tiles from the farmhand to his walk target, returned as tile-centre
   * waypoints. The beds he tends are solid ground, so a farmhand who only ever walked in a straight
   * line would grind against the edge of a field instead of walking round it to the row he is
   * working. The village never changes shape, so this costs nothing worth measuring.
   */
  private findPath(sx: number, sz: number, tx: number, tz: number): Vec2[] {
    const w = MAP_W, h = this.world.h;
    const start = this.navTile(sx, sz);
    const goal = this.navTile(tx, tz);
    if (start < 0 || goal < 0 || start === goal) return [];
    const prev = new Int32Array(w * h).fill(-1);
    const seen = new Uint8Array(w * h);
    const queue = new Int32Array(w * h);
    let head = 0, tail = 0, found = -1;
    seen[start] = 1;
    queue[tail++] = start;
    while (head < tail) {
      const c = queue[head++];
      if (c === goal) { found = c; break; }
      const cx = c % w, cz = (c - cx) / w;
      for (const [dx, dz] of N4) {
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
        const ni = nz * w + nx;
        if (seen[ni] || !this.inMain(nx, nz)) continue;
        seen[ni] = 1;
        prev[ni] = c;
        queue[tail++] = ni;
      }
    }
    if (found < 0) return [];
    const out: Vec2[] = [];
    for (let c = found; c !== start; c = prev[c]) {
      const cx = c % w;
      out.push({ x: cx + 0.5, z: (c - cx) / w + 0.5 });
    }
    out.reverse();
    return out;
  }

  private walkTo(w: FarmWorker, tx: number, tz: number, dt: number, avoid?: Vec2): boolean {
    const d = Math.hypot(tx - w.x, tz - w.z);
    if (d <= REACH) return true;
    // head for the next waypoint of the planned route, or straight at the target when there is none
    while (w.pathI < w.path.length && Math.hypot(w.path[w.pathI].x - w.x, w.path[w.pathI].z - w.z) < 0.45) w.pathI++;
    const at = w.pathI < w.path.length ? w.path[w.pathI] : { x: tx, z: tz };
    let dx = at.x - w.x, dz = at.z - w.z;
    const vd = Math.hypot(dx, dz) || 1;
    const speed = w.basket > 0 ? LOADED_SPEED : WALK_SPEED;
    dx /= vd; dz /= vd;
    w.facing = facingFrom(dx, dz);
    const ox = w.x, oz = w.z;
    const step = Math.min(speed * dt, vd);
    this.world.moveBox(w, dx * step, dz * step, 0.28, 0.24, step);
    // the player is solid to him: he waits rather than shoving her aside
    if (avoid && Math.hypot(w.x - avoid.x, w.z - avoid.z) < 0.62) { w.x = ox; w.z = oz; }
    const moved = Math.hypot(w.x - ox, w.z - oz);
    if (moved < step * 0.4) {
      w.stuck += dt;
      if (w.stuck > 0.9) {
        // boxed in by a fence, a house or a prop: sidestep, and after a few tries give up on
        // this bed for a while instead of grinding against the wall
        w.stuck = 0;
        w.stuckTries++;
        if (w.stuckTries > 2) {
          w.stuckTries = 0;
          if (w.tile >= 0) { w.blockedTile = w.tile; w.blockedT = 25; }
          w.task = null;
          w.state = 'idle';
          w.idleT = 0.4;
          return false;
        }
        const a = this.rng.next() * Math.PI * 2;
        this.world.moveBox(w, Math.cos(a) * 1.2, Math.sin(a) * 1.2, 0.28, 0.24, 1.2);
        // he knows the way round; if the way is shut, plan it again from where he ended up
        this.repath(w);
      }
    } else {
      w.stuck = 0;
      if (w.stuckTries > 0) w.stuckTries--;
    }
    return false;
  }

  // ---------------------------------------------------------------- plumbing
  private push(e: VillageEvent) {
    // the view drains these every frame; the cap only matters to headless runs that never drain
    if (this.events.length > 64) this.events.shift();
    this.events.push(e);
  }

  /** a bed's look changed: the view rebuilds its instances */
  private touch() { this.rev++; }

  /** drain the events the view has not drawn yet */
  drainEvents(): VillageEvent[] {
    if (!this.events.length) return [];
    const out = this.events;
    this.events = [];
    return out;
  }

  /** Plain-data snapshot — the payload shape that will cross the worker boundary. */
  snapshot() {
    return {
      day: this.day, dayT: this.dayT, plots: this.plots, workers: this.workers,
      tiles: [...this.tiles.values()], harvested: this.harvested, totals: this.totals,
    };
  }
}
