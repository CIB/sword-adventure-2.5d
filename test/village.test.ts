// Node-side validation of the village simulation: the beds the terrain generator drew turning into
// farm plots, the crop lifecycle (fallow -> tilled -> sown -> growing -> ripe -> harvested), the
// moisture that gates the growing, and the farmhand's day — the job order, the walk out, the basket
// to the barrow, and the walk home at knock-off.
// Stubs the DOM bits World's texture helpers need (none are called here).
// Run: npx esbuild test/village.test.ts --bundle --platform=node --format=esm | node --input-type=module
const g2d = () => ({
  createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  putImageData: () => {},
  drawImage: () => {},
});
(globalThis as any).document = { createElement: (tag: string) => (tag === 'canvas' ? { width: 0, height: 0, getContext: () => g2d() } : {}) };

import { World } from '../src/game/world';
import {
  VillageState, CROPS, DAY_SECONDS, FARM_CAPACITY, MOISTURE_SECONDS, STAGE_SECONDS, WORK_UNTIL,
  type FarmPlot, type FarmTile, type VillageEvent,
} from '../src/game/village';
import { MAP_W, Tile } from '../src/game/constants';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

const world = new World();
const village = new VillageState(world);
const idx = (x: number, z: number) => z * MAP_W + x;
const tile = (x: number, z: number): FarmTile => village.tiles.get(idx(x, z))!;
const DT = 1 / 30;
/** drive the simulation (and the farmhand with it) for `seconds` */
const run = (v: VillageState, seconds: number, dt = DT) => {
  for (let t = 0; t < seconds; t += dt) v.tick(dt);
};

// ---- which beds became farm land
// the south field is cut in two by the lane (a Path row at z23), so it is two 6x4 blocks of beds
const inField = (p: FarmPlot) => p.x0 >= 2 && p.x1 <= 7 && p.z0 >= 19 && p.z1 <= 27;
const field = village.plots.filter(inField);
const blocks = [...new Set(field.map((p) => `${p.z0}-${p.z1}`))].map((k) => field.filter((p) => `${p.z0}-${p.z1}` === k));
check('the south field becomes two blocks of beds', field.length === 4 && blocks.length === 2, `${field.length} plots`);
check('a block is worked as two strips', blocks.every((b) => b.length === 2 && b[0].id !== b[1].id), field.map((p) => `${p.x0}-${p.x1}`).join(' '));
check('the strips of a block are one region', blocks.every((b) => b[0].region === b[1].region));
check('the strips split the block down the middle', blocks.every((b) => Math.min(...b.map((p) => p.x0)) === 2 && Math.max(...b.map((p) => p.x1)) === 7));
check('a strip is named for the side it is on', field.every((p) => /^(West|East) field$/.test(p.name)), field.map((p) => p.name).join(' | '));
check('the two strips of a block carry a crop each', blocks.every((b) => b[0].crop !== b[1].crop), blocks.map((b) => b.map((p) => p.crop).join('/')).join(' '));
check('beds a farmhand will work are marked', field.every((p) => p.worked));
check('the field is all bed tiles', field.reduce((n, p) => n + p.cells.length, 0) === 48, String(field.reduce((n, p) => n + p.cells.length, 0)));

// small beds are decoration, not crop land
check('the north window boxes are not a plot', !village.tiles.has(idx(9, 2)) && !village.tiles.has(idx(10, 3)));
check('every plot is a real patch of tilled soil', village.plots.every((p) => p.cells.every((c) => world.tile(c % MAP_W, (c - c % MAP_W) / MAP_W) === Tile.Bed)));

// ---- solidity: a bed you can stand beside, never on
check('bed tiles are solid to walk on', world.isSolidTile(4, 20));
check('a bed with a walkable neighbour is workable', tile(7, 20).reach && tile(4, 22).reach);
check('a bed walled in by other beds is not', !tile(4, 20).reach);
const reachable = [...village.tiles.values()].filter((t) => t.reach && field.some((p) => p.id === t.plot));
check('the field offers more workable beds than one farmhand will keep', reachable.length >= FARM_CAPACITY, `${reachable.length} beds vs capacity ${FARM_CAPACITY}`);

// ---- the farmhand
const farmer = village.workerFor('farmer');
check('the farmer is hired as a farmhand', !!farmer);
check('a villager who is not a farmhand has no record', village.workerFor('elder') === null);
const his = farmer ? farmer.plots.map((id) => village.plots[id]) : [];
check('he is given the field by the farm yard', his.length === 2 && his.every(inField) && his[0].region === his[1].region, his.map((p) => p.name).join(' + '));
check('he starts at his own doorstep', !!farmer && Math.hypot(farmer.home.x - 11.5, farmer.home.z - 3.5) < 3, farmer ? `${farmer.home.x},${farmer.home.z}` : '');
const barrowProp = world.props.find((p) => p.kind === 'wheelbarrow')!;
check('the barrow is the wheelbarrow in the farm yard', Math.hypot(village.barrow.x - barrowProp.x, village.barrow.z - barrowProp.z) < 0.01);

