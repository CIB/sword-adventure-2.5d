/**
 * Model viewer: browse every procedural model in the game (characters, houses, props, foliage...)
 * in either the game's exact oblique-shear projection (with the pixel post-process) or a free orbit camera.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  buildHeroine, buildSoldier, buildVillager, buildDog, VILLAGER_LOOKS, buildRock, buildStump,
  buildFence, buildHouse, buildProp, buildHeart, buildRupee, buildArrow, buildJavelinProjectile,
  buildFernGeo, buildTallGrassGeo, buildBriarGeo, buildLilyGeo, buildBoulderGeo, vegObject, swayToon, type Humanoid,
} from '../game/models';
import type { PropKind, HouseSpec, EnemyKind } from '../game/world';
import { World } from '../game/world';
import { GrassSystem } from '../game/grass';
import { FoliageSystem, TREE_KINDS, type TreeKind } from '../game/foliage';
import { setWindView, setWindBasisFromCamera } from '../game/wind';
import { POST_VS, POST_FS } from '../game/game';
import { VIEW_W, VIEW_H, VIEW_TILES_X, VIEW_TILES_Y, CAM_HEIGHT, SHEAR, FACING_ANGLE } from '../game/constants';

type Entry = { name: string; build: () => { obj: THREE.Object3D; humanoid?: Humanoid; footprint?: number } };
type Cat = { name: string; items: Entry[] };

const hum = (h: Humanoid) => ({ obj: h.root, humanoid: h });
const PROPS: PropKind[] = ['well', 'sign', 'stall', 'bench', 'weathercock', 'lamp', 'barrel', 'crate', 'flowerpot', 'hedge', 'log', 'menhir', 'cart', 'hay', 'scarecrow', 'campfire', 'tent', 'banner', 'tower', 'ruinwall', 'pillar', 'crown', 'windmill', 'anvil', 'forge', 'cauldron', 'grave', 'deadtree', 'reeds', 'rosebush', 'beehive', 'wheelbarrow', 'statue', 'mushroom', 'amberrock'];
const world = new World();
const grass = new GrassSystem(world);
const foliage = new FoliageSystem(world);
/** A plant specimen for the viewer: the real thing, one instance of it, centred on the origin. */
const plant = (opts: Parameters<FoliageSystem['buildSpecimen']>[0], footprint = 4) => () => ({ obj: foliage.buildSpecimen(opts), footprint });

const catalog: Cat[] = [
  { name: 'Heroine', items: [{ name: 'Aria', build: () => hum(buildHeroine()) }] },
  { name: 'Fallen Knights', items: (['sword', 'spear', 'javelin', 'archer'] as EnemyKind[]).map((k) => ({ name: k[0].toUpperCase() + k.slice(1) + ' knight', build: () => hum(buildSoldier(k)) })) },
  { name: 'Villagers', items: [...Object.keys(VILLAGER_LOOKS).map((id) => ({ name: id[0].toUpperCase() + id.slice(1), build: () => hum(buildVillager(VILLAGER_LOOKS[id])) })), { name: 'Dog', build: () => hum(buildDog()) }] },
  { name: 'Houses', items: world.houses.map((h, i) => ({ name: `House ${i + 1} (${h.w}×${h.d}${h.sign && h.sign !== 'none' ? ', ' + h.sign : ''})`, build: () => { const spec: HouseSpec = { ...h, x: -h.w / 2, z: -h.d / 2 }; return { obj: buildHouse(spec), footprint: Math.max(h.w, h.d) + 2 }; } })) },
  { name: 'Foliage', items: [
    // leaf-card crowns: every species big and small, plus patches of the real map to judge density
    ...TREE_KINDS.flatMap((k: TreeKind) => [
      { name: `Tree (${k})`, build: plant({ kind: k, scale: 1 }) },
      { name: `Tree (${k}, small)`, build: plant({ kind: k, scale: 0.6 }, 3) },
    ]),
    { name: 'Grove (Willowmere)', build: () => ({ obj: foliage.buildPatch(90, 20, 7), footprint: 16 }) },
    { name: 'Grove (border forest)', build: () => ({ obj: foliage.buildPatch(4, 4, 6), footprint: 14 }) },
    { name: 'Copse (highland pines)', build: () => ({ obj: foliage.buildPatch(180, 30, 7), footprint: 16 }) },
    { name: 'Bush', build: plant({ kind: 'bush' }, 2) },
    { name: 'Bush (berries)', build: plant({ kind: 'bush', berry: true }, 2) },
    { name: 'Bushes (patch)', build: () => ({ obj: foliage.buildPatch(44, 33, 6), footprint: 14 }) },
    { name: 'Bush stump', build: () => ({ obj: buildStump() }) },
    { name: 'Rock', build: () => ({ obj: buildRock() }) }, { name: 'Rock (mossy)', build: () => ({ obj: buildRock(1) }) }, { name: 'Rock (crystal)', build: () => ({ obj: buildRock(2) }) },
    { name: 'Boulder', build: () => ({ obj: vegObject(buildBoulderGeo()) }) },
    { name: 'Fern (swaying)', build: () => ({ obj: new THREE.Mesh(buildFernGeo(), swayToon(0.3)) }) },
    { name: 'Tall grass (swaying)', build: () => ({ obj: new THREE.Mesh(buildTallGrassGeo(), swayToon(0.34)) }) },
    { name: 'Briar (swaying)', build: () => ({ obj: new THREE.Mesh(buildBriarGeo(), swayToon(0.1)) }) },
    { name: 'Lily pads', build: () => ({ obj: vegObject(buildLilyGeo()) }) },
    { name: 'Fence post', build: () => ({ obj: buildFence() }) },
    { name: 'Grass (animated)', build: () => ({ obj: grass.buildPatch(36, 22, 12, 12), footprint: 12 }) },
  ] },
  { name: 'Props', items: PROPS.map((k) => ({ name: k[0].toUpperCase() + k.slice(1), build: () => ({ obj: buildProp({ kind: k, x: 0, z: 0 }), footprint: k === 'tower' || k === 'windmill' ? 6 : k === 'statue' ? 3 : k === 'tent' || k === 'stall' ? 4 : k === 'deadtree' ? 2.5 : 2 }) })) },
  { name: 'Pickups & projectiles', items: [
    { name: 'Heart', build: () => ({ obj: buildHeart() }) }, { name: 'Rupee (green)', build: () => ({ obj: buildRupee(false) }) }, { name: 'Rupee (blue)', build: () => ({ obj: buildRupee(true) }) },
    { name: 'Arrow', build: () => ({ obj: buildArrow() }) }, { name: 'Javelin', build: () => ({ obj: buildJavelinProjectile() }) },
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
  // leaf cards are billboards for THIS projection: point the shared screen axes at the live camera
  if (mode === 'game') setWindView(0); else setWindBasisFromCamera(freeCam);
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
