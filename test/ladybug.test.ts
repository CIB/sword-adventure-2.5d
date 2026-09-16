// Ladybugs: the lush-country spawner that keeps them common in the green parts of the world, and the
// wing-clap — a charged-up gust of wind that hurts the heroine and throws everything else in front of
// the beetle off its feet. The ordinary beetle is soldier-sized (the queen is the oversized one, and
// rare), so the model checks below measure it against a soldier on screen, not against its own
// authoring numbers. Driven here the way Game.update drives them (a live Enemy per bug, a real
// Player, the same GameCtx the soldier tests use), with a tryHitPlayer that records every call so
// "one half-heart, once" can be checked to the number.
// Run: npx esbuild test/ladybug.test.ts --bundle --platform=node --format=esm | node --input-type=module
import * as THREE from 'three';
import { World } from '../src/game/world';
import { Enemy, Player, Projectile, fxGust, type GameCtx } from '../src/game/entities';
import { Wildlife } from '../src/game/wildlife';
import { buildSoldier, gustRange, isLadybug, poseLadybug, LADYBUG_GUST_TELL_HOVER } from '../src/game/models';
import { RNG, MAX_HP, FACING_VEC, SHEAR, inArc } from '../src/game/constants';

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
 * the request and then lets the real Player take it, so the damage the beetle asks for is the damage
 * her hearts actually show — and a blow the Player itself shrugs off still shows up in `hits`.
 */
