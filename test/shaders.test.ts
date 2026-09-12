// Static validation of every vegetation shader, the way three will actually compile it.
//
// The CPU previewer mirrors the foliage maths but never touches GLSL, and the sandbox has no GL
// context -- which is how two GPU-only bugs once shipped: an injected material referencing uniforms
// that were never declared (program fails to link, plants vanish) and a one-sided billboard material
// that the sheared projection's winding turns inside-out (every card backface-culled). This test
// reproduces the final shader sources in node and checks them statically:
//   1. every identifier used is declared somewhere in the final source, three's prefix, or GLSL itself;
//   2. the varyings a vertex shader writes are exactly the ones its fragment shader reads;
//   3. the billboard materials stay double-sided (the shear flips winding; one-sided = invisible).
const g2d = () => ({
  createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  putImageData: () => {},
});
(globalThis as any).document = { createElement: (tag: string) => (tag === 'canvas' ? { width: 0, height: 0, getContext: () => g2d() } : {}) };

import * as THREE from 'three';
import { World } from '../src/game/world';
import { FoliageSystem } from '../src/game/foliage';
import { GrassSystem } from '../src/game/grass';
import { swayMaterial } from '../src/game/wind';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

// ------------------------------------------------------------------ source assembly
/** three resolves `#include <chunk>` from ShaderChunk; do exactly that, recursively. */
const resolveIncludes = (src: string): string =>
  src.replace(/#include <([\w\d/]+)>/g, (_m, name: string) => {
    const chunk = (THREE.ShaderChunk as Record<string, string>)[name];
    if (chunk === undefined) throw new Error(`unknown shader chunk: ${name}`);
    return resolveIncludes(chunk);
  });

/** Run a material's onBeforeCompile against a stand-in shader record, like WebGLProgram does. */
const compiled = (mat: THREE.Material) => {
  const shader = {
    uniforms: {} as Record<string, THREE.IUniform>,
    vertexShader: (THREE.ShaderLib as any)[(mat as THREE.MeshToonMaterial).type === 'MeshToonMaterial' ? 'toon' : 'basic'].vertexShader as string,
    fragmentShader: (THREE.ShaderLib as any)[(mat as THREE.MeshToonMaterial).type === 'MeshToonMaterial' ? 'toon' : 'basic'].fragmentShader as string,
  };
  (mat.onBeforeCompile as (s: unknown) => void)(shader);
  return { vert: resolveIncludes(shader.vertexShader), frag: resolveIncludes(shader.fragmentShader) };
};

const world = new World();
const foliage = new FoliageSystem(world);
const grass = new GrassSystem(world);
const leafMat = (foliage as any).leafMat as THREE.ShaderMaterial;
const grassMat = (grass as any).material as THREE.ShaderMaterial;
const trunkMat = (foliage as any).trunkMat as THREE.MeshToonMaterial;
const fernMat = swayMaterial(new THREE.MeshToonMaterial(), { value: 0.3 }, { value: 1 });



// ------------------------------------------------------------------ 1. undeclared identifiers
const KEYWORDS = new Set(`void bool int float vec2 vec3 vec4 ivec2 ivec3 ivec4 bvec2 bvec3 bvec4 mat2 mat3 mat4 sampler2D sampler3D samplerCube sampler2DShadow samplerCubeShadow usampler2D sampler2DArray struct true false if else for while return break continue discard in out inout const attribute varying uniform precision highp mediump lowp`.split(/\s+/));
const BUILTINS = new Set(`radians degrees sin cos tan asin acos atan pow exp log exp2 log2 sqrt inversesqrt abs sign floor ceil fract mod min max clamp mix step smoothstep length distance dot cross normalize faceforward reflect refract matrixCompMult lessThan lessThanEqual greaterThan greaterThanEqual equal notEqual any all not texture texture2D texture2DProj textureCube textureSize texelFetch dFdx dFdy fwidth main linearToOutputTexel sRGBTransferEOTF sRGBTransferOETF`.split(/\s+/));
// what three's WebGLProgram prefix declares around every material (abridged to what the vegetation
// shaders and three's own chunks reference; skin/tangent attributes live in the prefix too)
const PREFIX = new Set(`position normal uv uv2 color instanceMatrix instanceColor modelMatrix modelViewMatrix projectionMatrix viewMatrix normalMatrix cameraPosition isOrthographic receiveShadow tangent skinIndex skinWeight`.split(/\s+/));
/** gl_* builtins and MACRO_STYLE names (three's prefix defines the feature macros). */
const freeIdentifier = (id: string) => id.startsWith('gl_') || /^[A-Z][A-Z0-9_]*$/.test(id);

