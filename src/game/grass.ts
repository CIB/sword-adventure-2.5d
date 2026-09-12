/**
 * Breath of the Wild-style grass: a dense carpet of individual blades.
 *
 * The trick (per BotW technical analyses, e.g. the ResetEra tech-analysis thread and the Cemu
 * grass-density work): every blade of grass is exactly ONE triangle — 3 vertices — rendered by
 * instancing tens of thousands of them. Wind just pushes the tip vertex, and the dark-root to
 * bright-tip gradient is plain per-vertex colour. That is why BotW's fields read as individual
 * blades instead of sparse tufts: a blade this cheap can be planted 20-30 to a tile.
 *
 * Adaptations for this engine:
 *  - Blades are screen-aligned around their width axis (the camera looks straight down under the
 *    oblique shear, so a randomly-rotated vertical triangle would collapse to an invisible sliver
 *    whenever it sits edge-on to the view). Height stays true-3D, so shear, depth and the
 *    player-parting deformation all still work.
 *  - Blades grow in discrete Zelda-style TUFTS (up to four per tile, 5-10 blades each) rather than
 *    a uniform carpet: lush hearts of a meadow fill up, fringes thin out, many green tiles are bare.
 *  - Blades are instanced per 16×16-tile chunk (one draw call each), streamed around the camera.
 *  - All animation lives in the vertex shader: travelling gusts (a noise field scrolled in world
 *    space), per-blade idle sway, gust shimmer, and radial parting around the player.
 *  - Cutting: the sword stamps a per-blade `aCut` timestamp; the shader makes the tile's tufts
 *    detach, tumble upward and fade (2D-Zelda style), hides them, then pops them back later.
 *
 * Per-instance data:
 *   aData0 = (root.x, root.y, root.z, height)
 *   aData1 = (width, phase, tintCode, lean)
 *   aData2 = dryness (0 = lush green, 1 = bleached amber; follows the world's biome blend)
 *   aCut   = game time the tuft was cut (-1 while standing)
 * `tintCode` doubles as a flower flag: values > 1.4 mark a flower blade, 1.5+ = petal index.
 */
import * as THREE from 'three';
import { clamp, hash2, MAP_W, MAP_H, Tile } from './constants';
import type { World, Biome } from './world';

export const GRASS_CHUNK = 16;  // tiles per chunk side
const BUILD_PER_FRAME = 2;      // chunk budget per frame (avoids hitches while travelling)
const MAX_BLADES_PER_CHUNK = 8000;
const MAX_TUFTS_PER_TILE = 4;   // a fully lush tile: one tuft per quadrant
const BLADES_PER_TUFT_MIN = 5, BLADES_PER_TUFT_RND = 5;

// Cutting (Zelda-style): the tufts of a hit tile detach, fly up and vanish, then regrow later.
export const CUT_FLY = 0.85;    // seconds the pieces are airborne
export const CUT_REGROW = 28;   // seconds until the tile regrows
const CUT_GROW = 0.7;           // regrow pop duration

// ------------------------------------------------------------------ palette
// sRGB hexes like the rest of the game, linearised because the scene renders into a linear render
// target (the post pass does the final sRGB encode). Injected into the shader as constants.
const lin = (hex: string) => { const c = new THREE.Color(hex).convertSRGBToLinear(); return `${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)}`; };
const PAL = {
  base: lin('#2e6a2a'),   // dark root
  tip: lin('#7bc65f'),    // matches the ground's light grass speckle
  tipL: lin('#a4d870'),
  dry: lin('#a8b050'),    // highland / moor bleach
  petals: ['#f8f8f8', '#f8d848', '#f07070', '#8aa0f8'].map(lin), // same petals as the ground texture
};

