import * as THREE from 'three';
import { buildCropGeo, vertexToon } from './models';
import { CROP_KINDS, CROP_STAGES, cropStage, type VillageState, type CropKind } from './village';
import type { World } from './world';

/**
 * The farm's live view: the crops on the plots and the wetness of the soil, drawn from
 * VillageState. Crops are one InstancedMesh per (crop kind, growth stage) — eight draw calls for
 * the whole farm however many plots there are — rebuilt whenever the sim's `rev` says a stage
 * changed. Soil moisture is a multiply-blended quad per plot whose instance colour darkens the
 * ground texture beneath it, so a freshly watered row reads as wet earth that slowly pales.
 */
export class FarmView {
  root = new THREE.Group();
  private crops = new Map<string, THREE.InstancedMesh>();
  private wet: THREE.InstancedMesh;
  private rev = -1;
  private wetT = 0;
  private m4 = new THREE.Matrix4();
  private col = new THREE.Color();

  constructor(private world: World, private village: VillageState) {
    const n = Math.max(1, village.farm.length);
    for (const crop of CROP_KINDS) for (let s = 0; s < CROP_STAGES; s++) {
      const im = new THREE.InstancedMesh(buildCropGeo(crop, s), vertexToon(), n);
      im.count = 0;
      im.frustumCulled = false;
      this.crops.set(crop + s, im);
      this.root.add(im);
    }
    const quad = new THREE.PlaneGeometry(0.96, 0.96).rotateX(-Math.PI / 2);
    this.wet = new THREE.InstancedMesh(quad, new THREE.MeshBasicMaterial({ color: 0xffffff, blending: THREE.MultiplyBlending, premultipliedAlpha: true, depthWrite: false, transparent: true }), n);
    this.wet.frustumCulled = false;
    this.wet.renderOrder = -1;
    village.farm.forEach((t, i) => {
      this.m4.makeTranslation(t.x + 0.5, world.tileH(t.x, t.z) + 0.006, t.z + 0.5);
      this.wet.setMatrixAt(i, this.m4);
      this.wet.setColorAt(i, this.col.set(0xffffff));
    });
    this.wet.count = village.farm.length;
    this.wet.instanceMatrix.needsUpdate = true;
    this.root.add(this.wet);
    this.sync();
  }

  /** lay the crop instances out again from the sim's plots */
  private sync() {
    this.rev = this.village.rev;
    const counts = new Map<string, number>();
    for (const t of this.village.farm) {
      const s = cropStage(t);
      if (s < 0) continue;
      const key = t.crop + s;
      const im = this.crops.get(key)!;
      const i = counts.get(key) ?? 0;
      // a little per-plot yaw so identical stages don't read as stamped copies
      const yaw = ((t.x * 7 + t.z * 13) % 4) * (Math.PI / 2);
      this.m4.makeRotationY(yaw).setPosition(t.x + 0.5, this.world.tileH(t.x, t.z) + 0.01, t.z + 0.5);
      im.setMatrixAt(i, this.m4);
      counts.set(key, i + 1);
    }
    for (const [key, im] of this.crops) {
      im.count = counts.get(key) ?? 0;
      im.instanceMatrix.needsUpdate = true;
    }
  }

  update(dt: number) {
    if (this.village.rev !== this.rev) this.sync();
    // soil moisture changes slowly: refresh the tint a few times a second, not every frame
    this.wetT -= dt;
    if (this.wetT > 0) return;
    this.wetT = 0.25;
    this.village.farm.forEach((t, i) => {
      const k = 1 - t.water * 0.55; // 1 = dry (no change), 0.45 = just watered (the post-process gamma softens it)
      this.wet.setColorAt(i, this.col.setRGB(k, k * 0.98, k * 0.96));
    });
    this.wet.instanceColor!.needsUpdate = true;
  }

  /** what a tile shows as its crop kind right now (for the harvest pop) */
  cropAt(tx: number, tz: number): CropKind | null { return this.village.plotAt(tx, tz)?.crop ?? null; }
}
