import * as THREE from 'three';
import { FACING_ANGLE, FACING_VEC, MAX_HP, clamp, inArc, lerp, normAngle, facingFrom, facingDelta, randomFacing, FACING_HALF_STEP, type Facing } from './constants';
import type { AudioEngine } from './audio';
import type { Input } from './input';
import { ATTACK_KEYS, SHIELD_KEYS } from './input';
import type { EnemyKind, Vec2, World, NpcSpec } from './world';
import type { Post, WorldSoldier } from './worldstate';
import { ACTIONS, type VillageState, type CropKind } from './village';
import {
  buildArrow, buildHeart, buildHeroine, buildJavelinProjectile, buildMoblinSpearProjectile, buildRupee, buildSoldier, part, toon,
  UNIT_BOX, UNIT_OCTA, UNIT_SPHERE, type Humanoid, buildVillager, buildDog, buildWateringCan, VILLAGER_LOOKS,
  GUST_RANGE, GUST_HALF_ARC,
} from './models';

export interface GameCtx {
  world: World;
  scene: THREE.Scene;
  audio: AudioEngine;
  player: Player;
  enemies: Enemy[];
  projectiles: Projectile[];
  rand(): number;
  spawnProjectile(kind: 'arrow' | 'javelin' | 'moblin_spear', x: number, z: number, dx: number, dz: number, dmg: number): void;
  spawnEffect(e: Effect): void;
  tryHitPlayer(dmg: number, sx: number, sz: number, opts?: { projectile?: boolean }): 'hit' | 'blocked' | 'immune';
  /** true while a dialogue box is open (player + NPCs freeze) */
  talking: boolean;
}

const angleTo = (dx: number, dz: number) => Math.atan2(dx, dz);
const easeOut = (p: number) => 1 - (1 - p) * (1 - p);

function setEmissive(mats: THREE.MeshToonMaterial[], on: boolean) {
  for (const m of mats) { m.emissive.set(on ? 0xffffff : 0x000000); m.emissiveIntensity = on ? 0.9 : 1; }
}

// ======================================================================= PLAYER
export type PlayerState = 'idle' | 'walk' | 'swing' | 'spin' | 'hurt' | 'dead';
const SWING_DUR = 0.2, SPIN_DUR = 0.5, SWING_START = -1.9, SWING_END = 1.15;
const SPIN_START = -0.35; // spin begins with the blade front-right, where the charge pose holds it
const SPIN_RADIUS = 1.75; // spin attack AoE radius (normal swing: 1.05)
const RECOVER_DUR = 0.14; // blend back to idle after an attack instead of snapping
const easeOutCubic = (p: number) => 1 - (1 - p) ** 3;
const smooth = (p: number) => p * p * (3 - 2 * p);
// quick wind-up, then a fast full circle that decelerates on the follow-through
const spinCurve = (p: number) => (p < 0.1 ? -0.12 * (p / 0.1) : -0.12 + 1.12 * easeOutCubic((p - 0.1) / 0.9));

/** Upper-body pose used to blend attack poses back into idle */
interface Pose { rootYaw: number; twist: number; lean: number; armX: number; armY: number; armZ: number; wrist: number; armLX: number; armLY: number; armLZ: number }
const lerpPose = (a: Pose, b: Pose, t: number): Pose => ({
  rootYaw: lerp(a.rootYaw, b.rootYaw, t), twist: lerp(a.twist, b.twist, t), lean: lerp(a.lean, b.lean, t),
  armX: lerp(a.armX, b.armX, t), armY: lerp(a.armY, b.armY, t), armZ: lerp(a.armZ, b.armZ, t), wrist: lerp(a.wrist, b.wrist, t),
  armLX: lerp(a.armLX, b.armLX, t), armLY: lerp(a.armLY, b.armLY, t), armLZ: lerp(a.armLZ, b.armLZ, t),
});

export class Player {
  pos: Vec2;
  facing: Facing = 0;
  hp = MAX_HP;
  rupees = 0;
  kills = 0;
  model: Humanoid;
  state: PlayerState = 'idle';
  stateT = 0;
  invuln = 0;
  knock: Vec2 = { x: 0, z: 0 };
  animT = 0;
  blocking = false;
  chargeT = 0;
  charged = false;
  holding = false;
  deadT = 0;
  sweepPrev = 0;
  sweepCur = 0;
  sweepHit = new Set<object>();
  sweepDmg = 1;
  sweepR = 1.05;
  sweepActive = false;
  recoverT = 0;
  rootYaw = 0; // extra model yaw from the spin attack (visual only; facing/hit arcs are unaffected)
  lastPose: Pose | null = null;
  sparkle: THREE.Mesh;
  readonly HW = 0.3;
  readonly HH = 0.25;

  constructor(private game: GameCtx, x: number, z: number) {
    this.pos = { x, z };
    this.model = buildHeroine();
    this.sparkle = part(UNIT_OCTA, new THREE.MeshBasicMaterial({ color: 0xffffff }), [0, -0.68, 0], [0.18, 0.18, 0.18]);
    this.sparkle.visible = false;
    this.model.weapon!.add(this.sparkle);
    game.scene.add(this.model.root);
    this.sync();
  }

  get dead() { return this.state === 'dead'; }
  get attacking() { return this.state === 'swing' || this.state === 'spin'; }
  get facingAngle() { return FACING_ANGLE[this.facing]; }

  update(dt: number, input: Input) {
    if (this.state === 'dead') {
      this.deadT += dt;
      const r = this.model.root;
      if (this.deadT < 0.9) r.rotation.y += dt * 18;
      else { const s = Math.max(0, 1 - (this.deadT - 0.9) * 2.5); r.scale.set(s, s, s); }
      return;
    }
    this.invuln = Math.max(0, this.invuln - dt);
    this.model.root.visible = this.invuln <= 0 || Math.floor(this.invuln * 16) % 2 === 0;

    if (this.state === 'hurt') {
      this.stateT -= dt;
      this.game.world.moveBox(this.pos, this.knock.x * dt, this.knock.z * dt, this.HW, this.HH);
      const f = Math.max(0, 1 - dt * 7);
      this.knock.x *= f; this.knock.z *= f;
      if (this.stateT <= 0) this.state = 'idle';
      this.animate(false, dt);
      this.sync();
      return;
    }

    const mx = input.moveX, mz = input.moveZ;
    const attackDown = input.down(ATTACK_KEYS);
    const attackPressed = input.justPressed(ATTACK_KEYS);
    this.blocking = input.down(SHIELD_KEYS) && !this.attacking;
    let moving = false;
    this.sweepActive = false;

    if (this.attacking) {
      this.stateT += dt;
      const dur = this.state === 'swing' ? SWING_DUR : SPIN_DUR;
      const p = Math.min(1, this.stateT / dur);
      this.sweepPrev = this.sweepCur;
      this.sweepCur = this.state === 'swing' ? lerp(SWING_START, SWING_END, easeOutCubic(p)) : SPIN_START - Math.PI * 2 * spinCurve(p);
      this.sweepActive = true;
      if (p >= 1) {
        this.state = 'idle';
        this.recoverT = RECOVER_DUR;
        if (attackDown) { this.holding = true; this.chargeT = 0; this.charged = false; }
      }
    } else {
      if (attackPressed && !this.blocking) this.startSwing();
      else {
        if (this.holding) {
          if (attackDown) {
            this.chargeT += dt;
            if (!this.charged && this.chargeT >= 0.75) { this.charged = true; this.game.audio.charged(); }
          } else {
            this.holding = false;
            if (this.charged) this.startSpin();
            this.charged = false;
            this.chargeT = 0;
          }
        }
        if (!this.attacking && (mx !== 0 || mz !== 0)) {
          const speed = this.blocking ? 2.4 : 4.6;
          const len = Math.hypot(mx, mz);
          const dx = (mx / len) * speed * dt, dz = (mz / len) * speed * dt;
          this.game.world.moveBox(this.pos, dx, dz, this.HW, this.HH, speed * dt);
          // turn to the nearest allowed heading of the (world-space) move vector, with a little
          // hysteresis so a heading exactly between two facings (e.g. a diagonal) doesn't flicker
          if (facingDelta(this.facing, mx, mz) > FACING_HALF_STEP + 0.05) this.facing = facingFrom(mx, mz);
          moving = true;
          this.animT += dt * speed * 2.6;
        }
      }
    }
    this.sparkle.visible = this.charged;
    if (this.charged) { this.sparkle.rotation.y += dt * 12; const s = 0.16 + Math.sin(this.animT * 3 + this.chargeT * 20) * 0.05; this.sparkle.scale.set(s, s, s); }
    this.animate(moving, dt);
    this.sync();
  }

  private startSwing() {
    this.state = 'swing';
    this.stateT = 0;
    this.sweepPrev = this.sweepCur = SWING_START;
    this.sweepHit.clear();
    this.sweepDmg = 1;
    this.sweepR = 1.05;
    this.sweepActive = true;
    this.holding = false;
    this.charged = false;
    this.game.audio.swing();
  }

  private startSpin() {
    this.state = 'spin';
    this.stateT = 0;
    this.sweepPrev = this.sweepCur = SPIN_START;
    this.sweepHit.clear();
    this.sweepDmg = 2;
    this.sweepR = SPIN_RADIUS;
    this.sweepActive = true;
    this.game.audio.spin();
    this.game.spawnEffect(fxSpinWave(this, SPIN_DUR, SPIN_RADIUS).at(this.pos.x, this.pos.z));
  }

  /** Arc (world angles) swept by the sword since the last frame */
  getSweep(): { from: number; to: number; r: number; dmg: number; hit: Set<object> } | null {
    if (!this.sweepActive) return null;
    // the model is mirrored (left-handed), so the blade's world angle is facing - sweep
    return { from: normAngle(this.facingAngle - this.sweepPrev), to: normAngle(this.facingAngle - this.sweepCur), r: this.sweepR, dmg: this.sweepDmg, hit: this.sweepHit };
  }

  hurt(dmg: number, sx: number, sz: number) {
    if (this.dead || this.invuln > 0) return;
    this.hp = Math.max(0, this.hp - dmg);
    this.invuln = 1.1;
    this.holding = false; this.charged = false; this.chargeT = 0;
    this.pushBack(sx, sz, 7);
    this.state = 'hurt';
    this.stateT = 0.25;
    this.game.audio.hurt();
    if (this.hp <= 0) {
      this.state = 'dead';
      this.deadT = 0;
      this.model.root.visible = true;
      this.blocking = false;
    }
  }

  pushBack(sx: number, sz: number, force: number, stun = 0.12) {
    let dx = this.pos.x - sx, dz = this.pos.z - sz;
    const d = Math.hypot(dx, dz) || 1;
    dx /= d; dz /= d;
    this.knock.x = dx * force; this.knock.z = dz * force;
    if (this.state !== 'hurt' && this.state !== 'dead') { this.state = 'hurt'; this.stateT = stun; }
  }

  /**
   * A shove that doesn't hurt: a gust of wind, a shoulder from a very large insect. She's thrown
   * off her feet for `stun` seconds and anything she was charging fizzles, but she takes no damage
   * and — a shove is not a hit — no invulnerability frames either, so a real blow can follow it.
   */
  shove(sx: number, sz: number, force: number, stun = 0.22) {
    if (this.dead) return;
    this.holding = false; this.charged = false; this.chargeT = 0;
    this.pushBack(sx, sz, force, stun);
  }