// ------------------------------------------------------------------ shaders
const VERT = /* glsl */ `
uniform float uTime;
uniform sampler2D uWindTex;
uniform float uWindScale;
uniform vec2 uWindDir;
uniform float uGust;
uniform float uLean;
uniform float uSway;
uniform vec2 uPlayer;
uniform float uPlayerR;
uniform float uPush;
uniform float uAmbient;
uniform float uSun;
uniform vec2 uRight;   // camera-right direction in world XZ: blades always face the screen
attribute vec4 aData0; // xyz = root on the ground plane, w = blade height
attribute vec4 aData1; // x = width, y = phase, z = tint code, w = lean
attribute float aData2; // dryness: 0 lush, 1 bleached (tracks the world's biome blend per blade)
attribute float aCut;   // game time the tuft was cut, or -1 while it stands
varying vec3 vCol;
varying float vShade;
varying float vGust;

const vec3 C_BASE = vec3(${PAL.base});
const vec3 C_TIP  = vec3(${PAL.tip});
const vec3 C_TIPL = vec3(${PAL.tipL});
const vec3 C_DRY  = vec3(${PAL.dry});
const vec3 PET0 = vec3(${PAL.petals[0]});
const vec3 PET1 = vec3(${PAL.petals[1]});
const vec3 PET2 = vec3(${PAL.petals[2]});
const vec3 PET3 = vec3(${PAL.petals[3]});
const float CUT_FLY = ${CUT_FLY.toFixed(3)};
const float CUT_REGROW = ${CUT_REGROW.toFixed(3)};
const float CUT_GROW = ${CUT_GROW.toFixed(3)};

void main() {
  float bend = position.y;      // unit blade: 0 at the root, 1 at the tip
  vec3 root = aData0.xyz;
  float H = aData0.w;
  float W = aData1.x;
  float phase = aData1.y;
  float tint = aData1.z;
  float lean = aData1.w;
  float dry = aData2;

  // cut state: -1 = standing, [0,FLY) = airborne piece, [FLY,REGROW) = gone, then a regrow pop
  float age = aCut < 0.0 ? -1.0 : uTime - aCut;
  if (age >= CUT_FLY && age < CUT_REGROW) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0); // degenerate, off-screen
    vCol = vec3(0.0); vShade = 0.0; vGust = 0.0;
    return;
  }
  float grow = age >= CUT_REGROW ? smoothstep(0.0, CUT_GROW, age - CUT_REGROW) : 1.0;
  grow = 1.0 - (1.0 - grow) * (1.0 - grow);
  H *= grow; W *= grow;

  // blade in its screen-aligned local frame: lx along camera-right, ly up
  float lx = position.x * W + lean * bend;
  float ly = bend * H;
  float rise = 0.0, flying = 0.0;
  vec2 scatter = vec2(0.0);
  if (age >= 0.0 && age < CUT_FLY) {
    // the tuft detaches: the whole piece pops up, tumbles, drifts outward and shrinks away
    flying = 1.0;
    float f = age / CUT_FLY;
    float e = 1.0 - (1.0 - f) * (1.0 - f);
    float spin = (fract(phase * 0.618) - 0.5) * 9.0 * f;
    float c = cos(spin), s = sin(spin);
    float cy = ly - H * 0.45;
    float rx = lx * c - cy * s, ry = lx * s + cy * c;
    float shrink = 1.0 - smoothstep(0.5, 1.0, f);
    lx = rx * shrink;
    ly = (ry + H * 0.45) * shrink;
    rise = 0.12 + e * 0.95;
    scatter = vec2(cos(phase * 3.1), sin(phase * 3.1)) * e * 0.28;
    bend = 1.0; // airborne pieces ride the wind as a whole
  }

  vec3 p = root;
  p.xz += uRight * lx + scatter;
  p.y  += ly + rise;
  float b2 = bend * bend;

  // travelling wind: a noise field scrolled across the meadow, plus a per-blade idle sway
  vec2 wuv = p.xz / uWindScale + uWindDir * (uTime * 0.13);
  float gust = texture2D(uWindTex, wuv).r;
  vec2 off = uWindDir * ((gust - 0.42) * uGust + uLean);
  off += vec2(sin(uTime * 2.1 + phase + p.z * 0.8), cos(uTime * 1.7 + phase * 1.3 + p.x * 0.6)) * uSway;
  p.xz += off * b2;
  p.y  -= length(off) * b2 * 0.3 * H; // keep the blade's length roughly constant as it leans

  // the player parts the grass
  vec2 d = p.xz - uPlayer;
  float pd = length(d);
  float push = (1.0 - smoothstep(uPlayerR * 0.15, uPlayerR, pd)) * uPush * (1.0 - flying);
  p.xz += (d / max(pd, 1e-4)) * push * bend;
  p.y -= push * bend * 0.2 * H;

  // colour: dark root -> bright tip, per-blade tint, bleached toward dry by the region
  if (tint > 1.4) {
    // a flower: green stem, petal-coloured head at the tip
    vec3 petal = tint < 2.5 ? PET0 : tint < 3.5 ? PET1 : tint < 4.5 ? PET2 : PET3;
    vCol = bend > 0.6 ? petal : mix(C_BASE, C_TIP, 0.5);
  } else {
    vec3 tip = mix(C_TIP, C_TIPL, tint);
    tip = mix(tip, C_DRY, dry);
    vec3 base = mix(C_BASE, C_DRY, dry * 0.65);
    vCol = mix(base, tip, bend);
  }

  // shade: quantised bands like the ground's toon gradient, picked per blade (BotW's fields are a
  // mosaic of green shades), plus fake occlusion toward the root and a shimmer when gusts hit
  float qv = fract(phase * 2.399);
  float q = qv > 0.7 ? 1.0 : qv > 0.4 ? 0.78 : 0.6;
  vShade = (uAmbient + uSun * q) * (0.72 + 0.28 * bend) * (1.0 + 0.18 * flying);
  vGust = gust * b2;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const FRAG = /* glsl */ `
