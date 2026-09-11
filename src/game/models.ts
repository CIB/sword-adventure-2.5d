import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { TreeSpec, HouseSpec, EnemyKind, PropSpec } from './world';

// ---------------------------------------------------------------- materials
let gradientMap: THREE.DataTexture | null = null;
export function getGradientMap(): THREE.DataTexture {
  if (gradientMap) return gradientMap;
  const levels = [0.22, 0.38, 0.58, 0.78, 1.0];
  const data = new Uint8Array(levels.map((l) => Math.round(l * 255)));
  gradientMap = new THREE.DataTexture(data, levels.length, 1, THREE.RedFormat);
  gradientMap.minFilter = THREE.NearestFilter;
  gradientMap.magFilter = THREE.NearestFilter;
  gradientMap.generateMipmaps = false;
  gradientMap.needsUpdate = true;
  return gradientMap;
}

export function toon(color: string | number | THREE.Color): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({ color, gradientMap: getGradientMap() });
}

export const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
export const UNIT_SPHERE = new THREE.SphereGeometry(0.5, 14, 10);
export const UNIT_HEMI = new THREE.SphereGeometry(0.5, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2);
export const UNIT_CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
export const UNIT_CONE = new THREE.ConeGeometry(0.5, 1, 12);
export const UNIT_PYRAMID = new THREE.ConeGeometry(0.5, 1, 4).rotateY(Math.PI / 4);
export const UNIT_OCTA = new THREE.OctahedronGeometry(0.5);
export const UNIT_CIRCLE = new THREE.CircleGeometry(0.5, 14).rotateX(-Math.PI / 2);

const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false });

export function part(geom: THREE.BufferGeometry, mat: THREE.Material, pos: [number, number, number], scale: [number, number, number]): THREE.Mesh {
  const m = new THREE.Mesh(geom, mat);
  m.position.set(pos[0], pos[1], pos[2]);
  m.scale.set(scale[0], scale[1], scale[2]);
  return m;
}

export function blobShadow(r: number): THREE.Mesh {
  const m = new THREE.Mesh(UNIT_CIRCLE, shadowMat);
  m.scale.set(r * 2, 1, r * 1.6);
  m.position.y = 0.02;
  return m;
}

export function collectMaterials(obj: THREE.Object3D): THREE.MeshToonMaterial[] {
  const set = new Set<THREE.MeshToonMaterial>();
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && (mesh.material as THREE.MeshToonMaterial).isMeshToonMaterial) set.add(mesh.material as THREE.MeshToonMaterial);
  });
  return [...set];
}

// ---------------------------------------------------------------- humanoids
export interface Humanoid {
  root: THREE.Group;
  body: THREE.Group;
  head: THREE.Group;
  armR: THREE.Group;
  armL: THREE.Group;
  handR: THREE.Group;
  handL: THREE.Group;
  legR: THREE.Group;
  legL: THREE.Group;
  weapon?: THREE.Group;
  shield?: THREE.Group;
  ponytail?: THREE.Group;
  materials: THREE.MeshToonMaterial[];
}

interface Palette { steel: THREE.Material; hilt: THREE.Material; gold: THREE.Material }

export function buildSword(p: Palette, len = 0.5): THREE.Group {
  const g = new THREE.Group();
  g.add(part(UNIT_BOX, p.steel, [0, -0.06 - len / 2, 0], [0.075, len, 0.03]));
  g.add(part(UNIT_BOX, p.steel, [0, -0.08 - len, 0], [0.04, 0.06, 0.03]));
  g.add(part(UNIT_BOX, p.hilt, [0, -0.04, 0], [0.24, 0.05, 0.07]));
  g.add(part(UNIT_CYL, p.hilt, [0, 0.06, 0], [0.055, 0.14, 0.055]));
  g.add(part(UNIT_SPHERE, p.gold, [0, 0.14, 0], [0.08, 0.08, 0.08]));
  return g;
}

function makeLeg(x: number, upper: THREE.Material, boot: THREE.Material): THREE.Group {
  const leg = new THREE.Group();
  leg.position.set(x, 0.34, 0);
  leg.add(part(UNIT_BOX, upper, [0, -0.1, 0], [0.14, 0.2, 0.15]));
  leg.add(part(UNIT_BOX, boot, [0, -0.27, 0.02], [0.16, 0.14, 0.21]));
  return leg;
}

function makeArm(x: number, sleeve: THREE.Material, skin: THREE.Material): { arm: THREE.Group; hand: THREE.Group } {
  const arm = new THREE.Group();
  arm.position.set(x, 0.74, 0);
  arm.rotation.order = 'YXZ';
  arm.add(part(UNIT_BOX, sleeve, [0, -0.08, 0], [0.13, 0.16, 0.13]));
  arm.add(part(UNIT_BOX, skin, [0, -0.2, 0], [0.11, 0.12, 0.11]));
  const hand = new THREE.Group();
  hand.position.set(0, -0.29, 0);
  hand.add(part(UNIT_SPHERE, skin, [0, 0, 0], [0.13, 0.13, 0.13]));
  arm.add(hand);
  return { arm, hand };
}

