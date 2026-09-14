// Node-side validation of the live soldier AI: the materialised half of the guard-post system.
// Soldiers are driven here exactly the way Game.updateWorld drives them — a live Enemy per world
// soldier, `follow` handed to it every frame from WorldState.targetFor, positions mirrored back —
// so this covers the leash that keeps a guard on its own patch, the loose wander of a spread post,
// the tight knot on a bridge, and a replacement marching the road in from off the map.
// Run: npx esbuild test/guards.test.ts --bundle --platform=node --format=esm | node --input-type=module
import * as THREE from 'three';
import { World } from '../src/game/world';
import { WorldState } from '../src/game/worldstate';
import { Enemy, Player, type GameCtx } from '../src/game/entities';
import { RNG } from '../src/game/constants';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

const world = new World();
const ws = new WorldState(world);
const rng = new RNG(7);

// a GameCtx with no renderer: everything the soldiers touch is the world, the scene graph and a stub
const noop = () => {};
const audio = new Proxy({}, { get: () => noop }) as never;
const ctx = {
  world,
  scene: new THREE.Scene(),
  audio,
  rand: () => rng.next(),
  talking: false,
  enemies: [] as Enemy[],
  spawnProjectile: noop,
  spawnEffect: noop,
  tryHitPlayer: () => 'immune' as const,
} as unknown as GameCtx;
// the player stays home in the village: nobody spots her, so every soldier keeps to its own business
(ctx as { player: Player }).player = new Player(ctx, world.playerStart.x, world.playerStart.z);

const DT = 1 / 30;
/** materialise a post's watch and drive it for `seconds`, mirroring positions like the Game does */
const run = (postIndex: number, seconds: number, start: { x: number; z: number }[]) => {
  const post = ws.posts[postIndex];
  const enemies = post.members.map((m, i) => {
    // exactly what Game.updateWorld does: stand the entity on the nearest clear tile
    const spot = world.nearestFree(start[i].x, start[i].z);
    m.hot = true;
    m.x = spot.x; m.z = spot.z;
    return new Enemy(ctx, m.kind, spot.x, spot.z, post, i);
  });
  const trail: number[] = enemies.map(() => 0);
  for (let t = 0; t < Math.round(seconds / DT); t++) {
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i], m = post.members[i];
      e.follow = WorldState.targetFor(post, i);
      const ox = e.pos.x, oz = e.pos.z;
      e.update(DT);
      trail[i] += Math.hypot(e.pos.x - ox, e.pos.z - oz);
      m.x = e.pos.x; m.z = e.pos.z; // the live entity is the authority
    }
    ws.tick(DT);
  }
  for (const e of enemies) e.dispose();
  return { post, enemies, trail };
};

const offCentre = (p: { cx: number; cz: number; rx: number; rz: number }, x: number, z: number) =>
  Math.hypot((x - p.cx) / p.rx, (z - p.cz) / p.rz);
const name = (n: string) => ws.posts.findIndex((p) => p.name === n);

// ---- a spread post roams its patch and never leaves it
{
  const i = name('Willowmere Patrol');
  const start = ws.posts[i].members.map((m) => ({ x: m.x, z: m.z }));
  const { post, enemies, trail } = run(i, 120, start);
  const strayed = enemies.map((e) => offCentre(post, e.pos.x, e.pos.z));
  const worst = Math.max(...strayed);
  const walked = Math.min(...trail);
  console.log(`INFO ${post.name}: furthest ${worst.toFixed(2)} of the patch radius out, walked ${trail.map((t) => t.toFixed(0)).sort((a, b) => +a - +b).join('/')} tiles`);
  check('spread guards stay inside the patch they guard', worst <= 1.02, `worst ${worst.toFixed(2)}`);
  check('spread guards patrol their patch (they all moved)', walked > 5, `${walked.toFixed(1)} tiles`);
  // spread out over the patch, the way hand-placed soldiers used to be — not bunched on one spot
  let spreadMax = 0, sumPair = 0, pairs = 0;
  for (let a = 0; a < enemies.length; a++) for (let b = a + 1; b < enemies.length; b++) {
    const d = Math.hypot(enemies[a].pos.x - enemies[b].pos.x, enemies[a].pos.z - enemies[b].pos.z);
    spreadMax = Math.max(spreadMax, d); sumPair += d; pairs++;
  }
  console.log(`INFO ${post.name}: guards ${Math.min(...enemies.map((e) => e.pos.x.toFixed(0)))}.. spread widest ${spreadMax.toFixed(1)}, mean gap ${(sumPair / pairs).toFixed(1)} tiles`);
  check('spread guards cover the patch, not one spot', spreadMax > Math.max(post.rx, post.rz) && sumPair / pairs > 8,
    `widest ${spreadMax.toFixed(1)}, mean gap ${(sumPair / pairs).toFixed(1)}`);
}

