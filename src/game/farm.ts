/**
 * The farm, drawn.
 *
 * `village.ts` simulates the fields; this file turns that state into the world. One instanced mesh of
 * tilled soil carries the ground's state (its per-instance colour is the tile's moisture, so a watered
 * row reads wet from the plaza), one instanced bucket per (crop, stage) carries the plants, and the
 * farmer is driven by the simulation's own body: position, facing and walk cycle copied onto his NPC,
 * and a pose built from the action he is in the middle of — with the tool that action calls for (a hoe
 * for breaking ground, a seed pouch for sowing, a watering can for watering, a basket that visibly
 * fills as the field comes in).
 *
 * Two rules keep it honest:
 *  - The view never changes the simulation. It reads tiles and the farmer, and it drains the village's
 *    event queue for the moments worth a particle: a seed leaving the hand, a can tipping, a crop coming
 *    off the plant, chaff off one that was left too long.
 *  - Nothing is rebuilt that had to be. Buckets refresh on a 12 Hz cadence or when the farm's revision
 *    moves, never every frame, so a village full of growing crops costs nothing to look at.
 */
import * as THREE from 'three';
import { clamp, lerp, hash2 } from './constants';
import { getGradientMap, UNIT_BOX, UNIT_SPHERE, UNIT_OCTA, type Humanoid } from './models';
import { cropGeo, cropWindMaterial, furrowGeo, wiltGeo, buildWateringCan, buildSeedPouch, buildBasket, produceGeo, seedGeo, dropGeo } from './crops';
import { CROPS, WATER_CAN, ACT_MOMENT, cropStages, type CropId, type FarmTile, type VillageEvent, type VillageState } from './village';
import { Effect, type Npc, type NpcController } from './entities';
import type { Vec2, World } from './world';

/** what the view may touch: the scene to draw into, the world to place things on, the sim to read */
export interface FarmCtx {
  scene: THREE.Scene;
  world: World;
  village: VillageState;
  spawnEffect(e: Effect): void;
}

// ------------------------------------------------------------------ palette
// Soil moisture is a *multiplier* over the dirt tone baked into `furrowGeo()`: dry ground keeps it
// sun-bleached, wet ground darkens it, and the instant after the can tips it takes a cold sheen.
const SOIL_DRY = new THREE.Color(1.14, 1.06, 0.94);
const SOIL_WET = new THREE.Color(0.4, 0.34, 0.32);
const SOIL_FLASH = new THREE.Color(0.62, 0.78, 1.0);

const seedMat = new THREE.MeshBasicMaterial({ color: 0xe8d08a });
const dropMat = new THREE.MeshBasicMaterial({ color: 0xaee4ff });
const dustMat = new THREE.MeshBasicMaterial({ color: 0xc0a077 });
const chaffMat = new THREE.MeshBasicMaterial({ color: 0x9a8b62 });
const SEED_GEO = seedGeo();
const DROP_GEO = dropGeo();

const ease = (p: number) => p * p * (3 - 2 * p);

// ------------------------------------------------------------------ the moments
// All of these follow the game's effect convention (see entities.ts): children are placed at absolute
// world x/z, and `spawnEffect` lifts the whole group to the terrain height, so a `y` here means "above
// the ground at that spot".

/** seeds leaving the hand: three kernels on a flat arc into the furrow, a puff of dust where they land */
export function fxSow(from: Vec2, to: Vec2): Effect {
  const kernels: { m: THREE.Mesh; lo: number; arc: number; spin: number }[] = [];
  const dust: { m: THREE.Mesh; a: number; r: number }[] = [];
  const e = new Effect(0.62, (p) => {
    for (const k of kernels) {
      const t = clamp((p - k.lo) / (1 - k.lo), 0, 1);
      const x = lerp(from.x, to.x, t), z = lerp(from.z, to.z, t);
      // a flat lob that lands and stays: the last tenth of it is the kernel settling into the soil
      const y = lerp(0.7, 0.03, t * t) + Math.sin(Math.min(1, t * 1.08) * Math.PI) * k.arc;
      k.m.position.set(x, y, z);
      k.m.rotation.set(k.spin * t * 7, k.spin * t * 5, t * 3);
      const s = 1 - 0.35 * p;
      k.m.scale.set(s, s, s);
    }
    for (const d of dust) {
      const t = clamp((p - 0.72) / 0.28, 0, 1);
      const r = 0.05 + t * d.r;
      d.m.position.set(to.x + Math.cos(d.a) * r, 0.03 + t * 0.1, to.z + Math.sin(d.a) * r * 0.6);
      const s = (1 - t) * 0.08;
      d.m.scale.set(s, s, s);
    }
  });
  for (let i = 0; i < 3; i++) {
    const m = new THREE.Mesh(SEED_GEO, seedMat);
    e.group.add(m);
    kernels.push({ m, lo: i * 0.08, arc: 0.3 + i * 0.06, spin: 1 + i });
  }
  for (let i = 0; i < 4; i++) {
    const m = new THREE.Mesh(UNIT_SPHERE, dustMat);
    e.group.add(m);
    dust.push({ m, a: (i / 4) * Math.PI * 2 + 0.4, r: 0.18 + (i % 2) * 0.08 });
  }
  return e.at(to.x, to.z);
}

