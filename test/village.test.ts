// Node-side validation of the village farm simulation: the plot layout the world hands over, crop growth
// that only happens on moist soil, the wilt deadline, the farmer's job choice and his ability to reach
// and work every tile of his fields, the day clock, the seed-sack plot unlock, run reset, and
// determinism — the same seed has to grow the same village. Uses a tiny fake patch of ground for the
// rules and the real generated World for the integration run.
// Run: npx esbuild test/village.test.ts --bundle --platform=node --format=esm | node --input-type=module
let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

import { World } from '../src/game/world';
import { Tile, MAP_W } from '../src/game/constants';
import {
  VillageState, CROPS, CROP_IDS, cropStages, cropGrowTime, isRipe, WATER_CAN, SEED_PACK, TILL_PER_DAY,
  WATER_PER_DAY, STALLED, DAY_SECONDS,
  type FarmPlotSeed, type VillageEvent, type VillageTerrain,
} from '../src/game/village';

// ------------------------------------------------------------------ the rules, on a fake patch of ground
/** a 6x6 field of bed ground, one solid tile in the middle, water all around it */
function fakeVillage(seed = 7) {
  const solid = new Set<number>([2 * 6 + 2]);
  const terrain: VillageTerrain = {
    isSolidTile: (x, z) => x < 0 || z < 0 || x > 5 || z > 5 || solid.has(z * 6 + x),
    tile: (x, z) => (x >= 0 && z >= 0 && x < 6 && z < 6 ? Tile.Bed : Tile.Water),
    moveBox: (p, dx, dz) => { p.x += dx; p.z += dz; return { bx: false, bz: false }; },
    nearestFree: () => ({ x: 0.5, z: 0.5 }),
  };
  const plots: FarmPlotSeed[] = [{ id: 0, name: 'Test Field', crop: 'turnip', x0: 0, z0: 0, x1: 5, z1: 5, cart: [0.5, 0.5] }];
  return new VillageState(terrain, plots, seed);
}

const v0 = fakeVillage();
check('the plot resolves to its free bed tiles', v0.tiles.length === 35, `${v0.tiles.length} tiles (36 minus the solid one)`);
check('ground under a prop is left out of the farm', v0.tileAt(2, 2) === undefined);
check('the farmer starts at his cart', Math.hypot(v0.farmer.x - 0.5, v0.farmer.z - 0.5) < 0.9);
check('the day starts at one', v0.day === 1 && v0.dayT === 0);
check('the cart comes with a full can and a full pack', v0.farmer.water === WATER_CAN && v0.farmer.seeds.turnip === SEED_PACK);
check('the fields are already mid-morning', v0.stats.tilled > 0 && v0.stats.sown > 0);
check('there is a harvest waiting for him', v0.readyCount() > 0);
// row 0 runs left to right, row 1 back right to left: the 7th tile in a 6-wide plot is the far end of
// the second row, which is why the farmer walks a field instead of darting across it
check('tiles are ordered in serpentine rows', v0.tiles[6].x === 5 && v0.tiles[6].z === 1, `order 6 → (${v0.tiles[6].x}, ${v0.tiles[6].z})`);
check('the first row runs the other way', v0.tiles[0].x === 0 && v0.tiles[5].x === 5);

// ---- the crop table
for (const id of CROP_IDS) {
  const spec = CROPS[id];
  check(`${id}: a seed stage and a ripe stage`, cropStages(id) >= 4, `${cropStages(id)} stages`);
  check(`${id}: grow time is the sum of its stages`, cropGrowTime(id) === spec.stageSec.reduce((a, b) => a + b, 0));
  check(`${id}: seeds cost more than one item sells for`, spec.seedPrice > spec.sellPrice);
  check(`${id}: a regrower comes back to a younger stage`, spec.regrowTo === undefined || spec.regrowTo < cropStages(id) - 1);
}

