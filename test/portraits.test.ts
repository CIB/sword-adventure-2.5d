// Node-side validation of the hand-made dialogue portraits. The game resolves an NPC's portrait as
// `public/portraits/<id>.png` for every id in game.ts's PORTRAITS set, and falls back to a live render of the
// 3D head for everyone else — so an image on disk that is not in that set is dead weight, and an id in the set
// without a file is a broken <img>. This checks both directions, plus the shape the dialogue box expects.
// Run: npx esbuild test/portraits.test.ts --bundle --platform=node --format=esm | node --input-type=module
import { readFileSync, readdirSync, statSync } from 'node:fs';

const GAME = 'src/game/game.ts';
const DIR = 'public/portraits';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

const game = readFileSync(GAME, 'utf8');

// ---- the wiring in game.ts
const setMatch = /const PORTRAITS = new Set\(\[([^\]]*)\]\)/.exec(game);
check('game.ts declares the PORTRAITS set', !!setMatch);
const wired = [...(setMatch?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
check('the portrait set is not empty', wired.length > 0, wired.join(', '));

const versionMatch = /const PORTRAIT_VERSION = (\d+)/.exec(game);
check('game.ts declares a PORTRAIT_VERSION', !!versionMatch);
check('PORTRAIT_VERSION is bumped past the first portraits (3)', Number(versionMatch?.[1] ?? 0) > 3, 'v' + versionMatch?.[1]);

// the portrait cache-buster has to be part of the URL the game actually builds
check('the URL carries the version query', game.includes('`portraits/${id}.png?v=${PORTRAIT_VERSION}`'));

// ---- every wired id has a portrait, and every portrait is wired
interface Png { w: number; h: number; depth: number; type: number; texts: string[] }
const readPng = (path: string): Png => {
  const buf = readFileSync(path);
  check(`${path} is a PNG`, buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
  const px = { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), depth: buf[24], type: buf[25], texts: [] as string[] };
  // walk the chunks so we can see whether generator metadata (tEXt: the raw ComfyUI renders carry ~700 KB of it) survived
  for (let i = 8; i < buf.length - 8;) {
    const len = buf.readUInt32BE(i), kind = buf.toString('latin1', i + 4, i + 8);
    if (kind === 'tEXt' || kind === 'zTXt' || kind === 'iTXt') px.texts.push(kind);
    i += 12 + len;
    if (kind === 'IEND') break;
  }
  return px;
};

const files = readdirSync(DIR).filter((f) => f.endsWith('.png')).sort();
check('every wired character has a portrait file', wired.every((id) => files.includes(`${id}.png`)), files.join(', '));
check('every portrait file is wired to a character', files.every((f) => wired.includes(f.replace(/\.png$/, ''))), 'orphans: ' + files.filter((f) => !wired.includes(f.replace(/\.png$/, ''))).join(', '));

for (const f of files) {
  const path = `${DIR}/${f}`;
  const px = readPng(path);
  const kb = Math.round(statSync(path).size / 1024);
  // the dialogue box draws the square art at 46*u CSS px with image-rendering: pixelated, so it must be square
  check(`${f} is square`, px.w === px.h, `${px.w}x${px.h}`);
  // 128 matches the rest of the set and is ~1:3 of the on-screen box at the common scales: plenty, and small
  check(`${f} is 128x128`, px.w === 128 && px.h === 128, `${px.w}x${px.h}`);
  check(`${f} is 8-bit truecolour (colour type 2)`, px.depth === 8 && px.type === 2, `depth ${px.depth}, type ${px.type}`);
  check(`${f} carries no generator metadata`, px.texts.length === 0, px.texts.join(', '));
  // a full-resolution 1024x1024 ComfyUI render is >1 MB; a downscaled portrait is ~30 KB
  check(`${f} is a downscale, not a raw render`, kb < 100, `${kb} KB`);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
