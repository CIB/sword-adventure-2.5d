import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  VIEW_W, VIEW_H, VIEW_TILES_X, VIEW_TILES_Y, CAM_HEIGHT, SHEAR, WATER_DEPTH, MAP_W, MAP_H, PX_PER_TILE, MAX_HP,
  RNG, inArc, FACING_VEC, clamp,
} from './constants';
import { World, type Vec2, type TileObj } from './world';
import { AudioEngine } from './audio';
import { Input, PAUSE_KEYS, MUTE_KEYS, ATTACK_KEYS, TALK_KEYS, USE_KEYS, ROTATE_CCW_KEYS, ROTATE_CW_KEYS, FULLSCREEN_KEYS, HELP_KEYS, MAP_KEYS, rotateView } from './input';
import { Player, Enemy, Npc, Projectile, Pickup, Effect, fxSpark, fxPuff, fxLeaves, type GameCtx } from './entities';
import { NPC_TALK, newQuestState, type Conversation, type QuestState, type TalkCtx } from './dialogue';
import {
  buildTrees, buildBush, buildBerryBush, buildStump, buildRock, buildFence, buildHouse, buildProp, getGroundGradientMap, buildVillager, buildDog, VILLAGER_LOOKS,
  buildFernGeo, buildTallGrassGeo, buildBriarGeo, buildLilyGeo, buildBoulderGeo, makeVegInstances,
} from './models';
import { GrassSystem } from './grass';
import { updateFoliage, makeVegInstancesWind } from './foliage';
import { Hud } from './hud';
import { WorldState, type Post } from './worldstate';
import { VillageState, CROPS, isRipe, type VillageEvent } from './village';
import { FarmView } from './farm';
import { WorldMap } from './map';

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

/** Characters with hand-made (AI-generated, SNES-style) portraits in public/portraits/; everyone else gets a live render of their 3D head. */
const PORTRAITS = new Set(['elder', 'bard', 'granny', 'aria']);
const PORTRAIT_VERSION = 2; // bump when portrait images change (busts the browser cache)

/**
 * Oblique projection: ground stays 1:1, world height becomes a vertical screen offset.
 * Multiplied into the orthographic projection matrix (see applyProjection).
 */
const SHEAR_MATRIX = new THREE.Matrix4().set(1, 0, 0, 0, 0, 1, SHEAR, SHEAR * CAM_HEIGHT, 0, 0, 1, 0, 0, 0, 0, 1);

export interface DialogueView { id: string; name: string; color: string; text: string; chars: number; more: boolean; portrait: string }

export class Game implements GameCtx {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.OrthographicCamera;
  private rt: THREE.WebGLRenderTarget;
  private postMat: THREE.ShaderMaterial;
  private postScene = new THREE.Scene();
  private postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  /** Internal render resolution in game pixels. resize() widens/tallens it so the game fills the window. */
  viewW = VIEW_W;
  viewH = VIEW_H;
  world = new World();
  /** persistent world state (chunks + the guard-post world system) — the world sim's data model */
  worldState: WorldState;
  /** the village farm: every bed tile in the plots is simulated ground, and the farmer works them */
  village: VillageState;
  /** what the farm looks like — instanced crops, wet soil, the farmer's rig (see farm.ts) */
  private farm: FarmView;
  /** tile-resolution world map (Tab / N) drawn from the world state + the terrain bitmap */
  private worldMap: WorldMap;
  /** world map screen open (gameplay keeps running underneath; it's an overlay, not a pause) */
  mapOpen = false;
  audio: AudioEngine;
  input: Input;
  hud: Hud;
  player: Player;
  enemies: Enemy[] = [];
  projectiles: Projectile[] = [];
  pickups: Pickup[] = [];
  effects: Effect[] = [];
  bushes: BushObj[] = [];
  npcs: Npc[] = [];
  quests: QuestState = newQuestState();
  talking = false;
  grass!: GrassSystem;
  private convo: Conversation | null = null;
  private convoPage = 0;
  private convoId = '';
  private convoChars = 0; // typewriter progress on the current page
  private toastMsg = '';
  private toastT = 0;
  /** a "row is ripe" toast per day at most — the farm should never compete with itself for the screen */
  private ripeToast = false;
  /** a gate on farm tool sounds, so a fast row of watering is not a machine gun of splashes */
  private farmSoundT = 0;
  private spinners: THREE.Object3D[] = [];
  /** windmill sails: spun about their local Z axis (the 'spin' objects turn about Y) */
  private millSpinners: THREE.Object3D[] = [];
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
  /** Browser fullscreen was toggled from the game (F key / gamepad Y) — the app performs the request. */
  onFullscreen: () => void = () => {};
  /** Control help was toggled from the game (H key / gamepad Select). */
  onHelp: () => void = () => {};
  /** Dialogue state for the React overlay (null when not talking) */
  onDialogue: (d: DialogueView | null) => void = () => {};
  private lastDialogueKey = '';
  private portraitCache = new Map<string, string>();

