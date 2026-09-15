// Node-side validation of the giant ladybug: the lush-country colonies it lives in, the beetle rig,
// and its special attack — the long wing-spread charge and the gust of wind that knocks everything in
// front of it away without doing any damage at all.
// The beetle is driven here exactly the way Game.updateWorld drives a materialised soldier.
// Run: npx esbuild test/ladybug.test.ts --bundle --platform=node --format=esm | node --input-type=module
import * as THREE from 'three';
import { World } from '../src/game/world';
import { WorldState } from '../src/game/worldstate';
import { Enemy, Player, Projectile, blowLooseProjectiles, type GameCtx } from '../src/game/entities';
import { buildLadybug, buildSoldier, poseLadybug } from '../src/game/models';
import { MAX_HP, RNG, FACING_VEC, facingFrom, type Facing } from '../src/game/constants';
import { SHIELD_KEYS, type Input } from '../src/game/input';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

const world = new World();
const ws = new WorldState(world);
const rng = new RNG(11);
const DT = 1 / 60;
/** how lush the ground is: the meadow, lake and farm biomes are the green, thick-grass country */
const lushness = (x: number, z: number) => { const bw = world.biomeWeights(x, z); return bw.meadow + bw.lake + bw.farm; };

// ---------------------------------------------------------------- where they live
const colonies = ws.posts.filter((p) => p.members.some((m) => m.kind === 'ladybug'));
const beetles = colonies.reduce((n, p) => n + p.members.length, 0);
console.log(`INFO ${colonies.length} ladybug colonies, ${beetles} beetles: ${colonies.map((p) => p.name).join(', ')}`);
check('ladybugs live in colonies of their own', colonies.length >= 5, `${colonies.length} colonies`);
check('a colony is beetles, not a mixed watch', colonies.every((p) => p.members.every((m) => m.kind === 'ladybug')));
check('they are common', beetles >= 15, `${beetles} beetles`);
check('every colony sits in lush ground', colonies.every((p) => lushness(p.cx, p.cz) > 0.85),
  colonies.map((p) => `${p.name} ${lushness(p.cx, p.cz).toFixed(2)}`).join(', '));
check('every colony stands on lush ground', colonies.every((p) => p.homes.every((h) => lushness(h.x, h.z) > 0.7)));
check('and on the lush biomes, not the dry ones',
  colonies.every((p) => ['meadow', 'lake', 'farm'].includes(world.groundRegion(p.cx, p.cz))),
  colonies.map((p) => world.groundRegion(p.cx, p.cz)).join('/'));
check('nothing else fields them (no beetles in a knights\' or moblins\' post)',
  ws.posts.filter((p) => !colonies.includes(p)).every((p) => p.members.every((m) => m.kind !== 'ladybug')));

