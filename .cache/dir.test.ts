import * as THREE from 'three';
import { World } from '../src/game/world';
import { Enemy, Player } from '../src/game/entities';
import { RNG } from '../src/game/constants';
const world = new World(); const rng = new RNG(1); const noop=()=>{};
const ctx:any = { world, scene:new THREE.Scene(), audio:new Proxy({}, {get:()=>noop}), rand:()=>rng.next(), talking:false, enemies:[], projectiles:[], spawnProjectile:(k:any,x:number,z:number,dx:number,dz:number)=>console.log('spit from',x.toFixed(2),z.toFixed(2),'dir',dx.toFixed(2),dz.toFixed(2)), spawnEffect:noop, tryHitPlayer:()=>'hit' };
ctx.player = new Player(ctx, 50.5, 38.5); // east
const f = new Enemy(ctx, 'spitflower', 44.5, 38.5); ctx.enemies.push(f);
for (let i=0;i<90;i++) f.update(1/30);
f.model.root.updateMatrixWorld(true);
const mouth = f.model.mouth!.getWorldPosition(new THREE.Vector3());
const headC = f.model.head.getWorldPosition(new THREE.Vector3());
console.log('headYaw', f.headYaw.toFixed(2), 'head at', headC.x.toFixed(2), headC.z.toFixed(2), 'mouth at', mouth.x.toFixed(2), mouth.z.toFixed(2), 'root', f.pos);
const disc = f.model.head.children[1].getWorldPosition(new THREE.Vector3());
const sep = f.model.head.children[0].getWorldPosition(new THREE.Vector3());
const petalTip = f.model.petals![0].children[0].getWorldPosition(new THREE.Vector3());
console.log('sepal', sep.x.toFixed(2), sep.z.toFixed(2), 'disc', disc.x.toFixed(2), disc.z.toFixed(2), 'petal', petalTip.x.toFixed(2), petalTip.y.toFixed(2), petalTip.z.toFixed(2), 'state', f.state, 'chargeP', f.chargeP.toFixed(2));
console.log('mouth y', mouth.y.toFixed(2), 'sepal y', sep.y.toFixed(2), 'head y', headC.y.toFixed(2), 'top seg', f.model.stalk![4].getWorldPosition(new THREE.Vector3()).x.toFixed(2), 'base seg', f.model.stalk![0].getWorldPosition(new THREE.Vector3()).x.toFixed(2));
