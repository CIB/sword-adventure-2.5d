/**
 * Model viewer: browse every procedural model in the game (characters, houses, props, foliage...)
 * in either the game's exact oblique-shear projection (with the pixel post-process) or a free orbit camera.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  buildHeroine, buildSoldier, buildVillager, buildDog, VILLAGER_LOOKS, buildTrees, buildBush, buildBerryBush, buildRock, buildStump,
  buildFence, buildHouse, buildProp, buildHeart, buildRupee, buildArrow, buildJavelinProjectile, buildMoblinSpearProjectile,
  buildFernGeo, buildTallGrassGeo, buildBriarGeo, buildLilyGeo, buildBoulderGeo, buildCropGeo, buildWateringCan, vegObject, LADYBUG_KINDS, type Humanoid,
} from '../game/models';
import type { PropKind, HouseSpec, EnemyKind } from '../game/world';
import { World } from '../game/world';
import { GrassSystem } from '../game/grass';
import { updateFoliage } from '../game/foliage';
import { POST_VS, POST_FS } from '../game/game';
import { VIEW_W, VIEW_H, VIEW_TILES_X, VIEW_TILES_Y, CAM_HEIGHT, SHEAR, FACING_ANGLE } from '../game/constants';

type Entry = { name: string; build: () => { obj: THREE.Object3D; humanoid?: Humanoid; footprint?: number } };
type Cat = { name: string; items: Entry[] };

const hum = (h: Humanoid) => ({ obj: h.root, humanoid: h });
const PROPS: PropKind[] = ['well', 'sign', 'stall', 'bench', 'weathercock', 'lamp', 'barrel', 'crate', 'flowerpot', 'hedge', 'log', 'menhir', 'cart', 'hay', 'scarecrow', 'campfire', 'tent', 'banner', 'tower', 'ruinwall', 'pillar', 'crown', 'windmill', 'anvil', 'forge', 'cauldron', 'grave', 'deadtree', 'reeds', 'rosebush', 'beehive', 'wheelbarrow', 'statue', 'mushroom', 'amberrock'];
const world = new World();
const grass = new GrassSystem(world);

const catalog: Cat[] = [
  { name: 'Heroine', items: [{ name: 'Aria', build: () => hum(buildHeroine()) }] },
  { name: 'Fallen Knights', items: (['sword', 'spear', 'javelin', 'archer'] as EnemyKind[]).map((k) => ({ name: k[0].toUpperCase() + k.slice(1) + ' knight', build: () => hum(buildSoldier(k)) })) },
  { name: 'Moblins', items: (['moblin', 'moblin_spear'] as EnemyKind[]).map((k) => ({ name: k === 'moblin' ? 'Sword moblin (shield)' : 'Spear moblin (thrower)', build: () => hum(buildSoldier(k)) })) },
  { name: 'Beasts', items: [
    ...LADYBUG_KINDS.map((k) => ({ name: k === 'ladybug' ? 'Ladybug (soldier-sized)' : 'Ladybug queen (oversized)', build: () => hum(buildSoldier(k)) })),
    { name: 'Spitflower (rooted)', build: () => hum(buildSoldier('spitflower')) },
  ] },
  // the size question in one picture: a soldier, the ordinary beetle, and the oversized queen
  { name: 'Size check', items: [{ name: 'Knight · ladybug · queen', build: () => {
    const line = new THREE.Group();
    const stand = (h: Humanoid, x: number) => { h.root.position.x = x; line.add(h.root); };
    stand(buildSoldier('sword'), -1.5);
    stand(buildSoldier('ladybug'), 0.4);
    stand(buildSoldier('ladybug_queen'), 2.3);
    return { obj: line, footprint: 6 };
  } }] },
  { name: 'Villagers', items: [...Object.keys(VILLAGER_LOOKS).map((id) => ({ name: id[0].toUpperCase() + id.slice(1), build: () => hum(buildVillager(VILLAGER_LOOKS[id])) })), { name: 'Dog', build: () => hum(buildDog()) }] },
  { name: 'Houses', items: world.houses.map((h, i) => ({ name: `House ${i + 1} (${h.w}×${h.d}${h.sign && h.sign !== 'none' ? ', ' + h.sign : ''})`, build: () => { const spec: HouseSpec = { ...h, x: -h.w / 2, z: -h.d / 2 }; return { obj: buildHouse(spec), footprint: Math.max(h.w, h.d) + 2 }; } })) },
  { name: 'Foliage', items: [
    { name: 'Tree (big)', build: () => { const g = new THREE.Group(); for (const o of buildTrees([{ x: 0, z: 0, scale: 1 }])) g.add(o); return { obj: g, footprint: 4 }; } },
    { name: 'Tree (small)', build: () => { const g = new THREE.Group(); for (const o of buildTrees([{ x: 0, z: 0, scale: 0.6 }])) g.add(o); return { obj: g, footprint: 3 }; } },
    { name: 'Tree (pine)', build: () => { const g = new THREE.Group(); for (const o of buildTrees([{ x: 0, z: 0, scale: 1, kind: 'pine' }])) g.add(o); return { obj: g, footprint: 4 }; } },
    { name: 'Tree (autumn)', build: () => { const g = new THREE.Group(); for (const o of buildTrees([{ x: 0, z: 0, scale: 1, kind: 'autumn' }])) g.add(o); return { obj: g, footprint: 4 }; } },
    { name: 'Tree (birch)', build: () => { const g = new THREE.Group(); for (const o of buildTrees([{ x: 0, z: 0, scale: 1, kind: 'birch' }])) g.add(o); return { obj: g, footprint: 4 }; } },
    { name: 'Tree (blossom)', build: () => { const g = new THREE.Group(); for (const o of buildTrees([{ x: 0, z: 0, scale: 1, kind: 'blossom' }])) g.add(o); return { obj: g, footprint: 4 }; } },
    { name: 'Bush', build: () => ({ obj: buildBush() }) }, { name: 'Bush (berries)', build: () => ({ obj: buildBerryBush() }) }, { name: 'Bush stump', build: () => ({ obj: buildStump() }) },
    { name: 'Rock', build: () => ({ obj: buildRock() }) }, { name: 'Rock (mossy)', build: () => ({ obj: buildRock(1) }) }, { name: 'Rock (crystal)', build: () => ({ obj: buildRock(2) }) },
    { name: 'Boulder', build: () => ({ obj: vegObject(buildBoulderGeo()) }) },
    { name: 'Fern', build: () => ({ obj: vegObject(buildFernGeo()) }) },
    { name: 'Tall grass', build: () => ({ obj: vegObject(buildTallGrassGeo()) }) },
    { name: 'Briar', build: () => ({ obj: vegObject(buildBriarGeo()) }) },
    { name: 'Lily pads', build: () => ({ obj: vegObject(buildLilyGeo()) }) },
    { name: 'Fence post', build: () => ({ obj: buildFence() }) },
    { name: 'Grass (animated)', build: () => ({ obj: grass.buildPatch(36, 22, 12, 12), footprint: 12 }) },
  ] },
  { name: 'Farm', items: [
    ...(['turnip', 'cabbage'] as const).flatMap((c) => ['seeded', 'sprout', 'leafy', 'ripe'].map((st, i) => ({ name: `${c[0].toUpperCase() + c.slice(1)} (${st})`, build: () => ({ obj: vegObject(buildCropGeo(c, i)) }) }))),
    { name: 'Watering can', build: () => { const g = new THREE.Group(); const c = buildWateringCan(); c.position.y = 0.4; g.add(c); return { obj: g }; } },
  ] },
  { name: 'Props', items: PROPS.map((k) => ({ name: k[0].toUpperCase() + k.slice(1), build: () => ({ obj: buildProp({ kind: k, x: 0, z: 0 }), footprint: k === 'tower' || k === 'windmill' ? 6 : k === 'statue' ? 3 : k === 'tent' || k === 'stall' ? 4 : k === 'deadtree' ? 2.5 : 2 }) })) },
  { name: 'Pickups & projectiles', items: [
    { name: 'Heart', build: () => ({ obj: buildHeart() }) }, { name: 'Rupee (green)', build: () => ({ obj: buildRupee(false) }) }, { name: 'Rupee (blue)', build: () => ({ obj: buildRupee(true) }) },
    { name: 'Arrow', build: () => ({ obj: buildArrow() }) }, { name: 'Javelin', build: () => ({ obj: buildJavelinProjectile() }) }, { name: 'Moblin spear', build: () => ({ obj: buildMoblinSpearProjectile() }) },
  ] },
  { name: 'Bridges', items: [{ name: 'All bridges (world)', build: () => { const g = new THREE.Group(); for (const o of world.createBridgeMeshes()) g.add(o); const b = world.bridges[0]; g.position.set(-(b.x0 + b.x1 + 1) / 2, 0, -(b.z0 + b.z1 + 1) / 2); const w = new THREE.Group(); w.add(g); return { obj: w, footprint: 12 }; } }] },
];

// ------------------------------------------------------------------ renderer + scenes
const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x1b4520, 1);

const scene = new THREE.Scene();
scene.add(new THREE.AmbientLight(0xffffff, 1.15));
const sun = new THREE.DirectionalLight(0xffffff, 2.05);
sun.position.set(-0.15, 1, 0.42);
scene.add(sun, sun.target);

// ground: a patch of the real grass tile texture
const groundTex = world.createGrassTileTexture();
groundTex.wrapS = groundTex.wrapT = THREE.RepeatWrapping; groundTex.repeat.set(40, 40);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2), new THREE.MeshToonMaterial({ map: groundTex }));
ground.position.y = -0.001;
scene.add(ground);
const gridHelper = new THREE.GridHelper(40, 40, 0x224422, 0x2f6a2f);
gridHelper.position.y = 0.002;
scene.add(gridHelper);

const holder = new THREE.Group();
scene.add(holder);

// game camera (same construction as game.ts)
const gameCam = new THREE.OrthographicCamera(-VIEW_TILES_X / 2, VIEW_TILES_X / 2, VIEW_TILES_Y / 2, -VIEW_TILES_Y / 2, 1, 200);
gameCam.up.set(0, 0, -1);
gameCam.updateProjectionMatrix();
gameCam.projectionMatrix.multiply(new THREE.Matrix4().set(1, 0, 0, 0, 0, 1, SHEAR, SHEAR * CAM_HEIGHT, 0, 0, 1, 0, 0, 0, 0, 1));
gameCam.projectionMatrixInverse.copy(gameCam.projectionMatrix).invert();
gameCam.position.set(0, CAM_HEIGHT, 0);
gameCam.lookAt(0, 0, 0);

// free camera
const freeCam = new THREE.PerspectiveCamera(40, VIEW_W / VIEW_H, 0.1, 200);
freeCam.position.set(4, 3.5, 5);
const controls = new OrbitControls(freeCam, canvas);
controls.target.set(0, 0.8, 0);
controls.enableDamping = true;

// post-process (same shader as the game)
const rt = new THREE.WebGLRenderTarget(VIEW_W, VIEW_H, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true, stencilBuffer: false });
rt.texture.colorSpace = THREE.SRGBColorSpace;
const depthTex = new THREE.DepthTexture(VIEW_W, VIEW_H); depthTex.type = THREE.UnsignedIntType; depthTex.format = THREE.DepthFormat;
rt.depthTexture = depthTex;
const postMat = new THREE.ShaderMaterial({
  uniforms: { tDiffuse: { value: rt.texture }, tDepth: { value: depthTex }, texel: { value: new THREE.Vector2(1 / VIEW_W, 1 / VIEW_H) }, camNear: { value: 1 }, camFar: { value: 200 }, threshold: { value: 0.16 } },
  vertexShader: POST_VS, fragmentShader: POST_FS, depthTest: false, depthWrite: false,
});
const postScene = new THREE.Scene(); postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMat));
const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

// ------------------------------------------------------------------ state
let mode: 'game' | 'free' = 'game';
let facing = 0;
let zoom = 3;
let current: { obj: THREE.Object3D; humanoid?: Humanoid; footprint?: number } | null = null;
let animT = 0;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const animCb = $<HTMLInputElement>('anim'), postCb = $<HTMLInputElement>('post'), gridCb = $<HTMLInputElement>('grid');

function layout() {
  const stage = $('stage');
  const W = stage.clientWidth, H = stage.clientHeight;
  if (mode === 'game') {
    const z = Math.max(1, Math.min(zoom, Math.floor(Math.min(W / VIEW_W, H / VIEW_H))));
    renderer.setSize(VIEW_W, VIEW_H, false);
    canvas.style.width = VIEW_W * z + 'px'; canvas.style.height = VIEW_H * z + 'px';
    canvas.style.imageRendering = 'pixelated';
  } else {
    renderer.setSize(W, H, false);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    canvas.style.imageRendering = 'auto';
    freeCam.aspect = W / H; freeCam.updateProjectionMatrix();
  }
  $('help').textContent = mode === 'game'
    ? 'Game view: the exact in-game camera (top-down ortho + oblique shear, 320×240). Use the facing buttons to turn characters.'
    : 'Free view: drag to orbit, right-drag to pan, wheel to zoom. Facing buttons still turn the model.';
}

function show(e: Entry, btn: HTMLButtonElement) {
  document.querySelectorAll('#list button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  holder.clear();
  current = e.build();
  holder.add(current.obj);
  animT = 0;
  $('name').textContent = e.name;
  // frame in free view
  const fp = current.footprint ?? 1.6;
  const box = new THREE.Box3().setFromObject(current.obj);
  const hgt = Math.max(0.5, box.max.y);
  controls.target.set(0, hgt * 0.45, 0);
  const d = Math.max(fp, hgt * 1.2) * 1.6 + 1.5;
  freeCam.position.set(d * 0.7, d * 0.55, d * 0.75);
  // game view: keep larger things in frame by shifting the camera
  gameCam.position.set(0, CAM_HEIGHT, 0.5); gameCam.lookAt(0, 0, 0.5);
  applyFacing();
}

function applyFacing() {
  if (!current) return;
  current.obj.rotation.y = FACING_ANGLE[facing]; // same convention as entities.ts (root.rotation.y = facingAngle)
}

function animate(dt: number) {
  if (!current?.humanoid) {
    if (current) {
      const sp = current.obj.getObjectByName('spin'); if (sp) sp.rotation.y += dt * 1.5;
      const ms = current.obj.getObjectByName('mill'); if (ms) ms.rotation.z += dt * 0.9; // windmill sails
    }
    return;
  }
  const m = current.humanoid;
  if (!animCb.checked) { m.legL.rotation.x = m.legR.rotation.x = 0; m.body.position.y = 0; return; }
  animT += dt * 9;
  const swing = Math.sin(animT);
  m.legL.rotation.x = swing * 0.7; m.legR.rotation.x = -swing * 0.7;
  m.body.position.y = Math.abs(swing) * 0.04;
  if (m.ponytail) m.ponytail.rotation.x = swing * 0.2 + 0.15;
  m.armL.rotation.x = swing * 0.3;
  // the spitflower: sway the stalk, turn the head slowly about, flare the petals and glow the mouth
  if (m.stalk && m.petals) {
    m.body.rotation.y = Math.sin(animT * 0.08) * 1.2;
    const c = 0.5 + 0.5 * Math.sin(animT * 0.3);
    const n = m.stalk.length;
    m.stalk.forEach((seg, i) => { const w = (i + 1) / n; seg.rotation.x = -0.16 * c * w; seg.rotation.z = Math.sin(animT * 0.15 + i * 0.6) * 0.05 * w; });
    m.head.rotation.x = 0.45 + 0.35 * c;
    m.petals.forEach((pt, i) => { pt.rotation.x = -0.15 - 0.6 * c + Math.sin(animT * 0.2 + i) * 0.04; });
    if (m.mouth) (m.mouth.material as THREE.MeshToonMaterial).emissiveIntensity = c * 1.6;
    m.legL.rotation.x = m.legR.rotation.x = 0; m.body.position.y = 0;
    return;
  }
  // the ladybugs: breathe their wing covers open and shut (with the hindwings beating under them)
  // so the shell and the wings beneath it can actually be looked at here
  if (m.elytronL && m.elytronR) {
    const open = 0.05 + (0.5 + 0.5 * Math.sin(animT * 0.25)) * 1.2;
    m.elytronL.rotation.z = open;
    m.elytronR.rotation.z = -open;
    const beat = open * 0.55 + Math.sin(animT * 1.4) * 0.45;
    if (m.hindwingL) m.hindwingL.rotation.z = beat;
    if (m.hindwingR) m.hindwingR.rotation.z = -beat;
  }
}

// ------------------------------------------------------------------ UI
const list = $('list');
function buildList(filter = '') {
  list.innerHTML = '';
  let first: [Entry, HTMLButtonElement] | null = null;
  for (const c of catalog) {
    const items = c.items.filter((i) => i.name.toLowerCase().includes(filter.toLowerCase()));
    if (!items.length) continue;
    const h = document.createElement('div'); h.className = 'cat'; h.textContent = c.name; list.appendChild(h);
    for (const it of items) {
      const b = document.createElement('button'); b.textContent = it.name; b.onclick = () => show(it, b); list.appendChild(b);
      if (!first) first = [it, b];
    }
  }
  return first;
}
const first = buildList();
if (first) show(first[0], first[1]);
$<HTMLInputElement>('search').oninput = (ev) => { const f = buildList((ev.target as HTMLInputElement).value); if (f && !current) show(f[0], f[1]); };
$('mode').querySelectorAll('button').forEach((b) => b.onclick = () => { mode = b.dataset.m as 'game' | 'free'; $('mode').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b)); layout(); });
$('facing').querySelectorAll('button').forEach((b) => b.onclick = () => { facing = +b.dataset.f!; $('facing').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b)); applyFacing(); });
$<HTMLInputElement>('zoom').oninput = (ev) => { zoom = +(ev.target as HTMLInputElement).value; $('zoomv').textContent = zoom + '×'; layout(); };
gridCb.onchange = () => { ground.visible = gridCb.checked; gridHelper.visible = gridCb.checked && mode === 'free'; };
window.addEventListener('resize', layout);
layout();

// ------------------------------------------------------------------ loop
let last = performance.now();
let grassTime = 0;
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  grassTime += dt;
  grass.setTime(grassTime); // keep the wind blowing even on non-grass entries (it's one uniform)
  updateFoliage(grassTime);
  animate(dt);
  gridHelper.visible = gridCb.checked && mode === 'free';
  if (mode === 'game') {
    if (postCb.checked) {
      renderer.setRenderTarget(rt); renderer.render(scene, gameCam);
      renderer.setRenderTarget(null); renderer.render(postScene, postCam);
    } else { renderer.setRenderTarget(null); renderer.render(scene, gameCam); }
  } else {
    controls.update();
    renderer.setRenderTarget(null); renderer.render(scene, freeCam);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