export function buildHeroine(): Humanoid {
  const m = {
    skin: toon('#f3bd92'), hair: toon('#f5cf46'), tunic: toon('#3fb04a'), tunicD: toon('#2d8c3a'),
    belt: toon('#6b4423'), boots: toon('#7b4a22'), tights: toon('#f6ebd8'), eye: toon('#1d2b5a'),
    cap: toon('#2f9038'), steel: toon('#dfe6f4'), hilt: toon('#3557c9'), gold: toon('#f2c14e'),
    shieldBlue: toon('#2f57c4'), shieldRim: toon('#cfd7e6'),
  };
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  root.add(blobShadow(0.34));

  const legL = makeLeg(0.11, m.tights, m.boots);
  const legR = makeLeg(-0.11, m.tights, m.boots);
  root.add(legL, legR);

  body.add(part(UNIT_BOX, m.tunic, [0, 0.58, 0], [0.5, 0.42, 0.3]));
  body.add(part(UNIT_BOX, m.tunicD, [0, 0.37, 0], [0.56, 0.12, 0.36]));
  body.add(part(UNIT_BOX, m.belt, [0, 0.49, 0], [0.52, 0.06, 0.32]));
  body.add(part(UNIT_BOX, m.gold, [0, 0.49, 0.16], [0.1, 0.06, 0.02]));
  body.add(part(UNIT_BOX, m.skin, [0, 0.8, 0], [0.16, 0.08, 0.14]));

  const { arm: armR, hand: handR } = makeArm(-0.3, m.tunic, m.skin);
  const { arm: armL, hand: handL } = makeArm(0.3, m.tunic, m.skin);
  body.add(armR, armL);

  const weapon = buildSword(m);
  handR.add(weapon);

  const shield = new THREE.Group();
  shield.add(part(UNIT_BOX, m.shieldRim, [0, 0, 0], [0.36, 0.42, 0.05]));
  shield.add(part(UNIT_BOX, m.shieldBlue, [0, 0, 0.02], [0.3, 0.36, 0.04]));
  shield.add(part(UNIT_CONE, m.gold, [0, 0.03, 0.05], [0.16, 0.16, 0.02]));
  shield.position.set(0, -0.04, 0.14);
  handL.add(shield);

  const head = new THREE.Group();
  head.position.set(0, 1.0, 0);
  body.add(head);
  head.add(part(UNIT_SPHERE, m.skin, [0, 0, 0], [0.64, 0.5, 0.52]));
  head.add(part(UNIT_BOX, m.eye, [-0.11, -0.04, 0.24], [0.07, 0.1, 0.04]));
  head.add(part(UNIT_BOX, m.eye, [0.11, -0.04, 0.24], [0.07, 0.1, 0.04]));
  head.add(part(UNIT_HEMI, m.hair, [0, 0.0, -0.02], [0.68, 0.5, 0.56]));
  head.add(part(UNIT_BOX, m.hair, [0, 0.12, 0.2], [0.5, 0.12, 0.2]));
  head.add(part(UNIT_BOX, m.hair, [-0.29, -0.06, 0.04], [0.09, 0.32, 0.26]));
  head.add(part(UNIT_BOX, m.hair, [0.29, -0.06, 0.04], [0.09, 0.32, 0.26]));
  const cap = part(UNIT_CONE, m.cap, [0, 0.3, -0.08], [0.6, 0.5, 0.6]);
  cap.rotation.x = -0.95;
  head.add(cap);
  head.add(part(UNIT_CYL, m.cap, [0, 0.14, -0.02], [0.68, 0.08, 0.62]));

  const ponytail = new THREE.Group();
  ponytail.position.set(0, 0.02, -0.28);
  ponytail.add(part(UNIT_SPHERE, m.hair, [0, 0, -0.04], [0.2, 0.2, 0.2]));
  ponytail.add(part(UNIT_BOX, m.belt, [0, -0.02, -0.06], [0.2, 0.06, 0.18]));
  ponytail.add(part(UNIT_BOX, m.hair, [0, -0.3, -0.06], [0.17, 0.52, 0.15]));
  ponytail.add(part(UNIT_SPHERE, m.hair, [0, -0.56, -0.06], [0.2, 0.16, 0.18]));
  head.add(ponytail);

  root.scale.set(1.08, 0.86, 0.92);
  return { root, body, head, armR, armL, handR, handL, legR, legL, weapon, shield, ponytail, materials: collectMaterials(root) };
}

export const SOLDIER_COLORS: Record<EnemyKind, string> = { sword: '#3c9c44', spear: '#3858c8', javelin: '#c83838', archer: '#7848b8' };

