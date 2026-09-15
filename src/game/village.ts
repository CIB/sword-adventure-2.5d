/**
 * Village simulation: the farm.
 *
 * Thistledown has worked ground — the tilled `Tile.Bed` plots south of the plaza and by the cottages —
 * and until now it was painted texture: the same four baked sprouts on every tile, forever. This file
 * makes it a *place that happens*: every bed tile in a farm plot is a piece of ground with real state
 * (worked or fallow, planted, how far along the plant is, how wet the soil is, whether the crop is ripe
 * or gone to seed), and the village farmer is a worker with a pack of seeds, a watering can and a day's
 * schedule who walks the plots and tends them — the way a Stardew Valley farm gets tended, except that
 * the farmer does it whether the player is watching or not.
 *
 * Everything here is plain data (no THREE, no DOM), deliberately structured-clone friendly, in the same
 * spirit as `worldstate.ts`: the simulation knows nothing about how a crop looks, it only knows what a
 * tile *is*. `farm.ts` materialises that state into meshes (instanced crops, wet soil), reads the
 * farmer's action to pose him, and turns the events below into particles (seed toss, watering, harvest).
 *
 * Design notes:
 *  - Crops grow in stages and only while their soil is moist; water evaporates, so the farmer's real
 *    job is watering, not planting. A dry crop waits instead of dying, which keeps a field you walk
 *    away from readable when you come back.
 *  - A ripe crop holds for a while and then wilts; a wilted crop has to be cleared before the ground is
 *    useful again. Deadlines give the day rhythm without punishing the player for looking elsewhere.
 *  - The farmer's day is budgeted like a person's: so many tiles of new ground broken, so many drawn
 *    with the can, a rest between stretches of work, and the spade and the pouch by turns. That is what
 *    keeps him farming instead of optimising, and it is why the fields expand a few tiles a day — a plot
 *    the shopkeeper's seed sack opens up fills in over a session rather than in one frame.
 *  - He works *down a row*: each plot keeps a cursor into its serpentine tile order and he does whatever
 *    the next tile that wants something needs. That is both how a person farms and the only scheme that
 *    cannot starve a class of work — an urgent-harvest pass is the one thing allowed to jump the row.
 *  - The farmer is a path-following body, not a teleporter: jobs are reached with a bounded BFS on the
 *    tile graph and walked with the same box physics as every other character, so the scarecrow and the
 *    hay cart are obstacles to him too, and he walks around them like anyone else would.
 */
import { MAP_W, Tile, RNG, clamp, facingFrom, type Facing } from './constants';
import type { Vec2 } from './world';

/**
 * One village day, in seconds. Deliberately far shorter than a real day: the point of the farm is that
 * a stage change, a harvest and a fresh furrow happen while you are in the village, not an hour later.
 * 60 s is long enough that the farmer's schedule reads as a working day (till, sow, water, walk to the
 * cart, back again) and short enough that a turnip comes up in about a day and a half.
 */
export const DAY_SECONDS = 60;
/**
 * Waterings the farmer's can holds before he walks to the cart to refill. A Stardew can is 6; his is 8
 * because he has a whole village's ground to keep wet and one trip more or less is the difference
 * between watering a row and watering two.
 */
export const WATER_CAN = 8;
/** seeds of one crop the farmer restocks to at the cart */
export const SEED_PACK = 12;
/** how full the basket gets before he carries it to the cart */
export const BASKET_FULL = 10;
/** new ground the farmer breaks per day, in tiles — the fields visibly expand */
export const TILL_PER_DAY = 5;
/**
 * Tiles a farmer will draw water for in a day: about a day and a half of cans. Watering has to be both
 * his first chore and a rationed one — a village field is never fully watered by one man, so if the can
 * outranked everything else he would abandon the hoe and the seed pouch forever, and if it were left to
 * the ordinary sweep he would water a tile once every two days and the field would grow in slow motion.
 */
export const WATER_PER_DAY = 12;
/** tiles/s: walking to a job, and shuffling about when there is nothing to do */
export const FARMER_SPEED = 1.75;
export const FARMER_STROLL = 0.65;
/** seconds a job waits before the farmer will try to reach it again after failing to */
export const RETRY_AFTER = 25;
/** a crop is "thirsty" (worth the farmer's trip) below this moisture */
export const THIRSTY = 0.5;
/** at or below this the soil is dust: the plant is alive and waiting, but it is not growing */
export const STALLED = 0.06;
/**
 * How much of its hold window a ripe crop may burn before it counts as an emergency — the one case in
 * which the farmer abandons his row, because a crop that wilts is a season's work thrown away.
 *
 * Deliberately late. A village field ripens faster than one man can clear it, so an early trigger turns
 * the emergency into his whole day and the hoe and the seed pouch never get a turn; a late one lets ripe
 * produce stand in the row (which is what makes a farm look farmed, and what gives a player a reason to
 * walk over and pick), and costs him only the crops that were truly going to waste.
 */
export const RIPE_URGENCY = 0.9;
/** jobs between rests: he is a man, not a sprinkler */
export const JOBS_PER_REST = 8;
/** jobs done in one plot before he moves on to the next field */
export const PLOT_PASS = 10;

// ------------------------------------------------------------------ crops
export type CropId = 'turnip' | 'potato' | 'tomato' | 'pumpkin';

/**
 * A crop. `stageSec` is the heart of it: one entry per step up the ladder from seed to ripe, in seconds
 * of *watered* time — so a crop's total grow time is `sum(stageSec)` if the farmer keeps it wet and
 * longer if he does not. The rest is what the renderer needs (shape family, palette, mature height) and
 * what the village economy needs (seed and sale price); they live in one plain object on purpose, so
 * `crops.ts` draws exactly what the simulation means and cannot drift out of step with it.
 */
export interface CropSpec {
  id: CropId;
  name: string;
  /** what the village calls it when there is more than one on the plant */
  plural: string;
  /** seconds of watered growth per stage step; length = stages - 1, stage 0 being the seed */
  stageSec: number[];
  /** moisture units the plant drinks per second; ~1/60 is a village day of water, ~1/30 half a day */
  drink: number;
  /** seconds a ripe crop holds on the plant before it wilts (0 = it waits forever) */
  hold: number;
  /** picked ripe → back to this stage and it fruits again; undefined = the plant is pulled out */
  regrowTo?: number;
  yieldMin: number;
  yieldMax: number;
  seedPrice: number;
  sellPrice: number;
  /** --- presentation, read by crops.ts; the simulation never looks at any of it --- */
  shape: 'root' | 'bush' | 'vine' | 'gourd';
  leaf: string;
  leafD: string;
  stem: string;
  fruit: string;
  fruitAlt: string;
  /** mature height, in tiles */
  height: number;
  /** leaves/branches per stage — how busy the plant looks */
  fronds: number;
}