/** a can's worth of water: a fan of droplets off the rose, a sheen spreading on the soil */
export function fxWater(from: Vec2, to: Vec2): Effect {
  const drops: { m: THREE.Mesh; lo: number; sx: number; sz: number; h: number }[] = [];
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.12, 0.34, 14).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x7fd0f0, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide }),
  );
  ring.position.set(to.x, 0.035, to.z);
  ring.visible = false;
  const e = new Effect(0.66, (p) => {
    for (const d of drops) {
      const u = clamp((p * 1.05 - d.lo) / 0.6, 0, 1);
      d.m.visible = u > 0 && u < 1;
      if (!d.m.visible) continue;
      // gravity in the second half of the arc: the water lifts off the rose and then falls
      const x = lerp(from.x + 0.2, to.x + d.sx, u), z = lerp(from.z, to.z + d.sz, u);
      const y = lerp(0.6, 0.03, u * u) + d.h * Math.sin(Math.min(1, u * 1.3) * Math.PI);
      d.m.position.set(x, y, z);
      const s = 1 - u * 0.3;
      d.m.scale.set(s, 1 + u * 0.9, s);
    }
    const rp = clamp((p - 0.4) / 0.55, 0, 1);
    ring.visible = rp > 0 && rp < 1;
    const rs = 0.7 + rp * 0.9;
    ring.scale.set(rs, 1, rs);
    (ring.material as THREE.MeshBasicMaterial).opacity = 0.5 * (1 - rp);
  });
  for (let i = 0; i < 11; i++) {
    const m = new THREE.Mesh(DROP_GEO, dropMat);
    e.group.add(m);
    const a = (i / 11) * Math.PI * 2;
    drops.push({
      m,
      lo: (i % 4) * 0.035 + hash2(i, 1, 9) * 0.05,
      sx: Math.cos(a) * (0.1 + hash2(i, 2, 3) * 0.2),
      sz: Math.sin(a) * (0.08 + hash2(i, 3, 4) * 0.18),
      h: 0.1 + hash2(i, 4, 5) * 0.12,
    });
  }
  e.group.add(ring);
  return e.at(to.x, to.z);
}

/** a hoe coming down: clods kicked up and out of the furrow */
export function fxDig(to: Vec2, dir: Vec2): Effect {
  const clods: { m: THREE.Mesh; vx: number; vy: number; vz: number; spin: number }[] = [];
  const e = new Effect(0.5, (p, t) => {
    for (const c of clods) {
      c.m.position.set(to.x + c.vx * t, 0.06 + c.vy * t - 1.9 * t * t, to.z + c.vz * t);
      c.m.rotation.set(c.spin * t * 6, c.spin * t * 4, t * 2);
      const s = (1 - p * 0.6) * 0.09;
      c.m.scale.set(s, s, s);
    }
  });
  const base = Math.atan2(dir.z, dir.x);
  for (let i = 0; i < 6; i++) {
    const m = new THREE.Mesh(UNIT_BOX, new THREE.MeshBasicMaterial({ color: i % 2 ? 0x7d5836 : 0x563619 }));
    e.group.add(m);
    const a = base + (i / 6 - 0.5) * 2.4;
    const sp = 0.7 + (i % 3) * 0.35;
    clods.push({ m, vx: Math.cos(a) * sp, vz: Math.sin(a) * sp * 0.7, vy: 1.1 + (i % 2) * 0.5, spin: 1 + i * 0.4 });
  }
  return e.at(to.x, to.z);
}