export function buildSoldier(kind: EnemyKind): Humanoid {
  const m = {
    steel: toon('#a3adc0'), steelD: toon('#6b7382'), tunic: toon(SOLDIER_COLORS[kind]), visor: toon('#15151c'),
    eye: toon('#ffe066'), boots: toon('#4a3020'), wood: toon('#8a5a2b'), gold: toon('#d9b24a'), skin: toon('#8b8f9b'),
  };
  (m.eye as THREE.MeshToonMaterial).emissive.set('#ffd040');
  (m.eye as THREE.MeshToonMaterial).emissiveIntensity = 0.6;
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  root.add(blobShadow(0.36));

  const legL = makeLeg(0.12, m.steelD, m.boots);
  const legR = makeLeg(-0.12, m.steelD, m.boots);
  root.add(legL, legR);

  body.add(part(UNIT_BOX, m.tunic, [0, 0.58, 0], [0.54, 0.42, 0.32]));
  body.add(part(UNIT_BOX, m.steelD, [0, 0.37, 0], [0.56, 0.1, 0.34]));
  body.add(part(UNIT_BOX, m.wood, [0, 0.5, 0], [0.56, 0.06, 0.34]));
  body.add(part(UNIT_BOX, m.gold, [0, 0.5, 0.17], [0.1, 0.06, 0.02]));
  body.add(part(UNIT_BOX, m.steel, [0, 0.66, 0.17], [0.3, 0.2, 0.03]));
  body.add(part(UNIT_BOX, m.steel, [-0.3, 0.78, 0], [0.18, 0.1, 0.2]));
  body.add(part(UNIT_BOX, m.steel, [0.3, 0.78, 0], [0.18, 0.1, 0.2]));

  const { arm: armR, hand: handR } = makeArm(-0.32, m.steel, m.steelD);
  const { arm: armL, hand: handL } = makeArm(0.32, m.steel, m.steelD);
  body.add(armR, armL);

  const head = new THREE.Group();
  head.position.set(0, 1.0, 0);
  body.add(head);
  head.add(part(UNIT_SPHERE, m.steel, [0, 0.02, 0], [0.64, 0.54, 0.6]));
  head.add(part(UNIT_BOX, m.steel, [0, -0.1, -0.1], [0.6, 0.24, 0.44]));
  head.add(part(UNIT_BOX, m.visor, [0, -0.06, 0.24], [0.42, 0.18, 0.1]));
  head.add(part(UNIT_BOX, m.eye, [-0.1, -0.05, 0.29], [0.06, 0.06, 0.02]));
  head.add(part(UNIT_BOX, m.eye, [0.1, -0.05, 0.29], [0.06, 0.06, 0.02]));
  head.add(part(UNIT_BOX, m.steelD, [0, -0.1, 0.3], [0.06, 0.16, 0.03]));
  head.add(part(UNIT_BOX, m.tunic, [0, 0.3, -0.04], [0.1, 0.16, 0.42]));
  head.add(part(UNIT_BOX, m.tunic, [0, 0.36, -0.3], [0.1, 0.22, 0.14]));

  let weapon: THREE.Group | undefined;
  let shield: THREE.Group | undefined;
  if (kind === 'sword') {
    weapon = buildSword({ steel: m.steel, hilt: m.wood, gold: m.gold }, 0.5);
    handR.add(weapon);
    shield = new THREE.Group();
    const disc = part(UNIT_CYL, m.steelD, [0, 0, 0], [0.42, 0.05, 0.42]);
    disc.rotation.x = Math.PI / 2;
    shield.add(disc);
    const disc2 = part(UNIT_CYL, m.tunic, [0, 0, 0.02], [0.3, 0.05, 0.3]);
    disc2.rotation.x = Math.PI / 2;
    shield.add(disc2);
    shield.add(part(UNIT_SPHERE, m.gold, [0, 0, 0.05], [0.12, 0.12, 0.08]));
    shield.position.set(0, -0.02, 0.14);
    handL.add(shield);
  } else if (kind === 'spear') {
    weapon = new THREE.Group();
    weapon.add(part(UNIT_CYL, m.wood, [0, 0.35, 0], [0.05, 1.4, 0.05]));
    weapon.add(part(UNIT_CONE, m.steel, [0, 1.15, 0], [0.11, 0.22, 0.06]));
    weapon.add(part(UNIT_BOX, m.gold, [0, 1.02, 0], [0.1, 0.04, 0.08]));
    handR.add(weapon);
  } else if (kind === 'javelin') {
    weapon = new THREE.Group();
    weapon.add(part(UNIT_CYL, m.wood, [0, 0.15, 0], [0.045, 0.9, 0.045]));
    weapon.add(part(UNIT_CONE, m.steel, [0, 0.66, 0], [0.09, 0.16, 0.05]));
    weapon.add(part(UNIT_BOX, m.tunic, [0, -0.22, 0], [0.03, 0.12, 0.08]));
    handR.add(weapon);
  } else {
    weapon = new THREE.Group();
    const bow = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.025, 6, 12, Math.PI), m.wood);
    bow.rotation.y = Math.PI / 2;
    weapon.add(bow);
    weapon.add(part(UNIT_BOX, m.steelD, [0, 0.01, 0], [0.012, 0.012, 0.68]));
    weapon.add(part(UNIT_BOX, m.tunic, [0, 0.02, 0], [0.04, 0.1, 0.06]));
    weapon.position.set(0, 0.02, 0.04);
    handL.add(weapon);
    handR.add(part(UNIT_BOX, m.wood, [0, -0.1, -0.06], [0.03, 0.3, 0.03]));
  }

  root.scale.set(1.1, 0.86, 0.92);
  return { root, body, head, armR, armL, handR, handL, legR, legL, weapon, shield, materials: collectMaterials(root) };
}

// ---------------------------------------------------------------- props
export function buildTrees(trees: TreeSpec[]): THREE.Object3D[] {
  const canopyMat = toon('#3f9a3d');
  const trunkMat = toon('#6b4226');
  const mk = (r: number, sx: number, sy: number, sz: number, x: number, y: number, z: number) => {
    const g = new THREE.SphereGeometry(r, 12, 8);
    g.scale(sx, sy, sz);
    g.translate(x, y, z);
    return g;
  };
  const canopyGeo = mergeGeometries([
    mk(1.0, 1, 0.62, 0.8, 0, 0.9, 0),
    mk(0.5, 1, 0.9, 0.9, -0.55, 1.25, -0.1),
    mk(0.5, 1, 0.9, 0.9, 0.55, 1.25, -0.1),
    mk(0.48, 1, 0.9, 0.9, 0, 1.45, 0.25),
    mk(0.44, 1, 0.9, 0.9, 0.05, 1.3, -0.35),
  ])!;
  const trunkGeo = new THREE.CylinderGeometry(0.2, 0.28, 0.95, 8).translate(0, 0.47, 0);
  const shadowGeo = new THREE.CircleGeometry(0.9, 12).rotateX(-Math.PI / 2).scale(1, 1, 0.7).translate(0, 0.015, 0.1);
  const canopy = new THREE.InstancedMesh(canopyGeo, canopyMat, trees.length);
  const trunk = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length);
  const shadow = new THREE.InstancedMesh(shadowGeo, shadowMat, trees.length);
  const mat = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  trees.forEach((t, i) => {
    pos.set(t.x, 0, t.z);
    scl.set(t.scale, t.scale, t.scale);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), ((i * 37) % 7) * 0.3);
    mat.compose(pos, q, scl);
    canopy.setMatrixAt(i, mat);
    trunk.setMatrixAt(i, mat);
    shadow.setMatrixAt(i, mat);
  });
  canopy.instanceMatrix.needsUpdate = true;
  trunk.instanceMatrix.needsUpdate = true;
  shadow.instanceMatrix.needsUpdate = true;
  return [trunk, canopy, shadow];
}

