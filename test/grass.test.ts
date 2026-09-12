// Node-side validation of the grass system: placement rules, geometry integrity, streaming, determinism.
// Stubs the DOM bits the wind-texture canvas needs.
const g2d = () => ({
  createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  putImageData: () => {},
});
(globalThis as any).document = { createElement: (tag: string) => (tag === 'canvas' ? { width: 0, height: 0, getContext: () => g2d() } : {}) };

import * as THREE from 'three';
import { World } from '../src/game/world';
import { GrassSystem, GRASS_CHUNK, tuftCount, CUT_FLY, CUT_REGROW } from '../src/game/grass';
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

// ---- new biome ground types (from the biome patch)
const findTile = (t: Tile): [number, number] | null => {
  for (let z = 0; z < MAP_H; z++) for (let x = 0; x < MAP_W; x++) if (world.tile(x, z) === t) return [x, z];
  return null;
};
const mudTile = findTile(Tile.Mud), gravelTile = findTile(Tile.Gravel);
const anyGrowable = (t: Tile) => {
  for (let z = 0; z < MAP_H; z++) for (let x = 0; x < MAP_W; x++) if (world.tile(x, z) === t && world.canGrowGrass(x, z)) return true;
  return false;
};
check('world has the new biome tiles', !!(findTile(Tile.DryGrass) && findTile(Tile.Heather) && mudTile && gravelTile));
check('dry steppe grass grows blades', anyGrowable(Tile.DryGrass));
check('heather grows blades', anyGrowable(Tile.Heather));
if (mudTile && !world.solid[world.idx(mudTile[0], mudTile[1])]) check('marsh mud stays bare', !world.canGrowGrass(mudTile[0], mudTile[1]));
if (gravelTile) check('gravel stays bare', !world.canGrowGrass(gravelTile[0], gravelTile[1]));

// ---- geometry integrity on a meadow chunk (home meadow, just outside the village)
const g = (grass as any).buildGeometry(33, 33, GRASS_CHUNK, GRASS_CHUNK) as THREE.InstancedBufferGeometry | null;
check('meadow chunk produces geometry', !!g);
if (g) {
  const base = g.getAttribute('position'), a0 = g.getAttribute('aData0') as THREE.InstancedBufferAttribute, a1 = g.getAttribute('aData1') as THREE.InstancedBufferAttribute, a2 = g.getAttribute('aData2') as THREE.InstancedBufferAttribute;
  const n = a0.count;
  check('unit blade base geometry', base.count === 3);
  check('instance attributes match', a0.count === a1.count && a0.count === a2.count, `${n} blades`);
  check('instance count flag set', g.instanceCount === n);
  check('dense carpet of blades (full coverage)', n >= 256 * 8 && n <= 256 * 36, `${n} blades (~${(n / 256).toFixed(1)}/tile)`);
  const cutAttr = g.getAttribute('aCut') as THREE.InstancedBufferAttribute;
  let standing = 0;
  for (let i = 0; i < cutAttr.count; i++) if (cutAttr.getX(i) < 0) standing++;
  check('all tufts start standing', cutAttr.count === n && standing === n);
  const ranges = g.userData.tileRanges as Map<number, [number, number]>;
  let rangeSum = 0;
  for (const [, r] of ranges) rangeSum += r[1];
  check('tile ranges cover every blade', rangeSum === n, `${ranges.size} tiles`);
  let growableChunk = 0;
  for (let z = 33; z < 49; z++) for (let x = 33; x < 49; x++) if (world.canGrowGrass(x, z)) growableChunk++;
  check('every grass tile in the chunk carries tufts', ranges.size === growableChunk, `${ranges.size}/${growableChunk} tiles tufted`);
  check('instance data fits in memory', n <= 8000);
  // every blade roots exactly on the drawn ground plane; heights/widths sensible; tint+dry valid
  let maxErr = 0, badH = 0, badTint = 0, badDry = 0, flowers = 0, maxDry = 0;
  for (let i = 0; i < n; i++) {
    const x = a0.getX(i), y = a0.getY(i), z = a0.getZ(i), h = a0.getW(i);
    maxErr = Math.max(maxErr, Math.abs(y - (grass as any).groundY(x, z)));
    if (h < 0.2 || h > 0.95) badH++;
    const tint = a1.getZ(i);
    if (!(tint >= 0 && tint <= 5.5)) badTint++;
    if (tint > 1.4) flowers++;
    const dry = a2.getX(i);
    if (!(dry >= 0 && dry <= 1)) badDry++;
    maxDry = Math.max(maxDry, dry);
  }
  check('roots exactly on the drawn ground plane', maxErr < 1e-5, `max err ${maxErr.toExponential(2)}`);
  check('blade heights sensible', badH === 0, `${badH} bad`);
  check('tint codes valid', badTint === 0);
  check('dryness valid and meadow stays lush', badDry === 0 && maxDry < 0.1, `max dry ${maxDry.toFixed(2)}`);
  console.log(`INFO meadow chunk: ${n} single-triangle blades (${flowers} flowers), ${n} tris`);
}

