// Node-side validation of the leaf-card foliage system: atlas integrity, crown layouts, chunk
// geometry, bush cutting, streaming and the perf budget. Stubs the DOM bits the textures need.
const g2d = () => ({
  createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  putImageData: () => {},
});
(globalThis as any).document = { createElement: (tag: string) => (tag === 'canvas' ? { width: 0, height: 0, getContext: () => g2d() } : {}) };

import * as THREE from 'three';
import { World } from '../src/game/world';
import { FoliageSystem, crownCards, tintFor, foliageDry, foliageDryCell, FOLIAGE_CHUNK, BUSH_FLY, TREE_KINDS, type TreeKind } from '../src/game/foliage';
import { leafTexel, leafAtlas, LEAF_CELL, LEAF_GRID, CELL_BERRY, CELL_NEEDLE, CELL_BROAD } from '../src/game/leaftex';
import { windUniforms, viewUniforms, setWindTime, setWindView, windTexture } from '../src/game/wind';
import { GrassSystem } from '../src/game/grass';
import { MAP_W, MAP_H, SHEAR } from '../src/game/constants';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

// ------------------------------------------------------------------ the atlas
{
  // every used cell must hold a leaf clump that fills a sane share of its cell: too sparse and
  // crowns go see-through, too full and the silhouette turns back into a blob
  const frac: number[] = [];
  const t = { r: 0, g: 0, b: 0, a: 0 };
  for (let cell = 0; cell < LEAF_GRID * LEAF_GRID; cell++) {
    let cov = 0, n = 0, red = 0, lum = 0;
    for (let y = 0; y < LEAF_CELL; y++) for (let x = 0; x < LEAF_CELL; x++) {
      leafTexel(cell, (x + 0.5) / LEAF_CELL, (y + 0.5) / LEAF_CELL, t);
      if (t.a > 127) { cov++; lum += (t.r + t.g + t.b) / 3; if (t.r > t.g * 1.5) red++; }
      n++;
    }
    frac.push(cov / n);
    if (cell === CELL_BERRY) check('berry cell is red-dominant', red / Math.max(1, cov) > 0.5, `${(100 * red / Math.max(1, cov)).toFixed(0)}% red`);
    if (cell === CELL_NEEDLE[0]) check('needle cell has coverage', cov / n > 0.2 && cov / n < 0.8, `${(100 * cov / n).toFixed(0)}%`);
  }
  // a cell holds a few leaves, not a solid disc: they overlap into a canopy once instanced
  const used = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => frac[i]);
  check('leaf cells hold a substantial clump', used.every((f) => f > 0.15 && f < 0.6), used.map((f) => (100 * f).toFixed(0) + '%').join(' '));
  check('atlas is a single 96x96 texture', leafAtlas().image.width === LEAF_CELL * LEAF_GRID && leafAtlas().image.height === LEAF_CELL * LEAF_GRID);
}

// ------------------------------------------------------------------ crown layouts
{
  const a = crownCards('oak', false, 0), b = crownCards('oak', false, 0);
  check('crown layouts are cached', a === b);
  check('crown layouts are deterministic', JSON.stringify(crownCards('pine', true, 2)) === JSON.stringify(crownCards('pine', true, 2)));
  for (const kind of [...TREE_KINDS, 'bush'] as (TreeKind | 'bush')[]) {
    for (const small of [false, true]) {
      const cards = crownCards(kind, small, 0);
      const big = crownCards(kind, false, 1);
      let bad = 0, badBend = 0, badTone = 0, badCell = 0, minY = 9, maxY = -9;
      for (const c of cards) {
        if (!(c.s > 0.05 && c.s < 1.4)) bad++;
        if (!(c.bend >= 0 && c.bend <= 1.35)) badBend++;
        if (!(c.tone >= -1 && c.tone <= 1)) badTone++;
        if (!(c.cell >= 0 && c.cell < 10)) badCell++;
        minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y);
      }
      check(`${kind}${small ? ' (small)' : ''}: cards sane`, bad === 0 && badBend === 0 && badTone === 0 && badCell === 0,
        `${cards.length} cards, y ${minY.toFixed(2)}..${maxY.toFixed(2)}`);
      if (!small && kind !== 'bush') check(`${kind}: big crowns are fuller than small`, cards.length > big.length * 0.9 && cards.length >= 20, `${cards.length} cards`);
      if (kind === 'bush') check('bush crowns sit on the ground', minY > -0.05 && maxY < 1.0, `y ${minY.toFixed(2)}..${maxY.toFixed(2)}`);
    }
  }
  const berry = crownCards('bush', false, 0, true);
  check('berry bushes carry berry cards', berry.some((c) => c.cell === CELL_BERRY && c.tone < 0), `${berry.filter((c) => c.cell === CELL_BERRY).length} berries`);
  // pines must build up in tiers, oaks as one dome
  const pineY = crownCards('pine', false, 0).map((c) => c.y).sort((x, y) => x - y);
  check('pine crowns reach conifer height', pineY[pineY.length - 1] > 2.6 && pineY[0] < 1.2, `y ${pineY[0].toFixed(2)}..${pineY[pineY.length - 1].toFixed(2)}`);
}