export function buildBush(): THREE.Group {
  const g = new THREE.Group();
  const m = toon('#3f9a3d'), mL = toon('#5fc04a'), mD = toon('#2a6e2a');
  g.add(part(UNIT_SPHERE, m, [0, 0.33, 0], [0.76, 0.56, 0.62]));
  g.add(part(UNIT_SPHERE, mL, [-0.16, 0.48, 0.02], [0.34, 0.28, 0.3]));
  g.add(part(UNIT_SPHERE, mL, [0.14, 0.5, -0.06], [0.3, 0.26, 0.26]));
  g.add(part(UNIT_SPHERE, m, [0.06, 0.42, 0.2], [0.34, 0.28, 0.3]));
  g.add(part(UNIT_CYL, mD, [0, 0.03, 0], [0.82, 0.06, 0.68]));
  return g;
}

export function buildStump(): THREE.Mesh {
  return part(UNIT_CYL, toon('#2f7a2f'), [0, 0.03, 0], [0.5, 0.06, 0.42]);
}

export function buildRock(): THREE.Group {
  const g = new THREE.Group();
  g.add(part(UNIT_SPHERE, toon('#a9a9a2'), [0, 0.26, 0], [0.7, 0.52, 0.6]));
  g.add(part(UNIT_SPHERE, toon('#c6c6be'), [-0.12, 0.42, -0.05], [0.3, 0.2, 0.26]));
  g.add(part(UNIT_CYL, toon('#63635e'), [0, 0.03, 0], [0.76, 0.06, 0.64]));
  return g;
}

export function buildFence(): THREE.Group {
  const g = new THREE.Group();
  g.add(part(UNIT_CYL, toon('#a5713d'), [0, 0.32, 0], [0.34, 0.64, 0.34]));
  g.add(part(UNIT_SPHERE, toon('#cf9a62'), [0, 0.64, 0], [0.34, 0.2, 0.34]));
  g.add(part(UNIT_CYL, toon('#5a3a1e'), [0, 0.02, 0], [0.42, 0.04, 0.4]));
  return g;
}

export function buildHouse(spec: HouseSpec): THREE.Group {
  const g = new THREE.Group();
  const cx = spec.x + spec.w / 2, cz = spec.z + spec.d / 2;
  const wallC = new THREE.Color(spec.wall ?? '#e8d6a8'), roofC = new THREE.Color(spec.roof ?? '#b73c3c');
  const wall = toon(wallC), roof = toon(roofC), roofD = toon(roofC.clone().multiplyScalar(0.62));
  const door = toon('#3a2214'), frame = toon('#7a4f2a'), win = toon('#7fb6ff'), winL = toon('#e8f4ff'), stone = toon('#8e8e88'), beam = toon('#6b4a2c');
  const depth = spec.d - 0.8;
  g.add(part(UNIT_BOX, wall, [cx, 0.65, cz], [spec.w, 1.3, depth]));
  g.add(part(UNIT_BOX, stone, [cx, 0.12, cz], [spec.w + 0.1, 0.24, depth + 0.1]));
  const fz = cz + depth / 2;
  // timber framing on the front
  for (const bx of [-spec.w / 2 + 0.08, spec.w / 2 - 0.08]) g.add(part(UNIT_BOX, beam, [cx + bx, 0.7, fz + 0.01], [0.1, 1.2, 0.04]));
  g.add(part(UNIT_BOX, beam, [cx, 1.26, fz + 0.01], [spec.w, 0.08, 0.04]));
  // door with rounded top + step
  g.add(part(UNIT_BOX, frame, [cx, 0.62, fz + 0.02], [1.0, 1.2, 0.06]));
  g.add(part(UNIT_BOX, door, [cx, 0.55, fz + 0.06], [0.72, 1.06, 0.06]));
  g.add(part(UNIT_CYL, door, [cx, 1.08, fz + 0.06], [0.72, 0.06, 0.4]).rotateX(Math.PI / 2));
  g.add(part(UNIT_SPHERE, toon('#f2c14e'), [cx + 0.22, 0.55, fz + 0.1], [0.08, 0.08, 0.06]));
  g.add(part(UNIT_BOX, stone, [cx, 0.05, fz + 0.2], [1.1, 0.1, 0.36]));
  // windows with shutters + flower boxes
  const wxs = spec.w >= 5 ? [-1.6, 1.6] : [-1.2, 1.2];
  for (const sx of wxs) {
    g.add(part(UNIT_BOX, frame, [cx + sx, 0.82, fz + 0.02], [0.6, 0.56, 0.06]));
    g.add(part(UNIT_BOX, win, [cx + sx, 0.82, fz + 0.06], [0.44, 0.42, 0.06]));
    g.add(part(UNIT_BOX, winL, [cx + sx - 0.1, 0.9, fz + 0.09], [0.1, 0.14, 0.02]));
    g.add(part(UNIT_BOX, frame, [cx + sx, 0.82, fz + 0.1], [0.05, 0.42, 0.02]));
    g.add(part(UNIT_BOX, frame, [cx + sx, 0.82, fz + 0.1], [0.44, 0.05, 0.02]));
    g.add(part(UNIT_BOX, roofD, [cx + sx - 0.36, 0.82, fz + 0.04], [0.1, 0.5, 0.05]));
    g.add(part(UNIT_BOX, roofD, [cx + sx + 0.36, 0.82, fz + 0.04], [0.1, 0.5, 0.05]));
    g.add(part(UNIT_BOX, beam, [cx + sx, 0.52, fz + 0.12], [0.6, 0.1, 0.16]));
    for (const fx of [-0.18, 0, 0.18]) g.add(part(UNIT_SPHERE, toon(['#ff5a5a', '#ffd23f', '#ff8ad8'][(Math.abs(fx * 100) | 0) % 3]), [cx + sx + fx, 0.62, fz + 0.14], [0.12, 0.12, 0.12]));
  }
  // roof: eaves slab + pyramid with a ridge cap and chimney
  const W = spec.w + 0.8, D = depth + 0.7;
  g.add(part(UNIT_BOX, roofD, [cx, 1.34, cz], [W + 0.1, 0.12, D + 0.1]));
  g.add(part(UNIT_PYRAMID, roof, [cx, 1.4 + 0.55, cz], [W / 0.7071, 1.1, D / 0.7071]));
  g.add(part(UNIT_BOX, roofD, [cx, 1.45, cz + D / 2 - 0.02], [W, 0.1, 0.06]));
  g.add(part(UNIT_BOX, stone, [cx + spec.w / 2 - 0.9, 2.05, cz - 0.3], [0.36, 0.8, 0.36]));
  g.add(part(UNIT_BOX, toon('#5a5a55'), [cx + spec.w / 2 - 0.9, 2.46, cz - 0.3], [0.44, 0.08, 0.44]));
  // small attic window
  g.add(part(UNIT_CYL, frame, [cx, 1.85, fz - 0.35 + 0.3], [0.3, 0.06, 0.3]).rotateX(Math.PI / 2));
  g.add(part(UNIT_CYL, win, [cx, 1.85, fz - 0.35 + 0.33], [0.2, 0.06, 0.2]).rotateX(Math.PI / 2));
  // shop sign
  if (spec.sign === 'shop') {
    const sg = new THREE.Group();
    sg.position.set(cx - spec.w / 2 + 0.5, 1.18, fz + 0.3);
    sg.add(part(UNIT_BOX, beam, [0, 0, -0.15], [0.06, 0.06, 0.34]));
    sg.add(part(UNIT_BOX, toon('#f7e7b7'), [0, -0.2, 0.02], [0.52, 0.36, 0.05]));
    sg.add(part(UNIT_BOX, toon('#c82828'), [0, -0.2, 0.05], [0.42, 0.26, 0.02]));
    sg.add(part(UNIT_SPHERE, toon('#f2c14e'), [0, -0.2, 0.07], [0.14, 0.14, 0.04]));
    g.add(sg);
  }
  return g;
}

