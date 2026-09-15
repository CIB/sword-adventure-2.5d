// Renders the ladybugs without a browser: a tiny CPU rasterizer drawing the model's triangles
// through the game's own camera (top-down orthographic + oblique shear, same sun, a 3-step toon
// lambert) so the models and the wing-clap can be eyeballed from a shell. Writes PNGs to .shots/.
//
//   .shots/ladybug-lineup.png  knight, common beetle shut / half open / spread, and the queen, facing S and E
//   .shots/ladybug-gust.png    a film strip of a live common beetle winding up, clapping and recovering
//   .shots/ladybug-<view>.png  free-camera views of the common beetle (front34, open34, side, top)
//
// Run: npx esbuild tools/preview-ladybug.mts --bundle --platform=node --format=esm | node --input-type=module
import * as THREE from 'three';
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { World } from '../src/game/world';
import { Enemy, Player, type Effect, type GameCtx } from '../src/game/entities';
import { RNG, SHEAR, FACING_ANGLE } from '../src/game/constants';
import { buildSoldier, type LadybugKind } from '../src/game/models';

/** how far the wing covers swing open at full spread (mirrors LADYBUG_OPEN in entities.ts) */
const OPEN = 1.25;

const SUN = new THREE.Vector3(-0.15, 1, 0.42).normalize();
const GRASS: [number, number, number] = [86, 150, 70];

// ---- png --------------------------------------------------------------------------------------------
function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { let c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(w: number, h: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let i = 0; i < w * 3; i++) raw[y * (w * 3 + 1) + 1 + i] = rgb[y * w * 3 + i];
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---- rasterizer -------------------------------------------------------------------------------------
type Project = (p: THREE.Vector3) => [number, number, number]; // screen x, screen y, depth (bigger = nearer)
type Tri = { p: [number, number, number][]; col: [number, number, number]; alpha: number };

class Canvas {
  rgb: Uint8Array;
  constructor(public w: number, public h: number, bg: [number, number, number]) {
    this.rgb = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { this.rgb[i * 3] = bg[0]; this.rgb[i * 3 + 1] = bg[1]; this.rgb[i * 3 + 2] = bg[2]; }
  }
  /** rasterize triangles into the viewport at (ox, oy) of size vw x vh */
  draw(tris: Tri[], ox: number, oy: number, vw: number, vh: number) {
    const depth = new Float32Array(vw * vh).fill(-1e9);
    tris.sort((a, b) => (a.alpha < 1 ? 1 : 0) - (b.alpha < 1 ? 1 : 0)); // opaque first, transparent painted after
    for (const t of tris) {
      const [[x0, y0, z0], [x1, y1, z1], [x2, y2, z2]] = t.p;
      const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxX = Math.min(vw - 1, Math.ceil(Math.max(x0, x1, x2)));
      const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxY = Math.min(vh - 1, Math.ceil(Math.max(y0, y1, y2)));
      const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
      if (Math.abs(area) < 1e-9) continue;
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) / area;
        const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const z = w0 * z0 + w1 * z1 + w2 * z2, i = y * vw + x;
        if (z <= depth[i]) continue;
        if (t.alpha >= 1) depth[i] = z;
        const o = ((oy + y) * this.w + ox + x) * 3, k = t.alpha;
        for (let c = 0; c < 3; c++) this.rgb[o + c] = Math.min(255, this.rgb[o + c] * (1 - k) + t.col[c] * 255 * k);
      }
    }
  }
  save(file: string) { writeFileSync(file, png(this.w, this.h, this.rgb)); console.log('wrote', file); }
}

