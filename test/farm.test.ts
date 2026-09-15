// Node-side check of the farm's rendering layer: the instanced soil quads and the per-(crop,
// stage) crop meshes FarmView draws from the village simulation. No WebGL here — the instanced
// meshes, their matrices, their instance colours and their geometry are what can be checked without
// a GPU, and that is most of what this file adds. Stubs the 2D canvas the soil texture paints into.
// Run: npx esbuild test/farm.test.ts --bundle --platform=node --format=esm | node --input-type=module
const g2d = () => ({
  fillStyle: '', strokeStyle: '',
  fillRect: () => {}, strokeRect: () => {}, clearRect: () => {},
  createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  putImageData: () => {}, drawImage: () => {},
});
(globalThis as any).document = { createElement: (tag: string) => (tag === 'canvas' ? { width: 0, height: 0, getContext: () => g2d() } : {}) };

import * as THREE from 'three';
import { World } from '../src/game/world';
import { VillageState } from '../src/game/village';
import { FarmView } from '../src/game/farm';
import { foliageUniforms } from '../src/game/foliage';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

const world = new World();
const state = new VillageState(world);
const farm = new FarmView(state, world);
// the fields of an InstancedMesh are private to the view, but they are exactly what is under test
const view = farm as any;
const DT = 1 / 30;

/** step the sim like the game does: tick, drain once, hand the events to the view */
const step = (seconds: number) => {
  for (let t = 0; t < seconds; t += DT) {
    state.tick(DT);
    farm.update(DT, state.drainEvents());
  }
};

// ---- a farm that nobody has worked yet
check('an unworked farm draws no soil', view.soil.count === 0, String(view.soil.count));
check('an unworked farm draws no crops', view.meshes.size === 0);
check('the soil and the crops hang off the farm root', farm.root.children.length === 1 && farm.root.children[0] === view.soil);
check('the soil quads follow the world, not the frustum', view.soil.frustumCulled === false);

// ---- after a morning's work
step(90);
const worked = [...state.tiles.values()].filter((t) => t.state !== 'fallow');
const planted = worked.filter((t) => t.state === 'sown' || t.state === 'ripe');
check('every worked bed gets a soil quad', view.soil.count === worked.length, `${view.soil.count} quads for ${worked.length} beds`);
check('the soil is tilled earth, not grass', (view.soil.material as THREE.Material).type === 'MeshBasicMaterial' && !!(view.soil.material as any).map);
check('some beds are planted', planted.length > 0, `${planted.length} planted`);

const m4 = new THREE.Matrix4();
const pos = new THREE.Vector3();
const quat = new THREE.Quaternion();
const scale = new THREE.Vector3();
const soilY = new Map<number, number>();
for (let i = 0; i < view.soil.count; i++) {
  view.soil.getMatrixAt(i, m4);
  m4.decompose(pos, quat, scale);
  soilY.set(Math.floor(pos.x) * 1000 + Math.floor(pos.z), pos.y);
}
check('the soil lies flat on the bed', [...soilY.keys()].every((k) => {
  const x = Math.floor(k / 1000), z = k % 1000;
  return Math.abs(soilY.get(k)! - (world.tileH(x, z) + 0.014)) < 1e-6;
}));

// ---- the crop meshes: one instanced draw per (crop, stage), covering every planted bed
const buckets = new Map<string, number[]>();
for (const t of planted) {
  const key = t.crop + ':' + t.visual;
  buckets.set(key, [...(buckets.get(key) ?? []), t.i]);
}
check('crops are drawn one mesh per crop and stage', view.meshes.size === buckets.size, `${view.meshes.size} buckets: ${[...view.meshes.keys()].join(' ')}`);
let drawn = 0;
let baked = 0;
for (const [key, ids] of buckets) {
  const mesh = view.meshes.get(key) as THREE.InstancedMesh;
  check(`the ${key} mesh covers its beds`, !!mesh && mesh.count === ids.length, mesh ? `${mesh.count}/${ids.length}` : 'missing');
  drawn += mesh.count;
  const geo = mesh.geometry;
  check(`the ${key} geometry is a coloured, wind-blown plant`, !!geo.getAttribute('color') && !!geo.getAttribute('aWindFactor'));
  if (geo.getAttribute('color')) baked++;
}
check('every planted bed is drawn exactly once', drawn === planted.length, `${drawn}/${planted.length}`);
check('every crop mesh is drawn with vertex colours and the shared wind', baked === buckets.size &&
  (view.cropMat as THREE.ShaderMaterial).vertexColors && (view.cropMat as THREE.ShaderMaterial).uniforms === (foliageUniforms as any));