// ---------------------------------------------------------------- village props
export function buildProp(p: PropSpec): THREE.Group {
  const g = new THREE.Group();
  const wood = toon('#8a5a2b'), woodL = toon('#c48b4f'), woodD = toon('#5a3a1e'), stone = toon('#a9a9a2'), stoneD = toon('#6f6f6a'), iron = toon('#3a3f4a');
  const gold = toon('#f2c14e');
  switch (p.kind) {
    case 'well': {
      g.add(part(UNIT_CYL, stone, [0, 0.3, 0], [1.0, 0.6, 1.0]));
      g.add(part(UNIT_CYL, stoneD, [0, 0.6, 0], [1.06, 0.08, 1.06]));
      g.add(part(UNIT_CYL, toon('#1e3d8c'), [0, 0.62, 0], [0.7, 0.04, 0.7]));
      for (const a of [0, 1, 2, 3, 4, 5]) g.add(part(UNIT_BOX, stoneD, [Math.cos(a) * 0.5, 0.3, Math.sin(a) * 0.5], [0.12, 0.5, 0.12]).rotateY(-a));
      g.add(part(UNIT_BOX, wood, [-0.42, 0.95, 0], [0.1, 0.9, 0.1]));
      g.add(part(UNIT_BOX, wood, [0.42, 0.95, 0], [0.1, 0.9, 0.1]));
      g.add(part(UNIT_CYL, woodD, [0, 1.15, 0], [0.12, 0.96, 0.12]).rotateZ(Math.PI / 2));
      g.add(part(UNIT_BOX, woodL, [0.5, 1.15, 0.12], [0.06, 0.24, 0.06]));
      g.add(part(UNIT_PYRAMID, toon('#b73c3c'), [0, 1.62, 0], [1.6, 0.5, 1.2]));
      g.add(part(UNIT_BOX, toon('#7e2626'), [0, 1.38, 0], [1.2, 0.06, 0.9]));
      g.add(part(UNIT_BOX, woodD, [0, 0.98, 0], [0.02, 0.36, 0.02]));
      g.add(part(UNIT_CYL, wood, [0, 0.76, 0], [0.22, 0.2, 0.22]));
      g.add(part(UNIT_CYL, iron, [0, 0.86, 0], [0.24, 0.02, 0.24]));
      g.add(blobShadow(0.55));
      break;
    }
    case 'weathercock': {
      g.add(part(UNIT_CYL, stoneD, [0, 0.08, 0], [0.5, 0.16, 0.5]));
      g.add(part(UNIT_CYL, wood, [0, 1.0, 0], [0.1, 1.85, 0.1]));
      g.add(part(UNIT_BOX, iron, [0, 1.95, 0], [0.5, 0.03, 0.03]));
      g.add(part(UNIT_BOX, iron, [0, 1.95, 0], [0.03, 0.03, 0.5]));
      const bird = new THREE.Group(); bird.position.y = 2.1; bird.name = 'spin';
      bird.add(part(UNIT_BOX, gold, [0, 0, 0], [0.32, 0.02, 0.02]));
      bird.add(part(UNIT_SPHERE, toon('#c82828'), [0.1, 0.1, 0], [0.16, 0.14, 0.1]));
      bird.add(part(UNIT_BOX, toon('#c82828'), [-0.12, 0.14, 0], [0.12, 0.2, 0.03]));
      bird.add(part(UNIT_CONE, gold, [0.2, 0.1, 0], [0.04, 0.08, 0.04]).rotateZ(-Math.PI / 2));
      g.add(bird);
      break;
    }
    case 'bench': {
      g.add(part(UNIT_BOX, woodL, [0, 0.3, 0], [0.9, 0.06, 0.34]));
      g.add(part(UNIT_BOX, woodL, [0, 0.55, -0.15], [0.9, 0.3, 0.05]));
      for (const x of [-0.36, 0.36]) { g.add(part(UNIT_BOX, wood, [x, 0.15, 0.1], [0.08, 0.3, 0.08])); g.add(part(UNIT_BOX, wood, [x, 0.35, -0.13], [0.08, 0.7, 0.08])); }
      break;
    }
    case 'lamp': {
      g.add(part(UNIT_CYL, stoneD, [0, 0.06, 0], [0.4, 0.12, 0.4]));
      g.add(part(UNIT_CYL, iron, [0, 0.8, 0], [0.08, 1.5, 0.08]));
      g.add(part(UNIT_BOX, iron, [0, 1.6, 0], [0.32, 0.06, 0.32]));
      const glow = toon('#ffe680'); glow.emissive.set('#ffc040'); glow.emissiveIntensity = 0.7;
      g.add(part(UNIT_BOX, glow, [0, 1.76, 0], [0.24, 0.28, 0.24]));
      g.add(part(UNIT_PYRAMID, iron, [0, 1.98, 0], [0.5, 0.16, 0.5]));
      break;
    }
    case 'sign': {
      g.add(part(UNIT_BOX, wood, [0, 0.4, 0], [0.1, 0.8, 0.1]));
      g.add(part(UNIT_BOX, woodL, [0, 0.72, 0.02], [0.8, 0.44, 0.08]));
      g.add(part(UNIT_BOX, woodD, [-0.2, 0.78, 0.07], [0.32, 0.04, 0.02]));
      g.add(part(UNIT_BOX, woodD, [-0.12, 0.68, 0.07], [0.48, 0.04, 0.02]));
      g.add(part(UNIT_BOX, woodD, [0.05, 0.6, 0.07], [0.5, 0.04, 0.02]));
      break;
    }
    case 'stall': {
      g.add(part(UNIT_BOX, wood, [0, 0.45, 0], [1.6, 0.5, 0.8]));
      g.add(part(UNIT_BOX, woodL, [0, 0.72, 0], [1.7, 0.06, 0.9]));
      for (const x of [-0.75, 0.75]) g.add(part(UNIT_BOX, woodD, [x, 1.1, -0.35], [0.08, 1.4, 0.08]));
      // striped awning
      for (let i = 0; i < 6; i++) g.add(part(UNIT_BOX, toon(i % 2 ? '#f6f1e6' : '#e04545'), [-0.75 + 0.15 + i * 0.3, 1.82, 0.05], [0.3, 0.06, 1.2]).rotateX(-0.22));
      // wares
      const fruit = ['#ff5a5a', '#ffb13d', '#8bd34a', '#ff5a5a', '#ffd23f'];
      fruit.forEach((c, i) => g.add(part(UNIT_SPHERE, toon(c), [-0.55 + i * 0.28, 0.85, 0.12 - (i % 2) * 0.22], [0.2, 0.2, 0.2])));
      g.add(part(UNIT_BOX, woodD, [0.45, 0.8, -0.2], [0.5, 0.12, 0.34]));
      break;
    }
    case 'barrel': {
      g.add(part(UNIT_CYL, woodL, [0, 0.3, 0], [0.5, 0.6, 0.5]));
      g.add(part(UNIT_CYL, iron, [0, 0.12, 0], [0.53, 0.05, 0.53]));
      g.add(part(UNIT_CYL, iron, [0, 0.48, 0], [0.53, 0.05, 0.53]));
      g.add(part(UNIT_CYL, woodD, [0, 0.61, 0], [0.42, 0.02, 0.42]));
      break;
    }
    case 'crate': {
      g.add(part(UNIT_BOX, woodL, [0, 0.28, 0], [0.56, 0.56, 0.56]));
      g.add(part(UNIT_BOX, wood, [0, 0.28, 0.28], [0.56, 0.08, 0.02]));
      g.add(part(UNIT_BOX, wood, [0, 0.28, 0.28], [0.08, 0.56, 0.02]));
      g.add(part(UNIT_BOX, wood, [0.28, 0.28, 0], [0.02, 0.56, 0.08]));
      break;
    }
    case 'flowerpot': {
      g.add(part(UNIT_CYL, toon('#c0623a'), [0, 0.14, 0], [0.34, 0.28, 0.34]));
      g.add(part(UNIT_CYL, toon('#8a4626'), [0, 0.28, 0], [0.38, 0.04, 0.38]));
      g.add(part(UNIT_SPHERE, toon('#3f9a3d'), [0, 0.38, 0], [0.34, 0.24, 0.34]));
      for (const [x, z, c] of [[-0.08, 0.06, '#ff5a5a'], [0.1, -0.04, '#ffd23f'], [0.0, 0.1, '#ff8ad8']] as [number, number, string][]) g.add(part(UNIT_SPHERE, toon(c), [x, 0.5, z], [0.12, 0.12, 0.12]));
      break;
    }
    case 'hedge': {
      g.add(part(UNIT_BOX, toon('#3f9a3d'), [0, 0.3, 0], [0.95, 0.6, 0.6]));
      g.add(part(UNIT_BOX, toon('#5fc04a'), [0, 0.6, 0], [0.9, 0.06, 0.55]));
      break;
    }
  }
  g.position.set(p.x, 0, p.z);
  if (p.rot) g.rotation.y = p.rot;
  return g;
}

