import * as THREE from 'three';
import { TEX_PX, hash2 } from './constants';
import { foliageUniforms } from './foliage';
import { buildCropGeo } from './models';
import type { CropKind, FarmTile, VillageEvent, VillageState } from './village';
import type { World } from './world';

/**
 * The farm's face: everything the village simulation does to the south field, drawn.
 *
 * Two instanced draw calls do most of it — a soil quad per bed under the hoe (bare dark earth when
 * it is dry, blue-dark and damp when it has just been watered) and one merged, vertex-coloured
 * plant geometry per (crop, growth stage), so the whole field is a handful of instanced draws
 * however many beds are planted. Both are rebuilt only when something actually changed
 * (VillageState.rev) or while a plant is springing up, which is a few times a minute, not a frame.
 *
 * Crops lean into the same wind field as the grass and the bushes (foliageUniforms), and they are
 * drawn at `tileH`, so the field sits on the village terrace rather than floating over it. The
 * ground texture already paints little green crosses on every bed tile; the soil quad covers them
 * the moment a bed is worked, so a tended bed never shows two sets of plants at once.
 */

/** how long a plant takes to spring into its new size after the simulation grows it */
const POP_TIME = 0.55;
/** bare, freshly-tilled earth, and the same earth just watered */
const DRY = new THREE.Color(1, 1, 1);
const WET = new THREE.Color(0.6, 0.63, 0.76);

const CROP_VERT = /* glsl */ `
uniform float uTime;
uniform sampler2D uWindTex;
uniform float uWindScale;
uniform vec2 uWindDir;
uniform float uGust;
uniform float uSway;
uniform float uAmbient;
uniform float uSun;
attribute float aWindFactor;
varying vec3 vColour;
varying float vShade;
void main() {
  vColour = color;
  vec4 world4 = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vec3 worldPos = world4.xyz;
  // the travelling gust, plus a slow wobble that is out of step from plant to plant
  vec2 wuv = worldPos.xz / uWindScale + uWindDir * (uTime * 0.13);
  float gust = texture2D(uWindTex, wuv).r;
  float phase = worldPos.x * 1.7 + worldPos.z * 2.3;
  vec2 windOff = uWindDir * ((gust - 0.42) * uGust * 0.5);
  windOff += vec2(sin(uTime * 0.9 + phase), cos(uTime * 0.7 + phase * 1.2)) * uSway * 0.6;
  worldPos.xz += windOff * aWindFactor;
  worldPos.y -= length(windOff) * aWindFactor * 0.1;

  vec3 worldNormal = normalize(mat3(modelMatrix) * vec3(mat3(instanceMatrix) * normal));
  vec3 sunDir = normalize(vec3(-0.15, 1.0, 0.42));
  float q = floor((0.5 + 0.5 * dot(worldNormal, sunDir)) * 3.0 + 0.25) / 3.0;
  vShade = uAmbient + uSun * (0.42 + q * 0.58);
  gl_Position = projectionMatrix * viewMatrix * world4;
}
`;

const CROP_FRAG = /* glsl */ `
varying vec3 vColour;
varying float vShade;
void main() { gl_FragColor = vec4(vColour * vShade, 1.0); }
`;

export class FarmView {
  readonly root = new THREE.Group();
  private soil: THREE.InstancedMesh;
  private soilTex: THREE.CanvasTexture;
  private cropMat: THREE.ShaderMaterial;
  private meshes = new Map<string, THREE.InstancedMesh>();
  /** beds whose plant is still springing into its new size */
  private pops = new Map<number, number>();
  private rev = -1;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();