  private animate(moving: boolean, dt: number) {
    const m = this.model;
    if (!this.attacking) this.recoverT = Math.max(0, this.recoverT - dt);
    const swing = moving ? Math.sin(this.animT) : 0;
    m.legL.rotation.x = swing * 0.7;
    m.legR.rotation.x = -swing * 0.7;
    m.body.position.y = moving ? Math.abs(Math.sin(this.animT)) * 0.04 : 0;
    if (m.ponytail) m.ponytail.rotation.x = (moving ? Math.sin(this.animT) * 0.2 : 0) + 0.15;
    // upper body ---------------------------------------------------------
    // The right arm stays roughly horizontal so the blade sweeps a flat arc in front of the
    // heroine (the oblique camera turns any pitch change into an apparent vertical chop).
    // Torso twist + wrist cock + a short recovery blend keep the swing from looking rigid.
    // Sword arm is held forward and slightly out (blade points ahead), pumping a bit with the stride
    // instead of trailing behind like a free-swinging arm.
    // Per-facing idle sword stance (the arm is a single rigid segment, so poses are tuned per view):
    //  down/right: sword held forward, blade ahead of her.
    //  up:         arm hangs down at her side, blade angled slightly outward.
    //  left:       the sword arm is on the far side of her body, so hold it a little forward
    //              and across so arm + blade peek out ahead of her instead of hiding behind the torso.
    const STANCE: Record<0 | 1 | 2 | 3, { x: number; y: number; z: number; w: number }> = {
      0: { x: -0.85, y: -0.35, z: 0.15, w: -0.35 },
      1: { x: -0.85, y: -0.35, z: 0.15, w: -0.35 },
      2: { x: -0.3, y: 0.0, z: -0.3, w: -0.55 },
      3: { x: -0.9, y: -0.3, z: 0.1, w: 0.0 },
    };
    const st = STANCE[(Math.round(this.facing / 2) % 4) as 0 | 1 | 2 | 3]; // diagonals borrow a cardinal stance
    const idlePose: Pose = {
      rootYaw: 0, twist: 0, lean: 0,
      armX: st.x - Math.max(0, -swing) * 0.3 + (moving ? 0.1 : 0), armY: st.y, armZ: st.z, wrist: st.w,
      armLX: -0.35 + swing * 0.3, armLY: 0.15, armLZ: -0.12, // shield arm held slightly forward so the shield clears the chest
    };
    let pose: Pose;
    if (this.state === 'swing') {
      const p = Math.min(1, this.stateT / SWING_DUR);
      const e = easeOutCubic(p);
      const twist = lerp(-0.55, 0.45, e);            // shoulders wind up to the right, follow through left
      pose = {
        rootYaw: 0, twist, lean: lerp(-0.08, 0.16, e),
        armX: -Math.PI / 2 + lerp(0.12, 0.38, e),   // slight downward tilt, stays near horizontal
        armY: this.sweepCur - twist,                 // world-space yaw == hit arc; torso does part of the work
        armZ: 0,
        wrist: lerp(-0.75, 0.5, e),                  // blade trails at the start, whips ahead at the end
        armLX: lerp(0.35, -0.25, e), armLY: lerp(0.3, -0.35, e), armLZ: -0.25,
      };
    } else if (this.state === 'spin') {
      // Whole body pirouettes: the sword arm stays locked out to the front-right and the
      // entire model (torso, legs, head) rotates so the blade sweeps the full circle.
      const p = Math.min(1, this.stateT / SPIN_DUR);
      const arc = Math.sin(p * Math.PI);
      const armY = SPIN_START;
      pose = {
        rootYaw: this.sweepCur - armY, twist: 0.25 * arc, lean: 0.14 * arc,
        armX: -Math.PI / 2 + 0.1 - 0.2 * arc, armY, armZ: 0, wrist: 0.9 * arc,   // arm extends fully, blade flung outward
        armLX: -0.9 * arc - 0.1, armLY: 0.6 * arc, armLZ: -0.4 * arc - 0.1,     // shield arm flies out for balance
      };
      m.body.position.y += arc * 0.16;                                        // small hop
      m.legL.rotation.x = -0.35 * arc; m.legR.rotation.x = 0.45 * arc;         // legs tuck during the jump-spin
    } else if (this.charged || this.holding) {
      // wind-up: shoulders coil to the right, sword pulled in across the body with the blade still pointing forward
      const t = smooth(Math.min(1, this.chargeT / 0.25));
      const tremble = this.charged ? Math.sin(this.chargeT * 45) * 0.03 : 0;
      pose = {
        rootYaw: -0.2 * t, twist: -0.3 * t + tremble, lean: 0.06 * t,
        armX: -0.85 - 0.5 * t, armY: -0.35 + 0.45 * t, armZ: 0.15 + 0.15 * t, wrist: -0.35 + 0.55 * t + tremble * 2,
        armLX: -0.2 * t + 0.1, armLY: 0.3 * t, armLZ: -0.25 * t - 0.1,
      };
    } else {
      pose = idlePose;
    }

    if (this.attacking) {
      this.lastPose = { ...pose, rootYaw: normAngle(pose.rootYaw) };
    } else if (this.recoverT > 0 && this.lastPose) {
      // ease out of the follow-through pose instead of snapping to idle
      pose = lerpPose(this.lastPose, pose, smooth(1 - this.recoverT / RECOVER_DUR));
    }

    this.rootYaw = pose.rootYaw;
    m.body.rotation.set(pose.lean, pose.twist, 0);
    m.head.rotation.y = -pose.twist * 0.6; // keep looking roughly where she's facing
    m.armR.rotation.set(pose.armX, pose.armY, pose.armZ);
    m.weapon!.rotation.set(0, 0, pose.wrist);
    if (this.blocking) {
      m.armL.rotation.set(-1.25, -0.55, 0);
      m.shield!.position.set(0, -0.02, 0.12);
      m.shield!.rotation.set(1.0, 0.45, 0);
    } else {
      m.armL.rotation.set(pose.armLX, pose.armLY, pose.armLZ);
      m.shield!.position.set(0, -0.04, 0.2);
      m.shield!.rotation.set(0, 0, 0);
    }
  }

  private sync() {
    this.model.root.position.set(this.pos.x, this.game.world.surfaceAt(this.pos.x, this.pos.z), this.pos.z);
    this.model.root.rotation.y = this.facingAngle - this.rootYaw; // mirrored model: yaw runs the other way
  }

  reset(x: number, z: number) {
    this.pos = { x, z };
    this.hp = MAX_HP; this.rupees = 0; this.kills = 0;
    this.state = 'idle'; this.stateT = 0; this.invuln = 0; this.deadT = 0; this.facing = 0;
    this.charged = false; this.holding = false; this.chargeT = 0; this.blocking = false;
    this.recoverT = 0; this.lastPose = null; this.rootYaw = 0;
    this.model.root.scale.set(1, 1, 1); this.model.root.visible = true;
    this.sync();
  }
}

// ======================================================================= ENEMY
type EState = 'patrol' | 'idle' | 'alert' | 'chase' | 'ranged' | 'windup' | 'attack' | 'recover';
interface Stats { hp: number; speed: number; chase: number; dmg: number; sight: number; range: number; attackDur: number; recover: number; cooldown: number }
const STATS: Record<EnemyKind, Stats> = {
  sword: { hp: 3, speed: 1.7, chase: 2.9, dmg: 2, sight: 6.5, range: 1.1, attackDur: 0.2, recover: 0.4, cooldown: 0.9 },
  spear: { hp: 4, speed: 1.5, chase: 2.5, dmg: 2, sight: 7, range: 1.8, attackDur: 0.24, recover: 0.45, cooldown: 1.1 },
  javelin: { hp: 2, speed: 2.1, chase: 2.5, dmg: 1, sight: 8, range: 6.5, attackDur: 0.16, recover: 0.5, cooldown: 2.2 },
  archer: { hp: 2, speed: 2.0, chase: 2.2, dmg: 1, sight: 9, range: 8.5, attackDur: 0.16, recover: 0.4, cooldown: 1.8 },
  // Moblins — LA-inspired: sword+shield bruiser with a frontal block + charge, and a spear-thrower
  moblin: { hp: 4, speed: 1.7, chase: 2.7, dmg: 2, sight: 6.8, range: 1.15, attackDur: 0.24, recover: 0.5, cooldown: 1.2 },
  moblin_spear: { hp: 3, speed: 2.0, chase: 2.6, dmg: 1, sight: 8.5, range: 7.0, attackDur: 0.20, recover: 0.6, cooldown: 2.0 },
  // The giant ladybug: a slow, lumbering beetle that never bites. Its whole attack is a gust of wind
  // out of its open shell — no damage at all (dmg 0), but it blows the heroine off her feet, so the
  // range it picks its fight at is the reach of that gust rather than the length of an arm.
  ladybug: { hp: 3, speed: 1.3, chase: 2.5, dmg: 0, sight: 7, range: 3.0, attackDur: 0.42, recover: 0.95, cooldown: 3.4 },
};

// ---- giant ladybug tuning -------------------------------------------------
/** seconds the shell takes to creak open before the clap (the whole telegraph of the attack) */
const LADYBUG_CHARGE = 1.1;
/** how far the wing covers swing open, radians */
const LADYBUG_OPEN = 1.25;
/** the shove a point-blank gust puts on the heroine (falls off with distance), tiles/second */
const GUST_PUSH = 13;

/** how far a guard on a tight post (bridge, camp) may drift from its own spot, in tiles */
const TIGHT_LEASH = 2.2;

export class Enemy {
  pos: Vec2;
  facing: Facing = 0;
  hp: number;
  model: Humanoid;
  state: EState = 'patrol';
  stateT = 1;
  dir: Vec2 = { x: 0, z: 1 };
  cooldown = 0;
  knockT = 0;
  knock: Vec2 = { x: 0, z: 0 };
  flashT = 0;
  animT = 0;
  /** seconds this soldier has existed — also ticks while standing still (animT only advances with the stride) */
  age = 0;
  alive = true;
  radius = 0.4;
  attackHit = false;
  yawPrev = 0;
  yawCur = 0;
  strafeDir = 1;
  /** the committed heading (and time left on it) this guard uses to walk back to its patch */
  detourX = 0;
  detourZ = 1;
  detourT = 0;
  /** how long to hold a freshly picked patrol heading after bumping into something */
  blockT = 0;
  fired = false;
  // Moblin shield guard (sword variant) — LA Switch remake: big shield blocks while raised, breaks after 3 hits
  moblinGuardHits = 0;
  moblinGuardBroken = 0;
  readonly st: Stats;
  readonly HW = 0.3;
  readonly HH = 0.25;

  /**
   * A materialised soldier. Every soldier belongs to a guard POST: a patch of the world it holds.
   * Left alone it wanders that patch at random — never leaving it, tight on a bridge deck and loose
   * across a wood — and its death is written back to the world state permanently. A replacement
   * marching in from off the map carries a route to follow instead (`follow`).
   */
  constructor(private game: GameCtx, public kind: EnemyKind, x: number, z: number,
    public post: Post | null = null, public memberIndex = 0) {
    this.pos = { x, z };
    this.st = STATS[kind];
    this.hp = this.st.hp;
    this.model = buildSoldier(kind);
    // a beetle is mostly shell: it presents a wider target than a soldier
    if (kind === 'ladybug') this.radius = 0.55;
    this.facing = randomFacing(game.rand());
    this.pickPatrolDir();
    game.scene.add(this.model.root);
    this.sync();
  }

  /** the world-state record behind this entity (null only for post-less enemies, e.g. tests) */
  get soldier(): WorldSoldier | null { return this.post ? this.post.members[this.memberIndex] : null; }
  /** point to march to (set by the Game every frame while this soldier walks its route in) */
  follow: Vec2 | null = null;

  get melee() { return this.kind === 'sword' || this.kind === 'spear' || this.kind === 'moblin' || this.kind === 'ladybug'; }
  get isMoblin() { return this.kind === 'moblin' || this.kind === 'moblin_spear'; }

  /**
   * The tile this guard stands watch on, taken from its own world record: a replacement inherits
   * the spot of the man it replaces, so it settles into the same place rather than joining a queue.
   */
  private get spot(): Vec2 | null {
    const m = this.soldier;
    if (m) return { x: m.hx, z: m.hz };
    return this.post ? this.post.homes[this.memberIndex] ?? null : null;
  }

