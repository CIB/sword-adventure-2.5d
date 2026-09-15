// Node-side smoke test for the farm's presentation layer. None of this needs a browser: THREE's scenes,
// geometries, instanced meshes and toon materials are all plain JS, so the crop geometry, the buckets the
// view builds from the simulation's state, the soil colouring and the farmer's rig can be constructed and
// stepped here. What it checks: every (crop, stage) bucket is real, finite, vertex-coloured geometry that
// fits inside a tile; the view assigns exactly one instance per tilled tile and per plant; instance
// matrices and joint angles never go NaN; the tools follow the job he is doing; and a whole season of
// farming leaves the view consistent and bounded.
// Run: npx esbuild test/farm.test.ts --bundle --platform=node --format=esm | node --input-type=module
import * as THREE from 'three';
import { Tile } from '../src/game/constants';
import {
  CROPS, CROP_IDS, cropStages, VillageState, type FarmPlotSeed, type VillageTerrain, type VillageEvent,
} from '../src/game/village';
import { cropGeo, furrowGeo, wiltGeo, produceGeo, seedGeo, dropGeo, cropWindMaterial, buildWateringCan, buildSeedPouch, buildBasket } from '../src/game/crops';
import { FarmView, FarmerRig, fxSow, fxWater, fxDig, fxPick, fxSprout, fxWilt, fxDeliver } from '../src/game/farm';
import { VILLAGER_LOOKS, buildVillager } from '../src/game/models';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

// ------------------------------------------------------------------ geometry
const geoOK = (g: THREE.BufferGeometry | null | undefined): boolean => {
  if (!g) return false;
  const pos = g.attributes.position;
  if (!pos || pos.count < 12) return false;
  for (let i = 0; i < pos.array.length; i++) if (!Number.isFinite(pos.array[i])) return false;
  return !!g.attributes.color && g.attributes.color.count === pos.count;
};

for (const id of CROP_IDS) {
  const n = cropStages(id);
  let allOK = true, seedH = 0, ripeH = 0;
  for (let stage = 0; stage < n; stage++) {
    const g = cropGeo(CROPS[id], stage);
    if (!geoOK(g)) allOK = false;
    g.computeBoundingBox();
    const box = g.boundingBox!;
    if (stage === 0) seedH = box.max.y;
    if (stage === n - 1) ripeH = box.max.y;
    // no plant may be wider than its tile, or the rows grow into each other
    if (Math.max(Math.abs(box.min.x), Math.abs(box.max.x)) > 0.52 || Math.abs(box.min.z) > 0.52) allOK = false;
    g.dispose();
  }
  check(`${id}: every stage is finite, coloured, tile-sized geometry`, allOK, `${n} stages`);
  check(`${id}: a ripe plant towers over its seed`, ripeH > seedH * 2.5, `${seedH.toFixed(2)} → ${ripeH.toFixed(2)} units`);
  const p = produceGeo(CROPS[id]);
  check(`${id}: its produce is a small, coloured mesh`, geoOK(p));
  p.dispose();
}
for (const [name, g] of [['tilled soil', furrowGeo()], ['wilted crop', wiltGeo()], ['seed kernel', seedGeo()], ['water droplet', dropGeo()]] as [string, THREE.BufferGeometry][]) {
  check(`${name} geometry is finite and coloured`, geoOK(g));
  g.dispose();
}
const can = buildWateringCan();
check('the watering can is a multi-part group', can.children.length >= 4);
check('the can body is a toon material the rig can tint', ((can.children[0] as THREE.Mesh).material as THREE.MeshToonMaterial).isMeshToonMaterial === true);
check('the seed pouch has its strap, bag and lip', buildSeedPouch().children.length === 3);
const basket = buildBasket(Object.values(CROPS));
check('the basket has one slot per unit of produce', basket.slots.length === 8 && basket.group.children.length === 10);
check('the slots start hidden (an empty basket is empty)', basket.slots.every((m) => !m.visible));
check('the wind material builds without a renderer', (cropWindMaterial() as THREE.Material).type === 'MeshToonMaterial');

