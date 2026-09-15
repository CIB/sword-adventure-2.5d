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
 * The other thing that lives out here is not an animal at all: the spitflower (see models.ts) grows
 * in the woods, rooted to the spot it comes up on, and counts on the same rules the beetles do — a
 * much smaller population, planted closer in, because a flower cannot come looking for the player.
 * It wants the deep woods rather than merely green country: plenty of trunks standing round it, and
 * enough open ground at the foot for her to walk up and cut it down.
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

// ---- the spitflowers ------------------------------------------------------
/** how many spitflowers stand in the woods around the player at once (rooted, so they are a few) */
const FLOWER_TARGET = 4;
/** seconds between attempts to plant one more */
const FLOWER_RETRY = 2.6;
/**
 * A flower is planted *close*, just past the view, rather than out where the beetles are seeded: it
 * cannot wander towards the player, so the only way she is ever going to meet one is if it comes up
 * in the country she is about to walk into.
 */
const FLOWER_RING_IN = 6, FLOWER_RING_OUT = 2;
/** how lush the ground has to be for a flower to take root in it (the woods are as green as it gets) */
const FLOWER_LUSH_MIN = 0.6;
/** what makes it the deep woods: this many tree tiles standing within this many tiles of the spot */
const WOOD_R = 4, WOOD_MIN = 5;
/** ...and what it takes for the player to count as standing in the woods at all, for the spawner to bother */
const WOOD_STANDING = 2;
/** the closest two flowers may stand, in tiles (and how far they keep from the beetles) */
const FLOWER_SPACING = 9;
/** the queen: a fresh world waits this long before the big one may settle in (seconds of play) */
const QUEEN_FIRST = 55;
/** ...then this long between queens, plus a random stretch of up to QUEEN_SPREAD, so it never feels scheduled */
const QUEEN_GAP = 90, QUEEN_SPREAD = 90;
/** somewhere green is not always available the moment her turn comes up: look again this much later */
const QUEEN_RETRY = 8;

