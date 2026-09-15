import * as THREE from 'three';
import { World } from '../src/game/world';
import { Enemy, Player, type GameCtx } from '../src/game/entities';
import { Wildlife } from '../src/game/wildlife';
import { RNG } from '../src/game/constants';
const world = new World(); const DT=1/30;
const rng = new RNG(1234); const noop=()=>{};
const ctx:any = { world, scene:new THREE.Scene(), audio:new Proxy({}, {get:()=>noop}), rand:()=>rng.next(), talking:false, enemies:[], projectiles:[], spawnProjectile:noop, spawnEffect:noop, tryHitPlayer:()=>'hit' };
ctx.player = new Player(ctx, 44.5, 38.5);
const wl:any = new Wildlife(ctx);
for (let i=0;i<180*30;i++){ wl.update(DT,26); for(const e of ctx.enemies) e.update(DT); if(i%600===0) console.log((i/30).toFixed(0), 'bugs', wl.bugs.length, 'queenT', wl.queenT.toFixed(1), 'flowers', wl.flowers.length, 'queen', wl.bugs.filter((b:any)=>b.kind==='ladybug_queen').length, wl.bugs.map((b:any)=>Math.hypot(b.pos.x-44.5,b.pos.z-38.5).toFixed(0)).join(' ')); }
// finer: track queen lifetime
{
const rng2 = new RNG(99); const ctx2:any = { ...ctx, rand:()=>rng2.next(), enemies:[], projectiles:[] }; ctx2.player = new Player(ctx2, 44.5, 38.5);
const w2:any = new Wildlife(ctx2); let had=false;
for (let i=0;i<240*30;i++){ w2.update(DT,26); for(const e of ctx2.enemies) e.update(DT); const q=ctx2.enemies.find((e:any)=>e.kind==='ladybug_queen'); if(q&&!had){had=true;console.log('queen at',(i/30).toFixed(1),'dist',Math.hypot(q.pos.x-44.5,q.pos.z-38.5).toFixed(1));} if(had&&q&&!q.alive){console.log('queen gone at',(i/30).toFixed(1),'dist',Math.hypot(q.pos.x-44.5,q.pos.z-38.5).toFixed(1)); had=false; ctx2.enemies=ctx2.enemies.filter((e:any)=>e.alive);} }
}