function makeCtx(playerX: number, playerZ: number) {
  const rng = new RNG(1234);
  const noop = () => {};
  const audio = new Proxy({}, { get: () => noop }) as never;
  const hits: number[] = [];
  const ctx = {
    world, scene: new THREE.Scene(), audio, rand: () => rng.next(), talking: false,
    enemies: [] as Enemy[], projectiles: [] as Projectile[],
    spawnProjectile: noop, spawnEffect: noop,
    tryHitPlayer: (dmg: number, sx: number, sz: number) => { hits.push(dmg); (ctx as { player: Player }).player.hurt(dmg, sx, sz); return 'hit' as const; },
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
/** how much of the screen a thing covers, in tiles: width × (height leaning back over its own depth) */
const screenArea = (b: THREE.Box3) => (b.max.x - b.min.x) * ((b.max.y - b.min.y) * SHEAR + (b.max.z - b.min.z));
const bugModel = buildSoldier('ladybug');
check('the ladybug has two separately hinged wing covers', !!bugModel.elytronL && !!bugModel.elytronR && bugModel.elytronL !== bugModel.elytronR);
check('...and hindwings to beat under them', !!bugModel.hindwingL && !!bugModel.hindwingR);
check('...and a ground tell for the gust', !!bugModel.gustArc);
check('the wing covers are shut at rest', Math.abs(bugModel.elytronL!.rotation.z) < 0.1);
check('the ground tell is measured in tiles of world, not in beetle lengths',
  Math.abs(bugModel.gustArcUnit! * bugModel.root.scale.x - gustRange('ladybug')) < 0.01,
  `tell=${(bugModel.gustArcUnit! * bugModel.root.scale.x).toFixed(2)} gust=${gustRange('ladybug')}`);
check('...and it starts high enough above the ground to avoid slope z-fighting',
  Math.abs(bugModel.gustArc!.position.y * bugModel.root.scale.y - LADYBUG_GUST_TELL_HOVER) < 1e-6,
  `hover=${(bugModel.gustArc!.position.y * bugModel.root.scale.y).toFixed(3)}`);
{
  // The regular beetle is the size of a soldier — the complaint that started this, so it is checked
  // the way it was complained about: as the patch of screen the thing takes up. The gust tell is a
  // cone lying on the floor, so it comes off before anything is measured.
  bugModel.root.remove(bugModel.gustArc!);
  const bug = size(bugModel.root), soldier = size(buildSoldier('sword').root);
  const h = bug.max.y - bug.min.y, w = bug.max.x - bug.min.x, l = bug.max.z - bug.min.z;
  const sh = soldier.max.y - soldier.min.y, sw = soldier.max.x - soldier.min.x;
  check('it stands on the ground', Math.abs(bug.min.y) < 0.06, `min.y=${bug.min.y.toFixed(3)}`);
  check('it is a beetle the size of a soldier, not a monster', h > 0.7 && h < sh + 0.05 && w > 0.8 && w < sw + 0.15,
    `bug ${w.toFixed(2)}x${h.toFixed(2)} vs soldier ${sw.toFixed(2)}x${sh.toFixed(2)}`);
  check('...and it fills about the same patch of screen as one', screenArea(bug) > screenArea(soldier) * 0.85 && screenArea(bug) < screenArea(soldier) * 1.3,
    `bug=${screenArea(bug).toFixed(2)} soldier=${screenArea(soldier).toFixed(2)}`);
  check('...and it is a broad, low thing rather than a tall one', w > 0.9 && l > 1.1 && l > h, `w=${w.toFixed(2)} l=${l.toFixed(2)} h=${h.toFixed(2)}`);
  // the clap: the covers hinge up off the body, so the beetle stands taller with them open
  const shutCover = size(bugModel.elytronL!);
  bugModel.elytronL!.rotation.z = 1.25;
  bugModel.elytronR!.rotation.z = -1.25;
  const open = size(bugModel.root), openCover = size(bugModel.elytronL!);
  check('the beetle stands taller with its shell open', open.max.y > bug.max.y + 0.12,
    `h=${(bug.max.y - bug.min.y).toFixed(2)}->${(open.max.y - open.min.y).toFixed(2)}`);
  check('...because the covers swing clear up off its back', openCover.max.y > shutCover.max.y + 0.2,
    `cover top ${shutCover.max.y.toFixed(2)} -> ${openCover.max.y.toFixed(2)}`);
  // ...and the open shell is what the hindwings beat under: measured in world space, since the wings
  // ride a group of their own inside the root and the root carries the beetle's size
  check('the hindwings sit under the shell and swing with it', size(bugModel.hindwingL!).max.y < shutCover.max.y,
    `wing top ${size(bugModel.hindwingL!).max.y.toFixed(2)} vs cover top ${shutCover.max.y.toFixed(2)}`);
  // with the shell shut again: the covers meet on the midline and nothing pokes out of them
  bugModel.elytronL!.rotation.z = 0;
  bugModel.elytronR!.rotation.z = 0;
  const coverL = size(bugModel.elytronL!, true), coverR = size(bugModel.elytronR!, true);
  check('the two covers meet along the midline', Math.abs(coverL.min.x) < 0.02 && Math.abs(coverR.max.x) < 0.02,
    `L.min.x=${coverL.min.x.toFixed(3)} R.max.x=${coverR.max.x.toFixed(3)}`);
  // (where the hindwings fold away is checked properly below, against the curved cover)
}

// the translucent flight wings: pale membranes hinged at the thorax under the pronotum. Folded,
// they vanish beneath the shell and the belly — checked the way the camera sees it, vertex by
// vertex against the curved cover, not just the bounding box (a flat sheet can hide inside the box
// and still poke out of the side). For the charge they sweep wide out to the sides and beat: a low
// fan, not a wall stood on edge.
{
  const bug = buildSoldier('ladybug');
  bug.root.remove(bug.gustArc!);
  bug.root.scale.set(1, 1, 1); // author space: the cover numbers below are in beetle lengths
  const membrane = bug.hindwingL!.children[0] as THREE.Mesh;
  const wmat = membrane.material as THREE.MeshToonMaterial;
  check('the wing membranes are pale, see-through sheets',
    wmat.transparent && wmat.opacity > 0.45 && wmat.opacity < 0.7 && wmat.depthWrite === false && wmat.side === THREE.DoubleSide,
    `opacity=${wmat.opacity} depthWrite=${wmat.depthWrite} side=${wmat.side}`);
  // how deep a point sits inside the cover: < 0 means inside the shell dome, the belly or the
  // pronotum (their ellipsoids, in author space)
  const cover = (p: THREE.Vector3) => {
    const f = (cx: number, cy: number, cz: number, hx: number, hy: number, hz: number) =>
      ((p.x - cx) / hx) ** 2 + ((p.y - cy) / hy) ** 2 + ((p.z - cz) / hz) ** 2 - 1;
    return Math.min(f(0, 0.6, -0.22, 0.56, 0.42, 0.62), f(0, 0.52, -0.02, 0.53, 0.26, 0.7), f(0, 0.8, 0.44, 0.43, 0.22, 0.26));
  };
  let n = 0, out = 0, worst = 0;
  for (const side of [bug.hindwingL!, bug.hindwingR!]) {
    side.updateWorldMatrix(true, true);
    for (const child of side.children) {
      const mesh = child as THREE.Mesh;
      const pos = mesh.geometry.getAttribute('position');
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        const d = cover(v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld));
        n++;
        if (d > 0) { out++; worst = Math.max(worst, d); }
      }
    }
  }
  check('the folded wings vanish under the shell and belly', out / n < 0.02 && worst < 0.05,
    `${out}/${n} vertices outside the cover, deepest ${worst.toFixed(4)}`);
  // the charge: the same wings swept fully open, posed exactly the way poseLadybug poses them —
  // measured against the SHUT shell, since that is what they fan out of
  const shell = size(bug.elytronL!).union(size(bug.elytronR!));
  poseLadybug(bug, 1, 0, 0, 0);
  const wings = size(bug.hindwingL!, true).union(size(bug.hindwingR!, true));
  check('the spread wings fan out wide past the shell', wings.max.x > shell.max.x + 0.2 && wings.min.x < shell.min.x - 0.2,
    `wings ±${wings.max.x.toFixed(2)} vs shell ±${shell.max.x.toFixed(2)}`);
  check('...and stay low — a fan, not a wall', wings.max.y < shell.max.y,
    `wing top ${wings.max.y.toFixed(2)} vs shell top ${shell.max.y.toFixed(2)}`);
}