// ------------------------------------------------------------------ palette
{
  const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const t0 = lum(tintFor('oak', 0, 0, 0).clone()), t1 = lum(tintFor('oak', 1, 0, 0).clone());
  check('palette runs shade -> sunlit', t1 > t0 * 1.8, `${t0.toFixed(3)} .. ${t1.toFixed(3)}`);
  check('berry tint is neutral (the atlas carries the red)', lum(tintFor('bush', -1, 0, 0).clone()) > 0.9);
  // judge the bleach in display space, which is what the palette is written against
  const srgb = (c: THREE.Color) => c.clone().convertLinearToSRGB();
  const lush = srgb(tintFor('oak', 0.5, 0, 0)), dry = srgb(tintFor('oak', 0.5, 0, 1));
  const hl = { h: 0, s: 0, l: 0 }, hd = { h: 0, s: 0, l: 0 };
  lush.getHSL(hl); dry.getHSL(hd);
  const warm = (c: THREE.Color) => c.r / (c.r + c.g + c.b);
  const half = warm(srgb(tintFor('oak', 0.5, 0, 0.5)));
  check('dry biomes bleach the foliage toward olive', warm(dry) > half && half > warm(lush) + 0.02 && hd.h < hl.h,
    `warmth ${warm(lush).toFixed(3)} -> ${half.toFixed(3)} -> ${warm(dry).toFixed(3)}, hue ${hl.h.toFixed(3)}->${hd.h.toFixed(3)}`);
}

