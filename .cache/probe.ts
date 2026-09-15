import * as THREE from 'three';
import { buildSoldier } from '../src/game/models';
const f = buildSoldier('spitflower');
f.body.rotation.y = 0; // facing +z (south, toward a player standing south)
const n = f.stalk!.length; const c = 1;
f.stalk!.forEach((s, i) => { const w = (i + 1) / n; s.rotation.x = -0.16 * c * w * 0.9; });
f.head.rotation.x = 0.45 + 0.35 * c;
f.root.updateMatrixWorld(true);
const mouth = f.mouth!.getWorldPosition(new THREE.Vector3());
const head = f.head.getWorldPosition(new THREE.Vector3());
const faceDir = new THREE.Vector3(0, 0, 1).applyQuaternion(f.head.getWorldQuaternion(new THREE.Quaternion()));
console.log('head', head.toArray().map(v=>v.toFixed(2)), 'mouth', mouth.toArray().map(v=>v.toFixed(2)), 'face normal', faceDir.toArray().map(v=>v.toFixed(2)));
