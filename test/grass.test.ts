// Node-side validation of the grass system: placement rules, geometry integrity, streaming, determinism.
// Stubs the DOM bits the wind-texture canvas needs.
const g2d = () => ({
  createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  putImageData: () => {},
});
(globalThis as any).document = { createElement: (tag: string) => (tag === 'canvas' ? { width: 0, height: 0, getContext: () => g2d() } : {}) };

import * as THREE from 'three';
import { World } from '../src/game/world';
import { GrassSystem, GRASS_CHUNK } from '../src/game/grass';
import { MAP_W, MAP_H, Tile } from '../src/game/constants';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

const world = new World();
const grass = new GrassSystem(world);

// ---- canGrowGrass rules
check('water tile rejected', !world.canGrowGrass(120, 50));
check('village plaza (cobble) rejected', !world.canGrowGrass(9, 8));
check('tree tile rejected', (() => { for (const t of world.trees) if (world.tile(Math.floor(t.x), Math.floor(t.z - 0.55)) === Tile.Grass) return !world.canGrowGrass(Math.floor(t.x), Math.floor(t.z - 0.55)); return true; })());
let grassTiles = 0, growTiles = 0;
for (let z = 0; z < MAP_H; z++) for (let x = 0; x < MAP_W; x++) {
  const t = world.tile(x, z);
  if (t === Tile.Grass || t === Tile.Flowers) { grassTiles++; if (world.canGrowGrass(x, z)) growTiles++; }
}
console.log(`INFO growable grass tiles: ${growTiles}/${grassTiles} (${(100 * growTiles / grassTiles).toFixed(1)}%)`);
check('a healthy share of grass tiles can grow blades', growTiles / grassTiles > 0.55 && growTiles / grassTiles < 0.99);

// ---- geometry integrity on a meadow chunk (home meadow near spawn, outside the village)
const g = (grass as any).buildGeometry(33, 33, GRASS_CHUNK, GRASS_CHUNK) as THREE.BufferGeometry | null;
check('meadow chunk produces geometry', !!g);
if (g) {
  const pos = g.getAttribute('position'), nrm = g.getAttribute('normal'), col = g.getAttribute('aCol'), uv = g.getAttribute('uv'), idx = g.getIndex()!;
  check('attributes match', pos.count === nrm.count && pos.count === col.count && pos.count === uv.count, `${pos.count} verts`);
  check('index fits uint16', pos.count <= 65535);
  let okIdx = true, yMin = Infinity, yMax = -Infinity;
  for (let i = 0; i < idx.count; i++) { const v = idx.getX(i); if (v < 0 || v >= pos.count) okIdx = false; }
  for (let i = 0; i < pos.count; i++) { yMin = Math.min(yMin, pos.getY(i)); yMax = Math.max(yMax, pos.getY(i)); }
  check('indices in range', okIdx);
  check('blade heights sensible', yMax - yMin < 1.2 && yMax - yMin > 0.3, `height span ${(yMax - yMin).toFixed(2)}`);
  // roots sit on the ground mesh plane
  let maxErr = 0;
  for (let i = 0; i < pos.count; i++) {
    const bend = uv.getX(i);
    if (bend !== 0) continue;
    const x = pos.getX(i), z = pos.getZ(i), y = pos.getY(i);
    const gy = (grass as any).groundY(x, z);
    maxErr = Math.max(maxErr, Math.abs(y - gy));
  }
  check('roots exactly on the drawn ground plane', maxErr < 1e-4, `max err ${maxErr.toExponential(2)}`);
  const bladeEstimate = pos.count / 5;
  console.log(`INFO meadow chunk: ~${bladeEstimate} blades, ${idx.count / 3} tris`);
}

// ---- water/village chunks stay empty where nothing grows
const plaza = (grass as any).buildGeometry(6, 6, GRASS_CHUNK, GRASS_CHUNK);
console.log('INFO plaza chunk (village core):', plaza ? `${(plaza as THREE.BufferGeometry).getAttribute('position').count} verts` : 'empty');

