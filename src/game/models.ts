import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { TreeSpec, HouseSpec, EnemyKind, PropSpec } from './world';
import { RNG } from './constants';

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

let groundGradientMap: THREE.DataTexture | null = null;
/** Fine toon ramp for the ground mesh: with only 5 bands the gentle meadow slopes snap between
 *  light and dark shading in broad flat patches; 16 close-spaced steps read as a smooth ramp
 *  while slopes still catch the sun. Characters and props keep the punchier 5-step map. */
export function getGroundGradientMap(): THREE.DataTexture {
  if (groundGradientMap) return groundGradientMap;
  const n = 16, lo = 0.62;
  const data = new Uint8Array(Array.from({ length: n }, (_, i) => Math.round((lo + (1 - lo) * (i / (n - 1))) * 255)));
  groundGradientMap = new THREE.DataTexture(data, n, 1, THREE.RedFormat);
  groundGradientMap.minFilter = THREE.NearestFilter;
  groundGradientMap.magFilter = THREE.NearestFilter;
  groundGradientMap.generateMipmaps = false;
  groundGradientMap.needsUpdate = true;
  return groundGradientMap;
}

export function toon(color: string | number | THREE.Color): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({ color, gradientMap: getGradientMap() });
}

/** Shared proportions for all humanoids (heroine, soldiers, villagers). Lower y to make everyone a bit stockier. */
export const CHAR_SCALE = { x: 1.08, y: 0.86, z: 0.92 }; // pre-squash tuned for the oblique (sheared) projection

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
  /**
   * Beetles only: the two halves of the wing covers, hinged on the dorsal midline, plus the
   * membranous hindwings that beat underneath them. The enemy animation cracks the shell open for
   * the charge and claps the hindwings for the gust.
   */
  elytronL?: THREE.Group;
  elytronR?: THREE.Group;
  hindwingL?: THREE.Group;
  hindwingR?: THREE.Group;
  /** beetles only: the faint cone on the ground in front of it, shown while it charges the gust */
  gustArc?: THREE.Mesh;
  /**
   * Beetles only: the local scale `gustArc` carries at full reach. The beetle's root is scaled to
   * size the body (see LADYBUG_SIZE), and the tell has to be divided by that again — the cone on the
   * floor is a promise about tiles of *world*, so it must not shrink along with the beetle.
   */
  gustArcUnit?: number;
  /**
   * Spitflower only: the petal hinges around the mouth (one group per petal, rotated about Z so
   * local +x points radially outward), the dark mouth the energy balls leave through, and the glow
   * burning inside it while the flower charges a spit.
   */
  petals?: THREE.Group[];
  mouth?: THREE.Mesh;
  mouthGlow?: THREE.Mesh;
  /**
   * Spitflower only: the upper-stalk joint, hinged halfway up so the stalk curves instead of
   * tilting like a stick. The lower stalk (`body`) yaws the whole assembly around at the base and
   * leans, and this joint bends further in the same direction — the turn visibly travels up the
   * plant rather than spinning on the neck.
   */
  stalkTop?: THREE.Group;
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
    belt: toon('#6b4423'), boots: toon('#7b4a22'), eye: toon('#1d2b5a'),
    cap: toon('#2f9038'), steel: toon('#dfe6f4'), hilt: toon('#3557c9'), gold: toon('#f2c14e'),
    shieldBlue: toon('#2f57c4'), shieldRim: toon('#cfd7e6'),
  };
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  root.add(blobShadow(0.34));

  // bare legs (skin) with boots
  const legL = makeLeg(0.11, m.skin, m.boots);
  const legR = makeLeg(-0.11, m.skin, m.boots);
  root.add(legL, legR);

  // tunic: no belt; the hem hangs one pixel (~0.06) lower at the sides than in the middle
  body.add(part(UNIT_BOX, m.tunic, [0, 0.58, 0], [0.5, 0.42, 0.3]));
  body.add(part(UNIT_BOX, m.tunicD, [0, 0.37, 0], [0.56, 0.12, 0.36]));
  body.add(part(UNIT_BOX, m.tunicD, [-0.19, 0.34, 0], [0.18, 0.12, 0.36]));
  body.add(part(UNIT_BOX, m.tunicD, [0.19, 0.34, 0], [0.18, 0.12, 0.36]));
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
  shield.position.set(0, -0.04, 0.2);
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

  // Left-handed: mirror the whole figure (animation keeps driving armR as the sword arm).
  root.scale.set(-CHAR_SCALE.x, CHAR_SCALE.y, CHAR_SCALE.z);
  const materials = collectMaterials(root);
  for (const mat of materials) mat.side = THREE.DoubleSide; // negative scale flips winding
  return { root, body, head, armR, armL, handR, handL, legR, legL, weapon, shield, ponytail, materials };
}

export const SOLDIER_COLORS: Record<EnemyKind, string> = { sword: '#3c9c44', spear: '#3858c8', javelin: '#c83838', archer: '#7848b8', moblin: '#3a6fbf', moblin_spear: '#4a84d6', ladybug: '#d43a2a', ladybug_queen: '#a8281c', spitflower: '#3f9a3d' };

// ---------------------------------------------------------------- the beetles
/**
 * The two ladybugs. A ladybird is a ladybird: `ladybug` is the ordinary one you meet all over the
 * green country, and it is built to stand next to a soldier without dwarfing him. `ladybug_queen` is
 * the oversized one — the same beetle, kept at the size the model was first drawn at, for the
 * special encounter rather than for the crowd.
 */
export const LADYBUG_KINDS = ['ladybug', 'ladybug_queen'] as const;
export type LadybugKind = (typeof LADYBUG_KINDS)[number];
export const isLadybug = (k: EnemyKind): k is LadybugKind => k === 'ladybug' || k === 'ladybug_queen';

/** The spitflower: a rooted turret-plant. It never walks — the stalk bends and the head turns. */
export const isSpitflower = (k: EnemyKind): k is 'spitflower' => k === 'spitflower';

/**
 * How a beetle is sized: the authored model (see buildLadybug) is one scale, and each kind is that
 * scale multiplied by `plan` on the ground and `y` in height. The common ladybug comes out of this
 * the size of a soldier — as wide as one and a little flatter, because that is what a beetle is —
 * while the queen keeps the whole 1:1 authoring size.
 */
export const LADYBUG_SIZE: Record<LadybugKind, { plan: number; y: number }> = {
  ladybug: { plan: 0.7, y: 0.76 },
  ladybug_queen: { plan: 1.03, y: 0.94 },
};

/**
 * How far a beetle's wing-clap carries, in tiles, and how wide the cone of wind is, in radians.
 * The model draws its ground preview cone from these, and the enemy AI (entities.ts) uses them for
 * the blast itself, so the tell on the floor is always exactly the wind you get. The queen's clap is
 * a longer one — she is the big one and she hits everything in a bigger room.
 */
export const COMMON_GUST_RANGE = 2.8;
export const QUEEN_GUST_RANGE = 4.4;
export const gustRange = (kind: EnemyKind): number => (kind === 'ladybug_queen' ? QUEEN_GUST_RANGE : COMMON_GUST_RANGE);
export const GUST_HALF_ARC = 1.1; // ~63° either side of straight ahead

/**
 * Moblin — Link's Awakening inspired pig-like raider (classic Koholint blue).
 * Two loadouts: 'moblin' (sword + large wooden shield, blocks frontal attacks)
 * and 'moblin_spear' (throws a bone-tipped spear). Both share the same bulky
 * pig head, floppy ears, snout and tusks; they are noticeably stockier and in
 * the iconic LA blue (#4a7fd6 / #3a6fbf) with a dark navy vest, clearly distinct
 * from the armoured knights.
 */
function buildMoblin(kind: 'moblin' | 'moblin_spear'): Humanoid {
  const isSpear = kind === 'moblin_spear';
  // LA palette — classic Koholint blue (Link's Awakening DX / Switch): vibrant blue skin
  // with a creamy pig snout, ivory tusks and a dark navy vest. Restores the iconic
  // blue moblin while keeping the pig read (snout/ears/tusks).
  const pig = toon('#4a7fd6');
  const pigD = toon('#2e5aa8');
  const snout = toon('#f0c4a8');
  const snoutDark = toon('#3a1a10');
  const tuskMat = toon('#f6f1de');
  const earMat = toon('#3a6fbf');
  const earInner = toon('#1e3a7a');
  const vest = toon('#2f4a8a');
  const vestD = toon('#1a335a');
  const belt = toon('#1e2e4a');
  const boots = toon('#1a2540');
  const eyeMat = toon('#1a1a1a');
  const eyeRed = toon('#ff4a3a');
  (eyeRed as THREE.MeshToonMaterial).emissive.set('#ff2020');
  (eyeRed as THREE.MeshToonMaterial).emissiveIntensity = 0.35;
  const wood = toon('#8a5a2b');
  const woodL = toon('#c48b4f');
  const woodD = toon('#5a3a1e');
  const steel = toon('#a3adc0');
  const steelD = toon('#6b7382');
  const gold = toon('#d9b24a');

  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  root.add(blobShadow(0.40));

  // bulkier legs — bare pig legs with hoof-like boots, wider than the knights
  const legL = new THREE.Group(); legL.position.set(0.13, 0.34, 0);
  legL.add(part(UNIT_BOX, pigD, [0, -0.08, 0], [0.16, 0.18, 0.16]));
  legL.add(part(UNIT_BOX, boots, [0, -0.26, 0.03], [0.18, 0.15, 0.22]));
  const legR = new THREE.Group(); legR.position.set(-0.13, 0.34, 0);
  legR.add(part(UNIT_BOX, pigD, [0, -0.08, 0], [0.16, 0.18, 0.16]));
  legR.add(part(UNIT_BOX, boots, [0, -0.26, 0.03], [0.18, 0.15, 0.22]));
  root.add(legL, legR);

  // vest — leather, no plate, with a belt
  body.add(part(UNIT_BOX, vest, [0, 0.58, 0], [0.58, 0.44, 0.34]));
  body.add(part(UNIT_BOX, vestD, [0, 0.37, 0], [0.60, 0.10, 0.36]));
  body.add(part(UNIT_BOX, belt, [0, 0.50, 0], [0.60, 0.06, 0.36]));
  body.add(part(UNIT_BOX, gold, [0, 0.50, 0.18], [0.08, 0.06, 0.02])); // buckle
  body.add(part(UNIT_BOX, vestD, [-0.30, 0.78, 0], [0.16, 0.10, 0.18]));
  body.add(part(UNIT_BOX, vestD, [0.30, 0.78, 0], [0.16, 0.10, 0.18]));
  body.add(part(UNIT_BOX, pig, [0, 0.80, 0], [0.16, 0.08, 0.14])); // neck

  const { arm: armR, hand: handR } = makeArm(-0.34, vest, pig);
  const { arm: armL, hand: handL } = makeArm(0.34, vest, pig);
  body.add(armR, armL);

  // pig head — large snout, floppy ears, tusks, bead eyes
  const head = new THREE.Group();
  head.position.set(0, 1.02, 0);
  body.add(head);
  // cranium
  head.add(part(UNIT_SPHERE, pig, [0, 0.02, 0], [0.70, 0.62, 0.66]));
  // snout — boxy, protruding
  head.add(part(UNIT_BOX, snout, [0, -0.08, 0.32], [0.38, 0.26, 0.24]));
  head.add(part(UNIT_BOX, snoutDark, [-0.08, -0.08, 0.44], [0.06, 0.06, 0.02])); // nostril L
  head.add(part(UNIT_BOX, snoutDark, [0.08, -0.08, 0.44], [0.06, 0.06, 0.02])); // nostril R
  head.add(part(UNIT_BOX, snoutDark, [0, -0.15, 0.38], [0.20, 0.03, 0.10])); // mouth slit
  // tusks — ivory, curving out and up
  head.add(part(UNIT_CONE, tuskMat, [-0.14, -0.16, 0.30], [0.08, 0.14, 0.08]).rotateZ(0.55).rotateX(-0.35));
  head.add(part(UNIT_CONE, tuskMat, [0.14, -0.16, 0.30], [0.08, 0.14, 0.08]).rotateZ(-0.55).rotateX(-0.35));
  // ears — large, droopy
  head.add(part(UNIT_BOX, earMat, [-0.36, 0.10, -0.02], [0.22, 0.32, 0.10]).rotateZ(0.25));
  head.add(part(UNIT_BOX, earInner, [-0.36, 0.08, 0.05], [0.14, 0.20, 0.03]).rotateZ(0.25));
  head.add(part(UNIT_BOX, earMat, [0.36, 0.10, -0.02], [0.22, 0.32, 0.10]).rotateZ(-0.25));
  head.add(part(UNIT_BOX, earInner, [0.36, 0.08, 0.05], [0.14, 0.20, 0.03]).rotateZ(-0.25));
  // eyes — small, close-set, reddish glow
  head.add(part(UNIT_BOX, eyeMat, [-0.13, 0.04, 0.30], [0.09, 0.09, 0.04]));
  head.add(part(UNIT_BOX, eyeRed, [-0.13, 0.04, 0.32], [0.04, 0.04, 0.02]));
  head.add(part(UNIT_BOX, eyeMat, [0.13, 0.04, 0.30], [0.09, 0.09, 0.04]));
  head.add(part(UNIT_BOX, eyeRed, [0.13, 0.04, 0.32], [0.04, 0.04, 0.02]));
  // brow ridge
  head.add(part(UNIT_BOX, pigD, [0, 0.14, 0.26], [0.58, 0.10, 0.28]));
  // little horn / hair tuft on top (spear variant has a mohawk)
  if (isSpear) {
    head.add(part(UNIT_CONE, toon('#5a3a1e'), [0, 0.36, -0.06], [0.20, 0.22, 0.16]));
    head.add(part(UNIT_BOX, toon('#5a3a1e'), [0, 0.22, -0.08], [0.10, 0.14, 0.22]));
  } else {
    head.add(part(UNIT_BOX, steelD, [0, 0.32, -0.04], [0.48, 0.06, 0.38])); // brow band
    head.add(part(UNIT_SPHERE, steelD, [0, 0.34, -0.04], [0.12, 0.08, 0.12]));
  }

  let weapon: THREE.Group | undefined;
  let shield: THREE.Group | undefined;
  if (isSpear) {
    // throwing spear — long wooden shaft with crude iron tip and a red cloth wrap, LA-style
    weapon = new THREE.Group();
    // shaft longer than knight javelin
    weapon.add(part(UNIT_CYL, wood, [0, 0.30, 0], [0.055, 1.25, 0.055]));
    weapon.add(part(UNIT_CONE, steel, [0, 1.02, 0], [0.12, 0.24, 0.06]));
    weapon.add(part(UNIT_BOX, toon('#c82828'), [0, 0.45, 0], [0.07, 0.18, 0.07])); // cloth
    weapon.add(part(UNIT_BOX, woodL, [0, -0.28, 0], [0.04, 0.10, 0.06])); // butt
    handR.add(weapon);
  } else {
    // sword & shield — LA sword moblin: big round wooden shield, crude cleaver-like sword
    // cleaver sword: wider, slightly curved feel via boxes
    weapon = new THREE.Group();
    weapon.add(part(UNIT_BOX, steel, [0, -0.08 - 0.25, 0], [0.12, 0.50, 0.035])); // broad blade
    weapon.add(part(UNIT_BOX, steelD, [0, -0.02, 0.015], [0.02, 0.45, 0.02])); // fuller line
    weapon.add(part(UNIT_BOX, wood, [0, -0.04, 0], [0.24, 0.06, 0.08])); // guard
    weapon.add(part(UNIT_CYL, wood, [0, 0.06, 0], [0.06, 0.14, 0.06])); // grip
    weapon.add(part(UNIT_SPHERE, woodD, [0, 0.14, 0], [0.09, 0.09, 0.09])); // pommel
    handR.add(weapon);

    // large shield — Switch remake style: huge, covers torso, wooden with metal rim and pig snout boss
    shield = new THREE.Group();
    const disc = part(UNIT_CYL, wood, [0, 0, 0], [0.62, 0.06, 0.62]);
    disc.rotation.x = Math.PI / 2;
    shield.add(disc);
    const rim = part(UNIT_CYL, woodD, [0, 0, -0.01], [0.66, 0.04, 0.66]);
    rim.rotation.x = Math.PI / 2;
    shield.add(rim);
    // iron boss in centre
    shield.add(part(UNIT_SPHERE, steelD, [0, 0, 0.06], [0.16, 0.16, 0.08]));
    shield.add(part(UNIT_SPHERE, steel, [0, 0, 0.07], [0.10, 0.10, 0.06]));
    // wooden cross reinforcement
    shield.add(part(UNIT_BOX, woodD, [0, 0, 0.04], [0.58, 0.06, 0.02]));
    shield.add(part(UNIT_BOX, woodD, [0, 0, 0.04], [0.06, 0.58, 0.02]));
    shield.position.set(0, -0.02, 0.16);
    handL.add(shield);
  }

  // moblins are bulkier / taller than knights — Koholint's brutes
  root.scale.set(CHAR_SCALE.x * 1.09, CHAR_SCALE.y * 1.06, CHAR_SCALE.z * 1.08);
  return { root, body, head, armR, armL, handR, handL, legR, legL, weapon, shield, materials: collectMaterials(root) };
}