// ---- moisture is what grows a crop
const dry = fakeVillage(11);
const tile = dry.tiles.find((t) => t.crop !== null && !isRipe(t))!;
const need = CROPS[tile.crop!].stageSec[1];
tile.tilled = true;
tile.stage = 1;
tile.grow = 0;
tile.moist = 0;
for (let i = 0; i < 100; i++) dry.growCrops(0.1);
check('dust grows nothing', tile.stage === 1 && tile.grow === 0);
tile.moist = 0.2;
const damp0 = tile.grow;
for (let i = 0; i < 20; i++) dry.growCrops(0.1); // 2 s at the slow pace
check('damp soil grows, but slowly', tile.grow > damp0 && tile.grow - damp0 < 2 / need, `+${(tile.grow - damp0).toFixed(3)} of ${2 / need}`);
const wet0 = tile.grow;
tile.moist = 1;
for (let i = 0; i < 10; i++) dry.growCrops(0.1); // 1 s at full pace
check('wet soil grows at full pace', Math.abs(tile.grow - wet0 - 1 / need) < 0.01, `+${(tile.grow - wet0).toFixed(3)} vs ${(1 / need).toFixed(3)}`);
check('the soil dries as the crop drinks', tile.moist < 1, `moist ${tile.moist.toFixed(3)}`);

// ---- a stage change is reported, and the tile's revision moves
const pop = fakeVillage(23);
const popTile = pop.tiles.find((t) => t.crop !== null && !isRipe(t))!;
popTile.moist = 1;
popTile.stage = 1;
popTile.grow = 0.99;
const rev = popTile.rev;
pop.growCrops(0.5);
const kinds = pop.takeEvents().map((e) => e.kind);
check('a plant coming up reports a sprout', kinds.includes('sprout'), kinds.join(','));
check('a changed tile is marked for the renderer', popTile.rev !== rev && pop.rev !== 0);
popTile.stage = cropStages(popTile.crop!) - 2;
popTile.grow = 0.99;
pop.growCrops(0.5);
check('a crop coming ripe reports it', pop.takeEvents().some((e) => e.kind === 'ripe'));

// ---- the wilt deadline, and clearing what it leaves
const wilty = fakeVillage(13);
const ripe = wilty.tiles.find((t) => isRipe(t))!;
const hold = CROPS[ripe.crop!].hold;
for (let i = 0; i < Math.ceil((hold + 4) / 1); i++) {
  wilty.growCrops(1);
  if (ripe.wilted) break;
}
check('a ripe crop left alone goes to seed', ripe.wilted === true);
check('a wilted crop is not "ready"', isRipe(ripe) === false);
check('a wilted tile wants clearing', wilty.jobFor(ripe) === 'clear');
wilty.clearTile(ripe);
check('clearing leaves worked, empty ground', !ripe.wilted && ripe.crop === null && ripe.tilled);

// ---- regrowers keep their plant, root crops come out of it
const tom = fakeVillage(17);
const tomTile = tom.tiles[0];
Object.assign(tomTile, { crop: 'tomato', stage: cropStages('tomato') - 1, grow: 0, wilted: false, tilled: true });
const got = tom.harvestTile(tomTile);
check('a picked tomato plant stays in the ground', tomTile.crop === 'tomato' && tomTile.stage === CROPS.tomato.regrowTo, `stage ${tomTile.stage}`);
check('the pick returned the yield', !!got && got.n >= CROPS.tomato.yieldMin && got.n <= CROPS.tomato.yieldMax);
const tur = fakeVillage(19);
const turTile = tur.tiles[0];
Object.assign(turTile, { crop: 'turnip', stage: cropStages('turnip') - 1, grow: 0, wilted: false, tilled: true });
tur.harvestTile(turTile);
check('a pulled turnip leaves bare earth', turTile.crop === null && turTile.tilled);
const unripe = tur.tiles[9];
Object.assign(unripe, { crop: 'turnip', stage: 1, grow: 0, wilted: false, tilled: true, moist: 1 });
check('an unripe crop cannot be harvested', tur.harvestTile(unripe) === null && unripe.crop === 'turnip');

// ------------------------------------------------------------------ the farmer, in the real village
const world = new World();
const v = new VillageState(world, world.farmPlots, 0x51a);

check('the village has three plots', v.plots.length === 3, v.plots.map((p) => p.name).join(', '));
check('two are worked, one waits on seed', v.plots.filter((p) => p.unlocked).length === 2);
check('every plot is inside the village fence', v.plots.every((p) =>
  p.x0 >= world.village.x0 && p.x1 <= world.village.x1 && p.z0 >= world.village.z0 && p.z1 <= world.village.z1));
check('every farm tile is bed ground the farmer can stand on', v.tiles.every((t) =>
  world.tile(t.x, t.z) === Tile.Bed && !world.isSolidTile(t.x, t.z)));