const TYPES = 'void|float|int|bool|vec2|vec3|vec4|ivec2|ivec3|ivec4|bvec2|bvec3|bvec4|mat2|mat3|mat4|sampler2D|sampler3D|samplerCube|sampler2DShadow|samplerCubeShadow|usampler2D|sampler2DArray';

/**
 * A pocket GLSL preprocessor: drop the branches a compile would not see, so dead feature code
 * (USE_CLEARCOAT, USE_IRIDESCENCE, ...) cannot report phantom identifiers. Undefined macros evaluate
 * false/0; pass the ones the material really has (instancing, instance colour).
 */
const preprocess = (src: string, defines: Set<string>): string => {
  const evalCond = (expr: string): boolean => {
    const js = expr
      .replace(/defined\s*\(\s*(\w+)\s*\)/g, (_m, id: string) => (defines.has(id) ? '1' : '0'))
      .replace(/defined\s+(\w+)/g, (_m, id: string) => (defines.has(id) ? '1' : '0'))
      .replace(/\b[A-Z_][A-Z0-9_]*\b/g, '0');   // any other macro: not defined for this scan
    try { return !!new Function(`return (${js});`)(); } catch { return false; }
  };
  const out: string[] = [];
  const stack: { active: boolean; parent: boolean; taken: boolean }[] = [{ active: true, parent: true, taken: false }];
  for (const line of src.split('\n')) {
    const t = line.trim();
    const top = stack[stack.length - 1];
    if (t.startsWith('#ifdef')) {
      stack.push({ active: top.active && defines.has(t.slice(6).trim()), parent: top.active, taken: defines.has(t.slice(6).trim()) });
    } else if (t.startsWith('#ifndef')) {
      const c = !defines.has(t.slice(7).trim());
      stack.push({ active: top.active && c, parent: top.active, taken: c });
    } else if (t.startsWith('#if ')) {
      const c = evalCond(t.slice(4));
      stack.push({ active: top.active && c, parent: top.active, taken: c });
    } else if (t.startsWith('#elif')) {
      const c = !top.taken && evalCond(t.slice(5));
      top.taken = top.taken || c; top.active = top.parent && c;
    } else if (t.startsWith('#else')) {
      const c = !top.taken;
      top.taken = true; top.active = top.parent && c;
    } else if (t.startsWith('#endif')) {
      if (stack.length > 1) stack.pop();
    } else if (top.active) {
      out.push(line);
    }
  }
  return out.join('\n');
};

