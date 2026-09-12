import { World } from '../src/game/world';
import { Tile } from '../src/game/constants';

const w = new World();
const names: Record<number, string> = Object.fromEntries(Object.entries(Tile).filter(([k]) => isNaN(+k)).map(([k, v]) => [v as number, k]));

// 1. distribution
const dist: Record<string, number> = {};
for (let z = 0; z < w.h; z++) for (let x = 0; x < w.w; x++) {
  const n = names[w.tiles[w.idx(x, z)]];
  dist[n] = (dist[n] || 0) + 1;
}
console.log('tiles:', JSON.stringify(dist));

// 2. biome weight field sanity: sample across the meadow→moor border (x 128..164, z=80)
const line = (label: string, pts: [number, number][]) => {
  const s = pts.map(([x, z]) => {
    const bw = w.biomeWeights(x, z);
    return `${(bw.meadow + bw.lake + bw.farm).toFixed(1)}/${bw.moor.toFixed(1)}/${bw.marsh.toFixed(1)}/${bw.highland.toFixed(1)}/${bw.mesa.toFixed(1)}`; // meadow/moor/marsh/highland/mesa
  });
  console.log(label, s.join('  '));
};
line('z=80 x: ', [130, 136, 140, 144, 148, 152, 156, 160].map((x, i) => [130 + i * 4, 80] as [number, number]));
line('z=118 x:', [130, 136, 140, 144, 148, 152, 156, 160].map((x, i) => [130 + i * 4, 118] as [number, number]));

// tile-type row across the meadow→moor border (z=80, x 126..162)
const row = (z: number, x0: number, x1: number) =>
  Array.from({ length: x1 - x0 + 1 }, (_, i) => names[w.tiles[w.idx(x0 + i, z)]]);
const r1 = row(80, 126, 162);
const r2 = row(140, 126, 162);
const r3 = row(30, 130, 166);
console.log('tile row z=80 :', r1.join(''));
console.log('tile row z=140:', r2.join(''));
console.log('tile row z=30 :', r3.join(''));

// count type changes along a row (more = softer/dappled transition)
const changes = (r: string[]) => r.slice(1).filter((t, i) => t !== r[i]).length;
console.log('changes z80:', changes(r1), ' z140:', changes(r2), ' z30:', changes(r3));

// 3. brightness uniformity: grass luminance of mixed palette across the map
const lum = (c: string) => {
  const m = c.match(/\d+/g)!.map(Number);
  return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
};
let min = 1e9, max = -1e9, minP: [number, number] = [0, 0], maxP: [number, number] = [0, 0];
let pmin = 1e9, pmax = -1e9;
for (let z = 2; z < w.h - 2; z += 4) for (let x = 2; x < w.w - 2; x += 4) {
  const mix = (w as any).mixColors(x, z);
  const L = lum(mix.grass), P = lum(mix.path);
  if (L < min) { min = L; minP = [x, z]; }
  if (L > max) { max = L; maxP = [x, z]; }
  if (P < pmin) pmin = P;
  if (P > pmax) pmax = P;
}
console.log(`grass luminance range: ${min.toFixed(1)} @${minP} .. ${max.toFixed(1)} @${maxP} (span ${(max - min).toFixed(1)})`);
console.log(`path  luminance range: ${pmin.toFixed(1)} .. ${pmax.toFixed(1)} (span ${(pmax - pmin).toFixed(1)})`);

// 4. village + spawn unchanged
const villageTiles = new Set(['Grass', 'Path', 'Cobble', 'Bed', 'Flowers']);
let changed = 0;
for (let z = 1; z <= 29; z++) for (let x = 1; x <= 32; x++) if (!villageTiles.has(names[w.tiles[w.idx(x, z)]])) changed++;
console.log('village changed tiles:', changed);
console.log('veg: ferns', w.ferns.length, 'tallgrass', w.tallgrass.length, 'briars', w.briars.length, 'boulders', w.boulders.length, 'lilies', w.lilies.length);