export class Wildlife {
  /** the ladybugs this system keeps track of (they also live in game.enemies while they're alive) */
  bugs: Enemy[] = [];
  /** the spitflowers standing in the woods around the player (rooted: they stay where they were planted) */
  flowers: Enemy[] = [];
  private retryT = RETRY;
  private flowerT = FLOWER_RETRY;
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
    this.bugs = this.bugs.filter((b) => b.alive);
    // ...and the flowers she has left behind. A flower cannot follow her anywhere, and it is not
    // written down in world state either: it is a plant of the woods she is in, so the woods she walks
    // into grow their own (out of sight, like the beetles)
    for (const f of this.flowers) if (Math.hypot(f.pos.x - p.x, f.pos.z - p.z) > viewR + LEAVE) f.dispose();
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
    // 4. ...and a flower in the woods she is walking towards, while the woods are short of them
    this.flowerTick(dt, p.x, p.z, viewR);
  }

  /** a fresh run is a fresh world: drop the population and let the country restock itself */
  reset() {
    this.bugs = [];
    this.flowers = [];
    this.retryT = RETRY;
    this.flowerT = FLOWER_RETRY;
    this.queenT = QUEEN_FIRST;
  }

  /**
   * The spitflowers: the same seed-out-of-sight idea as the beetles, with two differences that both
   * come of the plant being rooted. They are planted just past the view instead of out at the edge of
   * the region (a flower that came up behind the player would never be met), and they are rare —
   * four of them standing in the woods at once is a wood worth walking through carefully, and the
   * spacing between them is wide enough that they never become a wall of fire.
   */
  private flowerTick(dt: number, px: number, pz: number, viewR: number) {
    if (this.flowerT > 0) { this.flowerT -= dt; return; }
    this.flowerT = FLOWER_RETRY;
    if (this.flowers.length >= FLOWER_TARGET) return;
    // ...and only while she is standing among trees at all. A flower planted from out in the open
    // meadow would have to be put down in the open meadow to be of any use to anybody, and this is
    // also what keeps the beetles' own spawning (and its dice) exactly as it was.
    if (this.treesAround(Math.floor(px), Math.floor(pz)) < WOOD_STANDING) return;
    const spot = this.findFlowerSpot(px, pz, Math.max(12, viewR - FLOWER_RING_IN), viewR + FLOWER_RING_OUT);
    if (!spot) return;
    const flower = new Enemy(this.game, 'spitter', spot.x, spot.z);
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
    const spot = this.findSpot(px, pz, Math.max(14, viewR - SPAWN_IN), viewR + SPAWN_OUT);
    if (!spot) { this.queenT = QUEEN_RETRY; return; }
    const queen = new Enemy(this.game, 'ladybug_queen', spot.x, spot.z);
    this.game.enemies.push(queen);
    this.bugs.push(queen);
    this.queenT = QUEEN_GAP + this.game.rand() * QUEEN_SPREAD;
  }

  /** the best of a handful of tries at a clear, lush, out-of-sight tile to put a bug on */
  private findSpot(px: number, pz: number, r0: number, r1: number): Vec2 | null {
    let best: Vec2 | null = null, bestScore = -1;
    for (let i = 0; i < 12; i++) {
      const spot = this.trySpot(px, pz, r0, r1);
      if (!spot || spot.lush < LUSH_MIN) continue;
      if (this.crowded(spot.x, spot.z, SPACING)) continue;
      const score = spot.lush + this.game.rand() * 0.15;
      if (score > bestScore) { bestScore = score; best = { x: spot.x, z: spot.z }; }
    }
    return best;
  }

  /**
   * The best of a handful of tries at a patch of deep woods to take a spitflower root in: green
   * ground, trunks standing round about it, and enough clear ground at the foot of it that the
   * heroine can walk up and cut it down. A flower walled in by trunks would be an enemy she could
   * neither reach nor be blamed for being shot by, so that last part matters as much as the first.
   */
  private findFlowerSpot(px: number, pz: number, r0: number, r1: number): Vec2 | null {
    let best: Vec2 | null = null, bestScore = -1;
    for (let i = 0; i < 12; i++) {
      const spot = this.trySpot(px, pz, r0, r1);
      if (!spot || spot.lush < FLOWER_LUSH_MIN) continue;
      const tx = Math.floor(spot.x), tz = Math.floor(spot.z);
      const trees = this.treesAround(tx, tz);
      if (trees < WOOD_MIN) continue;
      if (!this.openFoot(tx, tz)) continue;
      if (this.crowded(spot.x, spot.z, FLOWER_SPACING)) continue;
      // the deeper into the wood, the likelier — but with a jitter, so the deepest spot on offer does
      // not simply get every flower the player ever meets
      const score = Math.min(1, trees / 20) * 0.6 + spot.lush * 0.35 + this.game.rand() * 0.2;
      if (score > bestScore) { bestScore = score; best = { x: spot.x, z: spot.z }; }
    }
    return best;
  }

  /**
   * One roll of the dice: a point out in the ring, and the tile it landed on if that tile is open
   * ground, not the village's back yard, and not under the nose of something already there.
   * Everything a creature might live on is tested by the caller — this is only what both of them
   * insist on. The lushness is read at the exact point the dice landed rather than at the centre of
   * the tile it fell in: it is the one field of the map measured at a spot (see World.lushness), and
   * which side of a meadow's edge the roll came down on is exactly what decides a beetle's spot.
   */
  private trySpot(px: number, pz: number, r0: number, r1: number): { x: number; z: number; lush: number } | null {
    const w = this.game.world;
    const v = w.village;
    const a = this.game.rand() * Math.PI * 2;
    const r = r0 + this.game.rand() * (r1 - r0);
    const x = px + Math.cos(a) * r, z = pz + Math.sin(a) * r;
    const tx = Math.floor(x), tz = Math.floor(z);
    if (tx < 2 || tz < 2 || tx >= w.w - 2 || tz >= w.h - 2) return null;
    if (w.isSolidTile(tx, tz) || w.tile(tx, tz) === Tile.Water) return null;
    // the village is a safe haven, and a beetle crawling out of Marin's flower bed would be odd anyway
    if (tx > v.x0 - 3 && tx < v.x1 + 3 && tz > v.z0 - 3 && tz < v.z1 + 3) return null;
    return { x: tx + 0.5, z: tz + 0.5, lush: w.lushness(x, z) };
  }

  /** how many of the woods' trees stand within WOOD_R tiles of a spot: the flower's measure of cover */
  private treesAround(tx: number, tz: number): number {
    const w = this.game.world;
    let n = 0;
    for (let dz = -WOOD_R; dz <= WOOD_R; dz++) for (let dx = -WOOD_R; dx <= WOOD_R; dx++) {
      const x = tx + dx, z = tz + dz;
      if (x < 0 || z < 0 || x >= w.w || z >= w.h) continue;
      n += w.treeCell[z * w.w + x];
    }
    return n;
  }

  /** open ground (or at least a way in) at the foot of a spot: nothing solid on any of its four sides */
  private openFoot(tx: number, tz: number): boolean {
    const w = this.game.world;
    return !w.isSolidTile(tx + 1, tz) && !w.isSolidTile(tx - 1, tz) && !w.isSolidTile(tx, tz + 1) && !w.isSolidTile(tx, tz - 1);
  }

  /** is there already a creature (or the player) closer than one of these has patience for? */
  private crowded(x: number, z: number, spacing: number): boolean {
    const p = this.game.player.pos;
    if (Math.hypot(p.x - x, p.z - z) < spacing) return true;
    for (const b of this.bugs) if (Math.hypot(b.pos.x - x, b.pos.z - z) < spacing) return true;
    for (const f of this.flowers) if (Math.hypot(f.pos.x - x, f.pos.z - z) < spacing) return true;
    return false;
  }
}