// ---------------------------------------------------------------- villagers
export interface VillagerLook {
  skin: string; hair: string; top: string; bottom: string; accent?: string;
  hat?: 'none' | 'straw' | 'cap' | 'bandana' | 'kerchief' | 'feather';
  hairStyle?: 'short' | 'long' | 'bald' | 'bun' | 'beard';
  scale?: number; kid?: boolean; item?: 'cane' | 'lute' | 'hoe' | 'broom' | 'basket';
}

export const VILLAGER_LOOKS: Record<string, VillagerLook> = {
  elder: { skin: '#f3bd92', hair: '#e8e8e8', top: '#5a3fb0', bottom: '#2d2660', hat: 'none', hairStyle: 'beard', item: 'cane' },
  shopkeeper: { skin: '#f3bd92', hair: '#4a2c14', top: '#e8e8e8', bottom: '#c82828', accent: '#f2c14e', hat: 'cap', hairStyle: 'short' },
  kid: { skin: '#f6c8a0', hair: '#f5cf46', top: '#ff8a3d', bottom: '#3a5fd0', hat: 'none', hairStyle: 'short', kid: true },
  granny: { skin: '#f0c4a0', hair: '#d8d8e0', top: '#2f8f5a', bottom: '#7a4f2a', hat: 'kerchief', hairStyle: 'bun', item: 'broom' },
  bard: { skin: '#f3bd92', hair: '#c8432c', top: '#3a9ad0', bottom: '#7a2a80', accent: '#f2c14e', hat: 'feather', hairStyle: 'long', item: 'lute' },
  farmer: { skin: '#e8a878', hair: '#4a2c14', top: '#8ad34a', bottom: '#6b4a2c', hat: 'straw', hairStyle: 'short', item: 'hoe' },
};

