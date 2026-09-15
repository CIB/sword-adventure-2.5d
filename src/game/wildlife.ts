import { Enemy, type GameCtx } from './entities';
import { Tile } from './constants';
import type { Vec2, EnemyKind } from './world';

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
 * The spitflowers are the woods' own: the same idea (a population kept up around the player, seeded
 * out of sight and released once left behind) but they only grow where the ground is proper forest
 * floor under the trees — never in the open meadow — and, being rooted, they are put down a little
 * farther apart so the wood is a gauntlet of them rather than a hedge.
 */

/** how many ladybugs the active region keeps busy while the ground is green */
const TARGET = 6;
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
/** the queen: a fresh world waits this long before the big one may settle in (seconds of play) */
const QUEEN_FIRST = 55;
/** ...then this long between queens, plus a random stretch of up to QUEEN_SPREAD, so it never feels scheduled */
const QUEEN_GAP = 90, QUEEN_SPREAD = 90;
/** somewhere green is not always available the moment her turn comes up: look again this much later */
const QUEEN_RETRY = 8;
/** how many spitflowers the woods around the player keep rooted */
const FLOWER_TARGET = 4;
/** seconds between attempts to grow one more */
const FLOWER_RETRY = 3;
/** a flower wants forest floor: ground this lush, and under the trees (see World.forested) */
const FLOWER_LUSH_MIN = 0.7;
/** rooted things keep more distance from each other than beetles do */
const FLOWER_SPACING = 7;

export class Wildlife {
  /** the ladybugs this system keeps track of (they also live in game.enemies while they're alive) */
  bugs: Enemy[] = [];
  private retryT = RETRY;
  /** seconds until the queen's next turn (queens are not part of the crowd, so they get their own clock) */
  private queenT = QUEEN_FIRST;
  /** the spitflowers rooted in the woods around the player (they also live in game.enemies) */
  flowers: Enemy[] = [];
  private flowerT = FLOWER_RETRY * 0.5;

  constructor(private game: GameCtx) {}

  /**
   * `viewR` is the radius of the active region around the player (the same one the world system
   * materialises its soldiers inside): new bugs appear outside it and old ones are released once
   * they've wandered well past it.
   */
  update(dt: number, viewR: number) {
    this.bugs = this.bugs.filter((b) => b.alive); // sword blows are the game's business (onEnemyDied)
    const p = this.game.player.pos;
    // 1. let the ones that have wandered off the active region go
    for (const b of this.bugs) if (Math.hypot(b.pos.x - p.x, b.pos.z - p.z) > viewR + LEAVE) b.dispose();
    this.bugs = this.bugs.filter((b) => b.alive);
    this.flowers = this.flowers.filter((f) => f.alive);
    for (const f of this.flowers) if (Math.hypot(f.pos.x - p.x, f.pos.z - p.z) > viewR + LEAVE) f.dispose();
    this.flowers = this.flowers.filter((f) => f.alive);
    // 2. the queen, if her turn has come up and the country is green enough to hold her
    this.queenTick(dt, p.x, p.z, viewR);
    // 2b. the woods grow their spitflowers
    this.flowerTick(dt, p.x, p.z, viewR);
    // 3. seed another every few seconds, while the country around the player is green and there is room
    if (this.retryT > 0) { this.retryT -= dt; return; }
    this.retryT = RETRY;
    if (this.bugs.length >= TARGET) return;
    const spot = this.findSpot(p.x, p.z, Math.max(14, viewR - SPAWN_IN), viewR + SPAWN_OUT, 'ladybug');
    if (!spot) return;
    const bug = new Enemy(this.game, 'ladybug', spot.x, spot.z);
    this.game.enemies.push(bug);
    this.bugs.push(bug);
  }

  /** a fresh run is a fresh world: drop the population and let the country restock itself */
  reset() {
    this.bugs = [];
    this.flowers = [];
    this.retryT = RETRY;
    this.queenT = QUEEN_FIRST;
    this.flowerT = FLOWER_RETRY * 0.5;
  }

  /**
   * The spitflowers' clock: while the player is somewhere with real woods around, put one more down
   * every few seconds until the wood has its share. Out on the meadow findSpot simply never finds a
   * forest-floor tile, so no flower grows there — a wood is where you meet them.
   */
  private flowerTick(dt: number, px: number, pz: number, viewR: number) {
    if (this.flowerT > 0) { this.flowerT -= dt; return; }
    this.flowerT = FLOWER_RETRY;
    if (this.flowers.length >= FLOWER_TARGET) return;
    const spot = this.findSpot(px, pz, Math.max(14, viewR - SPAWN_IN), viewR + SPAWN_OUT, 'spitflower');
    if (!spot) return;
    const flower = new Enemy(this.game, 'spitflower', spot.x, spot.z);
    this.game.enemies.push(flower);
    this.flowers.push(flower);
  }

