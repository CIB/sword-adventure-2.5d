// Spitflowers: the rooted flower of the woods. A big head on a long, flexible stalk that turns after
// the heroine and spits a slow energy ball at her; it grows only on the forest floor under the trees
// (the wildlife spawner, alongside the ladybugs) and it never takes a step. Driven here the way
// Game.update drives them — a live Enemy, a real Player, projectiles ticked by hand — with a
// tryHitPlayer that records every blow.
// Run: npx esbuild test/spitflower.test.ts --bundle --platform=node --format=esm | node --input-type=module
import * as THREE from 'three';
import { World } from '../src/game/world';
import { Enemy, Player, Projectile, type GameCtx, type ProjectileKind } from '../src/game/entities';
import { Wildlife } from '../src/game/wildlife';
import { buildSoldier, FLOWER_MOUTH_H, isRooted } from '../src/game/models';
import { RNG, MAX_HP } from '../src/game/constants';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

const world = new World();
const DT = 1 / 30;

function makeCtx(playerX: number, playerZ: number) {
  const rng = new RNG(4321);
  const noop = () => {};
  const audio = new Proxy({}, { get: () => noop }) as never;
  const hits: number[] = [];
  const ctx = {
    world, scene: new THREE.Scene(), audio, rand: () => rng.next(), talking: false,
    enemies: [] as Enemy[], projectiles: [] as Projectile[],
    spawnProjectile: (kind: ProjectileKind, x: number, z: number, dx: number, dz: number, dmg: number) => { ctx.projectiles.push(new Projectile(ctx, kind, x, z, { x: dx, z: dz }, dmg)); },
    spawnEffect: noop,
    tryHitPlayer: (dmg: number, sx: number, sz: number) => { hits.push(dmg); (ctx as { player: Player }).player.hurt(dmg, sx, sz); return 'hit' as const; },
  } as unknown as GameCtx;
  const player = new Player(ctx, playerX, playerZ);
  (ctx as { player: Player }).player = player;
  return { ctx, player, hits };
}
const tick = (ctx: GameCtx, dt = DT) => {
  for (const e of ctx.enemies) e.update(dt);
  for (const p of ctx.projectiles) p.update(dt);
  ctx.projectiles = ctx.projectiles.filter((p) => p.alive);
};

// ============================================================ the model
{
  const m = buildSoldier('spitflower');
  check('the flower is a chain of stalk segments with a head on the tip', !!m.stalk && m.stalk.length >= 4 && m.head.parent === m.stalk[m.stalk.length - 1]);
  check('...each segment hung off the one before, so bending one bends everything above it',
    !!m.stalk && m.stalk.every((s, i) => i === 0 || s.parent === m.stalk![i - 1]));
  check('the head carries a ring of petals and a mouth', !!m.petals && m.petals.length >= 6 && !!m.mouth && m.mouth.parent === m.head);
  const box = new THREE.Box3().setFromObject(m.root, true);
  check('it stands tall — well over the heroine\'s head', box.max.y > 1.5, `top at ${box.max.y.toFixed(2)}`);
  check('the mouth sits about where the energy ball leaves from', Math.abs(m.mouth!.getWorldPosition(new THREE.Vector3()).y - FLOWER_MOUTH_H) < 0.25,
    `mouth y=${m.mouth!.getWorldPosition(new THREE.Vector3()).y.toFixed(2)} vs ${FLOWER_MOUTH_H}`);
  check('it is the rooted kind', isRooted('spitflower') && !isRooted('ladybug'));
}