const declaredIn = (src: string): Set<string> => {
  const decl = new Set<string>();
  const add = (m: Iterable<RegExpMatchArray>, g: number) => { for (const x of m) decl.add(x[g]); };
  // `uniform|attribute|varying|const` + optional precision + type + name (globals, locals, params)
  add(src.matchAll(new RegExp(`(?:\\b(?:uniform|attribute|varying|const)\\s+)?(?:highp|mediump|lowp)?\\s*(?:${TYPES})\\s+([A-Za-z_]\\w*)`, 'g')), 1);
  // comma declarators: `float a = 1.0, b = 2.0;`
  add(src.matchAll(/,\s*([A-Za-z_]\w*)\s*(?:=|;|,)/g), 1);
  // assignment targets (a missed local, never a uniform: uniforms are only ever read)
  add(src.matchAll(/\b([A-Za-z_]\w*)\s*(?:=[^=]|\+\+|--)/g), 1);
  // struct definitions and struct-typed declarations, incl. arrays (`SunLight sunLights[ N ];`)
  add(src.matchAll(/struct\s+([A-Za-z_]\w*)/g), 1);
  add(src.matchAll(/\b([A-Z]\w*)\s+([A-Za-z_]\w*)\s*(?:=|;|,|\)|\[)/g), 1);
  add(src.matchAll(/\b([A-Z]\w*)\s+([A-Za-z_]\w*)\s*(?:=|;|,|\)|\[)/g), 2);
  // preprocessor defines
  add(src.matchAll(/#define\s+([A-Za-z_]\w*)/g), 1);
  return decl;
};

const scanSrc = (src: string, defines: Set<string>): string[] => {
  const live = preprocess(src, defines);
  const decl = declaredIn(live);
  const body = live
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*#[^\n]*$/gm, '');
  const used = new Set<string>();
  for (const m of body.matchAll(/(?<![.\w])[A-Za-z_]\w*/g)) used.add(m[0]);
  return [...used].filter((id) => !decl.has(id) && !KEYWORDS.has(id) && !BUILTINS.has(id) && !PREFIX.has(id) && !freeIdentifier(id));
};
const scan = (name: string, src: string, defines: Set<string>) => {
  const bad = scanSrc(src, defines);
  check(`${name}: no undeclared identifiers`, bad.length === 0, bad.join(', '));
};

scan('leaf vert', leafMat.vertexShader, new Set());
scan('leaf frag', leafMat.fragmentShader, new Set());
scan('grass vert', grassMat.vertexShader, new Set());
scan('grass frag', grassMat.fragmentShader, new Set());
// the scanner must catch the exact bug it was written for: an injected uniform with no declaration
{
  const WIND = await import('../src/game/wind').then((m) => m.WIND_GLSL);
  const broken = (THREE.ShaderLib as any).toon.vertexShader.replace('#include <begin_vertex>',
    `#include <begin_vertex>\n{ float k = uSwayGain * gustAt(vec2(0.0), uCanopyScale); transformed.x += k; }`);
  check('the scanner catches undeclared injected uniforms', scanSrc(WIND + broken, new Set()).includes('uSwayGain'));
}

const INST = new Set(['USE_INSTANCING', 'USE_INSTANCING_COLOR']);
scan('trunk+sway vert', compiled(trunkMat).vert, INST);
scan('trunk+sway frag', compiled(trunkMat).frag, INST);
scan('undergrowth+sway vert', compiled(fernMat).vert, INST);

// ------------------------------------------------------------------ 2. varying pairs
const varyingsOf = (src: string) => {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/varying\s+(\w+)\s+([A-Za-z_]\w*)\s*;/g)) out.set(m[2], m[1]);
  return out;
};
for (const [pair, v, f] of [['leaf', leafMat.vertexShader, leafMat.fragmentShader], ['grass', grassMat.vertexShader, grassMat.fragmentShader]] as [string, string, string][]) {
  const vv = varyingsOf(resolveIncludes(v)), ff = varyingsOf(resolveIncludes(f));
  const missing = [...ff.keys()].filter((k) => !vv.has(k));
  const mismatch = [...ff.entries()].filter(([k, t]) => vv.get(k) && vv.get(k) !== t).map(([k]) => k);
  check(`${pair}: fragment varyings all written by the vertex shader`, missing.length === 0 && mismatch.length === 0,
    missing.length ? `missing ${missing.join(',')}` : mismatch.length ? `type mismatch ${mismatch.join(',')}` : `${ff.size} varying(s)`);
}

// ------------------------------------------------------------------ 3. billboard winding
// The game's projection is sheared (game.ts multiplies SHEAR_MATRIX into projectionMatrix), which
// turns the leaf billboards' winding clockwise in view space. One-sided materials therefore cull
// every card -- the canopies go invisible while their shadow discs stay. Grass learned this first.
check('leaf cards are double-sided', leafMat.side === THREE.DoubleSide, `side=${leafMat.side}`);
check('grass blades are double-sided', grassMat.side === THREE.DoubleSide, `side=${grassMat.side}`);

// the injected sway must survive on a shared material without dropping three's own uniforms
{
  const sh = compiled(trunkMat);
  check('sway injection keeps the toon lighting includes', sh.vert.includes('vec3 transformed = vec3( position );') && sh.frag.includes('gradientMap'), '');
  check('sway injection declares its own uniforms', /uniform float uSwayGain;/.test(sh.vert) && /uniform float uSwayTop;/.test(sh.vert));
}

foliage.dispose();
grass.dispose();
console.log(failures ? `\n${failures} FAILURES` : '\nALL SHADER CHECKS PASSED');
process.exit(failures ? 1 : 0);