export const CROPS: Record<CropId, CropSpec> = {
  // the quick village crop: up in about a day and a half, so the loop is visible in one visit
  turnip: {
    id: 'turnip', name: 'TURNIP', plural: 'TURNIPS', stageSec: [9, 9, 10, 12], drink: 0.014, hold: 300,
    yieldMin: 1, yieldMax: 2, seedPrice: 12, sellPrice: 7,
    shape: 'root', leaf: '#5fb84a', leafD: '#3f8c3a', stem: '#4a9a44', fruit: '#f2eae2', fruitAlt: '#a04ab0',
    height: 0.46, fronds: 7,
  },
  potato: {
    id: 'potato', name: 'POTATO', plural: 'POTATOES', stageSec: [11, 12, 13, 14, 15], drink: 0.012, hold: 360,
    yieldMin: 2, yieldMax: 3, seedPrice: 20, sellPrice: 9,
    shape: 'bush', leaf: '#4fa845', leafD: '#357a36', stem: '#3f7a3a', fruit: '#c8a06a', fruitAlt: '#a8834f',
    height: 0.54, fronds: 8,
  },
  tomato: {
    id: 'tomato', name: 'TOMATO', plural: 'TOMATOES', stageSec: [12, 13, 14, 15], drink: 0.016, hold: 240, regrowTo: 2,
    yieldMin: 1, yieldMax: 2, seedPrice: 24, sellPrice: 12,
    shape: 'vine', leaf: '#3f8f3f', leafD: '#2d6a32', stem: '#5a8a3a', fruit: '#d8362a', fruitAlt: '#f0603a',
    height: 0.9, fronds: 6,
  },
  pumpkin: {
    id: 'pumpkin', name: 'PUMPKIN', plural: 'PUMPKINS', stageSec: [14, 16, 18, 20, 22, 24], drink: 0.014, hold: 420,
    yieldMin: 1, yieldMax: 1, seedPrice: 40, sellPrice: 26,
    shape: 'gourd', leaf: '#4a9a3f', leafD: '#357a36', stem: '#4a7a34', fruit: '#e08a28', fruitAlt: '#c06a1c',
    height: 0.56, fronds: 9,
  },
};

export const CROP_IDS = Object.keys(CROPS) as CropId[];
/** stages a crop passes through, seed (0) to ripe (stages - 1) */
export const cropStages = (id: CropId) => CROPS[id].stageSec.length + 1;
/** total seconds of watered growth from seed to ripe */
export const cropGrowTime = (id: CropId) => CROPS[id].stageSec.reduce((a, b) => a + b, 0);
/** is this tile's plant standing ripe? */
export const isRipe = (t: Pick<FarmTile, 'crop' | 'stage' | 'wilted'>) =>
  t.crop !== null && !t.wilted && t.stage >= cropStages(t.crop) - 1;

// ------------------------------------------------------------------ tiles
export interface FarmTile {
  /** index in `VillageState.tiles` */
  i: number;
  x: number;
  z: number;
  /** the plot this tile belongs to */
  plot: number;
  /** place in the plot's serpentine work order (the farmer works the rows in this order) */
  order: number;
  /** has the farmer broken this ground yet? an untilled tile is weeds and stubble */
  tilled: boolean;
  crop: CropId | null;
  /** 0 = seed in the ground … `cropStages(crop) - 1` = ripe */
  stage: number;
  /** 0..1 progress toward the next stage — the view interpolates the plant's size with it */
  grow: number;
  /** soil moisture, 0 (dust) to 1 (just watered) */
  moist: number;
  /** seconds the crop has been ripe (drives the wilt deadline) */
  ripeT: number;
  /** ripe too long: worthless, and it has to be cleared before the ground is useful again */
  wilted: boolean;
  /** picks this plant has given (regrowers only — the view shows a stubbier stump) */
  picks: number;
  /** per-tile revision: the view rebuilds a tile's instances when it moves */
  rev: number;
}

/** what the farmer is about to do to a tile — also the animation the view plays */
export type JobKind = 'till' | 'sow' | 'water' | 'harvest' | 'clear';
/** the farmer's frame-by-frame activity (`fetch` = refill and unload at the cart, `rest` = a breath) */
export type FarmerAct = 'idle' | 'walk' | JobKind | 'fetch' | 'rest';

/** how long the farmer spends on each action, in seconds (the view eases its pose with these) */
export const ACT_DUR: Record<JobKind | 'fetch' | 'rest', number> = {
  till: 0.85, sow: 0.7, water: 0.8, harvest: 0.7, clear: 0.75, fetch: 1.0, rest: 2.6,
};
/** the fraction of an action at which the tool lands — the view fires its particles here */
export const ACT_MOMENT = 0.55;

export type EventKind = JobKind | 'sprout' | 'ripe' | 'wilt' | 'day' | 'deliver' | 'unlock';

/**
 * Something the simulation did that the world should show. The view drains these once per frame: the
 * farmer's position it reads off the sim (same frame, so particles start at his hands), the crop state
 * it reads off the tiles. Nothing here has to be replayed, so the queue is fire-and-forget.
 */
export interface VillageEvent {
  kind: EventKind;
  /** the tile it happened on, in world units (tile centre); the cart for `deliver`, the village for `day` */
  x: number;
  z: number;
  /**
   * Who did it, in world units: the particles start here (seeds leave a hand, water pours from a can, a
   * picked crop flies back to whoever picked it). The tile centre when nobody was standing anywhere.
   */
  from: Vec2;
  crop: CropId | null;
  /** the stage the tile reached (sprout/sow), or the day number (`day`), or the plot id (`unlock`) */
  n1: number;
  /** how many items (harvest yield, seeds sown, tiles in a newly opened plot) */
  n: number;
  /** rupees involved, when the event is money (a harvest's worth, a sale at the cart) */
  rupees: number;
}

/** a farm plot as the world defines it: a rect of bed ground, the crop it grows, and its cart stand */
export interface FarmPlotSeed {
  id: number;
  name: string;
  crop: CropId;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** where the seed crates and the water butt stand, in tile coords: a walkable spot the farmer returns to */
  cart: [number, number];
  /** a locked plot is real ground the village has not taken on yet (see `unlockPlot`) */
  locked?: boolean;
}

/** the slice of the World the village sim needs — types only, so this module stays THREE-free */
export interface VillageTerrain {
  isSolidTile(x: number, z: number): boolean;
  tile(x: number, z: number): Tile;
  moveBox(p: Vec2, dx: number, dz: number, hw: number, hh: number, nudge?: number): { bx: boolean; bz: boolean };
  /** nearest walkable tile centre (used to park the farmer on free ground) */
  nearestFree(x: number, z: number): Vec2;
}

export interface VillageStats {
  days: number;
  tilled: number;
  sown: number;
  watered: number;
  harvested: number;
  /** crops that went to seed and had to be cleared out */
  lost: number;
  /** rupees the produce has earned the village at the cart */
  gold: number;
  byCrop: Record<CropId, number>;
}

