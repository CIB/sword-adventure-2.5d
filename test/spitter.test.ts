// The spitflower: a big flower on a long flexible stem that grows in the deep woods, turns its head
// to follow the heroine and spits balls of energy at her. Driven here the way Game.update drives it —
// a live Enemy per flower, a real Player, real Projectiles, the same GameCtx the soldier and ladybug
// tests use, with a spawnProjectile that records every ball so that "one ball per charge, for the
// damage its stats say, down the line it was holding" can be checked to the number.
// Run: npx esbuild test/spitter.test.ts --bundle --platform=node --format=esm | node --input-type=module
import * as THREE from 'three';
import { World } from '../src/game/world';
import { Enemy, Player, Projectile, fxEnergyBurst, type GameCtx } from '../src/game/entities';
import { Wildlife } from '../src/game/wildlife';
import { buildEnergyBall, buildHeroine, buildSpitter, ENERGY_BALL_SPEED, isSpitter, SPITTER_MAW_H } from '../src/game/models';
import { RNG, MAX_HP, normAngle } from '../src/game/constants';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

const world = new World();
const DT = 1 / 30;
const NO_INPUT = { moveX: 0, moveZ: 0, down: () => false, justPressed: () => false } as never;
const size = (o: THREE.Object3D, precise = false) => new THREE.Box3().setFromObject(o, precise);

/**
 * A GameCtx with no renderer, that records everything the flower throws and every time something
 * tried to hurt the heroine (the way test/ladybug.test.ts does): a ball goes into the real
 * Projectile list so it can be flown, and the blow it lands is the blow her hearts actually show.
 */
function makeCtx(playerX: number, playerZ: number) {
  const rng = new RNG(1234);
  const noop = () => {};
  const audio = new Proxy({}, { get: () => noop }) as never;
  const hits: number[] = [];
  const hitOpts: ({ projectile?: boolean } | undefined)[] = [];
  const shots: { kind: string; x: number; z: number; dx: number; dz: number; dmg: number; y: number }[] = [];
  const ctx = {
    world, scene: new THREE.Scene(), audio, rand: () => rng.next(), talking: false,
    enemies: [] as Enemy[], projectiles: [] as Projectile[],
    spawnProjectile: (kind: string, x: number, z: number, dx: number, dz: number, dmg: number, y = 0) => {
      shots.push({ kind, x, z, dx, dz, dmg, y });
      ctx.projectiles.push(new Projectile(ctx as unknown as GameCtx, kind as 'energy_ball', x, z, { x: dx, z: dz }, dmg, y));
    },
    spawnEffect: noop,
    tryHitPlayer: (dmg: number, sx: number, sz: number, opts?: { projectile?: boolean }) => {
      hits.push(dmg); hitOpts.push(opts);
      (ctx as { player: Player }).player.hurt(dmg, sx, sz);
      return 'hit' as const;
    },
  } as unknown as GameCtx & { projectiles: Projectile[] };
  const player = new Player(ctx, playerX, playerZ);
  (ctx as { player: Player }).player = player;
  return { ctx, player, hits, hitOpts, shots };
}

/** a frame of the game's own update order, for the things under test */
function step(ents: Enemy[], ctx: { projectiles: Projectile[] }, player: Player, input: unknown = NO_INPUT) {
  for (const e of ents) e.update(DT);
  for (const p of ctx.projectiles) p.update(DT);
  ctx.projectiles = ctx.projectiles.filter((p) => p.alive);
  player.update(DT, input as never);
}

/** how many of the woods' trees stand within `r` tiles of a tile (the flower's measure of cover) */
const treesAround = (tx: number, tz: number, r = 4) => {
  let n = 0;
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
    const x = tx + dx, z = tz + dz;
    if (x < 0 || z < 0 || x >= world.w || z >= world.h) continue;
    n += world.treeCell[z * world.w + x];
  }
  return n;
};

