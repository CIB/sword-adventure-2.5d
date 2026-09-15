import { Enemy, type GameCtx } from './entities';
import { Tile } from './constants';
import type { Vec2 } from './world';

/**
 * Wildlife: the creatures that live in the green parts of the world, as opposed to the soldiers who
 * hold it.
 *
 * A ladybug belongs to nobody. There is no guard post behind it, no patch it is tied to, and
 * nobody marching in from the map's edge to take the place of one that dies — it is simply *common
 * in lush country* (see World.lushness). So the game keeps a population of them alive in the green
 * ground around the player instead: while the player is standing somewhere verdant it seeds a new
 * beetle out of sight every few seconds until the neighbourhood is properly busy with them, and the
 * ones that wander off the active region are quietly released again. That is the same
 * materialise/release idea the world sim uses for its guards (see game.ts: updateWorld), just with
 * the population counted around the player rather than written down in world state.
 *
 * Only the green places stock them. In the moor, the marsh, the mesa or the highland steppe the
 * spawner simply finds nowhere it is willing to put a ladybug, so you will not meet one there.
 *
 * The oversized queen is the exception to the crowd: the same beetle at the size the model was first
 * drawn, one at a time, and only now and then after the player has been walking green country for a
 * while. She is the special encounter; the six little ones scuttling around the meadow are the norm.
 *
 * The spitflower is the woods' answer to the ladybug: a big blossom on a long stalk, rooted where
 * it sprouts, turning its head to spit energy balls at passers-by. It keeps its own, smaller
 * population beside the beetles — same lush-country rule, but only under the trees (mossy forest
 * floor, or a clearing with trunks in sight), so the open meadow stays beetle country and the deep
 * green woods grow teeth.
 */

/** how many ladybugs the active region keeps busy while the ground is green */
const TARGET = 6;
/** ...and how many spitflowers the green woods around it hold (a separate population) */
const FLOWER_TARGET = 3;
/** seconds between attempts to seed one more (only attempted while the population is short) */
const RETRY = 2.2;
/** how lush the ground has to be for a ladybug to want it: meadow, pond shore, woods, farmland */
const LUSH_MIN = 0.6;
/** nobody should see one appear: the spawn ring sits this far outside the view, out to this far */
const SPAWN_IN = 2, SPAWN_OUT = 12;
/** a bug that wanders this far past the active region is released (it has its own life to lead) */
const LEAVE = 10;
/** the closest a new bug may be dropped to another one, in tiles */
const SPACING = 5;
/** how far a spitflower looks for trunks before it calls a spot "woods", in tiles */
const WOODS_R = 4;
/** the queen: a fresh world waits this long before the big one may settle in (seconds of play) */
const QUEEN_FIRST = 55;
/** ...then this long between queens, plus a random stretch of up to QUEEN_SPREAD, so it never feels scheduled */
const QUEEN_GAP = 90, QUEEN_SPREAD = 90;
/** somewhere green is not always available the moment her turn comes up: look again this much later */
const QUEEN_RETRY = 8;

export class Wildlife {
  /** the ladybugs this system keeps track of (they also live in game.enemies while they're alive) */
  bugs: Enemy[] = [];
  /** the spitflowers, likewise (rooted, so they never wander — they only ever get released) */
  flowers: Enemy[] = [];
  private retryT = RETRY;
  private flowerRetryT = RETRY * 1.5;
  /** seconds until the queen's next turn (queens are not part of the crowd, so they get their own clock) */
  private queenT = QUEEN_FIRST;

  constructor(private game: GameCtx) {}

  /**
   * `viewR` is the radius of the active region around the player (the same one the world system
   * materialises its soldiers inside): new bugs appear outside it and old ones are released once
   * they've wandered well past it.
   */
  update(dt: number, viewR: number) {
    this.bugs = this.bugs.filter((b) => b.alive); // sword blows are the game's business (onEnemyDied)
    this.flowers = this.flowers.filter((f) => f.alive);
    const p = this.game.player.pos;
    // 1. let the ones that have wandered off the active region go
    for (const b of this.bugs) if (Math.hypot(b.pos.x - p.x, b.pos.z - p.z) > viewR + LEAVE) b.dispose();
    for (const f of this.flowers) if (Math.hypot(f.pos.x - p.x, f.pos.z - p.z) > viewR + LEAVE) f.dispose();
    this.bugs = this.bugs.filter((b) => b.alive);
    this.flowers = this.flowers.filter((f) => f.alive);
    // 2. the queen, if her turn has come up and the country is green enough to hold her
    this.queenTick(dt, p.x, p.z, viewR);
    // 3. seed another every few seconds, while the country around the player is green and there is room
    if (this.retryT > 0) { this.retryT -= dt; } else {
      this.retryT = RETRY;
      if (this.bugs.length < TARGET) {
        const spot = this.findSpot(p.x, p.z, Math.max(14, viewR - SPAWN_IN), viewR + SPAWN_OUT);
        if (spot) {
          const bug = new Enemy(this.game, 'ladybug', spot.x, spot.z);
          this.game.enemies.push(bug);
          this.bugs.push(bug);
        }
      }
    }
    // 4. ...and a flower now and then, where the green country runs to woods
    if (this.flowerRetryT > 0) { this.flowerRetryT -= dt; return; }
    this.flowerRetryT = RETRY * 1.5;
    if (this.flowers.length >= FLOWER_TARGET) return;
    const spot = this.findSpot(p.x, p.z, Math.max(14, viewR - SPAWN_IN), viewR + SPAWN_OUT, true);
    if (!spot) return;
    const flower = new Enemy(this.game, 'spitflower', spot.x, spot.z);
    this.game.enemies.push(flower);
    this.flowers.push(flower);
  }

