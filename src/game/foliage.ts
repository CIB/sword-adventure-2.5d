/**
 * BotW-inspired particle foliage: trees and bushes rendered as clusters of
 * small leaf cards / puffs, with wind.
 *
 * Goals:
 *  - Slightly more "particle" based than the old solid spheres
 *  - Wind effect shared with grass (same noise texture, same direction)
 *  - Performant: trees are instanced globally (one draw call per foliage type),
 *    bushes are merged per-bush but still a single mesh per bush with wind in shader.
 *  - BotW look: soft, slightly toon-shaded, circular leaf puffs,
 *    colour variation per puff, quantized shading.
 *  - Tree canopies are built from the *exact same* puff-cluster recipe as bushes
 *    (same placement, puffs, colour jitter and per-puff wind), only stretched a
 *    bit wider in proportion — so a tree reads as a big bush on a trunk.
 */

import * as THREE from 'three';
import { hash2, clamp } from './constants';
import type { TreeSpec } from './world';

export type TreeKind = 'oak' | 'pine' | 'autumn' | 'birch' | 'blossom';

// ------------------------------------------------------------------ wind
function makeWindTexture(): THREE.CanvasTexture {
  const S = 64, G = 16;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d')!;
  const img = g.createImageData(S, S);
  const h = (x: number, z: number) => hash2(((x % G) + G) % G, ((z % G) + G) % G, 77);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const gx = x / S * G, gz = y / S * G;
    const x0 = Math.floor(gx), z0 = Math.floor(gz);
    let fx = gx - x0, fz = gz - z0;
    fx = fx * fx * (3 - 2 * fx); fz = fz * fz * (3 - 2 * fz);
    const v = (h(x0, z0) * (1 - fx) + h(x0 + 1, z0) * fx) * (1 - fz)
      + (h(x0, z0 + 1) * (1 - fx) + h(x0 + 1, z0 + 1) * fx) * fz;
    const c = Math.round(clamp(v, 0, 1) * 255);
    const i = (y * S + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = c;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

const windTex = makeWindTexture();

export const foliageUniforms = {
  uTime: { value: 0 },
  uWindTex: { value: windTex },
  uWindScale: { value: 13 },
  uWindDir: { value: new THREE.Vector2(1, 0.35).normalize() },
  // toned down – previous 0.34/0.055 felt like storm for bushes
  uGust: { value: 0.22 },
  uSway: { value: 0.032 },
  uAmbient: { value: 0.62 },
  uSun: { value: 0.44 },
};

export function updateFoliage(t: number) {
  foliageUniforms.uTime.value = t;
}

// ------------------------------------------------------------------ gradient map (toon ramp)
let gradMap: THREE.DataTexture | null = null;
function getGrad(): THREE.DataTexture {
  if (gradMap) return gradMap;
  const levels = [0.22, 0.38, 0.58, 0.78, 1.0];
  const data = new Uint8Array(levels.map(l => Math.round(l * 255)));
  gradMap = new THREE.DataTexture(data, levels.length, 1, THREE.RedFormat);
  gradMap.minFilter = THREE.NearestFilter;
  gradMap.magFilter = THREE.NearestFilter;
  gradMap.generateMipmaps = false;
  gradMap.needsUpdate = true;
  return gradMap;
}

// ------------------------------------------------------------------ base geometries
function createPuffBase(): THREE.BufferGeometry {
  // 3 quads crossing at center, slight tilt for volume
  const pos: number[] = [];
  const norm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let v = 0;
  const addQuad = (rotY: number, tiltX: number) => {
    const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
    const cosT = Math.cos(tiltX), sinT = Math.sin(tiltX);
    // 4 corners of unit quad
    const corners: [number, number, number, number, number][] = [
      [-0.5, -0.5, 0, 0, 0],
      [0.5, -0.5, 0, 1, 0],
      [0.5, 0.5, 0, 1, 1],
      [-0.5, 0.5, 0, 0, 1],
    ];
    for (const [x, y, z, u, v_] of corners) {
      // tilt around X
      let ty = y * cosT - z * sinT;
      let tz = y * sinT + z * cosT;
      let tx = x;
      // rotY
      let rx = tx * cosY - tz * sinY;
      let rz = tx * sinY + tz * cosY;
      let ry = ty;
      pos.push(rx, ry, rz);
      // normal (0,0,1) after tilt+rotY
      let nx = 0, ny = -sinT, nz = cosT;
      let rnx = nx * cosY - nz * sinY;
      let rnz = nx * sinY + nz * cosY;
      let rny = ny;
      const len = Math.hypot(rnx, rny, rnz) || 1;
      norm.push(rnx / len, rny / len, rnz / len);
      uv.push(u, v_);
    }
    idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
    v += 4;
  };
  addQuad(0, 0.12);
  addQuad(Math.PI * 2 / 3, -0.10);
  addQuad(Math.PI * 4 / 3, 0.08);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

const puffBase = createPuffBase();

// ------------------------------------------------------------------ shaders
const INSTANCED_VERT = /* glsl */ `
uniform float uTime;
uniform sampler2D uWindTex;
uniform float uWindScale;
uniform vec2 uWindDir;
uniform float uGust;
uniform float uSway;
uniform float uAmbient;
uniform float uSun;
attribute vec3 aCenter;
attribute float aScale;
attribute float aRotY;
attribute vec3 aColor;
attribute float aPhase;
attribute float aWindFactor;
// per-vertex (baked into the canopy cluster): same per-puff variation bushes get
attribute vec3 aVTint;   // the puff's own colour (baked per kind, bush recipe); aColor is a per-tree brightness jitter
attribute float aVPhase; // per-puff flutter phase
attribute float aVWind;  // per-puff wind factor (outer puffs ride the wind more)
varying vec3 vColor;
varying float vShade;
varying vec2 vUv;
varying float vWind;
void main() {
  vUv = uv;
  vec3 pos = position * aScale;
  float c = cos(aRotY), s = sin(aRotY);
  vec3 rpos;
  rpos.x = pos.x * c - pos.z * s;
  rpos.y = pos.y;
  rpos.z = pos.x * s + pos.z * c;
  vec3 worldPos = aCenter + rpos;

  // wind: exact same recipe as bushes (BUSH_VERT) – gentle travelling gusts plus
  // per-puff flutter, so canopies move like the bushes they are built from
  vec2 wuv = worldPos.xz / uWindScale + uWindDir * (uTime * 0.13);
  float gust = texture2D(uWindTex, wuv).r;
  float wf = aWindFactor * aVWind;
  float ph = aPhase + aVPhase;
  vec2 windOff = uWindDir * ((gust - 0.42) * uGust * 0.55);
  windOff += vec2(sin(uTime * 0.9 + ph), cos(uTime * 0.7 + ph * 1.2)) * uSway * 0.55 * wf;
  worldPos.xz += windOff * wf;
  worldPos.y -= length(windOff) * wf * 0.10;

  vec3 norm = normal;
  vec3 rnorm;
  rnorm.x = norm.x * c - norm.z * s;
  rnorm.y = norm.y;
  rnorm.z = norm.x * s + norm.z * c;
  vec3 sunDir = normalize(vec3(-0.15, 1.0, 0.42));
  float nd = dot(normalize(rnorm), sunDir);
  float shade = 0.5 + 0.5 * nd;
  float q = floor(shade * 3.0 + 0.25) / 3.0;
  q = 0.42 + q * 0.58;

  vColor = aColor * aVTint;
  vShade = (uAmbient + uSun * q);
  vWind = gust;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
}
`;

const PUFF_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vShade;
varying vec2 vUv;
varying float vWind;
void main() {
  vec2 uv = vUv;
  float d = length(uv - 0.5);
  if (d > 0.5) discard;
  // softer, less distinct edge – previous 0.82 darkening made each puff pop like separate palm leaf
  float edge = smoothstep(0.35, 0.5, d);
  vec3 col = vColor * (vShade + vWind * 0.05);
  col = mix(col, col * 0.92, edge * 0.28);
  gl_FragColor = vec4(col, 1.0);
}
`;

const BUSH_VERT = /* glsl */ `
uniform float uTime;
uniform sampler2D uWindTex;
uniform float uWindScale;
uniform vec2 uWindDir;
uniform float uGust;
uniform float uSway;
uniform float uAmbient;
uniform float uSun;
attribute vec3 color;
attribute float aPhase;
attribute float aWindFactor;
varying vec3 vColor;
varying float vShade;
varying vec2 vUv;
varying float vWind;
void main() {
  vUv = uv;
  vColor = color;
  vec4 worldPos4 = modelMatrix * vec4(position, 1.0);
  vec3 worldPos = worldPos4.xyz;

  vec2 wuv = worldPos.xz / uWindScale + uWindDir * (uTime * 0.13);
  float gust = texture2D(uWindTex, wuv).r;
  // European bushes: much gentler wind – was 1.45/1.7 stormy
  vec2 windOff = uWindDir * ((gust - 0.42) * uGust * 0.55);
  windOff += vec2(sin(uTime * 0.9 + aPhase), cos(uTime * 0.7 + aPhase * 1.2)) * uSway * 0.55 * aWindFactor;
  worldPos.xz += windOff * aWindFactor;
  worldPos.y -= length(windOff) * aWindFactor * 0.10;

  vec3 worldNormal = normalize(mat3(modelMatrix) * normal);
  vec3 sunDir = normalize(vec3(-0.15, 1.0, 0.42));
  float nd = dot(worldNormal, sunDir);
  float shade = 0.5 + 0.5 * nd;
  float q = floor(shade * 3.0 + 0.25) / 3.0;
  q = 0.42 + q * 0.58;

  vShade = (uAmbient + uSun * q);
  vWind = gust;

  gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
}
`;

function makeInstancedMaterial(frag: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: foliageUniforms as any,
    vertexShader: INSTANCED_VERT,
    fragmentShader: frag,
    side: THREE.DoubleSide,
  });
}

function makeBushMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: foliageUniforms as any,
    vertexShader: BUSH_VERT,
    fragmentShader: PUFF_FRAG,
    side: THREE.DoubleSide,
  });
}

// shared materials for performance: one program per foliage type
// (trees and bushes share the same puff fragment shader – canopies are big bushes)
const sharedCanopyMat = makeInstancedMaterial(PUFF_FRAG);
const sharedBushMat = makeBushMaterial();

// ------------------------------------------------------------------ colour helpers
function linColor(hex: string): THREE.Color {
  return new THREE.Color(hex).convertSRGBToLinear();
}

const TREE_BASE: Record<TreeKind, string> = {
  // European palette: deeper oak green, dark spruce, muted autumn, light birch
  oak: '#2e6b30',
  pine: '#234d2a',
  autumn: '#c46a1e',
  birch: '#7fb34a',
  blossom: '#e8a8b8',
};

function varyColor(baseHex: string, h1: number, h2: number, kind: TreeKind): THREE.Color {
  const base = linColor(baseHex);
  // small HSL jitter for natural variation
  const hsl = { h: 0, s: 0, l: 0 };
  base.getHSL(hsl);
  // per-kind tweaks
  if (kind === 'blossom') {
    // keep pink, vary toward white or deeper pink
    hsl.s = clamp(hsl.s + (h1 - 0.5) * 0.25, 0.4, 0.95);
    hsl.l = clamp(hsl.l + (h2 - 0.5) * 0.28, 0.55, 0.82);
    hsl.h += (h1 - 0.5) * 0.04;
  } else if (kind === 'autumn') {
    hsl.h += (h1 - 0.5) * 0.12; // orange -> red/yellow
    hsl.s = clamp(hsl.s + (h2 - 0.5) * 0.2, 0.6, 1);
    hsl.l = clamp(hsl.l + (h1 - 0.5) * 0.25, 0.45, 0.72);
  } else {
    hsl.h += (h1 - 0.5) * 0.06;
    hsl.s = clamp(hsl.s + (h2 - 0.5) * 0.22, 0.45, 0.95);
    hsl.l = clamp(hsl.l + (h1 - 0.5) * 0.32, 0.32, 0.78);
  }
  const c = new THREE.Color().setHSL(hsl.h, hsl.s, hsl.l);
  return c;
}

// ------------------------------------------------------------------ tree canopy = a bush, wider
// The canopy cluster is generated with the exact same recipe as the bush
// (buildBushMerged): same 14 puffs, same dome placement, same puff base,
// same per-puff colour jitter and wind factors – only stretched a bit wider
// in proportion (CANOPY_WIDEN) and kept from getting too tall (CANOPY_FLATTEN).
//
// Because the cluster is instanced (one draw call for all trees of a kind),
// the per-puff data lives in per-vertex attributes instead of the per-vertex
// `color` the bush mesh uses:
//   aVTint   – the puff's own colour (varied around the kind's base colour with
//              the very same varyColor call bushes use around their base green),
//              baked per kind so canopies are as colourful as bushes
//   aVPhase  – per-puff flutter phase (added to the per-tree aPhase)
//   aVWind   – per-puff wind factor (multiplied with the per-tree aWindFactor)
// The per-instance aColor then acts as a subtle per-tree brightness jitter.
const CANOPY_WIDEN = 1.18;   // a bit wider in proportion than a bush
const CANOPY_FLATTEN = 0.92; // keep the dome from growing too tall

function buildCanopyClusterBase(kind: TreeKind): THREE.BufferGeometry {
  const puffCount = 14; // same as a bush
  const base = puffBase;
  const basePos = base.getAttribute('position') as THREE.BufferAttribute;
  const baseNorm = base.getAttribute('normal') as THREE.BufferAttribute;
  const baseUv = base.getAttribute('uv') as THREE.BufferAttribute;
  const baseIdx = base.getIndex()!;
  const pos: number[] = [];
  const norm: number[] = [];
  const uv: number[] = [];
  const tint: number[] = [];
  const vphase: number[] = [];
  const vwind: number[] = [];
  const idx: number[] = [];
  let vertOff = 0;

  for (let pi = 0; pi < puffCount; pi++) {
    // identical placement recipe to buildBushMerged (same hashes → same dome)
    const h1 = hash2(pi, 0, 31), h2 = hash2(pi, 1, 33), h3 = hash2(pi, 2, 35), h4 = hash2(pi, 3, 37);
    const theta = h1 * Math.PI * 2;
    const phi = Math.acos(1 - h2 * 0.88);
    const r = 0.34 * (0.45 + h3 * 0.55);
    const ox = r * Math.sin(phi) * Math.cos(theta);
    const oy = 0.28 + r * Math.cos(phi) * 0.62 + (h4 - 0.5) * 0.06;
    const oz = r * Math.sin(phi) * Math.sin(theta);
    const pScale = 0.30 + h1 * 0.18;
    const rotY = h2 * Math.PI * 2;
    const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
    // per-puff colour, varied around the kind's base exactly like bush puffs are
    // varied around the bush green (a few blossom puffs stay green, as before)
    const c = varyColor(TREE_BASE[kind], h3, h4, kind);
    if (kind === 'blossom' && h4 < 0.15) {
      const g = varyColor('#4a9a3a', h2, h3, 'oak');
      c.lerp(g, 0.35);
    }
    const windF = 0.45 + (r / 0.34) * 0.5 + h1 * 0.15;
    const ph = h1 * 10 + pi * 0.7;

    for (let vi = 0; vi < basePos.count; vi++) {
      const x = basePos.getX(vi) * pScale;
      const y = basePos.getY(vi) * pScale;
      const z = basePos.getZ(vi) * pScale;
      const rx = x * cosY - z * sinY;
      const rz = x * sinY + z * cosY;
      const ry = y;
      // the only difference to a bush: a bit wider in proportion
      pos.push((rx + ox) * CANOPY_WIDEN, (ry + oy) * CANOPY_FLATTEN, (rz + oz) * CANOPY_WIDEN);
      const nx = baseNorm.getX(vi), ny = baseNorm.getY(vi), nz = baseNorm.getZ(vi);
      const rnx = nx * cosY - nz * sinY;
      const rnz = nx * sinY + nz * cosY;
      const rny = ny;
      // normals go through the inverse of the non-uniform stretch
      const sx = rnx / CANOPY_WIDEN, sy = rny / CANOPY_FLATTEN, sz = rnz / CANOPY_WIDEN;
      const len = Math.hypot(sx, sy, sz) || 1;
      norm.push(sx / len, sy / len, sz / len);
      uv.push(baseUv.getX(vi), baseUv.getY(vi));
      tint.push(c.r, c.g, c.b);
      vphase.push(ph);
      vwind.push(windF);
    }
    for (let ii = 0; ii < baseIdx.count; ii++) {
      idx.push(baseIdx.getX(ii) + vertOff);
    }
    vertOff += basePos.count;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('aVTint', new THREE.Float32BufferAttribute(tint, 3));
  geo.setAttribute('aVPhase', new THREE.Float32BufferAttribute(vphase, 1));
  geo.setAttribute('aVWind', new THREE.Float32BufferAttribute(vwind, 1));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

// one tiny baked cluster per kind (168 verts each), built on first use
const canopyBases = new Map<TreeKind, THREE.BufferGeometry>();
function getCanopyBase(kind: TreeKind): THREE.BufferGeometry {
  let g = canopyBases.get(kind);
  if (!g) { g = buildCanopyClusterBase(kind); canopyBases.set(kind, g); }
  return g;
}

// local y of the cluster's underside – used to seat canopies onto their trunks
// (all kinds share the bush placement recipe, so one bounding box fits all)
const CANOPY_UNDER = (() => {
  const g = getCanopyBase('oak');
  g.computeBoundingBox();
  return g.boundingBox!.min.y;
})();

// ------------------------------------------------------------------ trunk + shadow helpers
const trunkGeo = new THREE.CylinderGeometry(0.2, 0.28, 0.95, 8).translate(0, 0.47, 0);
const shadowGeo = new THREE.CircleGeometry(0.9, 12).rotateX(-Math.PI / 2).scale(1, 1, 0.7).translate(0, 0.015, 0.1);
const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false });

function trunkMatFor(kind: TreeKind): THREE.MeshToonMaterial {
  const col = kind === 'birch' ? '#e8e0d0' : '#6b4226';
  return new THREE.MeshToonMaterial({ color: col, gradientMap: getGrad() });
}

// ------------------------------------------------------------------ instanced foliage builders
interface FoliageInstance {
  center: THREE.Vector3;
  scale: number;
  rotY: number;
  color: THREE.Color;
  phase: number;
  wind: number;
}

function buildInstancedGeo(instances: FoliageInstance[], base: THREE.BufferGeometry): THREE.InstancedBufferGeometry {
  const geo = new THREE.InstancedBufferGeometry();
  // copy base attributes
  geo.setIndex(base.getIndex()!);
  for (const name of ['position', 'normal', 'uv', 'aVTint', 'aVPhase', 'aVWind']) {
    const attr = base.getAttribute(name) as THREE.BufferAttribute;
    geo.setAttribute(name, attr);
  }
  const n = instances.length;
  const centers = new Float32Array(n * 3);
  const scales = new Float32Array(n);
  const rotYs = new Float32Array(n);
  const colors = new Float32Array(n * 3);
  const phases = new Float32Array(n);
  const winds = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const it = instances[i];
    centers[i * 3] = it.center.x;
    centers[i * 3 + 1] = it.center.y;
    centers[i * 3 + 2] = it.center.z;
    scales[i] = it.scale;
    rotYs[i] = it.rotY;
    colors[i * 3] = it.color.r;
    colors[i * 3 + 1] = it.color.g;
    colors[i * 3 + 2] = it.color.b;
    phases[i] = it.phase;
    winds[i] = it.wind;
  }
  geo.setAttribute('aCenter', new THREE.InstancedBufferAttribute(centers, 3));
  geo.setAttribute('aScale', new THREE.InstancedBufferAttribute(scales, 1));
  geo.setAttribute('aRotY', new THREE.InstancedBufferAttribute(rotYs, 1));
  geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(colors, 3));
  geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
  geo.setAttribute('aWindFactor', new THREE.InstancedBufferAttribute(winds, 1));
  geo.instanceCount = n;
  // bounding sphere: approximate from centers
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = centers[i * 3], y = centers[i * 3 + 1], z = centers[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
  const r = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 + 3;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, cy, cz), r);
  return geo;
}

function generateCanopyInstances(trees: TreeSpec[]): FoliageInstance[] {
  const out: FoliageInstance[] = [];
  for (let ti = 0; ti < trees.length; ti++) {
    const t = trees[ti];
    const scale = t.scale;
    const h1 = hash2(ti, 0, 11), h2 = hash2(ti, 0, 13);
    // big trees ≈ 2.2 units across, small ≈ 1.1 – same wide-dome ratio as bushes,
    // plus per-tree size jitter (the cluster itself is already CANOPY_WIDEN wider)
    const cScale = (scale < 0.8 ? 1.55 : 2.0) * scale * (0.94 + h1 * 0.12);
    // the baked cluster's underside sits at local y ≈ 0.07 (CANOPY_UNDER); drop the
    // origin so the canopy's bottom overlaps the top of the trunk (0.95 * scale)
    const yBase = (t.y ?? 0) + 0.85 * scale - CANOPY_UNDER * cScale;
    const center = new THREE.Vector3(t.x, yBase, t.z);
    // puff colours are baked per kind in the cluster (aVTint); the instance colour
    // is just a subtle per-tree brightness jitter so no two trees match exactly
    const bri = 0.93 + h2 * 0.14;
    const col = new THREE.Color(bri, bri, bri);
    // per-puff wind is baked into the cluster (aVWind); the instance factor stays 1
    out.push({ center, scale: cScale, rotY: h1 * Math.PI * 2, color: col, phase: h1 * 5 + ti * 0.15, wind: 1.0 });
  }
  return out;
}

// ------------------------------------------------------------------ public tree builder
export function buildTrees(trees: TreeSpec[]): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  // group by kind
  const byKind = new Map<TreeKind, TreeSpec[]>();
  for (const t of trees) {
    const k = (t.kind ?? 'oak') as TreeKind;
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k)!.push(t);
  }

  for (const [kind, list] of byKind) {
    if (!list.length) continue;
    // trunk
    const tMat = trunkMatFor(kind);
    const trunkMesh = new THREE.InstancedMesh(trunkGeo, tMat, list.length);
    const shadowMesh = new THREE.InstancedMesh(shadowGeo, shadowMat, list.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    list.forEach((t, i) => {
      p.set(t.x, t.y ?? 0, t.z);
      q.setFromAxisAngle(up, hash2(i, 0, 91) * Math.PI * 2);
      s.set(t.scale, t.scale, t.scale);
      m4.compose(p, q, s);
      trunkMesh.setMatrixAt(i, m4);
      shadowMesh.setMatrixAt(i, m4);
    });
    trunkMesh.instanceMatrix.needsUpdate = true;
    shadowMesh.instanceMatrix.needsUpdate = true;
    out.push(trunkMesh, shadowMesh);

    // canopy – a bush cluster (same recipe as the bushes, a bit wider), instanced
    const instances = generateCanopyInstances(list);
    if (instances.length) {
      const geo = buildInstancedGeo(instances, getCanopyBase(kind));
      const mesh = new THREE.Mesh(geo, sharedCanopyMat);
      mesh.frustumCulled = false;
      out.push(mesh);
    }
  }
  return out;
}

// ------------------------------------------------------------------ bush builder (per-bush merged)
// European boxwood-like bushes: denser, smaller, rounded – not palm fronds
function buildBushMerged(isBerry: boolean): THREE.BufferGeometry {
  const puffCount = isBerry ? 16 : 14;
  const base = puffBase;
  const basePos = base.getAttribute('position') as THREE.BufferAttribute;
  const baseNorm = base.getAttribute('normal') as THREE.BufferAttribute;
  const baseUv = base.getAttribute('uv') as THREE.BufferAttribute;
  const baseIdx = base.getIndex()!;
  const pos: number[] = [];
  const norm: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const phase: number[] = [];
  const wind: number[] = [];
  const idx: number[] = [];
  let vertOff = 0;

  const bushBaseHex = '#2f6d2f';
  for (let pi = 0; pi < puffCount; pi++) {
    const h1 = hash2(pi, 0, 31), h2 = hash2(pi, 1, 33), h3 = hash2(pi, 2, 35), h4 = hash2(pi, 3, 37);
    const theta = h1 * Math.PI * 2;
    const phi = Math.acos(1 - h2 * 0.88);
    const r = 0.34 * (0.45 + h3 * 0.55);
    const ox = r * Math.sin(phi) * Math.cos(theta);
    const oy = 0.28 + r * Math.cos(phi) * 0.62 + (h4 - 0.5) * 0.06;
    const oz = r * Math.sin(phi) * Math.sin(theta);
    const pScale = (0.30 + h1 * 0.18 + (isBerry ? 0.04 : 0));
    const rotY = h2 * Math.PI * 2;
    const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
    const c = varyColor(bushBaseHex, h3, h4, 'oak');
    const windF = 0.45 + (r / 0.34) * 0.5 + h1 * 0.15;
    const ph = h1 * 10 + pi * 0.7;

    for (let vi = 0; vi < basePos.count; vi++) {
      let x = basePos.getX(vi) * pScale;
      let y = basePos.getY(vi) * pScale;
      let z = basePos.getZ(vi) * pScale;
      const rx = x * cosY - z * sinY;
      const rz = x * sinY + z * cosY;
      const ry = y;
      pos.push(rx + ox, ry + oy, rz + oz);
      const nx = baseNorm.getX(vi), ny = baseNorm.getY(vi), nz = baseNorm.getZ(vi);
      const rnx = nx * cosY - nz * sinY;
      const rnz = nx * sinY + nz * cosY;
      const rny = ny;
      const len = Math.hypot(rnx, rny, rnz) || 1;
      norm.push(rnx / len, rny / len, rnz / len);
      uv.push(baseUv.getX(vi), baseUv.getY(vi));
      col.push(c.r, c.g, c.b);
      phase.push(ph);
      wind.push(windF);
    }
    for (let ii = 0; ii < baseIdx.count; ii++) {
      idx.push(baseIdx.getX(ii) + vertOff);
    }
    vertOff += basePos.count;
  }

  // berries: small red quads (as tiny puffs with red colour)
  if (isBerry) {
    const berryBase = puffBase; // reuse puff but tiny
    const bPos = berryBase.getAttribute('position') as THREE.BufferAttribute;
    const bNorm = berryBase.getAttribute('normal') as THREE.BufferAttribute;
    const bUv = berryBase.getAttribute('uv') as THREE.BufferAttribute;
    const bIdx = berryBase.getIndex()!;
    const berryCol = linColor('#e04a3a');
    const berryPositions: [number, number, number][] = [
      [-0.2, 0.45, 0.2],
      [0.18, 0.55, 0.05],
      [0.0, 0.36, 0.3],
      [0.26, 0.38, -0.16],
      [-0.28, 0.34, -0.1],
    ];
    for (let bi = 0; bi < berryPositions.length; bi++) {
      const [bx, by, bz] = berryPositions[bi];
      const h = hash2(bi, 9, 41);
      const bScale = 0.18 + h * 0.06;
      const rotY = h * Math.PI * 2;
      const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
      const ph = h * 10;
      for (let vi = 0; vi < bPos.count; vi++) {
        let x = bPos.getX(vi) * bScale;
        let y = bPos.getY(vi) * bScale;
        let z = bPos.getZ(vi) * bScale;
        const rx = x * cosY - z * sinY;
        const rz = x * sinY + z * cosY;
        const ry = y;
        pos.push(rx + bx, ry + by, rz + bz);
        const nx = bNorm.getX(vi), ny = bNorm.getY(vi), nz = bNorm.getZ(vi);
        const rnx = nx * cosY - nz * sinY;
        const rnz = nx * sinY + nz * cosY;
        const rny = ny;
        const len = Math.hypot(rnx, rny, rnz) || 1;
        norm.push(rnx / len, rny / len, rnz / len);
        uv.push(bUv.getX(vi), bUv.getY(vi));
        col.push(berryCol.r, berryCol.g, berryCol.b);
        phase.push(ph);
        wind.push(0.9);
      }
      for (let ii = 0; ii < bIdx.count; ii++) {
        idx.push(bIdx.getX(ii) + vertOff);
      }
      vertOff += bPos.count;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('aPhase', new THREE.Float32BufferAttribute(phase, 1));
  geo.setAttribute('aWindFactor', new THREE.Float32BufferAttribute(wind, 1));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

function makeBushGroup(isBerry: boolean): THREE.Group {
  const g = new THREE.Group();
  const foliageGeo = buildBushMerged(isBerry);
  // share bush material across all bushes for performance
  const mesh = new THREE.Mesh(foliageGeo, sharedBushMat);
  mesh.frustumCulled = false;
  g.add(mesh);
  // small dark base disc for grounding (toon)
  const baseMat = new THREE.MeshToonMaterial({ color: '#2a6e2a', gradientMap: getGrad() });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.41, 0.46, 0.06, 8).translate(0, 0.03, 0), baseMat);
  g.add(base);
  // blob shadow
  const sh = new THREE.Mesh(new THREE.CircleGeometry(0.45, 10).rotateX(-Math.PI / 2).translate(0, 0.015, 0), shadowMat);
  g.add(sh);
  return g;
}

export function buildBush(): THREE.Group {
  return makeBushGroup(false);
}

export function buildBerryBush(): THREE.Group {
  return makeBushGroup(true);
}

// ------------------------------------------------------------------ hedge & rosebush (particle versions of props)
function buildHedgeMerged(): THREE.BufferGeometry {
  // European trimmed hedge: low, dense boxwood – many small puffs, not large palm leaves
  const clusters = [
    { x: -0.3, z: 0, s: 1.0 },
    { x: 0, z: 0.08, s: 1.05 },
    { x: 0.32, z: -0.05, s: 0.95 },
  ];
  const base = puffBase;
  const basePos = base.getAttribute('position') as THREE.BufferAttribute;
  const baseNorm = base.getAttribute('normal') as THREE.BufferAttribute;
  const baseUv = base.getAttribute('uv') as THREE.BufferAttribute;
  const baseIdx = base.getIndex()!;
  const pos: number[] = [], norm: number[] = [], uv: number[] = [], col: number[] = [], phase: number[] = [], wind: number[] = [], idx: number[] = [];
  let vertOff = 0;
  for (let ci = 0; ci < clusters.length; ci++) {
    const cl = clusters[ci];
    const puffCount = 11;
    for (let pi = 0; pi < puffCount; pi++) {
      const h1 = hash2(ci, pi, 51), h2 = hash2(ci, pi, 53), h3 = hash2(ci, pi, 55), h4 = hash2(ci, pi, 57);
      const theta = h1 * Math.PI * 2;
      const phi = Math.acos(1 - h2 * 0.82);
      const r = 0.28 * (0.45 + h3 * 0.5);
      const ox = cl.x + r * Math.sin(phi) * Math.cos(theta) * 0.85;
      const oy = 0.26 + r * Math.cos(phi) * 0.55 + (h4 - 0.5) * 0.05;
      const oz = cl.z + r * Math.sin(phi) * Math.sin(theta) * 0.55;
      const pScale = (0.26 + h1 * 0.16) * cl.s;
      const rotY = h2 * Math.PI * 2;
      const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
      const c = varyColor('#2f6d2f', h3, h4, 'oak');
      const windF = 0.35 + (r / 0.28) * 0.4;
      const ph = h1 * 9 + ci * 2;
      for (let vi = 0; vi < basePos.count; vi++) {
        let x = basePos.getX(vi) * pScale, y = basePos.getY(vi) * pScale, z = basePos.getZ(vi) * pScale;
        const rx = x * cosY - z * sinY, rz = x * sinY + z * cosY, ry = y;
        pos.push(rx + ox, ry + oy, rz + oz);
        const nx = baseNorm.getX(vi), ny = baseNorm.getY(vi), nz = baseNorm.getZ(vi);
        const rnx = nx * cosY - nz * sinY, rnz = nx * sinY + nz * cosY, rny = ny;
        const len = Math.hypot(rnx, rny, rnz) || 1;
        norm.push(rnx / len, rny / len, rnz / len);
        uv.push(baseUv.getX(vi), baseUv.getY(vi));
        col.push(c.r, c.g, c.b);
        phase.push(ph);
        wind.push(windF);
      }
      for (let ii = 0; ii < baseIdx.count; ii++) idx.push(baseIdx.getX(ii) + vertOff);
      vertOff += basePos.count;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('aPhase', new THREE.Float32BufferAttribute(phase, 1));
  geo.setAttribute('aWindFactor', new THREE.Float32BufferAttribute(wind, 1));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

export function buildHedge(): THREE.Group {
  const g = new THREE.Group();
  const geo = buildHedgeMerged();
  const mesh = new THREE.Mesh(geo, sharedBushMat);
  mesh.frustumCulled = false;
  g.add(mesh);
  const baseMat = new THREE.MeshToonMaterial({ color: '#2a6e2a', gradientMap: getGrad() });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.52, 0.06, 6).translate(0, 0.03, 0).scale(1.2, 1, 0.7), baseMat);
  g.add(base);
  const sh = new THREE.Mesh(new THREE.CircleGeometry(0.55, 10).rotateX(-Math.PI / 2).translate(0, 0.016, 0).scale(1.2, 1, 0.7), shadowMat);
  g.add(sh);
  return g;
}

function buildRosebushMerged(): THREE.BufferGeometry {
  const puffCount = 12;
  const base = puffBase;
  const basePos = base.getAttribute('position') as THREE.BufferAttribute;
  const baseNorm = base.getAttribute('normal') as THREE.BufferAttribute;
  const baseUv = base.getAttribute('uv') as THREE.BufferAttribute;
  const baseIdx = base.getIndex()!;
  const pos: number[] = [], norm: number[] = [], uv: number[] = [], col: number[] = [], phase: number[] = [], wind: number[] = [], idx: number[] = [];
  let vertOff = 0;
  for (let pi = 0; pi < puffCount; pi++) {
    const h1 = hash2(pi, 0, 61), h2 = hash2(pi, 1, 63), h3 = hash2(pi, 2, 65), h4 = hash2(pi, 3, 67);
    const theta = h1 * Math.PI * 2, phi = Math.acos(1 - h2 * 0.85);
    const r = 0.28 * (0.45 + h3 * 0.5);
    const ox = r * Math.sin(phi) * Math.cos(theta);
    const oy = 0.28 + r * Math.cos(phi) * 0.55;
    const oz = r * Math.sin(phi) * Math.sin(theta);
    const pScale = 0.26 + h1 * 0.16;
    const rotY = h2 * Math.PI * 2;
    const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
    const c = varyColor('#2f6d2f', h3, h4, 'oak');
    const windF = 0.42 + (r / 0.28) * 0.4;
    const ph = h1 * 9;
    for (let vi = 0; vi < basePos.count; vi++) {
      let x = basePos.getX(vi) * pScale, y = basePos.getY(vi) * pScale, z = basePos.getZ(vi) * pScale;
      const rx = x * cosY - z * sinY, rz = x * sinY + z * cosY, ry = y;
      pos.push(rx + ox, ry + oy, rz + oz);
      const nx = baseNorm.getX(vi), ny = baseNorm.getY(vi), nz = baseNorm.getZ(vi);
      const rnx = nx * cosY - nz * sinY, rnz = nx * sinY + nz * cosY, rny = ny;
      const len = Math.hypot(rnx, rny, rnz) || 1;
      norm.push(rnx / len, rny / len, rnz / len);
      uv.push(baseUv.getX(vi), baseUv.getY(vi));
      col.push(c.r, c.g, c.b);
      phase.push(ph);
      wind.push(windF);
    }
    for (let ii = 0; ii < baseIdx.count; ii++) idx.push(baseIdx.getX(ii) + vertOff);
    vertOff += basePos.count;
  }
  // roses: 4 red puffs
  const rosePositions: [number, number, number][] = [
    [-0.18, 0.40, 0.22],
    [0.20, 0.50, 0.12],
    [0.05, 0.24, 0.28],
    [-0.05, 0.60, -0.05],
  ];
  for (let bi = 0; bi < rosePositions.length; bi++) {
    const [bx, by, bz] = rosePositions[bi];
    const h = hash2(bi, 7, 71);
    const bScale = 0.22 + h * 0.06;
    const rotY = h * Math.PI * 2;
    const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
    const roseCol = varyColor(bi % 2 ? '#e83a3a' : '#f05a6a', h, 1 - h, 'blossom');
    // make roses a bit more saturated red
    const ph = h * 8;
    for (let vi = 0; vi < basePos.count; vi++) {
      let x = basePos.getX(vi) * bScale, y = basePos.getY(vi) * bScale, z = basePos.getZ(vi) * bScale;
      const rx = x * cosY - z * sinY, rz = x * sinY + z * cosY, ry = y;
      pos.push(rx + bx, ry + by, rz + bz);
      const nx = baseNorm.getX(vi), ny = baseNorm.getY(vi), nz = baseNorm.getZ(vi);
      const rnx = nx * cosY - nz * sinY, rnz = nx * sinY + nz * cosY, rny = ny;
      const len = Math.hypot(rnx, rny, rnz) || 1;
      norm.push(rnx / len, rny / len, rnz / len);
      uv.push(baseUv.getX(vi), baseUv.getY(vi));
      col.push(roseCol.r, roseCol.g, roseCol.b);
      phase.push(ph);
      wind.push(0.7);
    }
    for (let ii = 0; ii < baseIdx.count; ii++) idx.push(baseIdx.getX(ii) + vertOff);
    vertOff += basePos.count;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('aPhase', new THREE.Float32BufferAttribute(phase, 1));
  geo.setAttribute('aWindFactor', new THREE.Float32BufferAttribute(wind, 1));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

export function buildRosebush(): THREE.Group {
  const g = new THREE.Group();
  const geo = buildRosebushMerged();
  const mesh = new THREE.Mesh(geo, sharedBushMat);
  mesh.frustumCulled = false;
  g.add(mesh);
  const baseMat = new THREE.MeshToonMaterial({ color: '#2a6e2a', gradientMap: getGrad() });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.40, 0.06, 8).translate(0, 0.03, 0), baseMat);
  g.add(base);
  const sh = new THREE.Mesh(new THREE.CircleGeometry(0.42, 10).rotateX(-Math.PI / 2).translate(0, 0.015, 0), shadowMat);
  g.add(sh);
  return g;
}

// ------------------------------------------------------------------ undergrowth wind instancing
// Ferns, tall grass, briars now sway with the same wind field as grass/trees
const VEG_VERT = /* glsl */ `
uniform float uTime;
uniform sampler2D uWindTex;
uniform float uWindScale;
uniform vec2 uWindDir;
uniform float uGust;
uniform float uSway;
uniform float uAmbient;
uniform float uSun;
attribute vec3 color;
attribute mat4 instanceMatrix;
varying vec3 vColor;
varying float vShade;
varying float vWind;
void main() {
  vColor = color;
  vec3 pos = position;
  // instance transform
  vec4 worldPos4 = modelMatrix * instanceMatrix * vec4(pos, 1.0);
  vec3 worldPos = worldPos4.xyz;

  vec2 wuv = worldPos.xz / uWindScale + uWindDir * (uTime * 0.13);
  float gust = texture2D(uWindTex, wuv).r;
  vec2 windOff = uWindDir * ((gust - 0.42) * uGust * 0.55);
  float phase = float(gl_InstanceID) * 0.73;
  windOff += vec2(sin(uTime * 0.9 + phase), cos(uTime * 0.7 + phase * 1.2)) * uSway * 0.6;

  // bend factor: higher vertices sway more (y is local height)
  float bend = clamp(position.y * 1.2, 0.0, 1.0);
  worldPos.xz += windOff * bend;
  worldPos.y -= length(windOff) * bend * 0.12;

  vec3 worldNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  vec3 sunDir = normalize(vec3(-0.15, 1.0, 0.42));
  float nd = dot(worldNormal, sunDir);
  float shade = 0.5 + 0.5 * nd;
  float q = floor(shade * 3.0 + 0.25) / 3.0;
  q = 0.42 + q * 0.58;
  vShade = (uAmbient + uSun * q);
  vWind = gust * bend;

  gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
}
`;

const VEG_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vShade;
varying float vWind;
void main() {
  vec3 col = vColor * (vShade + vWind * 0.07);
  gl_FragColor = vec4(col, 1.0);
}
`;

function makeVegWindMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: foliageUniforms as any,
    vertexShader: VEG_VERT,
    fragmentShader: VEG_FRAG,
    side: THREE.DoubleSide,
  });
}