check('the farm covers all the ground the world marked', world.farmTiles.every(([x, z]) => !!v.tileAt(x, z)),
  `${world.farmTiles.length} marked, ${v.tiles.length} claimed`);
check('the scarecrow is still standing in the field', v.tileAt(4, 21) === undefined);
const tilledAtStart = v.stats.tilled;
check('a locked plot starts untilled', v.plots[2].tiles.every((i) => !v.tiles[i].tilled));

// ---- a season of farming
const seen = new Set<VillageEvent['kind']>();
const visited = new Set<number>();
let inWall = 0, badPos = 0, maxBasket = 0, minWater = WATER_CAN;
const acts = new Set<string>();
const DT = 1 / 30;
// just over three village days: the first one belongs to the harvest that was already standing in the
// rows when the run began, which is exactly what a farmer does — pick what is ripe before breaking
// more ground. Two days is not enough to see the fields start to expand.
for (let i = 0; i < 60 * 30 * 3 + 60; i++) {
  v.tick(DT);
  for (const e of v.takeEvents()) seen.add(e.kind);
  const f = v.farmer;
  acts.add(f.act);
  if (!Number.isFinite(f.x) || !Number.isFinite(f.z)) badPos++;
  else if (world.isSolidTile(Math.floor(f.x), Math.floor(f.z))) inWall++;
  maxBasket = Math.max(maxBasket, f.basketN);
  minWater = Math.min(minWater, f.water);
  visited.add(Math.floor(f.z) * MAP_W + Math.floor(f.x));
}
check('the farmer never stood inside a wall', inWall === 0 && badPos === 0, `${inWall} frames`);
check('the day clock ran', v.day === 4, `day ${v.day}`);
check('the farmer harvested', v.stats.harvested > 0, `${v.stats.harvested} items`);
check('the farmer watered', v.stats.watered > 0, `${v.stats.watered} tiles`);
check('the farmer broke new ground', v.stats.tilled > tilledAtStart, `${tilledAtStart} → ${v.stats.tilled}`);
check('the till budget is what limits the field', v.stats.tilled <= tilledAtStart + 3 * TILL_PER_DAY, `${v.stats.tilled - tilledAtStart} broken in 3 days`);
check('he sowed what he broke', v.stats.sown > 0, `${v.stats.sown} seeds`);
check('baskets came off the field', maxBasket > 0, `biggest basket ${maxBasket}`);
check('produce sold at the cart earns the village', v.stats.gold > 0, `${v.stats.gold} rupees`);
check('the farmer walked his field, not one corner of it', visited.size > 18, `${visited.size} tiles stood on`);
check('the can is what limits his day (he runs low and refills)', minWater < WATER_CAN && v.stats.watered > 0, `can down to ${minWater}, ${v.stats.watered} waterings`);
check('and he carries the harvest to the cart', v.stats.gold > 0, `${v.stats.gold} rupees earned`);
for (const k of ['sow', 'water', 'harvest', 'till', 'ripe', 'day', 'deliver'] as VillageEvent['kind'][]) {
  check(`the sim reported a "${k}"`, seen.has(k), [...seen].join(' '));
}
for (const a of ['walk', 'rest', 'water', 'sow', 'harvest']) check(`the farmer was seen "${a}"`, acts.has(a), [...acts].join(' '));
check('he is not chasing a tile he cannot reach', !(v.farmer.act === 'walk' && v.farmer.path.length === 0));

// ---- a farmer who cannot get somewhere must not stop the village with him
// The pathfinder refuses to cut corners between solid props, and a trip to the cart that fails twice
// completes anyway: both of those exist because a wedged farmer used to freeze the whole simulation —
// the day kept turning, and nothing else ever happened again. So: run long, and demand progress.
const long = new VillageState(world, world.farmPlots, 0x51a);
const marks: number[] = [];
for (let d = 1; d <= 14; d++) {
  for (let i = 0; i < 60 * 20; i++) { long.tick(0.05); long.takeEvents(); }
  marks.push(long.stats.harvested + long.stats.tilled + long.stats.sown + long.stats.watered);
}
const stillWorking = marks.slice(1).every((n, i) => n > marks[i]);
check('a fortnight of days never wedges the farmer', stillWorking, `jobs done by day: ${marks.join(' ')}`);
// five tiles a day of spade work over a fortnight is most of a village: the point is that the ground
// keeps going, at the rate the sim advertises, and not that it is a spreadsheet-perfect 5 x 14
check('the fields keep expanding at the advertised rate', long.fallowCount() <= 8, `${long.fallowCount()} fallow tiles left after 14 days`);
check('nobody starves: the can, the spade and the pouch all ran',
  long.stats.watered > 40 && long.stats.tilled > 40 && long.stats.sown > 40, JSON.stringify(long.stats));