/** the farmer, as the simulation sees him: a body on the tile map, a job, and a shopping basket */
export interface Farmer {
  x: number;
  z: number;
  facing: Facing;
  /** true while he is putting one foot in front of the other (the view runs the walk cycle off it) */
  moving: boolean;
  act: FarmerAct;
  /** seconds into the current action (the view eases the pose with actT / actDur) */
  actT: number;
  actDur: number;
  /** the tile being worked, or -1 */
  job: number;
  jobKind: JobKind | null;
  /** walking: the compressed waypoints left to reach the job */
  path: Vec2[];
  wp: number;
  /** heading for the cart rather than for a tile job */
  fetching: boolean;
  water: number;
  seeds: Record<CropId, number>;
  basket: Record<CropId, number>;
  basketN: number;
  /** standing-about time before the next stroll */
  idleT: number;
  stuck: number;
  /** how many times in a row he has had to fight his way out of the same corner */
  stuckTries: number;
  /** where a rest is drifting him, if anywhere */
  strolling: Vec2 | null;
  /** tile index -> sim time before which the farmer will not try to reach it again */
  retry: Record<number, number>;
}

/** the box the farmer walks with — a shade narrower than an NPC's, so he fits between the rows */
const FHW = 0.26, FHH = 0.22;

const emptyByCrop = (): Record<CropId, number> => ({ turnip: 0, potato: 0, tomato: 0, pumpkin: 0 });

/**
 * The farm: its plots, the state of every tile in them, the farmer who works them and the day clock
 * that drives everything. Built next to `WorldState` (from the world's `farmPlots`), ticked once per
 * frame while the game is playing, reset with the run.
 */
export class VillageState {
  /** sim clock in seconds, and the village day it falls in */
  time = 0;
  day = 1;
  dayT = 0;
  tiles: FarmTile[] = [];
  plots: FarmPlot[] = [];
  farmer: Farmer;
  stats: VillageStats = {
    days: 1, tilled: 0, sown: 0, watered: 0, harvested: 0, lost: 0, gold: 0, byCrop: emptyByCrop(),
  };
  /** bumped on every tile change so the view can skip rebuilding while the fields are idle */
  rev = 0;

  /** the queue the view and the Game drain once per frame */
  private events: VillageEvent[] = [];
  private index = new Map<number, FarmTile>();
  private rng: RNG;
  /**
   * New tiles the farmer will break today. The count is both his budget and his priority: while it is
   * above zero, breaking ground outranks watering and sowing, so the far rows get opened up instead of
   * waiting forever behind an endless round of watering.
   */
  private tillTurn = TILL_PER_DAY;
  /** the day's watering budget, in tiles (see WATER_PER_DAY) */
  private waterTurn = WATER_PER_DAY;
  /** the ground hour alternates between the spade and the seed pouch (see `nextJob`) */
  private groundTurn = 0;
  /** the plot the farmer is working, so he finishes a row before crossing the village */
  private lastPlot = 0;
  /** which plot the sweep starts from, and how many jobs he has done in it since it moved on */
  private activePlot = 0;
  private plotJobs = 0;
  /** per-plot position in the serpentine sweep: where he left off, and where he starts tomorrow */
  private cursor: Record<number, number> = {};
  /** jobs done since the run began, and whether the next pause is owed to him */
  private jobsDone = 0;
  private needsRest = false;

  constructor(private terrain: VillageTerrain, private plotSeeds: FarmPlotSeed[], private seed = 0x7a11) {
    this.rng = new RNG(seed);
    this.buildPlots();
    this.farmer = this.newFarmer();
  }

  // ---------------------------------------------------------------- world layout
  /**
   * Resolve the plot rects into farm tiles: a rect's bed ground that is not buried under a prop. Rows
   * run in serpentine order so the farmer works down one side of a field and back up the other instead
   * of teleporting between scattered tiles.
   */
  private buildPlots() {
    this.tiles = [];
    this.index.clear();
    this.plots = this.plotSeeds.map((p) => ({ ...p, cart: { x: p.cart[0], z: p.cart[1] }, tiles: [], unlocked: !p.locked }));
    for (const plot of this.plots) {
      for (let z = plot.z0; z <= plot.z1; z++) {
        const row: FarmTileSeed[] = [];
        for (let x = plot.x0; x <= plot.x1; x++) row.push({ x, z });
        if ((z - plot.z0) % 2) row.reverse();
        for (const s of row) {
          if (!this.isFarmGround(s.x, s.z)) continue;
          const tile: FarmTile = {
            i: this.tiles.length, x: s.x, z: s.z, plot: plot.id, order: plot.tiles.length,
            tilled: false, crop: null, stage: 0, grow: 0, moist: 0, ripeT: 0, wilted: false, picks: 0, rev: 0,
          };
          this.tiles.push(tile);
          this.index.set(s.z * MAP_W + s.x, tile);
          plot.tiles.push(tile.i);
        }
      }
    }
    this.seedTheFields();
  }

  /** bed ground, walkable, and not under a house or a tree */
  private isFarmGround(x: number, z: number): boolean {
    return this.terrain.tile(x, z) === Tile.Bed && !this.terrain.isSolidTile(x, z);
  }

  /**
   * A village that is already mid-morning when you arrive: the near rows of the open plots are broken
   * and sown — some ripe, some sprouting, some dry enough to need the farmer right away — so there is
   * something to watch and something to harvest within the first minute, and bare earth to watch fill
   * in over the following days.
   */
  private seedTheFields() {
    for (const plot of this.plots) {
      if (!plot.unlocked) continue;
      const work = Math.min(plot.tiles.length, 16);
      for (let k = 0; k < work; k++) {
        const t = this.tiles[plot.tiles[k]];
        t.tilled = true;
        t.moist = 0.5 + this.rng.next() * 0.45;
        this.stats.tilled++;
        if (k >= work - 5) continue; // leave the far rows as bare earth for the farmer to sow
        t.crop = plot.crop;
        const last = cropStages(plot.crop) - 1;
        // the first two tiles are ripe (a harvest happens almost immediately), then a spread of stages
        t.stage = k < 2 ? last : 1 + Math.floor(this.rng.next() * (last - 1));
        t.grow = t.stage === last ? 0 : this.rng.next();
        if (t.stage !== last) this.stats.sown++;
        t.rev = ++this.rev;
      }
    }
  }

  private newFarmer(): Farmer {
    const cart = this.plots[0]?.cart ?? { x: 0, z: 0 };
    const at = this.terrain.nearestFree(cart.x, cart.z);
    const seeds = {} as Record<CropId, number>;
    for (const id of CROP_IDS) seeds[id] = SEED_PACK;
    return {
      x: at.x, z: at.z, facing: 0, moving: false, act: 'idle', actT: 0, actDur: 0,
      job: -1, jobKind: null, path: [], wp: 0, fetching: false,
      water: WATER_CAN, seeds, basket: emptyByCrop(), basketN: 0,
      idleT: 0.4, stuck: 0, stuckTries: 0, strolling: null, retry: {},
    };
  }

