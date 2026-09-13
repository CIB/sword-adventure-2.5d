// Node-side validation of the world state layer: chunk aggregation, the chunk road graph and its
// alignment with the map generation, squads + the background world sim (march, camps, rests, no
// respawn), and the map screen's rendering.
// Run: npx esbuild test/worldstate.test.ts --bundle --platform=node --format=esm | node --input-type=module
const g2d = () => ({
  createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  putImageData: () => {},
});
(globalThis as any).document = { createElement: (tag: string) => (tag === 'canvas' ? { width: 0, height: 0, getContext: () => g2d() } : {}) };

import { World } from '../src/game/world';
import { WorldState, CHUNK_T, CHUNKS_X, CHUNKS_Z, CAMPS } from '../src/game/worldstate';
import { WorldSim, WORLD_TICK, MARCH_SPEED } from '../src/game/worldsim';
import { WorldMap } from '../src/game/map';
import { MAP_W, MAP_H, Tile } from '../src/game/constants';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

const world = new World();
const ws = new WorldState(world);

// ---- grid shape
check('chunk grid covers the map exactly', CHUNKS_X * CHUNK_T === MAP_W && CHUNKS_Z * CHUNK_T === MAP_H);
check('one ChunkInfo per chunk', ws.chunks.length === CHUNKS_X * CHUNKS_Z);
check('chunkAt maps tiles to chunks', ws.chunkAt(0, 0) === ws.chunk(0, 0) && ws.chunkAt(MAP_W - 1, MAP_H - 1) === ws.chunk(CHUNKS_X - 1, CHUNKS_Z - 1));
check('chunkAt rejects out-of-map positions', ws.chunkAt(-1, 5) === null && ws.chunkAt(5, MAP_H + 1) === null);

// ---- chunk aggregates vs. ground truth (recompute a few chunks by hand)
const ROAD = new Set<number>([Tile.Path, Tile.Bridge, Tile.Cobble]);
let aggOK = true, roadFlagOK = true;
for (const [cx, cz] of [[0, 0], [12, 5], [15, 5], [20, 10], [8, 16], [25, 21]] as [number, number][]) {
  const c = ws.chunk(cx, cz);
  let water = 0, walk = 0, road = false;
  for (let dz = 0; dz < CHUNK_T; dz++) for (let dx = 0; dx < CHUNK_T; dx++) {
    const x = cx * CHUNK_T + dx, z = cz * CHUNK_T + dz;
    if (world.tile(x, z) === Tile.Water) water++;
    if (!world.isSolidTile(x, z)) walk++;
    if (ROAD.has(world.tile(x, z))) road = true;
  }
  if (Math.abs(c.water - water / 64) > 1e-9 || Math.abs(c.walkable - walk / 64) > 1e-9) aggOK = false;
  if (c.road !== road) roadFlagOK = false;
}
check('water/walkable fractions match a hand recount', aggOK);
check('road flag matches a hand recount', roadFlagOK);
check('some chunk is dominated by water', ws.chunks.some((c) => c.ground === Tile.Water && c.water > 0.5));
check('village chunks are flagged', ws.chunkAt(10, 10)!.village && !ws.chunkAt(180, 150)!.village);
check('road anchors sit on road tiles', ws.chunks.filter((c) => c.road).every((c) => ROAD.has(world.tile(Math.floor(c.ax), Math.floor(c.az)))));

// ---- generation <-> chunk alignment: roads and watercourses must not run ALONG chunk borders.
// A feature *crossing* a border shows as a short run (roads: the ~3-wide corridor) or as a wide
// body covering both sides far beyond the border (lakes, the river broadside). The bad case is a
// NARROW strip riding the border: feature on both border rows but land/ground `gap` tiles to each
// side, for a long run — that splits one route/river between two chunk columns and doubles it in
// the chunk model.
const alongBorder = (pred: (x: number, z: number) => boolean, gap: number, minRun: number): number => {
  let worst = 0;
  const strip = (a: [number, number], b: [number, number], aOut: [number, number], bOut: [number, number]) =>
    pred(a[0], a[1]) && pred(b[0], b[1]) && !pred(aOut[0], aOut[1]) && !pred(bOut[0], bOut[1]);
  for (let bx = 1; bx < CHUNKS_X; bx++) { // vertical borders: columns bx*8-1 | bx*8
    let run = 0;
    for (let z = 0; z < MAP_H; z++) {
      const X = bx * CHUNK_T;
      run = strip([X - 1, z], [X, z], [X - 1 - gap, z], [X + gap, z]) ? run + 1 : 0;
      worst = Math.max(worst, run);
    }
  }
  for (let bz = 1; bz < CHUNKS_Z; bz++) { // horizontal borders: rows bz*8-1 | bz*8
    let run = 0;
    for (let x = 0; x < MAP_W; x++) {
      const Z = bz * CHUNK_T;
      run = strip([x, Z - 1], [x, Z], [x, Z - 1 - gap], [x, Z + gap]) ? run + 1 : 0;
      worst = Math.max(worst, run);
    }
  }
  return worst >= minRun ? worst : 0;
};
// village streets are exempt: village chunks are walled off from squad routing anyway
const inVillage = (x: number, z: number) => x >= world.village.x0 && x <= world.village.x1 && z >= world.village.z0 && z <= world.village.z1;
const isRoadT = (x: number, z: number) => !inVillage(x, z) && ROAD.has(world.tile(x, z));
const isWaterT = (x: number, z: number) => world.tile(x, z) === Tile.Water;
{
  const roadRun = alongBorder(isRoadT, 3, 4);
  check('no road runs along a chunk border', roadRun === 0, roadRun ? `run of ${roadRun}` : '');
  const waterRun = alongBorder(isWaterT, 5, 6);
  check('no watercourse runs along a chunk border', waterRun === 0, waterRun ? `run of ${waterRun}` : '');
}