  constructor(private state: VillageState, private world: World) {
    this.soilTex = makeSoilTexture();
    this.soil = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: this.soilTex }),
      Math.max(1, state.tiles.size),
    );
    this.soil.frustumCulled = false; // instances move around the world; let the draws go through
    this.soil.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.soil.count = 0; // nothing is worked until the simulation says so
    this.root.add(this.soil);

    this.cropMat = new THREE.ShaderMaterial({
      uniforms: foliageUniforms as any, // the crops sway on the same wind as the grass
      vertexShader: CROP_VERT, fragmentShader: CROP_FRAG,
      vertexColors: true, side: THREE.DoubleSide,
    });
  }

  /** draw the farm: `events` is this frame's drained simulation events (for the growth pops) */
  update(dt: number, events: VillageEvent[]) {
    for (const ev of events) {
      if (ev.kind === 'sprout' || ev.kind === 'ripe') {
        const x = Math.floor(ev.x), z = Math.floor(ev.z);
        this.pops.set(z * this.world.w + x, POP_TIME);
      }
    }
    let popping = false;
    for (const [k, t] of [...this.pops]) {
      const left = t - dt;
      if (left <= 0) this.pops.delete(k);
      else { this.pops.set(k, left); popping = true; }
    }
    if (this.rev !== this.state.rev || popping) {
      this.rev = this.state.rev;
      this.rebuild();
    }
  }

  private plantScale(tile: FarmTile): number {
    const pop = this.pops.get(tile.i);
    if (!pop) return 1;
    const life = 1 - pop / POP_TIME;
    const eased = 1 - (1 - life) * (1 - life);
    return 0.5 + 0.5 * eased;
  }

  private rebuild() {
    // ---- soil: one dark quad per bed under the hoe
    let n = 0;
    for (const t of this.state.tiles.values()) {
      if (t.state === 'fallow') continue;
      const y = this.world.tileH(t.x, t.z) + 0.014;
      this.p.set(t.x + 0.5, y, t.z + 0.5);
      this.m4.compose(this.p, IDENTITY_Q, ONE);
      this.soil.setMatrixAt(n, this.m4);
      this.soil.setColorAt(n, t.wetT > 0 ? WET : DRY);
      n++;
    }
    this.soil.count = n;
    this.soil.instanceMatrix.needsUpdate = true;
    if (this.soil.instanceColor) this.soil.instanceColor.needsUpdate = true;

    // ---- crops: bucket the beds by (crop, stage) and lay one instanced draw per bucket
    const buckets = new Map<string, FarmTile[]>();
    for (const t of this.state.tiles.values()) {
      if (t.state !== 'sown' && t.state !== 'ripe') continue;
      const key = t.crop + ':' + t.visual;
      const list = buckets.get(key);
      if (list) list.push(t); else buckets.set(key, [t]);
    }
    for (const [key, list] of buckets) {
      const [kind, visual] = key.split(':');
      const mesh = this.meshFor(key, kind as CropKind, Number(visual));
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        const jitter = hash2(t.x, t.z, 71);
        const scale = this.plantScale(t);
        const yaw = hash2(t.x, t.z, 72) * Math.PI * 2;
        this.q.setFromAxisAngle(UP, yaw);
        this.p.set(t.x + 0.5, this.world.tileH(t.x, t.z) + 0.02, t.z + 0.5);
        const sy = scale * (0.92 + jitter * 0.16);
        this.s.set(scale * (0.94 + jitter * 0.12), sy, scale * (0.94 + jitter * 0.12));
        this.m4.compose(this.p, this.q, this.s);
        mesh.setMatrixAt(i, this.m4);
      }
      mesh.count = list.length;
      mesh.instanceMatrix.needsUpdate = true;
    }
    for (const [key, mesh] of this.meshes) if (!buckets.has(key)) mesh.count = 0;
  }

  private meshFor(key: string, kind: CropKind, stage: number): THREE.InstancedMesh {
    let mesh = this.meshes.get(key);
    if (!mesh) {
      mesh = new THREE.InstancedMesh(buildCropGeo(kind, stage), this.cropMat, Math.max(1, this.state.tiles.size));
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.root.add(mesh);
      this.meshes.set(key, mesh);
    }
    return mesh;
  }

  dispose() {
    for (const mesh of this.meshes.values()) { mesh.geometry.dispose(); this.root.remove(mesh); }
    this.meshes.clear();
    this.root.remove(this.soil);
    this.soil.geometry.dispose();
    (this.soil.material as THREE.Material).dispose();
    this.soilTex.dispose();
    this.cropMat.dispose();
  }
}

const IDENTITY_Q = new THREE.Quaternion();
const ONE = new THREE.Vector3(1, 1, 1);
const UP = new THREE.Vector3(0, 1, 0);

/** tilled soil: dark cloddy earth with the furrows running across the bed */
function makeSoilTexture(): THREE.CanvasTexture {
  const S = TEX_PX;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#6b4626';
  g.fillRect(0, 0, S, S);
  for (let y = 1; y < S; y += 5) {
    g.fillStyle = '#7d5531'; g.fillRect(0, y, S, 2);   // ridge catching the light
    g.fillStyle = '#4a3018'; g.fillRect(0, y + 2, S, 1); // shadow in the furrow
  }
  for (let i = 0; i < 30; i++) {
    const x = Math.floor(hash2(i, 1, 5) * S), y = Math.floor(hash2(i, 2, 6) * S);
    g.fillStyle = hash2(i, 3, 7) < 0.5 ? '#5a3a1e' : '#83593a';
    g.fillRect(x, y, 1 + (i % 2), 1);
  }
  g.fillStyle = '#4a3018';
  g.fillRect(0, 0, S, 1); g.fillRect(0, S - 1, S, 1);
  g.fillRect(0, 0, 1, S); g.fillRect(S - 1, 0, 1, S);
  const tex = new THREE.CanvasTexture(cv);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