  // ---------------------------------------------------------------- queries
  tileAt(x: number, z: number): FarmTile | undefined { return this.index.get(z * MAP_W + x); }
  plotOf(t: FarmTile): FarmPlot { return this.plots[t.plot]; }
  /** tiles whose crop is ready to pick */
  readyCount(): number { return this.countWhere((t) => isRipe(t)); }
  /** tiles whose crop is waiting on water */
  thirstyCount(): number { return this.countWhere((t) => !!t.crop && !t.wilted && !isRipe(t) && t.moist < THIRSTY); }
  /** broken ground waiting for seed */
  openCount(): number { return this.countWhere((t) => t.tilled && !t.crop && !t.wilted); }
  /** open-plot ground that has not been broken yet */
  fallowCount(): number { return this.countWhere((t) => !t.tilled && this.plots[t.plot].unlocked); }
  /** crops that went to seed */
  wiltedCount(): number { return this.countWhere((t) => t.wilted); }
  /** fraction of the village's open ground that is currently carrying a crop */
  plantedFraction(): number {
    const open = this.tiles.filter((t) => this.plots[t.plot].unlocked);
    if (!open.length) return 0;
    return open.filter((t) => t.crop !== null).length / open.length;
  }
  private countWhere(pred: (t: FarmTile) => boolean): number {
    let n = 0;
    for (const t of this.tiles) if (pred(t)) n++;
    return n;
  }
  /** one line of status per plot, for the farmer's dialogue */
  report(): { plot: string; crop: string; tilled: number; of: number; ready: number; wilted: number; open: boolean }[] {
    return this.plots.map((p) => {
      let tilled = 0, ready = 0, wilted = 0;
      for (const i of p.tiles) {
        const t = this.tiles[i];
        if (t.tilled) tilled++;
        if (isRipe(t)) ready++;
        if (t.wilted) wilted++;
      }
      return { plot: p.name, crop: CROPS[p.crop].name, tilled, of: p.tiles.length, ready, wilted, open: p.unlocked };
    });
  }

  /** drain the event queue (the view calls this once per frame) */
  takeEvents(): VillageEvent[] {
    if (!this.events.length) return [];
    const out = this.events;
    this.events = [];
    return out;
  }

  private emit(kind: EventKind, x: number, z: number, crop: CropId | null, n1 = 0, n = 0, rupees = 0, from?: Vec2) {
    this.events.push({ kind, x, z, crop, n1, n, rupees, from: from ?? { x, z } });
  }
  private emitAt(kind: EventKind, t: FarmTile | null, crop: CropId | null, n1 = 0, n = 0, rupees = 0, from?: Vec2) {
    this.emit(kind, t ? t.x + 0.5 : 0, t ? t.z + 0.5 : 0, crop, n1, n, rupees, from);
  }

  // ---------------------------------------------------------------- player hooks
  /** the shopkeeper's seed sack: take on a plot the village had left fallow */
  unlockPlot(id: number): boolean {
    const p = this.plots[id];
    if (!p || p.unlocked) return false;
    p.unlocked = true;
    this.farmer.seeds[p.crop] = Math.max(this.farmer.seeds[p.crop], SEED_PACK);
    this.emit('unlock', p.cart.x, p.cart.z, p.crop, id, p.tiles.length, 0);
    return true;
  }

  /** hand the farmer a sack of seeds (stock only — the ground is his business) */
  grantSeeds(crop: CropId, n: number) {
    this.farmer.seeds[crop] = Math.min(99, this.farmer.seeds[crop] + n);
  }

  /**
   * The player takes the produce straight off the farmer's basket instead of letting him walk it to the
   * cart. Returns null when there is nothing in it, so a conversation can say so rather than take money.
   */
  takeBasket(): { n: number; crop: CropId | null; value: number } | null {
    const f = this.farmer;
    if (f.basketN <= 0) return null;
    let crop: CropId | null = null;
    let value = 0;
    for (const id of CROP_IDS) {
      if (!f.basket[id]) continue;
      value += f.basket[id] * CROPS[id].sellPrice;
      if (!crop) crop = id;
    }
    const n = f.basketN;
    f.basket = emptyByCrop();
    f.basketN = 0;
    return { n, crop, value };
  }

  /** rain, when the weather arrives: every crop's soil takes a good drink */
  waterEverything(amount = 1) {
    for (const t of this.tiles) if (t.crop && !t.wilted) { t.moist = clamp(t.moist + amount, 0, 1); t.rev = ++this.rev; }
  }

  // ---------------------------------------------------------------- the day
  tick(dt: number) {
    this.time += dt;
    this.dayT += dt;
    if (this.dayT >= DAY_SECONDS) {
      this.dayT -= DAY_SECONDS;
      this.day++;
      this.newDay();
    }
    this.growCrops(dt);
    this.updateFarmer(dt);
  }

  private newDay() {
    this.stats.days = this.day;
    this.tillTurn = TILL_PER_DAY;
    this.waterTurn = WATER_PER_DAY;
    // Morning: the night air took most of what the soil drank. Every planted tile wakes up just dry
    // enough to want the can, which is what gives a farmer's day its shape — water first, then the rest.
    // Without this a crop sits at the slow-but-nonzero damp pace for a week and watering is a chore
    // nobody ever needs, which is a farming simulation in name only.
    for (const t of this.tiles) if (t.crop && !t.wilted) t.moist = Math.min(t.moist, 0.2) * 0.25;
    this.emit('day', 0, 0, null, this.day, this.openCount(), 0);
  }

  /**
   * Advance every plant by `dt` seconds of growing time and dry its soil a little. Split out of `tick`
   * so the fields can be run on their own: a test that wants to know whether a crop wilts on schedule
   * should not have to simulate a man walking rows to find out.
   */
  growCrops(dt: number) {
    for (const t of this.tiles) {
      const crop = t.crop;
      if (!crop || t.wilted) continue;
      const spec = CROPS[crop];
      const last = spec.stageSec.length;
      if (t.moist > 0) t.moist = Math.max(0, t.moist - spec.drink * dt);
      if (t.stage >= last) {
        // ripe: hold on the plant until the farmer comes, then go to seed
        t.ripeT += dt;
        if (spec.hold > 0 && t.ripeT > spec.hold) {
          t.wilted = true;
          t.rev = ++this.rev;
          this.emitAt('wilt', t, crop);
        }
        continue;
      }
      // Wet soil grows at full pace, drying soil at a third of it, and dust not at all. The middle band
      // is what makes one farmer's can matter — a field of sixty tiles is more than one man can water,
      // so the rows he got to stand a head taller than the rows he did not, all season long.
      const rate = t.moist > 0.45 ? 1 : t.moist > STALLED ? 0.34 : 0;
      if (rate === 0) continue;
      t.grow += (dt * rate) / spec.stageSec[t.stage];
      while (t.grow >= 1 && t.stage < last) {
        t.grow -= 1;
        t.stage++;
        t.rev = ++this.rev;
        if (t.stage === last) {
          t.grow = 0;
          t.ripeT = 0;
          this.emitAt('ripe', t, crop, t.stage);
        } else {
          this.emitAt('sprout', t, crop, t.stage);
        }
      }
    }
  }