check('crops cast into the wind field the grass uses', 'uTime' in (foliageUniforms as any) && 'uWindTex' in (foliageUniforms as any));

// ---- the plants stand on the bed, and they are not all the same size
const first = view.meshes.get([...view.meshes.keys()][0]) as THREE.InstancedMesh;
first.getMatrixAt(0, m4);
m4.decompose(pos, quat, scale);
check('a plant stands on the bed it grows in', Math.abs(pos.y - (world.tileH(Math.floor(pos.x), Math.floor(pos.z)) + 0.02)) < 1e-6, pos.y.toFixed(3));
check('plants are jittered so a row does not read as one stamp', first.count < 2 || (() => {
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  first.getMatrixAt(0, m4); m4.decompose(pos, quat, a);
  first.getMatrixAt(1, m4); m4.decompose(pos, quat, b);
  return Math.abs(a.x - b.x) > 1e-3 && Math.abs(a.y - b.y) > 1e-3;
})());

// ---- dry soil and watered soil do not look the same
check('soil is tinted per instance', !!view.soil.instanceColor);
if (view.soil.instanceColor) {
  // one of the beds dries out (a day's moisture simply runs out) and the view is told to redraw
  const soggy = worked[0], parched = worked[1];
  soggy.wetT = 30;
  parched.wetT = 0;
  state.rev++;
  farm.update(DT, []);
  const tintOf = (t: { x: number; z: number }) => {
    for (let i = 0; i < view.soil.count; i++) {
      view.soil.getMatrixAt(i, m4);
      m4.decompose(pos, quat, scale);
      if (Math.floor(pos.x) === t.x && Math.floor(pos.z) === t.z) {
        const c = new THREE.Color(); view.soil.getColorAt(i, c);
        return c;
      }
    }
    return null;
  };
  const wetTint = tintOf(soggy), dryTint = tintOf(parched);
  check('the damp bed is tinted apart from the dry one', !!wetTint && !!dryTint && wetTint.getHex() !== dryTint.getHex(),
    `${wetTint?.getHexString()} vs ${dryTint?.getHexString()}`);
}

// ---- a seed sprouting pops into its new size
const growing = [...state.tiles.values()].find((t) => t.state === 'sown');
check('there is a growing bed to watch', !!growing);
if (growing) {
  state.drainEvents();
  farm.update(DT, [{ kind: 'sprout', x: growing.x + 0.5, z: growing.z + 0.5, crop: growing.crop }]);
  const mesh = view.meshes.get(growing.crop + ':' + growing.visual) as THREE.InstancedMesh;
  const idx = [...buckets.get(growing.crop + ':' + growing.visual)!].indexOf(growing.i);
  const pop = new THREE.Vector3();
  mesh.getMatrixAt(idx, m4); m4.decompose(pos, quat, pop);
  check('a seed springs out of the soil', pop.y < 0.85, pop.y.toFixed(2));
  for (let t = 0; t < 0.7; t += DT) farm.update(DT, []);
  mesh.getMatrixAt(idx, m4); m4.decompose(pos, quat, pop);
  check('and settles at full size', pop.y > 0.85 && pop.y <= 1.3, pop.y.toFixed(2));
}

// ---- rebuilds only when something changed
const before = view.rev;
farm.update(DT, []);
check('a frame with nothing new does not rebuild', view.rev === before);
state.tick(0.0001);
const quiet = state.drainEvents().length === 0;
farm.update(DT, []);
check('nor does a tick that changed nothing', !quiet || view.rev === before);

// ---- a restart clears the field
state.reset();
farm.update(DT, []);
check('a restarted run wipes the soil', view.soil.count === 0, String(view.soil.count));
check('and the crops', [...view.meshes.values()].every((m: THREE.InstancedMesh) => m.count === 0));

// ---- teardown
const root = farm.root;
check('the farm is a group in the scene', root.children.length > 1);
farm.dispose();
check('dispose takes its meshes out of the scene', root.children.length === 0);
check('dispose forgets its crop meshes', view.meshes.size === 0);

console.log(failures ? `\n${failures} FAILURES` : '\nall farm view checks passed');