varying vec3 vCol;
varying float vShade;
varying float vGust;
void main() {
  // gusts catch the light: the tips brighten as a wave rolls through (the BotW field shimmer)
  gl_FragColor = vec4(vCol * (vShade + vGust * 0.22), 1.0);
}
`;

// ------------------------------------------------------------------ placement rules
/** Patchiness: smooth value noise (two octaves) so grass grows in BoTW-style clumps, not uniformly. */
function valueNoise(x: number, z: number, cell: number, salt: number): number {
  const x0 = Math.floor(x / cell), z0 = Math.floor(z / cell);
  const fx = x / cell - x0, fz = z / cell - z0;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const h00 = hash2(x0, z0, salt), h10 = hash2(x0 + 1, z0, salt), h01 = hash2(x0, z0 + 1, salt), h11 = hash2(x0 + 1, z0 + 1, salt);
  return (h00 * (1 - sx) + h10 * sx) * (1 - sz) + (h01 * (1 - sx) + h11 * sx) * sz;
}
function clumpNoise(tx: number, tz: number): number {
  return 0.55 * valueNoise(tx, tz, 7, 7) + 0.3 * valueNoise(tx, tz, 3, 17) + 0.15 * valueNoise(tx, tz, 1.5, 27);
}

/**
 * How many tufts a tile grows (0..MAX_TUFTS_PER_TILE). Deterministic, so the sword can ask about
 * tiles whose chunk isn't built. Zelda-style: tufts are discrete, patchy things — the lush heart
 * of a meadow fills up, the fringes thin out to the odd tuft, and plenty of green tiles stay bare
 * (the ground's grass texture is the base layer; tufts sit on top of it).
 */
export function tuftCount(w: World, tx: number, tz: number): number {
  if (!w.canGrowGrass(tx, tz)) return 0;
  const t = w.tile(tx, tz);
  const { density } = biomeMix(w, tx, tz);
  const tileMul = t === Tile.Heather ? 0.5 : t === Tile.DryGrass ? 0.7 : 1;
  const clump = clumpNoise(tx, tz);
  const lush = clamp((clump - 0.27) / 0.5, 0, 1) * density * tileMul;
  if (lush <= 0) return 0;
  // dropout: even inside lush patches some tiles are bare, and sparse fringes are mostly bare
  if (hash2(tx, tz, 29) < 0.08 + 0.45 * (1 - lush)) return 0;
  const e = lush * (MAX_TUFTS_PER_TILE + 0.4);
  const n = Math.floor(e) + (hash2(tx, tz, 23) < e - Math.floor(e) ? 1 : 0);
  return Math.min(MAX_TUFTS_PER_TILE, n);
}

/**
 * Lushness + dryness per biome, blended with the world's own soft biome weights so the carpet
 * transitions across borders exactly like the ground colours do (no hard lines at region edges).
 * Meadows grow a full BotW carpet; the rocky mesa and the amber highland only sparse steppe.
 */
const BIOME_DENSITY: Record<Biome, number> = { meadow: 1.0, lake: 0.95, farm: 0.85, marsh: 0.55, moor: 0.45, mesa: 0.35, highland: 0.25 };
const BIOME_DRY: Record<Biome, number> = { meadow: 0, lake: 0, farm: 0.05, marsh: 0.2, moor: 0.25, mesa: 0.4, highland: 0.7 };
function biomeMix(w: World, tx: number, tz: number): { density: number; dry: number } {
  const bw = w.biomeWeights(tx, tz);
  let density = 0, dry = 0;
  for (const b of Object.keys(BIOME_DENSITY) as Biome[]) {
    const wt = bw[b];
    if (!wt) continue;
    density += wt * BIOME_DENSITY[b];
    dry += wt * BIOME_DRY[b];
  }
  return { density, dry };
}

// ------------------------------------------------------------------ system
export class GrassSystem {
  readonly root = new THREE.Group();
  private world: World;
  private material: THREE.ShaderMaterial;
  private windTex: THREE.Texture;
  private chunks = new Map<number, THREE.Mesh | null>();
  private queue: number[] = [];
  private queued = new Set<number>();
  private chX = Math.ceil(MAP_W / GRASS_CHUNK);
  private chZ = Math.ceil(MAP_H / GRASS_CHUNK);
  /** tile index -> game time it was cut; survives chunk streaming so cut tiles stay cut */
  private cuts = new Map<number, number>();
  private now = 0;

  constructor(world: World) {
    this.world = world;
    this.windTex = GrassSystem.makeWindTexture();
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uWindTex: { value: this.windTex },
        uWindScale: { value: 13 },
        uWindDir: { value: new THREE.Vector2(1, 0.35).normalize() },
        uGust: { value: 0.34 },
        uLean: { value: 0.16 },
        uSway: { value: 0.055 },
        uPlayer: { value: new THREE.Vector2(-999, -999) },
        uPlayerR: { value: 0.8 },
        uPush: { value: 0.42 },
        uAmbient: { value: 0.6 },
        uSun: { value: 0.42 },
        uRight: { value: new THREE.Vector2(1, 0) },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.DoubleSide,
    });
  }

  /** Stream chunks around the camera, drive the wind. Called once per frame. */
  update(time: number, camX: number, camZ: number, radiusTiles: number, px: number, pz: number, viewAngle = 0) {
    const u = this.material.uniforms;
    u.uTime.value = time;
    this.now = time;
    (u.uPlayer.value as THREE.Vector2).set(px, pz);
    (u.uRight.value as THREE.Vector2).set(Math.cos(viewAngle), -Math.sin(viewAngle));

    const ccx = Math.floor(camX / GRASS_CHUNK), ccz = Math.floor(camZ / GRASS_CHUNK);
    const r = Math.max(1, Math.ceil(radiusTiles / GRASS_CHUNK) + 1);
    const needed = new Set<number>();
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      const cx = ccx + dx, cz = ccz + dz;
      if (cx < 0 || cz < 0 || cx >= this.chX || cz >= this.chZ) continue;
      const key = cz * this.chX + cx;
      needed.add(key);
      if (!this.chunks.has(key) && !this.queued.has(key)) { this.queued.add(key); this.queue.push(key); }
    }
    if (this.queue.length) {
      const d2 = (k: number) => { const cx = k % this.chX, cz = Math.floor(k / this.chX); return (cx - ccx) ** 2 + (cz - ccz) ** 2; };
      this.queue.sort((a, b) => d2(a) - d2(b));
      let n = BUILD_PER_FRAME;
      while (n-- > 0 && this.queue.length) {
        const key = this.queue.shift()!;
        this.queued.delete(key);
        if (this.chunks.has(key) || !needed.has(key)) continue;
        this.buildChunk(key);
      }
    }
    // unload chunks that fell out of range (keep one ring of hysteresis)
    for (const [key, mesh] of this.chunks) {
      const cx = key % this.chX, cz = Math.floor(key / this.chX);
      if (Math.max(Math.abs(cx - ccx), Math.abs(cz - ccz)) > r + 1) {
        if (mesh) { this.root.remove(mesh); mesh.geometry.dispose(); }
        this.chunks.delete(key);
      }
    }
  }

  /** Advance the wind clock without streaming (used by the model viewer). */
  setTime(t: number) { this.material.uniforms.uTime.value = t; this.now = t; }

  /** Does this tile currently have standing tufts the sword could cut? */
  hasTufts(tx: number, tz: number): boolean {
    if (tx < 0 || tz < 0 || tx >= MAP_W || tz >= MAP_H) return false;
    const cutAt = this.cuts.get(tz * MAP_W + tx);
    if (cutAt !== undefined && this.now - cutAt < CUT_REGROW) return false;
    return tuftCount(this.world, tx, tz) > 0;
  }

  /**
   * Cut the tufts on a tile: they detach and fly off (shader-side), then regrow after CUT_REGROW.
   * Returns false if there was nothing standing to cut.
   */
  cut(tx: number, tz: number): boolean {
    if (!this.hasTufts(tx, tz)) return false;
    const tileKey = tz * MAP_W + tx;
    this.cuts.set(tileKey, this.now);
    const mesh = this.chunks.get(Math.floor(tz / GRASS_CHUNK) * this.chX + Math.floor(tx / GRASS_CHUNK));
    if (mesh) this.writeCut(mesh.geometry as THREE.InstancedBufferGeometry, tileKey, this.now);
    return true;
  }

  /** Everything regrows at once (game restart). */
  resetCuts() {
    this.cuts.clear();
    for (const mesh of this.chunks.values()) {
      if (!mesh) continue;
      const attr = mesh.geometry.getAttribute('aCut') as THREE.InstancedBufferAttribute;
      (attr.array as Float32Array).fill(-1);
      attr.needsUpdate = true;
    }
  }

  private writeCut(geo: THREE.InstancedBufferGeometry, tileKey: number, t: number) {
    const ranges = geo.userData.tileRanges as Map<number, [number, number]>;
    const range = ranges?.get(tileKey);
    if (!range) return;
    const attr = geo.getAttribute('aCut') as THREE.InstancedBufferAttribute;
    const arr = attr.array as Float32Array;
    for (let i = range[0]; i < range[0] + range[1]; i++) arr[i] = t;
    attr.addUpdateRange(range[0], range[1]);
    attr.needsUpdate = true;
  }

  /**
   * Drop the chunk containing this tile so it regrows with the current solidity next time it's
   * near the camera (a bush was cut -> grass may grow there, or respawned -> it may not).
   */
  invalidate(tx: number, tz: number) {
    if (tx < 0 || tz < 0 || tx >= MAP_W || tz >= MAP_H) return;
    const key = Math.floor(tz / GRASS_CHUNK) * this.chX + Math.floor(tx / GRASS_CHUNK);
    const mesh = this.chunks.get(key);
    if (mesh === undefined) return;
    if (mesh) { this.root.remove(mesh); mesh.geometry.dispose(); }
    this.chunks.delete(key);
  }

  dispose() {
    for (const mesh of this.chunks.values()) if (mesh) { this.root.remove(mesh); mesh.geometry.dispose(); }
    this.chunks.clear();
    this.queue = [];
    this.queued.clear();
    this.material.dispose();
    this.windTex.dispose();
  }

  /** A free-standing patch centred on the origin, for the model viewer. */
  buildPatch(tx0: number, tz0: number, wTiles: number, hTiles: number): THREE.Mesh {
    const geo = this.buildGeometry(tx0, tz0, wTiles, hTiles) ?? new THREE.InstancedBufferGeometry();
    const cx = tx0 + wTiles / 2, cz = tz0 + hTiles / 2, cy = this.groundY(cx, cz);
    const a0 = geo.getAttribute('aData0') as THREE.InstancedBufferAttribute | undefined;
    if (a0) for (let i = 0; i < a0.count; i++) { a0.setXYZ(i, a0.getX(i) - cx, a0.getY(i) - cy, a0.getZ(i) - cz); }
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.5, 0), Math.hypot(wTiles, hTiles) / 2 + 2);
    return this.makeMesh(geo);
  }

  // ------------------------------------------------------------------ internals
  private buildChunk(key: number) {
    const cx = key % this.chX, cz = Math.floor(key / this.chX);
    const tx0 = cx * GRASS_CHUNK, tz0 = cz * GRASS_CHUNK;
    const geo = this.buildGeometry(tx0, tz0, GRASS_CHUNK, GRASS_CHUNK);
    if (!geo) { this.chunks.set(key, null); return; }
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(tx0 + GRASS_CHUNK / 2, 0.5, tz0 + GRASS_CHUNK / 2), GRASS_CHUNK * 0.71 + 2);
    this.chunks.set(key, this.addMesh(this.makeMesh(geo)));
  }

  /** All chunks share one material; dryness is a per-instance attribute. */
  private makeMesh(geo: THREE.BufferGeometry): THREE.Mesh {
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.matrixAutoUpdate = false; // static, already in world space
    return mesh;
  }

  private addMesh(mesh: THREE.Mesh): THREE.Mesh {
    this.root.add(mesh);
    return mesh;
  }

  /**
   * Scatter the tufts of every tile inside a rectangle into one instanced geometry (null if nothing
   * grows). Each tile's blades are contiguous; `userData.tileRanges` maps tile index -> [start, n]
   * so a cut can stamp the tile's blades without rebuilding the chunk.
   */
  private buildGeometry(tx0: number, tz0: number, wTiles: number, hTiles: number): THREE.InstancedBufferGeometry | null {
    const w = this.world;
    const d0: number[] = [], d1: number[] = [], d2: number[] = [], dc: number[] = [];
    const ranges = new Map<number, [number, number]>();
    // prune stale cuts while we're here
    for (const [k, t] of this.cuts) if (this.now - t >= CUT_REGROW + CUT_GROW) this.cuts.delete(k);
    outer:
    for (let tz = tz0; tz < tz0 + hTiles; tz++) for (let tx = tx0; tx < tx0 + wTiles; tx++) {
      const tufts = tuftCount(w, tx, tz);
      if (!tufts) continue;
      const t = w.tile(tx, tz);
      const { dry } = biomeMix(w, tx, tz);
      const flowerTile = t === Tile.Flowers;
      const tileKey = tz * MAP_W + tx;
      const cutAt = this.cuts.get(tileKey);
      const cutVal = cutAt !== undefined && this.now - cutAt < CUT_REGROW + CUT_GROW ? cutAt : -1;
      const start = d0.length / 4;
      const seed = tx * 731 + tz * 197;
      const q0 = Math.floor(hash2(tx, tz, 31) * 4);
      let i = 0;
      for (let k = 0; k < tufts; k++) {
        // tuft centre: one per (shuffled) quadrant, jittered, so tufts on a tile stay separate
        const q = (q0 + k) % 4;
        const hq = hash2(seed, k, 3), hq2 = hash2(seed, k, 4);
        const cx = tx + 0.28 + (q & 1) * 0.44 + (hq - 0.5) * 0.16;
        const cz = tz + 0.28 + (q >> 1) * 0.44 + (hq2 - 0.5) * 0.16;
        const blades = BLADES_PER_TUFT_MIN + Math.floor(hash2(seed, k, 5) * (BLADES_PER_TUFT_RND + 1));
        for (let b = 0; b < blades; b++, i++) {
          // every random value for this blade derives from two hashes (chunk builds are hot)
          const h1 = hash2(seed, i, 1), h2 = hash2(seed, i, 2);
          const rnd = (n: number) => { const v = h1 * (n * 1.37 + 0.71) + h2 * (n * 2.13 + 1.17); return v - Math.floor(v); };
          const ang = rnd(3) * Math.PI * 2, rad = Math.sqrt(rnd(4)) * 0.17;
          const x = clamp(cx + Math.cos(ang) * rad, tx + 0.04, tx + 0.96), z = clamp(cz + Math.sin(ang) * rad, tz + 0.04, tz + 0.96);
          const isFlower = flowerTile && rnd(9) < 0.08;
          // blades near the tuft's heart stand tallest
          const H = (0.3 + rnd(5) * 0.3 + (1 - rad / 0.17) * 0.12) * (1 - dry * 0.22) * (isFlower ? 1.18 : 1);
          const W = 0.09 + rnd(6) * 0.075;
          d0.push(x, this.groundY(x, z), z, H);
          d1.push(W, rnd(7) * Math.PI * 2, isFlower ? 1.5 + Math.floor(rnd(10) * 4) : rnd(10), (rnd(8) - 0.5) * 0.4);
          d2.push(dry);
          dc.push(cutVal);
          if (d0.length / 4 >= MAX_BLADES_PER_CHUNK) { ranges.set(tileKey, [start, d0.length / 4 - start]); break outer; }
        }
      }
      ranges.set(tileKey, [start, d0.length / 4 - start]);
    }
    if (!d0.length) return null;
    const g = new THREE.InstancedBufferGeometry();
    // unit blade: base edge at y=0 (x = ±0.5), tip at y=1 — position.y doubles as the bend weight
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0, 1, 0], 3));
    g.setAttribute('aData0', new THREE.InstancedBufferAttribute(new Float32Array(d0), 4));
    g.setAttribute('aData1', new THREE.InstancedBufferAttribute(new Float32Array(d1), 4));
    g.setAttribute('aData2', new THREE.InstancedBufferAttribute(new Float32Array(d2), 1));
    const cutAttr = new THREE.InstancedBufferAttribute(new Float32Array(dc), 1);
    cutAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aCut', cutAttr);
    g.instanceCount = d0.length / 4;
    g.userData.tileRanges = ranges;
    return g;
  }

  /**
   * Terrain height exactly as the ground mesh draws it: each tile is split along its shorter
   * diagonal into two flat triangles (see World.createGroundGeometry), so sample those planes
   * rather than the bilinear heightfield — blades then never float or sink on slopes.
   */
  private groundY(x: number, z: number): number {
    const w = this.world;
    const tx = Math.floor(x), tz = Math.floor(z);
    const h00 = w.cornerH(tx, tz), h10 = w.cornerH(tx + 1, tz), h01 = w.cornerH(tx, tz + 1), h11 = w.cornerH(tx + 1, tz + 1);
    const fx = clamp(x - tx, 0, 1), fz = clamp(z - tz, 0, 1);
    if (Math.abs(h00 - h11) <= Math.abs(h10 - h01)) {
      // diagonal (0,0)-(1,1)
      return fz >= fx
        ? h00 + (h01 - h00) * fz + (h11 - h01) * fx
        : h00 + (h10 - h00) * fx + (h11 - h10) * fz;
    }
    // diagonal (1,0)-(0,1)
    return fx + fz <= 1
      ? h00 + (h10 - h00) * fx + (h01 - h00) * fz
      : h11 * (fx + fz - 1) + h10 * (1 - fz) + h01 * (1 - fx);
  }

  /** Seamless smooth value noise (16×16 lattice upsampled to 64×64) used by the vertex shader for gusts. */
  private static makeWindTexture(): THREE.CanvasTexture {
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
}