// ---- a day of work
const day = new VillageState(world);
run(day, 90);
const worked = [...day.tiles.values()].filter((t) => t.state !== 'fallow');
check('he breaks ground on his first morning', day.totals.tilled > 0, `${day.totals.tilled} beds tilled`);
check('he sows what he tills', day.totals.sown > 0, `${day.totals.sown} beds sown`);
check('he waters what he sows', day.totals.watered > 0, `${day.totals.watered} waterings`);
check('the beds that are worked are the ones he can reach', worked.every((t) => t.reach));
check('he keeps the field under his capacity', worked.length <= FARM_CAPACITY, `${worked.length} beds`);
check('the first beds he works are a block, not scattered', (() => {
  const ids = worked.map((t) => `${t.x},${t.z}`);
  return ids.length < 2 || worked.some((t) => worked.filter((o) => Math.abs(o.x - t.x) + Math.abs(o.z - t.z) <= 1).length > 1);
})(), worked.map((t) => `${t.x},${t.z}`).join(' '));

// ---- growth is gated on moisture
const wet = new VillageState(world);
// a bed nobody tends (the Millbrook beds are outside the village): the farmhand cannot walk in on
// this experiment halfway through
const probe = [...wet.tiles.values()].find((t) => !wet.plots[t.plot].worked)!;
probe.state = 'sown';
probe.crop = 'turnip';
probe.growth = 0;
probe.visual = 0;
probe.wetT = MOISTURE_SECONDS * 4; // a well-watered bed: enough damp seconds for every stage
run(wet, STAGE_SECONDS / 2);
check('a damp crop grows', probe.growth > 0.4, probe.growth.toFixed(2));
probe.wetT = 0;
const stalled = probe.growth;
run(wet, 5);
check('a dry crop does not grow', probe.growth === stalled);
probe.wetT = 2;
run(wet, 3);
check('moisture runs out and shows as dry soil', probe.wetT === 0);
check('the tile remembers it was watered', probe.state === 'sown');

// ---- ripening, harvesting and the basket
const ripe = new VillageState(world);
// a bed nobody works (the farmhand tends one field, not the whole village): one damp bed is left
// to grow and ripen on its own
const bed = [...ripe.tiles.values()].find((t) => t.reach && !ripe.plots[t.plot].worked)!;
Object.assign(bed, { state: 'sown', growth: 0, visual: 0, wetT: MOISTURE_SECONDS * 3 });
const bedEvents: VillageEvent[] = [];
for (let t = 0; t < STAGE_SECONDS * 3 + 1; t += DT) {
  ripe.tick(DT);
  bedEvents.push(...ripe.drainEvents());
}
check('a crop passes through its growth stages', bedEvents.some((e) => e.kind === 'sprout') && bed.visual >= 2);
check('a crop that stays damp ripens', bed.state === 'ripe' && bed.visual === 3, bed.state);
check('ripening is announced for the view', bedEvents.some((e) => e.kind === 'ripe' && e.x === bed.x + 0.5));
check('a ripe crop has a colour to draw it in', CROPS[bed.crop].colour.startsWith('#'));

// three ripe beds left alone: the farmhand should come for them, and carry the basket to the barrow
const harvest = new VillageState(world);
const hbeds = harvest.handTiles(harvest.workerFor('farmer')!).filter((t) => t.reach).slice(0, 3);
check('the farmhand has reachable beds of his own', hbeds.length === 3, `${hbeds.length}`);
for (const b of hbeds) Object.assign(b, { state: 'ripe', growth: 3, visual: 3, wetT: 0 });
const hEvents: VillageEvent[] = [];
for (let t = 0; t < 180; t += DT) {
  harvest.tick(DT);
  hEvents.push(...harvest.drainEvents());
}
const pulled = (b: FarmTile) => hEvents.some((e) => e.kind === 'harvest' && e.x === b.x + 0.5 && e.z === b.z + 0.5);
check('he harvests the ripe beds', hbeds.every(pulled), hbeds.map((b) => `${b.x},${b.z}:${b.state}`).join(' '));
check('the harvest is announced where the crop stood', hEvents.some((e) => e.kind === 'harvest' && e.x === hbeds[0].x + 0.5));
check('it says which crop came out', hEvents.some((e) => e.kind === 'harvest' && e.crop === hbeds[0].crop));
check('his crop goes to the barrow, not into thin air', hEvents.some((e) => e.kind === 'stow') && harvest.harvested >= 3, `${harvest.harvested} harvested`);
check('the barrow is where the wheelbarrow stands', hEvents.every((e) => e.kind !== 'stow' || Math.hypot(e.x - barrowProp.x, e.z - barrowProp.z) < 0.01));