export function buildVillager(look: VillagerLook): Humanoid {
  const m = { skin: toon(look.skin), hair: toon(look.hair), top: toon(look.top), bottom: toon(look.bottom), acc: toon(look.accent ?? '#7a4f2a'), eye: toon('#1d2b5a'), boot: toon('#5a3a1e'), wood: toon('#8a5a2b') };
  const root = new THREE.Group(), body = new THREE.Group();
  root.add(body); root.add(blobShadow(0.32));
  const legL = makeLeg(0.11, m.bottom, m.boot), legR = makeLeg(-0.11, m.bottom, m.boot);
  root.add(legL, legR);
  body.add(part(UNIT_BOX, m.top, [0, 0.58, 0], [0.5, 0.42, 0.3]));
  body.add(part(UNIT_BOX, m.bottom, [0, 0.37, 0], [0.54, 0.12, 0.34]));
  body.add(part(UNIT_BOX, m.acc, [0, 0.47, 0], [0.52, 0.05, 0.32]));
  body.add(part(UNIT_BOX, m.skin, [0, 0.8, 0], [0.16, 0.08, 0.14]));
  const { arm: armR, hand: handR } = makeArm(-0.3, m.top, m.skin);
  const { arm: armL, hand: handL } = makeArm(0.3, m.top, m.skin);
  body.add(armR, armL);
  const head = new THREE.Group(); head.position.set(0, 1.0, 0); body.add(head);
  head.add(part(UNIT_SPHERE, m.skin, [0, 0, 0], [0.64, 0.5, 0.52]));
  head.add(part(UNIT_BOX, m.eye, [-0.11, -0.04, 0.24], [0.07, 0.1, 0.04]));
  head.add(part(UNIT_BOX, m.eye, [0.11, -0.04, 0.24], [0.07, 0.1, 0.04]));
  head.add(part(UNIT_BOX, toon('#e89a8a'), [-0.2, -0.1, 0.2], [0.08, 0.05, 0.04]));
  head.add(part(UNIT_BOX, toon('#e89a8a'), [0.2, -0.1, 0.2], [0.08, 0.05, 0.04]));
  const hs = look.hairStyle ?? 'short';
  if (hs !== 'bald') head.add(part(UNIT_HEMI, m.hair, [0, 0.0, -0.02], [0.68, 0.5, 0.56]));
  if (hs === 'short') head.add(part(UNIT_BOX, m.hair, [0, 0.1, 0.2], [0.5, 0.14, 0.18]));
  if (hs === 'long') { head.add(part(UNIT_BOX, m.hair, [-0.29, -0.1, 0.0], [0.1, 0.4, 0.3])); head.add(part(UNIT_BOX, m.hair, [0.29, -0.1, 0.0], [0.1, 0.4, 0.3])); head.add(part(UNIT_BOX, m.hair, [0, -0.15, -0.24], [0.5, 0.4, 0.12])); }
  if (hs === 'bun') { head.add(part(UNIT_SPHERE, m.hair, [0, 0.22, -0.12], [0.3, 0.26, 0.3])); }
  if (hs === 'beard') { head.add(part(UNIT_BOX, m.hair, [0, -0.2, 0.18], [0.36, 0.3, 0.16])); head.add(part(UNIT_BOX, m.hair, [0, -0.36, 0.14], [0.24, 0.18, 0.12])); head.add(part(UNIT_BOX, m.hair, [0, -0.14, 0.24], [0.42, 0.06, 0.06])); }
  switch (look.hat) {
    case 'straw': head.add(part(UNIT_CYL, toon('#e8c86a'), [0, 0.16, 0], [1.05, 0.05, 1.0])); head.add(part(UNIT_CYL, toon('#e8c86a'), [0, 0.28, 0], [0.56, 0.22, 0.52])); head.add(part(UNIT_CYL, toon('#c82828'), [0, 0.2, 0], [0.58, 0.05, 0.54])); break;
    case 'cap': head.add(part(UNIT_HEMI, m.acc, [0, 0.06, 0], [0.7, 0.4, 0.6])); head.add(part(UNIT_BOX, m.acc, [0, 0.08, 0.3], [0.5, 0.04, 0.28])); break;
    case 'kerchief': head.add(part(UNIT_HEMI, toon('#e04545'), [0, 0.04, -0.02], [0.72, 0.46, 0.62])); head.add(part(UNIT_BOX, toon('#e04545'), [0, -0.1, -0.3], [0.3, 0.3, 0.1])); break;
    case 'bandana': head.add(part(UNIT_CYL, toon('#e04545'), [0, 0.12, 0], [0.7, 0.1, 0.6])); break;
    case 'feather': head.add(part(UNIT_HEMI, toon('#2f8f5a'), [0, 0.1, 0], [0.66, 0.42, 0.58])); head.add(part(UNIT_BOX, toon('#f6f1e6'), [0.24, 0.32, -0.08], [0.06, 0.4, 0.12]).rotateZ(-0.5)); break;
  }
  // held item
  switch (look.item) {
    case 'cane': handR.add(part(UNIT_CYL, m.wood, [0, -0.25, 0.05], [0.05, 0.75, 0.05])); handR.add(part(UNIT_SPHERE, toon('#f2c14e'), [0, 0.1, 0.05], [0.12, 0.12, 0.12])); break;
    case 'lute': { const l = new THREE.Group(); l.position.set(0.3, 0.1, 0.22); l.rotation.set(0.3, 0, -0.9); l.add(part(UNIT_SPHERE, m.wood, [0, -0.1, 0], [0.34, 0.42, 0.12])); l.add(part(UNIT_BOX, toon('#5a3a1e'), [0, 0.28, 0.02], [0.08, 0.5, 0.05])); l.add(part(UNIT_CYL, toon('#2a1a10'), [0, -0.08, 0.06], [0.12, 0.02, 0.12]).rotateX(Math.PI / 2)); handL.add(l); break; }
    case 'hoe': handR.add(part(UNIT_CYL, m.wood, [0, 0.2, 0.05], [0.05, 1.3, 0.05])); handR.add(part(UNIT_BOX, toon('#8e8e88'), [0, 0.82, 0.16], [0.06, 0.06, 0.3])); break;
    case 'broom': handR.add(part(UNIT_CYL, m.wood, [0, -0.1, 0.05], [0.05, 1.1, 0.05])); handR.add(part(UNIT_CONE, toon('#e8c86a'), [0, -0.68, 0.05], [0.24, 0.3, 0.16]).rotateX(Math.PI)); break;
    case 'basket': handL.add(part(UNIT_CYL, toon('#c48b4f'), [0, -0.08, 0.1], [0.34, 0.24, 0.34])); break;
  }
  const s = look.scale ?? (look.kid ? 0.72 : 1);
  root.scale.set(1.08 * s, 0.86 * s, 0.92 * s);
  return { root, body, head, armR, armL, handR, handL, legR, legL, materials: collectMaterials(root) };
}