  /**
   * How far outside its ground this guard is: 1 = at the limit, >1 = strayed and walking back.
   * A tight post (a bridge, a camp) measures from the guard's own spot, so the knot stays thick;
   * a spread post measures from the edge of the whole patch it holds.
   */
  private strayed(): number {
    const p = this.post;
    if (!p) return 0;
    const spot = this.spot;
    if (p.tight && spot) return Math.hypot(this.pos.x - spot.x, this.pos.z - spot.z) / TIGHT_LEASH;
    return Math.hypot((this.pos.x - p.cx) / p.rx, (this.pos.z - p.cz) / p.rz);
  }

  private pickPatrolDir() {
    const p = this.post;
    // drifting towards the edge of its ground? Turn back in early enough that it never actually
    // leaves the patch — unless that way is blocked, in which case any other heading beats
    // fixating on a tree
    if (p && this.strayed() > (p.tight ? 0.9 : 0.7)) {
      const f = facingFrom(p.cx - this.pos.x, p.cz - this.pos.z);
      const v = FACING_VEC[f];
      if (!this.blocked(v[0], v[1])) { this.dir = { x: v[0], z: v[1] }; return; }
    }
    const f = randomFacing(this.game.rand());
    this.dir = { x: FACING_VEC[f][0], z: FACING_VEC[f][1] };
  }

  /** standing on the tile it guards (within a step of it) */
  private atSpot(): boolean {
    const spot = this.spot;
    return !!spot && Math.hypot(this.pos.x - spot.x, this.pos.z - spot.z) < 0.9;
  }

  /** would a step this way be stopped dead? Keeps a guard from fixating on a blocked heading. */
  private blocked(dx: number, dz: number): boolean {
    const len = Math.hypot(dx, dz) || 1;
    return this.game.world.boxCollides(this.pos.x + (dx / len) * 0.8, this.pos.z + (dz / len) * 0.8, this.HW, this.HH);
  }

  /** walk a direction, falling back to its two axes so a guard slides along what it bumps into */
  private walkSlide(dx: number, dz: number, speed: number, dt: number): boolean {
    if (this.walk(dx, dz, speed, dt)) return true;
    if (Math.abs(dx) > 1e-6 && Math.abs(dz) > 1e-6) {
      if (this.walk(dx, 0, speed, dt)) return true;
      if (this.walk(0, dz, speed, dt)) return true;
    }
    return false;
  }

  private faceToward(dx: number, dz: number, hyst = 1) {
    // keep the current heading while it's within (hyst × half a step) of the target direction
    if (facingDelta(this.facing, dx, dz) <= FACING_HALF_STEP * hyst + 1e-6) return;
    this.facing = facingFrom(dx, dz);
  }

  private walk(dx: number, dz: number, speed: number, dt: number): boolean {
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return false;
    dx /= len; dz /= len;
    const ox = this.pos.x, oz = this.pos.z;
    this.game.world.moveBox(this.pos, dx * speed * dt, dz * speed * dt, this.HW, this.HH, speed * dt);
    // the village is a safe haven: knights never cross the fence line
    const v = this.game.world.village;
    if (this.pos.x > v.x0 - 0.5 && this.pos.x < v.x1 + 1.5 && this.pos.z > v.z0 - 0.5 && this.pos.z < v.z1 + 1.5) { this.pos.x = ox; this.pos.z = oz; return false; }
    this.faceToward(dx, dz, 1.5);
    const moved = Math.hypot(this.pos.x - ox, this.pos.z - oz);
    this.animT += moved * 9;
    return moved > speed * dt * 0.3;
  }

  private canSee(dist: number, dx: number, dz: number): boolean {
    if (dist > this.st.sight) return false;
    if (dist < 2.5) return true;
    const f = FACING_VEC[this.facing];
    return (f[0] * dx + f[1] * dz) / dist > -0.15;
  }

  private becomeAlert() {
    this.state = 'alert';
    this.stateT = 0.4;
    this.game.spawnEffect(fxAlert(this.pos.x, this.pos.z).at(this.pos.x, this.pos.z));
    this.game.audio.alert();
  }

  update(dt: number) {
    if (!this.alive) return;
    const g = this.game, p = g.player, st = this.st;
    this.age += dt;
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.flashT > 0) { this.flashT -= dt; if (this.flashT <= 0) setEmissive(this.model.materials, false); }

    if (this.knockT > 0) {
      this.knockT -= dt;
      g.world.moveBox(this.pos, this.knock.x * dt, this.knock.z * dt, this.HW, this.HH);
      const f = Math.max(0, 1 - dt * 6);
      this.knock.x *= f; this.knock.z *= f;
      this.animate(false);
      this.sync();
      return;
    }

    // Moblin Shield moblin dazed after guard breaks — stands vulnerable, shield down
    if (this.kind === 'moblin' && this.moblinGuardBroken > 0) {
      this.moblinGuardBroken = Math.max(0, this.moblinGuardBroken - dt);
      if (this.moblinGuardBroken <= 0) this.moblinGuardHits = 0;
      this.animate(false);
      this.sync();
      // can still be alerted / start chasing again once stun ends, but while dazed hold still
      if (this.moblinGuardBroken > 0) return;
    }

    const dx = p.pos.x - this.pos.x, dz = p.pos.z - this.pos.z;
    const dist = Math.hypot(dx, dz) || 0.001;
    let moving = false;