// ============================================================ the plant itself
// A big flower head on a long stem: that is the whole silhouette, and the numbers below are the
// claims the enemy AI makes about it (the mouth it spits from is up at SPITTER_MAW_H, and the stem
// bends — a little at the foot, most of it near the top).
{
  const flower = buildSpitter();
  const box = size(flower.root, true);
  const heroine = size(buildHeroine().root, true);
  check('the spitflower stands on the ground', Math.abs(box.min.y) < 0.06, `min.y=${box.min.y.toFixed(3)}`);
  check('it is a big flower, head and all above the heroine\'s', box.max.y > heroine.max.y + 0.5,
    `flower top ${box.max.y.toFixed(2)} vs heroine ${heroine.max.y.toFixed(2)}`);
  check('...on a long stem: the mouth rides a person and a half up', SPITTER_MAW_H > 1.3 && SPITTER_MAW_H < 1.8,
    `SPITTER_MAW_H=${SPITTER_MAW_H.toFixed(2)}`);
  // ...and the one number the model and the AI both aim by is the same number: the pitch is worked
  // out from SPITTER_MAW_H, so if the model's mouth ever drifted off it the flower would spit over
  // her head (or into the floor) from every range
  {
    const m = buildSpitter();
    m.root.updateMatrixWorld(true);
    const mawY = m.maw!.getWorldPosition(new THREE.Vector3()).y;
    check('...and the height the AI aims from is the height the mouth is at', Math.abs(mawY - SPITTER_MAW_H) < 0.01,
      `model ${mawY.toFixed(3)} vs AI ${SPITTER_MAW_H.toFixed(3)}`);
  }
  check('the stem is a chain of joints, not one stick', (flower.stalk?.length ?? 0) >= 4, `${flower.stalk?.length} joints`);
  {
    // each joint hangs off the one below it, so bending the chain bends the plant
    const chain = flower.stalk ?? [];
    let linked = true;
    for (let i = 1; i < chain.length; i++) {
      let p: THREE.Object3D | null = chain[i].parent;
      let found = false;
      while (p) { if (p === chain[i - 1]) { found = true; break; } p = p.parent; }
      linked = linked && found;
    }
    check('...each one riding the joint below it', linked);
  }
  check('the head is on the top of that stem, and the mouth on the head',
    !!flower.maw && !!flower.head && !!flower.stalk && flower.maw.parent === flower.head
    && (() => { let p: THREE.Object3D | null = flower.head!.parent; while (p) { if (p === flower.stalk![flower.stalk!.length - 1]) return true; p = p.parent; } return false; })());
  check('...so the mouth rides at head height, well clear of the ground', size(flower.maw!).min.y > 1.1,
    `mouth at ${size(flower.maw!).min.y.toFixed(2)}`);
  check('the face is a ring of petals round the mouth', (flower.petals?.children.length ?? 0) >= 6,
    `${flower.petals?.children.length} petals`);
  check('...with the mouth in the middle of it', Math.hypot(flower.maw!.position.x, flower.maw!.position.y) < 0.15);
  check('the two lips ride the arm slots, with their glands in the hand slots',
    flower.armL.parent === flower.head && flower.armR.parent === flower.head
    && flower.handL.parent === flower.armL && flower.handR.parent === flower.armR);
  // the charge tell is built in, not implied: the throat is unlit at rest and the tell is a real
  // material the animation can fade (the lip glands share it, so the whole flower lights at once)
  const throatMat = flower.throat!.material as THREE.MeshBasicMaterial;
  check('the throat is cold at rest, on a material that can be lit', throatMat.opacity <= 0.1 && throatMat.transparent);
  const gland = flower.handL.children[0] as THREE.Mesh;
  check('...and the glands on the lips light with it', gland.material === flower.throat!.material);
  // opening the lips carries their tips back off the face, which is what lets the light inside be
  // seen from in front (the same slots and the same angles Enemy.animate drives them through)
  flower.root.updateMatrixWorld(true);
  const shut = flower.handL.getWorldPosition(new THREE.Vector3()).z;
  flower.armL.rotation.x = -0.55;
  flower.armR.rotation.x = 0.55;
  flower.root.updateMatrixWorld(true);
  const open = flower.handL.getWorldPosition(new THREE.Vector3()).z;
  check('the lips come back off the mouth when they open', open < shut - 0.05, `tip z ${shut.toFixed(2)} -> ${open.toFixed(2)}`);
}