/** every visible triangle of an object, lit the way the game's toon materials roughly come out */
function gather(obj: THREE.Object3D, project: Project, out: Tri[]) {
  obj.updateMatrixWorld(true);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    for (let p: THREE.Object3D | null = m; p; p = p.parent) if (!p.visible) return;
    const mat = m.material as THREE.MeshBasicMaterial & { emissive?: THREE.Color; emissiveIntensity?: number };
    const base = mat.color ?? new THREE.Color(1, 1, 1);
    const unlit = (mat as THREE.Material).type === 'MeshBasicMaterial';
    const pos = m.geometry.getAttribute('position'), idx = m.geometry.getIndex();
    const count = idx ? idx.count : pos.count;
    for (let i = 0; i < count; i += 3) {
      const ia = idx ? idx.getX(i) : i, ib = idx ? idx.getX(i + 1) : i + 1, ic = idx ? idx.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, ia).applyMatrix4(m.matrixWorld);
      b.fromBufferAttribute(pos, ib).applyMatrix4(m.matrixWorld);
      c.fromBufferAttribute(pos, ic).applyMatrix4(m.matrixWorld);
      n.copy(c).sub(a).cross(b.clone().sub(a)).normalize();
      let lit = 1;
      if (!unlit) { const d = Math.abs(n.dot(SUN)); lit = 0.28 + 0.62 * (d > 0.66 ? 1 : d > 0.33 ? 0.62 : 0.3); }
      const col: [number, number, number] = [base.r * lit, base.g * lit, base.b * lit];
      if (mat.emissive && (mat.emissiveIntensity ?? 0) > 0 && mat.emissive.r > 0) for (let k = 0; k < 3; k++) col[k] = Math.min(1, col[k] + 0.5);
      out.push({ p: [project(a), project(b), project(c)], col, alpha: mat.transparent ? (mat.opacity ?? 1) : 1 });
    }
  });
}

/** the game camera: x right, world z down the screen, height lifted up the screen by SHEAR; `s` px per tile */
const gameCam = (vw: number, vh: number, s: number, cx: number, cz: number): Project =>
  (p) => [vw / 2 + (p.x - cx) * s, vh / 2 + (p.z - cz) * s - p.y * SHEAR * s, p.y - p.z * 0.02];
/** a free orthographic camera: yaw about y, then pitch */
const orbitCam = (vw: number, vh: number, s: number, yaw: number, pitch: number, target: THREE.Vector3): Project => {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ')).invert();
  return (p) => { const v = p.clone().sub(target).applyQuaternion(q); return [vw / 2 + v.x * s, vh / 2 - v.y * s, v.z]; };
};

/** a ladybug posed with its wing covers `open` (0..1), the way Enemy.animate poses it mid-charge */
function posedBug(open: number, facing: number, x: number, z: number, kind: LadybugKind = 'ladybug') {
  const bug = buildSoldier(kind);
  bug.root.position.set(x, 0, z);
  bug.root.rotation.y = FACING_ANGLE[facing];
  const o = 0.05 + open * (OPEN - 0.05);
  bug.elytronL!.rotation.z = o; bug.elytronR!.rotation.z = -o;
  bug.hindwingL!.rotation.z = o * 0.55; bug.hindwingR!.rotation.z = -o * 0.55;
  bug.body.rotation.x = -0.17 * open; bug.head.rotation.x = -0.12 * open;
  return bug.root;
}

mkdirSync('.shots', { recursive: true });

// ---- 1. the line-up ----------------------------------------------------------------------------------
{
  const S = 110, W = 10 * S, H = 5 * S;
  const scene = new THREE.Group();
  for (const [row, facing, kind] of [[0, 0, 'sword'], [2.4, 2, 'spear']] as const) {
    const knight = buildSoldier(kind); knight.root.position.set(-3.6, 0, row); knight.root.rotation.y = FACING_ANGLE[facing]; scene.add(knight.root);
    [0, 0.5, 1].forEach((open, i) => scene.add(posedBug(open, facing, -2.0 + i * 1.6, row)));
    scene.add(posedBug(0, facing, 1.6, row, 'ladybug_queen'));
    scene.add(posedBug(1, facing, 4.0, row, 'ladybug_queen'));
  }
  const tris: Tri[] = [];
  gather(scene, gameCam(W, H, S, 0.2, 1.0), tris);
  const c = new Canvas(W, H, GRASS); c.draw(tris, 0, 0, W, H); c.save('.shots/ladybug-lineup.png');
}

