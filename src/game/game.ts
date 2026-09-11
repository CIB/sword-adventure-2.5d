import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  VIEW_W, VIEW_H, VIEW_TILES_X, VIEW_TILES_Y, CAM_HEIGHT, SHEAR, WATER_DEPTH, MAP_W, MAP_H, PX_PER_TILE, MAX_HP,
  RNG, inArc, FACING_VEC, clamp,
} from './constants';
import { World, type EnemyKind, type Vec2 } from './world';
import { AudioEngine } from './audio';
import { Input, PAUSE_KEYS, MUTE_KEYS, ATTACK_KEYS, TALK_KEYS } from './input';
import { Player, Enemy, Npc, Projectile, Pickup, Effect, fxSpark, fxPuff, fxLeaves, type GameCtx } from './entities';
import { NPC_TALK, newQuestState, type Conversation, type QuestState, type TalkCtx } from './dialogue';
import { buildTrees, buildBush, buildStump, buildRock, buildFence, buildHouse, buildProp, getGradientMap } from './models';
import { Hud } from './hud';

export type Phase = 'title' | 'playing' | 'paused' | 'gameover';

interface BushObj { tx: number; tz: number; mesh: THREE.Group; alive: boolean; stump?: THREE.Mesh }

export const POST_VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
export const POST_FS = `
precision highp float;
uniform sampler2D tDiffuse; uniform sampler2D tDepth; uniform vec2 texel;
uniform float camNear; uniform float camFar; uniform float threshold;
varying vec2 vUv;
float dist(vec2 uv){ return camNear + texture2D(tDepth, uv).x * (camFar - camNear); }
void main(){
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  float d = dist(vUv);
  float dl = dist(vUv + vec2(-texel.x, 0.0));
  float dr = dist(vUv + vec2(texel.x, 0.0));
  float du = dist(vUv + vec2(0.0, texel.y));
  float dd = dist(vUv + vec2(0.0, -texel.y));
  float edge = max(max(dl - d, dr - d), max(du - d, dd - d));
  if (edge > threshold) c *= 0.1;
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  c = mix(hi, lo, vec3(lessThanEqual(c, vec3(0.0031308))));
  c = floor(c * 31.0 + 0.5) / 31.0;
  gl_FragColor = vec4(c, 1.0);
}`;

export class Game implements GameCtx {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.OrthographicCamera;
  private rt: THREE.WebGLRenderTarget;
  private postScene = new THREE.Scene();
  private postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  world = new World();
  audio: AudioEngine;
  input: Input;
  hud: Hud;
  player: Player;
  enemies: Enemy[] = [];
  projectiles: Projectile[] = [];
  pickups: Pickup[] = [];
  effects: Effect[] = [];
  bushes: BushObj[] = [];
  respawns: { kind: EnemyKind; spawn: Vec2; t: number }[] = [];
  npcs: Npc[] = [];
  quests: QuestState = newQuestState();
  talking = false;
  private convo: Conversation | null = null;
  private convoPage = 0;
  private convoChars = 0; // typewriter progress on the current page
  private toastMsg = '';
  private toastT = 0;
  private spinners: THREE.Object3D[] = [];
  phase: Phase = 'title';
  time = 0;
  private lastNow = 0;
  private raf = 0;
  private cam: Vec2 = { x: 0, z: 0 };
  private waveTex: THREE.CanvasTexture;
  private rng = new RNG((Date.now() & 0xffff) + 1);
  private lowHpT = 0;
  private deathTimer = 0;
  onPhase: (p: Phase) => void = () => {};
  onMute: (m: boolean) => void = () => {};