// ------------------------------------------------------------------ the view, on a fake patch of ground
type EffectLike = { group: THREE.Group; update(dt: number): boolean };

function fixture() {
  const terrain: VillageTerrain & { cornerH(x: number, z: number): number } = {
    isSolidTile: () => false,
    tile: () => Tile.Bed,
    moveBox: (p, dx, dz) => { p.x += dx; p.z += dz; return { bx: false, bz: false }; },
    nearestFree: () => ({ x: 0.5, z: 3.5 }),
    cornerH: () => 0,
  };
  const plots: FarmPlotSeed[] = [{ id: 0, name: 'Test Field', crop: 'turnip', x0: 0, z0: 0, x1: 5, z1: 3, cart: [0.5, 3.5] }];
  const village = new VillageState(terrain, plots, 5);
  const scene = new THREE.Scene();
  const effects: EffectLike[] = [];
  const farm = new FarmView({
    scene,
    world: terrain as unknown as never,
    village,
    spawnEffect: (e) => { effects.push(e as unknown as EffectLike); scene.add((e as unknown as EffectLike).group); },
  });
  return { village, farm, scene, effects, terrain };
}

const f1 = fixture();
f1.farm.update(1 / 60);
const root = f1.scene.getObjectByName('farm')!;
check('the view puts the farm in one named group', !!root);
const instanced = root.children.filter((c): c is THREE.InstancedMesh => (c as THREE.InstancedMesh).isInstancedMesh === true);
check('soil and crops are instanced, not one mesh per plant', instanced.length >= 2 && instanced.length <= 10, `${instanced.length} instanced meshes`);
const tilled = f1.village.tiles.filter((t) => t.tilled).length;
const planted = f1.village.tiles.filter((t) => t.crop !== null).length;
const soil = instanced.find((m) => m.count === tilled);
check('one soil instance per tilled tile', !!soil, `${tilled} tilled`);
const plants = instanced.reduce((n, m) => n + (m === soil ? 0 : m.count), 0);
check('one plant instance per planted tile', plants === planted, `${plants} vs ${planted}`);
let nan = 0;
const probe = new THREE.Matrix4();
for (const m of instanced) for (let i = 0; i < m.count; i++) {
  m.getMatrixAt(i, probe);
  for (const v of probe.elements) if (!Number.isFinite(v)) nan++;
}
check('no instance matrix is NaN', nan === 0);
check('crop buckets are wind-lit toon meshes', instanced.filter((m) => m !== soil).every((m) => (m.material as THREE.Material).type === 'MeshToonMaterial'));

// soil colour is the moisture: a watered tile has to be darker than a dry one
const wet = f1.village.tiles.find((t) => t.tilled && t.moist > 0.9);
const parched = f1.village.tiles.find((t) => t.tilled && t.moist < 0.4);
if (soil && wet && parched && soil.instanceColor) {
  const arr = soil.instanceColor.array as Float32Array;
  const order = f1.village.tiles.filter((t) => t.tilled);
  const lum = (t: { x: number; z: number }) => {
    const i = order.findIndex((o) => o.x === t.x && o.z === t.z) * 3;
    return 0.2126 * arr[i] + 0.7152 * arr[i + 1] + 0.0722 * arr[i + 2];
  };
  check('wet soil is tinted darker than dry soil', lum(wet) < lum(parched), `${lum(wet).toFixed(2)} vs ${lum(parched).toFixed(2)}`);
}

// every event kind produces its particle, and none of them throw
const ev = (kind: VillageEvent['kind'], over: Partial<VillageEvent> = {}): VillageEvent =>
  ({ kind, x: 1.5, z: 1.5, crop: 'turnip', n1: 1, n: 2, rupees: 4, from: { x: 2.5, z: 2.5 }, ...over });
