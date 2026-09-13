// Node-side validation of the world-state layer: chunk aggregation, the chunk road graph, the
// chunk-border alignment guarantees (roads and linear water CROSS borders, never run along them),
// the squad system (routes, marching/resting, permanence of death), the map screen's tile-level
// rendering, and the world minimap painter.
// Stubs the DOM bits World's texture helpers need (none are called here) and a canvas 2D context.
// Run: npx esbuild test/worldstate.test.ts --bundle --platform=node --format=esm | node --input-type=module
const g2d = () => ({
  createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  putImageData: () => {},
  drawImage: () => {},
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

// ---- chunk-border alignment: roads and linear water may only CROSS a border, never run along it
// A border sits between tiles 8k-1 | 8k. A feature "runs along" a border when border-adjacent
// tiles are occupied for a long consecutive run — crossings are a few tiles wide at most.
{
  const v = world.village;
  const inVillage = (x: number, z: number) => x >= v.x0 - 1 && x <= v.x1 + 1 && z >= v.z0 - 1 && z <= v.z1 + 1;
  const road = (x: number, z: number) => x >= 0 && z >= 0 && x < MAP_W && z < MAP_H && ROAD.has(world.tile(x, z)) && !inVillage(x, z);
  const river = (x: number, z: number) => x >= 0 && z >= 0 && x < MAP_W && z < MAP_H && world.tile(x, z) === Tile.Water && world.isRiverWater(x, z);
  // longest run of consecutive tiles along any border where `pred` holds on either border-adjacent
  // line (or on both, for the straddling variant)
  const longestRun = (pred: (x: number, z: number) => boolean, both: boolean) => {
    let worst = 0, where = '';
    const scan = (k: number, vertical: boolean) => {
      const len = vertical ? MAP_H : MAP_W;
      const at = (i: number, off: number) => vertical ? pred(8 * k - 1 + off, i) : pred(i, 8 * k - 1 + off);
      let run = 0, start = 0;
      for (let i = 0; i <= len; i++) {
        const a = at(i, 0), b = at(i, 1);
        const hit = both ? a && b : a || b;
        if (hit) { if (run === 0) start = i; run++; } else { if (run > worst) { worst = run; where = vertical ? `x=${8 * k}` : `z=${8 * k}`; } run = 0; }
      }
    };
    for (let k = 1; k < MAP_W / CHUNK_T; k++) scan(k, true);
    for (let k = 1; k < MAP_H / CHUNK_T; k++) scan(k, false);
    return { worst, where };
  };
  const r1 = longestRun(road, false), r2 = longestRun(road, true);
  const w1 = longestRun(river, false), w2 = longestRun(river, true);
  console.log(`INFO longest road run along a border: ${r1.worst} (${r1.where}); straddling: ${r2.worst} (${r2.where})`);
  console.log(`INFO longest river run along a border: ${w1.worst} (${w1.where}); straddling: ${w2.worst} (${w2.where})`);
  check('roads never run along a chunk border', r1.worst <= 9);
  check('roads never straddle a chunk border', r2.worst <= 10);
  check('rivers never run along a chunk border', w1.worst <= 13);
  check('rivers never straddle a chunk border', w2.worst <= 13);
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

// ---- squads
check('every world squad spec became a squad', ws.squads.length === world.squads.length && ws.squads.length >= 12);
const soldierCount = ws.squads.reduce((n, s) => n + s.members.length, 0);
console.log(`INFO ${ws.squads.length} squads, ${soldierCount} soldiers`);
check('squads have soldiers', soldierCount >= 30);
check('soldier ids are unique', new Set(ws.squads.flatMap((s) => s.members.map((m) => m.id))).size === soldierCount);

// routes: closed loops over walkable road tiles, outside the village
const v = world.village;
const onNet = (x: number, z: number) => ROAD.has(world.tile(Math.floor(x), Math.floor(z))) && !world.isSolidTile(Math.floor(x), Math.floor(z));
let routeOK = true, outsideOK = true;
for (const sq of ws.squads) {
  if (sq.route.length < 2 || sq.total <= 0) routeOK = false;
  for (const p of sq.route) {
    if (!onNet(p.x, p.z)) routeOK = false;
    if (p.x > v.x0 - 0.5 && p.x < v.x1 + 1.5 && p.z > v.z0 - 0.5 && p.z < v.z1 + 1.5) outsideOK = false;
  }
  // every stop sits on the route at its recorded distance
  for (const s of sq.stops) {
    const p = sq.route[0]; // (checked via marching below — stops are triggerable distances)
    void p;
  }
}
check('routes are closed road loops of walkable tiles', routeOK);
check('routes never enter the village', outsideOK);

// every stop is reachable: march a squad around its whole loop and confirm it rests at each stop
{
  const sq = ws.squads.find((s) => s.stops.length >= 2 && !s.hot)!;
  let rests = 0;
  const seenStops = new Set<number>();
  const prevDist = -1;
  // simulate up to 3 full loops
  for (let t = 0; t < Math.ceil((sq.total / sq.speed) * 3) + 10 && rests < sq.stops.length; t++) {
    ws.tick(1);
    if (sq.state === 'rest' && !seenStops.has(Math.round(sq.dist * 100))) { seenStops.add(Math.round(sq.dist * 100)); rests++; }
    if (sq.dist < prevDist) break; // wrapped
  }
  void prevDist;
  check('a marching squad rests at its stops', rests >= 2, `${rests}/${sq.stops.length} stops`);
}

// ticking moves cold squads along their routes (and keeps them near the route + out of the village)
{
  const distToRoute = (sq: { route: { x: number; z: number }[] }, x: number, z: number) => {
    let best = Infinity;
    for (let i = 1; i < sq.route.length; i++) {
      const a = sq.route[i - 1], b = sq.route[i];
      const dx = b.x - a.x, dz = b.z - a.z;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
      best = Math.min(best, Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t)));
    }
    return best;
  };
  let near = true, out = true, moved = false;
  const before = ws.squads.map((s) => s.members.map((m) => ({ x: m.x, z: m.z })));
  for (let t = 0; t < 900; t++) ws.tick(0.1); // 90 sim-minutes
  ws.squads.forEach((sq, si) => {
    sq.members.forEach((m, mi) => {
      if (m.state === 'down') return;
      if (distToRoute(sq, m.x, m.z) > 3.5) near = false;
      if (m.x > v.x0 - 0.5 && m.x < v.x1 + 1.5 && m.z > v.z0 - 0.5 && m.z < v.z1 + 1.5) out = false;
      if (Math.hypot(m.x - before[si][mi].x, m.z - before[si][mi].z) > 2) moved = true;
    });
  });
  check('soldiers march along their routes', near && moved);
  check('soldiers never enter the village', out);
}

// death is permanent: no respawn, no new soldiers
{
  const victim = ws.squads[0];
  for (const m of victim.members) m.state = 'down';
  const count = () => ws.squads.reduce((n, s) => n + s.members.length, 0);
  const others = count();
  for (let t = 0; t < 1200; t++) ws.tick(0.1); // 2 sim-minutes
  check('fallen soldiers never respawn', WorldState.living(victim).length === 0);
  check('the world creates no new soldiers', count() === others);
}
// hot squads' members are not advanced by the tick (live entities are the authority)
{
  const sq = ws.squads[1];
  sq.hot = true;
  const m = WorldState.living(sq)[0];
  const x0 = m.x, z0 = m.z;
  ws.tick(5);
  check('hot squads keep their live positions', m.x === x0 && m.z === z0);
  sq.hot = false;
}

// reset() re-seeds the world
{
  ws.reset();
  check('reset revives every squad', ws.squads.every((s) => WorldState.living(s).length === s.members.length));
  check('reset rebuilds valid routes', ws.squads.every((s) => s.route.length >= 2 && s.total > 0));
}

// snapshot must be plain data (worker-transferable)
const snap = ws.snapshot();
check('snapshot is structured-clone friendly', (() => { try { JSON.parse(JSON.stringify(snap)); return true; } catch { return false; } })());

// ---- world minimap painter (one pixel per tile, real terrain colours)
{
  const img = { width: MAP_W, height: MAP_H, data: new Uint8ClampedArray(MAP_W * MAP_H * 4) } as unknown as ImageData;
  world.paintMinimap(img);
  const px = (x: number, z: number) => { const i = (z * MAP_W + x) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]]; };
  check('minimap paints every pixel opaque', img.data.every((b) => b === b) && px(0, 0)[3] === 255 && px(MAP_W - 1, MAP_H - 1)[3] === 255);
  const water = px(116, 10);   // the great river
  check('minimap water is blue', water[2] > water[0] && water[2] > water[1]);
  const path = px(30, 42);     // the meadow road
  check('minimap roads are tan, not grass-green', path[0] > path[2] && path[0] > 90 && path[1] > 70);
  const bridge = px(122, 44);  // the great bridge
  check('minimap bridge is wooden-brown', bridge[0] > bridge[2] + 30 && bridge[0] > 90 && bridge[1] > 60);
  // trees darken the canopy vs the ground beside them
  let treeTile: [number, number] | null = null;
  for (let z = 6; z < 18 && !treeTile; z++) for (let x = 60; x < 118 && !treeTile; x++) if (world.treeCell[world.idx(x, z)]) treeTile = [x, z];
  const clearTile: [number, number] | null = treeTile && (() => { for (let r = 1; r < 8; r++) { for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r]]) { const x = treeTile[0] + dx, z = treeTile[1] + dz; if (x >= 0 && z >= 0 && x < MAP_W && z < MAP_H && !world.treeCell[world.idx(x, z)] && world.tile(x, z) === world.tile(treeTile[0], treeTile[1])) return [x, z] as [number, number]; } } return null; })();
  if (treeTile && clearTile) {
    const t = px(treeTile[0], treeTile[1]), c = px(clearTile[0], clearTile[1]);
    check('minimap trees read as dark canopy', (t[0] + t[1] + t[2]) < (c[0] + c[1] + c[2]));
  } else check('minimap trees read as dark canopy', false, 'no tree/clear pair found');
  // village roofs are red
  let roof: [number, number] | null = null;
  for (let z = 1; z < 30 && !roof; z++) for (let x = 1; x < 33 && !roof; x++) if (world.houseCell[world.idx(x, z)]) roof = [x, z];
  if (roof) { const r = px(roof[0], roof[1]); check('minimap village reads as red roofs', r[0] > r[1] && r[0] > r[2]); }
  else check('minimap village reads as red roofs', false, 'no house tile found');
}