  /** a fresh run is a fresh world: drop the population and let the country restock itself */
  reset() {
    this.bugs = [];
    this.flowers = [];
    this.retryT = RETRY;
    this.flowerRetryT = RETRY * 1.5;
    this.queenT = QUEEN_FIRST;
  }

  /**
   * The queen's own, much slower clock. Nothing here seeds a beetle while one of her is already out
   * there — the commons are the population, she is an event — and if the countryside around the
   * player is all road or moor this minute, the spawner simply takes her turn again shortly.
   */
  private queenTick(dt: number, px: number, pz: number, viewR: number) {
    if (this.queenT > 0) { this.queenT -= dt; return; }
    if (this.bugs.some((b) => b.kind === 'ladybug_queen')) { this.queenT = QUEEN_GAP; return; }
    const spot = this.findSpot(px, pz, Math.max(14, viewR - SPAWN_IN), viewR + SPAWN_OUT);
    if (!spot) { this.queenT = QUEEN_RETRY; return; }
    // she is one beetle's worth of the six: if the commons are at capacity, the farthest one
    // quietly leaves as she settles in, so her arrival never grows the crowd past its usual size
    if (this.bugs.length >= TARGET) {
      let far: Enemy | null = null, farD = -1;
      for (const b of this.bugs) {
        if (b.kind === 'ladybug_queen') continue;
        const d = Math.hypot(b.pos.x - px, b.pos.z - pz);
        if (d > farD) { farD = d; far = b; }
      }
      far?.dispose();
      this.bugs = this.bugs.filter((b) => b.alive);
    }
    const queen = new Enemy(this.game, 'ladybug_queen', spot.x, spot.z);
    this.game.enemies.push(queen);
    this.bugs.push(queen);
    this.queenT = QUEEN_GAP + this.game.rand() * QUEEN_SPREAD;
  }

  /** the best of a handful of tries at a clear, lush, out-of-sight tile to put a bug on */
  private findSpot(px: number, pz: number, r0: number, r1: number, woods = false): Vec2 | null {
    const w = this.game.world;
    const v = w.village;
    let best: Vec2 | null = null, bestScore = -1;
    for (let i = 0; i < 12; i++) {
      const a = this.game.rand() * Math.PI * 2;
      const r = r0 + this.game.rand() * (r1 - r0);
      const x = px + Math.cos(a) * r, z = pz + Math.sin(a) * r;
      const tx = Math.floor(x), tz = Math.floor(z);
      if (tx < 2 || tz < 2 || tx >= w.w - 2 || tz >= w.h - 2) continue;
      if (w.isSolidTile(tx, tz) || w.tile(tx, tz) === Tile.Water) continue;
      // the village is a safe haven, and a beetle crawling out of Marin's flower bed would be odd anyway
      if (tx > v.x0 - 3 && tx < v.x1 + 3 && tz > v.z0 - 3 && tz < v.z1 + 3) continue;
      const lush = w.lushness(x, z);
      if (lush < LUSH_MIN) continue;
      // flowers only take root under the trees: mossy forest floor, or a clearing with trunks in sight
      if (woods && w.tile(tx, tz) !== Tile.ForestFloor && !this.nearTrees(tx, tz)) continue;
      if (this.crowded(tx + 0.5, tz + 0.5)) continue;
      const score = lush + this.game.rand() * 0.15;
      if (score > bestScore) { bestScore = score; best = { x: tx + 0.5, z: tz + 0.5 }; }
    }
    return best;
  }

  /** is there a trunk within WOODS_R tiles of this spot? */
  private nearTrees(tx: number, tz: number): boolean {
    const w = this.game.world;
    for (let dz = -WOODS_R; dz <= WOODS_R; dz++) for (let dx = -WOODS_R; dx <= WOODS_R; dx++) {
      const nx = tx + dx, nz = tz + dz;
      if (nx < 0 || nz < 0 || nx >= w.w || nz >= w.h) continue;
      if (w.treeCell[nz * w.w + nx]) return true;
    }
    return false;
  }

  /** is there already a bug (or the player) closer than one beetle's patience? */
  private crowded(x: number, z: number): boolean {
    const p = this.game.player.pos;
    if (Math.hypot(p.x - x, p.z - z) < SPACING) return true;
    for (const b of this.bugs) if (Math.hypot(b.pos.x - x, b.pos.z - z) < SPACING) return true;
    for (const f of this.flowers) if (Math.hypot(f.pos.x - x, f.pos.z - z) < SPACING) return true;
    return false;
  }
}