// ============================================================ turning its head
{
  const { ctx, player } = makeCtx(50.5, 38.5); // due east of it
  const f = new Enemy(ctx, 'spitflower', 44.5, 38.5);
  f.facing = 4; f.headYaw = Math.PI; // looking north
  ctx.enemies.push(f);
  const x0 = f.pos.x, z0 = f.pos.z;
  const yaws: number[] = [];
  for (let i = 0; i < Math.round(1.6 / DT); i++) { tick(ctx); yaws.push(f.headYaw); }
  const want = Math.atan2(player.pos.x - f.pos.x, player.pos.z - f.pos.z);
  check('it notices her and swings its head round to face her', Math.abs(f.headYaw - want) < 0.05, `yaw ${f.headYaw.toFixed(2)} want ${want.toFixed(2)}`);
  check('...smoothly, over several frames, not in one snap', new Set(yaws.map((y) => y.toFixed(2))).size > 8, `${new Set(yaws.map((y) => y.toFixed(2))).size} distinct yaws`);
  check('...without moving off its roots', f.pos.x === x0 && f.pos.z === z0);
  check('the stalk (not the roots) is what turned', Math.abs(f.model.body.rotation.y - f.headYaw) < 1e-6 && f.model.root.rotation.y === 0);
  // walk round behind it: it keeps turning after her
  player.pos = { x: 44.5, z: 32.5 };
  for (let i = 0; i < Math.round(2 / DT); i++) tick(ctx);
  check('walk round it and the head follows', Math.abs(Math.abs(f.headYaw) - Math.PI) < 0.1, `yaw ${f.headYaw.toFixed(2)}`);
}

// ============================================================ the spit
{
  const { ctx, player, hits } = makeCtx(44.5, 43.5); // 5 tiles south, in range
  const f = new Enemy(ctx, 'spitflower', 44.5, 38.5);
  f.facing = 0; f.headYaw = 0;
  ctx.enemies.push(f);
  let firstShot = -1, windupSeen = false, glowSeen = false;
  const hp0 = player.hp;
  for (let i = 0; i < Math.round(6 / DT); i++) {
    tick(ctx);
    if (f.state === 'windup') { windupSeen = true; if (f.chargeP > 0.5) glowSeen = true; }
    if (firstShot < 0 && ctx.projectiles.length) firstShot = i * DT;
  }
  check('it charges up (a visible wind-up) before it spits', windupSeen && glowSeen);
  check('it spits an energy ball', firstShot > 0, `first shot at ${firstShot.toFixed(2)}s`);
  check('the ball reaches her and costs half a heart', hits.length >= 1 && hits[0] === 1 && player.hp < hp0, `hp ${hp0} -> ${player.hp}, ${hits.length} hit(s)`);
  check('...more than once given the time', hits.length >= 2, `${hits.length} hits in 6s`);
  const flowerMoved = Math.hypot(f.pos.x - 44.5, f.pos.z - 38.5);
  check('and it has not left the spot it grew on', flowerMoved < 1e-6);
}

// The ball flies along where the head was pointed: a sidestep late in the charge is the answer.
{
  const { ctx, player, hits } = makeCtx(44.5, 44.5);
  const f = new Enemy(ctx, 'spitflower', 44.5, 38.5);
  f.facing = 0; f.headYaw = 0;
  ctx.enemies.push(f);
  let dodged = false;
  for (let i = 0; i < Math.round(4 / DT); i++) {
    // once the flower has committed to its aim, step well out of the line
    if (f.state === 'windup' && f.stateT < 0.2 && !dodged) { player.pos = { x: 47.5, z: 44.5 }; dodged = true; }
    tick(ctx);
  }
  check('a step out of the line once it has committed leaves her untouched', dodged && hits.length === 0 && player.hp === MAX_HP, `${hits.length} hit(s)`);
}

// Out of range it only watches; out of sight it loses interest.
{
  const { ctx, hits } = makeCtx(44.5, 38.5 + 8.6);
  const f = new Enemy(ctx, 'spitflower', 44.5, 38.5);
  ctx.enemies.push(f);
  for (let i = 0; i < Math.round(5 / DT); i++) tick(ctx);
  check('she can stand just out of range and watch it glare', hits.length === 0 && ctx.projectiles.length === 0 && (f.state === 'ranged' || f.state === 'alert'), `state ${f.state}`);
}

// Rooted: a sword blow hurts it but never shoves it, and a beetle's gust does not budge it either.
{
  const { ctx } = makeCtx(44.5, 40.0);
  const f = new Enemy(ctx, 'spitflower', 44.5, 38.5);
  ctx.enemies.push(f);
  const dead1 = f.hurt(1, 44.5, 40.0);
  for (let i = 0; i < 10; i++) tick(ctx);
  check('a blow lands and it stays put', !dead1 && f.hp === 2 && f.pos.x === 44.5 && f.pos.z === 38.5);
  const bug = new Enemy(ctx, 'ladybug', 44.5, 36.5); bug.facing = 0; // due south, at the flower
  ctx.enemies.push(bug);
  bug.state = 'attack'; bug.stateT = 0.2; bug.fired = false;
  bug.update(DT);
  check('a ladybug\'s gust does not blow a rooted flower over', f.knockT <= 0 && f.pos.z === 38.5);
  let dead = false;
  for (let i = 0; i < 2 && !dead; i++) dead = f.hurt(1, 44.5, 40.0);
  check('three swings and it is cut down', dead && !f.alive);
}

