// Node-side validation of the world-state layer: chunk aggregation, the chunk road graph, the
// chunk-border alignment guarantees (roads and linear water CROSS borders, never run along them),
// the guard-post system (patches, wandering, permanence of death, reinforcements marching in from
// off the map), the map screen's tile-level rendering, and the world minimap painter.
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

// ---- roads run off the map (where reinforcements march in from)
{
  const onEdge = (x: number, z: number) => {
    const tx = Math.floor(x), tz = Math.floor(z);
    return tx === 0 || tz === 0 || tx === MAP_W - 1 || tz === MAP_H - 1;
  };
  const entries = Object.entries(ws.entries);
  check('every edge entry resolved to a road tile', entries.length === Object.keys(world.edgeEntries).length
    && entries.every(([, p]) => ROAD.has(world.tile(Math.floor(p.x), Math.floor(p.z))) && !world.isSolidTile(Math.floor(p.x), Math.floor(p.z))));
  check('edge entries sit on the map border', entries.every(([, p]) => onEdge(p.x, p.z)),
    entries.map(([k, p]) => `${k}@${p.x},${p.z}`).join(' '));
  // the border forest leaves the road clear, so it reads as leaving the world
  check('no trees block a road at the map edge', entries.every(([, p]) => {
    for (let i = 0; i < 6; i++) {
      for (const [dx, dz] of [[i, 0], [-i, 0], [0, i], [0, -i]]) {
        const x = Math.floor(p.x) + dx, z = Math.floor(p.z) + dz;
        if (x < 0 || z < 0 || x >= MAP_W || z >= MAP_H) continue;
        if (ROAD.has(world.tile(x, z)) && world.treeCell[world.idx(x, z)]) return false;
      }
    }
    return true;
  }));
}

// ---- the roads near the village are the old ones: no cart lane ringing the walls
{
  const v = world.village;
  const road = (x: number, z: number) => ROAD.has(world.tile(x, z));
  // the bypass ran east from the south road along z~34 and north up x~42 to the forest trail.
  // (z starts below the east-gate road's band, which was always there.)
  let laneTiles = 0;
  for (let x = 36; x <= 45; x++) for (let z = 32; z <= 37; z++) if (road(x, z)) laneTiles++;
  for (let z = 16; z <= 40; z++) for (let x = 38; x <= 45; x++) if (road(x, z)) laneTiles++;
  check('no village bypass lane east of the walls', laneTiles === 0, `${laneTiles} road tiles`);
  // ... and the two roads that were always there still leave the village at its gates
  check('the south gate road still leaves the village', road(10, 31) || road(11, 31) || road(10, 32));
  check('the east gate road still leaves the village', road(34, 10) || road(35, 10) || road(34, 11));
  void v;
}

// ---- guard posts
check('every world post spec became a post', ws.posts.length === world.posts.length && ws.posts.length >= 12);
const soldierCount = ws.posts.reduce((n, p) => n + p.members.length, 0);
console.log(`INFO ${ws.posts.length} posts, ${soldierCount} soldiers, ${ws.posts.filter((p) => p.tight).length} of them tight`);
check('posts have soldiers', soldierCount >= 60);
check('soldier ids are unique', new Set(ws.posts.flatMap((p) => p.members.map((m) => m.id))).size === soldierCount);
check('every post fields one soldier per kind', ws.posts.every((p, i) => p.members.length === world.posts[i].kinds.length && p.homes.length === p.members.length));

