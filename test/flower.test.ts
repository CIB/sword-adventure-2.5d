// Spitflowers: the woods' answer to the ladybug — a big blossom on a long flexible stalk, rooted
// where it sprouts, turning its head to spit energy balls at passers-by. Driven here the way
// Game.update drives them (a live Enemy, a real Player, the same GameCtx the soldier tests use),
// with a tryHitPlayer that records every call so "one half-heart per spit" can be checked to the number.
// Run: npx esbuild test/flower.test.ts --bundle --platform=node --format=esm | node --input-type=module
import * as THREE from 'three';
import { World } from '../src/game/world';
import { Enemy, Player, Projectile, fxSpit, type GameCtx } from '../src/game/entities';
import { Wildlife } from '../src/game/wildlife';
import { buildSoldier, buildEnergyBall, isSpitflower, SPITFLOWER_HEAD_H, SPITFLOWER_PETALS } from '../src/game/models';
import { RNG, MAX_HP, Tile, normAngle } from '../src/game/constants';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

const world = new World();
const DT = 1 / 30;
const NO_INPUT = { moveX: 0, moveZ: 0, down: () => false, justPressed: () => false } as never;

/**
 * A GameCtx with no renderer, plus a tally of every time something tried to hurt the heroine. Where
 * the real Game decides whether a blow lands (Game.tryHitPlayer: shields, i-frames), this one records
 * the request and then lets the real Player take it — and unlike the ladybug harness it really spawns
 * projectiles, because the spit is the whole point here.
 */
function makeCtx(playerX: number, playerZ: number) {
  const rng = new RNG(99);
  const noop = () => {};
  const audio = new Proxy({}, { get: () => noop }) as never;
  const hits: number[] = [];
  const ctx = {
    world, scene: new THREE.Scene(), audio, rand: () => rng.next(), talking: false,
    enemies: [] as Enemy[], projectiles: [] as Projectile[],
    spawnProjectile: (kind: 'arrow' | 'javelin' | 'moblin_spear' | 'energy', x: number, z: number, dx: number, dz: number, dmg: number) => {
      ctx.projectiles.push(new Projectile(ctx as unknown as GameCtx, kind, x, z, { x: dx, z: dz }, dmg));
    },
    spawnEffect: noop,
    tryHitPlayer: (dmg: number, sx: number, sz: number) => { hits.push(dmg); (ctx as { player: Player }).player.hurt(dmg, sx, sz); return 'hit' as const; },
  } as unknown as GameCtx;
  const player = new Player(ctx, playerX, playerZ);
  (ctx as { player: Player }).player = player;
  return { ctx, player, hits };
}

// ============================================================ the model
const size = (o: THREE.Object3D, precise = false) => new THREE.Box3().setFromObject(o, precise);
const flowerModel = buildSoldier('spitflower');
check('the spitflower builds as a spitflower', isSpitflower('spitflower') && !isSpitflower('sword'));
check(`its head is ringed by ${SPITFLOWER_PETALS} hinged petals`, !!flowerModel.petals && flowerModel.petals.length === SPITFLOWER_PETALS,
  `${flowerModel.petals?.length ?? 0} petals`);
check('...with a mouth to spit through and a glow burning in it', !!flowerModel.mouth && !!flowerModel.mouthGlow);
check('the petals start cupped forward, not flung open', (flowerModel.petals![0].children[0].rotation.y) < 0,
  `rot.y=${flowerModel.petals![0].children[0].rotation.y.toFixed(2)}`);
{
  const f = size(flowerModel.root), soldier = size(buildSoldier('sword').root);
  const h = f.max.y - f.min.y, sh = soldier.max.y - soldier.min.y;
  check('it stands on the ground', Math.abs(f.min.y) < 0.06, `min.y=${f.min.y.toFixed(3)}`);
  check('it is a big flower: head and shoulders over a soldier', h > sh + 0.3,
    `flower ${h.toFixed(2)} vs soldier ${sh.toFixed(2)}`);
  check('...on a long stalk that holds the head well clear of the ferns',
    Math.abs(flowerModel.head.position.y - SPITFLOWER_HEAD_H) < 0.01 && SPITFLOWER_HEAD_H > 1.1,
    `head at ${flowerModel.head.position.y.toFixed(2)}`);
  const mouth = size(flowerModel.mouth!);
  check('...with the mouth facing out of the face, not buried in it',
    mouth.min.z > f.min.z + (f.max.z - f.min.z) * 0.55, `mouth z=${mouth.min.z.toFixed(2)} of ${f.min.z.toFixed(2)}..${f.max.z.toFixed(2)}`);
}
{
  const ball = buildEnergyBall();
  check('the energy ball is a glowing core in a shell', ball.children.length === 2);
  const fx = fxSpit(44.5, 38.5, 0);
  let frames = 0;
  while (fx.update(DT) && frames < 200) frames++;
  check('the spit flash plays out and cleans up', frames > 5 && frames < 200, `${frames} frames`);
}