const before = f1.effects.length;
for (const kind of ['sow', 'water', 'till', 'harvest', 'clear', 'ripe', 'sprout', 'wilt', 'deliver', 'unlock'] as VillageEvent['kind'][]) {
  f1.farm.onEvents([ev(kind)]);
  f1.farm.update(1 / 60);
}
check('every farm event spawns its particles', f1.effects.length === before + 10, `${f1.effects.length - before} effects`);
check('a day tick is silent (the Game toasts it, not the view)', (() => { const n = f1.effects.length; f1.farm.onEvents([ev('day')]); return f1.effects.length === n; })());
const finite = (e: EffectLike) => {
  let ok = true;
  for (let i = 0; i < 80; i++) if (!e.update(1 / 60)) break;
  e.group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && !Number.isFinite(m.position.x + m.position.y + m.position.z)) ok = false; });
  return ok;
};
for (const [name, e] of [
  ['sow', fxSow({ x: 1, z: 1 }, { x: 2, z: 2 })],
  ['water', fxWater({ x: 1, z: 1 }, { x: 2, z: 2 })],
  ['dig', fxDig({ x: 2, z: 2 }, { x: 1, z: 1 })],
  ['pick', fxPick({ x: 1, z: 1 }, 'turnip', 2)],
  ['sprout', fxSprout({ x: 2, z: 2 }, false)],
  ['ripe', fxSprout({ x: 2, z: 2 }, true)],
  ['wilt', fxWilt({ x: 2, z: 2 })],
  ['deliver', fxDeliver({ x: 2, z: 2 }, 3)],
] as [string, EffectLike][]) {
  check(`fx${name} stays finite over its whole life`, finite(e));
}

// ------------------------------------------------------------------ the rig
const f2 = fixture();
const model = buildVillager(VILLAGER_LOOKS.farmer);
const npc: any = { model, pos: { x: 0.5, z: 3.5 }, facing: 0, moving: false, animT: 0, controller: null, pose: null };
const rig = new FarmerRig({ scene: new THREE.Scene(), world: f2.terrain as never, village: f2.village, spawnEffect: () => {} });
rig.bind(npc);
check('the rig takes the NPC over', npc.controller === rig && typeof npc.pose === 'function');
check('the hoe is still in his right hand', !!model.handR.getObjectByName('tool'));
check('the seed pouch is strapped to his body', model.body.children.includes((rig as any).pouch));

/** hold the sim in one action at one point in it, let the joints settle, and read them back */
const settle = (act: string, phase: number) => {
  const f = f2.village.farmer;
  f2.village.farmer.act = act as never;
  f.jobKind = (['till', 'sow', 'water', 'harvest', 'clear'] as const).includes(act as never) ? (act as never) : null;
  f.actDur = 0.8;
  f.actT = phase * 0.8;
  f.moving = act === 'walk';
  f.basketN = 3;
  for (let i = 0; i < 200; i++) { rig.update(1 / 60, npc); npc.pose(model, npc, 1 / 60); }
  return { armR: model.armR.rotation.x, armRz: model.armR.rotation.z, armL: model.armL.rotation.x, lean: model.body.rotation.x, head: model.head.rotation.x, crouch: model.body.position.y, tilt: ((rig as any).can.rotation.x as number) };
};

const tillUp = settle('till', 0.4);
const tillDown = settle('till', 0.95);
check('the hoe arm raises over the shoulder on the wind-up', tillUp.armR < -1.4, `armR ${tillUp.armR.toFixed(2)}`);
check('and comes down into the ground after the tool lands', tillDown.armR > 0.3, `armR ${tillDown.armR.toFixed(2)}`);
check('he bends into a dig', tillDown.lean > 0.2, `lean ${tillDown.lean.toFixed(2)}`);
const water = settle('water', 0.7);
check('watering lifts the can arm', water.armL < -0.6, `armL ${water.armL.toFixed(2)}`);
check('and tips it', water.tilt > 0.5, `tilt ${water.tilt.toFixed(2)}`);
const pick = settle('harvest', 0.4);
check('a pick reaches down with both hands and crouches', pick.armR > 0.4 && pick.head > 0.2, `armR ${pick.armR.toFixed(2)}, head ${pick.head.toFixed(2)}`);
const sow = settle('sow', 0.9);
check('sowing ends with a flick of the wrist, not a hoe swing', sow.armR < -0.8);
const rest = settle('rest', 0.1);
const walk = settle('walk', 0.5);
check('a rest is not a walk is not a job', Math.abs(rest.lean - walk.lean) < 0.01 && Math.abs(walk.armR - tillUp.armR) > 0.5);
check('every pose is finite', [tillUp, tillDown, water, pick, sow, rest, walk].every((p) =>
  Object.values(p).every((n: number) => Number.isFinite(n))));