// The oversized one: for the special encounter she is her own model now, not the round little one
// scaled up — the moving legs that read as cute waddle on the small beetle made the big one look
// daft, so she is drawn longer and set steadier on her feet. Measured against the common beetle
// the way she will be seen: standing next to one.
{
  const queen = buildSoldier('ladybug_queen');
  queen.root.remove(queen.gustArc!);
  const q = size(queen.root), bug = size(bugModel.root);
  const qw = q.max.x - q.min.x, ql = q.max.z - q.min.z, qh = q.max.y - q.min.y;
  const bw = bug.max.x - bug.min.x, bl = bug.max.z - bug.min.z, bh = bug.max.y - bug.min.y;
  check('the queen is her own, longer model, not the little one scaled up', ql / qw > (bl / bw) * 1.15,
    `queen ${ql.toFixed(2)}x${qw.toFixed(2)} (l/w ${(ql / qw).toFixed(2)}) vs beetle ${bl.toFixed(2)}x${bw.toFixed(2)} (l/w ${(bl / bw).toFixed(2)})`);
  check('...and still noticeably bigger in every direction', qw > bw * 1.3 && qh > bh * 1.15,
    `queen ${qw.toFixed(2)}x${ql.toFixed(2)}x${qh.toFixed(2)} vs bug ${bw.toFixed(2)}x${bl.toFixed(2)}x${bh.toFixed(2)}`);
  check('...and her clap of wind carries a good deal further than a common beetle\'s',
    gustRange('ladybug_queen') > gustRange('ladybug') * 1.4, `${gustRange('ladybug_queen')} vs ${gustRange('ladybug')} tiles`);
  // the steadier walk: pose both beetles at full stride and read how far the body rocks. The legs
  // themselves stride exactly as far on both — it is the hull that stops rolling with the step
  const qb = buildSoldier('ladybug_queen'), cb = buildSoldier('ladybug');
  poseLadybug(qb, 0, 0, 1, 0.3);
  poseLadybug(cb, 0, 0, 1, 0.3);
  check('her six legs stride as far as the common beetle\'s',
    qb.legHips!.every((hip, i) => Math.abs(hip.rotation.x - cb.legHips![i].rotation.x) < 1e-9),
    `queen hip ${qb.legHips![0].rotation.x.toFixed(2)} vs beetle ${cb.legHips![0].rotation.x.toFixed(2)}`);
  check('...but her body rolls and yaws well under the common beetle\'s waddle',
    Math.abs(qb.body.rotation.z) < Math.abs(cb.body.rotation.z) * 0.6 && Math.abs(qb.body.rotation.y) < Math.abs(cb.body.rotation.y) * 0.6 && qb.body.position.y < cb.body.position.y,
    `queen roll ${Math.abs(qb.body.rotation.z).toFixed(3)} yaw ${Math.abs(qb.body.rotation.y).toFixed(3)} vs beetle ${Math.abs(cb.body.rotation.z).toFixed(3)}/${Math.abs(cb.body.rotation.y).toFixed(3)}`);
  // ...and her longer membranes still fold away under her longer shell, vertex by vertex against
  // the curved covers, exactly the way the common beetle's are checked above
  const qbug = buildSoldier('ladybug_queen');
  qbug.root.remove(qbug.gustArc!);
  qbug.root.scale.set(1, 1, 1); // author space
  const long = 1.26, wide = 0.94, high = 0.92, nose = 0.62 * (1.26 - 1);
  const qcover = (p: THREE.Vector3) => {
    const f = (cx: number, cy: number, cz: number, hx: number, hy: number, hz: number) =>
      ((p.x - cx) / hx) ** 2 + ((p.y - cy) / hy) ** 2 + ((p.z - cz) / hz) ** 2 - 1;
    return Math.min(f(0, 0.6, -0.22, 0.56 * wide, 0.42 * high, 0.62 * long), f(0, 0.52, -0.02, 0.53 * wide, 0.26, 0.7 * long), f(0, 0.8, 0.44 + nose, 0.43 * wide, 0.22, 0.26));
  };
  let qn = 0, qout = 0, qworst = 0;
  for (const side of [qbug.hindwingL!, qbug.hindwingR!]) {
    side.updateWorldMatrix(true, true);
    for (const child of side.children) {
      const mesh = child as THREE.Mesh;
      const pos = mesh.geometry.getAttribute('position');
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        const d = qcover(v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld));
        qn++;
        if (d > 0) { qout++; qworst = Math.max(qworst, d); }
      }
    }
  }
  check('...and her folded wings vanish under that longer shell', qout / qn < 0.02 && qworst < 0.05,
    `${qout}/${qn} vertices outside the cover, deepest ${qworst.toFixed(4)}`);
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
  check('...and it hurts her on the way out', player.hp === MAX_HP - bug.st.dmg, `hp=${player.hp} of ${MAX_HP}`);
  check('...once, for exactly the damage its stats say', hits.length === 1 && hits[0] === bug.st.dmg,
    `tryHitPlayer called ${hits.length}x with ${hits.join(',')} (dmg ${bug.st.dmg})`);
  check('the gust reaches as far as its ground tell promises', Math.abs(player.pos.z - pz0) <= gustRange('ladybug'));
}

