/**
 * Crop, soil and farm-tool geometry.
 *
 * `village.ts` knows what a farm tile *is*; this file knows what it *looks like*. It builds merged,
 * vertex-coloured geometries in the same idiom as the undergrowth in `models.ts` (a handful of
 * boxes/cones/spheres painted flat colours and merged into one buffer), so a whole field of one crop at
 * one stage is a single InstancedMesh — with `applyCropWind` on top, so the crops lean into the same
 * travelling gusts as the grass, the bushes and the tree canopies instead of standing like museum props.
 *
 * Geometry is generated per (crop, stage) and deterministic (`hash2` jitter, never Math.random): the
 * view rebuilds a bucket whenever a tile changes stage, and two runs have to look the same.
 *
 * Everything is sized in tiles: one unit is one tile (20 px at the internal resolution) and characters
 * are ~1.2 tall, so a mature turnip at 0.44 reads as a low clump of leaves while a staked tomato at
 * 0.88 comes up to the farmer's chest.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { hash2, clamp } from './constants';
import { withColor, getGradientMap, UNIT_BOX, UNIT_CYL } from './models';
import { cropStages, type CropSpec } from './village';

/** the wind uniforms are shared with grass/foliage/trees, so crops sway with the rest of the meadow */
import { foliageUniforms } from './foliage';

/**
 * Toon shading plus the world's wind field: same trick as the tree canopies (`applyTreeWind`) — the
 * gust is sampled at the instance's world position and the higher a vertex sits, the further it leans.
 * Crops are shorter than trees, so the bend is scaled up and the roots stay glued to the soil.
 */