// ---- a bridge guard holds a thick knot on the deck
{
  const i = name('Great Bridge Guard');
  const start = ws.posts[i].members.map((m) => ({ x: m.x, z: m.z }));
  const { post, enemies, trail } = run(i, 120, start);
  const fromSpot = Math.max(...enemies.map((e, k) => Math.hypot(e.pos.x - post.members[k].hx, e.pos.z - post.members[k].hz)));
  const spread = Math.max(...enemies.map((e) => Math.hypot(e.pos.x - post.cx, e.pos.z - post.cz)));
  console.log(`INFO ${post.name}: ${fromSpot.toFixed(1)} tiles from spot, knot ${spread.toFixed(1)} tiles across the centre`);
  check('bridge guards hold a tight knot', spread < 6, `${spread.toFixed(1)} tiles`);
  check('bridge guards shift their feet but hold the bridge', fromSpot < 3.5 && Math.min(...trail) > 0.5);
}

// ---- a guard that strayed out (after a chase) walks back onto its own ground
{
  const i = name('Meadow Watch');
  const post = ws.posts[i];
  // a chase can drag a guard this far out; put it on open, reachable ground (not inside a thicket)
  const roomy = (x: number, z: number) => {
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (world.isSolidTile(x + dx, z + dz)) return false;
    return true;
  };
  let away: { x: number; z: number } | null = null;
  for (let r = post.rx + 6; r < post.rx + 22 && !away; r++) {
    for (const z of [post.cz, post.cz - 3, post.cz + 3, post.cz - 6, post.cz + 6]) {
      const x = Math.floor(post.cx + r), zz = Math.floor(z);
      if (roomy(x, zz)) { away = { x: x + 0.5, z: zz + 0.5 }; break; }
    }
  }
  check('found open ground outside the patch to stray to', !!away, away ? `${away.x},${away.z}` : 'none');
  const start = post.members.map((m, k) => (k === 0 ? away! : { x: m.x, z: m.z }));
  const { enemies } = run(i, 60, start);
  const back = offCentre(post, enemies[0].pos.x, enemies[0].pos.z);
  console.log(`INFO strayed guard came back to ${back.toFixed(2)} of the patch radius`);
  check('a guard that strayed walks back to its patch', back <= 1.02, `${back.toFixed(2)}`);
}