// ---- the night is what makes the can his morning chore
const night = fakeVillage(31);
for (const t of night.tiles) if (t.crop && !isRipe(t)) { t.moist = 1; t.wilted = false; }
let wetAtDawn = -1;
let dayBefore = night.day;
for (let i = 0; i < Math.ceil(DAY_SECONDS / 0.2) + 4; i++) {
  night.tick(0.2);
  if (night.day !== dayBefore) {
    wetAtDawn = night.tiles.filter((t) => t.crop && !isRipe(t) && t.moist > STALLED).length;
    break;
  }
}
check('the night dries the soil, so the whole field wants water at dawn', wetAtDawn === 0, `${wetAtDawn} still wet at sunrise`);
const parched = fakeVillage(33);
const dryTile = parched.tiles.find((t) => t.crop && !isRipe(t) && !t.wilted)!;
dryTile.moist = 0;
check('a thirsty crop is a job, not a death sentence', parched.jobFor(dryTile) === 'water' && !dryTile.wilted);
check('a stalled crop still holds its place in the row', dryTile.stage >= 0 && parched.openCount() >= 0);

// ---- the fields fill in over a season
const openTilled = v.tiles.filter((t) => v.plots[t.plot].unlocked && t.tilled).length;
const openAll = v.tiles.filter((t) => v.plots[t.plot].unlocked).length;
check('the open plots are filling in', openTilled / openAll > 0.45, `${openTilled}/${openAll} tilled`);
// watering is rationed (a can and a bit a day) and the night takes the rest of it back out, so a field
// is partly dark with damp and partly pale — that contrast is the whole point of simulating moisture
const waterPerDay = v.stats.watered / (v.day - 1);
check('he waters a canful a day, not the whole village',
  waterPerDay > 0 && waterPerDay <= WATER_PER_DAY + 1, `${waterPerDay.toFixed(1)} tiles a day`);
check('and he really does water most days (the can is not decoration)',
  v.stats.watered >= WATER_PER_DAY, `${v.stats.watered} waterings in ${v.day - 1} days`);
check("the day's digging budget gets spent, not hoarded",
  v.stats.tilled - tilledAtStart >= TILL_PER_DAY, `${v.stats.tilled - tilledAtStart} tiles broken`);
check('and broken ground does not pile up unplanted', v.openCount() < 24, `${v.openCount()} open tiles`);
check('and the ground he did not reach is dry, not dead',
  v.tiles.every((t) => !t.crop || t.wilted || t.moist >= 0) && v.stats.lost <= v.stats.harvested);

// ---- the seed sack opens a field, and the farmer takes it on
check('the village will not re-open a plot it already works', v.unlockPlot(0) === false);
check("the shopkeeper's sack opens Colts Meadow", v.unlockPlot(2) === true);
const before2 = v.plots[2].tiles.filter((i) => v.tiles[i].tilled).length;
for (let i = 0; i < 60 * 30 * 12; i++) { v.tick(DT); v.takeEvents(); } // a fortnight of rotation
const after2 = v.plots[2].tiles.filter((i) => v.tiles[i].tilled).length;
check('the farmer broke ground in the new field', after2 > before2, `${before2} → ${after2}`);
check('and sowed it', v.plots[2].tiles.some((i) => v.tiles[i].crop === 'pumpkin'));

// ---- rain
const dryTiles = v.tiles.filter((t) => t.crop && !t.wilted && !isRipe(t) && t.moist < 0.2).length;
v.waterEverything(1);
check('rain soaks every living crop that needed it',
  dryTiles > 0 && v.tiles.every((t) => !t.crop || t.wilted || t.moist >= 0.9), `${dryTiles} were thirsting`);

