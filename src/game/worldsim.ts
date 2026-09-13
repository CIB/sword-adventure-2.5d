import { RNG } from './constants';
import { WorldState, type Squad, type ChunkInfo } from './worldstate';

/**
 * World simulation: the low-resolution background layer that moves squads along the chunk road
 * graph while they are outside the active region.
 *
 * Design constraints (all deliberate):
 *  - Pure function over WorldState + a step count: no THREE, no DOM, no wall clock. This is the
 *    piece that moves into a Web Worker on its own thread — the worker will own the state and
 *    ship snapshots back; nothing here would change.
 *  - Low tick rate: the sim advances in fixed WORLD_TICK steps (4 Hz). The caller accumulates
 *    frame time and calls tick() with however many whole steps elapsed; per step a marching
 *    squad covers MARCH_SPEED * WORLD_TICK tiles, so precision beyond 4 Hz buys nothing.
 *  - Squads the entity sim has materialised (squad.active) are skipped entirely: while the
 *    player can see them, the high-resolution simulation owns their movement and mirrors
 *    positions back into the squad records.
 *
 * Behaviour: a squad marches from road anchor to road anchor (the road tile nearest each chunk
 * centre). Arriving at a chunk it picks the next graph edge — straight on where possible, never
 * back the way it came unless at a dead end. Arriving at a CAMP chunk it usually halts and rests
 * (REST_MIN..REST_MAX seconds); on the road it occasionally takes a short breather. Village
 * chunks are never entered. Soldiers who die stay dead — nothing here creates records.
 */

/** seconds per world-sim step (4 Hz — the "lower tick rate" layer) */
export const WORLD_TICK = 0.25;
/** squad march speed in tiles/second (a touch below the soldiers' entity walk speed) */
export const MARCH_SPEED = 1.1;
/** rest duration at a camp, seconds */
export const REST_MIN = 20, REST_MAX = 50;
/** chance per arrival at a camp chunk that the squad halts to rest */
const CAMP_REST_P = 0.8;
/** chance per arrival at an ordinary chunk of a short breather */
const ROAD_REST_P = 0.06;
const ROAD_REST_MIN = 4, ROAD_REST_MAX = 10;

export class WorldSim {
  private rng: RNG;
  /** total sim steps executed (diagnostics / determinism tests) */
  steps = 0;

  constructor(private ws: WorldState, seed = 20240614) {
    this.rng = new RNG(seed);
  }

  /** Advance the world by `n` fixed WORLD_TICK steps. */
  tick(n: number) {
    for (let i = 0; i < n; i++) {
      this.steps++;
      for (const sq of this.ws.squads) {
        if (sq.active) continue;              // the entity sim owns materialised squads
        if (!sq.members.some((m) => m.alive)) continue; // wiped squads stay where they fell
        if (sq.state === 'rest') this.rest(sq);
        else this.march(sq);
      }
    }
  }

  private rest(sq: Squad) {
    sq.restT -= WORLD_TICK;
    if (sq.restT > 0) return;
    sq.state = 'march';
    this.pickNext(sq);
  }

  private march(sq: Squad) {
    const target = this.ws.chunks[sq.target];
    const dx = target.ax - sq.x, dz = target.az - sq.z;
    const d = Math.hypot(dx, dz);
    const step = MARCH_SPEED * WORLD_TICK;
    if (d <= step) {
      // arrived at the target chunk's road anchor
      sq.x = target.ax; sq.z = target.az;
      sq.prev = sq.cur;
      sq.cur = sq.target;
      if (target.camp && this.rng.next() < CAMP_REST_P) {
        sq.state = 'rest';
        sq.restT = REST_MIN + this.rng.next() * (REST_MAX - REST_MIN);
      } else if (this.rng.next() < ROAD_REST_P) {
        sq.state = 'rest';
        sq.restT = ROAD_REST_MIN + this.rng.next() * (ROAD_REST_MAX - ROAD_REST_MIN);
      } else {
        this.pickNext(sq);
      }
    } else {
      sq.x += dx / d * step;
      sq.z += dz / d * step;
    }
    this.settleMembers(sq);
  }

  /** choose the next chunk to march to: any road neighbour except the one we came from (unless dead end) */
  private pickNext(sq: Squad) {
    const cur = this.ws.chunks[sq.cur];
    let opts = this.ws.neighbours(cur);
    if (opts.length === 0) {
      // off the network (shouldn't happen) — walk to the nearest road chunk
      const back = this.ws.nearestRoadChunk(sq.x, sq.z);
      sq.target = this.ws.idx(back.cx, back.cz);
      return;
    }
    if (opts.length > 1) opts = opts.filter((c) => this.ws.idx(c.cx, c.cz) !== sq.prev);
    const pick = this.pickWeighted(sq, opts);
    sq.target = this.ws.idx(pick.cx, pick.cz);
  }

  /** prefer going straight through a junction (2x weight) so patrols sweep long routes */
  private pickWeighted(sq: Squad, opts: ChunkInfo[]): ChunkInfo {
    const cur = this.ws.chunks[sq.cur], prev = sq.prev >= 0 ? this.ws.chunks[sq.prev] : null;
    const weights = opts.map((c) => {
      if (!prev) return 1;
      const sameDir = Math.sign(c.cx - cur.cx) === Math.sign(cur.cx - prev.cx) && Math.sign(c.cz - cur.cz) === Math.sign(cur.cz - prev.cz);
      return sameDir ? 2 : 1;
    });
    let sum = 0;
    for (const w of weights) sum += w;
    let r = this.rng.next() * sum;
    for (let i = 0; i < opts.length; i++) { r -= weights[i]; if (r <= 0) return opts[i]; }
    return opts[opts.length - 1];
  }

  /** keep member records trailing the squad position in formation (world-state resolution only) */
  private settleMembers(sq: Squad) {
    for (const m of sq.members) {
      if (!m.alive) continue;
      m.x = sq.x + m.ox;
      m.z = sq.z + m.oz;
    }
  }
}