/** a crop coming off the plant: the produce arcs into the basket, a green pop where it grew */
export function fxPick(to: Vec2, crop: CropId, count: number): Effect {
  const items: { m: THREE.Mesh; fromX: number; fromZ: number; a: number }[] = [];
  const pops: THREE.Mesh[] = [];
  const geo = produceGeo(CROPS[crop]);
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const e = new Effect(0.55, (p) => {
    const t = clamp(p * 1.1, 0, 1);
    for (const it of items) {
      it.m.position.set(lerp(it.fromX, to.x, t), lerp(0.3, 0.9, t) + Math.sin(t * Math.PI) * 0.4, lerp(it.fromZ, to.z, t));
      it.m.rotation.y = t * 5 + it.a;
      const s = 1 - 0.4 * Math.max(0, t - 0.75) * 4;
      it.m.scale.set(s, s, s);
    }
    for (const q of pops) {
      const s = (1 - p) * 0.16;
      q.scale.set(s, s * 0.6, s);
      q.position.y = 0.16 + p * 0.3;
    }
  });
  for (let i = 0; i < Math.min(3, Math.max(1, count)); i++) {
    const m = new THREE.Mesh(geo, mat);
    e.group.add(m);
    const a = (i / 3) * Math.PI * 2;
    items.push({ m, a, fromX: to.x + Math.cos(a) * 0.18, fromZ: to.z + Math.sin(a) * 0.18 });
  }
  for (let i = 0; i < 3; i++) {
    const q = new THREE.Mesh(UNIT_SPHERE, new THREE.MeshBasicMaterial({ color: 0x74c256 }));
    q.position.set(to.x + (i - 1) * 0.12, 0.2, to.z + (i % 2 ? 0.09 : -0.07));
    e.group.add(q);
    pops.push(q);
  }
  return e.at(to.x, to.z);
}

/** a stage change — and, with `ripe`, the moment a row is worth picking */
export function fxSprout(to: Vec2, ripe: boolean): Effect {
  const bits: THREE.Mesh[] = [];
  let ring: THREE.Mesh | null = null;
  const e = new Effect(ripe ? 0.55 : 0.36, (p) => {
    for (let i = 0; i < bits.length; i++) {
      const b = bits[i];
      const s = Math.sin(p * Math.PI) * (ripe ? 0.15 : 0.1);
      b.scale.set(s, s * 1.3, s);
      b.position.y = 0.14 + p * (ripe ? 0.5 : 0.26);
    }
    if (ring) {
      const rs = 0.5 + p * 1.6;
      ring.scale.set(rs, 1, rs);
      ring.visible = p < 1;
      (ring.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - p);
    }
  });
  for (let i = 0; i < 4; i++) {
    const b = new THREE.Mesh(UNIT_OCTA, new THREE.MeshBasicMaterial({ color: ripe ? 0xfff0a0 : 0xa8e878 }));
    b.position.set(to.x + Math.cos((i / 4) * Math.PI * 2) * 0.22, 0.14, to.z + Math.sin((i / 4) * Math.PI * 2) * 0.16);
    e.group.add(b);
    bits.push(b);
  }
  if (ripe) {
    ring = new THREE.Mesh(
      new THREE.RingGeometry(0.28, 0.42, 16).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffe27a, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide }),
    );
    ring.position.set(to.x, 0.045, to.z);
    e.group.add(ring);
  }
  return e.at(to.x, to.z);
}

/** a crop left too long: it shakes itself apart into chaff */
export function fxWilt(to: Vec2): Effect {
  const bits: { m: THREE.Mesh; a: number; s: number }[] = [];
  const e = new Effect(0.6, (p) => {
    for (const b of bits) {
      const r = 0.06 + p * b.s;
      b.m.position.set(to.x + Math.cos(b.a) * r, 0.3 - p * 0.26, to.z + Math.sin(b.a) * r * 0.7);
      const s = (1 - p) * 0.07;
      b.m.scale.set(s, s, s);
    }
  });
  for (let i = 0; i < 5; i++) {
    const m = new THREE.Mesh(UNIT_BOX, chaffMat);
    e.group.add(m);
    bits.push({ m, a: (i / 5) * Math.PI * 2, s: 0.3 + (i % 2) * 0.2 });
  }
  return e.at(to.x, to.z);
}

