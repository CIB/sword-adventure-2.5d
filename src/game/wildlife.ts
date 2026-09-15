import { Enemy, type GameCtx } from './entities';
import { Tile } from './constants';
import type { Vec2 } from './world';

/**
 * Wildlife: the creatures that live in the green parts of the world, as opposed to the soldiers who
 * hold it.
 *
 * A giant ladybug belongs to nobody. There is no guard post behind it, no patch it is tied to, and
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

export class Wildlife {
  /** the ladybugs this system keeps track of (they also live in game.enemies while they're alive) */
  bugs: Enemy[] = [];
  private retryT = RETRY;

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
    // 2. seed another every few seconds, while the country around the player is green and there is room
    if (this.retryT > 0) { this.retryT -= dt; return; }
    this.retryT = RETRY;
    if (this.bugs.length >= TARGET) return;
    const spot = this.findSpot(p.x, p.z, Math.max(14, viewR - SPAWN_IN), viewR + SPAWN_OUT);
    if (!spot) return;
    const bug = new Enemy(this.game, 'ladybug', spot.x, spot.z);
    this.game.enemies.push(bug);
    this.bugs.push(bug);
  }

  /** a fresh run is a fresh world: drop the population and let the country restock itself */
  reset() {
    this.bugs = [];
    this.retryT = RETRY;
  }

  /** the best of a handful of tries at a clear, lush, out-of-sight tile to put a bug on */
  private findSpot(px: number, pz: number, r0: number, r1: number): Vec2 | null {
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
      if (this.crowded(tx + 0.5, tz + 0.5)) continue;
      const score = lush + this.game.rand() * 0.15;
      if (score > bestScore) { bestScore = score; best = { x: tx + 0.5, z: tz + 0.5 }; }
    }
    return best;
  }

  /** is there already a bug (or the player) closer than one beetle's patience? */
  private crowded(x: number, z: number): boolean {
    const p = this.game.player.pos;
    if (Math.hypot(p.x - x, p.z - z) < SPACING) return true;
    for (const b of this.bugs) if (Math.hypot(b.pos.x - x, b.pos.z - z) < SPACING) return true;
    return false;
  }
}