// ---------------------------------------------------------------- the beetle itself
{
  const lb = buildLadybug();
  check('six legs on the tripod rig', lb.legs.length === 6);
  check('wings, wing cases and antennae are rigged',
    !!(lb.wingL && lb.wingR && lb.elytraL && lb.elytraR && lb.antennaL && lb.antennaR));
  const boxOf = (root: THREE.Object3D) => {
    root.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(root);
    return { w: b.max.x - b.min.x, d: b.max.z - b.min.z, h: b.max.y };
  };
  /** how far parts reach across x, measured on their own geometry: Box3.setFromObject over-measures
   *  thin rotated parts, and the legs and the shadow would swamp the wings either way */
  const spanOf = (parts: THREE.Object3D[]) => {
    let lo = Infinity, hi = -Infinity;
    const v = new THREE.Vector3();
    for (const root of parts) root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const g = mesh.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      const b = g.boundingBox!;
      for (let i = 0; i < 8; i++) {
        v.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(mesh.matrixWorld);
        lo = Math.min(lo, v.x); hi = Math.max(hi, v.x);
      }
    });
    return hi - lo;
  };
  const wings = [lb.wingL, lb.wingR], shell = [lb.elytraL, lb.elytraR];
  const pose = (open: number, beat: number) => { poseLadybug(lb, open, beat, 0, open * 2); lb.root.updateMatrixWorld(true); };
  pose(0, 0); // wings folded away under the cases
  const folded = boxOf(lb.root), foldedWings = spanOf(wings), shellW = spanOf(shell);
  pose(1, Math.PI / 2); // wide open, mid-beat
  const spread = boxOf(lb.root), spreadWings = spanOf(wings);
  const steps = [0, 0.25, 0.5, 0.75, 1].map((o) => { pose(o, 0); return spanOf(wings); });
  const kn = boxOf(buildSoldier('sword').root);
  console.log(`INFO beetle folded ${folded.w.toFixed(2)}w ${folded.d.toFixed(2)}d ${folded.h.toFixed(2)}h, spread ${spread.w.toFixed(2)}w ${spread.h.toFixed(2)}h; knight ${kn.w.toFixed(2)}w ${kn.h.toFixed(2)}h; shell ${shellW.toFixed(2)} across, wings ${foldedWings.toFixed(2)} -> ${spreadWings.toFixed(2)} across`);
  check('the wings fan out steadily the whole way through the charge',
    steps.every((w, i) => i === 0 || w >= steps[i - 1]) && steps[1] > steps[0] * 1.05 && steps[2] > steps[1] * 1.05,
    steps.map((w) => w.toFixed(2)).join(' -> ') + ' across');
  check('wide enough to read from the game camera: twice the closed shell',
    spreadWings > shellW * 2 && spreadWings > foldedWings * 1.9 && spreadWings > 1.5,
    `${spreadWings.toFixed(2)} tiles of wing over a ${shellW.toFixed(2)} shell`);
  check('the wing cases lift as they open', spread.h > folded.h + 0.03, `${folded.h.toFixed(2)} -> ${spread.h.toFixed(2)} high`);
  check('soldier-sized (giant, for a ladybug)', folded.h > kn.h * 0.6 && folded.h < kn.h * 1.1,
    `${folded.h.toFixed(2)} high vs a knight's ${kn.h.toFixed(2)}`);
  check('and built like a beetle: broader and longer than it is tall', folded.w > folded.h && folded.d > folded.h);
}

// ---------------------------------------------------------------- driving one
/** a GameCtx with no renderer, recording everything the beetle asks the game to do */
function harness() {
  const calls: string[] = [];
  const audio = new Proxy({}, { get: (_t, k: string) => { calls.push('audio:' + k); return () => {}; } }) as never;
  const effects: unknown[] = [];
  const projectiles: Projectile[] = [];
  const gusts: { force: number; result: string }[] = [];
  const blows: { range: number; cos: number }[] = [];
  const damage: number[] = [];
  const ctx = {
    world,
    scene: new THREE.Scene(),
    audio,
    rand: () => rng.next(),
    talking: false,
    enemies: [] as Enemy[],
    spawnProjectile: () => {},
    spawnEffect: (e: unknown) => { effects.push(e); },
    tryHitPlayer: (dmg: number) => { damage.push(dmg); return 'immune' as const; },
    blowPlayer: (sx: number, sz: number, force: number) => {
      const r = player.blow(sx, sz, force); // the real rule, from the player herself
      gusts.push({ force, result: r });
      return r;
    },
    blowProjectiles: (_sx: number, _sz: number, _dx: number, _dz: number, range: number, cos: number) => {
      blows.push({ range, cos });
      blowLooseProjectiles(projectiles, _sx, _sz, _dx, _dz, range, cos);
    },
  } as unknown as GameCtx;
  const player = new Player(ctx, 0, 0);
  (ctx as { player: Player }).player = player;
  return { ctx, player, calls, effects, projectiles, gusts, blows, damage };
}

/** the player's controls, held still (and optionally bracing her shield into the wind) */
const input = (shield = false) => ({
  moveX: 0, moveZ: 0, viewAngle: 0,
  down: (keys: string[]) => shield && keys === SHIELD_KEYS,
  justPressed: () => false,
}) as unknown as Input;