// The ball it spits is made of light, and the model and the AI agree on how fast it goes.
{
  const ball = buildEnergyBall();
  check('the energy ball is a ball: a core with a halo round it', ball.children.length >= 4);
  const box = size(ball, true);
  const ex = box.max.x - box.min.x, ey = box.max.y - box.min.y, ez = box.max.z - box.min.z;
  check('...and round to look at, about three quarters of a tile across',
    Math.max(ex, ey, ez) - Math.min(ex, ey, ez) < 0.15 && ex > 0.5 && ex < 0.9,
    `${ex.toFixed(2)} x ${ey.toFixed(2)} x ${ez.toFixed(2)}`);
  const noop = () => {};
  const shot = new Projectile({ world, scene: new THREE.Scene(), audio: new Proxy({}, { get: () => noop }), rand: () => 0.5 } as unknown as GameCtx,
    'energy_ball', 10, 10, { x: 0, z: 1 }, 1, 1.4);
  check('the ball travels at the speed the AI aims with', shot.speed === ENERGY_BALL_SPEED, `${shot.speed} vs ${ENERGY_BALL_SPEED}`);
  shot.destroy();
}

// ============================================================ the head on the stem
// Everything this enemy does happens on the end of its neck: it notices her, comes round, tips down
// onto her, charges (mouth open, throat lit, petals spread) and spits. It never takes a step.
{
  const { ctx, player, shots } = makeCtx(44.5, 43.5);
  const flower = new Enemy(ctx, 'spitter', 44.5, 38.5);
  flower.yaw = Math.PI; // looking due north, straight away from her
  flower.cooldown = 999; // ...and held on a cooldown for now, so the head can be watched on its own
  ctx.enemies.push(flower);
  check('a spitflower is rooted, and says so', flower.rooted && isSpitter(flower.kind));
  check('...with a broad base to hit rather than a soldier\'s shoulders', flower.radius > 0.4, `r=${flower.radius}`);

  let turnT = 0;
  while (Math.abs(normAngle(flower.yaw)) > 0.12 && turnT < 6) { step([flower], ctx, player); turnT += DT; }
  check('it comes round to face her', turnT < 6, `${turnT.toFixed(2)}s`);
  check('...at a stem\'s pace, not a soldier\'s snap', turnT > 0.7, `${turnT.toFixed(2)}s for half a turn`);
  check('...and by then it is awake and looking at her', flower.state !== 'patrol' && Math.abs(normAngle(flower.yaw)) < 0.12);

  // the mouth is the thing that aims, so the head tips down onto her when she stands at its foot and
  // levels off again once she is a clearing away
  const farPitch = flower.aimPitch;
  player.pos = { x: 44.5, z: 40.0 };
  for (let i = 0; i < Math.round(2 / DT); i++) step([flower], ctx, player);
  const nearPitch = flower.aimPitch;
  check('standing at its foot, the head tips down onto her', nearPitch > farPitch + 0.25 && flower.model.head.rotation.x > 0.1,
    `pitch ${farPitch.toFixed(2)} -> ${nearPitch.toFixed(2)}, head ${flower.model.head.rotation.x.toFixed(2)}`);
  player.pos = { x: 44.5, z: 47.0 };
  for (let i = 0; i < Math.round(2.5 / DT); i++) step([flower], ctx, player);
  check('...and comes back up when she backs off', flower.aimPitch < nearPitch - 0.25,
    `pitch ${nearPitch.toFixed(2)} -> ${flower.aimPitch.toFixed(2)}`);

  // the stem bends like a plant: barely at the foot, most of it near the head. Read while she is at
  // its foot, where the lean is longest and the plant's own idle sway is a small part of it.
  const stalk = flower.model.stalk!;
  player.pos = { x: 44.5, z: 40.0 };
  for (let i = 0; i < Math.round(1.5 / DT); i++) step([flower], ctx, player);
  const bendFoot = Math.abs(stalk[0].rotation.x), bendTop = Math.abs(stalk[stalk.length - 1].rotation.x);
  check('the stem bends near the top, not at the root', bendTop > bendFoot * 4 && bendTop > 0.08 && stalk.length >= 4,
    `foot ${bendFoot.toFixed(3)} vs top ${bendTop.toFixed(3)}`);
  check('nothing has moved it an inch in all that time', Math.abs(flower.pos.x - 44.5) < 1e-6 && Math.abs(flower.pos.z - 38.5) < 1e-6);
  check('...and with its fire held it has thrown nothing at all', shots.length === 0, `${shots.length} shot(s)`);
}