const sharedVegWindMat = makeVegWindMaterial();

export interface VegSpot { x: number; y: number; z: number }

export function makeVegInstancesWind(geo: THREE.BufferGeometry, spots: VegSpot[], seed: number): THREE.InstancedMesh {
  // seed is kept for API compatibility but we use gl_InstanceID for phase
  void seed;
  const im = new THREE.InstancedMesh(geo, sharedVegWindMat, spots.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  // use same jitter logic as original makeVegInstances but via RNG hash for determinism
  for (let i = 0; i < spots.length; i++) {
    const t = spots[i];
    const h1 = hash2(i, 0, 901), h2 = hash2(i, 1, 902), h3 = hash2(i, 2, 903);
    p.set(t.x + (h1 - 0.5) * 0.4, t.y, t.z + (h2 - 0.5) * 0.4);
    q.setFromAxisAngle(up, h3 * Math.PI * 2);
    const sx = 0.8 + hash2(i, 3, 904) * 0.4;
    const sy = 0.8 + hash2(i, 4, 905) * 0.45;
    const sz = 0.8 + hash2(i, 5, 906) * 0.4;
    s.set(sx, sy, sz);
    m4.compose(p, q, s);
    im.setMatrixAt(i, m4);
  }
  im.instanceMatrix.needsUpdate = true;
  return im;
}

// ------------------------------------------------------------------ keep old API for rocks/stumps etc re-exported from models?
// This file only handles trees/bushes. Other foliage (ferns etc) stays in models.ts

// ------------------------------------------------------------------ dispose
export function disposeFoliage() {
  windTex.dispose();
  gradMap?.dispose();
  puffBase.dispose();
  for (const g of canopyBases.values()) g.dispose();
  canopyBases.clear();
  sharedCanopyMat.dispose();
  sharedBushMat.dispose();
  sharedVegWindMat.dispose();
}