// The charge tell is a decal over terrain, not a flat plate through it: on a gentle rise every
// vertex should be lifted to the rendered ground under that part of the cone.
{
  const facings = [0, 2, 4, 6] as const;
  let best = { x: 44.5, z: 39.1, facing: 0, spread: 0 };
  for (let z = 2.5; z < world.h - 3; z += 0.5) for (let x = 2.5; x < world.w - 3; x += 0.5) {
    if (world.lushness(x, z) < 0.8 || world.boxCollides(x, z, 0.3, 0.25)) continue;
    for (const facing of facings) {
      const v = FACING_VEC[facing], rootY = world.surfaceAt(x, z);
      let hi = -Infinity, lo = Infinity;
      for (let d = 0.3; d <= gustRange('ladybug') * 0.9; d += 0.35) {
        const y = world.renderedSurfaceAt(x + v[0] * d, z + v[1] * d) - rootY;
        hi = Math.max(hi, y); lo = Math.min(lo, y);
      }
      if (hi - lo > best.spread) best = { x, z, facing, spread: hi - lo };
    }
  }
  const { ctx } = makeCtx(best.x + 8, best.z + 8);
  const bug = new Enemy(ctx, 'ladybug', best.x, best.z);
  bug.facing = best.facing as typeof bug.facing;
  bug.state = 'windup';
  bug.stateT = 0.2;
  bug.update(DT);
  const arc = bug.model.gustArc!;
  bug.model.root.updateWorldMatrix(true, true);
  const pos = arc.geometry.getAttribute('position');
  const p = new THREE.Vector3();
  let minClear = Infinity, maxErr = 0;
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).applyMatrix4(arc.matrixWorld);
    const clear = p.y - world.renderedSurfaceAt(p.x, p.z);
    minClear = Math.min(minClear, clear);
    maxErr = Math.max(maxErr, Math.abs(clear - LADYBUG_GUST_TELL_HOVER));
  }
  check('the gust warning follows sloped terrain instead of sinking through it',
    best.spread > LADYBUG_GUST_TELL_HOVER && minClear > LADYBUG_GUST_TELL_HOVER - 0.01 && maxErr < 0.015,
    `terrain spread=${best.spread.toFixed(3)} clear=${minClear.toFixed(3)} err=${maxErr.toFixed(3)}`);
}

