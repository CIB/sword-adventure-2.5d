// Node-side validation of the village simulation: the farm's crop life cycle (seed -> ripe only
// while watered, soil drying out), the farmer's job choice and routing over the village, the
// action timings that drive his animation, the events he emits for the game, and a long soak
// that proves the field keeps cycling under him (ripe crops get pulled, empties get sown, dry
// rows get watered) instead of stalling.
// Run: npx esbuild test/village.test.ts --bundle --platform=node --format=esm | node --input-type=module
(globalThis as any).document = { createElement: (tag: string) => (tag === 'canvas' ? { width: 0, height: 0, getContext: () => ({}) } : {}) };

import { World } from '../src/game/world';
import { VillageState, CROPS, DRY_TIME, THIRSTY, ACTIONS, cropStage, isRipe, type FarmTile, type VillageEvent } from '../src/game/village';
import { Tile } from '../src/game/constants';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

const world = new World();
const vs = new VillageState(world);
const DT = 1 / 30;

// ---- the field
check('the village declares farm plots', world.farmPlots.length >= 2);
const plotTiles = world.farmPlots.reduce((n, p) => n + (p.x1 - p.x0 + 1) * (p.z1 - p.z0 + 1), 0);
check('every farm tile is a Bed tile inside a plot', vs.farm.length > 0 && vs.farm.every((t) => world.tile(t.x, t.z) === Tile.Bed && world.isFarmPlot(t.x, t.z)));
check('the scarecrow keeps its tile', vs.farm.length < plotTiles && !vs.plotAt(4, 21));
check('plotAt finds plots and nothing else', vs.plotAt(vs.farm[0].x, vs.farm[0].z) === vs.farm[0] && vs.plotAt(9, 9) === null && vs.plotAt(-1, -1) === null);
check('both crops are grown, laid out by row', vs.farm.some((t) => t.crop === 'turnip') && vs.farm.some((t) => t.crop === 'cabbage')
  && vs.farm.every((t) => vs.farm.filter((o) => o.z === t.z && Math.abs(o.x - t.x) <= 5 && o.x >= 2 && o.x <= 7 && t.x >= 2 && t.x <= 7).every((o) => o.crop === t.crop)));
check('the field starts mid-season', vs.farm.some((t) => !t.planted) && vs.farm.some((t) => isRipe(t)) && vs.farm.some((t) => t.planted && !isRipe(t)));

// ---- crop life cycle, on a plot of our own
{
  const t: FarmTile = { x: 0, z: 0, crop: 'turnip', planted: true, growth: 0, water: 0 };
  check('stage -1 for bare soil', cropStage({ ...t, planted: false }) === -1);
  check('stages climb with growth', cropStage({ ...t, growth: 0 }) === 0 && cropStage({ ...t, growth: 0.3 }) === 1 && cropStage({ ...t, growth: 0.7 }) === 2 && cropStage({ ...t, growth: 1 }) === 3);
  check('needOf: ripe -> harvest, bare -> sow, dry -> water, otherwise nothing',
    VillageState.needOf({ ...t, growth: 1 }) === 'harvest' && VillageState.needOf({ ...t, planted: false }) === 'sow'
    && VillageState.needOf({ ...t, water: THIRSTY - 0.01 }) === 'water' && VillageState.needOf({ ...t, water: 0.9 }) === null);
}
{
  // a private sim: one plot, watered; growth should complete in CROPS.grow seconds of wet time
  const solo = new VillageState(world);
  solo.farm = [{ x: 3, z: 19, crop: 'turnip', planted: true, growth: 0, water: 1 }];
  solo.farmer.task = 'rest'; solo.farmer.idle = 1e9; // keep him out of it
  const g0 = solo.farm[0].growth;
  for (let i = 0; i < 30; i++) solo.tick(DT);
  check('wet crops grow', solo.farm[0].growth > g0 && Math.abs(solo.farm[0].growth - 1 / CROPS.turnip.grow) < 1e-3);
  check('soil dries out', Math.abs(solo.farm[0].water - (1 - 1 / DRY_TIME)) < 1e-3);
  solo.farm[0].water = 0;
  const g1 = solo.farm[0].growth;
  for (let i = 0; i < 30; i++) solo.tick(DT);
  check('dry crops stall (but do not die)', solo.farm[0].growth === g1 && solo.farm[0].planted);
  check('rev bumps on a stage change', (() => { const r = solo.rev; solo.farm[0].growth = 0.199; solo.farm[0].water = 1; for (let i = 0; i < 30; i++) solo.tick(DT); return solo.rev > r; })());
}