/** produce dumped on the cart at the end of a round: a small heap and the village's money */
export function fxDeliver(at: Vec2, n: number): Effect {
  const items: THREE.Mesh[] = [];
  const glint = new THREE.Mesh(UNIT_OCTA, new THREE.MeshBasicMaterial({ color: 0xfff2a0 }));
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const ids = Object.keys(CROPS) as CropId[];
  const e = new Effect(0.75, (p) => {
    for (const it of items) {
      const t = clamp(p * 1.7 - (it.userData.lo as number), 0, 1);
      it.position.y = 0.42 + Math.sin(t * Math.PI) * 0.28;
      it.rotation.y = t * 3;
    }
    const s = Math.sin(p * Math.PI) * 0.26;
    glint.scale.set(s, s, s);
    glint.position.y = 0.66 + p * 0.34;
  });
  for (let i = 0; i < Math.min(4, Math.max(1, n)); i++) {
    const m = new THREE.Mesh(produceGeo(CROPS[ids[i % ids.length]]), mat);
    m.position.set(at.x + (i - 1.5) * 0.15, 0.42, at.z + (i % 2 ? 0.07 : -0.05));
    m.userData.lo = i * 0.07;
    e.group.add(m);
    items.push(m);
  }
  glint.position.set(at.x, 0.66, at.z);
  e.group.add(glint);
  return e.at(at.x, at.z);
}

// ------------------------------------------------------------------ the view
/**
 * The farm's renderer: soil, crops and the farmer's rig. Built by the Game next to the village state;
 * `update` runs once per frame with it, `onEvents` gets the state's drained queue.
 */
export class FarmView {
  root = new THREE.Group();
  /** the rig that lets the simulation drive the farmer NPC — hand it to `Game` to attach to the Npc */
  readonly rig: FarmerRig;

  private soil: THREE.InstancedMesh;
  /** one instanced mesh per `crop|stage` bucket (`wilt` for a crop that went to seed) */
  private buckets = new Map<string, THREE.InstancedMesh>();
  private geos = new Map<string, THREE.BufferGeometry>();
  /** per-tile pop: 1 just after a stage change, decaying — the plant stretches as it goes up */
  private pops: Float32Array;
  private lastRev = -1;
  private refreshT = 0;
  private scratch = {
    m4: new THREE.Matrix4(), q: new THREE.Quaternion(), p: new THREE.Vector3(), s: new THREE.Vector3(),
    up: new THREE.Vector3(0, 1, 0), col: new THREE.Color(),
  };

