import { MAP_W, MAP_H } from './constants';
import { WorldState, CHUNK_T, CHUNKS_X, CHUNKS_Z } from './worldstate';
import { drawText } from './hud';
import type { World } from './world';
import { CROPS, type VillageState } from './village';

/**
 * World map screen (Tab / N): a full terrain view of the world at tile resolution — one pixel per
 * tile, painted from the real generated map (biome ground colours, water, roads, bridges, trees,
 * village roofs, shore strips and relief shading) — instead of the old one-colour-per-chunk debug
 * grid. The cached base bitmap is painted once by World.paintMinimap; every frame afterwards is a
 * nearest-neighbour blit plus the live world-state overlay:
 *
 *   - the patch each guard post holds (a faint ring), camps as little tents, the village bounds
 *   - every soldier at its world position (red = on post, amber = a replacement marching in)
 *   - the farm: worked beds in soil/green/ripe, the farmhand as a green pip, the day's summary
 *   - the player
 *
 * The chunk grid stays as a whisper — it's the resolution of the background world simulation —
 * but what you see of the land itself is now exactly what was generated.
 */

const ROAD_GRID = 'rgba(0,0,0,0.13)';
const VILLAGE = '#f8d848';
const CAMP = '#f8e8b0';
const CAMP_DARK = '#7a5a30';
const SOLDIER = '#f04838';
const SOLDIER_ENROUTE = '#f8a030';
/** the ring drawn around each post's patch: what the soldiers there are guarding */
const PATCH = 'rgba(240,72,56,0.35)';
const PLAYER = '#58f0f8';
/** the farmhand, and the farm's beds: bare soil, green crop, ripe crop */
const FARMER = '#8ce070';
const SOIL = '#8a5c33';
const CROP = '#5cc44a';

export interface MapView {
  /** player position in world tiles */
  px: number;
  pz: number;
  time: number;
  gamepad: boolean;
}