    switch (this.state) {
      case 'patrol': {
        const post = this.post;
        const tight = !!post?.tight;
        this.blockT = Math.max(0, this.blockT - dt);
        if (this.follow) {
          // a replacement marching in from off the map: walk the road to its post
          const fx = this.follow.x - this.pos.x, fz = this.follow.z - this.pos.z;
          moving = this.walkSlide(fx, fz, Math.min(st.chase, 1.6), dt);
        } else if (post && this.strayed() > (tight ? 0.6 : 0.92) && !this.atSpot()) {
          // strayed towards the edge of its ground (usually after a chase): walk back to the spot it guards,
          // following around whatever is in the way instead of grinding against it
          const spot = this.spot;
          const hx = (spot ? spot.x : post.cx) - this.pos.x, hz = (spot ? spot.z : post.cz) - this.pos.z;
          // Commit to a heading for a second or two: re-aiming every frame just shuffles the guard
          // back and forth against whatever is in the way. Blocked, it swings wide on a random side.
          this.detourT = Math.max(0, this.detourT - dt);
          if (this.detourT <= 0) {
            const len = Math.hypot(hx, hz) || 1, ux = hx / len, uz = hz / len;
            if (!this.blocked(hx, hz)) { this.detourX = ux; this.detourZ = uz; }
            else {
              const side = g.rand() < 0.5 ? 1 : -1;
              this.detourX = ux - uz * side * 1.5;
              this.detourZ = uz + ux * side * 1.5;
              if (this.blocked(this.detourX, this.detourZ)) { this.detourX = -uz * side; this.detourZ = ux * side; }
            }
            // a knot guard holds a tile, so it swings wide for less time than one crossing a patch
            this.detourT = this.blocked(this.detourX, this.detourZ) ? 0.3
              : tight ? 0.5 + g.rand() * 0.6 : 0.9 + g.rand() * 1.4;
          }
          moving = this.walkSlide(this.detourX, this.detourZ, st.speed, dt);
          this.stateT = Math.max(this.stateT, 0.5);
        } else {
          // on guard: wander its own patch at random, standing about now and then
          const out = post ? this.strayed() : 0;
          if (out > (tight ? 0.4 : 0.7) && this.blockT <= 0) {
            // walking out towards the edge of its ground: turn back in now rather than at the next
            // re-pick, which can be seconds away and several tiles further out. A knot guard turns
            // back to the tile it holds — and sooner, since it has barely any room to drift;
            // one on a wide patch turns back to the middle of it.
            const own = this.spot;
            const ax = tight && own ? own.x : post!.cx, az = tight && own ? own.z : post!.cz;
            const f = facingFrom(ax - this.pos.x, az - this.pos.z);
            const v = FACING_VEC[f];
            if (!this.blocked(v[0], v[1]) && this.dir.x * v[0] + this.dir.z * v[1] < 0.5) {
              this.dir = { x: v[0], z: v[1] };
              this.blockT = tight ? 0.35 + g.rand() * 0.35 : 0.7 + g.rand() * 0.7;
            }
          }
          moving = this.walkSlide(this.dir.x, this.dir.z, st.speed * (tight ? 0.45 : 0.8), dt);
          this.stateT -= dt;
          if (!moving) {
            // ran into something: pick another way, but hold it a moment so it doesn't jitter in place
            if (this.blockT <= 0) { this.pickPatrolDir(); this.blockT = 0.4 + g.rand() * 0.6; }
          } else if (this.stateT <= 0) {
            this.pickPatrolDir();
            const idleP = tight ? 0.62 : 0.3;
            if (g.rand() < idleP) { this.state = 'idle'; this.stateT = (tight ? 1.6 : 0.5) + g.rand() * (tight ? 3.4 : 1); }
            else this.stateT = 1 + g.rand() * 2;
          }
        }
        if (!p.dead && this.canSee(dist, dx, dz)) this.becomeAlert();
        break;
      }
      case 'idle': {
        this.stateT -= dt;
        if (this.stateT <= 0) { this.state = 'patrol'; this.pickPatrolDir(); this.stateT = 1 + g.rand() * 2; }
        if (!p.dead && this.canSee(dist, dx, dz)) this.becomeAlert();
        break;
      }
      case 'alert': {
        this.faceToward(dx, dz);
        this.stateT -= dt;
        if (this.stateT <= 0) this.state = this.melee ? 'chase' : 'ranged';
        break;
      }
      case 'chase': {
        if (p.dead || dist > 11) { this.state = 'patrol'; this.stateT = 1; break; }
        if (dist <= st.range && this.cooldown <= 0) {
          this.state = 'windup';
          if (this.kind === 'sword') this.stateT = 0.22;
          else if (this.kind === 'moblin') this.stateT = 0.32; // pig lifts cleaver overhead like Switch remake wind-up
          else if (this.kind === 'ladybug') this.stateT = LADYBUG_CHARGE; // the shell has to come all the way open first
          else this.stateT = 0.3;
          // the beetle's wind-up is the loudest thing about it: the wing covers scrape open
          if (this.kind === 'ladybug') g.audio.wingCharge(LADYBUG_CHARGE);
          this.faceToward(dx, dz);
          break;
        }
        moving = this.walk(dx, dz, st.chase, dt);
        break;
      }
      case 'ranged': {
        if (p.dead || dist > 13) { this.state = 'patrol'; this.stateT = 1; break; }
        if (this.kind === 'javelin' || this.kind === 'moblin_spear') {
          if (dist < 2.8) moving = this.walk(-dx, -dz, st.chase, dt);
          else if (dist > 5.5) moving = this.walk(dx, dz, st.chase, dt);
          else {
            moving = this.walk(-dz * this.strafeDir, dx * this.strafeDir, st.speed * 0.6, dt);
            if (!moving) this.strafeDir *= -1;
            this.faceToward(dx, dz);
          }
          if (this.cooldown <= 0 && dist < st.range && dist > 1.5) {
            this.state = 'windup';
            this.stateT = this.kind === 'moblin_spear' ? 0.45 : 0.4; // LA spear moblin overhead wind-up
            this.faceToward(dx, dz);
          }
        } else {
          const ax = Math.abs(dx), az = Math.abs(dz);
          const aligned = ax < 0.45 || az < 0.45;
          if (dist < 2.2) moving = this.walk(-dx, -dz, st.chase, dt);
          else if (aligned) {
            this.faceToward(dx, dz, 1.5);
            if (this.cooldown <= 0 && dist < st.range) { this.state = 'windup'; this.stateT = 0.45; }
          } else {
            if (ax < az) moving = this.walk(Math.sign(dx), 0, st.speed, dt); else moving = this.walk(0, Math.sign(dz), st.speed, dt);
            if (!moving) moving = ax < az ? this.walk(0, Math.sign(dz), st.speed, dt) : this.walk(Math.sign(dx), 0, st.speed, dt);
          }
        }
        break;
      }
      case 'windup': {
        this.stateT -= dt;
        // Once a ladybug's shell is fully open the gust is going where it was pointed: the last
        // stretch of the charge stops tracking her, so the cone on the floor stops following her too
        // and stepping out of it is a real answer to the wind.
        const committed = this.kind === 'ladybug' && this.stateT < LADYBUG_CHARGE * 0.45;
        if (this.kind !== 'archer' && !committed) this.faceToward(dx, dz);
        if (this.stateT <= 0) {
          this.state = 'attack'; this.stateT = 0; this.attackHit = false; this.fired = false; this.yawPrev = this.yawCur = -1.7;
          if (this.kind === 'sword' || this.kind === 'moblin') g.audio.swing();
          else if (this.kind === 'spear' || this.kind === 'moblin_spear') g.audio.throwJav();
        }
        break;
      }
      case 'attack': {
        this.stateT += dt;
        this.doAttack(dt, dx, dz, dist);
        if (this.stateT >= st.attackDur) { this.state = 'recover'; this.stateT = st.recover; this.cooldown = st.cooldown; }
        break;
      }
      case 'recover': {
        this.stateT -= dt;
        if (this.stateT <= 0) { this.state = this.melee ? 'chase' : 'ranged'; if (this.model.weapon) this.model.weapon.visible = true; }
        break;
      }
    }
    this.animate(moving);
    this.sync();
  }

  private doAttack(dt: number, dx: number, dz: number, dist: number) {
    const g = this.game, st = this.st, p = g.player;
    const fa = FACING_ANGLE[this.facing];
    const fv = FACING_VEC[this.facing];
    if (this.kind === 'sword') {
      const pr = Math.min(1, this.stateT / st.attackDur);
      this.yawPrev = this.yawCur;
      this.yawCur = lerp(-1.7, 1.2, easeOut(pr));
      if (!this.attackHit && !p.dead && dist < 0.95 + 0.35 && inArc(angleTo(dx, dz), normAngle(fa + this.yawPrev), normAngle(fa + this.yawCur), 0.35)) {
        this.attackHit = true;
        if (g.tryHitPlayer(st.dmg, this.pos.x, this.pos.z) === 'blocked') this.recoil();
      }
    } else if (this.kind === 'moblin') {
      // LA sword moblin: broad cleaver sweep with a short charge step forward (Switch remake)
      if (this.stateT < 0.14) g.world.moveBox(this.pos, fv[0] * 2.8 * dt, fv[1] * 2.8 * dt, this.HW, this.HH);
      const pr = Math.min(1, this.stateT / st.attackDur);
      this.yawPrev = this.yawCur;
      this.yawCur = lerp(-1.6, 1.25, easeOut(pr));
      if (!this.attackHit && !p.dead && dist < 1.0 + 0.4 && inArc(angleTo(dx, dz), normAngle(fa + this.yawPrev), normAngle(fa + this.yawCur), 0.42)) {
        this.attackHit = true;
        if (g.tryHitPlayer(st.dmg, this.pos.x, this.pos.z) === 'blocked') this.recoil();
      }
    } else if (this.kind === 'spear') {
      if (this.stateT < 0.12) g.world.moveBox(this.pos, fv[0] * 3 * dt, fv[1] * 3 * dt, this.HW, this.HH);
      if (!this.attackHit && !p.dead) {
        // distance from player to thrust segment
        const L = 1.75;
        const t = Math.max(0, Math.min(L, dx * fv[0] + dz * fv[1]));
        const cx = fv[0] * t, cz = fv[1] * t;
        if (Math.hypot(dx - cx, dz - cz) < 0.45) {
          this.attackHit = true;
          if (g.tryHitPlayer(st.dmg, this.pos.x, this.pos.z) === 'blocked') this.recoil();
        }
      }
    } else if (this.kind === 'javelin') {
      if (!this.fired && this.stateT > 0.05) {
        this.fired = true;
        const inv = 1 / dist;
        g.spawnProjectile('javelin', this.pos.x + dx * inv * 0.5, this.pos.z + dz * inv * 0.5, dx * inv, dz * inv, st.dmg);
        g.audio.throwJav();
        if (this.model.weapon) this.model.weapon.visible = false;
      }
    } else if (this.kind === 'moblin_spear') {
      // LA spear moblin: single heavy throw, spear visible until release
      if (!this.fired && this.stateT > 0.08) {
        this.fired = true;
        const inv = 1 / dist;
        g.spawnProjectile('moblin_spear', this.pos.x + dx * inv * 0.5, this.pos.z + dz * inv * 0.5, dx * inv, dz * inv, st.dmg);
        g.audio.throwJav();
        if (this.model.weapon) this.model.weapon.visible = false;
      }
    } else if (this.kind === 'ladybug') {
      // the wing-clap: one gust, thrown a moment into the flap
      if (!this.fired && this.stateT > 0.07) {
        this.fired = true;
        this.gust();
      }
    } else {
      if (!this.fired) {
        this.fired = true;
        g.spawnProjectile('arrow', this.pos.x + fv[0] * 0.5, this.pos.z + fv[1] * 0.5, fv[0], fv[1], st.dmg);
        g.audio.arrow();
      }
    }
  }

  /**
   * The giant ladybug's whole attack: a clap of its hindwings throws a cone of wind out of its open
   * shell. Nothing in here touches `tryHitPlayer` — the gust cannot hurt anyone. It empties the cone
   * in front of it: the heroine is picked up and set back down, other soldiers are blown off their
   * feet, and arrows in flight are turned around and sent home.
   */
  private gust() {
    const g = this.game;
    const a = FACING_ANGLE[this.facing];
    g.audio.gust();
    g.spawnEffect(fxGust(this.pos.x, this.pos.z, a, GUST_RANGE).at(this.pos.x, this.pos.z));
    // the heroine — a step closer, a harder shove; a shield braced into the wind takes some of it
    const p = g.player;
    if (!p.dead && this.inGust(p.pos.x, p.pos.z, a)) {
      const d = Math.hypot(p.pos.x - this.pos.x, p.pos.z - this.pos.z);
      p.shove(this.pos.x, this.pos.z, (GUST_PUSH / (1 + d * 0.4)) * (p.blocking ? 0.6 : 1), 0.24);
    }
    // other soldiers (and the odd fellow beetle) are blown off their feet just the same
    for (const e of g.enemies) {
      if (e === this || !e.alive || e.knockT > 0 || !this.inGust(e.pos.x, e.pos.z, a)) continue;
      let ex = e.pos.x - this.pos.x, ez = e.pos.z - this.pos.z;
      const ed = Math.hypot(ex, ez) || 1;
      ex /= ed; ez /= ed;
      e.knock = { x: ex * 9, z: ez * 9 };
      e.knockT = 0.22;
    }
    // arrows and spears in the air get turned around and blown back the way they came
    for (const pr of g.projectiles ?? []) {
      if (!pr.alive || !this.inGust(pr.pos.x, pr.pos.z, a)) continue;
      const px = pr.pos.x - this.pos.x, pz = pr.pos.z - this.pos.z;
      if (pr.dir.x * px + pr.dir.z * pz >= 0) continue; // already heading away: leave it be
      pr.dir = { x: -pr.dir.x, z: -pr.dir.z };
      pr.mesh.rotation.y = Math.atan2(pr.dir.x, pr.dir.z);
    }
  }

  /**
   * Is a point inside the gust's cone? Only what the beetle is facing gets the wind — the padding is
   * for the bulk of the thing standing there (its own radius, not the shape of the cone).
   */
  private inGust(x: number, z: number, a = FACING_ANGLE[this.facing]): boolean {
    const dx = x - this.pos.x, dz = z - this.pos.z;
    if (Math.hypot(dx, dz) > GUST_RANGE) return false;
    return Math.abs(normAngle(Math.atan2(dx, dz) - a)) <= GUST_HALF_ARC + 0.25;
  }

  private recoil() {
    const p = this.game.player;
    let dx = this.pos.x - p.pos.x, dz = this.pos.z - p.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    dx /= d; dz /= d;
    this.knock = { x: dx * 4, z: dz * 4 };
    this.knockT = 0.18;
  }

  /** returns true when the enemy died */
  hurt(dmg: number, sx: number, sz: number): boolean {
    if (!this.alive) return false;
    // Moblin Shield Guard — frontal block while shield is up (LA Switch remake: big shield halts movement and absorbs hits, breaks after 3)
    if (this.kind === 'moblin' && this.moblinGuardBroken <= 0) {
      const shieldUp = this.state !== 'windup' && this.state !== 'attack' && this.state !== 'recover' && this.knockT <= 0;
      if (shieldUp) {
        const fv = FACING_VEC[this.facing];
        let ax = sx - this.pos.x, az = sz - this.pos.z;
        const alen = Math.hypot(ax, az) || 1; ax /= alen; az /= alen;
        const dot = fv[0] * ax + fv[1] * az;
        if (dot > 0.25) {
          this.moblinGuardHits++;
          this.game.spawnEffect(fxSpark(this.pos.x + fv[0] * 0.55, 0.85, this.pos.z + fv[1] * 0.55, 0.7).at(this.pos.x, this.pos.z));
          this.flashT = 0.07;
          setEmissive(this.model.materials, true);
          // halt movement like the Switch moblins — block stops the pig dead
          this.knockT = 0.09;
          this.knock = { x: 0, z: 0 };
          if (this.moblinGuardHits >= 3) {
            this.moblinGuardBroken = 1.4;
            this.game.spawnEffect(fxPuff(this.pos.x, this.pos.z).at(this.pos.x, this.pos.z));
            this.state = 'recover';
            this.stateT = 0.25;
          }
          return false;
        }
      }
    }
    this.hp -= dmg;
    let dx = this.pos.x - sx, dz = this.pos.z - sz;
    const d = Math.hypot(dx, dz) || 1;
    dx /= d; dz /= d;
    this.knock = { x: dx * 6.5, z: dz * 6.5 };
    this.knockT = 0.22;
    this.flashT = 0.15;
    setEmissive(this.model.materials, true);
    if (this.model.weapon) this.model.weapon.visible = true;
    if (this.hp <= 0) {
      this.alive = false;
      this.game.scene.remove(this.model.root);
      return true;
    }
    this.state = this.melee ? 'chase' : 'ranged';
    this.cooldown = Math.max(this.cooldown, 0.5);
    return false;
  }

  private animate(moving: boolean) {
    const m = this.model;
    const swing = moving ? Math.sin(this.animT) : 0;
    m.legL.rotation.x = swing * 0.7;
    m.legR.rotation.x = -swing * 0.7;
    m.body.position.y = moving ? Math.abs(Math.sin(this.animT)) * 0.03 : 0;
    const k = this.kind, s = this.state;
    if (k === 'ladybug') {
      // The charge is the whole read on this enemy: the wing covers yawn open over a full second
      // while the hindwings shiver underneath, then clap hard for the gust, then fold shut again.
      let open = 0.05;              // at rest the shell sits just cracked apart
      let buzz = 0;                 // how hard the hindwings are beating (0..1)
      let tremble = 0;
      let rear = 0;                 // the body tips back as it winds up, and lunges into the clap
      if (s === 'windup') {
        const p = clamp(1 - this.stateT / LADYBUG_CHARGE, 0, 1);
        const e = easeOutCubic(p);
        open = 0.05 + e * (LADYBUG_OPEN - 0.05);
        buzz = 0.5 * e;
        tremble = Math.sin(this.age * 32) * 0.02 * p;
        rear = -0.17 * e;
      } else if (s === 'attack') {
        const p = clamp(this.stateT / this.st.attackDur, 0, 1);
        open = LADYBUG_OPEN;
        buzz = 1;
        tremble = Math.sin(this.age * 58) * 0.03 * (1 - p * 0.6);
        rear = 0.1 * (1 - p);
      } else if (s === 'recover') {
        // stateT counts down here: the shell swings shut over the recovery
        const p = clamp(this.stateT / this.st.recover, 0, 1);
        open = LADYBUG_OPEN * p;
        buzz = 0.55 * p;
        rear = -0.05 * p;
      }
      if (this.model.elytronL) this.model.elytronL.rotation.z = open + tremble;
      if (this.model.elytronR) this.model.elytronR.rotation.z = -open - tremble;
      // the hindwings lift with the shell and beat together, hard and fast, for the clap
      const beat = Math.sin(this.age * 46) * 0.5 * buzz;
      const lift = open * 0.55 + beat;
      if (this.model.hindwingL) this.model.hindwingL.rotation.z = lift;
      if (this.model.hindwingR) this.model.hindwingR.rotation.z = -lift;
      // six legs scuttling, and the shell riding up and down over them
      m.legL.rotation.x = swing * 0.22;
      m.legR.rotation.x = -swing * 0.22;
      m.body.position.y = (moving ? Math.abs(Math.sin(this.animT)) * 0.05 : 0) + 0.06 * Math.max(0, -rear * 6);
      m.body.rotation.set(rear, Math.sin(this.animT) * 0.06 * (moving ? 1 : 0), moving ? Math.sin(this.animT) * 0.05 : 0);
      // head down into the wind, antennae sweeping back out of it
      m.head.rotation.x = s === 'attack' ? 0.22 : s === 'windup' ? -0.12 : 0;
      const wave = Math.sin(this.age * 2.6) * 0.16;
      m.armL.rotation.set(-0.5 + wave - buzz * 0.5, 0, -0.5);
      m.armR.rotation.set(-0.5 - wave - buzz * 0.5, 0, 0.5);
      // the ground tell, drawn only while it is winding up
      const arc = this.model.gustArc;
      if (arc) {
        const charging = s === 'windup';
        arc.visible = charging;
        if (charging) {
          const p = clamp(1 - this.stateT / LADYBUG_CHARGE, 0, 1);
          const r = 0.4 + 0.6 * easeOutCubic(p);
          arc.scale.set(GUST_RANGE * r, 1, GUST_RANGE * r);
          (arc.material as THREE.MeshBasicMaterial).opacity = 0.28 * p;
        }
      }
    } else if (k === 'moblin') {
      // LA sword+shield brute — big shield blocks while patrolling/chasing, drops when dazed
      if (this.moblinGuardBroken > 0) {
        // dazed after shield break — wobbles, shield droops, sword hangs
        m.armR.rotation.set(0.45 + Math.sin(this.animT * 6) * 0.15, 0.2, 0.2);
        m.armL.rotation.set(0.5, 0.1, -0.35);
        m.head.rotation.z = Math.sin(this.animT * 8) * 0.22;
        m.head.rotation.x = 0.18;
        m.body.rotation.set(0.18, Math.sin(this.animT * 5) * 0.12, 0);
        if (m.shield) { m.shield.position.set(0, -0.08, 0.08); m.shield.rotation.set(0.5, 0, -0.3); }
      } else if (s === 'windup') {
        // Switch remake wind-up: pig reels back, cleaver overhead, shield braced forward (movement halts)
        m.armR.rotation.set(-Math.PI / 2 - 0.65, -1.45, 0);
        m.armL.rotation.set(-1.15, -0.45, 0.05);
        if (m.shield) { m.shield.position.set(0, -0.02, 0.18); m.shield.rotation.set(1.0, 0.2, 0); }
        m.body.rotation.set(-0.08, -0.32, 0);
        m.head.rotation.set(0, 0.15, 0);
      } else if (s === 'attack') {
        m.armR.rotation.set(-Math.PI / 2 + 0.12, this.yawCur, 0);
        m.armL.rotation.set(-0.9, -0.35, 0);
        if (m.shield) { m.shield.position.set(0, -0.03, 0.15); m.shield.rotation.set(0.7, 0.25, 0); }
        m.body.rotation.set(0.06, 0.15, 0);
      } else if (s === 'recover') {
        m.armR.rotation.set(-Math.PI / 2 + 0.4, 0.9, 0);
        m.armL.rotation.set(-0.6, -0.2, -0.1);
        if (m.shield) { m.shield.position.set(0, -0.05, 0.12); m.shield.rotation.set(0.3, 0, 0); }
      } else {
        // guard stance — shield held forward, cleaver ready at shoulder (LA: shield blocks while moving)
        const bob = moving ? 0 : Math.sin(this.animT * 2) * 0.02;
        m.armR.rotation.set(-swing * 0.25 + 0.55, -0.15, 0.1);
        m.armL.rotation.set(-1.05 + bob, -0.40, 0.02);
        if (m.shield) { m.shield.position.set(0, -0.02, 0.16); m.shield.rotation.set(0.95, 0.30, 0); }
        m.body.rotation.set(0.04, 0, 0);
        m.head.rotation.set(0, 0, 0);
      }
    } else if (k === 'moblin_spear') {
      const w = m.weapon!;
      if (s === 'windup') {
        // LA spear throw: lifts spear high overhead with a visible hold
        m.armR.rotation.set(2.55, 0, 0.25);
        w.rotation.x = -0.9;
        m.armL.rotation.set(-0.8, 0, 0.15);
        m.body.rotation.set(-0.12, -0.15, 0);
        m.head.rotation.set(-0.1, 0, 0);
      } else if (s === 'attack' || s === 'recover') {
        m.armR.rotation.set(-Math.PI / 2 + 0.35, 0, 0);
        w.rotation.x = 0;
        m.armL.rotation.set(swing * 0.25, 0, -0.1);
        m.body.rotation.set(0.05, 0.1, 0);
      } else {
        // patrol/chase — spear carried low, trot
        m.armR.rotation.set(-swing * 0.3 + 0.05, 0, 0.1);
        w.rotation.x = 0;
        m.armL.rotation.set(swing * 0.35, 0, -0.1);
        m.body.rotation.set(0, 0, 0);
        m.head.rotation.set(0, 0, 0);
      }
    } else if (k === 'sword') {
      if (s === 'windup') m.armR.rotation.set(-Math.PI / 2 - 0.5, -1.7, 0);
      else if (s === 'attack') m.armR.rotation.set(-Math.PI / 2 + 0.1, this.yawCur, 0);
      else if (s === 'recover') m.armR.rotation.set(-Math.PI / 2 + 0.4, 1.2, 0);
      else m.armR.rotation.set(-swing * 0.3 + 0.6, -0.1, 0.1);
      m.armL.rotation.set(0.1, 0, -0.1);
    } else if (k === 'spear') {
      const w = m.weapon!;
      if (s === 'windup') { m.armR.rotation.set(0.9, 0, 0); w.rotation.x = 0.4; }
      else if (s === 'attack') { m.armR.rotation.set(-Math.PI / 2, 0.35, 0); w.rotation.x = Math.PI; }
      else if (s === 'recover') { m.armR.rotation.set(-Math.PI / 2 + 0.5, 0.35, 0); w.rotation.x = Math.PI; }
      else { m.armR.rotation.set(-swing * 0.2, 0, 0.1); w.rotation.x = 0; }
      m.armL.rotation.set(swing * 0.35, 0, -0.1);
    } else if (k === 'javelin') {
      const w = m.weapon!;
      if (s === 'windup') { m.armR.rotation.set(2.4, 0, 0.3); w.rotation.x = -0.83; }
      else if (s === 'attack' || s === 'recover') { m.armR.rotation.set(-Math.PI / 2 + 0.3, 0, 0); w.rotation.x = 0; }
      else { m.armR.rotation.set(-swing * 0.3 + 0.1, 0, 0.1); w.rotation.x = 0; }
      m.armL.rotation.set(swing * 0.35, 0, -0.1);
    } else {
      m.armL.rotation.set(-Math.PI / 2, 0.15, 0);
      if (s === 'windup') m.armR.rotation.set(-Math.PI / 2 + 0.2, -0.3, 0);
      else if (s === 'attack') m.armR.rotation.set(-Math.PI / 2 + 0.7, -0.9, 0);
      else m.armR.rotation.set(-Math.PI / 2 + 0.5, -0.5, 0);
    }
  }

  private sync() {
    this.model.root.position.set(this.pos.x, this.game.world.surfaceAt(this.pos.x, this.pos.z), this.pos.z);
    this.model.root.rotation.y = FACING_ANGLE[this.facing];
  }

  dispose() {
    this.alive = false;
    this.game.scene.remove(this.model.root);
  }
}