// The energy ball itself: it can be cut out of the air, and it pops against a wall.
{
  const { ctx } = makeCtx(60.5, 60.5);
  const ball = new Projectile(ctx, 'energy', 44.5, 38.5, { x: 0, z: 1 }, 1);
  ctx.projectiles.push(ball);
  check('the energy ball is the one projectile a sword can cut', ball.cuttable && !new Projectile(ctx, 'arrow', 44.5, 38.5, { x: 0, z: 1 }, 1).cuttable);
  ball.update(DT);
  ball.burst();
  check('...and it bursts when told to', !ball.alive);
  const slow = new Projectile(ctx, 'energy', 0, 0, { x: 1, z: 0 }, 1);
  const arrow = new Projectile(ctx, 'arrow', 0, 0, { x: 1, z: 0 }, 1);
  check('it is a slow ball, easier to read than an arrow', slow.speed < arrow.speed * 0.7, `${slow.speed} vs ${arrow.speed}`);
}

// ============================================================ the population
// The woods grow spitflowers; the open meadow, however green, does not.
function runWildlife(seconds: number, x: number, z: number, viewR = 26) {
  const { ctx, player } = makeCtx(x, z);
  const wildlife = new Wildlife(ctx);
  const seeded: { x: number; z: number; dist: number }[] = [];
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    const before = wildlife.flowers.length;
    wildlife.update(DT, viewR);
    for (const e of ctx.enemies) e.update(DT);
    if (wildlife.flowers.length > before) {
      const f = wildlife.flowers[wildlife.flowers.length - 1];
      seeded.push({ x: f.pos.x, z: f.pos.z, dist: Math.hypot(f.pos.x - x, f.pos.z - z) });
    }
  }
  return { ctx, player, wildlife, seeded };
}
{
  const { wildlife, seeded } = runWildlife(60, 86.5, 24.5); // Willowmere Woods
  check('the woods grow spitflowers', wildlife.flowers.length >= 3, `${wildlife.flowers.length} flowers`);
  check('every one of them on forest floor under the trees', seeded.every((s) => world.forested(Math.floor(s.x), Math.floor(s.z))));
  check('...out of sight of the player', seeded.every((s) => s.dist > 24), seeded.map((s) => s.dist.toFixed(0)).join(' '));
  check('...and spaced well apart', seeded.every((a, i) => seeded.every((b, j) => i === j || Math.hypot(a.x - b.x, a.z - b.z) >= 6.5)));
  check('the wood settles at a handful rather than a hedge of them', wildlife.flowers.length <= 4, `${wildlife.flowers.length}`);
  check('the ladybugs still come to the woods alongside them', wildlife.bugs.length >= 2, `${wildlife.bugs.length} bugs`);
}
{
  const { wildlife } = runWildlife(60, 33, 155); // the southern forest
  check('the southern forest has them too', wildlife.flowers.length >= 2, `${wildlife.flowers.length} flowers`);
}
{
  const { wildlife } = runWildlife(90, 172.5, 84.5); // the moor
  check('the moor grows none', wildlife.flowers.length === 0, `${wildlife.flowers.length} flowers`);
}
{
  // walk out of the woods: the ones left behind are released
  const { ctx, wildlife } = runWildlife(40, 86.5, 24.5);
  const before = wildlife.flowers.length;
  (ctx as { player: Player }).player.pos = { x: 178, z: 22 };
  for (let i = 0; i < Math.round(90 / DT); i++) wildlife.update(DT, 26);
  check('flowers left behind in the old wood are let go', before > 0 && wildlife.flowers.length === 0 && ctx.enemies.every((e) => !e.alive || !isRooted(e.kind)), `${before} -> ${wildlife.flowers.length}`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall good');
if (failures) process.exit(1);