  constructor(canvas: HTMLCanvasElement, hudCanvas: HTMLCanvasElement, audio: AudioEngine, input: Input) {
    this.audio = audio;
    this.input = input;
    this.hud = new Hud(hudCanvas);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(VIEW_W, VIEW_H, false);
    this.renderer.setClearColor(0x1b4520, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.rt = new THREE.WebGLRenderTarget(VIEW_W, VIEW_H, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true, stencilBuffer: false });
    this.rt.texture.colorSpace = THREE.SRGBColorSpace;
    const depthTex = new THREE.DepthTexture(VIEW_W, VIEW_H);
    depthTex.type = THREE.UnsignedIntType;
    depthTex.format = THREE.DepthFormat;
    this.rt.depthTexture = depthTex;

    const postMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this.rt.texture }, tDepth: { value: depthTex },
        texel: { value: new THREE.Vector2(1 / VIEW_W, 1 / VIEW_H) },
        camNear: { value: 1 }, camFar: { value: 200 }, threshold: { value: 0.16 },
      },
      vertexShader: POST_VS, fragmentShader: POST_FS, depthTest: false, depthWrite: false,
    });
    this.postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMat));

    // Top-down orthographic camera with an oblique shear: ground stays 1:1, height becomes a vertical screen
    // offset so fronts of objects (and terrain slopes) are visible.
    this.camera = new THREE.OrthographicCamera(-VIEW_TILES_X / 2, VIEW_TILES_X / 2, VIEW_TILES_Y / 2, -VIEW_TILES_Y / 2, 1, 200);
    this.camera.up.set(0, 0, -1);
    this.camera.updateProjectionMatrix();
    const shear = new THREE.Matrix4().set(1, 0, 0, 0, 0, 1, SHEAR, SHEAR * CAM_HEIGHT, 0, 0, 1, 0, 0, 0, 0, 1);
    this.camera.projectionMatrix.multiply(shear);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();

    // lights
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.15));
    const sun = new THREE.DirectionalLight(0xffffff, 2.05);
    sun.position.set(-0.15, 1, 0.42);
    this.scene.add(sun, sun.target);

    this.waveTex = this.world.createWaveTexture();
    this.buildStatic();

    const ps = this.world.playerStart;
    this.player = new Player(this, ps.x, ps.z);
    this.player.facing = 2;
    for (const n of this.world.npcs) this.npcs.push(new Npc(this, n));
    this.spawnAllEnemies();
    this.cam = { x: ps.x, z: ps.z - 1 };
    this.placeCamera(0);
  }

  // ------------------------------------------------------------------ world building
  private buildStatic() {
    const w = this.world;
    // heightmapped ground; lit (toon) so slopes read as shading, like the characters
    const ground = new THREE.Mesh(w.createGroundGeometry(), new THREE.MeshToonMaterial({ map: w.createGroundTexture(), gradientMap: getGradientMap() }));
    this.scene.add(ground);

    // animated water overlay
    const quads: THREE.BufferGeometry[] = [];
    for (let z = 0; z < w.h; z++) for (let x = 0; x < w.w; x++) {
      if (!w.isWaterUnder(x, z)) continue;
      const g = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(x + 0.5, -WATER_DEPTH + 0.02, z + 0.5);
      const pos = g.attributes.position, uv = g.attributes.uv;
      for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / 2, -pos.getZ(i) / 2);
      quads.push(g);
    }
    if (quads.length) {
      const water = new THREE.Mesh(mergeGeometries(quads)!, new THREE.MeshBasicMaterial({ map: this.waveTex, transparent: true, opacity: 0.75, depthWrite: false }));
      this.scene.add(water);
    }

    for (const o of buildTrees(w.trees)) this.scene.add(o);
    for (const o of w.createBridgeMeshes()) this.scene.add(o);
    for (const b of w.bushes) {
      const mesh = buildBush();
      mesh.position.set(b.tx + 0.5, w.tileH(b.tx, b.tz), b.tz + 0.5);
      mesh.rotation.y = ((b.tx * 7 + b.tz * 3) % 5) * 0.4;
      this.scene.add(mesh);
      this.bushes.push({ tx: b.tx, tz: b.tz, mesh, alive: true });
    }
    for (const r of w.rocks) {
      const mesh = buildRock();
      mesh.position.set(r.tx + 0.5, w.tileH(r.tx, r.tz), r.tz + 0.5);
      mesh.rotation.y = ((r.tx * 5 + r.tz * 11) % 6) * 0.5;
      this.scene.add(mesh);
    }
    for (const f of w.fences) {
      const mesh = buildFence();
      mesh.position.set(f.tx + 0.5, w.heightAt(f.tx + 0.5, f.tz + 0.5), f.tz + 0.5);
      this.scene.add(mesh);
    }
    for (const hs of w.houses) { const m = buildHouse(hs); m.position.y = w.tileH(hs.x + Math.floor(hs.w / 2), hs.z + 1); this.scene.add(m); }
    for (const pr of w.props) {
      const mesh = buildProp(pr);
      mesh.position.y = w.surfaceAt(pr.x, pr.z);
      this.scene.add(mesh);
      const sp = mesh.getObjectByName('spin');
      if (sp) this.spinners.push(sp);
    }
  }

  private spawnAllEnemies() {
    for (const s of this.world.spawns) this.enemies.push(new Enemy(this, s.kind, s.x, s.z, { x: s.x, z: s.z }));
  }

  // ------------------------------------------------------------------ GameCtx
  rand() { return this.rng.next(); }

  spawnProjectile(kind: 'arrow' | 'javelin', x: number, z: number, dx: number, dz: number, dmg: number) {
    this.projectiles.push(new Projectile(this, kind, x, z, { x: dx, z: dz }, dmg));
  }

  spawnEffect(e: Effect) {
    if (e.groundAt) e.group.position.y = this.world.surfaceAt(e.groundAt.x, e.groundAt.z);
    this.effects.push(e);
    this.scene.add(e.group);
  }

  tryHitPlayer(dmg: number, sx: number, sz: number, opts?: { projectile?: boolean }): 'hit' | 'blocked' | 'immune' {
    const p = this.player;
    if (p.dead || p.invuln > 0) return 'immune';
    let dx = sx - p.pos.x, dz = sz - p.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    dx /= d; dz /= d;
    const f = FACING_VEC[p.facing];
    const dot = f[0] * dx + f[1] * dz;
    if (p.blocking && dot > 0.2) { this.audio.block(); p.pushBack(sx, sz, 2.5); return 'blocked'; }
    if (opts?.projectile && !p.attacking && dot > 0.6) { this.audio.block(); return 'blocked'; }
    p.hurt(dmg, sx, sz);
    return 'hit';
  }

  private dropLoot(x: number, z: number, heartP: number, rupeeP: number) {
    const r = this.rand();
    if (r < heartP) this.pickups.push(new Pickup(this, 'heart', { x, z }));
    else if (r < heartP + rupeeP) this.pickups.push(new Pickup(this, this.rand() < 0.2 ? 'rupee5' : 'rupee', { x, z }));
  }

  // ------------------------------------------------------------------ dialogue
  private talkCtx(): TalkCtx {
    const p = this.player;
    return {
      rupees: p.rupees,
      spendRupees: (n) => { if (p.rupees < n) return false; p.rupees -= n; this.audio.rupee(); return true; },
      heal: () => { p.hp = MAX_HP; this.audio.heart(); },
      reward: (n) => { p.rupees = Math.min(999, p.rupees + n); this.audio.rupee(); this.toast('+' + n + ' RUPEES'); },
      toast: (m) => this.toast(m),
    };
  }

  toast(msg: string) { this.toastMsg = msg; this.toastT = 2.2; }

  private tryTalk() {
    if (this.player.attacking || this.player.dead) return;
    let best: Npc | null = null, bd = Infinity;
    for (const n of this.npcs) {
      if (!n.canTalk()) continue;
      const d = Math.hypot(n.pos.x - this.player.pos.x, n.pos.z - this.player.pos.z);
      if (d < bd) { bd = d; best = n; }
    }
    if (!best) return;
    const talker = NPC_TALK[best.spec.id];
    if (!talker) return;
    best.facePlayer();
    this.convo = talker(this.quests, this.talkCtx());
    this.convoPage = 0; this.convoChars = 0;
    this.talking = true;
    this.quests.talked.add(best.spec.id);
    this.audio.talk();
  }

  private updateDialogue(dt: number) {
    const c = this.convo!;
    const page = c.pages[this.convoPage];
    const done = this.convoChars >= page.length;
    if (!done) {
      const before = Math.floor(this.convoChars);
      this.convoChars = Math.min(page.length, this.convoChars + dt * 45);
      if (Math.floor(this.convoChars) !== before && Math.floor(this.convoChars) % 3 === 0) this.audio.blip();
    }
    if (this.input.justPressed(TALK_KEYS)) {
      if (!done) { this.convoChars = page.length; return; }
      this.convoPage++;
      this.convoChars = 0;
      if (this.convoPage >= c.pages.length) {
        this.talking = false;
        this.convo = null;
        c.onEnd?.(this.quests, this.talkCtx());
      } else this.audio.blip();
    }
  }

  // ------------------------------------------------------------------ phases
  setPhase(p: Phase) {
    this.phase = p;
    this.onPhase(p);
  }

  startGame() {
    this.audio.init();
    this.audio.resume();
    this.audio.start();
    this.audio.startMusic();
    this.setPhase('playing');
  }

  restart() {
    for (const e of this.enemies) e.dispose();
    this.enemies = [];
    for (const p of this.projectiles) p.destroy();
    this.projectiles = [];
    for (const p of this.pickups) p.destroy();
    this.pickups = [];
    for (const e of this.effects) this.scene.remove(e.group);
    this.effects = [];
    this.respawns = [];
    for (const b of this.bushes) {
      if (b.alive) continue;
      b.alive = true;
      this.scene.add(b.mesh);
      this.world.setSolid(b.tx, b.tz, true);
      if (b.stump) { this.scene.remove(b.stump); b.stump = undefined; }
    }
    const ps = this.world.playerStart;
    this.player.reset(ps.x, ps.z);
    this.spawnAllEnemies();
    this.cam = { x: ps.x, z: ps.z - 1 };
    this.deathTimer = 0;
    this.talking = false; this.convo = null;
    this.player.facing = 2;
    this.audio.resume();
    this.audio.startMusic();
    this.setPhase('playing');
  }

  start() {
    this.lastNow = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.audio.stopMusic();
    this.renderer.dispose();
  }

  private loop = (now: number) => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, Math.max(0.001, (now - this.lastNow) / 1000));
    this.lastNow = now;
    this.update(dt);
    this.input.endFrame();
    this.render();
  };

  // ------------------------------------------------------------------ update
  private update(dt: number) {
    const input = this.input;
    if (input.justPressed(MUTE_KEYS)) { this.audio.init(); this.audio.setMuted(!this.audio.muted); this.onMute(this.audio.muted); }
    if (this.phase === 'title') {
      this.time += dt;
      this.waveTex.offset.set(this.time * 0.05, -this.time * 0.02);
      if (input.justPressed(PAUSE_KEYS) || input.justPressed(ATTACK_KEYS)) this.startGame();
      return;
    }
    if (this.phase === 'gameover') {
      if (input.justPressed(PAUSE_KEYS) || input.justPressed(ATTACK_KEYS)) this.restart();
      return;
    }
    if (input.justPressed(PAUSE_KEYS)) {
      const paused = this.phase !== 'paused';
      this.setPhase(paused ? 'paused' : 'playing');
      if (this.audio.ctx) { if (paused) void this.audio.ctx.suspend(); else void this.audio.ctx.resume(); }
    }
    if (this.phase === 'paused') return;

    this.time += dt;
    this.waveTex.offset.set(this.time * 0.05, -this.time * 0.02);
    for (const sp of this.spinners) sp.rotation.y += dt * 1.5;
    if (this.toastT > 0) this.toastT -= dt;

    // NPCs (they idle/wander even mid-conversation freeze of the player)
    const pp = this.player.pos;
    for (const n of this.npcs) n.update(dt, !this.player.dead && n.canTalk());

    if (this.talking) {
      this.updateDialogue(dt);
      this.placeCamera(dt);
      return;
    }
    if (input.justPressed(TALK_KEYS) && !this.player.attacking) {
      const before = this.talking;
      this.tryTalk();
      if (this.talking !== before) { this.player.holding = false; this.player.charged = false; this.player.chargeT = 0; return; }
    }
    void pp;

    this.player.update(dt, input);
    for (const e of this.enemies) e.update(dt);
    this.resolveSword();
    this.resolveContact();
    this.separateEnemies();
    this.enemies = this.enemies.filter((e) => e.alive);

    for (const p of this.projectiles) p.update(dt);
    this.projectiles = this.projectiles.filter((p) => p.alive);
    for (const p of this.pickups) p.update(dt);
    this.pickups = this.pickups.filter((p) => p.alive);
    this.effects = this.effects.filter((e) => {
      const alive = e.update(dt);
      if (!alive) this.scene.remove(e.group);
      return alive;
    });
    this.updateRespawns(dt);

    if (!this.player.dead && this.player.hp <= 2) {
      this.lowHpT -= dt;
      if (this.lowHpT <= 0) { this.audio.lowHp(); this.lowHpT = 0.9; }
    }
    if (this.player.dead) {
      this.deathTimer += dt;
      if (this.deathTimer > 1.6) {
        this.audio.stopMusic();
        this.audio.gameOver();
        this.setPhase('gameover');
      }
    }
    this.placeCamera(dt);
  }

  private resolveSword() {
    const sw = this.player.getSweep();
    if (!sw) return;
    const p = this.player.pos;
    for (const e of this.enemies) {
      if (!e.alive || sw.hit.has(e)) continue;
      const dx = e.pos.x - p.x, dz = e.pos.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > sw.r + e.radius) continue;
      if (d > 0.45 && !inArc(Math.atan2(dx, dz), sw.from, sw.to, 0.3)) continue;
      sw.hit.add(e);
      this.audio.hit();
      this.spawnEffect(fxSpark(e.pos.x, 0.8, e.pos.z).at(e.pos.x, e.pos.z));
      if (e.hurt(sw.dmg, p.x, p.z)) this.onEnemyDied(e);
    }
    for (const b of this.bushes) {
      if (!b.alive) continue;
      const dx = b.tx + 0.5 - p.x, dz = b.tz + 0.5 - p.z;
      const d = Math.hypot(dx, dz);
      if (d > sw.r + 0.45) continue;
      if (!inArc(Math.atan2(dx, dz), sw.from, sw.to, 0.35)) continue;
      this.cutBush(b);
    }
  }

  private onEnemyDied(e: Enemy) {
    this.player.kills++;
    this.quests.kills++;
    this.audio.enemyDie();
    this.spawnEffect(fxPuff(e.pos.x, e.pos.z).at(e.pos.x, e.pos.z));
    this.dropLoot(e.pos.x, e.pos.z, 0.35, 0.4);
    this.respawns.push({ kind: e.kind, spawn: e.spawn, t: 22 + this.rand() * 12 });
  }

  private cutBush(b: BushObj) {
    b.alive = false;
    this.quests.bushes++;
    this.scene.remove(b.mesh);
    this.world.setSolid(b.tx, b.tz, false);
    b.stump = buildStump();
    b.stump.position.set(b.tx + 0.5, this.world.tileH(b.tx, b.tz), b.tz + 0.5);
    this.scene.add(b.stump);
    this.audio.bushCut();
    this.spawnEffect(fxLeaves(b.tx + 0.5, b.tz + 0.5).at(b.tx + 0.5, b.tz + 0.5));
    this.dropLoot(b.tx + 0.5, b.tz + 0.5, 0.18, 0.3);
  }

  private resolveContact() {
    const p = this.player;
    if (p.dead) return;
    for (const e of this.enemies) {
      if (!e.alive || e.knockT > 0) continue;
      const dx = e.pos.x - p.pos.x, dz = e.pos.z - p.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.72) {
        const res = this.tryHitPlayer(1, e.pos.x, e.pos.z);
        const d = dist || 1;
        if (res === 'blocked') {
          e.knock = { x: (dx / d) * 4.5, z: (dz / d) * 4.5 };
          e.knockT = 0.2;
        }
        if (dist < 0.6) {
          const push = 0.6 - dist;
          const nx = dist > 1e-4 ? dx / d : 1, nz = dist > 1e-4 ? dz / d : 0;
          this.world.moveBox(e.pos, nx * push, nz * push, e.HW, e.HH);
        }
      }
    }
  }

  private separateEnemies() {
    const es = this.enemies;
    for (let i = 0; i < es.length; i++) for (let j = i + 1; j < es.length; j++) {
      const a = es[i], b = es[j];
      if (!a.alive || !b.alive) continue;
      const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.7 || d < 1e-4) continue;
      const push = (0.7 - d) / 2;
      this.world.moveBox(a.pos, (-dx / d) * push, (-dz / d) * push, a.HW, a.HH);
      this.world.moveBox(b.pos, (dx / d) * push, (dz / d) * push, b.HW, b.HH);
    }
  }

  private updateRespawns(dt: number) {
    const p = this.player.pos;
    this.respawns = this.respawns.filter((r) => {
      r.t -= dt;
      if (r.t > 0) return true;
      if (Math.hypot(r.spawn.x - p.x, r.spawn.z - p.z) < 9) { r.t = 3; return true; }
      this.enemies.push(new Enemy(this, r.kind, r.spawn.x, r.spawn.z, r.spawn));
      this.spawnEffect(fxPuff(r.spawn.x, r.spawn.z).at(r.spawn.x, r.spawn.z));
      return false;
    });
  }

  private camY = 0;
  private placeCamera(dt: number) {
    const p = this.player.pos;
    const k = dt > 0 ? 1 - Math.exp(-dt * 9) : 1;
    this.cam.x += (p.x - this.cam.x) * k;
    this.cam.z += (p.z - 1.0 - this.cam.z) * k;
    // follow the player's altitude so the shear offset stays centred on the ground she stands on
    const gy = this.world.surfaceAt(p.x, p.z);
    this.camY += (gy - this.camY) * (dt > 0 ? 1 - Math.exp(-dt * 5) : 1);
    const hx = VIEW_TILES_X / 2, hz = VIEW_TILES_Y / 2;
    const cx = clamp(this.cam.x, hx, MAP_W - hx), cz = clamp(this.cam.z, hz, MAP_H - hz);
    const sx = Math.round(cx * PX_PER_TILE) / PX_PER_TILE, sz = Math.round(cz * PX_PER_TILE) / PX_PER_TILE;
    this.camera.position.set(sx, this.camY + CAM_HEIGHT, sz);
    this.camera.lookAt(sx, this.camY, sz);
  }

  // ------------------------------------------------------------------ render
  private render() {
    this.renderer.setRenderTarget(this.rt);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.postScene, this.postCam);
    const p = this.player;
    this.hud.draw({
      hp: p.hp, rupees: p.rupees, kills: p.kills,
      charge: p.charged ? 1 : p.holding ? Math.min(1, p.chargeT / 0.75) : 0,
      charged: p.charged, blocking: p.blocking, attacking: p.attacking, time: this.time,
      dialogue: this.convo ? { name: this.convo.name, color: this.convo.color, text: this.convo.pages[this.convoPage], chars: Math.floor(this.convoChars), more: this.convoPage < this.convo.pages.length - 1 } : null,
      toast: this.toastT > 0 ? this.toastMsg : '',
      canTalk: !this.talking && this.phase === 'playing' && this.npcs.some((n) => n.canTalk()),
    });
  }
}