// ======================================================================= NPC
export class Npc {
  pos: Vec2;
  home: Vec2;
  facing: Facing;
  model: Humanoid;
  animT = 0;
  t = 0;
  wanderT = 0;
  dir: Vec2 = { x: 0, z: 0 };
  bubble: THREE.Group;
  readonly isDog: boolean;
  readonly HW = 0.28;
  readonly HH = 0.24;

  constructor(protected game: GameCtx, public spec: NpcSpec) {
    this.pos = { x: spec.x, z: spec.z };
    this.home = { x: spec.x, z: spec.z };
    this.facing = ((spec.facing ?? 0) * 2) as Facing; // specs use the classic 4 directions
    this.isDog = spec.id === 'dog';
    this.model = this.isDog ? buildDog() : buildVillager(VILLAGER_LOOKS[spec.id] ?? VILLAGER_LOOKS.farmer);
    // "!" / "..." speech bubble shown when the player is close enough to talk
    this.bubble = new THREE.Group();
    const bmat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.bubble.add(part(UNIT_BOX, bmat, [0, 0, 0], [0.34, 0.3, 0.05]));
    this.bubble.add(part(UNIT_BOX, bmat, [0, -0.2, 0], [0.1, 0.12, 0.05]));
    this.bubble.add(part(UNIT_BOX, new THREE.MeshBasicMaterial({ color: 0x1d2b5a }), [0, 0.03, 0.03], [0.06, 0.16, 0.02]));
    this.bubble.add(part(UNIT_BOX, new THREE.MeshBasicMaterial({ color: 0x1d2b5a }), [0, -0.09, 0.03], [0.06, 0.05, 0.02]));
    this.bubble.position.set(0, this.isDog ? 1.0 : 1.75, 0);
    this.bubble.visible = false;
    this.model.root.add(this.bubble);
    this.wanderT = 1 + game.rand() * 2;
    game.scene.add(this.model.root);
    this.sync();
  }

  get facingAngle() { return FACING_ANGLE[this.facing]; }