// ---- road graph
let edgesSym = true, edgeCount = 0;
for (const c of ws.chunks) {
  if (c.roadN) { edgeCount++; if (!ws.chunk(c.cx, c.cz - 1).roadS) edgesSym = false; }
  if (c.roadS) { edgeCount++; if (!ws.chunk(c.cx, c.cz + 1).roadN) edgesSym = false; }
  if (c.roadW) { edgeCount++; if (!ws.chunk(c.cx - 1, c.cz).roadE) edgesSym = false; }
  if (c.roadE) { edgeCount++; if (!ws.chunk(c.cx + 1, c.cz).roadW) edgesSym = false; }
  if ((c.roadN || c.roadS || c.roadE || c.roadW) && !c.road) edgesSym = false;
}
console.log(`INFO road graph: ${ws.chunks.filter((c) => c.road).length} road chunks, ${edgeCount / 2} edges`);
check('road graph edges are symmetric', edgesSym);
check('road graph has a real network', edgeCount / 2 > 30);
// aligned roads keep the graph slim: ~1.1 edges per road chunk (a chain), not parallel ghost routes
check('graph is not overgrown (aligned roads)', edgeCount / 2 < ws.chunks.filter((c) => c.road).length * 1.35);
// connectivity: the network reachable from the village gate must span the map and hold every camp
{
  const seen = new Set<number>();
  const start = ws.chunks.find((c) => c.village && c.road)!;
  const stack = [start];
  seen.add(ws.idx(start.cx, start.cz));
  while (stack.length) {
    const c = stack.pop()!;
    const push = (cx: number, cz: number) => { const i = ws.idx(cx, cz); if (!seen.has(i)) { seen.add(i); stack.push(ws.chunk(cx, cz)); } };
    if (c.roadN) push(c.cx, c.cz - 1);
    if (c.roadS) push(c.cx, c.cz + 1);
    if (c.roadW) push(c.cx - 1, c.cz);
    if (c.roadE) push(c.cx + 1, c.cz);
  }
  console.log(`INFO road component from the village: ${seen.size} chunks`);
  check('village road component crosses the map east', [...seen].some((i) => ws.chunks[i].cx >= CHUNKS_X - 4));
  check('all camps are on the village road component', CAMPS.every((cp) => {
    const c = ws.chunkAt(cp.x, cp.z)!;
    return seen.has(ws.idx(c.cx, c.cz));
  }));
}

// ---- squads
const soldiers = ws.squads.flatMap((s) => s.members);
console.log(`INFO squads: ${ws.squads.length}, soldiers: ${soldiers.length}`);
check('squads were seeded', ws.squads.length >= 10);
check('squads have 3-5 members', ws.squads.every((s) => s.members.length >= 3 && s.members.length <= 5));
check('soldier ids are unique', new Set(soldiers.map((m) => m.id)).size === soldiers.length);
check('every squad starts on the road network', ws.squads.every((s) => ws.chunks[s.cur].road && !ws.chunks[s.cur].village));
check('camp squads start resting', CAMPS.every((cp) => ws.squads.some((s) => s.state === 'rest' && Math.hypot(s.x - cp.x, s.z - cp.z) < CHUNK_T)));
check('every squad has a melee anchor', ws.squads.every((s) => s.members[0].kind === 'sword' || s.members[0].kind === 'spear'));
const vb = world.village;
check('no squad in the village', ws.squads.every((s) => s.x < vb.x0 || s.x > vb.x1 || s.z < vb.z0 || s.z > vb.z1));