  // ---------------------------------------------------------------- the farmer
  /**
   * The farmer's own turn: carry on with the current job (walk the path, then act on the tile), or pick
   * the next one — see `nextJob` for what that is, and `toolLands` for how it lands.
   */
  private updateFarmer(dt: number) {
    const f = this.farmer;
    switch (f.act) {
      case 'walk':
        this.walkToJob(dt);
        return;
      case 'rest':
        this.doRest(dt);
        return;
      case 'idle':
        this.pickJob(dt);
        return;
      default:
        this.doAction(dt);
    }
  }

  /** mid-action: the tool lands at ACT_MOMENT, the action closes out at ACT_DUR */
  private doAction(dt: number) {
    const f = this.farmer;
    f.moving = false;
    const prev = f.actT;
    f.actT += dt;
    const moment = f.jobKind ? ACT_MOMENT * f.actDur : 0;
    if (f.job >= 0 && prev < moment && f.actT >= moment) this.toolLands();
    if (f.actT < f.actDur) return;
    if (f.job >= 0) this.finishJob();
    else this.finishFetch();
    f.act = 'idle';
    f.actT = 0;
    f.actDur = 0;
    f.job = -1;
    f.jobKind = null;
  }

  /** a breath, and maybe a few steps along the rows so he is never a statue */
  private doRest(dt: number) {
    const f = this.farmer;
    f.actT += dt;
    if (f.strolling) {
      let dx = f.strolling.x - f.x, dz = f.strolling.z - f.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.15) f.strolling = null;
      else {
        dx /= d; dz /= d;
        f.facing = facingFrom(dx, dz);
        const step = FARMER_STROLL * dt;
        const ox = f.x, oz = f.z;
        this.terrain.moveBox(f, dx * step, dz * step, FHW, FHH, step);
        f.moving = Math.hypot(f.x - ox, f.z - oz) > 1e-4;
      }
    }
    if (f.actT >= f.actDur) {
      f.act = 'idle';
      f.actT = 0;
      f.moving = false;
      f.strolling = null;
    }
  }

  /** decide what to do next; nothing to do means a rest, or a trip to the cart */
  private pickJob(dt: number) {
    const f = this.farmer;
    f.moving = false;
    if (f.idleT > 0) { f.idleT -= dt; return; }
    if (this.needsRest) { this.needsRest = false; this.startRest(); return; }
    // a full basket is a problem, not a preference: it goes to the cart before the next row, or he ends
    // the day carrying a harvest nobody has sold
    if (f.basketN >= BASKET_FULL) { this.startFetch(); return; }
    const job = this.nextJob();
    if (job) {
      // out of water or out of seed for it: fetch first, then do the same job
      if (!job.ok) { this.startFetch(); return; }
      this.assign(job.kind, job.tile);
      return;
    }
    // nothing wants him: he still walks to the cart if he is carrying produce or the can is half empty,
    // so he starts the next row with tools that work
    if (f.basketN > 0 || f.water < WATER_CAN * 0.5) { this.startFetch(); return; }
    this.startRest();
  }

  private startRest() {
    const f = this.farmer;
    f.act = 'rest';
    f.actDur = ACT_DUR.rest * (0.6 + this.rng.next() * 0.8);
    f.actT = 0;
    f.strolling = this.strollTarget();
  }

  /** the farmer drifts a tile or two toward his cart or along the rows instead of standing like a post */
  private strollTarget(): Vec2 | null {
    const cart = this.plots[this.lastPlot]?.cart ?? this.plots[0]?.cart;
    const f = this.farmer;
    if (!cart) return null;
    if (Math.hypot(cart.x - f.x, cart.z - f.z) > 5) return cart;
    const a = this.rng.next() * Math.PI * 2;
    const r = 0.8 + this.rng.next() * 1.4;
    return { x: f.x + Math.cos(a) * r, z: f.z + Math.sin(a) * r };
  }

  /**
   * What the farmer does next. Five passes, in this order:
   *  1. an emergency — a ripe crop close to going to seed anywhere on the village's ground. That is the
   *     one thing with a real deadline, so it is worth crossing a field for.
   *  2. the can — the thirstiest tile in the field he is standing in, while the day's water lasts.
   *  3. the ground hour, from mid-morning: the nearest tile that wants seed, else the nearest fallow
   *     ground while the day's digging budget lasts. This is what makes the fields grow outward.
   *  4. the sweep: each plot keeps a cursor into its serpentine tile order and he does whatever the next
   *     tile that wants something needs — water it, sow it, break it, pick it. That is how a person
   *     actually works a field (down the row, one chore per tile), it is what makes him read as *farming*
   *     rather than as a bot chasing the nearest red dot, and it makes starvation impossible: the cursor
   *     comes round to every tile, so no class of work can be skipped forever by a more urgent one.
   *
   * Two chores are rationed per day — so much new ground with the spade (`TILL_PER_DAY`) and a canful of
   * water (`WATER_PER_DAY`) — because a man with a hundred tiles and two hands has to stop something,
   * and the two that are always worth deferring are the ones with no deadline. A field nobody waters
   * grows in slow motion; a field nobody breaks never arrives at all.
   */
  private nextJob(): { kind: JobKind; tile: number; ok: boolean } | null {
    const f = this.farmer;
    const usable = (t: FarmTile) => this.time >= (f.retry[t.i] ?? 0);
    const ready = (kind: JobKind, t: FarmTile) =>
      kind !== 'water' || f.water > 0 ? kind !== 'sow' || f.seeds[this.plotOf(t).crop] > 0 : false;
    // 1. emergencies first: ripe, and running out of time
    let panic: { tile: number; kind: JobKind; d: number } | null = null;
    for (const t of this.tiles) {
      if (!t.crop || t.wilted || !isRipe(t) || !usable(t)) continue;
      const spec = CROPS[t.crop];
      if (spec.hold <= 0 || t.ripeT < spec.hold * RIPE_URGENCY) continue;
      const d = Math.hypot(t.x + 0.5 - f.x, t.z + 0.5 - f.z);
      if (!panic || d < panic.d) panic = { tile: t.i, kind: 'harvest', d };
    }
    if (panic) return { kind: panic.kind, tile: panic.tile, ok: true };
    // 2. the can first, in the field he is standing in: a thirsty crop is the only thing that actually
    // stops growth, so it comes before the hoe and the seed pouch — but only down his own row, because
    // watering the row you are in is how a farmer carries a can, and chasing the driest tile across the
    // village is how a bot does it (and leaves the fallow ground at the end of the row unbroken).
    if (this.waterTurn > 0) {
      const cur = this.plots[this.lastPlot];
      const plot = cur && cur.unlocked && cur.tiles.length ? cur : this.plots.find((p) => p.unlocked && p.tiles.length);
      let drink: { tile: number; d: number } | null = null;
      for (const idx of plot ? plot.tiles : []) {
        const t = this.tiles[idx];
        if (!t.crop || t.wilted || isRipe(t) || t.moist >= THIRSTY || !usable(t)) continue;
        const d = Math.hypot(t.x + 0.5 - f.x, t.z + 0.5 - f.z) + t.moist * 2;
        if (!drink || d < drink.d) drink = { tile: t.i, d };
      }
      if (drink) return { kind: 'water', tile: drink.tile, ok: f.water > 0 };
    }
    // 3. the ground hour, from mid-morning on: the spade and the seed pouch, one turn each. This is the
    // pass that makes the fields visibly expand — out in front of the row sweep, because a fallow tile at
    // the far end of a row would otherwise wait behind a hundred "pick me"s in front of it and the cursor
    // would never come round to it.
    if (this.dayT > DAY_SECONDS * 0.3) {
      const dig = this.tillTurn > 0 ? this.nearestJob('till') : -1;
      const plant = this.nearestJob('sow');
      const seeded = plant >= 0 && f.seeds[this.plotOf(this.tiles[plant]).crop] > 0;
      // Spade and pouch by turns — one tile broken, one tile sown. Any other order runs away with the
      // hour: sow-first leaves a field of bare broken ground (root crops come back to open ground every
      // time they are pulled, so that backlog never clears), and till-first leaves a farmer who only ever
      // seeds the ground he broke a week ago.
      if (this.groundTurn % 2 === 0) {
        if (dig >= 0) return { kind: 'till', tile: dig, ok: true };
        if (seeded) return { kind: 'sow', tile: plant, ok: true };
      } else {
        if (seeded) return { kind: 'sow', tile: plant, ok: true };
        if (dig >= 0) return { kind: 'till', tile: dig, ok: true };
      }
    }
    // 4. the sweep: a plot at a time, so he finishes a field before crossing the village to the next
    // one (and the plot he is on moves on after a pass, or the far fields would never be reached)
    const n = this.plots.length;
    for (let k = 0; k < n; k++) {
      const plot = this.plots[(this.activePlot + k) % n];
      if (!plot.unlocked || !plot.tiles.length) continue;
      const len = plot.tiles.length;
      const from = this.cursor[plot.id] ?? 0;
      for (let step = 0; step < len; step++) {
        const idx = (from + step) % len;
        const t = this.tiles[plot.tiles[idx]];
        const kind = this.jobFor(t);
        if (!kind || !usable(t)) continue;
        // a day's worth of spade work, and a canful of water: past those the row's chores wait for
        // tomorrow. Without the water cap the head of a row is thirsty every morning and the fallow
        // ground at the tail of it never gets broken, which is how a field stops expanding.
        if (kind === 'till' && this.tillTurn <= 0) continue;
        if (kind === 'water' && this.waterTurn <= 0) continue;
        const ok = ready(kind, t);
        // the cursor only moves when he can actually do the job: a tile he has to walk past for want of
        // seed is still the next thing on his list when he gets back from the cart
        if (ok) this.cursor[plot.id] = (idx + 1) % len;
        return { kind, tile: t.i, ok };
      }
    }
    // 5. nothing in the row wants him and the spade is put away: then seed the ground that is already
    // worked, nearest first, so a tile he broke this morning is not left bare until tomorrow's sweep
    const spare = this.nearestJob('sow');
    if (spare >= 0) return { kind: 'sow', tile: spare, ok: f.seeds[this.plotOf(this.tiles[spare]).crop] > 0 };
    return null;
  }

  /** the nearest tile in any open plot that wants this chore, or -1: for work the row is not getting to */
  private nearestJob(kind: JobKind): number {
    const f = this.farmer;
    let best = -1;
    let bd = Infinity;
    for (const t of this.tiles) {
      if (this.jobFor(t) !== kind) continue;
      if (this.time < (f.retry[t.i] ?? 0)) continue;
      const d = Math.hypot(t.x + 0.5 - f.x, t.z + 0.5 - f.z);
      if (d < bd) { bd = d; best = t.i; }
    }
    return best;
  }

  private assign(kind: JobKind, tile: number) {
    const f = this.farmer;
    const t = this.tiles[tile];
    f.job = tile;
    f.jobKind = kind;
    if (kind === 'till') this.tillTurn--;
    else if (kind === 'water') this.waterTurn--;
    if (kind === 'till' || kind === 'sow') this.groundTurn++;
    f.actDur = ACT_DUR[kind];
    f.act = 'walk';
    f.moving = false;
    f.strolling = null;
    f.fetching = false;
    f.stuck = 0;
    f.path = this.pathTo(t.x + 0.5, t.z + 0.5);
    f.wp = 0;
    this.lastPlot = t.plot;
    if (!f.path.length) this.giveUp();
  }

  /** the job turned out to be unreachable: leave it be for a while rather than fume in place */
  private giveUp() {
    const f = this.farmer;
    if (f.job >= 0) f.retry[f.job] = this.time + RETRY_AFTER;
    f.job = -1;
    f.jobKind = null;
    f.path = [];
    f.wp = 0;
    f.act = 'idle';
    f.actDur = 0;
    f.idleT = 0.3;
    f.stuckTries = 0;
  }

  private startFetch() {
    const f = this.farmer;
    const cart = this.plots[this.lastPlot]?.cart ?? this.plots[0]?.cart;
    if (!cart) { this.startRest(); return; }
    f.job = -1;
    f.jobKind = null;
    f.act = 'walk';
    f.fetching = true;
    f.moving = false;
    f.stuck = 0;
    f.stuckTries = 0;
    f.actDur = ACT_DUR.fetch;
    f.path = this.pathTo(cart.x, cart.z);
    f.wp = 0;
    if (!f.path.length) { this.finishFetch(); f.act = 'idle'; f.fetching = false; }
  }

  /** walk the current path; arrive on the tile centre and start the action */
  private walkToJob(dt: number) {
    const f = this.farmer;
    if (f.wp >= f.path.length) {
      f.path = [];
      f.wp = 0;
      f.moving = false;
      f.act = f.jobKind ? f.jobKind : 'fetch';
      f.actT = 0;
      f.actDur = f.jobKind ? ACT_DUR[f.jobKind] : ACT_DUR.fetch;
      f.fetching = false;
      return;
    }
    const goal = f.path[f.wp];
    let dx = goal.x - f.x, dz = goal.z - f.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-4) { f.wp++; return; }
    dx /= d; dz /= d;
    const speed = FARMER_SPEED * (f.basketN > 0 ? 0.88 : 1);
    const step = speed * dt;
    const ox = f.x, oz = f.z;
    f.facing = facingFrom(dx, dz);
    this.terrain.moveBox(f, dx * step, dz * step, FHW, FHH, step);
    const moved = Math.hypot(f.x - ox, f.z - oz);
    f.moving = moved > 1e-4;
    if (moved < step * 0.35) f.stuck += dt; else f.stuck = 0;
    if (Math.hypot(goal.x - f.x, goal.z - f.z) < 0.1) { f.wp++; f.stuckTries = 0; }
    if (f.stuck > 1.2) this.recoverFromStuck();
  }

  /**
   * The farm's verbs. Each is exactly one state change to one tile, and each is what the farmer's
   * action resolves to at the moment the tool lands — so a player (or a test, or tomorrow's co-op
   * partner) working a tile gets the same result and posts the same event as the farmer doing it.
   * Resource bookkeeping stays with the caller: whoever swings the tool pays for the seed and the water.
   */
  tillTile(t: FarmTile, from?: Vec2) {
    if (t.tilled || t.wilted) return;
    t.tilled = true;
    t.moist = Math.max(t.moist, 0.2);
    this.stats.tilled++;
    t.rev = ++this.rev;
    this.emitAt('till', t, null, 0, 0, 0, from);
  }

  /** sow the plot's crop into worked ground: stage 0 — a seed, waiting on water like everything else */
  sowTile(t: FarmTile, crop: CropId, from?: Vec2) {
    if (!t.tilled || t.crop || t.wilted) return;
    t.crop = crop;
    t.stage = 0;
    t.grow = 0;
    t.ripeT = 0;
    t.picks = 0;
    // a seed dropped in dust still has the damp of the clod it came out of
    if (t.moist < 0.25) t.moist = 0.25;
    this.stats.sown++;
    t.rev = ++this.rev;
    this.emitAt('sow', t, crop, 0, 1, 0, from);
  }

  /** a can of water on a tile: the whole of the farmer's day, in one line */
  waterTile(t: FarmTile, from?: Vec2) {
    if (!t.crop || t.wilted) return;
    t.moist = 1;
    this.stats.watered++;
    t.rev = ++this.rev;
    this.emitAt('water', t, t.crop, t.stage, 0, 0, from);
  }

  /**
   * Pick a ripe crop; returns what came off the plant, and where it goes next is the caller's
   * business (a basket, a cart, a player's pack). Regrowers stay in the ground and start again from a
   * younger stage; everything else is pulled out and leaves worked, empty earth.
   */
  harvestTile(t: FarmTile, from?: Vec2): { crop: CropId; n: number; rupees: number } | null {
    const crop = t.crop;
    if (!crop || t.wilted || !isRipe(t)) return null;
    const spec = CROPS[crop];
    const span = spec.yieldMax - spec.yieldMin;
    const n = spec.yieldMin + (span > 0 ? Math.floor(this.rng.next() * (span + 1)) : 0);
    this.stats.harvested += n;
    this.stats.byCrop[crop] += n;
    this.emitAt('harvest', t, crop, t.stage, n, n * spec.sellPrice, from);
    if (spec.regrowTo !== undefined) {
      // the plant stays: cut back to a younger stage, a fresh drink, and keep fruiting
      t.stage = spec.regrowTo;
      t.grow = 0;
      t.ripeT = 0;
      t.picks++;
      t.moist = Math.min(t.moist, 0.5);
    } else {
      t.crop = null;
      t.stage = 0;
      t.grow = 0;
      t.ripeT = 0;
    }
    t.rev = ++this.rev;
    return { crop, n, rupees: n * spec.sellPrice };
  }

  /** clear a crop that was left too long: the ground is usable again, the yield is not */
  clearTile(t: FarmTile, from?: Vec2) {
    if (!t.wilted) return;
    t.wilted = false;
    t.crop = null;
    t.stage = 0;
    t.grow = 0;
    t.ripeT = 0;
    t.picks = 0;
    this.stats.lost++;
    t.rev = ++this.rev;
    this.emitAt('clear', t, null, 0, 0, 0, from);
  }

  /** what a tile is waiting for, or null when it wants nothing — the job list the farmer reads */
  jobFor(t: FarmTile): JobKind | null {
    if (!this.plots[t.plot].unlocked) return null;
    if (t.wilted) return 'clear';
    if (t.crop) return isRipe(t) ? 'harvest' : t.moist < THIRSTY ? 'water' : null;
    return t.tilled ? 'sow' : 'till';
  }

  /**
   * Boxed in — by the player, a hedge, a crate of seeds. Shuffle aside and re-path from wherever he got
   * to, so a body in the way costs a step rather than his day. Twice round the block and he abandons the
   * tile; a cart trip he cannot finish is worse than that (he would walk into the same crate until the
   * world ended, and the whole village simulation would stop behind him), so a failed errand is treated
   * as done where he stands: the boy takes the basket, he fills the can, nobody minds.
   */
  private recoverFromStuck() {
    const f = this.farmer;
    f.stuck = 0;
    f.stuckTries++;
    const a = this.rng.next() * Math.PI * 2;
    this.terrain.moveBox(f, Math.cos(a) * 0.5, Math.sin(a) * 0.5, FHW, FHH, 0.1);
    if (f.stuckTries < 2) {
      const cart = this.plots[this.lastPlot]?.cart ?? this.plots[0]?.cart ?? null;
      const goal = f.job >= 0 && this.tiles[f.job]
        ? { x: this.tiles[f.job].x + 0.5, z: this.tiles[f.job].z + 0.5 }
        : cart;
      if (goal) {
        f.path = this.pathTo(goal.x, goal.z);
        f.wp = 0;
        if (f.path.length) return;
      }
    }
    f.stuckTries = 0;
    if (f.job < 0 && f.fetching) {
      this.finishFetch();
      f.act = 'idle';
      f.actT = 0;
      f.actDur = 0;
      f.fetching = false;
      f.path = [];
      f.wp = 0;
      return;
    }
    this.giveUp();
  }

  /** the moment the tool comes down: the farmer's action spends his pack and calls the verb */
  private toolLands() {
    const f = this.farmer;
    if (f.job < 0) return;
    const t = this.tiles[f.job];
    const at = { x: f.x, z: f.z };
    switch (f.jobKind) {
      case 'water':
        this.waterTile(t, at);
        f.water = Math.max(0, f.water - 1);
        break;
      case 'sow': {
        const crop = this.plotOf(t).crop;
        if (!t.crop && t.tilled && f.seeds[crop] > 0) {
          f.seeds[crop] = Math.max(0, f.seeds[crop] - 1);
          this.sowTile(t, crop, at);
        }
        break;
      }
      case 'harvest': {
        const got = this.harvestTile(t, at);
        if (got) {
          f.basket[got.crop] += got.n;
          f.basketN += got.n;
        }
        break;
      }
      case 'till': this.tillTile(t, at); break;
      case 'clear': this.clearTile(t, at); break;
    }
  }

  /** the beat after an action: a breather, and a proper rest once he has done a stretch of jobs */
  private finishJob() {
    const f = this.farmer;
    if (f.job < 0) return;
    this.lastPlot = this.tiles[f.job].plot;
    this.jobsDone++;
    f.idleT = 0.06 + this.rng.next() * 0.2;
    // a field at a time: after a pass he moves on to the next plot, so nothing waits behind a busy row
    this.plotJobs++;
    if (this.plotJobs >= PLOT_PASS) {
      this.plotJobs = 0;
      this.activePlot = (this.activePlot + 1) % Math.max(1, this.plots.length);
    }
    if (this.jobsDone % JOBS_PER_REST === 0) {
      f.idleT += 0.8 + this.rng.next() * 1.2;
      this.needsRest = true;
    }
  }

  /** the cart: fill the can, top up the seed pack, leave the produce for the village */
  private finishFetch() {
    const f = this.farmer;
    f.water = WATER_CAN;
    for (const id of CROP_IDS) f.seeds[id] = Math.max(f.seeds[id], SEED_PACK);
    if (f.basketN > 0) {
      let rupees = 0;
      for (const id of CROP_IDS) rupees += f.basket[id] * CROPS[id].sellPrice;
      f.basket = emptyByCrop();
      const n = f.basketN;
      f.basketN = 0;
      this.stats.gold += rupees;
      this.emit('deliver', f.x, f.z, null, 0, n, rupees, { x: f.x, z: f.z });
    }
    f.idleT = 0.4 + this.rng.next() * 0.8;
  }

  // ---------------------------------------------------------------- pathfinding
  /**
   * Bounded BFS over the walkable tile graph from the farmer's tile to the target, returning the tile
   * centres to walk with collinear runs compressed. The village is small and the search only runs when
   * a job is picked, so it is cheap; if a job is further than the radius the farmer walks toward it and
   * re-searches from wherever he got to (see `assign` — a failed search is what sets a retry, so he
   * never ends up walking into a wall forever).
   */
  private pathTo(tx: number, tz: number): Vec2[] {
    const f = this.farmer;
    const sx = Math.floor(f.x), sz = Math.floor(f.z);
    const gx = Math.floor(tx), gz = Math.floor(tz);
    if (sx === gx && sz === gz) return [{ x: tx, z: tz }];
    const R = 18;
    const w = R * 2 + 1;
    const prev = new Int32Array(w * w).fill(-2); // -2 unvisited, -1 = start
    const at = (x: number, z: number) => (z - (sz - R)) * w + (x - (sx - R));
    const free = (x: number, z: number) => {
      if (x < sx - R || x > sx + R || z < sz - R || z > sz + R) return false;
      if (x === gx && z === gz) return true; // the goal is always enterable: it is farm ground
      return !this.terrain.isSolidTile(x, z);
    };
    const start = at(sx, sz);
    prev[start] = -1;
    const queue = [start];
    let found = false;
    for (let head = 0; head < queue.length && !found; head++) {
      const c = queue[head];
      const cx = (c % w) + sx - R, cz = Math.floor(c / w) + sz - R;
      for (const [ox, oz] of DIRS) {
        const nx = cx + ox, nz = cz + oz;
        if (!free(nx, nz)) continue;
        // A diagonal is only a shortcut if he can actually fit through it: cutting the corner between two
        // solid tiles puts him nose-first into a box he cannot slide out of (see `recoverFromStuck`).
        if (ox !== 0 && oz !== 0 && (!free(cx + ox, cz) || !free(cx, cz + oz))) continue;
        const ni = at(nx, nz);
        if (prev[ni] !== -2) continue;
        prev[ni] = c;
        if (nx === gx && nz === gz) { found = true; break; }
        queue.push(ni);
      }
    }
    if (!found) return [];
    const path: Vec2[] = [];
    let c = at(gx, gz);
    while (c !== start) {
      const x = (c % w) + sx - R, z = Math.floor(c / w) + sz - R;
      path.push({ x: x + 0.5, z: z + 0.5 });
      c = prev[c];
      if (c === -1) return [];
    }
    path.reverse();
    if (Math.hypot(path[path.length - 1].x - tx, path[path.length - 1].z - tz) > 0.05) path.push({ x: tx, z: tz });
    return compress(path);
  }

  // ---------------------------------------------------------------- lifecycle
  /** a fresh morning: the fields back to the state the village was founded in, the farmer at his cart */
  reset() {
    this.time = 0;
    this.day = 1;
    this.dayT = 0;
    this.events = [];
    this.tillTurn = TILL_PER_DAY;
    this.waterTurn = WATER_PER_DAY;
    this.groundTurn = 0;
    this.lastPlot = 0;
    this.activePlot = 0;
    this.plotJobs = 0;
    this.cursor = {};
    this.jobsDone = 0;
    this.needsRest = false;
    this.rev = 0;
    this.rng = new RNG(this.seed);
    this.stats = {
      days: 1, tilled: 0, sown: 0, watered: 0, harvested: 0, lost: 0, gold: 0, byCrop: emptyByCrop(),
    };
    this.buildPlots();
    this.farmer = this.newFarmer();
  }

  /** plain-data snapshot — the payload shape that will one day cross a worker boundary */
  snapshot(): { day: number; dayT: number; time: number; stats: VillageStats; farmer: Farmer; tiles: FarmTile[] } {
    return { day: this.day, dayT: this.dayT, time: this.time, stats: this.stats, farmer: this.farmer, tiles: this.tiles };
  }
}

/**
 * A plot as the village builds it: the world's spec, its `cart` resolved to a world position, and the
 * farm tiles that came out of its rect.
 */
export interface FarmPlot extends Omit<FarmPlotSeed, 'cart'> {
  /** the cart stand in world units (the spec's tile tuple, resolved onto free ground) */
  cart: Vec2;
  /** indices into `VillageState.tiles`, in work order */
  tiles: number[];
  /** a locked plot starts false; the shopkeeper's seed sack turns it true */
  unlocked: boolean;
}

interface FarmTileSeed { x: number; z: number }

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;

/** drop waypoints that only continue the current heading, so the farmer walks lines, not a tile ladder */
function compress(path: Vec2[]): Vec2[] {
  if (path.length < 3) return path;
  const out: Vec2[] = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const a = out[out.length - 1], b = path[i], c = path[i + 1];
    if (Math.sign(b.x - a.x) !== Math.sign(c.x - b.x) || Math.sign(b.z - a.z) !== Math.sign(c.z - b.z)) out.push(b);
  }
  out.push(path[path.length - 1]);
  return out;
}