// ---- determinism
const a = (grass as any).buildGeometry(33, 33, GRASS_CHUNK, GRASS_CHUNK) as THREE.BufferGeometry;
const b = (grass as any).buildGeometry(33, 33, GRASS_CHUNK, GRASS_CHUNK) as THREE.BufferGeometry;
let same = a.getAttribute('position').count === b.getAttribute('position').count;
if (same) { const pa = a.getAttribute('position') as THREE.BufferAttribute, pb = b.getAttribute('position') as THREE.BufferAttribute; for (let i = 0; i < pa.count * 3; i++) if (pa.array[i] !== pb.array[i]) { same = false; break; } }
check('deterministic builds', same);

// ---- single-chunk build cost (what a streaming frame pays; median of 9 to dodge sandbox noise)
{
  const ts: number[] = [];
  for (let i = 0; i < 9; i++) {
    const t = performance.now();
    (grass as any).buildGeometry(60 + (i % 3) * 16, 60, GRASS_CHUNK, GRASS_CHUNK);
    ts.push(performance.now() - t);
  }
  ts.sort((a, b) => a - b);
  console.log(`INFO single chunk build median: ${ts[4].toFixed(2)} ms`);
  check('chunk build affordable', ts[4] < 12, `${ts[4].toFixed(2)} ms`);
}

// ---- streaming: walk the camera across the map
const t0 = performance.now();
for (let i = 0; i < 400; i++) {
  const cx = 9.5 + i * 0.5, cz = 9.5 + Math.sin(i * 0.05) * 30;
  grass.update(i * 0.016, cx, cz, 16, cx, cz);
}
const chunkCount = [...(grass as any).chunks.entries()].filter(([, m]: any) => m).length;
const emptyCount = [...(grass as any).chunks.entries()].filter(([, m]: any) => !m).length;
console.log(`INFO streaming: ${chunkCount} built chunks resident, ${emptyCount} empty slots, total ${(performance.now() - t0).toFixed(0)} ms`);
check('resident chunk count bounded', chunkCount <= 49, `${chunkCount}`);

// ---- steady-state update cost once the surroundings are built (median of 200)
{
  for (let i = 0; i < 20; i++) grass.update(i * 0.016, 41.5, 41.5, 16, 41.5, 41.5);
  const ts: number[] = [];
  for (let i = 0; i < 200; i++) {
    const t = performance.now();
    grass.update(1 + i * 0.016, 41.5, 41.5, 16, 41.5 + Math.sin(i * 0.1) * 0.2, 41.5);
    ts.push(performance.now() - t);
  }
  ts.sort((a, b) => a - b);
  console.log(`INFO steady update median: ${ts[100].toFixed(3)} ms`);
  check('steady-state update nearly free', ts[100] < 0.5, `${ts[100].toFixed(3)} ms`);
}

// ---- invalidate (bush cut / regrow): bring the camera back near the meadow first
for (let i = 0; i < 6; i++) grass.update(i * 0.016, 35.5, 35.5, 16, 35.5, 35.5);
const key = Math.floor(35 / GRASS_CHUNK) * (grass as any).chX + Math.floor(35 / GRASS_CHUNK);
check('chunk exists before invalidate', (grass as any).chunks.has(key));
grass.invalidate(35, 35);
check('invalidate drops the chunk', !(grass as any).chunks.has(key));
grass.update(0.5, 35.5, 35.5, 16, 35.5, 35.5);
grass.update(0.5, 35.5, 35.5, 16, 35.5, 35.5);
check('chunk regrows on next updates', (grass as any).chunks.has(key));

grass.dispose();
console.log(failures ? `\n${failures} FAILURES` : '\nALL TESTS PASSED');
process.exit(failures ? 1 : 0);