export function buildSoldier(kind: EnemyKind): Humanoid {
  if (isLadybug(kind)) return buildLadybug(kind);
  if (isSpitflower(kind)) return buildSpitflower();
  if (kind === 'moblin' || kind === 'moblin_spear') return buildMoblin(kind);
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

  root.scale.set(CHAR_SCALE.x * 1.02, CHAR_SCALE.y, CHAR_SCALE.z);
  return { root, body, head, armR, armL, handR, handL, legR, legL, weapon, shield, materials: collectMaterials(root) };
}

// ---------------------------------------------------------------- the giant ladybug
// Body proportions, all in local units (root sits on the ground; the beetle faces +z).
const SHELL_HW = 1.12, SHELL_H = 0.84, SHELL_LEN = 1.24;  // scale of a 0.5-radius quarter-dome
const SHELL_DROP = 0.42;                                   // dome height: where the shell's rim sits
const HINGE_Y = 1.02, HINGE_Z = -0.06;                     // the dorsal midline the wing covers hinge on
const HIP_Y = 0.46;                                        // leg pivot height
/** four spots per wing cover, in the dome's own (unit-sphere) space — mirrored for the other half */
const SHELL_SPOTS: [number, number, number][] = [
  [0.288, 0.192, 0.288], [0.271, 0.355, -0.052], [0.420, 0.126, -0.105], [0.218, 0.218, -0.327],
];
/** left (+x) and right (-x) quarters of a sphere: top half, split down the y-z plane */
const SHELL_DOME_L = new THREE.SphereGeometry(0.5, 12, 6, Math.PI / 2, Math.PI, 0, Math.PI / 2);
const SHELL_DOME_R = new THREE.SphereGeometry(0.5, 12, 6, -Math.PI / 2, Math.PI, 0, Math.PI / 2);

/**
 * A ladybug — the giant one of the beetle world, which is to say a ladybird the size of a soldier:
 * knee-high legs, a round black underbody, and a bright domed shell split down the middle. The two
 * halves are real, separately hinged wing covers (`elytronL`/`elytronR`), so the enemy can crack them
 * open for the wing-clap charge and let the membranous hindwings beat underneath
 * (`hindwingL`/`hindwingR`).
 *
 * The beetle is authored once, at the size it was drawn. LADYBUG_SIZE then sizes the two kinds: the
 * queen keeps practically all of it (a wide, low brute, taller than the heroine is a stride) and the
 * ordinary `ladybug` is scaled down to a soldier's bulk, so the two read as one species grown to
 * different ends. Everything that has to stay in *world* units — above all the gust tell lying on the
 * floor — divides that scale back out.
 *
 * Two things here are unusual for a model in this game: the shell material is double-sided (each
 * half is a hollow quarter-dome, and once the wings are open you look straight into it), and the
 * beetle carries `gustArc` — the faint cone painted on the ground in front of it that tells the
 * player exactly where its gust of wind will land.
 */