const colony = colonies[0];
/** a spot `d` tiles from (x,z) along one of the 8 headings, with clear ground all the way out to it */
function clearRun(x: number, z: number, d: number): { x: number; z: number; facing: Facing } | null {
  for (let i = 0; i < 8; i++) {
    const v = FACING_VEC[i];
    let clear = true;
    for (let s = 1; s <= d + 1; s++) if (world.isSolidTile(Math.floor(x + v[0] * s), Math.floor(z + v[1] * s))) { clear = false; break; }
    if (clear) return { x: x + v[0] * d, z: z + v[1] * d, facing: i as Facing };
  }
  return null;
}

/** stand a beetle on a colony spot with the player `d` tiles in front of it, ready to be blown */
function staged(d: number) {
  const home = colony.homes[0];
  const run = clearRun(home.x, home.z, d);
  if (!run) throw new Error('no clear ground to stage a beetle on');
  const h = harness();
  h.player.pos = { x: run.x, z: run.z };
  // she faces the beetle, so a braced shield is genuinely into the wind
  h.player.facing = facingFrom(home.x - run.x, home.z - run.z);
  const bug = new Enemy(h.ctx, 'ladybug', home.x, home.z);
  bug.facing = run.facing; // squared up to her from the start...
  const v = FACING_VEC[run.facing];
  bug.dir = { x: v[0], z: v[1] }; // ...and already lumbering her way, as a patrolling beetle would be
  h.ctx.enemies.push(bug);
  return { ...h, bug, home, run };
}

/** drive the beetle (and the player it is blowing about) until its gust lands, or `seconds` run out */
function untilGust(s: ReturnType<typeof staged>, seconds: number, shield = false, onFrame?: (i: number) => void) {
  const start = { ...s.player.pos };
  let frames = -1;
  const step = () => { for (const e of s.ctx.enemies) e.update(DT); s.player.update(DT, input(shield)); };
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    step();
    onFrame?.(i);
    if (s.gusts.length) { frames = i; break; }
  }
  // let the throw play out
  for (let i = 0; i < Math.round(0.7 / DT); i++) step();
  return {
    frames,
    hp: s.player.hp,
    thrown: Math.hypot(s.player.pos.x - start.x, s.player.pos.z - start.z),
    away: Math.hypot(s.player.pos.x - s.bug.pos.x, s.player.pos.z - s.bug.pos.z)
      - Math.hypot(start.x - s.bug.pos.x, start.z - s.bug.pos.z),
  };
}

// ---- wildlife, not one of the Fallen Knights
{
  const h = harness();
  const bug = new Enemy(h.ctx, 'ladybug', colony.homes[0].x, colony.homes[0].z);
  const knight = new Enemy(h.ctx, 'sword', colony.homes[0].x + 1, colony.homes[0].z);
  check('a beetle is wildlife, and every soldier is not', bug.isWildlife && !knight.isWildlife);
  bug.dispose(); knight.dispose();
}

// ---- the special attack: spread, beat, blow her away, no damage
{
  const s = staged(3);
  const seen: string[] = [];
  let chargeFrames = 0, wingAtGust = 0, halfSpread = 0;
  const r = untilGust(s, 6, false, () => {
    if (s.bug.state === 'windup') { chargeFrames++; halfSpread = Math.max(halfSpread, s.bug.wingOpen); }
    if (s.gusts.length) wingAtGust = s.bug.wingOpen;
    if (!seen.length || seen[seen.length - 1] !== s.bug.state) seen.push(s.bug.state);
  });
  console.log(`INFO gust ${(chargeFrames * DT).toFixed(2)}s after it stopped (states ${seen.join(' -> ')}), wings ${halfSpread.toFixed(2)} mid-charge / ${wingAtGust.toFixed(2)} at the blast, thrown ${r.thrown.toFixed(2)} tiles`);
  check('it stops and winds up before it blows', seen.includes('windup') && seen.includes('attack'));
  check('the charge takes a moment (a tell you can read)', chargeFrames * DT > 0.5, `${(chargeFrames * DT).toFixed(2)}s of spreading wings`);
  check('the wings spread through the charge', halfSpread > 0.35 && halfSpread < 0.99, halfSpread.toFixed(2));
  check('and are wide open when the gust comes', wingAtGust > 0.85, wingAtGust.toFixed(2));
  check('one gust, one blast', s.gusts.length === 1 && s.gusts[0].result === 'blown', JSON.stringify(s.gusts));
  check('it does no damage whatsoever', s.player.hp === MAX_HP && s.damage.length === 0, `hp ${s.player.hp}, hits ${s.damage.join('/')}`);
  check('and it throws her away from the beetle', r.thrown > 0.6 && r.away > 0.5, `${r.thrown.toFixed(2)} tiles, ${r.away.toFixed(2)} further off`);
  check('the wind is seen and heard', s.effects.length >= 1 && s.calls.includes('audio:gust') && s.calls.includes('audio:wings'),
    s.calls.filter((c) => c.startsWith('audio:')).join(', '));
  check('the gust reaches loose arrows too', s.blows.length === 1 && s.blows[0].range > 3 && s.blows[0].cos > 0.5);
  // a beat later, with the next charge still on cooldown, the wings are folded away under the cases again
  for (let i = 0; i < Math.round(0.4 / DT); i++) { s.bug.update(DT); s.player.update(DT, input()); }
  check('then the wings fold away again', s.bug.wingOpen < 0.2 && s.bug.state !== 'windup',
    `${s.bug.wingOpen.toFixed(2)} open, ${s.bug.state}`);
}