  /** Can the player talk to this NPC right now? (close + roughly facing them) */
  canTalk(): boolean {
    const p = this.game.player;
    const dx = this.pos.x - p.pos.x, dz = this.pos.z - p.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > 1.25) return false;
    const f = FACING_VEC[p.facing];
    return (f[0] * dx + f[1] * dz) / (d || 1) > 0.3;
  }

  /** Turn to face the player (used when a conversation starts) */
  facePlayer() {
    const p = this.game.player;
    const dx = p.pos.x - this.pos.x, dz = p.pos.z - this.pos.z;
    this.facing = facingFrom(dx, dz);
  }

  update(dt: number, near: boolean) {
    this.t += dt;
    this.bubble.visible = near && !this.game.talking;
    if (this.bubble.visible) { this.bubble.position.y = (this.isDog ? 1.0 : 1.75) + Math.sin(this.t * 6) * 0.05; this.bubble.rotation.y = -this.facingAngle; }
    let moving = false;
    const wander = this.spec.wander ?? 0;
    if (!this.game.talking && wander > 0) {
      this.wanderT -= dt;
      if (this.wanderT <= 0) {
        if (this.dir.x || this.dir.z) { this.dir = { x: 0, z: 0 }; this.wanderT = 1 + this.game.rand() * 2.5; }
        else {
          // pick a direction that keeps us near home
          const f = randomFacing(this.game.rand());
          let dx = FACING_VEC[f][0], dz = FACING_VEC[f][1];
          const hx = this.home.x - this.pos.x, hz = this.home.z - this.pos.z;
          if (Math.hypot(hx, hz) > wander * 0.7) { if (Math.abs(hx) > Math.abs(hz)) { dx = Math.sign(hx); dz = 0; } else { dx = 0; dz = Math.sign(hz); } }
          this.dir = { x: dx, z: dz };
          this.facing = facingFrom(dx, dz);
          this.wanderT = 0.5 + this.game.rand() * 1.2;
        }
      }
      if (this.dir.x || this.dir.z) {
        const speed = this.isDog ? 2.2 : 1.1;
        const ox = this.pos.x, oz = this.pos.z;
        const nx = this.pos.x + this.dir.x * speed * dt, nz = this.pos.z + this.dir.z * speed * dt;
        // don't walk into the player, and stay within the wander radius
        const p = this.game.player;
        const blocked = Math.hypot(nx - p.pos.x, nz - p.pos.z) < 0.7 || Math.hypot(nx - this.home.x, nz - this.home.z) > wander;
        if (!blocked) this.game.world.moveBox(this.pos, this.dir.x * speed * dt, this.dir.z * speed * dt, this.HW, this.HH);
        const moved = Math.hypot(this.pos.x - ox, this.pos.z - oz);
        if (moved < speed * dt * 0.3) this.wanderT = 0; else { moving = true; this.animT += moved * 9; }
      }
    }
    this.animate(moving);
    this.sync();
  }

  protected animate(moving: boolean) {
    const m = this.model;
    const sw = moving ? Math.sin(this.animT) : 0;
    if (this.isDog) {
      m.legL.rotation.x = sw * 0.8; m.legR.rotation.x = -sw * 0.8; m.armL.rotation.x = -sw * 0.8; m.armR.rotation.x = sw * 0.8;
      const tail = m.body.getObjectByName('tail'); if (tail) tail.rotation.z = Math.sin(this.t * 9) * 0.5;
      m.body.position.y = moving ? Math.abs(Math.sin(this.animT)) * 0.05 : 0;
      return;
    }
    m.legL.rotation.x = sw * 0.6; m.legR.rotation.x = -sw * 0.6;
    m.body.position.y = moving ? Math.abs(Math.sin(this.animT)) * 0.03 : Math.sin(this.t * 2) * 0.008; // idle breathing
    const id = this.spec.id;
    if (id === 'elder') { m.armR.rotation.set(0.35, 0, 0.1); m.armL.rotation.set(0.15, 0, -0.1); m.body.rotation.x = 0.12; }
    else if (id === 'bard') { m.armL.rotation.set(-1.35, -0.45, 0.0); m.armR.rotation.set(-1.25 + Math.sin(this.t * 7) * 0.1, 0.5, 0.0); // both hands in front, cradling / plucking the harp
      m.head.rotation.z = Math.sin(this.t * 2) * 0.1; m.body.position.y += Math.abs(Math.sin(this.t * 2)) * 0.015; }
    else if (id === 'granny') { m.armR.rotation.set(0.5 + Math.sin(this.t * 3) * 0.25, 0, 0.15); m.armL.rotation.set(0.2, 0, -0.1); m.body.rotation.x = 0.18; }
    else if (id === 'farmer') { m.armR.rotation.set(moving ? -sw * 0.3 : -0.4 + Math.abs(Math.sin(this.t * 2.5)) * 0.8, 0, 0.1); m.armL.rotation.set(sw * 0.3, 0, -0.1); }
    else if (id === 'kid') { m.armL.rotation.set(-sw * 0.6 - 0.1, 0, -0.35); m.armR.rotation.set(sw * 0.6 - 0.1, 0, 0.35); m.body.position.y += moving ? 0 : Math.abs(Math.sin(this.t * 4)) * 0.03; }
    else if (id === 'shopkeeper') { m.armL.rotation.set(-1.0, 0, -0.3); m.armR.rotation.set(-1.0 + Math.sin(this.t * 1.5) * 0.1, 0, 0.3); }
    else { m.armL.rotation.set(sw * 0.4, 0, -0.1); m.armR.rotation.set(-sw * 0.4, 0, 0.1); }
  }

  protected sync() {
    this.model.root.position.set(this.pos.x, this.game.world.surfaceAt(this.pos.x, this.pos.z), this.pos.z);
    this.model.root.rotation.y = this.facingAngle;
  }
}

// ======================================================================= FARMER
const smoothstep = (a: number, b: number, t: number) => { const p = Math.min(1, Math.max(0, (t - a) / (b - a))); return p * p * (3 - 2 * p); };

/**
 * The village farmer: a live view of VillageState.farmer. The village sim owns where he is and
 * what he's doing (walking the rows, sowing, watering, pulling a ripe crop, leaning on his hoe);
 * this entity mirrors that and plays the matching animation with the hoe, the watering can and
 * whatever he just pulled out of the ground. He is still an Npc — the player can talk to him —
 * and while he is being talked to he faces her and stands easy.
 */
export class Farmer extends Npc {
  /** the hoe, re-parented into its own group so it can be swung in the hand */
  private hoe: THREE.Group;
  private can: THREE.Group;
  /** the tip of the can's spout: where the water comes out (world position via matrixWorld) */
  spout = new THREE.Object3D();
  private produce: Record<CropKind, THREE.Group>;
  private chatting = false;
  private lastX: number; private lastZ: number;

  constructor(game: GameCtx, spec: NpcSpec, private village: VillageState) {
    super(game, spec);
    const m = this.model;
    this.hoe = new THREE.Group();
    for (const c of [...m.handR.children]) if (c.type === 'Mesh') { m.handR.remove(c); this.hoe.add(c); }
    m.handR.add(this.hoe);
    this.can = buildWateringCan();
    this.can.visible = false;
    this.spout.position.set(0, -0.07, 0.28);
    this.can.add(this.spout);
    m.handL.add(this.can);
    const veg = (crop: CropKind) => {
      const g = new THREE.Group();
      if (crop === 'turnip') {
        g.add(part(UNIT_SPHERE, toon('#e8d8f0'), [0, -0.12, 0.06], [0.28, 0.24, 0.28]));
        g.add(part(UNIT_SPHERE, toon('#9a4fb8'), [0, -0.02, 0.06], [0.24, 0.14, 0.24]));
        for (const x of [-0.06, 0.04]) g.add(part(UNIT_BOX, toon('#5cbf4a'), [x, 0.1, 0.06], [0.06, 0.22, 0.06]));
      } else {
        g.add(part(UNIT_SPHERE, toon('#4faa5a'), [0, -0.08, 0.06], [0.36, 0.26, 0.36]));
        g.add(part(UNIT_SPHERE, toon('#c8e8a0'), [0, -0.03, 0.06], [0.24, 0.24, 0.24]));
      }
      g.visible = false;
      m.handL.add(g);
      return g;
    };
    this.produce = { turnip: veg('turnip'), cabbage: veg('cabbage') };
    const f = village.farmer;
    this.pos.x = f.x; this.pos.z = f.z; this.facing = f.facing;
    this.lastX = f.x; this.lastZ = f.z;
    this.sync();
  }

  facePlayer() {
    super.facePlayer();
    this.chatting = true;
  }

  update(dt: number, near: boolean) {
    this.t += dt;
    this.bubble.visible = near && !this.game.talking;
    if (this.bubble.visible) { this.bubble.position.y = 1.75 + Math.sin(this.t * 6) * 0.05; this.bubble.rotation.y = -this.facingAngle; }
    if (!this.game.talking) this.chatting = false;
    const f = this.village.farmer;
    // mirror the sim: position always; facing unless he's turned to talk to the player
    this.pos.x = f.x; this.pos.z = f.z;
    if (!this.chatting) this.facing = f.facing;
    const moved = Math.hypot(f.x - this.lastX, f.z - this.lastZ);
    this.lastX = f.x; this.lastZ = f.z;
    const moving = moved > 1e-4;
    if (moving) this.animT += moved * 9;
    this.pose(moving);
    this.sync();
  }

  private pose(moving: boolean) {
    const m = this.model, f = this.village.farmer;
    const sw = moving ? Math.sin(this.animT) : 0;
    m.legL.rotation.x = sw * 0.6; m.legR.rotation.x = -sw * 0.6;
    m.body.position.y = moving ? Math.abs(Math.sin(this.animT)) * 0.03 : Math.sin(this.t * 2) * 0.008;
    m.body.rotation.x = 0; m.head.rotation.set(0, 0, 0);
    this.can.visible = false; this.can.rotation.x = 0;
    for (const k of Object.keys(this.produce) as CropKind[]) this.produce[k].visible = false;
    // the hoe carried over the shoulder, the free hand swinging or hanging
    const carry = () => { m.armR.rotation.set(-0.5, 0, 0.15); this.hoe.rotation.x = 0; };
    const task = this.chatting ? 'idle' : f.task;
    switch (task) {
      case 'walk': carry(); m.armL.rotation.set(sw * 0.45, 0, -0.1); break;
      case 'rest': {
        // leaning on the hoe, butt on the ground, looking out over the field
        m.armR.rotation.set(-0.42, 0, 0.1); this.hoe.rotation.x = 0.18;
        m.armL.rotation.set(0.1, 0, -0.12);
        m.body.rotation.x = 0.06; m.head.rotation.y = Math.sin(this.t * 0.7) * 0.35;
        break;
      }
      case 'sow': {
        const t = f.t, a = ACTIONS.sow;
        const strike = a.marks[0].t; // the hoe bites at this moment
        if (t < strike + 0.25) {
          // wind up over the head, then bring the blade down into the soil
          const up = smoothstep(0, strike * 0.6, t), down = smoothstep(strike * 0.6, strike + 0.05, t);
          const k = up - down * 0.95;
          m.armR.rotation.set(-0.5 + (-2.6 + 0.5) * k + down * (-0.9 + 0.5), 0, 0.1);
          this.hoe.rotation.x = up * (Math.PI / 2) + down * (Math.PI / 2);
          m.body.rotation.x = -0.15 * up + 0.45 * down;
          m.armL.rotation.set(-0.3 * up, 0, -0.1);
        } else {
          // shoulder the hoe and broadcast seed with the free hand: two sweeps across the plot
          const settle = smoothstep(strike + 0.25, strike + 0.55, t);
          m.armR.rotation.set(-0.9 + (-0.5 + 0.9) * settle, 0, 0.1); this.hoe.rotation.x = Math.PI * (1 - settle);
          m.body.rotation.x = 0.45 * (1 - settle) + 0.12 * settle;
          const c0 = a.marks[1].t - 0.35, c1 = a.marks[2].t + 0.25;
          const p = Math.min(1, Math.max(0, (t - c0) / (c1 - c0)));
          const lift = smoothstep(c0 - 0.15, c0, t) * (1 - smoothstep(c1, c1 + 0.3, t));
          m.armL.rotation.set(-0.95 * lift, Math.sin(p * Math.PI * 2 - Math.PI / 2) * 0.8 * lift, -0.1 - 0.5 * lift);
        }
        break;
      }
      case 'water': {
        // ported from #20 visuals — steel/brass can comes up, tips, pours till bed soaked (visuals only)
        const a = ACTIONS.water;
        this.can.visible = true;
        this.hoe.rotation.x = 0;
        const p = a.dur > 0 ? Math.min(1, f.t / a.dur) : 1;
        const up = smooth(Math.min(1, p / 0.6));
        const tip = clamp((p - 0.58) / 0.12, 0, 1) * (1 - clamp((p - 0.9) / 0.1, 0, 1));
        m.armL.rotation.set(-0.6 - 0.9 * up, -0.35 * up, 0.1);
        m.armR.rotation.set(0.5, 0, 0.4);
        this.can.rotation.x = 1.0 * tip;
        m.body.rotation.x = 0.14 * up;
        m.head.rotation.x = 0.1 * up;
        break;
      }
      case 'harvest': {
        const t = f.t, a = ACTIONS.harvest, pull = a.marks[0].t;
        carry();
        // bend down to the plant, grip it, heave it out and hold it up
        const bend = smoothstep(0, pull * 0.6, t) * (1 - smoothstep(pull - 0.05, pull + 0.2, t));
        const hold = smoothstep(pull - 0.05, pull + 0.2, t) * (1 - smoothstep(a.dur - 0.3, a.dur, t));
        // (held out in front of the chest, not overhead: from the oblique camera an overhead hand
        // vanishes under the straw hat's brim)
        m.body.rotation.x = 0.75 * bend - 0.05 * hold;
        m.armL.rotation.set(-0.9 * bend - 1.35 * hold, 0, -0.15);
        m.armR.rotation.set(-0.5 - 0.4 * bend, 0, 0.15);
        m.head.rotation.x = -0.4 * bend;
        const crop = f.job >= 0 ? this.village.farm[f.job].crop : null;
        if (crop && t >= pull) this.produce[crop].visible = true;
        break;
      }
      default: {
        // standing easy (or chatting): hoe grounded, weight on one leg
        m.armR.rotation.set(-0.42, 0, 0.1); this.hoe.rotation.x = 0.18;
        m.armL.rotation.set(0.05, 0, -0.1);
      }
    }
  }
}