export function buildDog(): Humanoid {
  const fur = toon('#f0d9a8'), furD = toon('#c9a874'), dark = toon('#2a1a10');
  const root = new THREE.Group(), body = new THREE.Group();
  root.add(body); root.add(blobShadow(0.26));
  body.add(part(UNIT_BOX, fur, [0, 0.32, -0.05], [0.34, 0.3, 0.6]));
  const head = new THREE.Group(); head.position.set(0, 0.5, 0.3); body.add(head);
  head.add(part(UNIT_BOX, fur, [0, 0, 0], [0.34, 0.3, 0.32]));
  head.add(part(UNIT_BOX, furD, [0, -0.06, 0.2], [0.2, 0.14, 0.14]));
  head.add(part(UNIT_BOX, dark, [0, -0.02, 0.28], [0.08, 0.06, 0.04]));
  head.add(part(UNIT_BOX, dark, [-0.09, 0.05, 0.16], [0.05, 0.06, 0.02]));
  head.add(part(UNIT_BOX, dark, [0.09, 0.05, 0.16], [0.05, 0.06, 0.02]));
  head.add(part(UNIT_BOX, furD, [-0.16, 0.12, -0.02], [0.1, 0.22, 0.12]));
  head.add(part(UNIT_BOX, furD, [0.16, 0.12, -0.02], [0.1, 0.22, 0.12]));
  const tail = part(UNIT_BOX, furD, [0, 0.45, -0.4], [0.08, 0.26, 0.08]); tail.rotation.x = -0.6; tail.name = 'tail'; body.add(tail);
  const mk = (x: number, z: number) => { const l = new THREE.Group(); l.position.set(x, 0.2, z); l.add(part(UNIT_BOX, fur, [0, -0.1, 0], [0.11, 0.2, 0.11])); return l; };
  const legL = mk(0.12, 0.18), legR = mk(-0.12, 0.18), armL = mk(0.12, -0.24), armR = mk(-0.12, -0.24);
  root.add(legL, legR, armL, armR);
  const collar = part(UNIT_CYL, toon('#c82828'), [0, 0.42, 0.18], [0.36, 0.06, 0.34]); body.add(collar);
  return { root, body, head, armR, armL, handR: armR, handL: armL, legR, legL, materials: collectMaterials(root) };
}

export function buildHeart(): THREE.Group {
  const m = toon('#ee3040');
  const g = new THREE.Group();
  g.add(part(UNIT_SPHERE, m, [-0.085, 0.07, 0], [0.2, 0.2, 0.14]));
  g.add(part(UNIT_SPHERE, m, [0.085, 0.07, 0], [0.2, 0.2, 0.14]));
  const cone = part(UNIT_CONE, m, [0, -0.06, 0], [0.34, 0.24, 0.14]);
  cone.rotation.z = Math.PI;
  g.add(cone);
  return g;
}

export function buildRupee(blue: boolean): THREE.Group {
  const g = new THREE.Group();
  g.add(part(UNIT_OCTA, toon(blue ? '#3a7cf0' : '#3ad03a'), [0, 0, 0], [0.3, 0.52, 0.3]));
  return g;
}

export function buildArrow(): THREE.Group {
  const g = new THREE.Group();
  const shaft = part(UNIT_CYL, toon('#c9a26b'), [0, 0, 0], [0.04, 0.5, 0.04]);
  shaft.rotation.x = Math.PI / 2;
  g.add(shaft);
  const tip = part(UNIT_CONE, toon('#dfe6f4'), [0, 0, 0.3], [0.09, 0.12, 0.05]);
  tip.rotation.x = Math.PI / 2;
  g.add(tip);
  g.add(part(UNIT_BOX, toon('#e04040'), [0, 0, -0.22], [0.02, 0.12, 0.1]));
  g.add(part(UNIT_BOX, toon('#e04040'), [0, 0, -0.22], [0.12, 0.02, 0.1]));
  return g;
}

export function buildJavelinProjectile(): THREE.Group {
  const g = new THREE.Group();
  const shaft = part(UNIT_CYL, toon('#8a5a2b'), [0, 0, 0], [0.05, 0.9, 0.05]);
  shaft.rotation.x = Math.PI / 2;
  g.add(shaft);
  const tip = part(UNIT_CONE, toon('#dfe6f4'), [0, 0, 0.5], [0.1, 0.16, 0.05]);
  tip.rotation.x = Math.PI / 2;
  g.add(tip);
  return g;
}