// ---- a braced shield stands in the wind
{
  const free = untilGust(staged(3), 6);
  const braced = untilGust(staged(3), 6, true);
  console.log(`INFO thrown ${free.thrown.toFixed(2)} tiles open, ${braced.thrown.toFixed(2)} braced`);
  check('she is thrown when she isn\'t braced', free.thrown > 0.6 && free.away > 0.5);
  check('bracing the shield into the wind holds her ground', braced.thrown < free.thrown * 0.6, `${braced.thrown.toFixed(2)} vs ${free.thrown.toFixed(2)}`);
  check('and still no damage either way', free.hp === MAX_HP && braced.hp === MAX_HP);
}

// ---- the cone: everything in front goes, nothing behind or to the side does
{
  const s = staged(3);
  const fv = FACING_VEC[s.bug.facing];
  const side: [number, number] = [-fv[1], fv[0]];
  // a knight already inside the wings' reach, plus two standing well out of the cone. The two are
  // parked (idle, facing away, nothing to see) so that whatever moves them is the wind and not them.
  const front = new Enemy(s.ctx, 'sword', s.home.x + fv[0] * 2.2, s.home.z + fv[1] * 2.2);
  const behind = new Enemy(s.ctx, 'sword', s.home.x - fv[0] * 2.5, s.home.z - fv[1] * 2.5);
  const aside = new Enemy(s.ctx, 'sword', s.home.x + side[0] * 2.5, s.home.z + side[1] * 2.5);
  for (const e of [front, behind, aside]) s.ctx.enemies.push(e);
  // Parked idle and looking the other way: an enemy's view is a wide arc, so these two have to be
  // facing away from the player herself, not merely away from the beetle, or they would charge in.
  for (const e of [behind, aside]) {
    e.facing = facingFrom(e.pos.x - s.player.pos.x, e.pos.z - s.player.pos.z);
    e.state = 'idle'; e.stateT = 99;
  }
  // and one hugging the beetle's backshell, the spot you slip into to dodge the blast
  const hugging = new Enemy(s.ctx, 'sword', s.home.x - fv[0] * 0.45, s.home.z - fv[1] * 0.45);
  hugging.facing = facingFrom(hugging.pos.x - s.player.pos.x, hugging.pos.z - s.player.pos.z);
  hugging.state = 'idle'; hugging.stateT = 99;
  s.ctx.enemies.push(hugging);
  const victims = [front, behind, aside, hugging];
  const hp0 = new Map<Enemy, number>(victims.map((e) => [e, e.hp]));
  const knocked = new Map<Enemy, number>(victims.map((e) => [e, 0]));
  const step = () => {
    for (const e of s.ctx.enemies) { knocked.set(e, Math.max(knocked.get(e)!, e.knockT)); e.update(DT); }
    s.player.update(DT, input());
  };
  // drive to the blast, then a beat past it: the knock slides its victims for a quarter second and
  // suspends their own wits while it does, so this window is the wind's work alone
  let gustFrame = -1;
  for (let i = 0; i < Math.round(6 / DT) && gustFrame < 0; i++) { step(); if (s.gusts.length) gustFrame = i; }
  const atGust = new Map<Enemy, { x: number; z: number }>(victims.map((e) => [e, { ...e.pos }]));
  for (let i = 0; i < Math.round(0.35 / DT); i++) step();
  check('the gust landed', gustFrame >= 0, `${(gustFrame * DT).toFixed(2)}s in`);
  const pushed = (e: Enemy) => { // how far it slid away from the beetle in that window
    const f = atGust.get(e)!;
    const dx = e.pos.x - s.bug.pos.x, dz = e.pos.z - s.bug.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    return ((e.pos.x - f.x) * dx + (e.pos.z - f.z) * dz) / d;
  };
  console.log(`INFO front slid ${pushed(front).toFixed(2)} tiles out (knocked ${knocked.get(front)!.toFixed(2)}s), behind ${pushed(behind).toFixed(2)} (knocked ${knocked.get(behind)!.toFixed(2)}s), side ${pushed(aside).toFixed(2)} (knocked ${knocked.get(aside)!.toFixed(2)}s), hugging its back ${pushed(hugging).toFixed(2)} (knocked ${knocked.get(hugging)!.toFixed(2)}s)`);
  check('the wind takes whatever is in front of it, knights and all', knocked.get(front)! > 0.2 && pushed(front) > 0.15);
  check('and leaves what stands behind it alone', knocked.get(behind) === 0);
  check('or wide of it alone', knocked.get(aside) === 0);
  check('and round the back of it is safe', knocked.get(hugging) === 0);
  check('none of them are hurt by it either', victims.every((e) => e.hp === hp0.get(e)));
  for (const e of victims) e.dispose();
}

