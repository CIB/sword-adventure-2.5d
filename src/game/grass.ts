/**
 * Breath of the Wild-style animated grass.
 *
 * The meadows are covered in small tufts of tapered blades — opaque triangle strips, no alpha
 * textures, so they stay crisp at the game's chunky resolution. Blades are merged into one mesh
 * per 16×16-tile chunk, streamed around the camera, and animated entirely in the vertex shader:
 *
 *  - travelling gusts: a noise field scrolled through the field in world space pushes the tips,
 *  - idle sway: a per-blade phase makes every tuft dance slightly out of step,
 *  - the player parts the grass radially as she walks through it (the classic BotW touch),
 *  - shading is a quantised lambert on the blade face, matching the ground's toon gradient.
 *
 * Vertex layout per blade (5 verts, 3 tris): root L/R, middle L/R, tip. The `uv` attribute carries
 * (bend weight, random phase) instead of texture coordinates, and per-vertex colours run from a
 * dark root to a bright tip with per-tuft tint variation.
 */
import * as THREE from 'three';
import { clamp, hash2, MAP_W, MAP_H, Tile } from './constants';
import type { World } from './world';

export const GRASS_CHUNK = 16; // tiles per chunk side
const BUILD_PER_FRAME = 2;     // chunk budget per frame (avoids hitches while travelling)
const MAX_BLADES_PER_CHUNK = 1500;

// ------------------------------------------------------------------ palette
// sRGB hexes like the rest of the game; linearised here because the scene renders into a linear
// render target (the post pass does the final sRGB encode). Kept as [r,g,b] triples for fast mixing.
type RGB = [number, number, number];
const lin = (hex: string): RGB => { const c = new THREE.Color(hex).convertSRGBToLinear(); return [c.r, c.g, c.b]; };
const C_BASE = lin('#3f7a34');   // dark root
const C_TIP = lin('#7bc65f');    // matches the ground's light grass speckle
const C_TIP_L = lin('#9ad86e');
const C_DRY = lin('#9aa84e');    // highland / moor tint
const C_COOL = lin('#4f9f66');   // shaded-forest tint
const PETALS: RGB[] = ['#f8f8f8', '#f8d848', '#f07070', '#8aa0f8'].map(lin); // same petals as the ground texture

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
uniform vec3 uSunDir;
uniform float uAmbient;
uniform float uSun;
attribute vec3 aCol;
varying vec3 vCol;
varying float vShade;
varying float vGust;

void main() {
  float bend = uv.x;    // 0 at the root, 1 at the tip
  float phase = uv.y;   // per-blade random phase
  vec3 p = position;
  float b2 = bend * bend;

  // travelling wind: a noise field scrolled across the meadow, plus a per-blade idle sway
  vec2 wuv = p.xz / uWindScale + uWindDir * (uTime * 0.13);
  float gust = texture2D(uWindTex, wuv).r;
  vec2 off = uWindDir * ((gust - 0.42) * uGust + uLean);
  off += vec2(sin(uTime * 2.1 + phase + p.z * 0.8), cos(uTime * 1.7 + phase * 1.3 + p.x * 0.6)) * uSway;
  p.xz += off * b2;
  p.y -= length(off) * b2 * 0.32; // keep the blade's length roughly constant as it leans

  // the player parts the grass
  vec2 d = p.xz - uPlayer;
  float pd = length(d);
  float push = (1.0 - smoothstep(uPlayerR * 0.15, uPlayerR, pd)) * uPush;
  p.xz += (d / max(pd, 1e-4)) * push * bend;
  p.y -= push * bend * 0.22;

  // toon-ish shading: quantised two-sided lambert on the blade face, like the ground's gradient map
  float ndl = abs(dot(normalize(normal), uSunDir));
  float q = ndl > 0.72 ? 1.0 : ndl > 0.42 ? 0.78 : ndl > 0.18 ? 0.58 : 0.4;
  vShade = uAmbient + uSun * q;
  vGust = gust * b2;
  vCol = aCol;

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
  return 0.7 * valueNoise(tx, tz, 5, 7) + 0.3 * valueNoise(tx, tz, 2, 17);
}