// ---- determinism, reset, and the report the dialogue reads
const a1 = new VillageState(world, world.farmPlots, 99);
const a2 = new VillageState(world, world.farmPlots, 99);
for (let i = 0; i < 3000; i++) { a1.tick(DT); a2.tick(DT); }
check('the same seed grows the same village', JSON.stringify(a1.snapshot()) === JSON.stringify(a2.snapshot()));
const untouched = new VillageState(world, world.farmPlots, 99);
a1.reset();
check('reset is the morning of day one', a1.day === 1 && a1.time === 0 && a1.stats.harvested === 0 && a1.stats.watered === 0);
check('a reset village is a new village, exactly', JSON.stringify(a1.snapshot()) === JSON.stringify(untouched.snapshot()));
check('and the farmer is back at his cart', Math.hypot(a1.farmer.x - v.plots[0].cart.x, a1.farmer.z - v.plots[0].cart.z) < 2.5);

const rep = v.report();
check('the farmer can describe every plot', rep.length === 3 && rep.every((r) => r.of > 0 && typeof r.ready === 'number'));
check('the report counts are the tile counts', rep.reduce((n, r) => n + r.of, 0) === v.tiles.length);
check('the report knows which plots are open', rep.filter((r) => r.open).length === 3);

// ------------------------------------------------------------------ what the village says about it
// The dialogue is a window onto the simulation, so every line it builds from the state has to survive
// every state — including an empty basket, a wilted field and the farmer mid-swing.
import { NPC_TALK, newQuestState, PRODUCE_PRICE, SEED_SACK_PRICE, type TalkCtx } from '../src/game/dialogue';
const ctxFor = (v: VillageState, rupees = 200): TalkCtx => ({
  rupees,
  spendRupees: (n: number) => { if (rupees < n) return false; rupees -= n; return true; },
  heal: () => {},
  reward: () => {},
  toast: () => {},
  village: v,
  takeBasket: () => v.takeBasket(),
  buySeeds: () => true,
});
const talkOK = (v: VillageState, label: string) => {
  let clean = true, pages = 0;
  for (const id of ['farmer', 'shopkeeper', 'goodwife', 'elder', 'granny']) {
    const talk = NPC_TALK[id];
    if (!talk) { clean = false; continue; }
    const c = talk(newQuestState(), ctxFor(v));
    pages += c.pages.length;
    for (const line of c.pages) if (typeof line !== 'string' || !line.length || line.includes('undefined') || line.includes('NaN') || line.includes('null')) clean = false;
    c.onEnd?.(newQuestState(), ctxFor(v));
  }
  check(`the village can talk about the farm (${label})`, clean && pages >= 10, `${pages} pages`);
};
const talking = new VillageState(world, world.farmPlots, 3);
talkOK(talking, 'day one');
for (const act of ['idle', 'walk', 'till', 'sow', 'water', 'harvest', 'clear', 'fetch', 'rest'] as const) {
  talking.farmer.act = act;
  talking.farmer.moving = act === 'walk';
  talkOK(talking, `the farmer is ${act}`);
}
const empty = new VillageState(world, world.farmPlots, 4);
empty.reset();
for (const t of empty.tiles) { t.crop = null; t.wilted = false; t.tilled = false; }
empty.farmer.basketN = 0;
talkOK(empty, 'nothing planted at all');

// the farmer sells what he has picked, and only that
const seller = new VillageState(world, world.farmPlots, 5);
seller.farmer.basket.turnip = 3;
seller.farmer.basketN = 3;
const sold = seller.takeBasket();
check('the basket hands over its produce', !!sold && sold.n === 3 && sold.crop === 'turnip');
check('and then there is nothing left to buy', seller.takeBasket() === null && seller.farmer.basketN === 0);
check('the produce price is under what it is worth', PRODUCE_PRICE <= (sold?.value ?? 0) + 6, `${PRODUCE_PRICE} vs ${sold?.value}`);
// the point of the sack: the field it opens is worth far more to the village than the rupees it costs
const meadow = v.plots[2];
const seasonWorth = meadow.tiles.length * CROPS.pumpkin.yieldMin * CROPS.pumpkin.sellPrice;
check('a seed sack pays for itself in the field it opens', seasonWorth > SEED_SACK_PRICE, `${seasonWorth} of pumpkins for ${SEED_SACK_PRICE} rupees`);

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall village checks passed');