// ---- a sword blow through the spread interrupts it
{
  const s = staged(3);
  let interrupted = false;
  for (let i = 0; i < Math.round(4 / DT) && !interrupted; i++) {
    s.bug.update(DT);
    s.player.update(DT, input());
    if (s.bug.state === 'windup' && s.bug.wingOpen > 0.4) {
      interrupted = true;
      s.bug.hurt(1, s.player.pos.x, s.player.pos.z);
    }
  }
  // a short window: long enough for the wings to fold, too short for it to wind up again (cooldown 0.5s)
  for (let i = 0; i < Math.round(0.45 / DT); i++) { s.bug.update(DT); s.player.update(DT, input()); }
  check('hitting it mid-spread interrupts the gust', interrupted && s.gusts.length === 0, `gusts ${s.gusts.length}`);
  check('and the wings fold away', s.bug.wingOpen < 0.3, s.bug.wingOpen.toFixed(2));
  check('the shell takes a sword like anything else', s.bug.hp === 4, `hp ${s.bug.hp}`);
}

// ---- the wind turns a loose arrow
{
  const h = harness();
  const at = colony.homes[1];
  const inCone = new Projectile(h.ctx, 'arrow', at.x + 2, at.z, { x: -1, z: 0 }, 1);
  const outCone = new Projectile(h.ctx, 'arrow', at.x - 2, at.z, { x: -1, z: 0 }, 1);
  h.projectiles.push(inCone, outCone);
  const speed = inCone.speed;
  const caught = blowLooseProjectiles(h.projectiles, at.x, at.z, 1, 0, 4.2, Math.cos(0.62));
  check('an arrow caught in the cone is turned downwind and slowed',
    caught === 1 && inCone.dir.x > 0.99 && inCone.speed < speed, `${caught} caught, dir ${inCone.dir.x.toFixed(2)}, speed ${inCone.speed.toFixed(1)}`);
  check('an arrow outside it flies on', outCone.dir.x === -1 && outCone.speed === speed);
  inCone.destroy(); outCone.destroy();
}

console.log(failures ? `\n${failures} FAILURES` : '\nALL TESTS PASSED');
process.exit(failures ? 1 : 0);