// ============================================================ rooted, and turning its head
// A flower four tiles north of the heroine: well inside spit range, which is the whole test.
{
  const { ctx, player } = makeCtx(44.5, 43.0);
  const flower = new Enemy(ctx, 'spitflower', 44.5, 39.0);
  ctx.enemies.push(flower);
  const x0 = flower.pos.x, z0 = flower.pos.z;
  const yaw0 = flower.headYaw;
  let sawWindup = false, sawAttack = false, maxGlow = 0, minPetal = Infinity, maxPetal = -Infinity;
  for (let i = 0; i < Math.round(4 / DT); i++) {
    flower.update(DT);
    player.update(DT, NO_INPUT);
    for (const p of ctx.projectiles) p.update(DT);
    if (flower.state === 'windup') sawWindup = true;
    if (flower.state === 'attack') sawAttack = true;
    const glow = flower.model.mouthGlow!;
    maxGlow = Math.max(maxGlow, glow.scale.x);
    const petal = flower.model.petals![0].children[0];
    minPetal = Math.min(minPetal, petal.rotation.y);
    maxPetal = Math.max(maxPetal, petal.rotation.y);
  }
  check('it never walks anywhere', flower.pos.x === x0 && flower.pos.z === z0,
    `moved ${Math.hypot(flower.pos.x - x0, flower.pos.z - z0).toFixed(3)}`);
  check('...but its head swings around to face her', Math.abs(normAngle(yaw0 - flower.headYaw)) > 0.2
    && Math.abs(normAngle(flower.headYaw - Math.atan2(player.pos.x - flower.pos.x, player.pos.z - flower.pos.z))) < 0.25,
    `head ${flower.headYaw.toFixed(2)} vs her at ${Math.atan2(player.pos.x - flower.pos.x, player.pos.z - flower.pos.z).toFixed(2)}`);
  check('...while the stalk it stands on never turns', Math.abs(normAngle(flower.model.root.rotation.y - flower.plantedYaw)) < 1e-6);
  check('it charges its spit before it spits', sawWindup && sawAttack);
  check('the mouth glows brighter as the spit brews', maxGlow > 0.2, `glow r=${maxGlow.toFixed(2)}`);
  check('...and the petals yawn open with it', maxPetal - minPetal > 0.3, `${minPetal.toFixed(2)} -> ${maxPetal.toFixed(2)}`);
  check('it spat at her', ctx.projectiles.length >= 1, `${ctx.projectiles.length} ball(s)`);
  check('...energy balls, half a heart each', ctx.projectiles.every((p) => p.kind === 'energy' && p.dmg === 1),
    ctx.projectiles.map((p) => `${p.kind}:${p.dmg}`).join(' '));
  check('...and one of them found her', player.hp === MAX_HP - 1, `hp=${player.hp} of ${MAX_HP}`);
}

// The spit is dodgeable: sidestep while it charges and the ball sails past.
{
  const { ctx, player } = makeCtx(44.5, 43.0);
  const flower = new Enemy(ctx, 'spitflower', 44.5, 39.0);
  ctx.enemies.push(flower);
  // let it notice her and start charging, then step out of the way as it locks on
  for (let i = 0; i < Math.round(1.2 / DT); i++) { flower.update(DT); player.update(DT, NO_INPUT); }
  player.pos = { x: 47.5, z: 43.0 };
  for (let i = 0; i < Math.round(1.2 / DT); i++) {
    flower.update(DT);
    player.update(DT, NO_INPUT);
    for (const p of ctx.projectiles) p.update(DT);
  }
  check('a sidestep once it locks on dodges the spit', player.hp === MAX_HP, `hp=${player.hp} of ${MAX_HP}`);
  for (let i = 0; i < Math.round(4 / DT); i++) {
    flower.update(DT);
    player.update(DT, NO_INPUT);
    for (const p of ctx.projectiles) p.update(DT);
  }
  check('...but standing still lines her up for the next one', player.hp === MAX_HP - 1, `hp=${player.hp} of ${MAX_HP}`);
}

// Four swings and it is done — and no blow ever uproots it.
{
  const { ctx } = makeCtx(44.5, 43.0);
  const flower = new Enemy(ctx, 'spitflower', 44.5, 39.0);
  ctx.enemies.push(flower);
  const x0 = flower.pos.x, z0 = flower.pos.z;
  let dead = false;
  for (let i = 0; i < 4 && !dead; i++) {
    dead = flower.hurt(1, flower.pos.x, flower.pos.z + 1);
    for (let k = 0; k < Math.round(0.3 / DT); k++) flower.update(DT);
  }
  check('a spitflower is a four-swing target', dead && flower.st.hp === 4, `${flower.st.hp} hp`);
  check('...that stays planted through every blow', flower.pos.x === x0 && flower.pos.z === z0);
}