// Two beetles clapping in the same breath: the wind hurts, but her i-frames are still hers, so a pair
// of them cannot grind her down any faster than one — though both gusts throw her.
{
  const { ctx, player, hits } = makeCtx(44.5, 41.5);
  const a = new Enemy(ctx, 'ladybug', 44.5, 39.6); a.facing = 0;
  const b = new Enemy(ctx, 'ladybug', 45.4, 39.8); b.facing = 0;
  ctx.enemies.push(a, b);
  for (const bug of [a, b]) { bug.state = 'attack'; bug.stateT = 0.2; bug.fired = false; bug.update(DT); }
  check('two gusts in the same breath only cost her one hit', hits.length === 2 && player.hp === MAX_HP - 1,
    `${hits.length} calls, hp ${player.hp} of ${MAX_HP}`);
  check('...and both of them still throw her', player.knock.z > 0 && Math.abs(player.knock.z) > 2, `knock ${player.knock.z.toFixed(1)}`);
}

// Facing matters: a beetle charged up with the heroine at its back leaves her alone.
{
  const { ctx, player, hits } = makeCtx(44.5, 38.0);
  const bug = new Enemy(ctx, 'ladybug', 44.5, 41.0);
  bug.facing = 4; // looking north, away from her
  ctx.enemies.push(bug);
  const pz0 = player.pos.z;
  for (let i = 0; i < Math.round(0.6 / DT); i++) bug.update(DT);
  check('a gust thrown the other way leaves her standing', Math.abs(player.pos.z - pz0) < 0.05 && player.hp === MAX_HP && hits.length === 0,
    `moved ${Math.abs(player.pos.z - pz0).toFixed(2)} tiles, hp ${player.hp}, ${hits.length} hit(s)`);
}

// A sword blow mid-charge: the beetle has braced for the clap, so a plain swing only nudges it
// and does not cancel the charge — the clap comes anyway. Only the charged spin breaks it off.
{
  const { ctx, player, hits } = makeCtx(44.5, 41.5);
  const bug = new Enemy(ctx, 'ladybug', 44.5, 39.1);
  bug.facing = 0; // due south, at the player
  ctx.enemies.push(bug);
  bug.state = 'windup'; bug.stateT = 0.5; // shell partway open
  const pz0 = player.pos.z;
  bug.hurt(1, player.pos.x, player.pos.z); // a plain swing lands on the charging shell
  check('a plain swing does not cancel the charge', bug.state === 'windup' && bug.stateT > 0.4,
    `state=${bug.state} t=${bug.stateT.toFixed(2)}`);
  check('...and the braced beetle takes a lighter shove', Math.hypot(bug.knock.x, bug.knock.z) < 4 && bug.knockT < 0.22,
    `shove ${Math.hypot(bug.knock.x, bug.knock.z).toFixed(1)} for ${bug.knockT.toFixed(2)}s (a loose beetle takes 6.5 for 0.22s)`);
  // let the charge finish, the clap land, and her throw play out
  for (let i = 0; i < Math.round(1.5 / DT); i++) {
    bug.update(DT); player.update(DT, NO_INPUT);
  }
  check('the clap comes anyway, on the charge that was never cancelled',
    hits.length === 1 && player.hp === MAX_HP - bug.st.dmg && player.pos.z > pz0 + 0.5,
    `hp ${player.hp} of ${MAX_HP}, ${hits.length} hit(s), moved ${(player.pos.z - pz0).toFixed(2)} tiles`);
}