// ======================================================================= PROJECTILE
export class Projectile {
  mesh: THREE.Group;
  pos: Vec2;
  alive = true;
  life = 0;
  speed: number;
  constructor(private game: GameCtx, public kind: 'arrow' | 'javelin' | 'moblin_spear', x: number, z: number, public dir: Vec2, public dmg: number) {
    this.pos = { x, z };
    if (kind === 'arrow') this.mesh = buildArrow();
    else if (kind === 'moblin_spear') this.mesh = buildMoblinSpearProjectile();
    else this.mesh = buildJavelinProjectile();
    this.speed = kind === 'arrow' ? 9.5 : kind === 'moblin_spear' ? 7.2 : 6.5;
    this.mesh.rotation.y = Math.atan2(dir.x, dir.z);
    if (kind === 'javelin' || kind === 'moblin_spear') this.mesh.rotation.x = -0.25;
    game.scene.add(this.mesh);
    this.sync();
  }
  private y = 0;
  private sync() { this.mesh.position.set(this.pos.x, this.y, this.pos.z); }
  update(dt: number) {
    if (!this.alive) return;
    if (this.life === 0) this.y = this.game.world.surfaceAt(this.pos.x, this.pos.z) + 0.6;
    this.life += dt;
    this.pos.x += this.dir.x * this.speed * dt;
    this.pos.z += this.dir.z * this.speed * dt;
    this.sync();
    const w = this.game.world;
    const ground = w.heightAt(this.pos.x, this.pos.z);
    if (this.life > 3 || w.blocksProjectile(this.pos.x, this.pos.z) || ground > this.y - 0.1 || ground < this.y - 1.4) {
      this.game.spawnEffect(fxSpark(this.pos.x, this.y - ground - 0.1, this.pos.z, 0.5).at(this.pos.x, this.pos.z));
      this.destroy();
      return;
    }
    const p = this.game.player;
    if (!p.dead && Math.hypot(p.pos.x - this.pos.x, p.pos.z - this.pos.z) < 0.45) {
      const res = this.game.tryHitPlayer(this.dmg, this.pos.x - this.dir.x, this.pos.z - this.dir.z, { projectile: true });
      if (res !== 'immune') {
        if (res === 'blocked') this.game.spawnEffect(fxSpark(this.pos.x, 0.7, this.pos.z, 0.6).at(this.pos.x, this.pos.z));
        this.destroy();
      }
    }
  }
  destroy() { this.alive = false; this.game.scene.remove(this.mesh); }
}

// ======================================================================= PICKUP
export class Pickup {
  mesh: THREE.Group;
  t = 0;
  life = 12;
  alive = true;
  constructor(private game: GameCtx, public kind: 'heart' | 'rupee' | 'rupee5', public pos: Vec2) {
    this.mesh = kind === 'heart' ? buildHeart() : buildRupee(kind === 'rupee5');
    this.mesh.position.set(pos.x, 0.35, pos.z);
    game.scene.add(this.mesh);
  }
  update(dt: number) {
    if (!this.alive) return;
    this.t += dt; this.life -= dt;
    if (this.life <= 0) { this.destroy(); return; }
    this.mesh.position.y = this.game.world.surfaceAt(this.pos.x, this.pos.z) + 0.35 + Math.sin(this.t * 4) * 0.06;
    if (this.kind !== 'heart') this.mesh.rotation.y += dt * 3;
    this.mesh.visible = this.life > 3 || Math.floor(this.life * 10) % 2 === 0;
    const p = this.game.player;
    if (!p.dead && this.t > 0.3 && Math.hypot(p.pos.x - this.pos.x, p.pos.z - this.pos.z) < 0.6) {
      if (this.kind === 'heart') { p.hp = Math.min(MAX_HP, p.hp + 2); this.game.audio.heart(); }
      else { p.rupees = Math.min(999, p.rupees + (this.kind === 'rupee5' ? 5 : 1)); this.game.audio.rupee(); }
      this.destroy();
    }
  }
  destroy() { this.alive = false; this.game.scene.remove(this.mesh); }
}

// ======================================================================= EFFECTS
export class Effect {
  group = new THREE.Group();
  t = 0;
  /** if set, the effect group is lifted to the terrain height at this point when spawned */
  groundAt: Vec2 | null = null;
  constructor(public dur: number, private fn: (p: number, t: number, g: THREE.Group) => void) {}
  at(x: number, z: number): this { this.groundAt = { x, z }; return this; }
  update(dt: number): boolean {
    this.t += dt;
    this.fn(Math.min(1, this.t / this.dur), this.t, this.group);
    return this.t < this.dur;
  }
}

const sparkMat = new THREE.MeshBasicMaterial({ color: 0xfff2a0 });
const whiteMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
const puffMat = new THREE.MeshBasicMaterial({ color: 0xe6e6f0 });
const leafMat = new THREE.MeshBasicMaterial({ color: 0x4cb040 });
const alertMat = new THREE.MeshBasicMaterial({ color: 0xff3c3c });

export function fxSpark(x: number, y: number, z: number, size = 1): Effect {
  const core = part(UNIT_OCTA, sparkMat, [x, y, z], [0.1, 0.1, 0.1]);
  const bits: { m: THREE.Mesh; a: number }[] = [];
  const e = new Effect(0.22, (p) => {
    const s = Math.sin(p * Math.PI) * 0.7 * size;
    core.scale.set(s, s * 1.4, s);
    core.rotation.y = p * 3;
    for (const b of bits) {
      const r = p * 0.7 * size;
      b.m.position.set(x + Math.cos(b.a) * r, y + Math.sin(b.a) * r * 0.5 + p * 0.3, z + Math.sin(b.a) * r * 0.3);
      const bs = (1 - p) * 0.09;
      b.m.scale.set(bs, bs, bs);
    }
  });
  e.group.add(core);
  for (let i = 0; i < 4; i++) { const m = part(UNIT_BOX, whiteMat, [x, y, z], [0.08, 0.08, 0.08]); e.group.add(m); bits.push({ m, a: (i / 4) * Math.PI * 2 + 0.4 }); }
  return e;
}

const waveMat = new THREE.MeshBasicMaterial({ color: 0x9fe6ff, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide });
const trailMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide });
const dustMat = new THREE.MeshBasicMaterial({ color: 0xd9cfb0, transparent: true, opacity: 0.8, depthWrite: false });

/** Charge attack VFX: an expanding ground ring, a fading blade-trail arc that follows the sword, and kicked-up dust. */
export function fxSpinWave(player: { pos: Vec2; facingAngle: number; sweepCur: number; sweepR: number }, dur: number, radius: number): Effect {
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 40).rotateX(-Math.PI / 2), waveMat.clone());
  ring.position.y = 0.05;
  // Blade trail: an arc of ~75 degrees behind the sword tip. RingGeometry's theta starts on local +x; after
  // rotateX(-90deg) local +y becomes world -z, so a ring point at theta sits at world angle (atan2(x,z)) = theta + 90deg.
  const TRAIL_ARC = 1.3;
  const trail = new THREE.Mesh(new THREE.RingGeometry(0.62, 1, 16, 1, -TRAIL_ARC, TRAIL_ARC).rotateX(-Math.PI / 2), trailMat.clone());
  trail.position.y = 0.65;
  const dust: { m: THREE.Mesh; a: number; s: number }[] = [];
  const e = new Effect(dur + 0.25, (_p, t, g) => {
    const { x, z } = player.pos;
    g.position.set(x, g.position.y, z);
    // ground shockwave: expands during the spin, then fades
    const rp = Math.min(1, t / dur);
    const rr = 0.4 + easeOutCubic(rp) * radius;
    ring.scale.set(rr, 1, rr);
    (ring.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - Math.max(0, (t - dur * 0.5) / (dur * 0.5 + 0.25)));
    // (mirrored model) the sword's world angle increases during the spin, so the trail occupies [tip - TRAIL_ARC, tip]
    trail.visible = t < dur;
    if (trail.visible) {
      const tipA = player.facingAngle - player.sweepCur;
      trail.rotation.y = tipA - Math.PI / 2;
      trail.scale.set(player.sweepR, 1, player.sweepR);
      (trail.material as THREE.MeshBasicMaterial).opacity = 0.7 * Math.sin(rp * Math.PI) ** 0.5;
    }
    for (const d of dust) {
      const r = 0.45 + easeOutCubic(rp) * radius * 0.85;
      d.m.position.set(Math.cos(d.a) * r, 0.1 + Math.sin(rp * Math.PI) * d.s * 1.2, Math.sin(d.a) * r * 0.7);
      const sc = (1 - rp) * d.s;
      d.m.scale.set(sc, sc, sc);
    }
  });
  e.group.add(ring, trail);
  for (let i = 0; i < 10; i++) {
    const m = part(UNIT_SPHERE, dustMat, [0, 0, 0], [0.2, 0.2, 0.2]);
    e.group.add(m);
    dust.push({ m, a: (i / 10) * Math.PI * 2 + 0.2, s: 0.18 + (i % 3) * 0.06 });
  }
  return e;
}

export function fxPuff(x: number, z: number): Effect {
  const parts: { m: THREE.Mesh; a: number; r: number }[] = [];
  const e = new Effect(0.5, (p) => {
    for (const pt of parts) {
      const r = 0.15 + p * pt.r;
      pt.m.position.set(x + Math.cos(pt.a) * r, 0.35 + p * 0.6, z + Math.sin(pt.a) * r * 0.6);
      const s = (1 - p * p) * 0.42;
      pt.m.scale.set(s, s, s);
    }
  });
  for (let i = 0; i < 6; i++) {
    const m = part(UNIT_SPHERE, puffMat, [x, 0.35, z], [0.4, 0.4, 0.4]);
    e.group.add(m);
    parts.push({ m, a: (i / 6) * Math.PI * 2, r: 0.7 + (i % 2) * 0.3 });
  }
  return e;
}

const gustMat = new THREE.MeshBasicMaterial({ color: 0xeaf6ff, transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide });
const gustLeafMat = new THREE.MeshBasicMaterial({ color: 0x66c247, transparent: true, opacity: 0.95, depthWrite: false });

/**
 * The giant ladybug's wing-clap: a cone of wind rolling out of its open shell — a wall of air that
 * races to the full reach of the gust and fades, streaks tearing along inside it, and torn-up
 * leaves tumbling low over the ground. `angle` is the direction the beetle faces; everything here
 * is authored in a "straight ahead = +z" frame and then turned to face that way.
 */