// The reach is the ball's, not an arm's: it has none. Out past the range it stops spitting, however
// plainly it can see her — and that range is where the ball can still arrive, not a step further.
{
  const { ctx, player, shots } = makeCtx(44.5, 38.5 + 9.5);
  const flower = new Enemy(ctx, 'spitter', 44.5, 38.5);
  ctx.enemies.push(flower);
  for (let i = 0; i < Math.round(5 / DT); i++) step([flower], ctx, player);
  check('out past its reach it holds its fire, however plainly it sees her',
    shots.length === 0 && flower.state !== 'windup' && flower.state !== 'attack' && flower.st.sight > flower.st.range,
    `${shots.length} shot(s), state ${flower.state}, sight ${flower.st.sight} vs range ${flower.st.range}`);
  check('...though it has still turned to keep her in front of it', Math.abs(normAngle(flower.yaw)) < 0.1,
    `yaw ${flower.yaw.toFixed(2)}`);
}

// Nobody there to look at: the head rests tipped up at the sun, and it stays asleep.
{
  const { ctx, player } = makeCtx(44.5, 60.0);
  const flower = new Enemy(ctx, 'spitter', 44.5, 38.5);
  ctx.enemies.push(flower);
  for (let i = 0; i < Math.round(3 / DT); i++) step([flower], ctx, player);
  check('with nobody about, the flower sleeps and nods at the sky', flower.state === 'patrol' && flower.model.head.rotation.x < -0.3,
    `head ${flower.model.head.rotation.x.toFixed(2)}`);
}

// ============================================================ the spit
// One ball per charge, aimed down the line the head is holding, thrown from the mouth at head height
// and dropping into level flight: half a heart, and a hit she can see coming from nine tiles away.
{
  const { ctx, player, hits, hitOpts, shots } = makeCtx(44.5, 43.5);
  const flower = new Enemy(ctx, 'spitter', 44.5, 38.5);
  flower.yaw = 0;
  ctx.enemies.push(flower);
  const restGlow = (flower.model.throat!.material as THREE.MeshBasicMaterial).opacity;
  let sawWindup = false, sawAttack = false, maxGlow = 0, maxSpread = 1, maxLip = 0, maxWindupDist = 0;
  for (let i = 0; i < Math.round(4 / DT); i++) {
    const distBefore = Math.hypot(player.pos.x - flower.pos.x, player.pos.z - flower.pos.z);
    step([flower], ctx, player);
    maxWindupDist = Math.max(maxWindupDist, distBefore);
    if (flower.state === 'windup' || flower.state === 'attack') {
      sawWindup = sawWindup || flower.state === 'windup';
      maxGlow = Math.max(maxGlow, (flower.model.throat!.material as THREE.MeshBasicMaterial).opacity);
      maxSpread = Math.max(maxSpread, flower.model.petals!.scale.x);
      maxLip = Math.max(maxLip, Math.abs(flower.model.armL!.rotation.x));
    }
    if (flower.state === 'attack') sawAttack = true;
  }
  check('it charges before it spits', sawWindup && sawAttack);
  check('...the mouth is cold at rest and lights up over the charge', restGlow <= 0.1 && maxGlow > 0.6,
    `${restGlow.toFixed(2)} -> ${maxGlow.toFixed(2)}`);
  check('...the petals spread wide and the lips come open with it', maxSpread > 1.1 && maxLip > 0.3,
    `petals x${maxSpread.toFixed(2)}, lips ${maxLip.toFixed(2)}`);
  check('it throws exactly one ball, of exactly the damage its stats say',
    shots.length === 1 && shots[0].kind === 'energy_ball' && shots[0].dmg === flower.st.dmg,
    `${shots.length} shot(s): ${shots.map((s) => `${s.kind} dmg=${s.dmg}`).join(', ')}`);
  const ball = shots[0];
  const ux = (player.pos.x - ball.x), uz = (player.pos.z - ball.z);
  const ul = Math.hypot(ux, uz);
  check('...down the line it was holding, at where she is', (ball.dx * ux + ball.dz * uz) / ul > 0.92,
    `aim dot ${((ball.dx * ux + ball.dz * uz) / ul).toFixed(3)}`);
  check('...out of the mouth, above the ground rather than along it', ball.y > 1, `left at y=${ball.y.toFixed(2)}`);
  check('...and the shot is a projectile: a braced shield can turn it away', hitOpts[0]?.projectile === true);
  check('...which lands as the half heart it costs', hits.length === 1 && hits[0] === 1 && player.hp === MAX_HP - 1,
    `${hits.length} hit(s), hp ${player.hp} of ${MAX_HP}`);
  check('the flower never walked into her to do it', maxWindupDist > 3, `opened up from ${maxWindupDist.toFixed(1)} tiles`);
}

