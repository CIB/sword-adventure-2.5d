/**
 * The one wind every plant in the game samples.
 *
 * Grass blades, tree canopies, bushes and ferns all read the SAME scrolling noise field with the
 * SAME clock and direction, so a gust that ripples across a meadow also rolls through the trees
 * standing in it (BotW drives all of its vegetation from one shared wind texture for exactly this
 * reason). The uniforms below are shared *objects*: every vegetation material spreads them in, so
 * writing `uTime` once per frame animates the whole landscape.
 *
 * Two different feature scales are read from the one texture:
 *   `uWindScale`    — grass-sized eddies (~0.8 world units per noise cell).
 *   `uCanopyScale`  — the same field read coarser, so a whole tree sways as one body instead of
 *                     boiling card by card. Same texture, same scroll speed, same direction.
 *
 * `uRight` / `uUp` are the projection's screen axes expressed in world space. The game renders an
 * oblique (sheared) orthographic projection, so "screen up" is NOT world up: a world offset `d`
 * lands on screen at `(d·right, d·(up + SHEAR·Y))`. `uRight` and `uUp` are those two basis vectors
 * pre-divided so that `anchor + uRight*x + uUp*y` places a quad of exactly `x`×`y` SCREEN units —
 * which is what the billboarded leaf cards and the screen-aligned grass blades both need.
 */
import * as THREE from 'three';
import { clamp, hash2, SHEAR } from './constants';

// ------------------------------------------------------------------ shared uniforms
/** Wind field + clock. Values are the ones the grass system has always used. */
export const windUniforms = {
  uTime: { value: 0 },
  uWindScale: { value: 13 },
  uWindDir: { value: new THREE.Vector2(1, 0.35).normalize() },
  uGust: { value: 0.34 },
  uLean: { value: 0.16 },
  uSway: { value: 0.055 },
  /** coarser read of the same field for whole-plant sway (trees, bushes, ferns) */
  uCanopyScale: { value: 34 },
};

/** Screen axes in world space (see the header). */
export const viewUniforms = {
  uRight: { value: new THREE.Vector3(1, 0, 0) },
  uUp: { value: new THREE.Vector3(0, SHEAR, -1).divideScalar(1 + SHEAR * SHEAR) },
};

/** Vegetation lighting: the same two-term toon response the grass blades use. */
export const lightUniforms = {
  uAmbient: { value: 0.6 },
  uSun: { value: 0.42 },
};

/** Every vegetation material spreads this in (plus `uWindTex`, which needs the lazy texture). */
export const vegUniforms = { ...windUniforms, ...viewUniforms, ...lightUniforms };

export function setWindTime(t: number) { windUniforms.uTime.value = t; }

/** Point the screen axes at the game's oblique camera for a given yaw (radians). */
export function setWindView(viewAngle: number) {
  const ca = Math.cos(viewAngle), sa = Math.sin(viewAngle);
  // camera right = (cos, 0, -sin); camera up (pre-shear) = (-sin, 0, -cos)
  (viewUniforms.uRight.value as THREE.Vector3).set(ca, 0, -sa);
  (viewUniforms.uUp.value as THREE.Vector3).set(-sa, SHEAR, -ca).divideScalar(1 + SHEAR * SHEAR);
}

/**
 * Aim the billboards at an arbitrary camera (the model viewer's free orbit cam). For a normal
 * camera the screen axes are just its own right/up, already unit length, so quads come out square.
 */
export function setWindBasisFromCamera(cam: THREE.Camera) {
  cam.updateMatrixWorld();
  (viewUniforms.uRight.value as THREE.Vector3).setFromMatrixColumn(cam.matrixWorld, 0).normalize();
  (viewUniforms.uUp.value as THREE.Vector3).setFromMatrixColumn(cam.matrixWorld, 1).normalize();
}

// ------------------------------------------------------------------ shared GLSL
/**
 * Uniform declarations + the two gust helpers. Every vegetation shader starts with this block so
 * the gust maths can only ever be written once.
 */
export const WIND_GLSL = /* glsl */ `
uniform float uTime;
uniform sampler2D uWindTex;
uniform float uWindScale;
uniform float uCanopyScale;
uniform vec2 uWindDir;
uniform float uGust;
uniform float uLean;
uniform float uSway;
uniform vec3 uRight;
uniform vec3 uUp;
uniform float uAmbient;
uniform float uSun;

/** The shared gust field, scrolled along the wind direction. The scale arg picks the feature size. */
float gustAt(vec2 xz, float scale) {
  return texture2D(uWindTex, xz / scale + uWindDir * (uTime * 0.13)).r;
}
/** Grass-sized push: the travelling gust plus the constant lean every plant has. */
vec2 gustPush(float gust) {
  return uWindDir * ((gust - 0.42) * uGust + uLean);
}
`;