  constructor(private ctx: FarmCtx) {
    const cap = Math.max(1, ctx.village.tiles.length);
    this.pops = new Float32Array(cap);
    this.root.name = 'farm';

    const soilMat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: getGradientMap() });
    this.soil = new THREE.InstancedMesh(furrowGeo(), soilMat, cap);
    this.soil.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.soil.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
    this.soil.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.soil.count = 0;
    this.soil.visible = false;
    this.soil.frustumCulled = false; // instances span the village; the geometry's own bound would cull them
    this.root.add(this.soil);
    ctx.scene.add(this.root);
    this.rig = new FarmerRig(ctx);
  }

  /** point the rig at the farmer NPC it drives */
  bindFarmer(npc: Npc) { this.rig.bind(npc); }

  /** force a rebuild (run restart, a plot unlocked, a save loaded) */
  invalidate() {
    this.lastRev = -1;
    this.refreshT = 0;
  }

  update(dt: number) {
    const v = this.ctx.village;
    let popLive = false;
    for (let i = 0; i < v.tiles.length; i++) {
      if (this.pops[i] > 0) { this.pops[i] = Math.max(0, this.pops[i] - dt * 3); popLive = true; }
    }
    this.refreshT -= dt;
    if (this.lastRev !== v.rev || this.refreshT <= 0 || popLive) {
      this.refreshT = 0.08;
      this.lastRev = v.rev;
      this.rebuild();
    }
  }

  /** the moments worth a particle, straight off the simulation's queue */
  onEvents(evs: VillageEvent[]) {
    const v = this.ctx.village;
    for (const ev of evs) {
      const to = { x: ev.x, z: ev.z };
      // `from` is whoever did the work — the farmer's hands, or the player standing in the rows
      const from = ev.from ?? { x: v.farmer.x, z: v.farmer.z };
      switch (ev.kind) {
        case 'sow': this.ctx.spawnEffect(fxSow(from, to)); break;
        case 'water': this.ctx.spawnEffect(fxWater(from, to)); break;
        case 'till':
        case 'clear': this.ctx.spawnEffect(fxDig(to, { x: from.x - ev.x, z: from.z - ev.z })); break;
        case 'harvest': this.ctx.spawnEffect(fxPick(from, ev.crop ?? 'turnip', ev.n)); break;
        case 'deliver': this.ctx.spawnEffect(fxDeliver(from, ev.n)); break;
        case 'sprout':
        case 'ripe': {
          const tile = v.tileAt(Math.floor(ev.x), Math.floor(ev.z));
          if (tile) this.pops[tile.i] = 1;
          this.ctx.spawnEffect(fxSprout(to, ev.kind === 'ripe'));
          break;
        }
        case 'wilt': this.ctx.spawnEffect(fxWilt(to)); break;
        case 'unlock': this.ctx.spawnEffect(fxSprout({ x: ev.x, z: ev.z }, true)); break;
        case 'day': break; // the Game turns days into toasts, not particles
      }
    }
  }

  // ---------------------------------------------------------------- instancing
  private bucket(key: string, geo: THREE.BufferGeometry): THREE.InstancedMesh {
    let b = this.buckets.get(key);
    if (!b) {
      b = new THREE.InstancedMesh(geo, cropWindMaterial(), Math.max(1, this.ctx.village.tiles.length));
      b.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      b.count = 0;
      b.visible = false;
      b.frustumCulled = false;
      this.root.add(b);
      this.buckets.set(key, b);
    }
    return b;
  }

  /** geometry for a crop at a stage, cached per bucket key (a field of 40 turnips shares one buffer) */
  private geoFor(crop: CropId | null, stage: number, wilted: boolean): THREE.BufferGeometry {
    const key = wilted || !crop ? 'wilt' : `${crop}|${stage}`;
    let g = this.geos.get(key);
    if (!g) {
      g = crop && !wilted ? cropGeo(CROPS[crop], stage) : wiltGeo();
      this.geos.set(key, g);
    }
    return g;
  }

  /** the ground's top surface in a tile: the highest corner, so an overlay never sinks into a slope */
  private tileTop(t: FarmTile): number {
    const w = this.ctx.world;
    return Math.max(w.cornerH(t.x, t.z), w.cornerH(t.x + 1, t.z), w.cornerH(t.x, t.z + 1), w.cornerH(t.x + 1, t.z + 1));
  }

  private rebuild() {
    const v = this.ctx.village;
    const s = this.scratch;
    for (const b of this.buckets.values()) b.count = 0;
    let soilN = 0;
    for (const t of v.tiles) {
      const y = this.tileTop(t) + 0.014;
      if (t.tilled) {
        s.col.copy(SOIL_DRY).lerp(SOIL_WET, clamp(t.moist, 0, 1));
        if (t.moist > 0.9) s.col.lerp(SOIL_FLASH, ((t.moist - 0.9) / 0.1) * 0.6);
        if (soilN < this.soil.instanceColor!.count) this.soil.setColorAt(soilN, s.col);
        s.p.set(t.x + 0.5, y - t.moist * 0.008, t.z + 0.5); // soaked earth settles a touch
        s.q.setFromAxisAngle(s.up, 0);
        s.s.set(1, 1, 1);
        s.m4.compose(s.p, s.q, s.s);
        this.soil.setMatrixAt(soilN++, s.m4);
      }
      if (!t.crop) continue;
      const last = cropStages(t.crop) - 1;
      const geo = this.geoFor(t.crop, t.stage, t.wilted);
      const b = this.bucket(t.wilted ? 'wilt' : `${t.crop}|${t.stage}`, geo);
      if (b.count >= b.instanceMatrix.count) continue;
      // the plant swells between stages rather than jumping, and pops a little as it changes
      const grow = clamp(t.stage + (t.stage >= last ? 1 : t.grow), 0, last);
      const pop = t.i < this.pops.length ? this.pops[t.i] : 0;
      const sc = 0.6 + 0.4 * (grow / last);
      s.p.set(
        t.x + 0.5 + (hash2(t.x, t.z, 17) - 0.5) * 0.12,
        y,
        t.z + 0.5 + (hash2(t.x, t.z, 18) - 0.5) * 0.12,
      );
      s.q.setFromAxisAngle(s.up, hash2(t.x, t.z, 19) * Math.PI * 2);
      s.s.set(sc * (1 + pop * 0.1), sc * (1 + pop * 0.3), sc * (1 + pop * 0.1));
      s.m4.compose(s.p, s.q, s.s);
      b.setMatrixAt(b.count, s.m4);
      b.count++;
    }
    this.soil.count = soilN;
    this.soil.visible = soilN > 0;
    this.soil.instanceMatrix.needsUpdate = true;
    if (this.soil.instanceColor) this.soil.instanceColor.needsUpdate = true;
    for (const b of this.buckets.values()) {
      b.visible = b.count > 0;
      b.instanceMatrix.needsUpdate = true;
    }
  }

  dispose() {
    this.ctx.scene.remove(this.root);
    for (const g of this.geos.values()) g.dispose();
    for (const b of this.buckets.values()) b.geometry.dispose();
    this.geos.clear();
    this.buckets.clear();
    this.rig.dispose();
  }
}