// The charge is a real wind-up, not a formality: once the head has committed, changing where she
// stands is the answer, and the ball goes where the glowing mouth was pointing.
{
  const { ctx, player, hits, shots } = makeCtx(44.5, 43.5);
  const flower = new Enemy(ctx, 'spitter', 44.5, 38.5);
  flower.yaw = 0;
  ctx.enemies.push(flower);
  let committed = false;
  for (let i = 0; i < Math.round(4 / DT) && !committed; i++) {
    step([flower], ctx, player);
    committed = flower.state === 'windup' && flower.stateT < 0.34; // inside the last stretch of the charge
  }
  check('the flower holds its charge and commits to a line', committed, `state ${flower.state}, t ${flower.stateT.toFixed(2)}`);
  const shotsAtCommit = shots.length;
  player.pos = { x: 47.5, z: 43.5 }; // three tiles to the side, after the line was frozen
  for (let i = 0; i < Math.round(1.1 / DT); i++) step([flower], ctx, player);
  check('...and stepping off that line is a real answer to it', shots.length === shotsAtCommit + 1 && hits.length === 0 && player.hp === MAX_HP,
    `${shots.length - shotsAtCommit} ball(s), ${hits.length} hit(s), hp ${player.hp}`);
}

// A plant does not shoot into a tree trunk: with a trunk between the two of them it holds its fire,
// even though she is well inside its reach and it can plainly see her.
{
  const blocked = (() => {
    for (let tz = 8; tz < world.h - 8; tz++) for (let tx = 8; tx < world.w - 8; tx++) {
      if (!world.treeCell[tz * world.w + tx]) continue; // a trunk stands here
      // ...with open ground immediately either side of it, so the thin line between the two of them
      // crosses the trunk tile and nowhere else
      const fx = tx + 0.5, fz = tz + 1.5, px = tx + 0.5, pz = tz - 0.5;
      if (world.isSolidTile(tx, tz + 1) || world.isSolidTile(tx, tz - 1)) continue;
      if (world.blocksProjectile(fx, fz) || world.blocksProjectile(px, pz)) continue;
      if (!world.blocksProjectile(tx + 0.5, tz + 0.5)) continue;
      return { fx, fz, px, pz };
    }
    return null;
  })();
  check('there is a trunk on the map to hide behind', !!blocked, blocked ? `at ${blocked.fx},${blocked.fz}` : 'none found');
  if (blocked) {
    const { ctx, player, shots } = makeCtx(blocked.px, blocked.pz);
    const flower = new Enemy(ctx, 'spitter', blocked.fx, blocked.fz);
    ctx.enemies.push(flower);
    for (let i = 0; i < Math.round(6 / DT); i++) step([flower], ctx, player);
    check('...and with it between them the flower holds its fire', shots.length === 0 && flower.state !== 'windup',
      `${shots.length} shot(s), state ${flower.state}`);
  }
}