// The charge stance, measured head-on against a loose beetle — and the one blow that still breaks
// the charge off: the charged spin.
{
  const { ctx, player } = makeCtx(44.5, 41.5);
  const braced = new Enemy(ctx, 'ladybug', 44.5, 39.1);
  braced.state = 'windup'; braced.stateT = 0.5;
  const loose = new Enemy(ctx, 'ladybug', 46.5, 39.1);
  ctx.enemies.push(braced, loose);
  braced.hurt(1, player.pos.x, player.pos.z);
  loose.hurt(1, player.pos.x, player.pos.z);
  const kb = Math.hypot(braced.knock.x, braced.knock.z), kl = Math.hypot(loose.knock.x, loose.knock.z);
  check('a charging beetle takes less than half the shove a loose one does',
    kb > 0 && kl > 6 && kl < 7 && kb < kl / 2, `charging ${kb.toFixed(1)} vs loose ${kl.toFixed(1)}`);
  check('...and it is back on its feet sooner', braced.knockT < loose.knockT,
    `${braced.knockT.toFixed(2)}s vs ${loose.knockT.toFixed(2)}s`);
  check('...and its charge is still going', braced.state === 'windup' && loose.state === 'chase',
    `braced=${braced.state} loose=${loose.state}`);
  braced.hurt(1, player.pos.x, player.pos.z, true); // the charged spin
  check('the charged spin does break the charge off', braced.state === 'chase', `state=${braced.state}`);
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
  const far = new Enemy(ctx, 'sword', 60.5, 38.6 + gustRange('ladybug') + 0.6);
  far.knockT = 0;
  ctx.enemies.push(far);
  bug.state = 'attack'; bug.stateT = 0.2; bug.fired = false;
  bug.update(DT);
  check('...but not what is out of reach', far.knockT <= 0);
}

// The queen throws the same wind, but hers reaches past where a common beetle's stops.
{
  const { ctx, player, hits } = makeCtx(44.5, 42.4);
  const queen = new Enemy(ctx, 'ladybug_queen', 44.5, 37.8);
  queen.facing = 0; // due south, up the meadow
  ctx.enemies.push(queen);
  const reaches = new Enemy(ctx, 'sword', 44.5, 37.8 + gustRange('ladybug_queen') - 0.3);
  ctx.enemies.push(reaches);
  queen.state = 'attack'; queen.stateT = 0.2; queen.fired = false;
  queen.update(DT);
  check('the queen\'s clap blows away soldiers a common beetle could not touch',
    reaches.knockT > 0 && gustRange('ladybug_queen') - 0.3 > gustRange('ladybug'),
    `${(gustRange('ladybug_queen') - 0.3).toFixed(1)} tiles out, common reach ${gustRange('ladybug')}`);
  const beyond = new Enemy(ctx, 'sword', 44.5, 37.8 + gustRange('ladybug_queen') + 0.6);
  ctx.enemies.push(beyond);
  queen.state = 'attack'; queen.stateT = 0.2; queen.fired = false;
  queen.update(DT);
  check('...and still stops at the edge of her own cone', beyond.knockT <= 0);
  // and where the two claps cross, hers is the one that costs a whole heart
  player.pos = { x: 44.5, z: 41.0 };
  queen.state = 'attack'; queen.stateT = 0.2; queen.fired = false;
  queen.update(DT);
  check('the queen\'s clap costs a whole heart where a common beetle\'s costs half of one',
    player.hp === MAX_HP - queen.st.dmg && queen.st.dmg === 2 && hits[hits.length - 1] === 2 && player.knock.z > 0,
    `hp ${player.hp} of ${MAX_HP}, last blow ${hits[hits.length - 1]}`);
}

