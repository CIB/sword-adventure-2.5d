// Giant ladybugs: the lush-country spawner that keeps them common in the green parts of the world,
// and the wing-clap — a charged-up gust of wind that shoves everything in front of the beetle and
// hurts nobody. Driven here the way Game.update drives them (a live Enemy per bug, a real Player,
// the same GameCtx the soldier tests use), with a tryHitPlayer that counts its calls so "no damage"
// means the AI never even asked.
// Run: npx esbuild test/ladybug.test.ts --bundle --platform=node --format=esm | node --input-type=module
import * as THREE from 'three';
import { World } from '../src/game/world';
import { Enemy, Player, Projectile, fxGust, type GameCtx } from '../src/game/entities';
import { Wildlife } from '../src/game/wildlife';
import { buildSoldier, GUST_RANGE } from '../src/game/models';
import { RNG, MAX_HP, FACING_VEC } from '../src/game/constants';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

const world = new World();
const DT = 1 / 30;
const NO_INPUT = { moveX: 0, moveZ: 0, down: () => false, justPressed: () => false } as never;

/** a GameCtx with no renderer, plus a tally of every time something tried to hurt the heroine */
function makeCtx(playerX: number, playerZ: number) {
  const rng = new RNG(1234);
  const noop = () => {};
  const audio = new Proxy({}, { get: () => noop }) as never;
  const hits: number[] = [];
  const ctx = {
    world, scene: new THREE.Scene(), audio, rand: () => rng.next(), talking: false,
    enemies: [] as Enemy[], projectiles: [] as Projectile[],
    spawnProjectile: noop, spawnEffect: noop,
    // the real Game applies the damage; here we only record that somebody asked for it
    tryHitPlayer: (dmg: number) => { hits.push(dmg); return 'hit' as const; },
  } as unknown as GameCtx;
  const player = new Player(ctx, playerX, playerZ);
  (ctx as { player: Player }).player = player;
  return { ctx, player, hits };
}

// ============================================================ the lushness field
// The spawner's whole rulebook is World.lushness: green country spawns bugs, dry country doesn't.
check('home meadow is lush country', world.lushness(44.5, 38.5) > 0.8, world.lushness(44.5, 38.5).toFixed(2));
check('Willowmere wood floor is lush', world.lushness(86.5, 24.5) > 0.8, world.lushness(86.5, 24.5).toFixed(2));
check('the farmland is lush', world.lushness(86.5, 140.5) > 0.8, world.lushness(86.5, 140.5).toFixed(2));
check('the moor is not', world.lushness(172.5, 84.5) < 0.4, world.lushness(172.5, 84.5).toFixed(2));
check('the mesa is not', world.lushness(87.5, 61.5) < 0.4, world.lushness(87.5, 61.5).toFixed(2));
check('the highland is not', world.lushness(185.5, 15.5) < 0.4, world.lushness(185.5, 15.5).toFixed(2));
// a road through the meadow is green country either side, but not somewhere a beetle lives
const pathTile = (() => {
  for (let z = 30; z < 50; z++) for (let x = 30; x < 60; x++) if (world.tile(x, z) === 1 && world.lushness(x + 0.5, z + 0.5) < 0.6) return { x: x + 0.5, z: z + 0.5 };
  return null;
})();
check('a road through the meadow is not spawning ground', !!pathTile, pathTile ? `(${pathTile.x},${pathTile.z}) lush=${world.lushness(pathTile.x, pathTile.z).toFixed(2)}` : 'no path found');