// ---- biome response: the amber highland grows sparse, bleached blades
{
  // pick the highland chunk with the most tufts (the steppe is sparse, so don't hardcode one)
  let best: [number, number] = [176, 16], bestN = -1;
  for (let cz = 0; cz < 48; cz += GRASS_CHUNK) for (let cx = 160; cx < MAP_W; cx += GRASS_CHUNK) {
    let n = 0;
    for (let z = cz; z < cz + GRASS_CHUNK; z++) for (let x = cx; x < cx + GRASS_CHUNK; x++) n += tuftCount(world, x, z);
    if (n > bestN) { bestN = n; best = [cx, cz]; }
  }
  const hg = (grass as any).buildGeometry(best[0], best[1], GRASS_CHUNK, GRASS_CHUNK) as THREE.InstancedBufferGeometry | null;
  const mg = (grass as any).buildGeometry(33, 33, GRASS_CHUNK, GRASS_CHUNK) as THREE.InstancedBufferGeometry | null;
  check('highland chunk produces geometry', !!hg);
  if (hg && mg) {
    const hn = hg.getAttribute('aData0').count, mn = mg.getAttribute('aData0').count;
    const a2 = hg.getAttribute('aData2') as THREE.InstancedBufferAttribute;
    let drySum = 0;
    for (let i = 0; i < a2.count; i++) drySum += a2.getX(i);
    const dryAvg = drySum / a2.count;
    check('highland is sparser than the meadow', hn < mn * 0.8, `${hn} vs ${mn}`);
    check('highland blades are bleached', dryAvg > 0.3, `avg dry ${dryAvg.toFixed(2)}`);
    console.log(`INFO highland chunk: ${hn} blades, avg dryness ${dryAvg.toFixed(2)}`);
  }
}