export function fxGust(x: number, z: number, angle: number, range: number): Effect {
  const holder = new THREE.Group();
  holder.position.set(x, 0, z);
  holder.rotation.y = angle;
  const wallGeo = new THREE.CylinderGeometry(1, 1, 1, 20, 1, true, -GUST_HALF_ARC, GUST_HALF_ARC * 2);
  const walls = [0, 0.12].map((lag) => {
    const m = new THREE.Mesh(wallGeo, gustMat.clone());
    m.position.y = 0.55;
    holder.add(m);
    return { m, lag, h: 1.1 };
  });
  const streaks: { m: THREE.Mesh; a: number; y: number; sp: number }[] = [];
  for (let i = 0; i < 14; i++) {
    const a = (-0.85 + (i / 13) * 1.7) * GUST_HALF_ARC;
    const m = part(UNIT_BOX, gustMat, [0, 0, 0], [0.07, 0.05, 0.85]);
    m.rotation.y = a;
    holder.add(m);
    streaks.push({ m, a, y: 0.25 + (i % 4) * 0.3, sp: 0.8 + (i % 3) * 0.09 });
  }
  const leaves: { m: THREE.Mesh; a: number; vy: number; spin: number }[] = [];
  for (let i = 0; i < 9; i++) {
    const a = (-0.95 + (i / 8) * 1.9) * GUST_HALF_ARC + (i % 2 ? 0.12 : -0.12);
    const m = part(UNIT_BOX, i % 3 === 0 ? puffMat : gustLeafMat, [0, 0, 0], [0.13, 0.03, 0.1]);
    m.rotation.y = a;
    holder.add(m);
    leaves.push({ m, a, vy: 1.4 + (i % 3) * 0.7, spin: 6 + (i % 4) * 3 });
  }
  const e = new Effect(0.6, (p, t) => {
    for (const w of walls) {
      const wp = clamp((t - w.lag) / 0.3, 0, 1);
      // the wall of air stops dead at the reach the AI actually uses — the tell never lies
      const r = 0.5 + easeOutCubic(wp) * (range - 0.5);
      w.m.scale.set(r, w.h * (1 - 0.25 * wp), r);
      w.m.position.y = (w.h * (1 - 0.25 * wp)) / 2 + 0.08;
      (w.m.material as THREE.MeshBasicMaterial).opacity = 0.4 * (1 - wp) * (1 - p * 0.35);
      w.m.visible = wp > 0 && p < 0.95;
    }
    for (const s of streaks) {
      const r = 0.5 + easeOutCubic(p) * (range - 0.5) * s.sp;
      s.m.position.set(Math.sin(s.a) * r, s.y + p * 0.35, Math.cos(s.a) * r);
      const sc = (1 - p) * (1 + 0.5 * p);
      s.m.scale.set(0.07, 0.05, 0.85 * sc);
      (s.m.material as THREE.MeshBasicMaterial).opacity = 0.45 * (1 - p);
    }
    for (const l of leaves) {
      const r = 0.4 + easeOutCubic(p) * range * 0.8;
      l.m.position.set(Math.sin(l.a) * r, Math.max(0.05, 0.25 + l.vy * t - 5 * t * t), Math.cos(l.a) * r);
      l.m.rotation.x += 0.2;
      l.m.rotation.z += 0.15;
      l.m.rotation.y += 0.02 * l.spin;
      const ls = (1 - p * 0.5);
      l.m.scale.set(0.13 * ls, 0.03, 0.1 * ls);
    }
  });
  e.group.add(holder);
  return e;
}

export function fxLeaves(x: number, z: number): Effect {
  const parts: { m: THREE.Mesh; vx: number; vz: number; vy: number }[] = [];
  const e = new Effect(0.55, (_p, t) => {
    for (const pt of parts) {
      pt.m.position.set(x + pt.vx * t, Math.max(0.05, 0.4 + pt.vy * t - 6 * t * t), z + pt.vz * t);
      pt.m.rotation.x += 0.2; pt.m.rotation.z += 0.15;
    }
  });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.3;
    const m = part(UNIT_BOX, leafMat, [x, 0.4, z], [0.12, 0.03, 0.1]);
    e.group.add(m);
    parts.push({ m, vx: Math.cos(a) * (1.2 + (i % 3) * 0.4), vz: Math.sin(a) * (1.2 + (i % 2) * 0.4), vy: 2 + (i % 3) * 0.6 });
  }
  return e;
}

// ---- farm effects (the visible moments of the village sim's farmer)
const seedMat = new THREE.MeshBasicMaterial({ color: 0xe8d8a0 });
const dropMat = new THREE.MeshBasicMaterial({ color: 0x8ec0f5, transparent: true, opacity: 0.85, depthWrite: false });
const soilMat = new THREE.MeshBasicMaterial({ color: 0x7a5230 });
const wetMat = new THREE.MeshBasicMaterial({ color: 0x3a2a18, transparent: true, opacity: 0.35, depthWrite: false });

/** a handful of seed cast from a hand toward the plot, bouncing to rest in the furrows */
export function fxSeeds(hx: number, hy: number, hz: number, tx: number, tz: number, rand: () => number): Effect {
  const parts: { m: THREE.Mesh; x0: number; z0: number; vx: number; vz: number; vy: number; land: number }[] = [];
  const e = new Effect(0.7, (_p, t) => {
    for (const s of parts) {
      const tt = Math.min(t, s.land);
      const y = hy + s.vy * tt - 7 * tt * tt;
      // after landing: settle on the soil, a tiny hop
      const rest = t > s.land ? Math.max(0, Math.sin((t - s.land) * 14) * 0.03 * (1 - (t - s.land) * 2)) : 0;
      s.m.position.set(s.x0 + s.vx * tt, Math.max(0.012, t > s.land ? 0.012 + rest : y), s.z0 + s.vz * tt);
      s.m.rotation.x += 0.3; s.m.rotation.y += 0.2;
    }
  });
  for (let i = 0; i < 7; i++) {
    const m = part(UNIT_BOX, seedMat, [hx, hy, hz], [0.07, 0.05, 0.06]);
    e.group.add(m);
    // aim each seed at a different spot on the plot
    const ax = tx + 0.5 + (rand() - 0.5) * 0.8, az = tz + 0.5 + (rand() - 0.5) * 0.8;
    const land = 0.28 + rand() * 0.2;
    // solve the vertical throw so the seed touches ground at `land`; horizontal speed to arrive there
    const vy = (7 * land * land - hy) / land;
    parts.push({ m, x0: hx, z0: hz, vx: (ax - hx) / land, vz: (az - hz) / land, vy, land });
  }
  return e;
}

/** water from the can: a stream of droplets falling from the spout, and a darkening of the soil */
export function fxWater(spout: THREE.Object3D, tx: number, tz: number, surfaceY: number, dur: number, rand: () => number): Effect {
  const drops: { m: THREE.Mesh; born: number; x: number; y: number; z: number; vx: number; vz: number }[] = [];
  const patch = part(UNIT_BOX, wetMat, [tx + 0.5, surfaceY + 0.008, tz + 0.5], [0.001, 0.002, 0.001]);
  const v = new THREE.Vector3();
  let emitT = 0, seq = 0;
  const e = new Effect(dur + 0.6, (_p, t, g) => {
    // the pour lasts `dur`; the stream keeps falling a moment after the can rights itself
    if (t < dur) {
      emitT += 1 / 60;
      while (emitT > 0.028) {
        emitT -= 0.028;
        spout.getWorldPosition(v);
        const d = drops[seq % 26] ?? (() => {
          const m = part(UNIT_BOX, dropMat, [0, 0, 0], [0.06, 0.09, 0.06]);
          g.add(m);
          const nd = { m, born: 0, x: 0, y: 0, z: 0, vx: 0, vz: 0 };
          drops.push(nd);
          return nd;
        })();
        d.born = t; d.x = v.x; d.y = v.y; d.z = v.z;
        // push the stream forward toward the plot — old code was near-vertical and puddled at his feet
        const txc = tx + 0.5, tzc = tz + 0.5;
        const fdx = txc - v.x, fdz = tzc - v.z;
        const base = 1.4; // tuned so a 0.9m drop lands ~0.7 tiles forward
        d.vx = fdx * base + (rand() - 0.5) * 0.5;
        d.vz = fdz * base + (rand() - 0.5) * 0.5;
        seq++;
      }
    }
    for (const d of drops) {
      const a = t - d.born;
      const y = d.y - 4.5 * a * a;
      if (y <= surfaceY) { d.m.visible = false; continue; }
      d.m.visible = true;
      d.m.position.set(d.x + d.vx * a, y, d.z + d.vz * a);
    }
    // the soil darkens as it takes the water and stays dark a moment
    const k = Math.min(1, t / (dur * 0.7));
    patch.scale.set(0.9 * k, 0.01, 0.9 * k);
    (patch.material as THREE.MeshBasicMaterial).opacity = 0.35 * (1 - Math.max(0, (t - dur) / 0.6));
  });
  e.group.add(patch);
  return e;
}

/** the hoe biting the soil: a puff of clods */
export function fxSoil(tx: number, tz: number, rand: () => number): Effect {
  const parts: { m: THREE.Mesh; vx: number; vz: number; vy: number }[] = [];
  const e = new Effect(0.5, (_p, t) => {
    for (const pt of parts) {
      pt.m.position.set(tx + 0.5 + pt.vx * t, Math.max(0.03, 0.08 + pt.vy * t - 7 * t * t), tz + 0.5 + pt.vz * t);
      pt.m.rotation.x += 0.25;
    }
  });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + rand();
    const m = part(UNIT_BOX, soilMat, [tx + 0.5, 0.08, tz + 0.5], [0.08, 0.06, 0.07]);
    e.group.add(m);
    parts.push({ m, vx: Math.cos(a) * (0.5 + rand() * 0.5), vz: Math.sin(a) * (0.5 + rand() * 0.5), vy: 1.4 + rand() * 1.2 });
  }
  return e;
}

/** a ripe crop coming out of the ground: a spray of soil and torn leaves */
export function fxHarvest(tx: number, tz: number, rand: () => number): Effect {
  const parts: { m: THREE.Mesh; vx: number; vz: number; vy: number }[] = [];
  const e = new Effect(0.55, (_p, t) => {
    for (const pt of parts) {
      pt.m.position.set(tx + 0.5 + pt.vx * t, Math.max(0.03, 0.1 + pt.vy * t - 7 * t * t), tz + 0.5 + pt.vz * t);
      pt.m.rotation.x += 0.2; pt.m.rotation.z += 0.15;
    }
  });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + rand();
    const leaf = i % 3 === 0;
    const m = part(UNIT_BOX, leaf ? leafMat : soilMat, [tx + 0.5, 0.1, tz + 0.5], leaf ? [0.1, 0.03, 0.08] : [0.07, 0.06, 0.07]);
    e.group.add(m);
    parts.push({ m, vx: Math.cos(a) * (0.4 + rand() * 0.6), vz: Math.sin(a) * (0.4 + rand() * 0.6), vy: 1.6 + rand() * 1.4 });
  }
  return e;
}

export function fxAlert(x: number, z: number): Effect {
  const bar = part(UNIT_BOX, alertMat, [x, 1.75, z], [0.1, 0.32, 0.1]);
  const dot = part(UNIT_BOX, alertMat, [x, 1.5, z], [0.1, 0.1, 0.1]);
  const e = new Effect(0.55, (p) => {
    const bounce = Math.sin(Math.min(1, p * 2.5) * Math.PI) * 0.25;
    bar.position.y = 1.78 + bounce; dot.position.y = 1.5 + bounce;
    bar.visible = dot.visible = p < 0.85 || Math.floor(p * 40) % 2 === 0;
  });
  e.group.add(bar, dot);
  return e;
}