// ------------------------------------------------------------------ the farmer
/**
 * The farmer's body, driven by the simulation.
 *
 * The sim owns where he is and what he is doing; this copies that onto his NPC (the Npc's own
 * `sync()` puts the model on the ground at the position and facing we write) and poses him for it. The
 * pose is *smoothed*, not keyframed: every action states where its joints should be and the joints chase
 * that target, so an action that ends mid-swing returns to idle without a snap — and a 15 fps stretch
 * does not stutter a hoe.
 */
export class FarmerRig implements NpcController {
  private npc: Npc | null = null;
  private can = buildWateringCan();
  private pouch = buildSeedPouch();
  private basket = buildBasket(Object.values(CROPS));
  private hoe: THREE.Object3D | null = null;
  private canMat: THREE.MeshToonMaterial | null = null;

  // the smoothed joints
  private armR = 0; private armRz = 0.1; private armL = 0; private armLz = -0.1;
  private lean = 0; private headDown = 0; private tilt = 0; private crouch = 0;

  constructor(private ctx: FarmCtx) {
    this.can.visible = false;
    this.can.position.set(0, -0.3, 0.05);
    this.can.scale.setScalar(0.62);
    this.canMat = (this.can.children[0] as THREE.Mesh).material as THREE.MeshToonMaterial;
    this.basket.group.visible = false;
    this.basket.group.position.set(0, -0.26, 0.14);
    this.basket.group.scale.setScalar(0.6);
  }

  /** hand the rig the farmer NPC: the tools go into his hands, and the Npc's update calls us */
  bind(npc: Npc) {
    this.npc = npc;
    npc.controller = this;
    npc.model.body.add(this.pouch);
    npc.model.handL.add(this.can);
    npc.model.handL.add(this.basket.group);
    this.hoe = npc.model.handR.getObjectByName('tool') ?? null;
    npc.pose = (m: Humanoid, _npc: Npc, dt: number) => this.pose(m, dt);
  }

  /** every frame, from the NPC's own update: the sim's body onto the NPC */
  update(dt: number, npc: Npc) {
    const f = this.ctx.village.farmer;
    npc.pos.x = f.x;
    npc.pos.z = f.z;
    npc.facing = f.facing;
    npc.moving = f.moving;
    if (f.moving) npc.animT += dt * 9.2;
    // the basket fills up as he picks, and the tool in his hands follows the job
    this.basket.group.visible = f.basketN > 0;
    for (let i = 0; i < this.basket.slots.length; i++) this.basket.slots[i].visible = i < f.basketN;
    const carryingWater = f.act === 'water' || (f.act === 'walk' && f.jobKind === 'water');
    this.can.visible = carryingWater;
    if (this.hoe) {
      // the hoe comes out for the digging jobs and rides on his shoulder while he walks; a pick or a
      // sowing needs both hands, so it goes away
      this.hoe.visible = f.act !== 'harvest' && f.act !== 'sow' && f.act !== 'rest' && f.act !== 'fetch';
    }
    const w = clamp(f.water / WATER_CAN, 0, 1);
    if (this.canMat) this.canMat.color.setRGB(0.2 + 0.25 * w, 0.32 + 0.26 * w, 0.52 + 0.36 * w);
  }