// ============================================================ the model
const size = (o: THREE.Object3D, precise = false) => new THREE.Box3().setFromObject(o, precise);
const bugModel = buildSoldier('ladybug');
check('the ladybug has two separately hinged wing covers', !!bugModel.elytronL && !!bugModel.elytronR && bugModel.elytronL !== bugModel.elytronR);
check('...and hindwings to beat under them', !!bugModel.hindwingL && !!bugModel.hindwingR);
check('...and a ground tell for the gust', !!bugModel.gustArc);
check('the wing covers are shut at rest', Math.abs(bugModel.elytronL!.rotation.z) < 0.1);
{
  // "giant" means the size of a soldier — and a beetle that stands on its own six feet. The gust
  // tell is a three-tile cone lying on the floor, so it comes off before anything is measured.
  bugModel.root.remove(bugModel.gustArc!);
  const bug = size(bugModel.root), soldier = size(buildSoldier('sword').root);
  const h = bug.max.y - bug.min.y, w = bug.max.x - bug.min.x, l = bug.max.z - bug.min.z;
  check('it stands on the ground', Math.abs(bug.min.y) < 0.06, `min.y=${bug.min.y.toFixed(3)}`);
  check('it is a big bug, but no bigger than a soldier', h > 0.8 && h < soldier.max.y - soldier.min.y + 0.1, `bug=${h.toFixed(2)} soldier=${(soldier.max.y - soldier.min.y).toFixed(2)}`);
  check('...and it is a broad, low thing rather than a tall one', w > 1 && l > 1.2 && l > h, `w=${w.toFixed(2)} l=${l.toFixed(2)} h=${h.toFixed(2)}`);
  // the clap: the covers hinge up off the body, so the beetle stands taller with them open
  const shutCover = size(bugModel.elytronL!);
  bugModel.elytronL!.rotation.z = 1.25;
  bugModel.elytronR!.rotation.z = -1.25;
  const open = size(bugModel.root), openCover = size(bugModel.elytronL!);
  check('the beetle stands taller with its shell open', open.max.y > bug.max.y + 0.15,
    `h=${(bug.max.y - bug.min.y).toFixed(2)}->${(open.max.y - open.min.y).toFixed(2)}`);
  check('...because the covers swing clear up off its back', openCover.max.y > shutCover.max.y + 0.2,
    `cover top ${shutCover.max.y.toFixed(2)} -> ${openCover.max.y.toFixed(2)}`);
  // ...and the open shell is what the hindwings beat under
  check('the hindwings sit under the shell and swing with it', bugModel.hindwingL!.position.y < shutCover.max.y);
  // with the shell shut again: the covers meet on the midline and nothing pokes out of them
  bugModel.elytronL!.rotation.z = 0;
  bugModel.elytronR!.rotation.z = 0;
  const coverL = size(bugModel.elytronL!, true), coverR = size(bugModel.elytronR!, true);
  check('the two covers meet along the midline', Math.abs(coverL.min.x) < 0.02 && Math.abs(coverR.max.x) < 0.02,
    `L.min.x=${coverL.min.x.toFixed(3)} R.max.x=${coverR.max.x.toFixed(3)}`);
  const hind = size(bugModel.hindwingL!, true).union(size(bugModel.hindwingR!, true));
  check('the hindwings fold away inside the shut shell', coverL.union(coverR).containsBox(hind));
}

// ============================================================ the wing-clap
// A beetle two and a half tiles in front of the heroine: in range of the gust, right in its cone.
{
  const { ctx, player, hits } = makeCtx(44.5, 41.5);
  const bug = new Enemy(ctx, 'ladybug', 44.5, 39.1);
  ctx.enemies.push(bug);
  const pz0 = player.pos.z;
  let sawWindup = false, sawAttack = false, maxOpen = 0, sawArc = false;
  for (let i = 0; i < Math.round(2.2 / DT); i++) {
    bug.update(DT);
    player.update(DT, NO_INPUT);
    if (bug.state === 'windup') { sawWindup = true; sawArc = sawArc || !!bug.model.gustArc?.visible; }
    if (bug.state === 'attack') sawAttack = true;
    maxOpen = Math.max(maxOpen, bug.model.elytronL?.rotation.z ?? 0);
  }
  check('the beetle charges before it flaps', sawWindup && sawAttack);
  check('its wing covers swing right open for the charge', maxOpen > 1, `open=${maxOpen.toFixed(2)}`);
  check('it paints the gust cone on the ground while it charges', sawArc);
  check('the gust shoves the heroine away from it', player.pos.z > pz0 + 0.5, `moved ${(player.pos.z - pz0).toFixed(2)} tiles`);
  check('...without hurting her', player.hp === MAX_HP, `hp=${player.hp}`);
  check('...and without ever asking to', hits.length === 0, `tryHitPlayer called ${hits.length}x`);
  check('the gust reaches as far as its ground tell promises', Math.abs(player.pos.z - pz0) <= GUST_RANGE);
}