/** Lushness per region (mirrors the world's flower placement: meadows bloom, the moor barely grows). */
function regionDensity(tx: number, tz: number): number {
  if (tx > 150 && tz < 40) return 0.3;                 // Amber Highland: sparse
  if (tx > 140 && tz > 60 && tz < 120) return 0.42;    // Grey Moor
  if (tx >= 1 && tx <= 32 && tz >= 1 && tz <= 29) return 0.85; // Thistledown: kept lawns
  if (tx < 60 && tz < 50) return 1.0;                  // the home meadow
  return 0.8;
}
/** 0 = lush green, 1 = dry amber (blades bleach on the highland and the moor). */
function regionDryness(tx: number, tz: number): number {
  if (tx > 150 && tz < 40) return 0.55;
  if (tx > 140 && tz > 60 && tz < 120) return 0.35;
  if (tx > 140 && tz >= 120) return 0.2; // the Drowned Field
  return 0;
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
        uSunDir: { value: new THREE.Vector3(-0.15, 1, 0.42).normalize() }, // same direction as the game's sun
        uAmbient: { value: 0.6 },
        uSun: { value: 0.42 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.DoubleSide,
    });
  }

  /** Stream chunks around the camera and drive the wind. Called once per frame. */
  update(time: number, camX: number, camZ: number, radiusTiles: number, px: number, pz: number) {
    const u = this.material.uniforms;
    u.uTime.value = time;
    (u.uPlayer.value as THREE.Vector2).set(px, pz);

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
  setTime(t: number) { this.material.uniforms.uTime.value = t; }

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
    const geo = this.buildGeometry(tx0, tz0, wTiles, hTiles) ?? new THREE.BufferGeometry();
    const cx = tx0 + wTiles / 2, cz = tz0 + hTiles / 2;
    geo.translate(-cx, -this.groundY(cx, cz), -cz);
    return new THREE.Mesh(geo, this.material);
  }

  // ------------------------------------------------------------------ internals
  private buildChunk(key: number) {
    const cx = key % this.chX, cz = Math.floor(key / this.chX);
    const geo = this.buildGeometry(cx * GRASS_CHUNK, cz * GRASS_CHUNK, GRASS_CHUNK, GRASS_CHUNK);
    this.chunks.set(key, geo ? this.addMesh(geo) : null);
  }

  private addMesh(geo: THREE.BufferGeometry): THREE.Mesh {
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.matrixAutoUpdate = false; // static, already in world space
    this.root.add(mesh);
    return mesh;
  }

  /** Merge every tuft inside a tile rectangle into one world-space geometry (null if nothing grows there). */
  private buildGeometry(tx0: number, tz0: number, wTiles: number, hTiles: number): THREE.BufferGeometry | null {
    const w = this.world;
    const pos: number[] = [], nrm: number[] = [], col: number[] = [], uv: number[] = [], idx: number[] = [];
    let blades = 0;
    outer:
    for (let tz = tz0; tz < tz0 + hTiles; tz++) for (let tx = tx0; tx < tx0 + wTiles; tx++) {
      if (!w.canGrowGrass(tx, tz)) continue;
      const clump = clumpNoise(tx, tz);
      const p = regionDensity(tx, tz) * (0.25 + 1.15 * clump);
      const flowerTile = w.tile(tx, tz) === Tile.Flowers;
      let tufts = 0;
      if (hash2(tx, tz, 1) < p) tufts++;
      if (clump > 0.62 && hash2(tx, tz, 2) < p * 0.8) tufts++;
      if (!tufts) continue;
      const dry = regionDryness(tx, tz);
      for (let t = 0; t < tufts; t++) {
        const jx = (hash2(tx, tz, 11 + t) - 0.5) * 0.7, jz = (hash2(tx, tz, 21 + t) - 0.5) * 0.7;
        const x = tx + 0.5 + jx, z = tz + 0.5 + jz;
        blades += this.addTuft(pos, nrm, col, uv, idx, x, z, tx * 731 + tz * 197 + t * 57,
          dry, flowerTile && hash2(tx, tz, 31 + t) < 0.6);
        if (blades > MAX_BLADES_PER_CHUNK) break outer;
      }
    }
    if (!idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('aCol', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    return g;
  }

  /** One tuft of 4-6 blades radiating from a centre. Returns the number of blades added. */
  private addTuft(pos: number[], nrm: number[], col: number[], uv: number[], idx: number[],
    x: number, z: number, seed: number, dry: number, flower: boolean): number {
    // All the tuft's randomness comes from 2 hashes; extra draws are cheap arithmetic remixes of
    // those two (chunk builds are hot — this keeps them under a millisecond).
    const h1 = hash2(seed, 0, 1), h2 = hash2(seed, 0, 2);
    const frac = (v: number) => v - Math.floor(v);
    const rnd = (k: number) => frac(h1 * (k * 1.37 + 0.71) + h2 * (k * 2.13 + 1.17));
    // per-tuft tint: a shade of green nudged cool or dry by the region ([r,g,b] linear triples)
    const mix = (a: readonly number[], b: readonly number[], t: number) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    let base = mix(C_BASE, C_COOL, rnd(9) * 0.35);
    let tip = mix(C_TIP, C_TIP_L, rnd(10));
    if (dry > 0) { tip = mix(tip, C_DRY, dry); base = mix(base, C_DRY, dry * 0.6); }
    const mid = mix(base, tip, 0.45);
    const petal = PETALS[Math.floor(rnd(12) * PETALS.length)];
    const n = 4 + Math.floor(rnd(11) * 3);
    const flowerBlade = flower ? Math.floor(rnd(13) * n) : -1;
    for (let i = 0; i < n; i++) {
      const isFlower = i === flowerBlade;
      const bi = i + 2; // per-blade draw offset
      const h = (0.42 + rnd(bi * 7 + 1) * 0.34) * (isFlower ? 1.15 : 1);
      const yaw = rnd(bi * 7 + 2) * Math.PI;
      const dirX = Math.cos(yaw), dirZ = Math.sin(yaw); // the blade's width axis
      const rad = rnd(bi * 7 + 3) * 0.17, ang = rnd(bi * 7 + 4) * Math.PI * 2;
      const bx = x + Math.cos(ang) * rad, bz = z + Math.sin(ang) * rad;
      const y = this.groundY(bx, bz);                        // the blade extrudes from the ground at its centre
      const hw = 0.055 + rnd(bi * 7 + 5) * 0.045;       // half width
      const lean = (rnd(bi * 7 + 6) - 0.5) * hw * 1.2;   // the tip curls a little
      const phase = rnd(bi * 7 + 7) * Math.PI * 2;
      const vi = pos.length / 3;
      const V = (px: number, py: number, pz: number, bend: number) => {
        pos.push(px, py, pz);
        nrm.push(-dirZ, 0, dirX); // blade-face normal (shading uses abs(dot))
        uv.push(bend, phase);
      };
      // root corners sit exactly on the drawn ground plane (their own xz, not the blade centre's,
      // so the base edge never floats or sinks on slopes)
      V(bx - hw * dirX, this.groundY(bx - hw * dirX, bz - hw * dirZ), bz - hw * dirZ, 0);
      V(bx + hw * dirX, this.groundY(bx + hw * dirX, bz + hw * dirZ), bz + hw * dirZ, 0);
      V(bx - hw * 0.55 * dirX, y + h * 0.52, bz - hw * 0.55 * dirZ, 0.52);
      V(bx + hw * 0.55 * dirX, y + h * 0.52, bz + hw * 0.55 * dirZ, 0.52);
      V(bx + lean * dirX, y + h, bz + lean * dirZ, 1);
      const cMid = isFlower ? mix(mid, petal, 0.4) : mid;
      const cTip = isFlower ? petal : tip;
      col.push(...base, ...base, ...cMid, ...cMid, ...cTip);
      idx.push(vi, vi + 1, vi + 2, vi + 2, vi + 1, vi + 3, vi + 2, vi + 3, vi + 4);
    }
    return n;
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