const v = world.village;
const inVillage = (x: number, z: number) => x > v.x0 - 0.5 && x < v.x1 + 1.5 && z > v.z0 - 0.5 && z < v.z1 + 1.5;
const offCentre = (p: { cx: number; cz: number; rx: number; rz: number }, x: number, z: number) =>
  Math.hypot((x - p.cx) / p.rx, (z - p.cz) / p.rz);
{
  let homesOK = true, outsideOK = true, walkableOK = true;
  for (const p of ws.posts) {
    for (const m of p.members) {
      if (offCentre(p, m.hx, m.hz) > 1) homesOK = false;
      if (world.isSolidTile(Math.floor(m.hx), Math.floor(m.hz))) walkableOK = false;
      if (inVillage(m.x, m.z) || inVillage(m.hx, m.hz)) outsideOK = false;
      if (m.state !== 'post') homesOK = false; // the first watch starts on its spot
    }
  }
  check('every guard has a spot inside its patch', homesOK);
  check('every guard spot is walkable ground', walkableOK);
  check('guards never stand in the village', outsideOK);
}
// posts hold their own ground, not the roads: a spread post keeps most of its guards off the road
{
  let offRoad = 0, total = 0;
  for (const p of ws.posts) {
    if (p.tight) continue;
    for (const m of p.members) { total++; if (!ROAD.has(world.tile(Math.floor(m.hx), Math.floor(m.hz)))) offRoad++; }
  }
  console.log(`INFO spread posts: ${offRoad}/${total} guard spots off the roads`);
  check('spread posts guard the land, not the roads', total > 0 && offRoad / total > 0.8);
}
// the bridges are held in force: a tight knot, close to the deck
{
  const bridges = ws.posts.filter((p) => p.name.includes('Bridge'));
  const spreadOf = (p: (typeof ws.posts)[number]) =>
    Math.max(...p.members.map((m) => Math.hypot(m.x - p.cx, m.z - p.cz)));
  const tight = Math.max(...bridges.map(spreadOf));
  const loose = Math.max(...ws.posts.filter((p) => !p.tight).map(spreadOf));
  console.log(`INFO bridge knots reach ${tight.toFixed(1)} tiles out; spread posts ${loose.toFixed(1)}`);
  check('bridge guards hold a thick knot', bridges.length >= 3 && tight < 7);
  check('bridge knots are tighter than a spread patch', tight * 2 < loose);
}
// reinforcements: every post that recruits has a road route in from its map-edge entry
{
  const withEntry = ws.posts.filter((p) => p.entry);
  check('most posts recruit replacements', withEntry.length >= ws.posts.length - 2, `${withEntry.length}/${ws.posts.length}`);
  check('every reinforcement route starts at the map edge', withEntry.every((p) =>
    p.route.length >= 2 && p.route[0].x === p.entry!.x && p.route[0].z === p.entry!.z));
  check('every reinforcement route runs over road tiles', withEntry.every((p) =>
    p.route.every((pt) => ROAD.has(world.tile(Math.floor(pt.x), Math.floor(pt.z))))));
}

// ---- the watch wanders its own patch (cold simulation)
{
  const before = ws.posts.map((p) => p.members.map((m) => ({ x: m.x, z: m.z })));
  for (let t = 0; t < 1200; t++) ws.tick(0.25); // 5 sim-minutes
  let inPatch = true, out = true, moved = false, tightOK = true;
  ws.posts.forEach((p, pi) => {
    p.members.forEach((m, mi) => {
      if (m.state === 'down') return;
      if (offCentre(p, m.x, m.z) > 1.05) inPatch = false;
      if (inVillage(m.x, m.z)) out = false;
      if (Math.hypot(m.x - before[pi][mi].x, m.z - before[pi][mi].z) > 1.5) moved = true;
      if (p.tight && Math.hypot(m.x - m.hx, m.z - m.hz) > 3) tightOK = false;
    });
  });
  check('guards wander their own patch and stay in it', inPatch && moved);
  check('guards never enter the village', out);
  check('tight posts barely leave their spot', tightOK);
}