// A ladybug's gust shivers its leaves but cannot move it.
{
  const { ctx } = makeCtx(60.5, 43.0);
  const bug = new Enemy(ctx, 'ladybug', 60.5, 38.6);
  bug.facing = 0;
  ctx.enemies.push(bug);
  const flower = new Enemy(ctx, 'spitflower', 60.5, 40.4); // right in the cone
  ctx.enemies.push(flower);
  const soldier = new Enemy(ctx, 'sword', 61.0, 40.4);
  ctx.enemies.push(soldier);
  bug.state = 'attack'; bug.stateT = 0.2; bug.fired = false;
  bug.update(DT);
  check('the gust throws a soldier but not the rooted flower', soldier.knockT > 0 && flower.knockT <= 0,
    `soldier knockT=${soldier.knockT.toFixed(2)} flower knockT=${flower.knockT.toFixed(2)}`);
}

// ============================================================ the population
// Flowers keep their own population beside the beetles: same lush-country rule, but only in the woods.
function runWildlife(seconds: number, x: number, z: number, viewR = 26) {
  const { ctx, player } = makeCtx(x, z);
  const wildlife = new Wildlife(ctx);
  const spawned: { x: number; z: number; dist: number }[] = [];
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    // arrivals are read off the enemy list itself, so a frame that both releases one and seeds
    // another still counts the newcomer
    const n = ctx.enemies.length;
    wildlife.update(DT, viewR);
    for (const e of ctx.enemies) e.update(DT);
    for (let k = n; k < ctx.enemies.length; k++) {
      const f = ctx.enemies[k];
      if (f.kind !== 'spitflower') continue;
      spawned.push({ x: f.pos.x, z: f.pos.z, dist: Math.hypot(f.pos.x - x, f.pos.z - z) });
    }
  }
  return { ctx, player, wildlife, spawned };
}
const nearTrees = (x: number, z: number) => {
  const tx = Math.floor(x), tz = Math.floor(z);
  for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) {
    const nx = tx + dx, nz = tz + dz;
    if (nx < 0 || nz < 0 || nx >= world.w || nz >= world.h) continue;
    if (world.treeCell[nz * world.w + nx]) return true;
  }
  return false;
};
const isWoods = (x: number, z: number) => world.tile(Math.floor(x), Math.floor(z)) === Tile.ForestFloor || nearTrees(x, z);
{
  const { wildlife, spawned } = runWildlife(120, 33, 155);
  check('the southern woods grow spitflowers', wildlife.flowers.length >= 2, `${wildlife.flowers.length} flowers`);
  check('every one takes root on green ground', spawned.every((s) => world.lushness(s.x, s.z) >= 0.6),
    spawned.map((s) => world.lushness(s.x, s.z).toFixed(2)).join(' '));
  check('...under the trees, never in the open', spawned.every((s) => isWoods(s.x, s.z)),
    spawned.map((s) => `(${s.x.toFixed(0)},${s.z.toFixed(0)})`).join(' '));
  const v = world.village;
  check('...outside the village', spawned.every((s) => s.x < v.x0 - 3 || s.x > v.x1 + 3 || s.z < v.z0 - 3 || s.z > v.z1 + 3));
  check('...and out of sight', spawned.every((s) => s.dist > 24), spawned.map((s) => s.dist.toFixed(0)).join(' '));
  check('the flowers never crowd the beetles out', wildlife.bugs.length >= 2, `${wildlife.bugs.length} bugs beside them`);
  check('...and settle at their own smaller number', wildlife.flowers.length <= 3, `${wildlife.flowers.length} flowers`);
}
{
  const { wildlife } = runWildlife(120, 86.5, 24.5);
  check('Willowmere grows them too', wildlife.flowers.length >= 1, `${wildlife.flowers.length} flowers`);
}
{
  const { wildlife } = runWildlife(120, 172.5, 84.5);
  check('the moor grows none', wildlife.flowers.length === 0, `${wildlife.flowers.length} flowers`);
}
{
  // walk out of the green: the flowers left behind are released with the beetles
  const { ctx, wildlife } = runWildlife(60, 33, 155);
  const before = wildlife.flowers.length;
  (ctx as { player: Player }).player.pos = { x: 178, z: 22 };
  for (let i = 0; i < Math.round(60 / DT); i++) wildlife.update(DT, 26);
  check('flowers left behind are let go', before > 0 && wildlife.flowers.length === 0, `${before} -> ${wildlife.flowers.length}`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall good');
if (failures) process.exit(1);
