import * as THREE from 'three';
import { FACING_ANGLE, FACING_VEC, MAX_HP, inArc, lerp, normAngle, type Facing } from './constants';
import type { AudioEngine } from './audio';
import type { Input } from './input';
import { ATTACK_KEYS, SHIELD_KEYS } from './input';
import type { EnemyKind, Vec2, World } from './world';
import {
  buildArrow, buildHeart, buildHeroine, buildJavelinProjectile, buildRupee, buildSoldier, part,
  UNIT_BOX, UNIT_OCTA, UNIT_SPHERE, type Humanoid,
} from './models';

export interface GameCtx {
  world: World;
  scene: THREE.Scene;
  audio: AudioEngine;
  player: Player;
  enemies: Enemy[];
  rand(): number;
  spawnProjectile(kind: 'arrow' | 'javelin', x: number, z: number, dx: number, dz: number, dmg: number): void;
  spawnEffect(e: Effect): void;
  tryHitPlayer(dmg: number, sx: number, sz: number, opts?: { projectile?: boolean }): 'hit' | 'blocked' | 'immune';
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
          const fv = FACING_VEC[this.facing];
          const keep = (fv[0] !== 0 && mx === fv[0]) || (fv[1] !== 0 && mz === fv[1]);
          if (!keep) this.facing = mx !== 0 ? (mx > 0 ? 1 : 3) : mz > 0 ? 0 : 2;
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
    this.game.spawnEffect(fxSpinWave(this, SPIN_DUR, SPIN_RADIUS));
  }

  /** Arc (world angles) swept by the sword since the last frame */
  getSweep(): { from: number; to: number; r: number; dmg: number; hit: Set<object> } | null {
    if (!this.sweepActive) return null;
    return { from: normAngle(this.facingAngle + this.sweepPrev), to: normAngle(this.facingAngle + this.sweepCur), r: this.sweepR, dmg: this.sweepDmg, hit: this.sweepHit };
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

  pushBack(sx: number, sz: number, force: number) {
    let dx = this.pos.x - sx, dz = this.pos.z - sz;
    const d = Math.hypot(dx, dz) || 1;
    dx /= d; dz /= d;
    this.knock.x = dx * force; this.knock.z = dz * force;
    if (this.state !== 'hurt' && this.state !== 'dead') { this.state = 'hurt'; this.stateT = 0.12; }
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
    // Facing down/right the forward-held sword reads well. Facing up/left the same pose looks like the
    // arm is thrust up and ahead of her, so there the arm hangs lower and further out to her side.
    const away = this.facing === 2 || this.facing === 3 ? 1 : 0;
    const idlePose: Pose = {
      rootYaw: 0, twist: 0, lean: 0,
      armX: lerp(-0.85, -0.4, away) - Math.max(0, -swing) * 0.3 + (moving ? 0.1 : 0),
      armY: lerp(-0.35, -0.1, away), armZ: lerp(0.15, -0.3, away), wrist: lerp(-0.35, -0.2, away),
      armLX: 0.1 + swing * 0.3, armLY: 0, armLZ: -0.1,
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
      m.shield!.position.set(0, -0.04, 0.14);
      m.shield!.rotation.set(0, 0, 0);
    }
  }

  private sync() {
    this.model.root.position.set(this.pos.x, 0, this.pos.z);
    this.model.root.rotation.y = this.facingAngle + this.rootYaw;
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
};

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
  alive = true;
  radius = 0.4;
  attackHit = false;
  yawPrev = 0;
  yawCur = 0;
  strafeDir = 1;
  fired = false;
  readonly st: Stats;
  readonly HW = 0.3;
  readonly HH = 0.25;

  constructor(private game: GameCtx, public kind: EnemyKind, x: number, z: number, public spawn: Vec2) {
    this.pos = { x, z };
    this.st = STATS[kind];
    this.hp = this.st.hp;
    this.model = buildSoldier(kind);
    this.facing = Math.floor(game.rand() * 4) as Facing;
    this.pickPatrolDir();
    game.scene.add(this.model.root);
    this.sync();
  }

  get melee() { return this.kind === 'sword' || this.kind === 'spear'; }

  private pickPatrolDir() {
    const f = Math.floor(this.game.rand() * 4) as Facing;
    this.dir = { x: FACING_VEC[f][0], z: FACING_VEC[f][1] };
  }

  private faceToward(dx: number, dz: number, hyst = 1) {
    const ax = Math.abs(dx), az = Math.abs(dz);
    if (hyst > 1) {
      const f = FACING_VEC[this.facing];
      const along = f[0] * dx + f[1] * dz;
      if (along > 0 && (f[0] !== 0 ? ax * hyst >= az : az * hyst >= ax)) return;
    }
    if (ax > az) this.facing = dx > 0 ? 1 : 3;
    else this.facing = dz > 0 ? 0 : 2;
  }

  private walk(dx: number, dz: number, speed: number, dt: number): boolean {
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return false;
    dx /= len; dz /= len;
    const ox = this.pos.x, oz = this.pos.z;
    this.game.world.moveBox(this.pos, dx * speed * dt, dz * speed * dt, this.HW, this.HH, speed * dt);
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
    this.game.spawnEffect(fxAlert(this.pos.x, this.pos.z));
    this.game.audio.alert();
  }

  update(dt: number) {
    if (!this.alive) return;
    const g = this.game, p = g.player, st = this.st;
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

    const dx = p.pos.x - this.pos.x, dz = p.pos.z - this.pos.z;
    const dist = Math.hypot(dx, dz) || 0.001;
    let moving = false;

    switch (this.state) {
      case 'patrol': {
        moving = this.walk(this.dir.x, this.dir.z, st.speed, dt);
        this.stateT -= dt;
        if (!moving || this.stateT <= 0) {
          this.pickPatrolDir();
          if (g.rand() < 0.3) { this.state = 'idle'; this.stateT = 0.5 + g.rand(); } else this.stateT = 1 + g.rand() * 2;
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
          this.state = 'windup'; this.stateT = this.kind === 'sword' ? 0.22 : 0.3; this.faceToward(dx, dz);
          break;
        }
        moving = this.walk(dx, dz, st.chase, dt);
        break;
      }
      case 'ranged': {
        if (p.dead || dist > 13) { this.state = 'patrol'; this.stateT = 1; break; }
        if (this.kind === 'javelin') {
          if (dist < 2.8) moving = this.walk(-dx, -dz, st.chase, dt);
          else if (dist > 5.5) moving = this.walk(dx, dz, st.chase, dt);
          else {
            moving = this.walk(-dz * this.strafeDir, dx * this.strafeDir, st.speed * 0.6, dt);
            if (!moving) this.strafeDir *= -1;
            this.faceToward(dx, dz);
          }
          if (this.cooldown <= 0 && dist < st.range && dist > 1.5) { this.state = 'windup'; this.stateT = 0.4; this.faceToward(dx, dz); }
        } else {
          const ax = Math.abs(dx), az = Math.abs(dz);
          const aligned = ax < 0.45 || az < 0.45;
          if (dist < 2.2) moving = this.walk(-dx, -dz, st.chase, dt);
          else if (aligned) {
            if (ax < az) this.facing = dz > 0 ? 0 : 2; else this.facing = dx > 0 ? 1 : 3;
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
        if (this.kind !== 'archer') this.faceToward(dx, dz);
        if (this.stateT <= 0) {
          this.state = 'attack'; this.stateT = 0; this.attackHit = false; this.fired = false; this.yawPrev = this.yawCur = -1.7;
          if (this.kind === 'sword') g.audio.swing(); else if (this.kind === 'spear') g.audio.throwJav();
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
    } else {
      if (!this.fired) {
        this.fired = true;
        g.spawnProjectile('arrow', this.pos.x + fv[0] * 0.5, this.pos.z + fv[1] * 0.5, fv[0], fv[1], st.dmg);
        g.audio.arrow();
      }
    }
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
    if (k === 'sword') {
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
    this.model.root.position.set(this.pos.x, 0, this.pos.z);
    this.model.root.rotation.y = FACING_ANGLE[this.facing];
  }

  dispose() {
    this.alive = false;
    this.game.scene.remove(this.model.root);
  }
}

// ======================================================================= PROJECTILE
export class Projectile {
  mesh: THREE.Group;
  pos: Vec2;
  alive = true;
  life = 0;
  speed: number;
  constructor(private game: GameCtx, public kind: 'arrow' | 'javelin', x: number, z: number, public dir: Vec2, public dmg: number) {
    this.pos = { x, z };
    this.mesh = kind === 'arrow' ? buildArrow() : buildJavelinProjectile();
    this.speed = kind === 'arrow' ? 9.5 : 6.5;
    this.mesh.rotation.y = Math.atan2(dir.x, dir.z);
    if (kind === 'javelin') this.mesh.rotation.x = -0.25;
    game.scene.add(this.mesh);
    this.sync();
  }
  private sync() { this.mesh.position.set(this.pos.x, 0.6, this.pos.z); }
  update(dt: number) {
    if (!this.alive) return;
    this.life += dt;
    this.pos.x += this.dir.x * this.speed * dt;
    this.pos.z += this.dir.z * this.speed * dt;
    this.sync();
    const w = this.game.world;
    if (this.life > 3 || w.blocksProjectile(this.pos.x, this.pos.z)) {
      this.game.spawnEffect(fxSpark(this.pos.x, 0.5, this.pos.z, 0.5));
      this.destroy();
      return;
    }
    const p = this.game.player;
    if (!p.dead && Math.hypot(p.pos.x - this.pos.x, p.pos.z - this.pos.z) < 0.45) {
      const res = this.game.tryHitPlayer(this.dmg, this.pos.x - this.dir.x, this.pos.z - this.dir.z, { projectile: true });
      if (res !== 'immune') {
        if (res === 'blocked') this.game.spawnEffect(fxSpark(this.pos.x, 0.7, this.pos.z, 0.6));
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
    this.mesh.position.y = 0.35 + Math.sin(this.t * 4) * 0.06;
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
  constructor(public dur: number, private fn: (p: number, t: number, g: THREE.Group) => void) {}
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
  const trail = new THREE.Mesh(new THREE.RingGeometry(0.62, 1, 16, 1, 0, TRAIL_ARC).rotateX(-Math.PI / 2), trailMat.clone());
  trail.position.y = 0.65;
  const dust: { m: THREE.Mesh; a: number; s: number }[] = [];
  const e = new Effect(dur + 0.25, (_p, t, g) => {
    const { x, z } = player.pos;
    g.position.set(x, 0, z);
    // ground shockwave: expands during the spin, then fades
    const rp = Math.min(1, t / dur);
    const rr = 0.4 + easeOutCubic(rp) * radius;
    ring.scale.set(rr, 1, rr);
    (ring.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - Math.max(0, (t - dur * 0.5) / (dur * 0.5 + 0.25)));
    // the sword's world angle decreases during the spin, so the trail occupies [tip, tip + TRAIL_ARC]
    trail.visible = t < dur;
    if (trail.visible) {
      const tipA = player.facingAngle + player.sweepCur;
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