  /** the action's target pose, chased by the smoothing below */
  private pose(m: Humanoid, dt: number) {
    const f = this.ctx.village.farmer;
    const p = f.actDur > 0 ? clamp(f.actT / f.actDur, 0, 1) : 0;
    const wind = p < ACT_MOMENT ? p / ACT_MOMENT : 1; // 0..1 up to the moment the tool lands
    const follow = p < ACT_MOMENT ? 0 : (p - ACT_MOMENT) / (1 - ACT_MOMENT); // 0..1 after it
    let armR = 0, armRz = 0.1, armL = 0, armLz = -0.1, lean = 0, headDown = 0, tilt = 0, crouch = 0;
    switch (f.act) {
      case 'till':
      case 'clear':
        // the hoe goes up over the shoulder, then down into the ground, and he bends into it
        armR = lerp(0, -2.15, ease(wind)) + lerp(0, 2.9, ease(follow));
        armRz = 0.34 - 0.24 * follow;
        lean = 0.1 + 0.16 * wind + 0.34 * ease(follow);
        headDown = 0.3 * ease(follow);
        break;
      case 'sow':
        // hand in the pouch at his hip, then a flick of the wrist that scatters the seed
        armR = 0.95 * ease(wind) - 2.2 * ease(follow);
        armRz = 0.5 * ease(wind) - 0.4 * ease(follow);
        armL = -0.25 * ease(wind);
        lean = 0.14 * ease(wind) + 0.1 * ease(follow);
        headDown = 0.18;
        break;
      case 'water':
        // the can lifts and tips: the pour *is* the tilt, and it holds until the action closes
        armL = -1.2 * ease(wind) + 0.55 * ease(follow);
        armLz = -0.35;
        tilt = 1.2 * ease(wind) - 0.4 * ease(follow);
        armR = -0.25 * ease(wind);
        lean = 0.08 * ease(wind);
        break;
      case 'harvest':
        // both hands down into the plant, and he comes up with the yield
        armR = 1.05 * ease(wind) - 0.5 * ease(follow);
        armL = 0.95 * ease(wind) - 0.6 * ease(follow);
        lean = 0.42 * ease(wind) - 0.1 * ease(follow);
        crouch = 0.1 * ease(wind);
        headDown = 0.4 * ease(wind);
        break;
      case 'fetch':
        // a nod and a heave of the basket off the hip onto the cart
        armL = -0.55;
        armR = -0.35;
        lean = 0.06;
        headDown = 0.12;
        break;
      case 'rest':
        // hands on hips, and a stretch now and then so a rest is not a statue
        armR = -0.15; armRz = 0.75;
        armL = -0.15; armLz = -0.75;
        if (p > 0.3 && p < 0.72) { armR = -2.4; armL = -2.2; lean = -0.16; headDown = -0.3; }
        break;
      case 'walk':
        armR = f.jobKind === 'water' ? -0.3 : -0.55; // the tool rides on the shoulder between rows
        armL = f.jobKind === 'water' ? -0.85 : 0;
        tilt = f.jobKind === 'water' ? 0.2 : 0;
        break;
      default:
        break;
    }
    // frame-rate independent chase: stiff enough that a swing has weight, quick enough that a
    // released pose is back on the idle pose before the next one starts
    const k = 1 - Math.exp(-Math.max(0.0001, dt) * 15);
    this.armR += (armR - this.armR) * k;
    this.armRz += (armRz - this.armRz) * k;
    this.armL += (armL - this.armL) * k;
    this.armLz += (armLz - this.armLz) * k;
    this.lean += (lean - this.lean) * k;
    this.headDown += (headDown - this.headDown) * k;
    this.tilt += (tilt - this.tilt) * k;
    this.crouch += (crouch - this.crouch) * k;
    m.armR.rotation.set(this.armR, 0, this.armRz);
    m.armL.rotation.set(this.armL, 0, this.armLz);
    m.body.rotation.x = this.lean;
    m.head.rotation.x = this.headDown;
    m.body.position.y -= this.crouch;
    this.can.rotation.x = this.tilt;
  }

  dispose() {
    const npc = this.npc;
    if (!npc) return;
    npc.controller = null;
    npc.pose = null;
    npc.model.body.remove(this.pouch);
    npc.model.handL.remove(this.can);
    npc.model.handL.remove(this.basket.group);
    if (this.hoe) this.hoe.visible = true;
  }
}