export function cropWindMaterial(): THREE.MeshToonMaterial {
  const mat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: getGradientMap() });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, foliageUniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        uniform sampler2D uWindTex;
        uniform float uWindScale;
        uniform vec2 uWindDir;
        uniform float uGust;
        uniform float uSway;`,
      )
      .replace(
        '#include <project_vertex>',
        `vec4 mvPosition = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
          float bend = clamp( position.y * 2.2, 0.0, 1.0 );
          bend = bend * bend * 0.7 + bend * 0.3;
          vec2 wuv = mvPosition.xz / uWindScale + uWindDir * ( uTime * 0.13 );
          float gust = texture2D( uWindTex, wuv ).r;
          float phase = instanceMatrix[3].x * 1.7 + instanceMatrix[3].z * 2.3;
          vec2 windOff = uWindDir * ( ( gust - 0.42 ) * uGust * 1.5 );
          windOff += vec2( sin( uTime * 1.5 + phase ), cos( uTime * 1.2 + phase * 1.31 ) ) * uSway * 2.4;
          mvPosition.xz += windOff * bend;
        #endif
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;`,
      );
  };
  return mat;
}

/** a tapered leaf: a flat box, tilted outward, painted one of the crop's greens */
function leaf(len: number, wide: number, tilt: number, yaw: number, col: string, lift = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(wide, len, wide * 0.42);
  g.translate(0, len / 2, 0);
  g.rotateZ(tilt);
  g.rotateY(yaw);
  g.translate(0, lift, 0);
  return withColor(g, col);
}

/** a blade frond for root crops: thin, long, drooping */
function frond(len: number, tilt: number, yaw: number, col: string, x = 0, z = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(0.045, len, 0.028);
  g.translate(0, len / 2, 0);
  g.rotateZ(tilt);
  g.rotateY(yaw);
  g.translate(x, 0, z);
  return withColor(g, col);
}

/**
 * One plant: `crop` at growth stage `stage` (0 = seed in the ground, last = ripe).
 *
 * The stages are not just "smaller version of the next one": each one changes the *shape* — kernels,
 * then a two-leaf sprout, then the crop's own habit (fronds / bush / stake / sprawl), then fruit.
 */
export function cropGeo(crop: CropSpec, stage: number): THREE.BufferGeometry {
  const stages = cropStages(crop.id);
  const last = stages - 1;
  const p = clamp(stage / last, 0, 1);
  const parts: THREE.BufferGeometry[] = [];

  // --- stage 0: the seed. Just kernels in a dimple, with the first hook of a shoot if it is close over
  if (stage === 0) {
    parts.push(withColor(new THREE.CylinderGeometry(0.2, 0.24, 0.03, 8).translate(0, 0.015, 0), crop.shape === 'gourd' ? '#4a2f18' : '#563619'));
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + hash2(i, stage, 3) * 0.6;
      const r = 0.06 + hash2(i, stage, 4) * 0.05;
      const k = new THREE.BoxGeometry(0.055, 0.035, 0.045);
      k.translate(Math.cos(a) * r, 0.035, Math.sin(a) * r);
      k.rotateY(a);
      parts.push(withColor(k, i % 2 ? crop.fruitAlt : '#d8c284'));
    }
    if (crop.shape === 'vine' || crop.shape === 'gourd') parts.push(withColor(new THREE.BoxGeometry(0.02, 0.07, 0.02).translate(0.02, 0.06, 0), '#6aa84a'));
    return mergeGeometries(parts)!;
  }

  // --- the sprout: two seed leaves on a short pale stem, whatever the crop turns into later
  if (stage === 1) {
    parts.push(withColor(new THREE.BoxGeometry(0.035, 0.1, 0.035).translate(0, 0.05, 0), crop.stem));
    parts.push(leaf(0.11, 0.07, 0.9, 0.4, crop.leaf, 0.08));
    parts.push(leaf(0.11, 0.07, -0.9, Math.PI - 0.4, crop.leafD, 0.08));
    if (crop.shape === 'vine') parts.push(stake(0.34));
    return mergeGeometries(parts)!;
  }

  const h = crop.height * (0.42 + 0.58 * p);
  const ripe = stage >= last;
  const fruiting = p >= 0.72;
  switch (crop.shape) {
    case 'root': {
      // turnip: a rosette of fronds over the shoulder of the bulb, which shows as it swells
      const n = Math.max(3, Math.round(crop.fronds * (0.5 + 0.5 * p)));
      if (ripe) {
        const bulb = new THREE.SphereGeometry(0.5, 10, 7);
        bulb.scale(0.34, 0.26, 0.32);
        bulb.translate(0, 0.12, 0);
        parts.push(withColor(bulb, crop.fruit));
        const crown = new THREE.SphereGeometry(0.5, 10, 6);
        crown.scale(0.3, 0.14, 0.28);
        crown.translate(0, 0.24, 0);
        parts.push(withColor(crown, crop.fruitAlt)); // the purple shoulder above the soil line
      }
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + hash2(i, stage, 11) * 0.5;
        const len = h * (0.75 + hash2(i, stage, 12) * 0.4);
        const tilt = 0.5 + hash2(i, stage, 13) * 0.45;
        const r = ripe ? 0.1 : 0.03;
        parts.push(frond(len, tilt, a, i % 2 ? crop.leaf : crop.leafD, Math.cos(a) * r, Math.sin(a) * r));
      }
      if (ripe) { // a couple of leaves are always bigger on a crop worth pulling
        parts.push(leaf(0.2, 0.16, 1.1, 0.9, crop.leaf, 0.2));
        parts.push(leaf(0.2, 0.16, -1.1, Math.PI + 0.6, crop.leafD, 0.2));
      }
      break;
    }
    case 'bush': {
      // potato: a leafy hill with flowers in the middle of it; the tubers stay hidden (a lift of soil)
      const n = Math.max(3, Math.round(crop.fronds * (0.55 + 0.45 * p)));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + hash2(i, stage, 21) * 0.7;
        const rr = 0.06 + (i % 2) * 0.1;
        const clump = new THREE.SphereGeometry(0.5, 8, 6);
        clump.scale(0.26, 0.16 + 0.1 * p, 0.26);
        clump.translate(Math.cos(a) * rr, h * (0.42 + hash2(i, stage, 22) * 0.3), Math.sin(a) * rr);
        parts.push(withColor(clump, i % 2 ? crop.leaf : crop.leafD));
      }
      if (fruiting) for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + 0.5;
        const f = new THREE.SphereGeometry(0.5, 6, 5);
        f.scale(0.08, 0.05, 0.08);
        f.translate(Math.cos(a) * 0.11, h * 0.85, Math.sin(a) * 0.11);
        parts.push(withColor(f, i === 1 ? '#f4f0e4' : '#efe4b4'));
      }
      // the soil lift over the hill: this is where the yield is, out of sight
      const mound = new THREE.SphereGeometry(0.5, 9, 5);
      mound.scale(0.36, 0.1, 0.34);
      parts.push(withColor(mound, ripe ? '#7d5836' : '#6b4a2c'));
      if (ripe) for (let i = 0; i < crop.yieldMin; i++) {
        const a = 1.1 + i * 1.7;
        const t = new THREE.SphereGeometry(0.5, 7, 5);
        t.scale(0.13, 0.1, 0.11);
        t.translate(Math.cos(a) * 0.19, 0.04, Math.sin(a) * 0.19);
        parts.push(withColor(t, crop.fruit));
      }
      break;
    }
    case 'vine': {
      // tomato: a stake the plant is trained up, leaves in pairs, fruit at the middle height
      parts.push(stake(h * 1.12));
      const stem = new THREE.BoxGeometry(0.045, h, 0.045);
      stem.translate(0.01, h / 2, 0.01);
      parts.push(withColor(stem, crop.stem));
      const n = Math.max(2, Math.round(crop.fronds * (0.4 + 0.6 * p)));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + hash2(i, stage, 31) * 0.4;
        const y = h * (0.28 + 0.62 * (i / Math.max(1, n - 1)));
        parts.push(leaf(0.19, 0.13, 1.15, a, i % 2 ? crop.leaf : crop.leafD, y));
        parts.push(leaf(0.15, 0.1, 1.35, a + 2.3, i % 2 ? crop.leafD : crop.leaf, y + 0.03));
      }
      const fruits = ripe ? 3 : fruiting ? 2 : 0;
      for (let i = 0; i < fruits; i++) {
        const a = (i / Math.max(1, fruits)) * Math.PI * 2 + 0.6;
        const s = new THREE.SphereGeometry(0.5, 8, 6);
        const r = ripe ? 0.13 : 0.09;
        s.scale(r * 2, r * 2, r * 2);
        s.translate(Math.cos(a) * 0.12, h * (0.42 + 0.16 * i), Math.sin(a) * 0.12);
        parts.push(withColor(s, ripe ? crop.fruit : '#5f9a3a'));
        if (ripe) { // a green shoulder and a calyx, so the fruit reads as picked-ripe and not painted
          const cap = new THREE.ConeGeometry(0.05, 0.045, 6);
          cap.translate(Math.cos(a) * 0.12, h * (0.42 + 0.16 * i) + r, 0.12 * Math.sin(a));
          parts.push(withColor(cap, crop.leafD));
        }
      }
      break;
    }
    case 'gourd': {
      // pumpkin: a flat sprawl of big leaves and a tendril, then the fruit itself on the ground
      const n = Math.max(3, Math.round(crop.fronds * (0.5 + 0.5 * p)));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + hash2(i, stage, 41) * 0.5;
        const r = 0.12 + 0.16 * p + hash2(i, stage, 42) * 0.06;
        const pad = new THREE.BoxGeometry(0.2, 0.03, 0.18);
        pad.rotateY(a);
        pad.translate(Math.cos(a) * r, 0.05 + 0.03 * (i % 2), Math.sin(a) * r);
        parts.push(withColor(pad, i % 2 ? crop.leaf : crop.leafD));
      }
      const vine = new THREE.TorusGeometry(0.16 + 0.08 * p, 0.018, 5, 10, Math.PI * 1.3);
      vine.rotateX(-Math.PI / 2);
      vine.translate(0.02, 0.035, -0.02);
      parts.push(withColor(vine, crop.stem));
      if (fruiting) {
        const size = ripe ? 0.44 : 0.22;
        const body = new THREE.SphereGeometry(0.5, 10, 7);
        body.scale(size, size * 0.78, size * 0.92);
        body.translate(0.06, size * 0.4, 0.05);
        parts.push(withColor(body, ripe ? crop.fruit : '#4f8a3a'));
        if (ripe) {
          for (let i = 0; i < 3; i++) { // the ribs
            const rib = new THREE.BoxGeometry(0.03, size * 0.62, size * 0.9);
            rib.rotateY((i / 3) * Math.PI);
            rib.translate(0.06, size * 0.4, 0.05);
            parts.push(withColor(rib, crop.fruitAlt, 0.9));
          }
          const stub = new THREE.CylinderGeometry(0.035, 0.045, 0.09, 6);
          stub.translate(0.06, size * 0.82, 0.05);
          parts.push(withColor(stub, '#6b7a3a'));
        }
      }
      break;
    }
  }
  return mergeGeometries(parts)!;
}

/** a bamboo-ish stake a vine is trained up */
function stake(h: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(0.05, h, 0.05);
  g.translate(-0.04, h / 2, -0.04);
  const top = new THREE.BoxGeometry(0.07, 0.035, 0.07);
  top.translate(-0.04, h, -0.04);
  const a = withColor(g, '#8a7a4a');
  const b = withColor(top, '#6b5a34');
  return mergeGeometries([a, b])!;
}

/**
 * The tilled-soil overlay: the ridges a hoe leaves in the ground, one instance per worked tile. It is
 * painted with the plot's own soil tones; the view multiplies them by a per-instance colour for
 * moisture, so a watered tile is the same dirt dark and a dry one pale.
 */
export function furrowGeo(): THREE.BufferGeometry {
  const SOIL = '#8a6238', RIDGE = '#a5764a', FURROW = '#5f3f22', EDGE = '#6f4d2a';
  const parts: THREE.BufferGeometry[] = [];
  parts.push(withColor(new THREE.PlaneGeometry(0.98, 0.98).rotateX(-Math.PI / 2), SOIL));
  for (let i = 0; i < 3; i++) {
    const ridge = new THREE.BoxGeometry(0.94, 0.05, 0.15);
    ridge.translate(0, 0.02, -0.28 + i * 0.28);
    parts.push(withColor(ridge, RIDGE));
    const shade = new THREE.BoxGeometry(0.94, 0.02, 0.07);
    shade.translate(0, 0.045, -0.28 + i * 0.28 + 0.11);
    parts.push(withColor(shade, FURROW));
  }
  // a low lip around the tile, so a watered plot keeps its colour at the seam with the next row
  for (const [x, z, sx, sz] of [[0, -0.47, 0.96, 0.06], [0, 0.47, 0.96, 0.06], [-0.47, 0, 0.06, 0.96], [0.47, 0, 0.06, 0.96]] as const) {
    const lip = new THREE.BoxGeometry(sx, 0.035, sz);
    lip.translate(x, 0.012, z);
    parts.push(withColor(lip, EDGE));
  }
  return mergeGeometries(parts)!;
}

/** a kernel, for the sowing particles and the seed row by the cart */
export function seedGeo(): THREE.BufferGeometry {
  return withColor(new THREE.BoxGeometry(0.06, 0.04, 0.05), '#e0c884');
}

/** a droplet: bright, slightly blue, unlit — the water reads against the dark soil */
export function dropGeo(): THREE.BufferGeometry {
  return withColor(new THREE.BoxGeometry(0.05, 0.07, 0.05), '#9fd8f5');
}

/** a produce item for the farmer's basket and the harvest pop (painted with the crop's own colours) */
export function produceGeo(crop: CropSpec): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  switch (crop.shape) {
    case 'root': {
      const body = new THREE.SphereGeometry(0.5, 8, 6);
      body.scale(0.2, 0.17, 0.19);
      parts.push(withColor(body, crop.fruit));
      const crown = new THREE.SphereGeometry(0.5, 8, 5);
      crown.scale(0.17, 0.07, 0.16);
      crown.translate(0, 0.1, 0);
      parts.push(withColor(crown, crop.fruitAlt));
      parts.push(withColor(new THREE.BoxGeometry(0.03, 0.08, 0.03).translate(0.02, 0.16, 0), crop.leaf));
      break;
    }
    case 'bush':
      for (let i = 0; i < 2; i++) {
        const t = new THREE.SphereGeometry(0.5, 7, 5);
        t.scale(0.15, 0.11, 0.13);
        t.translate(i ? 0.07 : -0.06, 0, i ? -0.03 : 0.04);
        t.rotateY(i * 1.2);
        parts.push(withColor(t, i ? crop.fruitAlt : crop.fruit));
      }
      break;
    case 'vine': {
      const b = new THREE.SphereGeometry(0.5, 8, 6);
      b.scale(0.19, 0.18, 0.19);
      parts.push(withColor(b, crop.fruit));
      const cap = new THREE.ConeGeometry(0.05, 0.05, 6);
      cap.translate(0, 0.11, 0);
      parts.push(withColor(cap, crop.leafD));
      break;
    }
    case 'gourd': {
      const body = new THREE.SphereGeometry(0.5, 10, 7);
      body.scale(0.3, 0.24, 0.28);
      parts.push(withColor(body, crop.fruit));
      const rib = new THREE.BoxGeometry(0.025, 0.2, 0.28);
      rib.rotateY(0.8);
      parts.push(withColor(rib, crop.fruitAlt, 0.9));
      const stub = new THREE.CylinderGeometry(0.03, 0.035, 0.06, 6);
      stub.translate(0, 0.15, 0);
      parts.push(withColor(stub, '#6b7a3a'));
      break;
    }
  }
  return mergeGeometries(parts)!;
}

/**
 * The farmer's watering can: a body, a long spout with a rose on the end, a top handle. Built as a
 * group so the view can hang it off his hand and *tilt* it — the whole watering animation is this one
 * rotation plus the droplets the sim spawns.
 */
export function buildWateringCan(): THREE.Group {
  const g = new THREE.Group();
  const tin = new THREE.MeshToonMaterial({ color: 0x5f86c8 });
  const tinD = new THREE.MeshToonMaterial({ color: 0x3f5f96 });
  const body = new THREE.Mesh(UNIT_CYL, tin);
  body.scale.set(0.3, 0.26, 0.3);
  body.position.y = -0.02;
  const spout = new THREE.Mesh(UNIT_CYL, tin);
  spout.scale.set(0.07, 0.34, 0.07);
  spout.position.set(0, 0.05, 0.19);
  spout.rotation.x = -0.85;
  const rose = new THREE.Mesh(UNIT_CYL, tinD);
  rose.scale.set(0.13, 0.05, 0.13);
  rose.position.set(0, 0.18, 0.32);
  rose.rotation.x = -0.5;
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.022, 5, 10, Math.PI), tinD);
  handle.position.set(0, 0.12, -0.02);
  handle.rotation.set(0, Math.PI / 2, 0);
  const band = new THREE.Mesh(UNIT_CYL, tinD);
  band.scale.set(0.32, 0.035, 0.32);
  band.position.y = 0.09;
  g.add(body, spout, rose, handle, band);
  g.rotation.z = 0.1;
  return g;
}

/** the farmer's seed pouch, worn at the hip: the pack his seeds come out of */
export function buildSeedPouch(): THREE.Group {
  const g = new THREE.Group();
  const leather = new THREE.MeshToonMaterial({ color: 0x8a5a2b });
  const strap = new THREE.Mesh(UNIT_BOX, new THREE.MeshToonMaterial({ color: 0x6b4423 }));
  strap.scale.set(0.5, 0.045, 0.05);
  strap.position.set(0, 0.44, 0.16);
  const bag = new THREE.Mesh(UNIT_BOX, leather);
  bag.scale.set(0.2, 0.18, 0.12);
  bag.position.set(0.16, 0.34, 0.14);
  const lip = new THREE.Mesh(UNIT_CYL, new THREE.MeshToonMaterial({ color: 0xa8763f }));
  lip.scale.set(0.14, 0.04, 0.1);
  lip.position.set(0.16, 0.44, 0.14);
  g.add(strap, bag, lip);
  return g;
}

/**
 * The produce basket the farmer carries to the cart. `slots` are the items themselves, which the view
 * shows one per unit in the basket — a basket visibly filling up as the field comes in is the clearest
 * read of "work is happening" there is.
 */
export function buildBasket(crops: CropSpec[], max = 8): { group: THREE.Group; slots: THREE.Mesh[] } {
  const g = new THREE.Group();
  const wicker = new THREE.MeshToonMaterial({ color: 0xc48b4f });
  const wickerD = new THREE.MeshToonMaterial({ color: 0x9a6c3a });
  const body = new THREE.Mesh(UNIT_CYL, wicker);
  body.scale.set(0.4, 0.22, 0.4);
  body.position.y = 0;
  const rim = new THREE.Mesh(UNIT_CYL, wickerD);
  rim.scale.set(0.44, 0.04, 0.44);
  rim.position.y = 0.11;
  g.add(body, rim);
  const slots: THREE.Mesh[] = [];
  for (let i = 0; i < max; i++) {
    const crop = crops[i % crops.length];
    const m = new THREE.Mesh(produceGeo(crop), new THREE.MeshToonMaterial({ vertexColors: true }));
    const a = (i / max) * Math.PI * 2;
    const r = i % 2 ? 0.13 : 0.06;
    m.position.set(Math.cos(a) * r, 0.14 + (i > max / 2 ? 0.09 : 0), Math.sin(a) * r);
    m.rotation.y = a;
    m.scale.setScalar(0.8);
    m.visible = false;
    slots.push(m);
    g.add(m);
  }
  return { group: g, slots };
}

/** a crop gone to seed: grey stalks still standing, worth nothing but the clearing of them */
export function wiltGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const len = 0.26 + (i % 3) * 0.07;
    const g = new THREE.BoxGeometry(0.04, len, 0.03);
    g.translate(0, len / 2, 0);
    g.rotateZ(0.9 + (i % 2) * 0.3);
    g.rotateY(a);
    g.translate(Math.cos(a) * 0.08, 0, Math.sin(a) * 0.08);
    parts.push(withColor(g, i % 2 ? '#9a8b62' : '#7d7050'));
  }
  const head = new THREE.BoxGeometry(0.16, 0.06, 0.14);
  head.translate(0.02, 0.3, 0.03);
  parts.push(withColor(head, '#6b5f42'));
  return mergeGeometries(parts)!;
}