export class WorldMap {
  private g: CanvasRenderingContext2D;
  /** cached MAP_W x MAP_H terrain bitmap (built once from the world) */
  private base: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement, private state: WorldState, world: World, private village?: VillageState) {
    // same backing canvas as the HUD: the map draws after (over) the HUD while open
    this.g = canvas.getContext('2d')!;
    this.base = document.createElement('canvas');
    this.base.width = MAP_W;
    this.base.height = MAP_H;
    const bg = this.base.getContext('2d')!;
    const img = bg.createImageData(MAP_W, MAP_H);
    world.paintMinimap(img);
    bg.putImageData(img, 0, 0);
  }

  /** world tiles -> map pixels */
  private px(x: number, z: number, x0: number, y0: number, scale: number): [number, number] {
    return [x0 + Math.round(x * scale), y0 + Math.round(z * scale)];
  }

  draw(v: MapView) {
    const g = this.g;
    const W = g.canvas.width, H = g.canvas.height;
    const state = this.state;

    // dim the world behind the map
    g.fillStyle = 'rgba(6,10,14,0.86)';
    g.fillRect(0, 0, W, H);

    // Fit the tile map, centred, with room for the text: two rows above it (posts, title) and four
    // below (the farm's day, the legend, the close hint). Integer scales blit nearest-neighbour
    // (crisp pixels); a fractional fit below 2x is drawn with smoothing so the map still fills the
    // screen — a soft, paper-map look with crisp markers on top.
    const TITLE_ROWS = 22, FOOT_ROWS = 34;
    const fit = Math.min((W - 16) / MAP_W, (H - TITLE_ROWS - FOOT_ROWS) / MAP_H);
    const scale = fit >= 2 ? Math.floor(fit) : fit;
    const mw = Math.round(MAP_W * scale), mh = Math.round(MAP_H * scale);
    const x0 = Math.floor((W - mw) / 2);
    // never lower than the centred look, never so low that the text below runs off the canvas
    const y0 = Math.max(TITLE_ROWS, Math.min(Math.floor((H - mh) / 2) - 2, H - FOOT_ROWS - mh));

    // frame
    g.fillStyle = '#f8f0d8';
    g.fillRect(x0 - 2, y0 - 2, mw + 4, mh + 4);
    g.fillStyle = '#0a1016';
    g.fillRect(x0 - 1, y0 - 1, mw + 2, mh + 2);

    // terrain
    g.imageSmoothingEnabled = fit < 2;
    g.drawImage(this.base, x0, y0, mw, mh);

    // faint chunk grid: the resolution of the world sim's chunk model
    g.fillStyle = ROAD_GRID;
    for (let cx = 1; cx < CHUNKS_X; cx++) g.fillRect(x0 + cx * CHUNK_T * scale, y0, 1, mh);
    for (let cz = 1; cz < CHUNKS_Z; cz++) g.fillRect(x0, y0 + cz * CHUNK_T * scale, mw, 1);

    // village bounds
    const vb = state.village;
    const vx = x0 + vb.cx0 * CHUNK_T * scale, vy = y0 + vb.cz0 * CHUNK_T * scale;
    const vw = (vb.cx1 - vb.cx0 + 1) * CHUNK_T * scale, vh = (vb.cz1 - vb.cz0 + 1) * CHUNK_T * scale;
    g.fillStyle = VILLAGE;
    g.fillRect(vx, vy, vw, 1); g.fillRect(vx, vy + vh - 1, vw, 1);
    g.fillRect(vx, vy, 1, vh); g.fillRect(vx + vw - 1, vy, 1, vh);

    // camps: a little tent at every rest stop
    const t = Math.max(2, scale);
    for (const c of state.camps) {
      const [px, py] = this.px(c.x, c.z, x0, y0, scale);
      g.fillStyle = CAMP_DARK;
      g.fillRect(px - t, py - t, t + 1, 1); g.fillRect(px - t, py, 1, t); // ground shadow
      g.fillStyle = CAMP;
      g.fillRect(px - t + 1, py - t + 1, t - 1, 1);                       // ridge
      g.fillRect(px - t + 2, py - t + 2, t - 3, 1);                       // skirt
      g.fillRect(px - t + 3, py - t + 3, t - 5, 1);
    }

    // the patch each post holds: a faint ellipse of the ground its soldiers guard
    g.fillStyle = PATCH;
    for (const post of state.posts) {
      const steps = 48;
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const [px, py] = this.px(post.cx + Math.cos(a) * post.rx, post.cz + Math.sin(a) * post.rz, x0, y0, scale);
        g.fillRect(px, py, 1, 1);
      }
    }

    // soldiers: every living one at its world position, coloured by what it's doing
    let alive = 0, fallen = 0, enroute = 0;
    for (const post of state.posts) {
      for (const m of post.members) {
        if (m.state === 'down') { fallen++; continue; }
        alive++;
        if (m.state === 'enroute') enroute++;
        const [px, py] = this.px(m.x, m.z, x0, y0, scale);
        g.fillStyle = '#000';
        g.fillRect(px - 1, py - 1, 3, 3);
        g.fillStyle = m.state === 'enroute' ? SOLDIER_ENROUTE : SOLDIER;
        g.fillRect(px, py, 1, 1);
      }
    }

    // the village's beds: what the farmhand has under the hoe, in the crop's colour
    if (this.village) {
      for (const t of this.village.tiles.values()) {
        if (t.state === 'fallow') continue;
        const [px, py] = this.px(t.x + 0.5, t.z + 0.5, x0, y0, scale);
        g.fillStyle = t.state === 'ripe' ? CROPS[t.crop].colour : t.state === 'sown' ? CROP : SOIL;
        g.fillRect(px, py, Math.max(1, Math.round(scale)), Math.max(1, Math.round(scale)));
      }

      // the farmhand at work
      for (const w of this.village.workers) {
        const [px, py] = this.px(w.x, w.z, x0, y0, scale);
        g.fillStyle = '#000';
        g.fillRect(px - 1, py - 1, 3, 3);
        g.fillStyle = FARMER;
        g.fillRect(px, py, 1, 1);
      }
    }

    // player marker (blinking)
    if (Math.floor(v.time * 3) % 2 === 0) {
      const [px, py] = this.px(v.px, v.pz, x0, y0, scale);
      g.fillStyle = '#000';
      g.fillRect(px - 2, py - 2, 5, 5);
      g.fillStyle = PLAYER;
      g.fillRect(px - 1, py - 1, 3, 3);
    }

    // header + legend
    const title = 'WORLD MAP';
    drawText(g, title, Math.floor(W / 2 - title.length * 2), Math.max(2, y0 - 12), '#f8f0d8');
    const sub = `${state.posts.length} POSTS - ${alive} SOLDIERS (${enroute} MARCHING IN) - ${fallen} FALLEN`;
    drawText(g, sub, Math.floor(W / 2 - sub.length * 2), Math.max(2, y0 - 20), '#9aa8b8');
    const farm = this.village ? this.village.summary() : 'THE FIELDS ARE UNTENDED';
    drawText(g, farm, Math.floor(W / 2 - farm.length * 2), y0 + mh + 4, '#8ce070');
    const legend = 'RED ON POST  AMBER MARCHING IN  GREEN FARMBED';
    drawText(g, legend, Math.floor(W / 2 - legend.length * 2), y0 + mh + 12, '#c8b088');
    const hint = v.gamepad ? 'R3: CLOSE' : 'TAB: CLOSE';
    drawText(g, hint, Math.floor(W / 2 - hint.length * 2), y0 + mh + 20, '#f8d848');
  }
}