// Rooted means rooted: a sword blow rattles it and a beetle's gust throws it about, and it does not
// move a hair either way.
{
  const { ctx, player } = makeCtx(44.5, 39.5);
  const flower = new Enemy(ctx, 'spitter', 44.5, 44.5);
  const bug = new Enemy(ctx, 'ladybug', 44.5, 47.2); // two and a half tiles off, inside a common clap
  bug.facing = 4; // looking north, at the flower and the heroine beyond it
  ctx.enemies.push(flower, bug);
  const at = { x: flower.pos.x, z: flower.pos.z };
  // a blade out of nowhere, the way Game.resolveSword lands one
  flower.hurt(1, flower.pos.x, flower.pos.z - 1);
  check('a blade lands on the stem and it shudders on its roots', flower.knockT > 0 && flower.hp === flower.st.hp - 1,
    `${flower.hp} hp, knockT ${flower.knockT.toFixed(2)}`);
  for (let i = 0; i < Math.round(0.5 / DT); i++) step([flower], ctx, player);
  check('...without moving it an inch off them', Math.abs(flower.pos.x - at.x) < 1e-6 && Math.abs(flower.pos.z - at.z) < 1e-6,
    `moved ${Math.hypot(flower.pos.x - at.x, flower.pos.z - at.z).toFixed(4)} tiles`);
  check('...and the shudder passes in its own time', flower.knockT <= 0);
  // and then a beetle's own clap, thrown straight at it
  bug.state = 'attack'; bug.stateT = 0.2; bug.fired = false;
  bug.update(DT);
  check('a beetle\'s clap is a shove like any other, and shoves it', flower.knockT > 0, `knockT ${flower.knockT.toFixed(2)}`);
  for (let i = 0; i < Math.round(0.5 / DT); i++) step([flower], ctx, player);
  check('...and cannot blow it out of its clearing either', Math.abs(flower.pos.x - at.x) < 1e-6 && Math.abs(flower.pos.z - at.z) < 1e-6,
    `moved ${Math.hypot(flower.pos.x - at.x, flower.pos.z - at.z).toFixed(4)} tiles`);
  check('a spitflower is a plant, not a soft target: three swings and it is done',
    flower.st.hp === 3 && flower.st.speed === 0 && flower.st.chase === 0,
    `${flower.st.hp} hp, speed ${flower.st.speed}`);
}