// Facing matters: a beetle charged up with the heroine at its back leaves her alone.
{
  const { ctx, player, hits } = makeCtx(44.5, 38.0);
  const bug = new Enemy(ctx, 'ladybug', 44.5, 41.0);
  bug.facing = 4; // looking north, away from her
  ctx.enemies.push(bug);
  const pz0 = player.pos.z;
  for (let i = 0; i < Math.round(0.6 / DT); i++) bug.update(DT);
  check('a gust thrown the other way leaves her standing', Math.abs(player.pos.z - pz0) < 0.05 && player.hp === MAX_HP && hits.length === 0);
}

// Everything in the cone goes, not just the heroine: soldiers are blown off their feet, and an arrow
// in the air is turned around and sent back where it came from.
{
  const { ctx, player } = makeCtx(60.5, 41.0);
  const bug = new Enemy(ctx, 'ladybug', 60.5, 38.6);
  bug.facing = 0; // due south, at the soldier and the player
  ctx.enemies.push(bug);
  const soldier = new Enemy(ctx, 'sword', 61.6, 40.6);
  ctx.enemies.push(soldier);
  // get the beetle into its flap without touching the soldier's own AI
  bug.state = 'attack'; bug.stateT = 0.2; bug.fired = false;
  const sx0 = soldier.pos.x, sz0 = soldier.pos.z;
  const arrow = new Projectile(ctx, 'arrow', 60.5, 40.8, { x: 0, z: -1 }, 1); // inbound, toward the beetle
  ctx.projectiles.push(arrow);
  bug.update(DT);
  check('the gust blows a soldier off its feet', soldier.knockT > 0 && Math.hypot(soldier.knock.x, soldier.knock.z) > 0, `knock=${soldier.knock.x.toFixed(1)},${soldier.knock.z.toFixed(1)}`);
  check('...pushing it away from the beetle', soldier.knock.z > 0 && Math.hypot(soldier.pos.x - sx0, soldier.pos.z - sz0) < 0.1);
  check('an arrow in flight is blown back the way it came', arrow.dir.z > 0 && arrow.alive, `dir.z=${arrow.dir.z.toFixed(2)}`);
  // the beetle gets its reach from the model, and the model from the AI: one number, two uses
  const far = new Enemy(ctx, 'sword', 60.5, 38.6 + GUST_RANGE + 0.6);
  far.knockT = 0;
  ctx.enemies.push(far);
  bug.state = 'attack'; bug.stateT = 0.2; bug.fired = false;
  bug.update(DT);
  check('...but not what is out of reach', far.knockT <= 0);
}

// ============================================================ the wind itself
// The effects are pure scene graph (no renderer needed): build one and play it out, checking that
// the cone of wind really does reach as far as the AI's gust does.
{
  const fx = fxGust(44.5, 38.5, 0, GUST_RANGE);
  let frames = 0, far = 0;
  while (fx.update(DT) && frames < 200) {
    frames++;
    const b = new THREE.Box3().setFromObject(fx.group, true);
    far = Math.max(far, Math.abs(b.min.x - 44.5), Math.abs(b.max.x - 44.5), Math.abs(b.min.z - 38.5), Math.abs(b.max.z - 38.5));
  }
  check('the blast effect plays out and cleans up', frames > 10 && frames < 200, `${frames} frames`);
  check('the wind reaches exactly as far as the gust that hurts nobody', far >= GUST_RANGE * 0.9 && far <= GUST_RANGE * 1.35, `reach=${far.toFixed(2)} vs ${GUST_RANGE}`);
}