// ---- 2. free views -----------------------------------------------------------------------------------
for (const [name, open, yaw, pitch] of [['front34', 0, 0.6, -0.5], ['open34', 1, 0.6, -0.5], ['side', 0, Math.PI / 2, -0.15], ['top', 1, 0, -1.4]] as const) {
  const tris: Tri[] = [];
  gather(posedBug(open, 0, 0, 0), orbitCam(480, 400, 200, yaw, pitch, new THREE.Vector3(0, 0.3, 0)), tris);
  const c = new Canvas(480, 400, [40, 60, 40]); c.draw(tris, 0, 0, 480, 400); c.save(`.shots/ladybug-${name}.png`);
}

// ---- 3. the gust, live -------------------------------------------------------------------------------
{
  const world = new World();
  const rng = new RNG(5);
  const effects: Effect[] = [];
  const ctx = {
    world, scene: new THREE.Scene(), audio: new Proxy({}, { get: () => () => {} }), rand: () => rng.next(), talking: false, enemies: [] as Enemy[], projectiles: [],
    spawnProjectile: () => {},
    spawnEffect: (e: Effect) => { if (e.groundAt) e.group.position.y = world.surfaceAt(e.groundAt.x, e.groundAt.z); effects.push(e); },
    tryHitPlayer: (dmg: number, sx: number, sz: number) => { player.hurt(dmg, sx, sz); return 'hit' as const; },
  } as unknown as GameCtx;
  const base = world.nearestFree(46.5, 24.5);
  // she stands two tiles south (down the screen), so the beetle faces the camera and the gust rolls down the frame
  const player = new Player(ctx, base.x, base.z + 2.2);
  (ctx as { player: Player }).player = player;
  const still = { moveX: 0, moveZ: 0, down: () => false, justPressed: () => false } as never;
  const bug = new Enemy(ctx, 'ladybug', base.x, base.z);
  ctx.enemies.push(bug);
  bug.state = 'chase'; bug.facing = 0;

  const FW = 300, FH = 330, S = 90, DT = 1 / 60;
  const times = [0, 0.55, 1.05, 1.2, 1.4, 2.2]; // seconds since the wind-up began
  const c = new Canvas(FW * times.length, FH, GRASS);
  const cx = base.x, cz = base.z + 1.0 - world.surfaceAt(base.x, base.z) * SHEAR;
  const project = gameCam(FW, FH, S, cx, cz);
  let t = 0, frame = 0, started = false;
  for (let step = 0; step < 6 * 60 && frame < times.length; step++) {
    bug.update(DT); player.update(DT, still);
    for (const e of effects) e.update(DT);
    if (!started) { if (bug.state === 'windup') started = true; else continue; }
    if (t >= times[frame] - 1e-6) {
      const tris: Tri[] = [];
      gather(bug.model.root, project, tris);
      gather(player.model.root, project, tris);
      for (const e of effects) if (e.t < e.dur) gather(e.group, project, tris);
      c.draw(tris, frame * FW, 0, FW, FH);
      console.log(`frame ${frame} @${times[frame].toFixed(2)}s: ${bug.state}, covers ${bug.model.elytronL!.rotation.z.toFixed(2)} rad open, she is ${(player.pos.z - base.z).toFixed(2)} tiles off, hp ${player.hp}`);
      frame++;
    }
    t += DT;
  }
  for (let f = 1; f < times.length; f++) for (let y = 0; y < FH; y++) { const o = (y * c.w + f * FW) * 3; c.rgb[o] = c.rgb[o + 1] = c.rgb[o + 2] = 20; }
  c.save('.shots/ladybug-gust.png');
}