check('the NPC picked up the sim body', Math.abs(npc.pos.x - f2.village.farmer.x) < 1e-9 && npc.facing === f2.village.farmer.facing);

const canGroup = (rig as any).can as THREE.Group;
settle('water', 0.5);
check('the watering can comes out for a watering', canGroup.visible === true);
settle('harvest', 0.5);
check('and goes away for a pick, along with the hoe', canGroup.visible === false && model.handR.getObjectByName('tool')!.visible === false);
settle('till', 0.5);
check('the hoe comes back out for a dig', model.handR.getObjectByName('tool')!.visible === true);
const basketGroup = (rig as any).basket.group as THREE.Group;
f2.village.farmer.basketN = 0; rig.update(1 / 60, npc);
check('an empty basket stays home', basketGroup.visible === false);
f2.village.farmer.basketN = 4; rig.update(1 / 60, npc);
// the first two children are the basket itself (body + rim); the rest are the produce slots
check('a basket with produce comes along, filled to the count',
  basketGroup.visible === true && basketGroup.children.slice(2).filter((c) => c.visible).length === 4,
  `${basketGroup.children.slice(2).filter((c) => c.visible).length} of 8 slots showing`);

// ------------------------------------------------------------------ a whole season, drawn
const f3 = fixture();
let maxBucket = 0, peakMeshes = 0;
for (let i = 0; i < 60 * 30 * 14; i++) {
  f3.village.tick(1 / 30);
  const evs = f3.village.takeEvents();
  if (evs.length) f3.farm.onEvents(evs);
  f3.farm.update(1 / 60);
  if (i % 37 === 0) {
    const meshes = f3.scene.getObjectByName('farm')!.children.filter((c) => (c as THREE.InstancedMesh).isInstancedMesh);
    peakMeshes = Math.max(peakMeshes, meshes.length);
    for (const m of meshes) maxBucket = Math.max(maxBucket, (m as THREE.InstancedMesh).count);
  }
}
check('a season of farming leaves the tiles finite', f3.village.tiles.every((t) => Number.isFinite(t.moist) && Number.isFinite(t.grow) && Number.isFinite(t.ripeT)));
check('a bucket never holds more than one instance per tile', maxBucket <= f3.village.tiles.length, `largest ${maxBucket}/${f3.village.tiles.length}`);
check('the bucket count stays bounded as crops move through stages', peakMeshes <= 1 + CROP_IDS.length * 7 + 1, `${peakMeshes} instanced meshes at the peak`);
check('the fields grew under him', f3.village.stats.tilled > 6, `${f3.village.stats.tilled} tilled`);
check('and the view still matches the state', (() => {
  f3.farm.update(1 / 60);
  const meshes = f3.scene.getObjectByName('farm')!.children.filter((c) => (c as THREE.InstancedMesh).isInstancedMesh) as THREE.InstancedMesh[];
  // the soil mesh is the only one the view paints per instance
  const plantedNow = f3.village.tiles.filter((t) => t.crop !== null).length;
  const counted = meshes.filter((m) => !m.instanceColor).reduce((n, m) => n + m.count, 0);
  const soilCount = meshes.filter((m) => m.instanceColor).reduce((n, m) => n + m.count, 0);
  return counted === plantedNow && soilCount === f3.village.tiles.filter((t) => t.tilled).length;
})(), `plants ${f3.village.tiles.filter((t) => t.crop !== null).length}`);

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall farm view checks passed');