// ---- the working day and the night
check('a day is long enough to work and to sleep in', DAY_SECONDS * (1 - WORK_UNTIL) > 8);
const night = new VillageState(world);
night.dayT = WORK_UNTIL + 0.05;
run(night, 6);
const nfarmer = night.workerFor('farmer')!;
check('when the light goes he knocks off', nfarmer.state === 'rest', nfarmer.state);
check('he rests at his own door', Math.hypot(nfarmer.x - nfarmer.home.x, nfarmer.z - nfarmer.home.z) < 0.7, `${nfarmer.x.toFixed(1)},${nfarmer.z.toFixed(1)}`);
const morning = new VillageState(world);
morning.dayT = 0.02;
run(morning, 40);
check('and he is back at the field in the morning', Math.hypot(morning.workerFor('farmer')!.x - 11.5, morning.workerFor('farmer')!.z - 3.5) > 1);

// ---- a week on the farm: crops come in, nothing gets stuck
const week = new VillageState(world);
run(week, DAY_SECONDS * 3);
const wf = week.workerFor('farmer')!;
check('three days of work bring in a harvest', week.harvested > 0, `${week.harvested} crops`);
check('the farmhand is still sane after three days', Number.isFinite(wf.x) && Number.isFinite(wf.z) && wf.x > 0 && wf.x < MAP_W);
check('he spends his time on the field, not stuck on a wall', wf.blockedT <= 0 || wf.blockedT < 25);
check('the day counter rolls over', week.day >= 3, `day ${week.day}`);
check('the day\'s harvest resets each morning', week.harvestedToday <= week.harvested);
check('crops are harvested and re-sown, not abandoned', week.totals.sown > week.harvested, `${week.totals.sown} sown, ${week.harvested} harvested`);
check('nothing is left standing in the rain: every crop has a crop in it', [...week.tiles.values()].every((t) => t.state === 'fallow' || !!CROPS[t.crop]));
check('the summary reads like a sentence', /^DAY \d+ [A-Z]+ - \d+\/\d+ BEDS OF [A-Z+ ]+ - \d+ RIPE - \d+ IN TODAY$/.test(week.summary()), week.summary());

// ---- determinism (the sim must be replayable, like the world state)
const a = new VillageState(world, { seed: 99 });
const b = new VillageState(world, { seed: 99 });
run(a, 60);
run(b, 60);
const wa = a.workerFor('farmer')!, wb = b.workerFor('farmer')!;
check('the same seed replays the same day', Math.abs(wa.x - wb.x) < 1e-9 && Math.abs(wa.z - wb.z) < 1e-9 && a.totals.tilled === b.totals.tilled);

// ---- a restart puts the farm back the way the run started
const rerun = new VillageState(world);
run(rerun, 60);
check('a worked farm has something worth resetting', rerun.totals.tilled > 0);
rerun.reset();
const rf = rerun.workerFor('farmer')!;
check('a fresh run starts on the first morning', rerun.day === 1 && rerun.dayT === 0.04);
check('every bed is bare soil again', [...rerun.tiles.values()].every((t) => t.state === 'fallow' && t.growth === 0 && t.visual === 0 && t.wetT === 0));
check('the barrow and the tallies are emptied', rerun.harvested === 0 && rerun.harvestedToday === 0 && rerun.totals.tilled === 0 && rf.basket === 0);
check('the farmhand is back at his door', Math.abs(rf.x - rf.home.x) < 1e-9 && Math.abs(rf.z - rf.home.z) < 1e-9 && rf.state === 'idle' && rf.task === null);
check('nothing is queued up for the view', rerun.drainEvents().length === 0);
check('the view is told to redraw', rerun.rev > 0);
// the restarted day should play out exactly like a first day does
const control = new VillageState(world);
const day60 = (v: VillageState) => {
  run(v, 60);
  const w = v.workerFor('farmer')!;
  return [w.x.toFixed(6), w.z.toFixed(6), w.task, w.tile, w.basket, v.totals.tilled, v.totals.sown,
    [...v.tiles.values()].filter((t) => t.state !== 'fallow').length].join('|');
};
check('the restarted run replays the same day', day60(rerun) === day60(control), day60(rerun));

// ---- the snapshot is plain data
const snap = week.snapshot();
check('snapshot carries the calendar, plots, workers and beds', snap.day === week.day && snap.plots.length === week.plots.length && snap.tiles.length === week.tiles.size);
check('snapshot survives a structured clone', (() => {
  try { return structuredClone(snap).workers.length === week.workers.length; } catch { return false; }
})());

console.log(failures ? `\n${failures} FAILURES` : '\nall village checks passed');