  constructor(canvas: HTMLCanvasElement, hudCanvas: HTMLCanvasElement, audio: AudioEngine, input: Input) {
    this.audio = audio;
    this.input = input;
    this.hud = new Hud(hudCanvas);
    this.worldState = new WorldState(this.world);
    this.village = new VillageState(this.world, this.world.farmPlots);
    this.farm = new FarmView({ scene: this.scene, world: this.world, village: this.village, spawnEffect: (e) => this.spawnEffect(e) });
    this.worldMap = new WorldMap(hudCanvas, this.worldState, this.world);

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
    this.postMat = postMat;
    this.postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMat));

    // Top-down orthographic camera with an oblique shear: ground stays 1:1, height becomes a vertical screen
    // offset so fronts of objects (and terrain slopes) are visible.
    this.camera = new THREE.OrthographicCamera(-VIEW_TILES_X / 2, VIEW_TILES_X / 2, VIEW_TILES_Y / 2, -VIEW_TILES_Y / 2, 1, 200);
    this.camera.up.set(0, 0, -1);
    this.applyProjection();

    // lights
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.15));
    const sun = new THREE.DirectionalLight(0xffffff, 2.05);
    sun.position.set(-0.15, 1, 0.42);
    this.scene.add(sun, sun.target);

    this.waveTex = this.world.createWaveTexture();
    this.buildStatic();

    const ps = this.world.playerStart;
    this.player = new Player(this, ps.x, ps.z);
    this.player.facing = 4; // north
    for (const n of this.world.npcs) this.npcs.push(new Npc(this, n));
    // the farmer's body belongs to the village simulation from here on (see FarmerRig)
    const farmer = this.npcs.find((n) => n.spec.id === 'farmer');
    if (farmer) this.farm.bindFarmer(farmer);
    this.cam = { x: ps.x, z: ps.z - 1 };
    this.placeCamera(0);
  }

  // ------------------------------------------------------------------ viewport
  /** Set the orthographic frustum from the current internal resolution, then re-apply the oblique shear. */
  private applyProjection() {
    const cam = this.camera;
    const hw = this.viewW / PX_PER_TILE / 2, hh = this.viewH / PX_PER_TILE / 2;
    cam.left = -hw; cam.right = hw; cam.top = hh; cam.bottom = -hh;
    cam.updateProjectionMatrix();
    cam.projectionMatrix.multiply(SHEAR_MATRIX);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  }

  /**
   * Change the internal render resolution (in game pixels). Called by the app whenever the window size changes so
   * the play area fills the whole screen instead of letterboxing; the CSS size is owned by the app.
   *
   * `hudW/hudH` size the HUD separately: when the app magnifies the world with an integer CSS upscale (`zoom`), the
   * world renders below the HUD's resolution, and the HUD's 320x240-derived layout can't shrink to match.
   * `isThor` marks the AYN Thor / very wide layout: larger HUD, frametime in the top row, bigger dialogs.
   */
  resize(w: number, h: number, hudW = w, hudH = h, isThor = false) {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    this.hud.resize(hudW, hudH, isThor); // before the early-return: the HUD size is independent of the world's
    if (w === this.viewW && h === this.viewH) return;
    this.viewW = w;
    this.viewH = h;
    this.renderer.setSize(w, h, false);
    this.rt.setSize(w, h); // three re-creates the colour + depth textures on the next render
    (this.postMat.uniforms.texel.value as THREE.Vector2).set(1 / w, 1 / h);
    this.applyProjection();
    this.placeCamera(0); // keep the map-edge clamp right (the title screen never calls placeCamera)
  }

  // ------------------------------------------------------------------ world building
  private buildStatic() {
    const w = this.world;
    // heightmapped ground; lit (toon) so slopes read as shading, like the characters
    const ground = new THREE.Mesh(w.createGroundGeometry(), new THREE.MeshToonMaterial({ map: w.createGroundTexture(), gradientMap: getGroundGradientMap() }));
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
      const mesh = (b.tx * 31 + b.tz * 17) % 5 === 0 ? buildBerryBush() : buildBush(); // ~20% berry bushes
      mesh.position.set(b.tx + 0.5, w.tileH(b.tx, b.tz), b.tz + 0.5);
      mesh.rotation.y = ((b.tx * 7 + b.tz * 3) % 5) * 0.4;
      this.scene.add(mesh);
      this.bushes.push({ tx: b.tx, tz: b.tz, mesh, alive: true });
    }
    for (const r of w.rocks) {
      const mesh = buildRock(r.v ?? 0);
      mesh.position.set(r.tx + 0.5, w.tileH(r.tx, r.tz), r.tz + 0.5);
      mesh.rotation.y = ((r.tx * 5 + r.tz * 11) % 6) * 0.5;
      this.scene.add(mesh);
    }
    // undergrowth: one instanced draw call per type (ferns, tall grass, briars, boulders, lily pads)
    const veg = (geo: THREE.BufferGeometry, list: TileObj[], seed: number, onWater = false, wind = false) => {
      if (!list.length) return;
      // +0.012 on land keeps the base off the ground quad (no z-fighting); lilies sit on the water surface
      const spots = list.map((t) => ({ x: t.tx + 0.5, y: onWater ? -WATER_DEPTH + 0.06 : w.tileH(t.tx, t.tz) + 0.012, z: t.tz + 0.5 }));
      if (wind) {
        this.scene.add(makeVegInstancesWind(geo, spots, seed));
      } else {
        this.scene.add(makeVegInstances(geo, spots, seed));
      }
    };
    veg(buildFernGeo(), w.ferns, 901, false, true);
    veg(buildTallGrassGeo(), w.tallgrass, 902, false, true);
    veg(buildBriarGeo(), w.briars, 903, false, true);
    veg(buildBoulderGeo(), w.boulders, 904);
    veg(buildLilyGeo(), w.lilies, 905, true);
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
      const mill = mesh.getObjectByName('mill');
      if (mill) this.millSpinners.push(mill);
    }

    // BotW-style animated grass, streamed around the camera
    this.grass = new GrassSystem(w);
    this.scene.add(this.grass.root);
  }

  /**
   * The world system step. Every soldier holds its post's patch in world state (wandering its own
   * ground, or walking the road in from the map's edge); the ones near the player are materialised
   * as live entities that do the same under their own AI, mirroring their position back into world
   * state. Walking out of the active region de-materialises a soldier again. A fallen soldier never
   * comes back — but his post recruits a replacement, who marches in from off the map.
   */
  private updateWorld(dt: number) {
    const ws = this.worldState;
    // live entities are the authority for their soldiers' positions: mirror them back first
    for (const e of this.enemies) {
      const m = e.alive ? e.soldier : null;
      if (m) { m.x = e.pos.x; m.z = e.pos.z; }
    }
    ws.tick(dt);
    // materialise / de-materialise soldiers around the player (per soldier, so a lone replacement
    // walking in down a road is a real entity too, not just a dot in world state)
    const p = this.player.pos;
    const R = Math.max(24, Math.hypot(this.viewW, this.viewH) / PX_PER_TILE / 2 + 8); // covers the view, plus margin
    const RH = R + 8; // hysteresis so soldiers at the edge don't flicker in and out
    for (const post of ws.posts) {
      for (let i = 0; i < post.members.length; i++) {
        const m = post.members[i];
        if (m.state === 'down') { if (m.hot) { m.hot = false; this.releaseSoldier(post, i); } continue; }
        const near = Math.hypot(m.x - p.x, m.z - p.z) < (m.hot ? RH : R);
        if (near && !m.hot) {
          m.hot = true;
          const spot = this.world.nearestFree(m.x, m.z);
          this.enemies.push(new Enemy(this, m.kind, spot.x, spot.z, post, i));
          this.spawnEffect(fxPuff(spot.x, spot.z).at(spot.x, spot.z));
        } else if (!near && m.hot) {
          m.hot = false;
          this.releaseSoldier(post, i);
        }
      }
    }
    // hand every materialised soldier its marching orders (null = free to wander its patch)
    for (const e of this.enemies) {
      if (!e.alive || !e.post) continue;
      e.follow = WorldState.targetFor(e.post, e.memberIndex);
    }
  }

  /** drop the live entity standing in for one world-state soldier */
  private releaseSoldier(post: Post, index: number) {
    for (const e of this.enemies) if (e.post === post && e.memberIndex === index) e.dispose();
  }

  // ------------------------------------------------------------------ GameCtx
  rand() { return this.rng.next(); }

  spawnProjectile(kind: 'arrow' | 'javelin' | 'moblin_spear', x: number, z: number, dx: number, dz: number, dmg: number) {
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
      // the farm, as a conversation can use it: read the fields, buy the produce, buy the seeds
      village: this.village,
      takeBasket: () => this.village.takeBasket(),
      buySeeds: (crop, price, plot) => {
        if (!this.spendRupeesQuiet(price)) return false;
        this.audio.rupee();
        this.village.grantSeeds(crop, 8);
        if (plot !== undefined) this.village.unlockPlot(plot);
        this.toast(plot !== undefined ? 'THE VILLAGE TAKES ON A NEW FIELD' : CROPS[crop].name + ' SEEDS FOR THE FARM');
        return true;
      },
    };
  }

  /** rupees out, no chime (the caller picks the sound that fits the moment) */
  private spendRupeesQuiet(n: number): boolean {
    const p = this.player;
    if (p.rupees < n) return false;
    p.rupees -= n;
    return true;
  }

  /**
   * The village farm made something happen. The view gets all of it (particles at the tile, the sound of
   * a hoe or a can when the player is close enough to hear it); the player gets the two moments worth a
   * toast — a row coming ripe, and the day turning over.
   */
  private onVillageEvents(evs: VillageEvent[]) {
    this.farm.onEvents(evs);
    const v = this.village;
    const p = this.player.pos;
    // you hear the farm when you are on it, and a hoe every tenth of a second would be a racket: the
    // tool sounds share one small gate, so a busy row reads as work rather than as a stutter
    const near = (x: number, z: number) => Math.hypot(x - p.x, z - p.z) < 10;
    for (const ev of evs) {
      const heard = this.farmSoundT <= 0 && near(ev.x, ev.z);
      if (heard) this.farmSoundT = 0.3;
      switch (ev.kind) {
        case 'sow': if (heard) this.audio.seedDrop(); break;
        case 'water': if (heard) this.audio.pour(); break;
        case 'till': case 'clear': if (heard) this.audio.hoeDig(); break;
        case 'harvest': if (heard) this.audio.pick(); break;
        case 'ripe': {
          if (!near(ev.x, ev.z) || this.ripeToast) break;
          const tile = v.tileAt(Math.floor(ev.x), Math.floor(ev.z));
          const plot = tile ? v.plots[tile.plot] : null;
          this.ripeToast = true;
          this.toast((ev.crop ? CROPS[ev.crop].plural : 'CROPS') + ' RIPE' + (plot ? ' IN THE ' + plot.name.toUpperCase() : ''));
          break;
        }
        case 'deliver':
          if (ev.rupees > 0 && near(ev.x, ev.z)) { this.audio.rupee(); this.toast('GRANARY +' + ev.rupees + ' RUPEES'); }
          break;
        case 'unlock':
          this.ripeToast = false;
          this.toast('COLTS MEADOW GOES INTO ROTATION');
          break;
        case 'day':
          // the day belongs to the farm, so the notice is for whoever is standing in it
          this.ripeToast = false;
          if (Math.hypot(v.farmer.x - p.x, v.farmer.z - p.z) < 18) this.toast('DAY ' + ev.n1 + ' IN THISTLEDOWN');
          break;
      }
    }
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
    this.convoId = best.spec.id;
    this.convoPage = 0; this.convoChars = 0;
    this.talking = true;
    this.quests.talked.add(best.spec.id);
    this.audio.talk();
  }

  /**
   * Pick what is ripe under the player's boots (or clear what has gone to seed). The village's farm is
   * simulated ground, so this is not a scripted pickup: it calls the same verb the farmer's hoe calls,
   * which is why the tile pops, the produce flies over and the row needs resowing afterwards.
   */
  /** the tile the player is standing at / facing that is worth his hands: ripe, or gone to seed */
  private pickTarget() {
    const p = this.player;
    const f = FACING_VEC[p.facing];
    // the tile he faces first, then the one he is standing on — the rows are one tile wide and close
    for (const d of [0.75, 0]) {
      const t = this.village.tileAt(Math.floor(p.pos.x + f[0] * d), Math.floor(p.pos.z + f[1] * d));
      if (t && (isRipe(t) || t.wilted)) return t;
    }
    return null;
  }

  private tryPick(): boolean {
    const t = this.pickTarget();
    if (!t) return false;
    const p = this.player;
    const at = { x: p.pos.x, z: p.pos.z };
    if (t.wilted) {
      this.village.clearTile(t, at);
      this.audio.grassCut();
      this.toast('CLEARED A GONE-TO-SEED CROP');
      return true;
    }
    const got = this.village.harvestTile(t, at);
    if (!got) return false;
    this.audio.pick();
    if (p.hp < MAX_HP) {
      p.hp = Math.min(MAX_HP, p.hp + 1);
      this.audio.heart();
      this.toast('FRESH ' + CROPS[got.crop].name + ' - +1 LIFE');
    } else this.toast('FRESH ' + CROPS[got.crop].name);
    return true;
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

  private publishDialogue() {
    if (!this.convo) { if (this.lastDialogueKey) { this.lastDialogueKey = ''; this.onDialogue(null); } return; }
    const chars = Math.floor(this.convoChars);
    const key = this.convoId + '|' + this.convoPage + '|' + chars;
    if (key === this.lastDialogueKey) return;
    this.lastDialogueKey = key;
    this.onDialogue({ id: this.convoId, name: this.convo.name, color: this.convo.color, text: this.convo.pages[this.convoPage], chars, more: this.convoPage < this.convo.pages.length - 1, portrait: this.portrait(this.convoId) });
  }

  /** Render a character's head (from its real 3D model) into a small portrait image (data URL), cached per NPC id. */
  private portrait(id: string): string {
    const hit = this.portraitCache.get(id);
    if (hit) return hit;
    if (PORTRAITS.has(id)) { const url = `portraits/${id}.png?v=${PORTRAIT_VERSION}`; this.portraitCache.set(id, url); return url; }
    const npc = this.npcs.find((n) => n.spec.id === id);
    const isDog = id === 'dog';
    const model = isDog ? buildDog() : buildVillager(VILLAGER_LOOKS[id] ?? VILLAGER_LOOKS.farmer);
    void npc;
    const S = 96;
    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 1.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.9); sun.position.set(-0.4, 1, 1.2); scene.add(sun);
    model.root.scale.set(1, 1, 1); model.root.rotation.y = 0.35; // three-quarter view, unsquashed
    scene.add(model.root);
    // frame the head and shoulders
    const headY = isDog ? 0.5 : 1.0, half = isDog ? 0.45 : 0.55;
    const cam = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, 20);
    cam.position.set(0, headY - (isDog ? 0.05 : 0.08), 5); cam.lookAt(0, headY - (isDog ? 0.05 : 0.08), 0);
    const rt = new THREE.WebGLRenderTarget(S, S, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    rt.texture.colorSpace = THREE.SRGBColorSpace;
    const prevClear = this.renderer.getClearColor(new THREE.Color()), prevAlpha = this.renderer.getClearAlpha();
    this.renderer.setRenderTarget(rt);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear();
    this.renderer.render(scene, cam);
    const buf = new Uint8Array(S * S * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, S, S, buf);
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(prevClear, prevAlpha);
    rt.dispose();
    const cv = document.createElement('canvas'); cv.width = S; cv.height = S;
    const g = cv.getContext('2d')!;
    const img = g.createImageData(S, S);
    for (let y = 0; y < S; y++) img.data.set(buf.subarray((S - 1 - y) * S * 4, (S - y) * S * 4), y * S * 4); // flip Y
    g.putImageData(img, 0, 0);
    const url = cv.toDataURL();
    this.portraitCache.set(id, url);
    return url;
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
    for (const b of this.bushes) {
      if (b.alive) continue;
      b.alive = true;
      this.scene.add(b.mesh);
      this.world.setSolid(b.tx, b.tz, true);
      this.grass.invalidate(b.tx, b.tz); // no grass inside the respawned bush
      if (b.stump) { this.scene.remove(b.stump); b.stump = undefined; }
    }
    this.grass.resetCuts();
    this.village.reset(); // a new run is a new season: fresh fields, the farmer back at his cart
    this.farm.invalidate();
    this.ripeToast = false;
    const ps = this.world.playerStart;
    this.player.reset(ps.x, ps.z);
    this.worldState.reset(); // a fresh run is a fresh world: new guards on every post, nothing carried over
    this.cam = { x: ps.x, z: ps.z - 1 };
    this.deathTimer = 0;
    this.talking = false; this.convo = null;
    this.player.facing = 4; // north
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
    this.grass.dispose();
    this.renderer.dispose();
  }

  private loop = (now: number) => {
    this.raf = requestAnimationFrame(this.loop);
    const frameMs = now - this.lastNow;
    const dt = Math.min(0.05, Math.max(0.001, frameMs / 1000));
    this.lastNow = now;
    this.hud.pushFrameTime(frameMs); // the HUD's frametime graph wants the raw frame interval, not the clamped step
    this.input.pollGamepads();
    this.update(dt);
    this.input.endFrame();
    this.render();
  };

  // ------------------------------------------------------------------ update
  private update(dt: number) {
    const input = this.input;
    if (input.justPressed(MUTE_KEYS)) { this.audio.init(); this.audio.setMuted(!this.audio.muted); this.onMute(this.audio.muted); }
    if (input.justPressed(FULLSCREEN_KEYS)) this.onFullscreen();
    if (input.justPressed(HELP_KEYS)) this.onHelp();
    if ((this.phase === 'playing' || this.phase === 'paused') && input.justPressed(MAP_KEYS)) {
      this.mapOpen = !this.mapOpen;
      this.audio.blip();
    }
    if (this.phase === 'playing' && !this.talking) {
      if (input.justPressed(ROTATE_CW_KEYS)) this.rotateView(1);
      else if (input.justPressed(ROTATE_CCW_KEYS)) this.rotateView(-1);
    }
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
    for (const ms of this.millSpinners) ms.rotation.z += dt * 0.9;
    if (this.toastT > 0) this.toastT -= dt;
    if (this.farmSoundT > 0) this.farmSoundT -= dt;

    // NPCs (they idle/wander even mid-conversation freeze of the player)
    const pp = this.player.pos;
    for (const n of this.npcs) n.update(dt, !this.player.dead && n.canTalk());

    // the village farm: crops grow, the farmer works his rows. It runs on the game clock, so it stops
    // with a pause or a conversation and never behind your back while the title screen is up
    if (!this.talking) {
      this.village.tick(dt);
      const evs = this.village.takeEvents();
      if (evs.length) this.onVillageEvents(evs);
      this.farm.update(dt);
    }

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
    // nothing to say to anyone: the fields are the other thing worth pressing E at
    if (input.justPressed(USE_KEYS) && !this.player.attacking && this.tryPick()) return;
    void pp;

    this.updateWorld(dt);
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
    // grass tufts: every tile whose centre the blade sweeps over loses its tufts (Zelda-style)
    const reach = Math.ceil(sw.r + 0.5);
    const ptx = Math.floor(p.x), ptz = Math.floor(p.z);
    let cutGrass = 0;
    for (let tz = ptz - reach; tz <= ptz + reach; tz++) for (let tx = ptx - reach; tx <= ptx + reach; tx++) {
      const dx = tx + 0.5 - p.x, dz = tz + 0.5 - p.z;
      const d = Math.hypot(dx, dz);
      if (d > sw.r + 0.35) continue;
      if (d > 0.45 && !inArc(Math.atan2(dx, dz), sw.from, sw.to, 0.4)) continue;
      if (!this.grass.hasTufts(tx, tz)) continue;
      if (this.grass.cut(tx, tz)) {
        cutGrass++;
        if (this.rand() < 0.04) this.dropLoot(tx + 0.5, tz + 0.5, 0.4, 0.6); // the odd heart/rupee, like Zelda
      }
    }
    if (cutGrass) this.audio.grassCut();
  }

  private onEnemyDied(e: Enemy) {
    this.player.kills++;
    this.quests.kills++;
    this.audio.enemyDie();
    this.spawnEffect(fxPuff(e.pos.x, e.pos.z).at(e.pos.x, e.pos.z));
    this.dropLoot(e.pos.x, e.pos.z, 0.35, 0.4);
    // this soldier is down for good; the world sim queues his post a replacement, who will
    // march in from off the map along the roads (see WorldState.tick)
    const m = e.soldier;
    if (m) { m.state = 'down'; m.hot = false; }
  }

  private cutBush(b: BushObj) {
    b.alive = false;
    this.quests.bushes++;
    this.scene.remove(b.mesh);
    this.world.setSolid(b.tx, b.tz, false);
    this.grass.invalidate(b.tx, b.tz); // grass may now grow where the bush stood
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

  private camY = 0;
  /** camera yaw in 45° steps (0 = north up, 8 steps per turn) */
  viewStep = 0;
  private viewAngle = 0;        // animated yaw (radians)
  onView: (step: number) => void = () => {};
  rotateView(dir: 1 | -1) {
    this.viewStep = (((this.viewStep + dir) % 8) + 8) % 8;
    this.onView(this.viewStep);
    this.audio.blip();
  }
  private placeCamera(dt: number) {
    const p = this.player.pos;
    const k = dt > 0 ? 1 - Math.exp(-dt * 9) : 1;
    // animate the yaw toward the target quarter turn (shortest way round)
    const target = this.viewStep * Math.PI / 4;
    let da = target - this.viewAngle;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    this.viewAngle += da * (dt > 0 ? 1 - Math.exp(-dt * 10) : 1);
    if (Math.abs(da) < 1e-3) this.viewAngle = target;
    this.input.viewAngle = this.viewAngle;
    // look slightly "up the screen" (toward the top edge in camera space) so there's more room ahead
    const [ax, az] = rotateView(0, -1.0, this.viewAngle);
    this.cam.x += (p.x + ax - this.cam.x) * k;
    this.cam.z += (p.z + az - this.cam.z) * k;
    // follow the player's altitude so the shear offset stays centred on the ground she stands on
    const gy = this.world.surfaceAt(p.x, p.z);
    this.camY += (gy - this.camY) * (dt > 0 ? 1 - Math.exp(-dt * 5) : 1);
    // keep the rotated view rectangle inside the map: half-extents of its world-space bounding box
    const ca = Math.cos(this.viewAngle), sa = Math.sin(this.viewAngle);
    const tilesX = this.viewW / PX_PER_TILE, tilesY = this.viewH / PX_PER_TILE;
    const hx = (Math.abs(ca) * tilesX + Math.abs(sa) * tilesY) / 2, hz = (Math.abs(sa) * tilesX + Math.abs(ca) * tilesY) / 2;
    const cx = clamp(this.cam.x, hx, MAP_W - hx), cz = clamp(this.cam.z, hz, MAP_H - hz);
    const sx = Math.round(cx * PX_PER_TILE) / PX_PER_TILE, sz = Math.round(cz * PX_PER_TILE) / PX_PER_TILE;
    // camera "up" on screen = world -Z rotated by the yaw (rotating about +Y)
    this.camera.up.set(-sa, 0, -ca);
    this.camera.position.set(sx, this.camY + CAM_HEIGHT, sz);
    this.camera.lookAt(sx, this.camY, sz);
  }

  // ------------------------------------------------------------------ render
  private render() {
    // BotW-style grass: stream chunks around the camera, animate wind, part around the player
    this.grass.update(
      this.time, this.cam.x, this.cam.z,
      Math.hypot(this.viewW, this.viewH) / PX_PER_TILE / 2 + 2,
      this.player.pos.x, this.player.pos.z,
      this.viewAngle,
    );
    // BotW-inspired particle foliage wind
    updateFoliage(this.time);
    this.renderer.setRenderTarget(this.rt);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.postScene, this.postCam);
    const p = this.player;
    this.publishDialogue();
    this.hud.draw({
      hp: p.hp, rupees: p.rupees, kills: p.kills,
      charge: p.charged ? 1 : p.holding ? Math.min(1, p.chargeT / 0.75) : 0,
      charged: p.charged, blocking: p.blocking, attacking: p.attacking, time: this.time,
      dialogue: !!this.convo,
      toast: this.toastT > 0 ? this.toastMsg : '',
      canTalk: !this.talking && this.phase === 'playing' && this.npcs.some((n) => n.canTalk()),
      canPick: !this.talking && this.phase === 'playing' && !!this.pickTarget(),
      gamepad: this.input.gamepadActive,
    });
    if (this.mapOpen && (this.phase === 'playing' || this.phase === 'paused')) {
      this.worldMap.draw({ px: p.pos.x, pz: p.pos.z, time: this.time, gamepad: this.input.gamepadActive });
    }
  }
}
