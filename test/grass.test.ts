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

// ---- geometry integrity on a meadow chunk (home meadow, just outside the village)
const g = (grass as any).buildGeometry(33, 33, GRASS_CHUNK, GRASS_CHUNK) as THREE.InstancedBufferGeometry | null;
check('meadow chunk produces geometry', !!g);
if (g) {
  const base = g.getAttribute('position'), a0 = g.getAttribute('aData0') as THREE.InstancedBufferAttribute, a1 = g.getAttribute('aData1') as THREE.InstancedBufferAttribute;
  const n = a0.count;
  check('unit blade base geometry', base.count === 3);
  check('instance attributes match', a0.count === a1.count, `${n} blades`);
  check('instance count flag set', g.instanceCount === n);
  check('dense BotW-style coverage', n >= 256 * 8, `${n} blades (~${(n / 256).toFixed(1)}/tile)`);
  check('instance data fits in memory', n <= 7200);
  // every blade roots exactly on the drawn ground plane; heights/widths sensible; tint code valid
  let maxErr = 0, badH = 0, badTint = 0, flowers = 0;
  for (let i = 0; i < n; i++) {
    const x = a0.getX(i), y = a0.getY(i), z = a0.getZ(i), h = a0.getW(i);
    maxErr = Math.max(maxErr, Math.abs(y - (grass as any).groundY(x, z)));
    if (h < 0.2 || h > 0.95) badH++;
    const tint = a1.getZ(i);
    if (!(tint >= 0 && tint <= 5.5)) badTint++;
    if (tint > 1.4) flowers++;
  }
  check('roots exactly on the drawn ground plane', maxErr < 1e-5, `max err ${maxErr.toExponential(2)}`);
  check('blade heights sensible', badH === 0, `${badH} bad`);
  check('tint codes valid', badTint === 0);
  console.log(`INFO meadow chunk: ${n} single-triangle blades (${flowers} flowers), ${n} tris`);
}

// ---- flower tiles actually bloom
{
  let flowerTile: [number, number] | null = null;
  outer:
  for (let z = 0; z < MAP_H; z++) for (let x = 0; x < MAP_W; x++) {
    if (world.tile(x, z) === Tile.Flowers && world.canGrowGrass(x, z) && x < 60 && z < 50) { flowerTile = [x, z]; break outer; }
  }
  if (flowerTile) {
    const [fx, fz] = flowerTile;
    const fg = (grass as any).buildGeometry(fx, fz, 1, 1) as THREE.InstancedBufferGeometry | null;
    const a1 = fg?.getAttribute('aData1') as THREE.InstancedBufferAttribute | undefined;
    let hasFlower = false;
    if (a1) for (let i = 0; i < a1.count; i++) if (a1.getZ(i) > 1.4) hasFlower = true;
    // a single tile has only a ~6% chance per blade; allow either but report
    console.log(`INFO flower tile (${fx},${fz}): ${a1?.count ?? 0} blades, flower present: ${hasFlower}`);
    check('flower tile grows blades', (a1?.count ?? 0) > 0);
  } else {
    check('found a flower tile to test', false);
  }
}

// ---- determinism
const a = (grass as any).buildGeometry(33, 33, GRASS_CHUNK, GRASS_CHUNK) as THREE.InstancedBufferGeometry;
const b = (grass as any).buildGeometry(33, 33, GRASS_CHUNK, GRASS_CHUNK) as THREE.InstancedBufferGeometry;
let same = a.getAttribute('aData0').count === b.getAttribute('aData0').count;
if (same) { const pa = a.getAttribute('aData0').array as Float32Array, pb = b.getAttribute('aData0').array as Float32Array; for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) { same = false; break; } }
check('deterministic builds', same);

// ---- single-chunk build cost (median of 9 to dodge sandbox noise)
{
  const ts: number[] = [];
  for (let i = 0; i < 9; i++) {
    const t = performance.now();
    (grass as any).buildGeometry(60 + (i % 3) * 16, 60, GRASS_CHUNK, GRASS_CHUNK);
    ts.push(performance.now() - t);
  }
  ts.sort((a2, b2) => a2 - b2);
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
console.log(`INFO streaming: ${chunkCount} built chunks resident, total ${(performance.now() - t0).toFixed(0)} ms`);
check('resident chunk count bounded', chunkCount <= 49, `${chunkCount}`);

// ---- steady-state update cost once the surroundings are built (median of 200)
{
  for (let i = 0; i < 20; i++) grass.update(i * 0.016, 41.5, 41.5, 16, 41.5, 41.5);
  const ts: number[] = [];
  for (let i = 0; i < 200; i++) {
    const t = performance.now();
    grass.update(1 + i * 0.016, 41.5, 41.5, 16, 41.5 + Math.sin(i * 0.1) * 0.2, 41.5, 0.3);
    ts.push(performance.now() - t);
  }
  ts.sort((a2, b2) => a2 - b2);
  console.log(`INFO steady update median: ${ts[100].toFixed(3)} ms`);
  check('steady-state update nearly free', ts[100] < 0.5, `${ts[100].toFixed(3)} ms`);
}

// ---- invalidate (bush cut / regrow): camera is parked near the meadow
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