// ---- flower tiles actually bloom
{
  let flowerTile: [number, number] | null = null;
  outer:
  for (let z = 0; z < MAP_H; z++) for (let x = 0; x < MAP_W; x++) {
    if (world.tile(x, z) === Tile.Flowers && tuftCount(world, x, z) > 0) { flowerTile = [x, z]; break outer; }
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

// ---- tuft distribution: every grass tile carries tufts, denser in the meadow than the steppe
{
  let growable = 0, tufted = 0, meadowFull = 0, meadowTot = 0, steppeSum = 0, steppeN = 0;
  for (let z = 0; z < MAP_H; z++) for (let x = 0; x < MAP_W; x++) {
    if (!world.canGrowGrass(x, z)) continue;
    growable++;
    const n = tuftCount(world, x, z);
    if (n > 0) tufted++;
    const bw = world.biomeWeights(x, z);
    if (bw.meadow > 0.9) { meadowTot++; if (n === 4) meadowFull++; }
    if (bw.highland > 0.9 || bw.mesa > 0.9) { steppeSum += n; steppeN++; }
  }
  console.log(`INFO tufted grass tiles: ${tufted}/${growable} (${(100 * tufted / growable).toFixed(1)}%)`);
  check('every grass tile carries tufts', tufted === growable, `${growable - tufted} bare`);
  check('pure meadow tiles are fully tufted (2×2)', meadowFull === meadowTot, `${meadowFull}/${meadowTot}`);
  check('steppe is sparser but never bare', steppeN > 0 && steppeSum / steppeN >= 1 && steppeSum / steppeN < 4, `${(steppeSum / steppeN).toFixed(1)} tufts/tile`);
  check('non-growable tiles never tuft', tuftCount(world, 120, 50) === 0 && tuftCount(world, 9, 8) === 0);
}

// ---- cutting: the sword stamps the tile's blades, chunk rebuilds keep the cut, regrowth clears it
{
  let cutTile: [number, number] | null = null;
  for (let z = 33; z < 49 && !cutTile; z++) for (let x = 33; x < 49; x++) if (tuftCount(world, x, z) > 0) { cutTile = [x, z]; break; }
  check('found a tufted tile to cut', !!cutTile);
  if (cutTile) {
    const [cx, cz] = cutTile;
    const cg = new GrassSystem(world);
    for (let i = 0; i < 6; i++) cg.update(10 + i * 0.016, 41.5, 41.5, 16, 41.5, 41.5);
    check('tufted tile reports tufts', cg.hasTufts(cx, cz));
    check('bare tile is not cuttable', !cg.cut(120, 50));
    check('cut succeeds', cg.cut(cx, cz));
    check('cut tile no longer has tufts', !cg.hasTufts(cx, cz));
    check('second cut is a no-op', !cg.cut(cx, cz));
    const key = Math.floor(cz / GRASS_CHUNK) * (cg as any).chX + Math.floor(cx / GRASS_CHUNK);
    const mesh = (cg as any).chunks.get(key) as THREE.Mesh;
    const geo = mesh.geometry as THREE.InstancedBufferGeometry;
    const attr = geo.getAttribute('aCut') as THREE.InstancedBufferAttribute;
    const [start, n] = (geo.userData.tileRanges as Map<number, [number, number]>).get(cz * MAP_W + cx)!;
    let stamped = 0, others = 0;
    for (let i = 0; i < attr.count; i++) { const v = attr.getX(i); if (i >= start && i < start + n) { if (v >= 0) stamped++; } else if (v >= 0) others++; }
    check('only the cut tile\'s blades are stamped', stamped === n && others === 0, `${stamped}/${n} stamped, ${others} others`);
    check('cut attribute flagged for upload', attr.needsUpdate === true || attr.version > 0);
    // streaming away and back must rebuild the chunk with the cut still applied
    cg.invalidate(cx, cz);
    cg.update(10.5, 41.5, 41.5, 16, 41.5, 41.5); cg.update(10.5, 41.5, 41.5, 16, 41.5, 41.5);
    const geo2 = ((cg as any).chunks.get(key) as THREE.Mesh).geometry as THREE.InstancedBufferGeometry;
    const attr2 = geo2.getAttribute('aCut') as THREE.InstancedBufferAttribute;
    const [s2, n2] = (geo2.userData.tileRanges as Map<number, [number, number]>).get(cz * MAP_W + cx)!;
    let kept = 0;
    for (let i = s2; i < s2 + n2; i++) if (attr2.getX(i) >= 0) kept++;
    check('cut survives a chunk rebuild', kept === n2);
    check('cut stubble is immediate while blades fly', (cg.update(10 + CUT_FLY * 0.5, 41.5, 41.5, 16, 41.5, 41.5), !cg.hasTufts(cx, cz)));
    cg.update(10 + CUT_REGROW + 2, 41.5, 41.5, 16, 41.5, 41.5);
    check('never regrows while in view', !cg.hasTufts(cx, cz));
    cg.update(10 + CUT_REGROW / 2, 141.5, 41.5, 16, 141.5, 41.5);
    check('does not regrow early even off-screen', !cg.hasTufts(cx, cz));
    cg.update(10 + CUT_REGROW + 4, 141.5, 41.5, 16, 141.5, 41.5);
    check('regrows once old and off-screen', cg.hasTufts(cx, cz));
    for (let i = 0; i < 6; i++) cg.update(10 + CUT_REGROW + 5 + i * 0.016, 41.5, 41.5, 16, 41.5, 41.5);
    const geo3 = ((cg as any).chunks.get(key) as THREE.Mesh).geometry as THREE.InstancedBufferGeometry;
    const attr3 = geo3.getAttribute('aCut') as THREE.InstancedBufferAttribute;
    const [s3, n3] = (geo3.userData.tileRanges as Map<number, [number, number]>).get(cz * MAP_W + cx)!;
    let up = 0;
    for (let i = s3; i < s3 + n3; i++) if (attr3.getX(i) < 0) up++;
    check('regrown tile stands again in the buffer', up === n3);
    cg.cut(cx, cz);
    cg.resetCuts();
    check('resetCuts regrows everything', cg.hasTufts(cx, cz));
    cg.dispose();
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
    (grass as any).buildGeometry(32 + (i % 3) * GRASS_CHUNK, 32, GRASS_CHUNK, GRASS_CHUNK);
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