// ============================================================ the population
// Lush country stocks itself with ladybugs; the dry parts of the world do not.
function runWildlife(seconds: number, x: number, z: number, viewR = 26) {
  const { ctx, player } = makeCtx(x, z);
  const wildlife = new Wildlife(ctx);
  // where each new bug was put down, recorded the frame it appears (they wander off green ground
  // soon enough — the law is about where they are *seeded*, not where a beetle ends up strolling)
  const spawned: { x: number; z: number; dist: number }[] = [];
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    const before = wildlife.bugs.length;
    wildlife.update(DT, viewR);
    for (const e of ctx.enemies) e.update(DT);
    if (wildlife.bugs.length > before) {
      const b = wildlife.bugs[wildlife.bugs.length - 1];
      spawned.push({ x: b.pos.x, z: b.pos.z, dist: Math.hypot(b.pos.x - x, b.pos.z - z) });
    }
  }
  return { ctx, player, wildlife, spawned };
}
{
  const { wildlife, spawned } = runWildlife(60, 44.5, 38.5);
  check('the meadow lives up to its name: ladybugs move in', wildlife.bugs.length >= 3, `${wildlife.bugs.length} bugs`);
  check('they keep arriving', spawned.length >= 3, `${spawned.length} arrivals`);
  check('every one of them arrives on green ground', spawned.every((s) => world.lushness(s.x, s.z) >= 0.6),
    spawned.map((s) => world.lushness(s.x, s.z).toFixed(2)).join(' '));
  const v = world.village;
  check('...outside the village', spawned.every((s) => s.x < v.x0 - 3 || s.x > v.x1 + 3 || s.z < v.z0 - 3 || s.z > v.z1 + 3));
  check('...and out of sight of the player', spawned.every((s) => s.dist > 24), spawned.map((s) => s.dist.toFixed(0)).join(' '));
  const cap = wildlife.bugs.length;
  for (let i = 0; i < Math.round(30 / DT); i++) wildlife.update(DT, 26);
  check('the population settles rather than piling up', wildlife.bugs.length <= 6, `${cap} -> ${wildlife.bugs.length}`);
}
{
  const { wildlife } = runWildlife(90, 172.5, 84.5);
  check('the moor has none to offer', wildlife.bugs.length === 0, `${wildlife.bugs.length} bugs`);
}
{
  const { wildlife } = runWildlife(90, 33, 155);
  check('the southern woods are alive with them', wildlife.bugs.length >= 3, `${wildlife.bugs.length} bugs`);
}
{
  // walk out of the green: the ones left behind are released, not followed
  const { ctx, wildlife } = runWildlife(40, 44.5, 38.5);
  const before = wildlife.bugs.length;
  (ctx as { player: Player }).player.pos = { x: 178, z: 22 };
  for (let i = 0; i < Math.round(90 / DT); i++) wildlife.update(DT, 26);
  check('bugs left behind in the old country are let go', before > 0 && wildlife.bugs.length === 0 && ctx.enemies.every((e) => !e.alive || e.kind !== 'ladybug'), `${before} -> ${wildlife.bugs.length}`);
}
{
  const { ctx } = runWildlife(40, 44.5, 38.5);
  const bugs = ctx.enemies.filter((e) => e.kind === 'ladybug');
  const bug = bugs[0];
  check('a ladybug is a soft target that leaves nothing to chance', gapCheck(bug));
}
function gapCheck(bug: Enemy) {
  // three hits of a normal swing kill it, and it never damages anyone by attacking
  let dead = false;
  for (let i = 0; i < 3 && !dead; i++) dead = bug.hurt(1, bug.pos.x, bug.pos.z - 1);
  return dead && bug.st.dmg === 0;
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall good');
if (failures) process.exit(1);