// determinism: same world -> same squads
{
  const ws2 = new WorldState(new World());
  check('seeding is deterministic', JSON.stringify(ws2.snapshot().squads) === JSON.stringify(ws.snapshot().squads));
}

// ---- world sim
const sim = new WorldSim(ws);
const before = ws.squads.map((s) => ({ x: s.x, z: s.z, state: s.state }));
sim.tick(Math.round(60 / WORLD_TICK)); // one minute of world time
let movedOK = true, speedOK = true, onNetwork = true;
for (let i = 0; i < ws.squads.length; i++) {
  const s = ws.squads[i], b = before[i];
  const d = Math.hypot(s.x - b.x, s.z - b.z);
  if (b.state === 'march' && d === 0 && s.state === 'march') movedOK = false;    // marching squads move
  if (d > 60 * MARCH_SPEED + 1e-6) speedOK = false;                              // never faster than march speed
  const cc = ws.chunkAt(s.x, s.z);
  if (!cc || (!cc.road && !ws.chunks[s.target].road)) onNetwork = false;         // stay on the network
}
check('marching squads move', movedOK);
check('squads respect march speed', speedOK);
check('squads stay on the road network', onNetwork);
check('village chunks are never entered', ws.squads.every((s) => !ws.chunks[s.cur].village && !ws.chunks[s.target].village));
// members follow in formation
check('members trail the squad in formation', ws.squads.every((s) => s.members.every((m) => !m.alive || Math.hypot(m.x - (s.x + m.ox), m.z - (s.z + m.oz)) < 1e-6)));

// over a long stretch squads rest at camps at some point
{
  let rested = 0;
  const restSeen = new Set<number>();
  for (let t = 0; t < 40 * 60 / WORLD_TICK; t += 4) { // 40 minutes, sampled
    sim.tick(4);
    for (const s of ws.squads) if (s.state === 'rest' && !restSeen.has(s.id)) { restSeen.add(s.id); rested++; }
  }
  console.log(`INFO squads that rested at least once in 40min: ${rested}/${ws.squads.length}`);
  check('squads take rest stops', rested >= ws.squads.length * 0.5);
  check('active squads are never moved by the sim', (() => {
    const s = ws.squads[0];
    s.active = true;
    const x = s.x, z = s.z;
    sim.tick(20);
    const ok = s.x === x && s.z === z;
    s.active = false;
    return ok;
  })());
}

// ---- no respawn: killing members never brings them back
{
  const sq = ws.squads[1];
  for (const m of sq.members) m.alive = false;
  const positions = sq.members.map((m) => ({ x: m.x, z: m.z }));
  sim.tick(Math.round(120 / WORLD_TICK));
  check('dead soldiers stay dead', sq.members.every((m) => !m.alive));
  check('wiped squads stop moving', sq.members.every((m, i) => m.x === positions[i].x && m.z === positions[i].z));
  check('soldiersAlive excludes the dead', ws.soldiersAlive() === soldiers.length - sq.members.length);
}

// ---- map screen rendering (stub 2D context, count draw calls)
interface Op { style: string; x: number; y: number; w: number; h: number }
const ops: Op[] = [];
let drewTerrain = false;
const ctx = {
  canvas: { width: 417, height: 235 },
  fillStyle: '#000',
  imageSmoothingEnabled: false,
  fillRect(x: number, y: number, w: number, h: number) { ops.push({ style: String(this.fillStyle), x, y, w, h }); },
  drawImage() { drewTerrain = true; },
} as unknown as CanvasRenderingContext2D;
const canvas = { width: 417, height: 235, getContext: () => ctx } as unknown as HTMLCanvasElement;
// the offscreen terrain canvas needs a fillRect-capable context too
(globalThis as any).document.createElement = (tag: string) => (tag === 'canvas' ? {
  width: 0, height: 0,
  getContext: () => ({ fillStyle: '#000', fillRect() {}, ...g2d() }),
} : {});
const map = new WorldMap(canvas, world, ws);
map.draw({ px: 9.5, pz: 9.5, time: 0, gamepad: false });
check('map draws the terrain layer', drewTerrain);
check('map draws overlays', ops.length > 200);
check('player marker drawn at t=0 (blink on)', ops.some((o) => o.style === '#58f0f8'));
check('camp markers drawn', ops.filter((o) => o.style === '#f09030').length === CAMPS.length);
const aliveNow = ws.soldiersAlive();
check('one dot per living soldier', ops.filter((o) => o.style === '#f04838').length === aliveNow, `${ops.filter((o) => o.style === '#f04838').length}/${aliveNow}`);
check('fallen soldiers leave marks', ops.filter((o) => o.style === '#5a3038').length === ws.squads[1].members.length);

console.log(failures ? `\n${failures} FAILURES` : '\nALL TESTS PASSED');
process.exit(failures ? 1 : 0);