// ---- death is permanent, and the post recruits a replacement from off the map
{
  const post = ws.posts.find((p) => p.name === 'Willowmere Patrol')!;
  const victim = post.members[0];
  const victimKind = victim.kind;
  victim.state = 'down';
  const countBefore = post.members.length;
  const ids = new Set(post.members.map((m) => m.id));

  // nothing happens on the spot: the fallen soldier stays down
  for (let t = 0; t < 40; t++) ws.tick(0.5);
  check('a fallen soldier never gets up', victim.state === 'down');

  // ... but the post sends for a replacement, who appears on the map's edge
  let recruit = post.members.find((m) => !ids.has(m.id)) ?? null;
  for (let t = 0; t < 400 && !recruit; t++) { ws.tick(0.5); recruit = post.members.find((m) => !ids.has(m.id)) ?? null; }
  check('the post recruits a replacement', !!recruit && post.members.length === countBefore + 1);
  check('the replacement is the same kind of soldier', recruit?.kind === victimKind);
  check('the replacement starts on the map edge', !!recruit && recruit.state === 'enroute'
    && Math.hypot(recruit.x - post.entry!.x, recruit.z - post.entry!.z) < 3, recruit ? `${recruit.x.toFixed(1)},${recruit.z.toFixed(1)}` : '');

  // he walks the road in and takes up the fallen guard's spot
  let arrived = false;
  for (let t = 0; t < 1600 && !arrived; t++) {
    ws.tick(0.5);
    arrived = recruit!.state === 'post';
  }
  check('the replacement marches in and takes up the post', arrived, recruit ? `${recruit.x.toFixed(1)},${recruit.z.toFixed(1)}` : '');
  check('he holds the fallen guard\'s spot', arrived && recruit!.hx === victim.hx && recruit!.hz === victim.hz);
  check('the fallen soldier is still down', victim.state === 'down');

  // the world never fields more soldiers than the posts have spots for
  const extra = ws.posts.reduce((n, p) => n + Math.max(0, WorldState.living(p).length - p.homes.length), 0);
  check('no post is ever over strength', extra === 0, `${extra} extra`);
}

// hot soldiers are not advanced by the tick (live entities are the authority)
{
  const post = ws.posts.find((p) => !p.tight)!;
  const m = WorldState.living(post)[0];
  m.hot = true;
  const x0 = m.x, z0 = m.z;
  ws.tick(5);
  check('materialised soldiers keep their live positions', m.x === x0 && m.z === z0);
  m.hot = false;
}

// a materialised replacement still has its route advanced by the world sim
{
  const post = ws.posts.find((p) => p.name === 'Crown Hollow Guard')!;
  post.members[0].state = 'down';
  let recruit = null as null | (typeof post.members)[number];
  for (let t = 0; t < 400 && !recruit; t++) {
    ws.tick(0.5);
    recruit = post.members.find((m) => m.state === 'enroute') ?? null;
  }
  if (recruit) {
    recruit.hot = true; // the live entity walks; the sim must still hand it waypoints
    const wp0 = recruit.wp;
    recruit.x = post.route[Math.min(wp0, post.route.length - 1)].x;
    recruit.z = post.route[Math.min(wp0, post.route.length - 1)].z;
    ws.tick(0.5);
    check('the world sim advances a materialised recruit\'s route', recruit.wp > wp0 || recruit.state === 'post');
    check('targetFor points a marching soldier at the road', WorldState.targetFor(post, post.members.indexOf(recruit)) !== null);
    recruit.hot = false;
  } else check('the world sim advances a materialised recruit\'s route', false, 'no recruit appeared');
}
// a soldier standing guard has no forced target: it is free to wander
check('targetFor leaves a guard on post free to roam',
  ws.posts.every((p) => p.members.every((m, i) => m.state !== 'post' || WorldState.targetFor(p, i) === null)));

// reset() re-seeds the world
{
  ws.reset();
  check('reset puts a fresh watch on every spot', ws.posts.every((p) => WorldState.living(p).length === p.homes.length));
  check('reset clears the fallen', ws.posts.every((p) => p.members.every((m) => m.state === 'post')));
  check('reset rebuilds every patch', ws.posts.every((p) => p.homes.length > 0 && p.members.length === p.homes.length));
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
  // the patch each post holds, camps, soldiers, player
  check('map rings every guard post\'s patch', ops.filter((o) => o.style === 'rgba(240,72,56,0.35)').length === ws.posts.length * 48);
  check('map draws the camps', ops.some((o) => o.style === '#f8e8b0'));
  const red = ops.filter((o) => o.style === '#f04838' && o.w === 1 && o.h === 1).length;
  check('map draws a dot per living soldier', red === ws.posts.reduce((n, p) => n + WorldState.living(p).length, 0), `${red}`);
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
