import * as THREE from 'three';
import { buildSoldier, buildHeroine } from '../src/game/models';
import { deflateSync } from 'zlib';
import { writeFileSync } from 'fs';
function png(w: number, h: number, rgb: Uint8Array) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; Buffer.from(rgb.buffer, y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1); }
  const crcT = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c; }
  const crc = (b: Buffer) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// the game's oblique view: looking straight down, screen-up = north (-z), height sheared up the screen
const SHEAR = 0.85;
function render(root: THREE.Object3D, file: string, W = 520, H = 420, scale = 90) {
  const rgb = new Uint8Array(W * H * 3); const zb = new Float32Array(W * H).fill(-1e9);
  for (let i = 0; i < W * H; i++) { rgb[i * 3] = 120; rgb[i * 3 + 1] = 160; rgb[i * 3 + 2] = 120; }
  root.updateMatrixWorld(true);
  const light = new THREE.Vector3(0.4, 0.8, 0.5).normalize();
  root.traverse((o) => {
    const m = o as THREE.Mesh; if (!m.isMesh) return;
    const g = m.geometry as THREE.BufferGeometry; const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshBasicMaterial;
    if (mat.transparent && (mat.opacity ?? 1) < 0.3) return;
    const col = new THREE.Color(mat.color); const em = (mat as any).emissive as THREE.Color | undefined; const ei = (mat as any).emissiveIntensity ?? 0;
    const pos = g.attributes.position; const idx = g.index; const n = idx ? idx.count : pos.count;
    const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]; const nrm = new THREE.Vector3();
    for (let i = 0; i < n; i += 3) {
      for (let k = 0; k < 3; k++) { const vi = idx ? idx.getX(i + k) : i + k; v[k].fromBufferAttribute(pos, vi).applyMatrix4(m.matrixWorld); }
      nrm.crossVectors(new THREE.Vector3().subVectors(v[1], v[0]), new THREE.Vector3().subVectors(v[2], v[0])).normalize();
      const lgt = 0.45 + 0.55 * Math.abs(nrm.dot(light));
      const r = Math.min(255, (col.r * lgt + (em ? em.r * ei : 0)) * 255), gg = Math.min(255, (col.g * lgt + (em ? em.g * ei : 0)) * 255), b = Math.min(255, (col.b * lgt + (em ? em.b * ei : 0)) * 255);
      const sx = v.map((p) => W / 2 + p.x * scale), sy = v.map((p) => H / 2 + (p.z - p.y * SHEAR) * scale), sz = v.map((p) => p.y - p.z * 0.001);
      const minX = Math.max(0, Math.floor(Math.min(...sx))), maxX = Math.min(W - 1, Math.ceil(Math.max(...sx)));
      const minY = Math.max(0, Math.floor(Math.min(...sy))), maxY = Math.min(H - 1, Math.ceil(Math.max(...sy)));
      const area = (sx[1] - sx[0]) * (sy[2] - sy[0]) - (sx[2] - sx[0]) * (sy[1] - sy[0]); if (Math.abs(area) < 1e-6) continue;
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        const w0 = ((sx[1] - x) * (sy[2] - y) - (sx[2] - x) * (sy[1] - y)) / area, w1 = ((sx[2] - x) * (sy[0] - y) - (sx[0] - x) * (sy[2] - y)) / area, w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * sz[0] + w1 * sz[1] + w2 * sz[2]; const pi = y * W + x;
        if (z > zb[pi]) { zb[pi] = z; rgb[pi * 3] = r; rgb[pi * 3 + 1] = gg; rgb[pi * 3 + 2] = b; }
      }
    }
  });
  writeFileSync(file, png(W, H, rgb));
}
// player stands SOUTH of the flower (screen-down); flower should face her: headYaw = 0 (+z)
for (const [name, yaw, px, pz] of [['south', 0, 0, 2.2], ['east', Math.PI / 2, 2.2, 0]] as const) {
  const f = buildSoldier('spitflower');
  f.body.rotation.y = yaw; const c = 0.6; const n = f.stalk!.length;
  f.stalk!.forEach((s, i) => { const w = (i + 1) / n; s.rotation.x = -0.16 * c * w * 0.9; });
  f.head.rotation.x = 0.45 + 0.35 * c; f.petals!.forEach((p) => p.rotation.x = -0.15 - 0.6 * c);
  (f.mouth!.material as THREE.MeshToonMaterial).emissiveIntensity = c * 1.6;
  const scene = new THREE.Group(); scene.add(f.root);
  const h = buildHeroine(); h.root.position.set(px, 0, pz); h.root.rotation.y = Math.atan2(-px, -pz); scene.add(h.root);
  render(scene, `.cache/game_${name}.png`);
}
console.log('done');