// ------------------------------------------------------------------ sway for standard materials
/** Declared separately from WIND_GLSL: only injected materials carry these two uniforms. */
const SWAY_UNIFORMS = /* glsl */ `
uniform float uSwayGain;
uniform float uSwayTop;
`;

const SWAY_BODY = /* glsl */ `
#include <begin_vertex>
// ---- shared-gust sway: bend by height up the plant, computed in world space ----
{
  vec4 swayW4 = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  swayW4 = instanceMatrix * swayW4;
#endif
  swayW4 = modelMatrix * swayW4;
  vec3 swayW = swayW4.xyz;
  float swayH = clamp( position.y / max( uSwayTop, 1e-4 ), 0.0, 1.0 );
  float swayK = swayH * swayH;                       // roots stay put, tips travel
  float swayG = gustAt( swayW.xz, uCanopyScale );
  vec2 swayXZ = gustPush( swayG ) * uSwayGain * swayK;
  swayXZ += vec2( sin( uTime * 1.7 + swayW.x * 0.9 ), cos( uTime * 1.35 + swayW.z * 0.8 ) ) * uSway * swayK;
  vec3 swayOff = vec3( swayXZ.x, -length( swayXZ ) * 0.35 * swayH, swayXZ.y );
#ifdef USE_INSTANCING
  // world -> object space for this instance. M = R*S, so M^-1 v is (M^T v) / |column|^2.
  mat3 sm = mat3( instanceMatrix );
  swayOff = vec3(
    dot( sm[0], swayOff ) / max( dot( sm[0], sm[0] ), 1e-6 ),
    dot( sm[1], swayOff ) / max( dot( sm[1], sm[1] ), 1e-6 ),
    dot( sm[2], swayOff ) / max( dot( sm[2], sm[2] ), 1e-6 ) );
#endif
  transformed += swayOff;
}
`;

/**
 * Make a *standard* material (MeshToonMaterial and friends) bend in the shared wind, so the
 * undergrowth and the tree trunks move with the same gusts as the grass and the leaf cards — without
 * giving up three's lighting, gradient ramps and instancing.
 *
 * `gain` is how far a fully-bent tip travels (world units), `top` is the local vertex height that
 * counts as "the tip". Both are uniforms of their own so every swaying material shares ONE compiled
 * program (three keys the program cache on the injected source, not on uniform values).
 */
export function swayMaterial<T extends THREE.Material>(mat: T, gain: { value: number }, top: { value: number } = { value: 1 }): T {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWindTex = { value: windTexture() };
    Object.assign(shader.uniforms, windUniforms, { uSwayGain: gain, uSwayTop: top });
    shader.vertexShader = WIND_GLSL + SWAY_UNIFORMS + shader.vertexShader.replace('#include <begin_vertex>', SWAY_BODY);
  };
  return mat;
}

// ------------------------------------------------------------------ wind texture
const WIND_TEX = 64;   // texture size
const WIND_GRID = 16;  // lattice cells across it (one cell ≈ uWindScale/16 world units)

let windTex: THREE.Texture | null = null;

/** Seamless smooth value noise (16×16 lattice upsampled to 64×64), shared by every plant. */
export function windTexture(): THREE.Texture {
  if (windTex) return windTex;
  const cv = document.createElement('canvas');
  cv.width = cv.height = WIND_TEX;
  const g = cv.getContext('2d')!;
  const img = g.createImageData(WIND_TEX, WIND_TEX);
  const h = (x: number, z: number) => hash2(((x % WIND_GRID) + WIND_GRID) % WIND_GRID, ((z % WIND_GRID) + WIND_GRID) % WIND_GRID, 77);
  for (let y = 0; y < WIND_TEX; y++) for (let x = 0; x < WIND_TEX; x++) {
    const gx = x / WIND_TEX * WIND_GRID, gz = y / WIND_TEX * WIND_GRID;
    const x0 = Math.floor(gx), z0 = Math.floor(gz);
    let fx = gx - x0, fz = gz - z0;
    fx = fx * fx * (3 - 2 * fx); fz = fz * fz * (3 - 2 * fz);
    const v = (h(x0, z0) * (1 - fx) + h(x0 + 1, z0) * fx) * (1 - fz)
      + (h(x0, z0 + 1) * (1 - fx) + h(x0 + 1, z0 + 1) * fx) * fz;
    const c = Math.round(clamp(v, 0, 1) * 255);
    const i = (y * WIND_TEX + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = c;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  windTex = tex;
  return tex;
}