// ---- routing: the farmer walks between the rows, around houses and the fence
check('beds are passable, houses and fences are not', vs.passable(3, 20) && !vs.passable(14, 22) && !vs.passable(32, 20) && !vs.passable(0, 20));
{
  const p = vs.pathTo(3, 25);
  check('a path from home to the far field exists and is 4-connected', !!p && p.length > 4 && p.every((w, i) => i === 0 || Math.abs(w.x - p[i - 1].x) + Math.abs(w.z - p[i - 1].z) < 1.001));
  check('the path ends on the target tile', !!p && Math.floor(p[p.length - 1].x) === 3 && Math.floor(p[p.length - 1].z) === 25);
  check('unreachable tiles have no path', vs.pathTo(14, 22) === null && vs.pathTo(50, 50) === null);
}

// ---- the farmer at work: soak the sim and watch him
{
  const sim = new VillageState(world);
  const jobs = { sow: 0, water: 0, harvest: 0 };
  const events: VillageEvent[] = [];
  let lastTask = sim.farmer.task, maxStep = 0, offField = false, everWalked = false, everRested = false;
  let px = sim.farmer.x, pz = sim.farmer.z;
  const ripeBefore = sim.farm.filter(isRipe).length;
  for (let i = 0; i < 30 * 600; i++) { // ten minutes
    sim.tick(DT);
    const f = sim.farmer;
    maxStep = Math.max(maxStep, Math.hypot(f.x - px, f.z - pz)); px = f.x; pz = f.z;
    if (!sim.passable(Math.floor(f.x), Math.floor(f.z))) offField = true;
    if (f.task === 'walk') everWalked = true;
    if (f.task === 'rest') everRested = true;
    if (f.task !== lastTask) { if (f.task === 'sow' || f.task === 'water' || f.task === 'harvest') jobs[f.task]++; lastTask = f.task; }
    events.push(...sim.drain());
  }
  check('the farmer walks', everWalked);
  check('he moves at a walking pace, never teleports', maxStep < 0.1, `max step ${maxStep.toFixed(3)}`);
  check('he never leaves walkable ground', !offField);
  check('he harvests', jobs.harvest > 0, `${jobs.harvest}`);
  check('he sows', jobs.sow > 0, `${jobs.sow}`);
  check('he waters', jobs.water > 0, `${jobs.water}`);
  check('harvests are tallied', sim.farmer.harvested.turnip + sim.farmer.harvested.cabbage === events.filter((e) => e.kind === 'harvest').length);
  check('ripe crops get pulled and replanted (the field turns over)', sim.farm.filter(isRipe).length < ripeBefore + 3 && jobs.harvest >= ripeBefore);
  const kinds = new Set(events.map((e) => e.kind));
  check('events for every visible moment', kinds.has('hoe') && kinds.has('sow') && kinds.has('water') && kinds.has('harvest'));
  check('a sowing emits one hoe and two seed casts', events.filter((e) => e.kind === 'hoe').length === jobs.sow && events.filter((e) => e.kind === 'sow').length === 2 * jobs.sow);
  check('events carry the plot and the farmer stance', events.every((e) => sim.plotAt(e.tx, e.tz) !== null && Math.hypot(e.tx + 0.5 - e.x, e.tz + 0.5 - e.z) < 1.6));
  check('he works from a neighbouring tile, facing the plot', events.every((e) => Math.abs(e.tx + 0.5 - e.x) + Math.abs(e.tz + 0.5 - e.z) < 1.6));
  check('he does not stand on the plot he works', events.every((e) => !(Math.floor(e.x) === e.tx && Math.floor(e.z) === e.tz)));
  // once the whole field is caught up he goes home to rest
  const done = new VillageState(world);
  for (const t of done.farm) { t.planted = true; t.growth = 0.5; t.water = 1; }
  for (let i = 0; i < 30 * 60; i++) done.tick(DT);
  check('with nothing to do he rests by the wheelbarrow', everRested || done.farmer.task === 'rest', done.farmer.task);
  check('...at his home spot', Math.hypot(done.farmer.x - done.farmer.hx, done.farmer.z - done.farmer.hz) < 0.7);
}