// ============================================================ the wind itself
// The effects are pure scene graph (no renderer needed): build one and play it out, checking that
// the cone of wind really does reach as far as the AI's gust does.
{
  const fx = fxGust(44.5, 38.5, 0, gustRange('ladybug'));
  let frames = 0, far = 0;
  while (fx.update(DT) && frames < 200) {
    frames++;
    const b = new THREE.Box3().setFromObject(fx.group, true);
    far = Math.max(far, Math.abs(b.min.x - 44.5), Math.abs(b.max.x - 44.5), Math.abs(b.min.z - 38.5), Math.abs(b.max.z - 38.5));
  }
  check('the blast effect plays out and cleans up', frames > 10 && frames < 200, `${frames} frames`);
  check('the wind reaches exactly as far as the gust that hits her', far >= gustRange('ladybug') * 0.9 && far <= gustRange('ladybug') * 1.35, `reach=${far.toFixed(2)} vs ${gustRange('ladybug')}`);
}

// ============================================================ the population
// Lush country stocks itself with ladybugs; the dry parts of the world do not.
function runWildlife(seconds: number, x: number, z: number, viewR = 26) {
  const { ctx, player } = makeCtx(x, z);
  const wildlife = new Wildlife(ctx);
  // where each new bug was put down, recorded the frame it appears (they wander off green ground
  // soon enough — the law is about where they are *seeded*, not where a beetle ends up strolling)
  const spawned: { x: number; z: number; dist: number }[] = [];
  const queens: { x: number; z: number; dist: number }[] = [];
  let queenMax = 0;
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    // arrivals are read off the enemy list itself: the population count can stay level across a
    // frame that both releases one and seeds another (or swaps a common out for the queen)
    const n = ctx.enemies.length;
    wildlife.update(DT, viewR);
    for (const e of ctx.enemies) e.update(DT);
    for (let k = n; k < ctx.enemies.length; k++) {
      const b = ctx.enemies[k];
      const at = { x: b.pos.x, z: b.pos.z, dist: Math.hypot(b.pos.x - x, b.pos.z - z) };
      spawned.push(at);
      if (b.kind === 'ladybug_queen') queens.push(at);
    }
    queenMax = Math.max(queenMax, wildlife.bugs.filter((b) => b.kind === 'ladybug_queen').length);
  }
  return { ctx, player, wildlife, spawned, queens, queenMax };
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
  check('bugs left behind in the old country are let go', before > 0 && wildlife.bugs.length === 0 && ctx.enemies.every((e) => !e.alive || !isLadybug(e.kind)), `${before} -> ${wildlife.bugs.length}`);
}
{
  const { ctx } = runWildlife(40, 44.5, 38.5);
  const bugs = ctx.enemies.filter((e) => e.kind === 'ladybug');
  const bug = bugs[0];
  // The number is asserted, not just printed: the beetle must take exactly four 1-damage swings,
  // so a quiet revert of its HP fails the check instead of reading as a different number
  check('a ladybug is a soft target: four swings and it is done', swingsToKill(bug) === 4 && bug.st.hp === 4 && bug.st.dmg === 1,
    `${bug.st.hp} hp, gust does ${bug.st.dmg}`);
}
/** how many plain-swing hits it takes to kill (0 = it survives the whole trial) */
function swingsToKill(bug: Enemy, trial = 12): number {
  let hits = 0;
  while (hits < trial && bug.alive) { bug.hurt(1, bug.pos.x, bug.pos.z - 1); hits++; }
  return bug.alive ? 0 : hits;
}