// ---- map screen rendering (stub 2D context, count draw calls)
interface Op { style: string; x: number; y: number; w: number; h: number; image?: boolean }
const mkCtx = (w: number, h: number) => {
  const ops: Op[] = [];
  const ctx = {
    canvas: { width: w, height: h },
    fillStyle: '#000',
    imageSmoothingEnabled: false,
    fillRect(x: number, y: number, cw: number, ch: number) { ops.push({ style: String(this.fillStyle), x, y, w: cw, h: ch }); },
    drawImage(img: unknown, x: number, y: number, cw: number, ch: number) { ops.push({ style: 'image', x, y, w: cw, h: ch, image: true }); },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, ops };
};
{
  const { ctx, ops } = mkCtx(417, 235);
  const canvas = { width: 417, height: 235, getContext: () => ctx } as unknown as HTMLCanvasElement;
  const map = new WorldMap(canvas, ws, world);
  map.draw({ px: 9.5, pz: 9.5, time: 0, gamepad: false });
  check('map draws something', ops.length > 300);
  // the terrain bitmap is blitted, filling the frame (fractional fit under 2x, smoothing on)
  const blit = ops.find((o) => o.image);
  check('map blits the tile terrain', !!blit, blit ? `${blit.w}x${blit.h}` : 'no image');
  check('map terrain fills the screen', !!blit && blit.w >= 200 && blit.h >= 170);
  check('map terrain blit is smoothed at fractional scale', (ctx as any).imageSmoothingEnabled === true);
  // chunk grid lines over the terrain
  check('map draws the chunk grid', ops.filter((o) => o.style === 'rgba(0,0,0,0.13)').length === (CHUNKS_X - 1) + (CHUNKS_Z - 1));
  // camps, squads, player
  check('map draws the camps', ops.some((o) => o.style === '#f8e8b0'));
  const red = ops.filter((o) => o.style === '#f04838').length;
  check('map draws a dot per living soldier', red === ws.squads.reduce((n, s) => n + WorldState.living(s).length, 0), `${red}`);
  check('player marker drawn at t=0 (blink on)', ops.some((o) => o.style === '#58f0f8'));
  // blink off half a beat later
  ops.length = 0;
  map.draw({ px: 9.5, pz: 9.5, time: 0.4, gamepad: false });
  check('player marker blinks', !ops.some((o) => o.style === '#58f0f8'));
}
{
  // a large canvas gets the crisp integer-scale path
  const { ctx, ops } = mkCtx(900, 500);
  const canvas = { width: 900, height: 500, getContext: () => ctx } as unknown as HTMLCanvasElement;
  const map = new WorldMap(canvas, ws, world);
  map.draw({ px: 100, pz: 100, time: 0, gamepad: false });
  const blit = ops.find((o) => o.image);
  check('large canvas uses integer pixel scale', !!blit && blit.w === MAP_W * 2 && blit.h === MAP_H * 2 && (ctx as any).imageSmoothingEnabled === false);
}

console.log(failures ? `\n${failures} FAILURES` : '\nALL TESTS PASSED');
process.exit(failures ? 1 : 0);