// ---- action timings (what the animation is built on)
for (const k of ['sow', 'water', 'harvest'] as const) {
  const a = ACTIONS[k];
  check(`${k}: marks lie inside the action in order`, a.marks.every((m, i) => m.t > 0 && m.t < a.dur && (i === 0 || m.t > a.marks[i - 1].t)));
}

// ---- the player in the way: he waits, then routes around
{
  const sim = new VillageState(world);
  // put him on the field path with a job across the path, and stand the player right in front of him
  sim.farmer.x = 4.5; sim.farmer.z = 23.5; sim.farmer.task = 'idle';
  for (const t of sim.farm) { t.planted = true; t.growth = 0.5; t.water = 1; }
  const target = sim.plotAt(6, 24)!; target.planted = false;
  sim.tick(DT);
  check('he picks the job', sim.farmer.task === 'walk' && sim.farmer.jobKind === 'sow');
  const next = sim.farmer.path.find((w) => Math.hypot(w.x - sim.farmer.x, w.z - sim.farmer.z) > 0.5)!;
  const blocker = { x: next.x, z: next.z };
  for (let i = 0; i < 20; i++) sim.tick(DT, blocker); // walks up to them...
  const x0 = sim.farmer.x, z0 = sim.farmer.z;
  for (let i = 0; i < 15; i++) sim.tick(DT, blocker);  // ...and stops short
  check('he waits for someone standing in his way', sim.farmer.x === x0 && sim.farmer.z === z0 && sim.farmer.wait > 0 && Math.hypot(blocker.x - x0, blocker.z - z0) < 0.7);
  for (let i = 0; i < 30 * 8; i++) sim.tick(DT, blocker);
  check('...then finds a way round and finishes the job', target.planted, sim.farmer.task);
  // someone standing right on top of him must not pin him in place
  const pin = new VillageState(world);
  pin.farmer.x = 4.5; pin.farmer.z = 23.5;
  for (const t of pin.farm) { t.planted = true; t.growth = 0.5; t.water = 1; }
  pin.plotAt(6, 24)!.planted = false;
  for (let i = 0; i < 30 * 3; i++) pin.tick(DT, { x: 4.5, z: 23.5 });
  check('he can step away from someone standing on him', Math.hypot(pin.farmer.x - 4.5, pin.farmer.z - 23.5) > 1);
}

// ---- reset is a fresh field
{
  const sim = new VillageState(world);
  for (let i = 0; i < 30 * 120; i++) sim.tick(DT);
  const moved = Math.hypot(sim.farmer.x - sim.farmer.hx, sim.farmer.z - sim.farmer.hz) > 0.1 || sim.farmer.harvested.turnip + sim.farmer.harvested.cabbage > 0;
  sim.reset();
  const fresh = new VillageState(world);
  check('reset restores the opening field and the farmer at home', moved && sim.farmer.x === sim.farmer.hx && JSON.stringify(sim.farm) === JSON.stringify(fresh.farm));
}

// ---- snapshot is plain data
check('snapshot is structured-clone friendly', (() => { try { structuredClone(vs.snapshot()); return true; } catch { return false; } })());

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