// What the soft-target number means in the actual game: full sword swings run through the
// player's real state machine and the game's own reach/arc check — not direct hurt() calls.
// One full swing must hit the beetle exactly once, for 1 damage, so a 4 hp ladybug falls on
// the fourth swing (this is the thing that used to read as three in a stale build).
{
  const { ctx, player } = makeCtx(44.5, 44.5);
  player.facing = 0; // due south, at the beetle
  const bug = new Enemy(ctx, 'ladybug', 44.5, 45.8); // 1.3 tiles ahead: inside the sweep
  ctx.enemies.push(bug);
  let swings = 0, hits = 0, inSwing = 0, wasAttacking = false;
  for (let i = 0; i < 300 && bug.alive; i++) {
    const press = player.state === 'idle'; // tap the sword each frame she is free to swing
    player.update(DT, { moveX: 0, moveZ: 0, down: () => false, justPressed: () => press } as never);
    if (player.attacking) {
      if (!wasAttacking) { swings++; inSwing = 0; }
      const sw = player.getSweep();
      if (sw && bug.alive) {
        const dx = bug.pos.x - player.pos.x, dz = bug.pos.z - player.pos.z;
        const d = Math.hypot(dx, dz);
        // the same reach and arc check the game applies (game.ts: resolveSword)
        if (d <= sw.r + bug.radius && (d <= 0.45 || inArc(Math.atan2(dx, dz), sw.from, sw.to, 0.3))) {
          if (!sw.hit.has(bug)) {
            sw.hit.add(bug);
            inSwing++; hits++;
            bug.hurt(sw.dmg, player.pos.x, player.pos.z, sw.heavy);
          }
        }
      }
    }
    wasAttacking = player.attacking;
  }
  check('one full swing hits the beetle exactly once, for 1 damage', swings === hits && hits === bug.st.hp,
    `${swings} swings, ${hits} hits, ${bug.st.hp} hp`);
  check('...so a 4 hp ladybug falls on the fourth swing, not the third', !bug.alive && swings === 4, `${swings} swings`);
}

// The queen is the special encounter: one at a time, rare, and never part of the crowd. Given long
// enough in green country she turns up (out of sight, on lush ground, like everything else here),
// while the ordinary beetles keep coming the whole time — she is one beetle's worth of the six, not a
// second species muscling the commons out of the meadow.
{
  const { ctx, wildlife, spawned, queens, queenMax } = runWildlife(180, 44.5, 38.5);
  check('the oversized queen turns up in green country', queens.length >= 1 && queens.length <= 2, `${queens.length} queens, ${spawned.length} bugs seeded in 180s`);
  check('...on lush ground and out of sight, like every other bug', queens.every((q) => world.lushness(q.x, q.z) >= 0.6 && q.dist > 24),
    queens.map((q) => `${q.dist.toFixed(0)}t lush=${world.lushness(q.x, q.z).toFixed(2)}`).join(' '));
  check('...but never two of her at once', queenMax <= 1, `${queenMax} at once`);
  check('...and the ordinary beetles do not stop coming', spawned.filter((s) => !queens.includes(s)).length >= 3,
    `${spawned.length - queens.length} commons`);
  // the encounter's own queen may already have wandered off the active region and been let go by
  // then (the spawner's business, with full HP intact) — the toughness is about the species, so
  // measure it on a live one, a fresh one if the other has gone
  let queen = ctx.enemies.find((e) => e.kind === 'ladybug_queen' && e.alive);
  if (!queen) { queen = new Enemy(ctx, 'ladybug_queen', 44.5, 39.1); ctx.enemies.push(queen); }
  check('the queen is the tough one of the family', swingsToKill(queen) === 12 && queen.st.hp === 12, `${queen.st.hp} hp, dmg ${queen.st.dmg}`);
  check('...and her clap does twice what a common beetle\'s does',
    queen.st.dmg === 2 && ctx.enemies.filter((e) => e.kind === 'ladybug').every((e) => e.st.dmg === 1),
    `queen ${queen.st.dmg}, commons ${[...new Set(ctx.enemies.filter((e) => e.kind === 'ladybug').map((e) => e.st.dmg))].join(',')}`);
  check('...while the commons keep the population at its usual size', wildlife.bugs.length <= 6, `${wildlife.bugs.length} bugs`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall good');
if (failures) process.exit(1);
