// Node-side validation of the world state layer: chunk aggregation, the chunk road graph,
// soldier records and the active-region sync, plus the map screen's chunk rendering.
// Stubs the DOM bits World's texture helpers need (none are called here) and a canvas 2D context.
// Run: npx esbuild test/worldstate.test.ts --bundle --platform=node --format=esm | node --input-type=module
const g2d = () => ({
  createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  putImageData: () => {},
});
(globalThis as any).document = { createElement: (tag: string) => (tag === 'canvas' ? { width: 0, height: 0, getContext: () => g2d() } : {}) };

import { World } from '../src/game/world';
import { WorldState, CHUNK_T, CHUNKS_X, CHUNKS_Z } from '../src/game/worldstate';
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

// the great river runs the map north-south: some chunk must be dominated by water
check('some chunk is dominated by water', ws.chunks.some((c) => c.ground === Tile.Water && c.water > 0.5));
check('village chunks are flagged', ws.chunkAt(10, 10)!.village && !ws.chunkAt(180, 150)!.village);
check('biomes vary across the map', ws.chunkAt(10, 10)!.biome === 'meadow' && ws.chunkAt(190, 20)!.biome === 'highland');

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
// the roads form long routes: from the village the network must reach the far east of the map
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
  const reachEast = [...seen].some((i) => ws.chunks[i].cx >= CHUNKS_X - 4);
  console.log(`INFO road component from the village: ${seen.size} chunks`);
  check('village road component crosses the map east', reachEast);
  check('village road component is large', seen.size > 40);
}

// ---- soldiers
check('one soldier record per hand-placed spawn', ws.soldiers.length === world.spawns.length && ws.soldiers.length > 50);
check('soldiers start on their home anchor, patrolling', ws.soldiers.every((s) => s.x === s.home.x && s.z === s.home.z && s.state === 'patrol'));
check('soldier ids are unique', new Set(ws.soldiers.map((s) => s.id)).size === ws.soldiers.length);

// sync: move one live enemy, drop another
const a = ws.soldiers[0], b = ws.soldiers[1];
ws.syncActive([{ home: a.home, x: a.home.x + 3, z: a.home.z - 2 }]);
check('sync mirrors a live enemy position', a.x === a.home.x + 3 && a.z === a.home.z - 2 && a.state === 'patrol');
check('sync marks missing enemies down', b.state === 'down');
ws.syncActive(ws.soldiers.map((s) => ({ home: s.home, x: s.home.x, z: s.home.z })));
check('sync revives records when the enemy is back', b.state === 'patrol');

// snapshot must be plain data (worker-transferable)
const snap = ws.snapshot();
check('snapshot is structured-clone friendly', (() => { try { JSON.parse(JSON.stringify(snap)); return true; } catch { return false; } })());

// ---- map screen rendering (stub 2D context, count draw calls)
interface Op { style: string; x: number; y: number; w: number; h: number }
const ops: Op[] = [];
const ctx = {
  canvas: { width: 417, height: 235 },
  fillStyle: '#000',
  fillRect(x: number, y: number, w: number, h: number) { ops.push({ style: String(this.fillStyle), x, y, w, h }); },
} as unknown as CanvasRenderingContext2D;
const canvas = { width: 417, height: 235, getContext: () => ctx } as unknown as HTMLCanvasElement;
const map = new WorldMap(canvas, ws);
map.draw({ px: 9.5, pz: 9.5, time: 0, gamepad: false });
check('map draws something', ops.length > 500);
// every chunk cell must be painted: count full-cell rects of the computed cell size
const cell = Math.max(4, Math.floor(Math.min((417 - 16) / CHUNKS_X, (235 - 34) / CHUNKS_Z)));
const cells = ops.filter((o) => o.w === cell && o.h === cell);
check('one filled cell per chunk', cells.length === CHUNKS_X * CHUNKS_Z, `${cells.length}`);
check('player marker drawn at t=0 (blink on)', ops.some((o) => o.style === '#58f0f8'));
check('soldier dots drawn', ops.filter((o) => o.style === '#ffb0a0').length === ws.soldiers.filter((s) => s.state !== 'down').length);
map.draw({ px: 9.5, pz: 9.5, time: 0.4, gamepad: false });

console.log(failures ? `\n${failures} FAILURES` : '\nALL TESTS PASSED');
process.exit(failures ? 1 : 0);