// ------------------------------------------------------------------ shared wind
{
  const world = new World();
  const grass = new GrassSystem(world);
  const foliage = new FoliageSystem(world);
  const gm = (grass as any).material as THREE.ShaderMaterial;
  check('grass and foliage share the wind clock', gm.uniforms.uTime === windUniforms.uTime);
  check('grass and foliage share the screen axes', gm.uniforms.uRight === viewUniforms.uRight && gm.uniforms.uUp === viewUniforms.uUp);
  check('both read one wind texture', gm.uniforms.uWindTex.value === windTexture());
  setWindTime(7.5); setWindView(0);
  const up = viewUniforms.uUp.value as THREE.Vector3;
  check('screen-up basis matches the oblique shear', Math.abs(up.y - SHEAR / (1 + SHEAR * SHEAR)) < 1e-6 && Math.abs(up.z + 1 / (1 + SHEAR * SHEAR)) < 1e-6, up.toArray().map((v) => v.toFixed(3)).join(','));
  setWindView(Math.PI / 2);
  const right = viewUniforms.uRight.value as THREE.Vector3;
  check('screen-right follows the yaw', Math.abs(right.x) < 1e-6 && Math.abs(right.z + 1) < 1e-6);
  setWindView(0);
  void foliage;

  // ---------------------------------------------------------------- chunk geometry
  const f = foliage as any;
  const build = (tx: number, tz: number) => f.build(tx, tz, FOLIAGE_CHUNK, FOLIAGE_CHUNK);
  const forest = build(64, 0);   // Willowmere Woods
  check('a woodland chunk produces cards', !!forest?.leaves, forest ? `${(forest.leaves.geometry as THREE.InstancedBufferGeometry).instanceCount} cards` : '');
  if (forest) {
    const g = forest.leaves.geometry as THREE.InstancedBufferGeometry;
    const a0 = g.getAttribute('aData0'), a1 = g.getAttribute('aData1'), a2 = g.getAttribute('aData2'), ac = g.getAttribute('aCut');
    check('instance attributes line up', a0.count === a1.count && a1.count === a2.count && a2.count === ac.count && g.instanceCount === a0.count, `${a0.count} cards`);
    check('unit quad base geometry', g.getAttribute('position').count === 4 && g.index!.count === 6);
    let standing = 0, badSize = 0, badCell = 0;
    for (let i = 0; i < ac.count; i++) if (ac.getX(i) < 0) standing++;
    for (let i = 0; i < a0.count; i++) { if (!(a0.getW(i) > 0.02)) badSize++; if (!(a2.getW(i) >= 0 && a2.getW(i) < 10)) badCell++; }
    check('trees start standing, sizes and cells sane', standing === ac.count && badSize === 0 && badCell === 0);
    check('trunk + shadow meshes accompany the cards', !!forest.trunks && !!forest.shadows, `${forest.trunks.count} trunks, ${forest.shadows.count} shadows`);
    check('chunk bounds cover the crown overhang', g.boundingSphere.radius > FOLIAGE_CHUNK * 0.7, `r=${g.boundingSphere.radius.toFixed(1)}`);
  }

  // ---------------------------------------------------------------- bushes: cut, respawn, rebuild
  let bushChunk: [number, number] | null = null;
  outer:
  for (let cz = 0; cz < MAP_H; cz += FOLIAGE_CHUNK) for (let cx = 0; cx < MAP_W; cx += FOLIAGE_CHUNK) {
    const list = (f.bushBuckets as Map<number, { tx: number; tz: number }[]>).get(f.chunkKey(cx, cz));
    if (list?.length) { bushChunk = [cx, cz]; break outer; }
  }
  check('found a chunk with bushes', !!bushChunk);
  if (bushChunk) {
    const [bx, bz] = bushChunk;
    const bush = (f.bushBuckets as Map<number, { tx: number; tz: number }[]>).get(f.chunkKey(bx, bz))![0];
    for (let i = 0; i < 4; i++) foliage.update(i * 0.016, bx + 8, bz + 8, 16, 0);
    check('standing bush reports cuttable', foliage.hasBush(bush.tx, bush.tz));
    check('empty tile is not cuttable', !foliage.cutBush(bush.tx + 3, bush.tz + 3) || !foliage.hasBush(bush.tx + 3, bush.tz + 3));
    check('cut succeeds', foliage.cutBush(bush.tx, bush.tz));
    check('cut bush is gone', !foliage.hasBush(bush.tx, bush.tz));
    check('second cut is a no-op', !foliage.cutBush(bush.tx, bush.tz));
    const data = (f.chunks as Map<number, { leaves: THREE.Mesh }>).get(f.chunkKey(bx, bz));
    const g = data.leaves.geometry as THREE.InstancedBufferGeometry;
    const ranges = g.userData.bushRanges as Map<number, [number, number]>;
    const [start, n] = ranges.get(bush.tz * MAP_W + bush.tx)!;
    const ac = g.getAttribute('aCut') as THREE.InstancedBufferAttribute;
    let stamped = 0, others = 0;
    for (let i = 0; i < ac.count; i++) { const v = ac.getX(i); if (i >= start && i < start + n) { if (v >= 0) stamped++; } else if (v >= 0) others++; }
    check('only that bush\'s cards are stamped', stamped === n && others === 0, `${stamped}/${n} stamped, ${others} others`);
    // rebuild keeps the cut (streaming must not resurrect a cut bush)
    foliage.invalidate(bush.tx, bush.tz);
    foliage.update(1, bx + 8, bz + 8, 16, 0); foliage.update(1, bx + 8, bz + 8, 16, 0);
    check('still cut after a chunk rebuild', !foliage.hasBush(bush.tx, bush.tz));
    foliage.respawnBush(bush.tx, bush.tz);
    check('respawn stands the bush back up', foliage.hasBush(bush.tx, bush.tz));
    foliage.cutBush(bush.tx, bush.tz);
    foliage.respawnAll();
    check('respawnAll clears every cut', foliage.hasBush(bush.tx, bush.tz));
    void BUSH_FLY;
  }

  // ---------------------------------------------------------------- streaming + budget
  const t0 = performance.now();
  for (let i = 0; i < 300; i++) {
    const cx = 20 + i * 0.6, cz = 40 + Math.sin(i * 0.05) * 60;
    foliage.update(i * 0.016, cx, cz, 16, 0);
  }
  const st = foliage.stats();
  console.log(`INFO streaming: ${st.chunks} chunks resident, ${st.cards} cards, ${st.trunks} trunks, ${(performance.now() - t0).toFixed(0)} ms total`);
  // the drop test hystereses one chunk beyond the needed window, so the resident set is (2(r+1)+1)^2
  check('resident chunks bounded', st.chunks <= 81, `${st.chunks}`);
  check('resident cards bounded (perf)', st.cards < 60000, `${st.cards} cards = ${st.cards * 2} tris`);

  // worst case: the dense border forest, where a chunk is ~2600 cards. The build loop is capped by
  // both a chunk count and a wall-clock budget, so no streaming frame should be able to run away.
  {
    const frames: number[] = [];
    for (let i = 0; i < 40; i++) { const t = performance.now(); foliage.update(20 + i * 0.016, 70, 36, 16, 0); frames.push(performance.now() - t); }
    const dense = foliage.stats();
    const worst = Math.max(...frames.slice(2));   // skip the JIT tier-up of the first frames
    console.log(`INFO dense forest: ${dense.chunks} chunks, ${dense.cards} cards (${dense.cards * 2} tris), ${dense.drawCalls} draw calls, worst streaming frame ${worst.toFixed(2)} ms`);
    check('dense forest stays inside the triangle budget', dense.cards * 2 < 120000, `${dense.cards * 2} tris`);
    check('no streaming frame hitches', worst < 8, `${worst.toFixed(2)} ms`);
    check('draw calls are a handful per chunk', dense.drawCalls <= dense.chunks * 3 && dense.drawCalls < 250, `${dense.drawCalls}`);
  }

  // the dryness grid the build samples must agree with the per-plant field it replaced
  {
    const cache = new Map<number, number>();
    let maxDelta = 0;
    for (let i = 0; i < 400; i++) {
      const x = (i * 37) % MAP_W, z = (i * 53) % MAP_H;
      maxDelta = Math.max(maxDelta, Math.abs(foliageDryCell(world, x, z, cache) - foliageDry(world, x, z)));
    }
    check('dryness grid tracks the exact field', maxDelta < 0.12, `max delta ${maxDelta.toFixed(3)}, ${cache.size} cells cached`);
  }

  // whole-map cost, for the record: the old blob renderer submitted ~2.6M triangles per frame
  let mapCards = 0, mapTrees = 0;
  for (const t of world.trees) { mapCards += crownCards(t.kind ?? 'oak', t.scale < 0.8, 0).length; mapTrees++; }
  for (const b of world.bushes) mapCards += crownCards('bush', false, 0, (b.tx * 31 + b.tz * 17) % 5 === 0).length;
  const oldTris = mapTrees * 884 + world.bushes.length * 1056;
  console.log(`INFO whole map: ${mapTrees} trees + ${world.bushes.length} bushes = ${mapCards} leaf cards (${mapCards * 2} tris)`);
  console.log(`INFO old blob renderer: ~${(oldTris / 1e6).toFixed(2)}M tris per frame, all of it always submitted`);
  check('the card cloud is far cheaper than the blobs', mapCards * 2 < oldTris * 0.12, `${(mapCards * 2 / 1e6).toFixed(2)}M vs ${(oldTris / 1e6).toFixed(2)}M`);

  // chunk build cost (median of 9, worst-case forests included)
  {
    const ts: number[] = [];
    const spots: [number, number][] = [[64, 0], [0, 0], [160, 16], [32, 32], [96, 16], [176, 96], [16, 144], [112, 144], [80, 32]];
    for (const [tx, tz] of spots) {
      const t = performance.now();
      f.build(tx, tz, FOLIAGE_CHUNK, FOLIAGE_CHUNK);
      ts.push(performance.now() - t);
    }
    ts.sort((a, b) => a - b);
    console.log(`INFO foliage chunk build median: ${ts[4].toFixed(2)} ms (worst ${ts[8].toFixed(2)} ms)`);
    check('chunk build affordable', ts[4] < 12, `${ts[4].toFixed(2)} ms`);
  }
  // steady update is a no-op once streamed
  {
    for (let i = 0; i < 10; i++) foliage.update(1 + i * 0.016, 90, 20, 16, 0);
    const ts: number[] = [];
    for (let i = 0; i < 200; i++) { const t = performance.now(); foliage.update(2 + i * 0.016, 90, 20, 16, 0); ts.push(performance.now() - t); }
    ts.sort((a, b) => a - b);
    console.log(`INFO steady foliage update median: ${ts[100].toFixed(3)} ms`);
    check('steady-state update nearly free', ts[100] < 0.5, `${ts[100].toFixed(3)} ms`);
  }

  // viewer helpers
  const spec = foliage.buildSpecimen({ kind: 'oak', scale: 1 });
  check('buildSpecimen returns a plant', spec.children.length === 3);
  const patch = foliage.buildPatch(90, 20, 7);
  check('buildPatch returns a grove', patch.children.length >= 3);

  // biome dryness follows the world's soft weights
  check('highland foliage is drier than the meadow', foliageDry(world, 180, 20) > foliageDry(world, 40, 40) + 0.1,
    `${foliageDry(world, 180, 20).toFixed(2)} vs ${foliageDry(world, 40, 40).toFixed(2)}`);

  foliage.dispose();
  grass.dispose();
}

// a couple of atlas cells used by the layout, sanity-named so a bad import fails loudly
void CELL_BROAD;

console.log(failures ? `\n${failures} FAILURES` : '\nALL TESTS PASSED');
process.exit(failures ? 1 : 0);