// ============================================================ the woods grow them
// Spitflowers are seeded by the same wildlife system the beetles are, on the same rules — lush
// ground, out of sight — with the extra one that makes them a flower of the *forests*: trunks
// standing round about them, and open ground at the foot for the heroine to come at.
function runWildlife(seconds: number, x: number, z: number, viewR = 26) {
  const { ctx, player } = makeCtx(x, z);
  const wildlife = new Wildlife(ctx);
  const planted: { x: number; z: number; dist: number }[] = [];
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    const before = wildlife.flowers.length;
    wildlife.update(DT, viewR);
    for (const e of ctx.enemies) e.update(DT);
    if (wildlife.flowers.length > before) {
      const f = wildlife.flowers[wildlife.flowers.length - 1];
      planted.push({ x: f.pos.x, z: f.pos.z, dist: Math.hypot(f.pos.x - x, f.pos.z - z) });
    }
  }
  return { ctx, player, wildlife, planted };
}
{
  const { wildlife, planted } = runWildlife(90, 33, 155); // the southern woods
  check('the woods grow spitflowers', wildlife.flowers.length >= 2, `${wildlife.flowers.length} standing, ${planted.length} planted`);
  check('every one of them comes up on green ground', planted.every((s) => world.lushness(s.x, s.z) >= 0.6),
    planted.map((s) => world.lushness(s.x, s.z).toFixed(2)).join(' '));
  check('...in the deep of the wood, with trunks all round it',
    planted.every((s) => treesAround(Math.floor(s.x), Math.floor(s.z)) >= 5),
    planted.map((s) => treesAround(Math.floor(s.x), Math.floor(s.z))).join(' '));
  check('...with open ground at its foot, so she can walk up and cut it down',
    planted.every((s) => {
      const tx = Math.floor(s.x), tz = Math.floor(s.z);
      return !world.isSolidTile(tx + 1, tz) && !world.isSolidTile(tx - 1, tz) && !world.isSolidTile(tx, tz + 1) && !world.isSolidTile(tx, tz - 1);
    }));
  // far enough that none of them was ever seen to appear: the ring is worked out from the same view
  // radius the beetles use, so a flower is always planted out past the edge of what is on screen
  check('...out of sight of the player', planted.every((s) => s.dist > 12), planted.map((s) => s.dist.toFixed(0)).join(' '));
  check('...and never right on top of each other',
    wildlife.flowers.every((a, i) => wildlife.flowers.every((b, j) => i === j || Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z) >= 9)),
    `${wildlife.flowers.length} flowers`);
  check('...and nothing walks them about afterwards', wildlife.flowers.every((f) => f.st.speed === 0 && f.st.chase === 0));
  const v = world.village;
  check('the village stays clear of them', planted.every((s) => s.x < v.x0 - 3 || s.x > v.x1 + 3 || s.z < v.z0 - 3 || s.z > v.z1 + 3));
  check('...and they are not soldiers: no post, no queue, nobody marching to replace them',
    wildlife.flowers.every((f) => f.soldier === null && f.post === null));
}
{
  // the open meadow: plenty for the beetles, nothing for a flower (there is nowhere to put one)
  const { wildlife } = runWildlife(90, 44.5, 38.5);
  check('the meadow grows no flowers at all', wildlife.flowers.length === 0, `${wildlife.flowers.length} flowers`);
  check('...while the beetles carry on living there', wildlife.bugs.length >= 3, `${wildlife.bugs.length} bugs`);
}
{
  // the two populations are separate books: one can be released and restocked without the other
  const { ctx, wildlife } = runWildlife(60, 33, 155);
  const flowers = wildlife.flowers.length, bugs = wildlife.bugs.length;
  wildlife.reset();
  check('a fresh run is a fresh wood', flowers > 0 && bugs > 0 && wildlife.flowers.length === 0 && wildlife.bugs.length === 0,
    `${flowers} flowers / ${bugs} bugs -> ${wildlife.flowers.length} / ${wildlife.bugs.length}`);
  const { ctx: ctx2, wildlife: w2 } = runWildlife(60, 33, 155);
  (ctx2 as { player: Player }).player.pos = { x: 178, z: 22 }; // out to the moors
  for (let i = 0; i < Math.round(90 / DT); i++) w2.update(DT, 26);
  check('flowers left behind in the old woods are let go',
    w2.flowers.length === 0 && ctx2.enemies.every((e) => !e.alive || !isSpitter(e.kind)), `${w2.flowers.length} left`);
  check('...and the woods that grow them are the greens, not the dry parts of the map', world.lushness(172.5, 84.5) < 0.4);
  void ctx;
}

// ============================================================ the light it throws
// The burst is pure scene graph (no renderer needed): build one and play it out, the way the arrow
// and the gust effects are checked in test/ladybug.test.ts.
{
  const fx = fxEnergyBurst(44.5, 1.3, 38.5, 1);
  let frames = 0, grew = 0;
  const first = size(fx.group, true);
  while (fx.update(DT) && frames < 200) {
    frames++;
    grew = Math.max(grew, size(fx.group, true).max.x - size(fx.group, true).min.x);
  }
  check('the energy bursts, plays out and cleans up', frames > 4 && frames < 60, `${frames} frames`);
  check('...flaring out wider than it started', grew > (first.max.x - first.min.x) * 1.2,
    `${(first.max.x - first.min.x).toFixed(2)} -> ${grew.toFixed(2)}`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall good');
if (failures) process.exit(1);