  /**
   * The queen's own, much slower clock. Nothing here seeds a beetle while one of her is already out
   * there — the commons are the population, she is an event — and if the countryside around the
   * player is all road or moor this minute, the spawner simply takes her turn again shortly.
   */
  private queenTick(dt: number, px: number, pz: number, viewR: number) {
    if (this.queenT > 0) { this.queenT -= dt; return; }
    if (this.bugs.some((b) => b.kind === 'ladybug_queen')) { this.queenT = QUEEN_GAP; return; }
    // she is one beetle's worth of the population, not an extra on top of it: if the meadow is full
    // she takes the place of the farthest common — one out past the edge of the screen (viewR is the
    // view plus a margin, see game.ts), so nobody sees it go
    if (this.bugs.length >= TARGET) {
      let far: Enemy | null = null, farD = viewR - 8;
      for (const b of this.bugs) {
        const d = Math.hypot(b.pos.x - px, b.pos.z - pz);
        if (b.kind === 'ladybug' && d > farD) { far = b; farD = d; }
      }
      if (!far) { this.queenT = QUEEN_RETRY; return; }
      far.dispose();
      this.bugs = this.bugs.filter((b) => b.alive);
      this.queenT = 0.2; // room made: she settles in on the next tick
      return;
    }
    const spot = this.findSpot(px, pz, Math.max(14, viewR - SPAWN_IN), viewR + SPAWN_OUT);
    if (!spot) { this.queenT = QUEEN_RETRY; return; }
    const queen = new Enemy(this.game, 'ladybug_queen', spot.x, spot.z);
    this.game.enemies.push(queen);
    this.bugs.push(queen);
    this.queenT = QUEEN_GAP + this.game.rand() * QUEEN_SPREAD;
  }

  /**
   * The best of a handful of tries at a clear, lush, out-of-sight tile to put a creature on. A
   * spitflower is pickier than a beetle: it will only take forest floor under the trees.
   */
  private findSpot(px: number, pz: number, r0: number, r1: number, kind: EnemyKind = 'ladybug'): Vec2 | null {
    const w = this.game.world;
    const v = w.village;
    const flower = kind === 'spitflower';
    let best: Vec2 | null = null, bestScore = -1;
    for (let i = 0; i < (flower ? 20 : 12); i++) {
      const a = this.game.rand() * Math.PI * 2;
      const r = r0 + this.game.rand() * (r1 - r0);
      const x = px + Math.cos(a) * r, z = pz + Math.sin(a) * r;
      const tx = Math.floor(x), tz = Math.floor(z);
      if (tx < 2 || tz < 2 || tx >= w.w - 2 || tz >= w.h - 2) continue;
      // snapping to the tile centre can pull a spot on the inner edge of the ring back into view
      if (Math.hypot(tx + 0.5 - px, tz + 0.5 - pz) < r0) continue;
      if (w.isSolidTile(tx, tz) || w.tile(tx, tz) === Tile.Water) continue;
      // the village is a safe haven, and a beetle crawling out of Marin's flower bed would be odd anyway
      if (tx > v.x0 - 3 && tx < v.x1 + 3 && tz > v.z0 - 3 && tz < v.z1 + 3) continue;
      const lush = w.lushness(x, z);
      if (lush < (flower ? FLOWER_LUSH_MIN : LUSH_MIN)) continue;
      if (flower && !w.forested(tx, tz)) continue;
      if (this.crowded(tx + 0.5, tz + 0.5, flower ? FLOWER_SPACING : SPACING)) continue;
      const score = lush + this.game.rand() * 0.15;
      if (score > bestScore) { bestScore = score; best = { x: tx + 0.5, z: tz + 0.5 }; }
    }
    return best;
  }

  /** is there already a creature (or the player) closer than `spacing` tiles? */
  private crowded(x: number, z: number, spacing = SPACING): boolean {
    const p = this.game.player.pos;
    if (Math.hypot(p.x - x, p.z - z) < spacing) return true;
    for (const b of this.bugs) if (Math.hypot(b.pos.x - x, b.pos.z - z) < spacing) return true;
    for (const f of this.flowers) if (Math.hypot(f.pos.x - x, f.pos.z - z) < spacing) return true;
    return false;
  }
}