export function buildLadybug(kind: LadybugKind = 'ladybug'): Humanoid {
  const queen = kind === 'ladybug_queen';
  const shellMat = toon(queen ? '#b52a1a' : '#d8382a'); shellMat.side = THREE.DoubleSide;
  const shellDark = toon(queen ? '#7c1a12' : '#9c2418'); shellDark.side = THREE.DoubleSide;
  const spotMat = toon('#1a1418');
  const bodyMat = toon('#2b2329');
  const legMat = toon('#3a3036');
  const wingMat = new THREE.MeshToonMaterial({ color: '#8e7f8c', transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false });
  const eyeMat = toon('#f8f4e8');
  const pupilMat = toon('#141018');

  const root = new THREE.Group();
  root.add(blobShadow(0.72));
  const body = new THREE.Group();
  root.add(body);

  // six legs, three a side, splayed out past the shell — the pivot sits on the hip line so a swing
  // rocks the whole row forward and back the way a beetle scuttles
  const legs = (side: 1 | -1) => {
    const g = new THREE.Group();
    g.position.set(0, HIP_Y, 0);
    for (let i = -1; i <= 1; i++) {
      const leg = part(UNIT_BOX, legMat, [0.48 * side, -0.25, i * 0.44], [0.11, 0.5, 0.11]);
      leg.rotation.z = 0.6 * side;   // out and down: the foot lands a little outside the shell
      leg.rotation.x = -i * 0.22;    // front pair reaching ahead, back pair trailing
      g.add(leg);
    }
    return g;
  };
  const legL = legs(1), legR = legs(-1);
  root.add(legL, legR);

  // underbody: the dark abdomen you see once the shell is open, and the round belly from the side
  body.add(part(UNIT_SPHERE, bodyMat, [0, 0.52, -0.02], [1.06, 0.52, 1.4]));
  body.add(part(UNIT_BOX, bodyMat, [0, 0.44, 0.1], [0.5, 0.3, 0.9]));
  // pronotum: the black shield between head and shell, with its two little white cheek patches
  body.add(part(UNIT_HEMI, spotMat, [0, 0.80, 0.44], [0.86, 0.44, 0.52]));
  body.add(part(UNIT_BOX, eyeMat, [-0.27, 0.87, 0.62], [0.13, 0.11, 0.12]));
  body.add(part(UNIT_BOX, eyeMat, [0.27, 0.87, 0.62], [0.13, 0.11, 0.12]));

  const shellHalf = (side: 1 | -1) => {
    const g = new THREE.Group();
    g.position.set(0, HINGE_Y, HINGE_Z);
    const dome = new THREE.Mesh(side > 0 ? SHELL_DOME_L : SHELL_DOME_R, shellMat);
    dome.scale.set(SHELL_HW, SHELL_H, SHELL_LEN);
    dome.position.set(0, -SHELL_DROP, -0.16);
    g.add(dome);
    const spot = queen ? 0.3 : 0.26; // the big one carries the same four spots, a shade fatter
    for (const [sx, sy, sz] of SHELL_SPOTS) dome.add(part(UNIT_SPHERE, spotMat, [sx * side, sy, sz], [spot, spot, spot]));
    // a low ridge along the dorsal midline, so the closed shell still reads as two wing covers
    g.add(part(UNIT_BOX, shellDark, [0.03 * side, 0, -0.16], [0.07, 0.06, SHELL_LEN * 0.9]));
    return g;
  };
  const elytronL = shellHalf(1), elytronR = shellHalf(-1);
  body.add(elytronL, elytronR);

  // hindwings: folded flat under the shell, beating hard for the wing-clap
  const hindwing = (side: 1 | -1) => {
    const g = new THREE.Group();
    g.position.set(0.05 * side, HINGE_Y - 0.14, HINGE_Z - 0.05);
    const wing = part(UNIT_BOX, wingMat, [0.22 * side, -0.02, -0.14], [0.36, 0.02, 0.62]);
    wing.rotation.z = 0.1 * side;
    wing.rotation.y = -0.22 * side;
    g.add(wing);
    return g;
  };
  const hindwingL = hindwing(1), hindwingR = hindwing(-1);
  body.add(hindwingL, hindwingR);

  const head = new THREE.Group();
  head.position.set(0, 0.7, 0.66);
  body.add(head);
  head.add(part(UNIT_SPHERE, bodyMat, [0, 0, 0], [0.46, 0.42, 0.44]));
  head.add(part(UNIT_SPHERE, eyeMat, [-0.16, 0.05, 0.14], [0.2, 0.2, 0.18]));
  head.add(part(UNIT_SPHERE, eyeMat, [0.16, 0.05, 0.14], [0.2, 0.2, 0.18]));
  head.add(part(UNIT_SPHERE, pupilMat, [-0.2, 0.06, 0.2], [0.1, 0.11, 0.09]));
  head.add(part(UNIT_SPHERE, pupilMat, [0.2, 0.06, 0.2], [0.1, 0.11, 0.09]));

  // antennae ride the arm slots (the enemy animation waves them about from there); their tips sit
  // in the hand slots, which is all this beetle has for hands
  const antenna = (side: 1 | -1) => {
    const arm = new THREE.Group();
    arm.position.set(0.13 * side, 0.14, 0.06);
    arm.rotation.order = 'YXZ';
    arm.rotation.set(-0.5, 0, -0.5 * side);
    arm.add(part(UNIT_BOX, bodyMat, [0, 0.19, 0], [0.05, 0.42, 0.05]));
    const hand = new THREE.Group();
    hand.position.set(0, 0.4, 0);
    hand.add(part(UNIT_BOX, bodyMat, [0, 0.05, 0], [0.1, 0.12, 0.1]));
    arm.add(hand);
    return { arm, hand };
  };
  const { arm: armL, hand: handL } = antenna(1);
  const { arm: armR, hand: handR } = antenna(-1);
  head.add(armL, armR);

  // the tell: a faint cone on the ground ahead, sized from the real gust the AI throws. The beetle's
  // own scale is divided back out of it, so the cone the player sees is the cone the wind fills.
  const range = gustRange(kind);
  const size = LADYBUG_SIZE[kind];
  const arcGeo = new THREE.RingGeometry(0.18, 1, 26, 1, -GUST_HALF_ARC - Math.PI / 2, GUST_HALF_ARC * 2).rotateX(-Math.PI / 2);
  const gustArc = new THREE.Mesh(arcGeo, new THREE.MeshBasicMaterial({ color: '#e2f4ff', transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
  gustArc.position.y = 0.06;
  gustArc.scale.set(range / size.plan, 1, range / size.plan);
  gustArc.visible = false;
  root.add(gustArc);

  // the ordinary beetle stands about as tall as a soldier's chest and as wide as his shoulders; the
  // queen is left at the size she was drawn, a stride longer than the heroine
  root.scale.set(size.plan, size.y, size.plan);
  return { root, body, head, armR, armL, handR, handL, legR, legL, elytronL, elytronR, hindwingL, hindwingR, gustArc, gustArcUnit: range / size.plan, materials: collectMaterials(root) };
}

// ---------------------------------------------------------------- the spitflower
/** Height of the flower head above the ground (the stalk is long so the head clears the ferns). */
export const SPITFLOWER_HEAD_H = 1.24;
/** How many petals ring the mouth. */
export const SPITFLOWER_PETALS = 7;

/**
 * A spitflower — the forest's own turret: a big blossom on a long flexible stalk, rooted where it
 * sprouted. It aims the way a plant would: the stalk hauls itself around at the base and bends
 * toward her, and the head only adds a small correction on its neck — there is deliberately no
 * free-spinning neck joint for it to turret on.
 *
 * The stalk is two segments: the lower stalk (`body`) yaws the assembly around and leans, and the
 * upper joint (`stalkTop`) bends further in the same direction, so the turn visibly curves up the
 * plant. The head is a sunflower-like face: a yellow disc ringed by petals, with a dark mouth in
 * the middle that glows green while a spit is charging. The petals are real hinges (`petals`):
 * cupped forward around the mouth at rest, flung back for the spit. The side buds ride the arm
 * slots and the two big ground leaves ride the leg slots, so the Humanoid rig stays intact.
 */
export function buildSpitflower(): Humanoid {
  const stalkMat = toon('#3f9a3d');
  const leafMat = toon('#4cb040');
  const leafDark = toon('#2f7a2f');
  const sepalMat = toon('#2e7a34');
  const faceMat = toon('#f2c14e');
  const petalMat = toon('#e14a6a');
  const petalLight = toon('#f2788f');
  const mouthMat = toon('#2a1420');
  const soilMat = toon('#6b4a2c');
  const glowMat = new THREE.MeshBasicMaterial({ color: '#b8ff4a' });

  const root = new THREE.Group();
  root.add(blobShadow(0.42));
  // yaw first, then tilt in the yawed frame: rotation.y swings the stalk around, rotation.x leans
  // it toward wherever it faces
  const body = new THREE.Group();
  body.rotation.order = 'YXZ';
  root.add(body);

  // the mound it sits in, and the lower stalk rising out of it
  body.add(part(UNIT_SPHERE, soilMat, [0, 0.04, 0], [0.5, 0.16, 0.44]));
  body.add(part(UNIT_CYL, stalkMat, [0, 0.4, 0], [0.24, 0.7, 0.24]));
  // a pair of thorns on the lower stalk
  body.add(part(UNIT_CONE, leafDark, [0.13, 0.42, 0], [0.09, 0.16, 0.09]).rotateZ(-1.1));
  body.add(part(UNIT_CONE, leafDark, [-0.13, 0.58, 0.02], [0.09, 0.16, 0.09]).rotateZ(1.1));

  // the upper stalk, hinged halfway up so the whole thing curves
  const stalkTop = new THREE.Group();
  stalkTop.position.set(0, 0.72, 0);
  body.add(stalkTop);
  stalkTop.add(part(UNIT_CYL, stalkMat, [0, 0.26, 0], [0.18, 0.6, 0.18]));
  const midLeaf = part(UNIT_BOX, leafMat, [0.2, 0.28, 0], [0.34, 0.05, 0.16]);
  midLeaf.rotation.z = 0.5;
  stalkTop.add(midLeaf);

  // the two big ground leaves (leg slots): broad, drooping, rustling in the animation
  const leaf = (side: 1 | -1) => {
    const g = new THREE.Group();
    g.position.set(0.1 * side, 0.3, 0);
    const blade = part(UNIT_BOX, side > 0 ? leafMat : leafDark, [0.3 * side, 0, 0], [0.6, 0.06, 0.26]);
    blade.rotation.z = -0.28 * side; // tip drooping toward the ground
    g.add(blade);
    g.add(part(UNIT_BOX, leafDark, [0.3 * side, 0.03, 0], [0.5, 0.02, 0.05]).rotateZ(-0.28 * side)); // centre rib
    return g;
  };
  const legL = leaf(1), legR = leaf(-1);
  root.add(legL, legR);

  // side buds (arm slots): two closed buds on short stems, bobbing gently
  const bud = (side: 1 | -1, y: number) => {
    const arm = new THREE.Group();
    arm.position.set(0.12 * side, y, 0);
    arm.rotation.order = 'YXZ';
    arm.add(part(UNIT_CYL, stalkMat, [0.08 * side, 0, 0], [0.06, 0.2, 0.06]).rotateZ(1.2 * side));
    arm.add(part(UNIT_SPHERE, sepalMat, [0.18 * side, 0.06, 0], [0.16, 0.2, 0.16]));
    arm.add(part(UNIT_SPHERE, petalMat, [0.18 * side, 0.16, 0], [0.1, 0.1, 0.1]));
    const hand = new THREE.Group();
    hand.position.set(0.18 * side, 0.16, 0);
    arm.add(hand);
    return { arm, hand };
  };
  const { arm: armR, hand: handR } = bud(-1, 0.56);
  const { arm: armL, hand: handL } = bud(1, 0.42);
  body.add(armR, armL);

  // the head: neck + sepal cup + yellow face + dark mouth, ringed by hinged petals.
  // It rides the upper stalk (0.72 + 0.52 = SPITFLOWER_HEAD_H above the ground when straight).
  const head = new THREE.Group();
  head.position.set(0, SPITFLOWER_HEAD_H - 0.72, 0);
  head.rotation.order = 'YXZ';
  stalkTop.add(head);
  head.add(part(UNIT_CYL, stalkMat, [0, -0.1, 0], [0.18, 0.3, 0.18]));
  head.add(part(UNIT_SPHERE, sepalMat, [0, 0, -0.06], [0.54, 0.48, 0.44]));
  head.add(part(UNIT_SPHERE, faceMat, [0, 0, 0.2], [0.44, 0.4, 0.18]));
  const mouth = part(UNIT_CYL, mouthMat, [0, 0, 0.32], [0.26, 0.1, 0.26]);
  mouth.rotation.x = Math.PI / 2;
  head.add(mouth);
  const mouthGlow = part(UNIT_SPHERE, glowMat, [0, 0, 0.31], [0.14, 0.14, 0.14]);
  head.add(mouthGlow);
  const petals: THREE.Group[] = [];
  for (let i = 0; i < SPITFLOWER_PETALS; i++) {
    const a = (i / SPITFLOWER_PETALS) * Math.PI * 2;
    const hinge = new THREE.Group();
    hinge.position.set(0, 0, 0.1);
    hinge.rotation.z = a; // local +x points radially outward from the mouth
    const petal = part(UNIT_SPHERE, i % 2 ? petalLight : petalMat, [0.38, 0, 0], [0.36, 0.2, 0.1]);
    petal.rotation.y = -0.3; // cupped loosely forward at rest (the enemy animation works them)
    hinge.add(petal);
    head.add(hinge);
    petals.push(hinge);
  }

  return { root, body, head, armR, armL, handR, handL, legR, legL, petals, mouth, mouthGlow, stalkTop, materials: collectMaterials(root) };
}

// ---------------------------------------------------------------- props
export type TreeKind = 'oak' | 'pine' | 'autumn' | 'birch' | 'blossom';

// Bushes, hedges and rosebushes keep the particle-foliage look from this branch
// (see foliage.ts). Trees are the classic solid toon canopies as on main, with a
// gentle shader-driven canopy sway (applyTreeWind below) so they move slightly
// in the wind without changing how they look.
import { buildBush as buildBushFoliage, buildBerryBush as buildBerryBushFoliage, buildHedge as buildHedgeFoliage, buildRosebush as buildRosebushFoliage, foliageUniforms } from './foliage';

/** Trees are rendered as one instanced trio (trunk/canopy/shadow) per kind so the map can mix species. */
export function buildTrees(trees: TreeSpec[]): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  for (const kind of ['oak', 'pine', 'autumn', 'birch', 'blossom'] as TreeKind[]) {
    const list = trees.filter((t) => (t.kind ?? 'oak') === kind);
    if (list.length) out.push(...buildTreeVariant(list, kind));
  }
  return out;
}

/** Gentle wind sway for the instanced tree canopies — look untouched, motion only.
 *  The canopy leans into the same travelling gusts as the grass and bushes (shared
 *  uTime / wind texture / wind direction uniforms), applied in world space after the
 *  instance transform so every tree bows with the same wind. Vertices bend more the
 *  higher they sit: the crown rustles while the part hugging the trunk stays put. */
function applyTreeWind(mat: THREE.MeshToonMaterial) {
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
          // canopy wind, in world space (these meshes sit untransformed in the scene)
          float treeScale = length( instanceMatrix[0].xyz );
          float bend = clamp( ( position.y - 0.8 ) * 0.45, 0.0, 1.0 );
          bend = bend * bend * 0.65 + bend * 0.35;
          vec2 wuv = mvPosition.xz / uWindScale + uWindDir * ( uTime * 0.13 );
          float gust = texture2D( uWindTex, wuv ).r;
          float phase = instanceMatrix[3].x * 1.7 + instanceMatrix[3].z * 2.3;
          vec2 windOff = uWindDir * ( ( gust - 0.42 ) * uGust );
          windOff += vec2( sin( uTime * 1.1 + phase ), cos( uTime * 0.85 + phase * 1.31 ) ) * uSway;
          windOff *= treeScale * bend * 1.8;
          mvPosition.xz += windOff;
          mvPosition.y -= ( abs( windOff.x ) + abs( windOff.y ) ) * 0.3;
        #endif
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;`,
      );
  };
}

function buildTreeVariant(trees: TreeSpec[], kind: TreeKind): THREE.Object3D[] {
  const mk = (r: number, sx: number, sy: number, sz: number, x: number, y: number, z: number) => {
    const g = new THREE.SphereGeometry(r, 12, 8);
    g.scale(sx, sy, sz);
    g.translate(x, y, z);
    return g;
  };
  let canopyGeo: THREE.BufferGeometry;
  if (kind === 'pine') {
    // tall stacked cones: the conifers of the Amber Highland
    const cone = (r: number, h: number, y: number) => {
      const g = new THREE.ConeGeometry(r, h, 9);
      g.translate(0, y + h / 2, 0);
      return g;
    };
    canopyGeo = mergeGeometries([cone(1.0, 1.5, 0.75), cone(0.76, 1.35, 1.45), cone(0.52, 1.15, 2.1)])!;
  } else {
    canopyGeo = mergeGeometries([
      mk(1.0, 1, 0.62, 0.8, 0, 0.9, 0),
      mk(0.5, 1, 0.9, 0.9, -0.55, 1.25, -0.1),
      mk(0.5, 1, 0.9, 0.9, 0.55, 1.25, -0.1),
      mk(0.48, 1, 0.9, 0.9, 0, 1.45, 0.25),
      mk(0.44, 1, 0.9, 0.9, 0.05, 1.3, -0.35),
    ])!;
  }
  const canopyMat = toon(kind === 'pine' ? '#2e7a4a' : kind === 'autumn' ? '#d18a2e' : kind === 'birch' ? '#9ac04a' : kind === 'blossom' ? '#e89ac0' : '#3f9a3d');
  applyTreeWind(canopyMat);
  const trunkMat = toon(kind === 'birch' ? '#e8e0d0' : '#6b4226');
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
    pos.set(t.x, t.y ?? 0, t.z);
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
  return buildBushFoliage();
}

export function buildBerryBush(): THREE.Group {
  return buildBerryBushFoliage();
}

export function buildHedge(): THREE.Group {
  return buildHedgeFoliage();
}

export function buildRosebush(): THREE.Group {
  return buildRosebushFoliage();
}

// ---------------------------------------------------------------- undergrowth (vertex-coloured, instanced)
/** Paint a flat vertex colour across a geometry so several parts can be merged into one material. */
function withColor(geo: THREE.BufferGeometry, hex: string, k = 1): THREE.BufferGeometry {
  const c = new THREE.Color(hex).multiplyScalar(k);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
  return geo;
}

export function vertexToon(): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: getGradientMap() });
}

/** A single-mesh view of a vegetation geometry (model viewer). */
export function vegObject(geo: THREE.BufferGeometry): THREE.Mesh {
  return new THREE.Mesh(geo, vertexToon());
}

/** Bracken fern: a fan of drooping fronds on a short stem. */
export function buildFernGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + (i % 3) * 0.3;
    const len = 0.55 + (i % 4) * 0.12;
    const g = new THREE.ConeGeometry(0.1, len, 4);
    g.translate(0, len / 2, 0);
    g.rotateZ(0.85 + (i % 3) * 0.12);
    g.rotateY(a);
    parts.push(withColor(g, i % 2 ? '#2f7a3a' : '#3f8f46'));
  }
  parts.push(withColor(new THREE.ConeGeometry(0.09, 0.5, 4).translate(0, 0.25, 0).rotateZ(0.4).rotateY(1.2), '#58b04a'));
  parts.push(withColor(new THREE.CylinderGeometry(0.03, 0.05, 0.18, 5).translate(0, 0.09, 0), '#6b4a2c'));
  return mergeGeometries(parts)!;
}

/** Tall swaying grass tuft. */
export function buildTallGrassGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const cols = ['#6faf4e', '#7fbf5a', '#5a9a42'];
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + (i % 2) * 0.4;
    const hgt = 0.5 + (i % 5) * 0.12;
    const g = new THREE.BoxGeometry(0.035, hgt, 0.035);
    g.translate(0, hgt / 2, 0);
    g.rotateZ(((i % 3) - 1) * 0.22);
    g.rotateY(a);
    parts.push(withColor(g, cols[i % 3]));
  }
  return mergeGeometries(parts)!;
}

/** Thorny briar thicket. */
export function buildBriarGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const core = new THREE.IcosahedronGeometry(0.42, 0); core.scale(1, 0.8, 1); core.translate(0, 0.32, 0);
  parts.push(withColor(core, '#2e4a2a'));
  parts.push(withColor(new THREE.IcosahedronGeometry(0.3, 0).scale(1, 0.7, 1).translate(0.16, 0.5, 0.1), '#3a5a32'));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.4;
    const t = new THREE.ConeGeometry(0.035, 0.22, 4);
    t.translate(0, 0.11, 0); t.rotateZ(Math.PI / 2 + 0.5); t.rotateY(a); t.translate(0.3, 0.35, 0);
    // icosahedrons are non-indexed: the cones must be too, or mergeGeometries() rejects the mix
    parts.push(withColor(t.toNonIndexed()!, '#4a3018'));
  }
  return mergeGeometries(parts)!;
}

/** Lily pads with a single blossom (floats on water). */
export function buildLilyGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const pad = (r: number, x: number, z: number, c: string) => {
    const g = new THREE.CylinderGeometry(r * 0.92, r, 0.035, 10);
    g.translate(x, 0, z); parts.push(withColor(g, c));
  };
  pad(0.34, 0.08, 0.05, '#4a9a44');
  pad(0.28, -0.2, -0.14, '#58a84e');
  pad(0.2, 0.14, -0.26, '#4a9a44');
  parts.push(withColor(new THREE.SphereGeometry(0.07, 8, 6).translate(0.08, 0.06, 0.05), '#f2f2f2'));
  parts.push(withColor(new THREE.SphereGeometry(0.035, 6, 5).translate(0.08, 0.1, 0.05), '#f2c14e'));
  return mergeGeometries(parts)!;
}

// ---------------------------------------------------------------- crops (village farm)
/**
 * One growth stage of a crop as a single vertex-coloured geometry covering a whole plot (a 3x2
 * grid of plants on a tile), in the plot's local frame (tile centre at the origin). The stages
 * follow the sim's CROP_STAGES: 0 seeded (a few seed dots), 1 sprout, 2 leafy, 3 ripe.
 */
export function buildCropGeo(crop: 'turnip' | 'cabbage', stage: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // plant positions in the plot: three across, two rows, a touch of jitter so the rows aren't rigid
  const spots: [number, number, number][] = [];
  for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) {
    const k = r * 3 + c;
    spots.push([-0.3 + c * 0.3 + (((k * 7) % 5) - 2) * 0.02, -0.2 + r * 0.4 + (((k * 3) % 5) - 2) * 0.02, 0.85 + ((k * 11) % 4) * 0.08]);
  }
  const leafC = crop === 'turnip' ? ['#5cbf4a', '#8ce070'] : ['#4faa5a', '#7fd08a'];
  const sprout = crop === 'turnip' ? '#8ce070' : '#7fd08a';
  const pad = (g: THREE.BufferGeometry) => g.index ? g.toNonIndexed() : g;
  for (const [x, z, s] of spots) {
    if (stage <= 0) {
      // seeds pressed into the furrow
      parts.push(withColor(pad(new THREE.BoxGeometry(0.06, 0.03, 0.05)).translate(x, 0.015, z), '#e8d8a0'));
      continue;
    }
    if (stage === 1) {
      // a pair of seed leaves on a short stem
      const h = 0.14 * s;
      parts.push(withColor(pad(new THREE.BoxGeometry(0.03, h, 0.03)).translate(x, h / 2, z), '#4a9a40'));
      for (const side of [-1, 1]) parts.push(withColor(pad(new THREE.BoxGeometry(0.1, 0.02, 0.06)).rotateZ(side * 0.5).translate(x + side * 0.05, h, z), sprout));
      continue;
    }
    if (crop === 'turnip') {
      // turnip: a rosette of upright leaves; the ripe one shows a purple-white root shouldering out of the soil
      const n = stage === 2 ? 4 : 6;
      const lh = (stage === 2 ? 0.22 : 0.3) * s;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + s;
        const leaf = new THREE.ConeGeometry(0.05, lh, 4);
        leaf.translate(0, lh / 2, 0); leaf.rotateZ(0.45); leaf.rotateY(a); leaf.translate(x, 0.02, z);
        parts.push(withColor(pad(leaf), leafC[i % 2]));
      }
      if (stage >= 3) {
        parts.push(withColor(pad(new THREE.SphereGeometry(0.11 * s, 8, 6)).scale(1, 0.7, 1).translate(x, 0.04, z), '#e8d8f0'));
        parts.push(withColor(pad(new THREE.SphereGeometry(0.08 * s, 8, 5)).scale(1, 0.6, 1).translate(x, 0.1, z), '#9a4fb8'));
      }
    } else {
      // cabbage: a flat whorl of outer leaves, and a tight pale head once ripe
      const r = (stage === 2 ? 0.1 : 0.14) * s;
      parts.push(withColor(pad(new THREE.SphereGeometry(r, 8, 6)).scale(1.4, 0.45, 1.4).translate(x, r * 0.35, z), leafC[0]));
      parts.push(withColor(pad(new THREE.SphereGeometry(r * 0.8, 8, 6)).scale(1.2, 0.5, 1.2).translate(x + 0.02, r * 0.5, z - 0.02), leafC[1]));
      if (stage >= 3) parts.push(withColor(pad(new THREE.SphereGeometry(r * 0.7, 8, 6)).translate(x, r * 0.75, z), '#c8e8a0'));
    }
  }
  return mergeGeometries(parts)!;
}

/**
 * The farmhand's watering can — ported from #20 visuals (steel + brass band).
 * Stubby body with brass base band, spout with rose, bow handle. Holds from hand
 * so pour is just tipping forward.
 */
export function buildWateringCan(): THREE.Group {
  const steel = toon('#a8b4c0'), steelD = toon('#6f7c88'), brass = toon('#c9a24a');
  const g = new THREE.Group();
  g.add(part(UNIT_CYL, steel, [0, -0.17, 0.0], [0.3, 0.3, 0.3]));        // body
  g.add(part(UNIT_CYL, steelD, [0, -0.03, 0.0], [0.26, 0.06, 0.26]));    // lid
  g.add(part(UNIT_CYL, brass, [0, -0.31, 0.0], [0.31, 0.04, 0.31]));     // base band
  const spout = part(UNIT_CYL, steel, [0, -0.14, 0.2], [0.07, 0.34, 0.07]);
  spout.rotation.x = 0.8;
  g.add(spout);
  g.add(part(UNIT_CYL, steelD, [0, -0.05, 0.34], [0.11, 0.05, 0.11]));   // rose
  g.add(part(UNIT_BOX, steelD, [0, 0.05, 0.0], [0.05, 0.22, 0.05]));     // handle bow
  g.add(part(UNIT_BOX, steelD, [0, 0.14, 0.0], [0.18, 0.04, 0.05]));
  return g;
}

/** Big faceted boulder with a moss cap. */
export function buildBoulderGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const main = new THREE.IcosahedronGeometry(0.72, 0); main.scale(1.15, 0.78, 0.98); main.translate(0, 0.34, 0);
  parts.push(withColor(main, '#a2a29a'));
  parts.push(withColor(new THREE.IcosahedronGeometry(0.4, 0).scale(1, 0.8, 1).translate(0.62, 0.18, 0.3), '#84847c'));
  parts.push(withColor(new THREE.IcosahedronGeometry(0.34, 0).scale(1.1, 0.5, 0.9).translate(-0.12, 0.62, 0.08), '#5f9a4a'));
  parts.push(withColor(new THREE.IcosahedronGeometry(0.2, 0).translate(0.2, 0.08, -0.5), '#6f6f6a'));
  return mergeGeometries(parts)!;
}

export interface VegSpot { x: number; y: number; z: number }

/** One InstancedMesh for a scatter of vegetation (single draw call, per-instance yaw/scale/position jitter). */
export function makeVegInstances(geo: THREE.BufferGeometry, spots: VegSpot[], seed: number): THREE.InstancedMesh {
  const im = new THREE.InstancedMesh(geo, vertexToon(), spots.length);
  const rng = new RNG(seed);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  spots.forEach((t, i) => {
    p.set(t.x + (rng.next() - 0.5) * 0.4, t.y, t.z + (rng.next() - 0.5) * 0.4);
    q.setFromAxisAngle(up, rng.next() * Math.PI * 2);
    s.set(0.8 + rng.next() * 0.4, 0.8 + rng.next() * 0.45, 0.8 + rng.next() * 0.4);
    m4.compose(p, q, s);
    im.setMatrixAt(i, m4);
  });
  im.instanceMatrix.needsUpdate = true;
  return im;
}

export function buildStump(): THREE.Mesh {
  return part(UNIT_CYL, toon('#2f7a2f'), [0, 0.03, 0], [0.5, 0.06, 0.42]);
}

/** v: 0 plain, 1 mossy (forests), 2 crystal (mesa/highland) */
export function buildRock(v = 0): THREE.Group {
  const g = new THREE.Group();
  g.add(part(UNIT_SPHERE, toon('#a9a9a2'), [0, 0.26, 0], [0.7, 0.52, 0.6]));
  g.add(part(UNIT_SPHERE, toon('#c6c6be'), [-0.12, 0.42, -0.05], [0.3, 0.2, 0.26]));
  g.add(part(UNIT_CYL, toon('#63635e'), [0, 0.03, 0], [0.76, 0.06, 0.64]));
  if (v === 1) {
    g.add(part(UNIT_BOX, toon('#5f9a4a'), [-0.08, 0.5, 0.02], [0.5, 0.14, 0.42]));
    g.add(part(UNIT_BOX, toon('#4a7a3a'), [0.18, 0.3, 0.2], [0.3, 0.1, 0.2]));
  } else if (v === 2) {
    const cry = toon('#7a5ac8'), cryL = toon('#a88ae8');
    g.add(part(UNIT_OCTA, cry, [0.16, 0.55, 0.1], [0.2, 0.3, 0.2]).rotateZ(-0.2));
    g.add(part(UNIT_OCTA, cryL, [-0.14, 0.5, 0.18], [0.14, 0.2, 0.14]).rotateZ(0.35));
    g.add(part(UNIT_OCTA, cry, [-0.02, 0.52, -0.2], [0.12, 0.16, 0.12]));
  }
  return g;
}

export function buildFence(): THREE.Group {
  const g = new THREE.Group();
  g.add(part(UNIT_CYL, toon('#a5713d'), [0, 0.32, 0], [0.34, 0.64, 0.34]));
  g.add(part(UNIT_SPHERE, toon('#cf9a62'), [0, 0.64, 0], [0.34, 0.2, 0.34]));
  g.add(part(UNIT_CYL, toon('#5a3a1e'), [0, 0.02, 0], [0.42, 0.04, 0.4]));
  return g;
}

/**
 * Hipped roof: rectangular eave (W x D) at y=0, short ridge (length rl) at height H, pushed back by rz.
 * Flat-shaded, with vertex colours that run light at the ridge -> dark at the eave. Under the straight-down
 * game camera a slope has no perspective cue, so this gradient (quantised by the post-FX into SNES-style bands)
 * is what makes the roof read as sloped instead of flat.
 */
function hipRoofGeometry(W: number, D: number, H: number, rl: number, rz: number): THREE.BufferGeometry {
  const hw = W / 2, hd = D / 2, hr = rl / 2;
  const A = [-hw, 0, hd], B = [hw, 0, hd], C = [hw, 0, -hd], E = [-hw, 0, -hd]; // eave corners (front = +z)
  const R1 = [-hr, H, rz], R2 = [hr, H, rz];
  const tris = [
    [A, B, R2], [A, R2, R1],        // front slope
    [C, E, R1], [C, R1, R2],        // back slope
    [B, C, R2],                     // right hip
    [E, A, R1],                     // left hip
  ];
  const pos: number[] = [], col: number[] = [];
  for (const t of tris) for (const v of t) {
    pos.push(v[0], v[1], v[2]);
    const k = 0.62 + 0.5 * (v[1] / H); // eave 0.62 -> ridge 1.12
    col.push(k, k, k);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

/**
 * SNES-style cottage (A Link to the Past look): a big, dark-trimmed hipped roof dominating the silhouette,
 * short tan walls with dark timber posts, an oversized arched door with a stone surround, amber windows
 * and two round vents on the roof slope.
 */
export function buildHouse(spec: HouseSpec): THREE.Group {
  const g = new THREE.Group();
  const cx = spec.x + spec.w / 2, cz = spec.z + spec.d / 2;
  const roofC = new THREE.Color(spec.roof ?? '#b73c3c');
  // muted, slightly dusky roof tones like the SNES palette
  const roofMid = roofC.clone().lerp(new THREE.Color('#6a3040'), 0.25);
  const roof = toon(roofMid), roofD = toon(roofMid.clone().multiplyScalar(0.6)), roofL = toon(roofMid.clone().lerp(new THREE.Color('#ffffff'), 0.16));
  const trim = toon('#3a1e1e');
  const wall = toon(new THREE.Color(spec.wall ?? '#e8d6a8').lerp(new THREE.Color('#c9a469'), 0.55));
  const wallD = toon('#a07c48');
  const timber = toon('#5a3418'), timberL = toon('#7a4a24');
  const stone = toon('#a8a49a'), stoneD = toon('#6f6b62');
  const doorM = toon('#4a2a12'), doorD = toon('#2e1a0a');
  const amber = toon('#f6b83c'); amber.emissive.set('#c07a10'); amber.emissiveIntensity = 0.55;
  const amberL = toon('#ffe9a0'); amberL.emissive.set('#ffd060'); amberL.emissiveIntensity = 0.6;

  const depth = spec.d - 0.8;
  const WH = 1.15;                          // wall height (short - the roof is the star)
  const fz = cz + depth / 2;                // front face z
  // stone foundation + walls
  g.add(part(UNIT_BOX, stoneD, [cx, 0.1, cz], [spec.w + 0.14, 0.2, depth + 0.14]));
  g.add(part(UNIT_BOX, stone, [cx, 0.19, fz + 0.08], [spec.w + 0.14, 0.06, 0.02]));
  g.add(part(UNIT_BOX, wall, [cx, WH / 2 + 0.1, cz], [spec.w, WH, depth]));
  // dark timber posts: corners + between openings; a top plate under the eaves
  const posts = spec.w >= 5 ? [-spec.w / 2 + 0.1, -0.95, 0.95, spec.w / 2 - 0.1] : [-spec.w / 2 + 0.1, spec.w / 2 - 0.1];
  for (const px of posts) g.add(part(UNIT_BOX, timber, [cx + px, WH / 2 + 0.1, fz + 0.02], [0.14, WH, 0.06]));
  g.add(part(UNIT_BOX, timber, [cx, WH + 0.08, fz + 0.02], [spec.w, 0.12, 0.06]));
  for (const sx of [-1, 1]) g.add(part(UNIT_BOX, timber, [cx + sx * spec.w / 2, WH / 2 + 0.1, cz], [0.06, WH, depth]));
  g.add(part(UNIT_BOX, wallD, [cx, 0.3, fz + 0.01], [spec.w, 0.16, 0.03])); // shadow band at the base of the wall

  // big arched door with a stone surround and a step
  const dw = 1.1, dh = 1.0;
  g.add(part(UNIT_BOX, stone, [cx, dh / 2 + 0.1, fz + 0.04], [dw + 0.3, dh, 0.08]));
  g.add(part(UNIT_CYL, stone, [cx, dh + 0.1, fz + 0.04], [dw + 0.3, 0.08, dw + 0.3]).rotateX(Math.PI / 2));
  g.add(part(UNIT_BOX, doorM, [cx, dh / 2 + 0.1, fz + 0.09], [dw, dh, 0.06]));
  g.add(part(UNIT_CYL, doorM, [cx, dh + 0.1, fz + 0.09], [dw, 0.06, dw]).rotateX(Math.PI / 2));
  g.add(part(UNIT_BOX, doorD, [cx, dh / 2 + 0.1, fz + 0.125], [0.05, dh, 0.02]));       // plank seam
  g.add(part(UNIT_BOX, doorD, [cx, 0.62, fz + 0.125], [dw - 0.1, 0.06, 0.02]));           // cross brace
  g.add(part(UNIT_SPHERE, toon('#f2c14e'), [cx + 0.3, 0.6, fz + 0.14], [0.09, 0.09, 0.06]));
  g.add(part(UNIT_BOX, stoneD, [cx, 0.05, fz + 0.22], [dw + 0.4, 0.1, 0.4]));

  // amber windows with a dark cross frame
  const wxs = spec.w >= 5 ? [-1.6, 1.6] : [-1.2, 1.2];
  for (const sx of wxs) {
    g.add(part(UNIT_BOX, timber, [cx + sx, 0.78, fz + 0.03], [0.62, 0.58, 0.06]));
    g.add(part(UNIT_BOX, amber, [cx + sx, 0.78, fz + 0.07], [0.48, 0.44, 0.04]));
    g.add(part(UNIT_BOX, amberL, [cx + sx - 0.1, 0.86, fz + 0.09], [0.12, 0.12, 0.02]));
    g.add(part(UNIT_BOX, timber, [cx + sx, 0.78, fz + 0.1], [0.06, 0.44, 0.02]));
    g.add(part(UNIT_BOX, timber, [cx + sx, 0.78, fz + 0.1], [0.48, 0.06, 0.02]));
    g.add(part(UNIT_BOX, timberL, [cx + sx, 0.47, fz + 0.08], [0.7, 0.08, 0.14])); // sill
  }

  // roof: wide eaves, tall hipped slope facing the camera, dark trim boards and ridge cap
  const W = spec.w + 1.0, D = depth + 0.9, RH = 1.45;
  const ridgeLen = Math.max(0.6, W - 2.2), ridgeZ = -D * 0.12; // ridge sits toward the back so the front slope is large
  const roofY = WH + 0.14;
  roof.vertexColors = true;
  const rg = new THREE.Mesh(hipRoofGeometry(W, D, RH, ridgeLen, ridgeZ), roof);
  rg.position.set(cx, roofY, cz);
  g.add(rg);
  // shingle rows across the front slope: thin dark lines every ~0.3 along the slope (reads as tiled roof rows)
  const frontN = Math.atan2(RH, D / 2 - ridgeZ); // slope angle of the front face
  const slopeLen = Math.hypot(D / 2 - ridgeZ, RH);
  const rows = Math.floor(slopeLen / 0.3);
  for (let r = 1; r < rows; r++) {
    const t = r / rows;
    const z = D / 2 - (D / 2 - ridgeZ) * t, y = RH * t;
    const wid = W - (W - ridgeLen) * t - 0.16;
    const line = part(UNIT_BOX, roofD, [0, 0, 0], [wid, 0.02, 0.05]);
    line.position.set(cx, roofY + y + 0.012, cz + z + 0.008);
    line.rotation.x = -frontN;
    g.add(line);
  }
  void roofL;
  // eave trim
  g.add(part(UNIT_BOX, trim, [cx, roofY - 0.02, cz + D / 2 - 0.02], [W + 0.06, 0.12, 0.1]));
  g.add(part(UNIT_BOX, trim, [cx, roofY - 0.02, cz - D / 2 + 0.02], [W + 0.06, 0.12, 0.1]));
  for (const sx of [-1, 1]) g.add(part(UNIT_BOX, trim, [cx + sx * (W / 2 - 0.02), roofY - 0.02, cz], [0.1, 0.12, D + 0.06]));
  // ridge cap + finials
  g.add(part(UNIT_BOX, trim, [cx, roofY + RH + 0.02, cz + ridgeZ], [ridgeLen + 0.2, 0.1, 0.16]));
  for (const sx of [-1, 1]) g.add(part(UNIT_SPHERE, trim, [cx + sx * (ridgeLen / 2 + 0.08), roofY + RH + 0.06, cz + ridgeZ], [0.14, 0.14, 0.14]));
  // two round vents on the front slope
  const vt = 0.42, vz = D / 2 - (D / 2 - ridgeZ) * vt, vy = RH * vt;
  for (const sx of (spec.w >= 5 ? [-1.1, 1.1] : [-0.8, 0.8])) {
    const ring = part(UNIT_CYL, trim, [0, 0, 0], [0.4, 0.06, 0.4]);
    const hole = part(UNIT_CYL, doorD, [0, 0, 0.02], [0.26, 0.06, 0.26]);
    const grp = new THREE.Group(); grp.add(ring, hole);
    grp.position.set(cx + sx, roofY + vy + 0.03, cz + vz + 0.02);
    grp.rotation.x = Math.PI / 2 - frontN;
    g.add(grp);
  }

  if (spec.sign === 'inn') {
    const sg = new THREE.Group();
    sg.position.set(cx - spec.w / 2 + 0.5, WH - 0.02, fz + 0.3);
    sg.add(part(UNIT_BOX, timber, [0, 0, -0.15], [0.06, 0.06, 0.34]));
    sg.add(part(UNIT_BOX, toon('#3a5fd0'), [0, -0.2, 0.02], [0.52, 0.36, 0.05]));
    sg.add(part(UNIT_CYL, toon('#f7e7b7'), [0, -0.22, 0.06], [0.16, 0.2, 0.08]));   // a mug
    sg.add(part(UNIT_BOX, toon('#f7e7b7'), [0.1, -0.22, 0.06], [0.05, 0.12, 0.06]));
    g.add(sg);
  }
  // shop sign
  if (spec.sign === 'shop') {
    const sg = new THREE.Group();
    sg.position.set(cx - spec.w / 2 + 0.5, WH - 0.02, fz + 0.3);
    sg.add(part(UNIT_BOX, timber, [0, 0, -0.15], [0.06, 0.06, 0.34]));
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
      // BotW-style hedge: dense particle foliage, 3 merged bush clusters side by side
      // Uses the same puff shader as bushes, so wind animates the whole hedge
      g.add(buildHedgeFoliage());
      break;
    }
    case 'log': {
      g.add(part(UNIT_CYL, wood, [0, 0.22, 0], [0.44, 1.6, 0.44]).rotateZ(Math.PI / 2));
      g.add(part(UNIT_CYL, woodL, [0.81, 0.22, 0], [0.4, 0.02, 0.4]).rotateZ(Math.PI / 2));
      g.add(part(UNIT_CYL, woodL, [-0.81, 0.22, 0], [0.4, 0.02, 0.4]).rotateZ(Math.PI / 2));
      g.add(part(UNIT_BOX, woodD, [0.2, 0.42, 0.1], [0.3, 0.05, 0.08]));
      g.add(blobShadow(0.7));
      break;
    }
    case 'menhir': {
      const moss = toon('#5f9a4a');
      g.add(part(UNIT_BOX, stone, [0, 0.8, 0], [0.5, 1.6, 0.36]).rotateZ(0.05));
      g.add(part(UNIT_BOX, stoneD, [0.1, 1.5, 0.05], [0.42, 0.34, 0.3]).rotateZ(-0.2));
      g.add(part(UNIT_BOX, moss, [-0.12, 0.25, 0.14], [0.26, 0.4, 0.1]));
      g.add(part(UNIT_BOX, stoneD, [0.08, 0.9, 0.19], [0.14, 0.05, 0.02]));
      g.add(part(UNIT_BOX, stoneD, [0.08, 1.1, 0.19], [0.14, 0.05, 0.02]));
      g.add(blobShadow(0.36));
      break;
    }
    case 'cart': {
      g.add(part(UNIT_BOX, woodL, [0, 0.5, 0], [1.4, 0.1, 0.9]));
      for (const z of [-0.42, 0.42]) g.add(part(UNIT_BOX, wood, [0, 0.72, z], [1.4, 0.36, 0.06]));
      g.add(part(UNIT_BOX, wood, [-0.68, 0.72, 0], [0.06, 0.36, 0.9]));
      for (const x of [-0.35, 0.35]) for (const z of [-0.5, 0.5]) { g.add(part(UNIT_CYL, woodD, [x, 0.34, z], [0.68, 0.08, 0.68]).rotateX(Math.PI / 2)); g.add(part(UNIT_CYL, iron, [x, 0.34, z], [0.72, 0.03, 0.72]).rotateX(Math.PI / 2)); }
      g.add(part(UNIT_BOX, wood, [1.0, 0.42, 0.2], [0.8, 0.06, 0.06]).rotateZ(0.15));
      g.add(part(UNIT_BOX, wood, [1.0, 0.42, -0.2], [0.8, 0.06, 0.06]).rotateZ(0.15));
      for (let i = 0; i < 3; i++) g.add(part(UNIT_SPHERE, toon('#e8c86a'), [-0.3 + i * 0.3, 0.72, (i % 2) * 0.2 - 0.1], [0.34, 0.3, 0.34]));
      g.add(blobShadow(0.75));
      break;
    }
    case 'hay': {
      const hay = toon('#e8c86a'), hayD = toon('#c9a247');
      g.add(part(UNIT_CYL, hay, [0, 0.4, 0], [0.9, 0.8, 0.9]));
      g.add(part(UNIT_SPHERE, hay, [0, 0.8, 0], [0.9, 0.5, 0.9]));
      g.add(part(UNIT_BOX, hayD, [0.2, 0.5, 0.42], [0.3, 0.05, 0.06]));
      g.add(part(UNIT_BOX, hayD, [-0.25, 0.3, 0.42], [0.3, 0.05, 0.06]));
      g.add(part(UNIT_CYL, wood, [0, 1.15, 0], [0.06, 0.3, 0.06]));
      g.add(blobShadow(0.5));
      break;
    }
    case 'scarecrow': {
      g.add(part(UNIT_CYL, wood, [0, 0.7, 0], [0.08, 1.4, 0.08]));
      g.add(part(UNIT_BOX, wood, [0, 1.15, 0], [1.1, 0.07, 0.07]));
      g.add(part(UNIT_BOX, toon('#8a5aa8'), [0, 1.0, 0], [0.5, 0.5, 0.3]));
      g.add(part(UNIT_SPHERE, toon('#e8c86a'), [0, 1.42, 0], [0.34, 0.34, 0.34]));
      g.add(part(UNIT_CYL, toon('#6b4a2c'), [0, 1.6, 0], [0.7, 0.05, 0.7]));
      g.add(part(UNIT_CONE, toon('#6b4a2c'), [0, 1.72, 0], [0.4, 0.26, 0.4]));
      g.add(part(UNIT_BOX, toon('#1d2b5a'), [-0.07, 1.44, 0.17], [0.05, 0.05, 0.02]));
      g.add(part(UNIT_BOX, toon('#1d2b5a'), [0.07, 1.44, 0.17], [0.05, 0.05, 0.02]));
      g.add(blobShadow(0.25));
      break;
    }
    case 'campfire': {
      for (const a of [0, 1.05, 2.1, 3.15, 4.2, 5.25]) g.add(part(UNIT_SPHERE, stoneD, [Math.cos(a) * 0.42, 0.08, Math.sin(a) * 0.42], [0.22, 0.16, 0.22]));
      g.add(part(UNIT_CYL, woodD, [0, 0.1, 0], [0.1, 0.7, 0.1]).rotateZ(Math.PI / 2).rotateY(0.6));
      g.add(part(UNIT_CYL, woodD, [0, 0.12, 0], [0.1, 0.7, 0.1]).rotateZ(Math.PI / 2).rotateY(-0.7));
      const fire = toon('#ff9a2e'); fire.emissive.set('#ff6a00'); fire.emissiveIntensity = 0.9;
      const fireIn = toon('#ffe066'); fireIn.emissive.set('#ffd040'); fireIn.emissiveIntensity = 1;
      const f = part(UNIT_CONE, fire, [0, 0.36, 0], [0.4, 0.55, 0.4]); f.name = 'flame'; g.add(f);
      g.add(part(UNIT_CONE, fireIn, [0.02, 0.3, 0.02], [0.22, 0.34, 0.22]));
      g.add(part(UNIT_CYL, toon('#2a2a2a'), [0, 0.03, 0], [0.7, 0.04, 0.7]));
      break;
    }
    case 'tent': {
      const cloth = toon('#4a5a8c'), clothD = toon('#2f3b62');
      g.add(part(UNIT_PYRAMID, cloth, [0, 0.55, 0], [1.9, 1.1, 1.9]).rotateY(Math.PI / 4));
      g.add(part(UNIT_BOX, clothD, [0, 0.35, 0.72], [0.5, 0.7, 0.2]));
      g.add(part(UNIT_CYL, woodD, [0, 1.15, 0], [0.06, 0.3, 0.06]));
      g.add(part(UNIT_BOX, toon('#c82828'), [0.06, 1.25, 0], [0.14, 0.1, 0.02]));
      g.add(blobShadow(1.0));
      break;
    }
    case 'banner': {
      g.add(part(UNIT_CYL, woodD, [0, 1.0, 0], [0.07, 2.0, 0.07]));
      g.add(part(UNIT_SPHERE, gold, [0, 2.02, 0], [0.12, 0.12, 0.12]));
      g.add(part(UNIT_BOX, toon('#8c2a2a'), [0.24, 1.55, 0], [0.42, 0.75, 0.03]));
      g.add(part(UNIT_BOX, toon('#f2c14e'), [0.24, 1.6, 0.02], [0.14, 0.14, 0.02]));
      g.add(part(UNIT_BOX, toon('#5a1a1a'), [0.24, 1.14, 0], [0.42, 0.08, 0.03]));
      g.add(part(UNIT_CYL, stoneD, [0, 0.04, 0], [0.34, 0.08, 0.34]));
      break;
    }
    case 'tower': {
      const moss = toon('#5f9a4a');
      g.add(part(UNIT_CYL, stone, [0, 1.2, 0], [2.4, 2.4, 2.4]));
      g.add(part(UNIT_CYL, stoneD, [0, 0.15, 0], [2.6, 0.3, 2.6]));
      // broken crenellated top
      for (const a of [0, 0.9, 1.8, 3.4, 4.3, 5.4]) g.add(part(UNIT_BOX, stone, [Math.cos(a) * 1.1, 2.55 + ((a * 7) % 3) * 0.1, Math.sin(a) * 1.1], [0.36, 0.5 + ((a * 5) % 2) * 0.3, 0.36]).rotateY(-a));
      g.add(part(UNIT_BOX, stoneD, [0, 1.1, 1.21], [0.5, 0.9, 0.08]));   // doorway
      g.add(part(UNIT_BOX, toon('#1a1a22'), [0, 1.0, 1.24], [0.34, 0.7, 0.04]));
      g.add(part(UNIT_BOX, toon('#1a1a22'), [0.9, 1.9, 0.8], [0.18, 0.3, 0.04]).rotateY(-0.7));
      g.add(part(UNIT_BOX, moss, [-0.9, 0.6, 0.7], [0.4, 0.8, 0.14]).rotateY(0.9));
      g.add(part(UNIT_BOX, moss, [0.7, 0.4, -0.9], [0.5, 0.5, 0.14]).rotateY(2.4));
      // fallen stones
      g.add(part(UNIT_BOX, stone, [1.7, 0.18, 0.9], [0.4, 0.36, 0.34]).rotateY(0.4));
      g.add(part(UNIT_BOX, stoneD, [-1.5, 0.15, 1.2], [0.36, 0.3, 0.3]).rotateY(0.9));
      g.add(blobShadow(1.35));
      break;
    }
    case 'ruinwall': {
      const moss = toon('#5f9a4a');
      g.add(part(UNIT_BOX, stone, [0, 0.4, 0], [1.9, 0.8, 0.4]));
      g.add(part(UNIT_BOX, stone, [-0.55, 0.95, 0], [0.8, 0.4, 0.4]));
      g.add(part(UNIT_BOX, stoneD, [0.5, 0.85, 0], [0.5, 0.2, 0.4]));
      g.add(part(UNIT_BOX, stoneD, [0, 0.3, 0.21], [1.9, 0.04, 0.02]));
      g.add(part(UNIT_BOX, stoneD, [0, 0.55, 0.21], [1.9, 0.04, 0.02]));
      g.add(part(UNIT_BOX, moss, [0.5, 0.25, 0.2], [0.5, 0.4, 0.04]));
      g.add(part(UNIT_BOX, stone, [1.2, 0.14, 0.4], [0.3, 0.28, 0.28]).rotateY(0.5));
      g.add(blobShadow(0.8));
      break;
    }
    case 'pillar': {
      g.add(part(UNIT_BOX, stoneD, [0, 0.12, 0], [0.7, 0.24, 0.7]));
      g.add(part(UNIT_CYL, stone, [0, 1.0, 0], [0.46, 1.6, 0.46]));
      g.add(part(UNIT_BOX, stoneD, [0, 1.86, 0], [0.62, 0.14, 0.62]));
      g.add(part(UNIT_BOX, toon('#5f9a4a'), [0.1, 0.5, 0.22], [0.2, 0.5, 0.04]));
      g.add(blobShadow(0.36));
      break;
    }
    case 'crown': {
      // the Amber Crown on a mossy stone ledge, glowing
      g.add(part(UNIT_BOX, stone, [0, 0.3, 0], [1.4, 0.6, 1.0]));
      g.add(part(UNIT_BOX, toon('#5f9a4a'), [0, 0.61, 0], [1.3, 0.04, 0.9]));
      const amber = toon('#ffb52e'); amber.emissive.set('#ff9a00'); amber.emissiveIntensity = 0.8;
      const c = new THREE.Group(); c.name = 'spin'; c.position.y = 0.95;
      c.add(part(UNIT_CYL, gold, [0, 0, 0], [0.6, 0.18, 0.6]));
      for (const a of [0, 1.05, 2.1, 3.15, 4.2, 5.25]) { c.add(part(UNIT_BOX, gold, [Math.cos(a) * 0.27, 0.2, Math.sin(a) * 0.27], [0.1, 0.24, 0.1])); }
      c.add(part(UNIT_OCTA, amber, [0, 0.16, 0.3], [0.2, 0.26, 0.2]));
      g.add(c);
      const glow = new THREE.Mesh(UNIT_CIRCLE, new THREE.MeshBasicMaterial({ color: 0xffb040, transparent: true, opacity: 0.25, depthWrite: false }));
      glow.scale.set(3, 1, 3); glow.position.y = 0.64; g.add(glow);
      break;
    }
    case 'windmill': {
      const red = toon('#b73c3c');
      // tapered four-sided stone body
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.45, 2.4, 4).rotateY(Math.PI / 4), stone);
      body.position.y = 1.2; g.add(body);
      g.add(part(UNIT_CYL, stoneD, [0, 0.08, 0], [2.9, 0.16, 2.9]).rotateY(Math.PI / 4));
      // arched door + amber windows
      g.add(part(UNIT_BOX, woodD, [0, 0.5, 1.22], [0.55, 1.0, 0.1]));
      g.add(part(UNIT_CYL, woodD, [0, 1.0, 1.22], [0.55, 0.06, 0.55]).rotateX(Math.PI / 2));
      for (const sx of [-0.55, 0.55]) g.add(part(UNIT_BOX, toon('#f6b83c'), [sx, 1.7, 0.8], [0.26, 0.32, 0.05]));
      // conical cap
      g.add(part(UNIT_PYRAMID, red, [0, 2.9, 0], [2.0, 1.0, 2.0]));
      // hub + four rotating sails (spun about Z by the game)
      const hub = new THREE.Group(); hub.position.set(0, 2.45, 0.95); g.add(hub);
      hub.add(part(UNIT_SPHERE, woodD, [0, 0, 0.02], [0.3, 0.3, 0.3]));
      const sails = new THREE.Group(); sails.name = 'mill'; hub.add(sails);
      for (let i = 0; i < 4; i++) {
        const arm = new THREE.Group(); arm.rotation.z = i * Math.PI / 2 + Math.PI / 4;
        arm.add(part(UNIT_BOX, woodL, [0.8, 0, 0], [1.6, 0.1, 0.08]));
        arm.add(part(UNIT_BOX, toon('#f6f1e6'), [1.0, 0.45, 0], [0.42, 0.9, 0.03]));
        sails.add(arm);
      }
      g.add(blobShadow(1.5));
      break;
    }
    case 'anvil': {
      g.add(part(UNIT_BOX, woodD, [0, 0.2, 0], [0.6, 0.4, 0.42]));
      g.add(part(UNIT_BOX, iron, [0, 0.48, 0], [0.48, 0.14, 0.2]));
      g.add(part(UNIT_BOX, iron, [-0.3, 0.47, 0], [0.26, 0.12, 0.12])); // horn
      g.add(part(UNIT_BOX, iron, [0, 0.57, 0], [0.54, 0.06, 0.24])); // face
      g.add(part(UNIT_BOX, toon('#6b7382'), [0.18, 0.5, 0.05], [0.1, 0.04, 0.06])); // glint
      break;
    }
    case 'forge': {
      g.add(part(UNIT_BOX, stone, [0, 0.35, 0], [1.1, 0.7, 0.9]));
      g.add(part(UNIT_BOX, stoneD, [0, 0.08, 0], [1.24, 0.16, 1.04]));
      g.add(part(UNIT_BOX, stoneD, [0, 0.72, 0], [1.16, 0.08, 0.96]));
      // glowing fire mouth
      g.add(part(UNIT_BOX, toon('#1a1a22'), [0, 0.3, 0.46], [0.62, 0.52, 0.06]));
      const coals = toon('#ff7a1e'); coals.emissive.set('#ff5500'); coals.emissiveIntensity = 0.9;
      g.add(part(UNIT_BOX, coals, [0, 0.26, 0.49], [0.44, 0.32, 0.03]));
      // chimney pipe
      g.add(part(UNIT_CYL, iron, [0.32, 1.1, -0.25], [0.16, 1.0, 0.16]));
      g.add(part(UNIT_CYL, iron, [0.32, 1.55, -0.25], [0.26, 0.06, 0.26]));
      // hammer + tongs resting on the side
      g.add(part(UNIT_BOX, wood, [-0.72, 0.3, 0.3], [0.5, 0.05, 0.05]).rotateZ(0.9));
      g.add(part(UNIT_BOX, iron, [-0.52, 0.48, 0.3], [0.2, 0.14, 0.12]));
      break;
    }
    case 'cauldron': {
      const pot = toon('#2a2a32'), potD = toon('#1c1c24');
      for (const a of [0.5, 2.6, 4.7]) g.add(part(UNIT_BOX, potD, [Math.cos(a) * 0.28, 0.05, Math.sin(a) * 0.28], [0.1, 0.12, 0.1]));
      g.add(part(UNIT_CYL, pot, [0, 0.34, 0], [0.56, 0.44, 0.56]));
      g.add(part(UNIT_CYL, potD, [0, 0.56, 0], [0.62, 0.07, 0.62])); // rim
      const potion = toon('#5aff6a'); potion.emissive.set('#20d040'); potion.emissiveIntensity = 0.8;
      g.add(part(UNIT_CYL, potion, [0, 0.57, 0], [0.52, 0.03, 0.52])); // glowing brew
      g.add(part(UNIT_SPHERE, pot, [0.3, 0.52, 0.2], [0.08, 0.08, 0.08])); // bubble
      break;
    }
    case 'grave': {
      const moss = toon('#5f9a4a');
      g.add(part(UNIT_BOX, stoneD, [0, 0.05, 0], [0.72, 0.1, 0.5]));
      g.add(part(UNIT_BOX, stone, [0, 0.42, 0], [0.5, 0.72, 0.12]).rotateZ(0.04));
      g.add(part(UNIT_CYL, stone, [0, 0.78, 0], [0.5, 0.06, 0.12]).rotateZ(Math.PI / 2).rotateZ(0.04));
      g.add(part(UNIT_BOX, stoneD, [0, 0.45, 0.07], [0.08, 0.3, 0.02])); // carved cross
      g.add(part(UNIT_BOX, stoneD, [0, 0.55, 0.07], [0.24, 0.07, 0.02]));
      g.add(part(UNIT_BOX, moss, [-0.14, 0.12, 0.05], [0.32, 0.12, 0.07]));
      g.add(part(UNIT_BOX, moss, [0.12, 0.7, -0.02], [0.16, 0.1, 0.05]));
      break;
    }
    case 'deadtree': {
      const bark = toon('#4a3524'), barkD = toon('#3a2a1c');
      g.add(part(UNIT_CYL, bark, [0, 0.9, 0], [0.22, 1.8, 0.22]).rotateZ(0.06));
      g.add(part(UNIT_BOX, barkD, [0.5, 1.7, 0], [1.0, 0.1, 0.1]).rotateZ(0.5));
      g.add(part(UNIT_BOX, barkD, [-0.45, 1.9, 0.1], [0.9, 0.08, 0.08]).rotateZ(-0.45).rotateY(0.5));
      g.add(part(UNIT_BOX, barkD, [0.15, 1.4, -0.15], [0.7, 0.08, 0.08]).rotateZ(0.9).rotateY(-0.8));
      g.add(part(UNIT_BOX, barkD, [0.02, 2.1, 0.05], [0.06, 0.5, 0.06]).rotateZ(-0.12));
      g.add(blobShadow(0.5));
      break;
    }
    case 'reeds': {
      const leaf = toon('#4a8f3a'), leafL = toon('#69b04a'), spike = toon('#7a4a24');
      g.add(part(UNIT_CYL, toon('#8a7a4a'), [0, 0.03, 0], [0.5, 0.05, 0.5])); // wet earth
      for (let i = 0; i < 8; i++) {
        const a = i * 2.39996, r = 0.06 + (i % 3) * 0.11;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        const hgt = 0.75 + (i % 4) * 0.17;
        g.add(part(UNIT_BOX, i % 2 ? leaf : leafL, [x, hgt / 2, z], [0.045, hgt, 0.045]).rotateZ((i % 2 ? -1 : 1) * 0.09));
        if (i % 2 === 0) g.add(part(UNIT_CYL, spike, [x, hgt + 0.07, z], [0.09, 0.22, 0.09])); // cattail head
      }
      break;
    }
    case 'rosebush': {
      g.add(buildRosebushFoliage());
      break;
    }
    case 'beehive': {
      g.add(part(UNIT_CYL, wood, [0, 0.8, 0], [0.1, 1.5, 0.1]));
      g.add(part(UNIT_BOX, woodL, [0, 1.65, 0], [0.55, 0.5, 0.55]));
      g.add(part(UNIT_BOX, wood, [0, 1.92, 0], [0.6, 0.06, 0.6]));
      g.add(part(UNIT_BOX, woodD, [0, 1.5, 0.28], [0.2, 0.06, 0.02])); // entrance slit
      g.add(part(UNIT_BOX, woodL, [0.14, 1.44, 0.34], [0.28, 0.04, 0.14]).rotateZ(-0.4)); // landing board
      g.add(blobShadow(0.3));
      break;
    }
    case 'wheelbarrow': {
      g.add(part(UNIT_BOX, woodL, [0, 0.42, 0], [0.5, 0.24, 0.7]));
      g.add(part(UNIT_BOX, toon('#5a3a1e'), [0, 0.56, 0.05], [0.44, 0.1, 0.5])); // load of dirt
      g.add(part(UNIT_BOX, wood, [-0.26, 0.3, 0.05], [0.05, 0.05, 0.6]));
      g.add(part(UNIT_BOX, wood, [0.26, 0.3, 0.05], [0.05, 0.05, 0.6]));
      for (const x of [-0.16, 0.16]) g.add(part(UNIT_CYL, woodD, [x, 0.22, -0.42], [0.05, 0.5, 0.05]));
      g.add(part(UNIT_CYL, iron, [0, 0.2, 0.4], [0.4, 0.06, 0.4]).rotateX(Math.PI / 2));
      break;
    }
    case 'statue': {
      const marble = toon('#cfd2da'), marbleD = toon('#9aa0ac'), moss = toon('#5f9a4a');
      g.add(part(UNIT_BOX, marbleD, [0, 0.1, 0], [1.6, 0.2, 1.2]));
      g.add(part(UNIT_BOX, marble, [0, 0.22, 0.2], [1.5, 0.14, 1.1]));
      // seated knight
      g.add(part(UNIT_BOX, marble, [0, 0.72, -0.05], [0.5, 0.8, 0.42]));
      g.add(part(UNIT_SPHERE, marble, [0, 1.25, -0.05], [0.4, 0.44, 0.4]));
      g.add(part(UNIT_BOX, marbleD, [0, 1.18, 0.12], [0.3, 0.1, 0.2])); // visor slit
      for (const sx of [-0.24, 0.24]) g.add(part(UNIT_BOX, marble, [sx, 0.5, 0.32], [0.18, 0.5, 0.22]));
      g.add(part(UNIT_BOX, marbleD, [-0.5, 0.28, 0.05], [0.6, 0.16, 0.3])); // fallen arm
      g.add(part(UNIT_BOX, marbleD, [0.6, 0.32, 0.32], [0.5, 0.1, 0.14]).rotateZ(0.15)); // broken sword
      g.add(part(UNIT_BOX, moss, [-0.3, 0.62, 0.2], [0.18, 0.3, 0.06]));
      g.add(part(UNIT_BOX, moss, [0.25, 1.42, -0.1], [0.14, 0.1, 0.05]));
      g.add(blobShadow(0.9));
      break;
    }
    case 'mushroom': {
      const stem = toon('#e8e0c8'), cap = toon('#d04838'), spot = toon('#f6f1e6');
      const shroom = (x: number, z: number, s: number) => {
        g.add(part(UNIT_CYL, stem, [x, 0.14 * s, z], [0.14 * s, 0.28 * s, 0.14 * s]));
        g.add(part(UNIT_SPHERE, cap, [x, 0.3 * s, z], [0.34 * s, 0.22 * s, 0.34 * s]));
        g.add(part(UNIT_SPHERE, spot, [x + 0.08 * s, 0.34 * s, z + 0.05 * s], [0.08 * s, 0.06 * s, 0.08 * s]));
        g.add(part(UNIT_SPHERE, spot, [x - 0.1 * s, 0.32 * s, z - 0.04 * s], [0.07 * s, 0.05 * s, 0.07 * s]));
      };
      shroom(0, 0, 1); shroom(0.3, 0.18, 0.7); shroom(-0.24, 0.24, 0.55);
      g.add(part(UNIT_CYL, toon('#3f9a3d'), [0, 0.02, 0], [0.8, 0.04, 0.8]));
      break;
    }
    case 'amberrock': {
      // amber chunks glowing out of a grey boulder (Amber Highland)
      const amber = toon('#ffb52e'); amber.emissive.set('#ff8a00'); amber.emissiveIntensity = 0.75;
      const b = new THREE.Mesh(new THREE.IcosahedronGeometry(0.55, 0), stone);
      b.scale.set(1.5, 1, 1.3); b.position.y = 0.28; g.add(b);
      g.add(part(UNIT_SPHERE, stoneD, [0.4, 0.12, 0.35], [0.4, 0.26, 0.36]));
      g.add(part(UNIT_OCTA, amber, [0.15, 0.5, 0.28], [0.22, 0.3, 0.22]).rotateZ(-0.25));
      g.add(part(UNIT_OCTA, amber, [-0.3, 0.44, 0.2], [0.16, 0.22, 0.16]).rotateZ(0.4));
      g.add(part(UNIT_OCTA, toon('#ffd23f'), [0.05, 0.36, 0.42], [0.12, 0.18, 0.12]));
      const glow = new THREE.Mesh(UNIT_CIRCLE, new THREE.MeshBasicMaterial({ color: 0xffb040, transparent: true, opacity: 0.18, depthWrite: false }));
      glow.scale.set(2.4, 1, 2.2); glow.position.y = 0.05; g.add(glow);
      g.add(blobShadow(1.0));
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
  hat?: 'none' | 'straw' | 'cap' | 'bandana' | 'kerchief' | 'feather' | 'flower';
  hairStyle?: 'short' | 'long' | 'bald' | 'bun' | 'beard';
  scale?: number; kid?: boolean; item?: 'cane' | 'lute' | 'harp' | 'hoe' | 'broom' | 'basket';
  dress?: boolean; sash?: string;
}

export const VILLAGER_LOOKS: Record<string, VillagerLook> = {
  elder: { skin: '#f3bd92', hair: '#e8e8e8', top: '#5a3fb0', bottom: '#2d2660', hat: 'none', hairStyle: 'beard', item: 'cane' },
  shopkeeper: { skin: '#f3bd92', hair: '#4a2c14', top: '#e8e8e8', bottom: '#c82828', accent: '#f2c14e', hat: 'cap', hairStyle: 'short' },
  kid: { skin: '#f6c8a0', hair: '#f5cf46', top: '#ff8a3d', bottom: '#3a5fd0', hat: 'none', hairStyle: 'short', kid: true },
  granny: { skin: '#f0c4a0', hair: '#d8d8e0', top: '#2f8f5a', bottom: '#7a4f2a', hat: 'kerchief', hairStyle: 'bun', item: 'broom' },
  bard: { skin: '#f6c8a0', hair: '#e0703a', top: '#6f86d6', bottom: '#6f86d6', accent: '#f2e6b0', hat: 'flower', hairStyle: 'long', item: 'harp', dress: true, sash: '#e85a9a' },
  farmer: { skin: '#e8a878', hair: '#4a2c14', top: '#8ad34a', bottom: '#6b4a2c', hat: 'straw', hairStyle: 'short', item: 'hoe' },
  innkeeper: { skin: '#f3bd92', hair: '#7a3a1a', top: '#c8862a', bottom: '#5a3a2c', accent: '#f6f1e6', hat: 'none', hairStyle: 'bun' },
  smith: { skin: '#d89868', hair: '#2a1a10', top: '#5a5a66', bottom: '#3a3a3a', accent: '#8a5a2b', hat: 'bandana', hairStyle: 'beard' },
  goodwife: { skin: '#f6c8a0', hair: '#4a2c14', top: '#d05a8a', bottom: '#f0e2c0', hat: 'kerchief', hairStyle: 'long', item: 'basket' },
  boy: { skin: '#f3bd92', hair: '#3a2214', top: '#3a9ad0', bottom: '#6b4a2c', hat: 'cap', hairStyle: 'short', kid: true },
  woodcutter: { skin: '#e0a070', hair: '#3a2214', top: '#c8442e', bottom: '#3a3a3a', hat: 'none', hairStyle: 'beard', item: 'hoe' },
  miller: { skin: '#f3bd92', hair: '#d8d8e0', top: '#e8e8e8', bottom: '#8a6a3c', hat: 'cap', hairStyle: 'short', item: 'basket' },
  shepherd: { skin: '#e8a878', hair: '#c8432c', top: '#7a9ad0', bottom: '#6b4a2c', hat: 'straw', hairStyle: 'short', item: 'cane' },
  fisher: { skin: '#e8b890', hair: '#4a2c14', top: '#3a8fa0', bottom: '#2d3a60', hat: 'bandana', hairStyle: 'short', item: 'basket' },
  hermit: { skin: '#f0c4a0', hair: '#e8e8e8', top: '#6b4a2c', bottom: '#4a3a2c', hat: 'none', hairStyle: 'beard', item: 'cane' },
  squire: { skin: '#f6c8a0', hair: '#f5cf46', top: '#8c8c96', bottom: '#5a2a2a', accent: '#c82828', hat: 'cap', hairStyle: 'short' },
};

export function buildVillager(look: VillagerLook): Humanoid {
  const m = { skin: toon(look.skin), hair: toon(look.hair), top: toon(look.top), bottom: toon(look.bottom), acc: toon(look.accent ?? '#7a4f2a'), eye: toon('#1d2b5a'), boot: toon('#5a3a1e'), wood: toon('#8a5a2b') };
  const root = new THREE.Group(), body = new THREE.Group();
  root.add(body); root.add(blobShadow(0.32));
  const legL = makeLeg(0.11, m.bottom, m.boot), legR = makeLeg(-0.11, m.bottom, m.boot);
  root.add(legL, legR);
  body.add(part(UNIT_BOX, m.top, [0, 0.58, 0], [0.5, 0.42, 0.3]));
  if (look.dress) {
    // long flared skirt with a light hem band and a sash tied at the back
    body.add(part(UNIT_BOX, m.bottom, [0, 0.3, 0], [0.6, 0.26, 0.4]));
    body.add(part(UNIT_BOX, m.bottom, [0, 0.14, 0], [0.66, 0.1, 0.46]));
    body.add(part(UNIT_BOX, m.acc, [0, 0.09, 0], [0.68, 0.05, 0.48]));
    body.add(part(UNIT_BOX, m.acc, [0, 0.76, 0.14], [0.3, 0.06, 0.04])); // collar
    if (look.sash) { const sm = toon(look.sash); body.add(part(UNIT_BOX, sm, [0, 0.47, 0], [0.54, 0.07, 0.34])); body.add(part(UNIT_BOX, sm, [0, 0.36, -0.2], [0.26, 0.28, 0.08])); body.add(part(UNIT_BOX, sm, [-0.1, 0.24, -0.22], [0.08, 0.28, 0.05])); body.add(part(UNIT_BOX, sm, [0.1, 0.24, -0.22], [0.08, 0.28, 0.05])); }
  } else {
    body.add(part(UNIT_BOX, m.bottom, [0, 0.37, 0], [0.54, 0.12, 0.34]));
    body.add(part(UNIT_BOX, m.acc, [0, 0.47, 0], [0.52, 0.05, 0.32]));
  }
  body.add(part(UNIT_BOX, m.skin, [0, 0.8, 0], [0.16, 0.08, 0.14]));
  const { arm: armR, hand: handR } = makeArm(-0.3, look.dress ? m.skin : m.top, m.skin);
  const { arm: armL, hand: handL } = makeArm(0.3, look.dress ? m.skin : m.top, m.skin);
  if (look.dress) { armR.add(part(UNIT_BOX, m.top, [0, 0.02, 0], [0.16, 0.14, 0.18])); armL.add(part(UNIT_BOX, m.top, [0, 0.02, 0], [0.16, 0.14, 0.18])); } // short puff sleeves
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
  if (hs === 'long') {
    // fringe across the forehead, a thicker crown, long side locks and a back curtain down to the shoulders
    head.add(part(UNIT_BOX, m.hair, [0, 0.1, 0.2], [0.56, 0.16, 0.2]));
    head.add(part(UNIT_BOX, m.hair, [0, 0.05, 0.25], [0.44, 0.1, 0.1]));
    head.add(part(UNIT_SPHERE, m.hair, [0, 0.08, -0.04], [0.72, 0.42, 0.62]));
    head.add(part(UNIT_BOX, m.hair, [-0.3, -0.14, 0.02], [0.12, 0.52, 0.34]));
    head.add(part(UNIT_BOX, m.hair, [0.3, -0.14, 0.02], [0.12, 0.52, 0.34]));
    head.add(part(UNIT_BOX, m.hair, [0, -0.22, -0.24], [0.6, 0.6, 0.14]));
  }
  if (hs === 'bun') { head.add(part(UNIT_SPHERE, m.hair, [0, 0.22, -0.12], [0.3, 0.26, 0.3])); }
  if (hs === 'beard') { head.add(part(UNIT_BOX, m.hair, [0, -0.2, 0.18], [0.36, 0.3, 0.16])); head.add(part(UNIT_BOX, m.hair, [0, -0.36, 0.14], [0.24, 0.18, 0.12])); head.add(part(UNIT_BOX, m.hair, [0, -0.14, 0.24], [0.42, 0.06, 0.06])); }
  switch (look.hat) {
    case 'straw': head.add(part(UNIT_CYL, toon('#e8c86a'), [0, 0.16, 0], [1.05, 0.05, 1.0])); head.add(part(UNIT_CYL, toon('#e8c86a'), [0, 0.28, 0], [0.56, 0.22, 0.52])); head.add(part(UNIT_CYL, toon('#c82828'), [0, 0.2, 0], [0.58, 0.05, 0.54])); break;
    case 'cap': head.add(part(UNIT_HEMI, m.acc, [0, 0.06, 0], [0.7, 0.4, 0.6])); head.add(part(UNIT_BOX, m.acc, [0, 0.08, 0.3], [0.5, 0.04, 0.28])); break;
    case 'kerchief': head.add(part(UNIT_HEMI, toon('#e04545'), [0, 0.04, -0.02], [0.72, 0.46, 0.62])); head.add(part(UNIT_BOX, toon('#e04545'), [0, -0.1, -0.3], [0.3, 0.3, 0.1])); break;
    case 'bandana': head.add(part(UNIT_CYL, toon('#e04545'), [0, 0.12, 0], [0.7, 0.1, 0.6])); break;
    case 'feather': head.add(part(UNIT_HEMI, toon('#2f8f5a'), [0, 0.1, 0], [0.66, 0.42, 0.58])); head.add(part(UNIT_BOX, toon('#f6f1e6'), [0.24, 0.32, -0.08], [0.06, 0.4, 0.12]).rotateZ(-0.5)); break;
    case 'flower': { // red hibiscus over the right ear
      const red = toon('#e83a3a'), yel = toon('#f8d848');
      for (const a of [0, 1.26, 2.51, 3.77, 5.03]) head.add(part(UNIT_SPHERE, red, [0.3 + Math.cos(a) * 0.0, 0.06 + Math.sin(a) * 0.09, 0.02 + Math.cos(a) * 0.09], [0.06, 0.11, 0.11]));
      head.add(part(UNIT_SPHERE, yel, [0.34, 0.06, 0.02], [0.05, 0.06, 0.06]));
      head.add(part(UNIT_BOX, toon('#2f8f5a'), [0.3, -0.02, -0.08], [0.04, 0.06, 0.14]));
      break;
    }
  }
  // held item
  switch (look.item) {
    case 'cane': handR.add(part(UNIT_CYL, m.wood, [0, -0.25, 0.05], [0.05, 0.75, 0.05])); handR.add(part(UNIT_SPHERE, toon('#f2c14e'), [0, 0.1, 0.05], [0.12, 0.12, 0.12])); break;
    case 'lute': { const l = new THREE.Group(); l.position.set(0.3, 0.1, 0.22); l.rotation.set(0.3, 0, -0.9); l.add(part(UNIT_SPHERE, m.wood, [0, -0.1, 0], [0.34, 0.42, 0.12])); l.add(part(UNIT_BOX, toon('#5a3a1e'), [0, 0.28, 0.02], [0.08, 0.5, 0.05])); l.add(part(UNIT_CYL, toon('#2a1a10'), [0, -0.08, 0.06], [0.12, 0.02, 0.12]).rotateX(Math.PI / 2)); handL.add(l); break; }
    case 'harp': { // small lyre-harp held upright in front of the chest (attached to the body so it stays centred)
      const h = new THREE.Group(); h.position.set(0.04, 0.5, 0.4); h.rotation.set(-0.15, 0.25, 0.12);
      h.add(part(UNIT_BOX, m.wood, [0, -0.22, 0], [0.34, 0.08, 0.06]));                       // base
      h.add(part(UNIT_BOX, m.wood, [-0.15, 0.02, 0], [0.06, 0.5, 0.06]));                       // left post
      h.add(part(UNIT_BOX, m.wood, [0.15, 0.06, 0], [0.06, 0.58, 0.06]).rotateZ(-0.15));        // right post (curved)
      h.add(part(UNIT_BOX, m.wood, [0, 0.28, 0], [0.34, 0.06, 0.06]));                          // yoke
      for (const x of [-0.09, -0.03, 0.03, 0.09]) h.add(part(UNIT_BOX, toon('#f2c14e'), [x, 0.03, 0], [0.012, 0.44, 0.012]));
      body.add(h);
      break;
    }
    case 'hoe': handR.add(part(UNIT_CYL, m.wood, [0, 0.2, 0.05], [0.05, 1.3, 0.05])); handR.add(part(UNIT_BOX, toon('#8e8e88'), [0, 0.82, 0.16], [0.06, 0.06, 0.3])); break;
    case 'broom': handR.add(part(UNIT_CYL, m.wood, [0, -0.1, 0.05], [0.05, 1.1, 0.05])); handR.add(part(UNIT_CONE, toon('#e8c86a'), [0, -0.68, 0.05], [0.24, 0.3, 0.16]).rotateX(Math.PI)); break;
    case 'basket': handL.add(part(UNIT_CYL, toon('#c48b4f'), [0, -0.08, 0.1], [0.34, 0.24, 0.34])); break;
  }
  const s = look.scale ?? (look.kid ? 0.72 : 1);
  root.scale.set(CHAR_SCALE.x * s, CHAR_SCALE.y * s, CHAR_SCALE.z * s);
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

/**
 * A spitflower's energy ball: a hot yellow-green core in a translucent crackling shell. Pure
 * MeshBasicMaterial, so it reads as glowing against the toon world (the projectile update pulses
 * it as it flies).
 */
export function buildEnergyBall(): THREE.Group {
  const g = new THREE.Group();
  g.add(part(UNIT_SPHERE, new THREE.MeshBasicMaterial({ color: '#d8ff6a' }), [0, 0, 0], [0.24, 0.24, 0.24]));
  g.add(part(UNIT_SPHERE, new THREE.MeshBasicMaterial({ color: '#7ae02a', transparent: true, opacity: 0.45, depthWrite: false }), [0, 0, 0], [0.38, 0.38, 0.38]));
  return g;
}

/** Moblin throwing spear — thicker, cruder than the knight javelin, with a red cloth wrap and a broader iron head. */
export function buildMoblinSpearProjectile(): THREE.Group {
  const g = new THREE.Group();
  const shaft = part(UNIT_CYL, toon('#8a5a2b'), [0, 0, 0], [0.06, 1.1, 0.06]);
  shaft.rotation.x = Math.PI / 2;
  g.add(shaft);
  const tip = part(UNIT_CONE, toon('#d0d8e8'), [0, 0, 0.60], [0.13, 0.26, 0.06]);
  tip.rotation.x = Math.PI / 2;
  g.add(tip);
  g.add(part(UNIT_BOX, toon('#c82828'), [0, 0, 0.10], [0.07, 0.07, 0.16]));
  g.add(part(UNIT_BOX, toon('#c48b4f'), [0, 0, -0.48], [0.05, 0.05, 0.12]));
  return g;
}