// ---- a replacement marches in from off the map and takes up its post
{
  const i = name('Crown Hollow Guard');
  const post = ws.posts[i];
  post.members[0].state = 'down';
  // the world sim sends for a replacement
  let idx = -1;
  for (let t = 0; t < 400 && idx < 0; t++) {
    ws.tick(0.5);
    idx = post.members.findIndex((m) => m.state === 'enroute');
  }
  check('a replacement is on the road', idx >= 0);
  if (idx >= 0) {
    const m = post.members[idx];
    m.hot = true;
    const e = new Enemy(ctx, m.kind, m.x, m.z, post, idx);
    const from = Math.hypot(m.x - post.cx, m.z - post.cz);
    let arrived = false, walked = 0, onRoad = true;
    for (let t = 0; t < Math.round(600 / DT) && !arrived; t++) {
      e.follow = WorldState.targetFor(post, idx);
      const ox = e.pos.x, oz = e.pos.z;
      e.update(DT);
      walked += Math.hypot(e.pos.x - ox, e.pos.z - oz);
      m.x = e.pos.x; m.z = e.pos.z;
      ws.tick(DT);
      arrived = m.state === 'post' && e.follow === null;
    }
    const to = Math.hypot(m.x - post.cx, m.z - post.cz);
    console.log(`INFO replacement walked ${walked.toFixed(0)} tiles, ${from.toFixed(0)} out -> ${to.toFixed(1)} from the post centre`);
    check('the replacement walks the road in from the map edge', walked > from * 0.6 && to < from);
    check('the replacement arrives and takes up the post', arrived);
    check('he ends up inside the patch he was sent to', offCentre(post, m.x, m.z) <= 1.02, offCentre(post, m.x, m.z).toFixed(2));
    void onRoad;
    e.dispose();
  }
}

/* ---- every post: nobody wedged, nobody wandering off, nobody marching the roads ---- */
{
  const wedged: string[] = [], strayed: string[] = [], onRoads: string[] = [];
  let spreadWorst = 0, tightWorst = 0;
  for (const post of ws.posts) {
    const es: { e: Enemy; m: WorldSoldier; walked: number; worst: number }[] = [];
    for (let i = 0; i < post.members.length; i++) {
      const m = post.members[i];
      m.state = 'post'; m.x = m.hx; m.z = m.hz;
      es.push({ e: new Enemy(ctx, m.kind, m.x, m.z, post, i), m, walked: 0, worst: 0 });
    }
    for (let t = 0; t < Math.round(90 / DT); t++) {
      for (const g of es) {
        g.e.follow = WorldState.targetFor(post, post.members.indexOf(g.m));
        const ox = g.e.pos.x, oz = g.e.pos.z;
        g.e.update(DT);
        g.walked += Math.hypot(g.e.pos.x - ox, g.e.pos.z - oz);
        g.m.x = g.e.pos.x; g.m.z = g.e.pos.z;
        // how far outside the ground it guards: the patch for a roaming post, its own tile for a knot
        const k = post.tight
          ? Math.hypot(g.e.pos.x - g.m.hx, g.e.pos.z - g.m.hz) / 2.2
          : offCentre(post, g.e.pos.x, g.e.pos.z);
        if (k > g.worst) g.worst = k;
      }
      ws.tick(DT);
    }
    for (const g of es) {
      if (post.tight) { if (g.worst > tightWorst) tightWorst = g.worst; }
      else if (g.worst > spreadWorst) spreadWorst = g.worst;
      if (g.walked < (post.tight ? 0.2 : 0.5)) wedged.push(`${post.name} (${g.walked.toFixed(1)})`);
      if (g.worst > 1.06) strayed.push(`${post.name} (${g.worst.toFixed(2)})`);
      const t = world.tile(Math.floor(g.e.pos.x), Math.floor(g.e.pos.z));
      if (!post.tight && (t === 'path' || t === 'bridge' || t === 'cobble')) onRoads.push(post.name);
    }
    for (const g of es) g.e.dispose();
  }
  console.log(`INFO all ${ws.posts.length} posts: spread guards reach ${spreadWorst.toFixed(2)} of their patch, knot guards ${tightWorst.toFixed(2)} of their leash`);
  check('no guard is wedged in place anywhere on the map', wedged.length === 0, wedged.join(', '));
  check('no guard wanders out of the ground it guards', strayed.length === 0, strayed.join(', '));
  check('roaming guards are not standing on the roads', onRoads.length === 0, onRoads.join(', '));
}

console.log(failures ? `\n${failures} FAILURES` : '\nALL TESTS PASSED');
process.exit(failures ? 1 : 0);
