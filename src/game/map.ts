import { MAP_W, MAP_H } from './constants';
import { WorldState, CHUNK_T, CHUNKS_X, CHUNKS_Z } from './worldstate';
import { drawText } from './hud';
import type { World } from './world';

/**
 * World map screen (Tab / N): a full terrain view of the world at tile resolution — one pixel per
 * tile, painted from the real generated map (biome ground colours, water, roads, bridges, trees,
 * village roofs, shore strips and relief shading) — instead of the old one-colour-per-chunk debug
 * grid. The cached base bitmap is painted once by World.paintMinimap; every frame afterwards is a
 * nearest-neighbour blit plus the live world-state overlay:
 *
 *   - camps (rest stops) as little tents, the village bounds, a faint chunk grid
 *   - every squad as a column of soldiers at its world position (red = marching, amber = resting)
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
const SOLDIER_REST = '#f8a030';
const PLAYER = '#58f0f8';

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

  constructor(canvas: HTMLCanvasElement, private state: WorldState, world: World) {
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

    // fit the tile map, centred (leave a text row top + bottom). Integer scales blit
    // nearest-neighbour (crisp pixels); a fractional fit below 2x is drawn with smoothing so the
    // map still fills the screen — a soft, paper-map look with crisp markers on top.
    const fit = Math.min((W - 16) / MAP_W, (H - 36) / MAP_H);
    const scale = fit >= 2 ? Math.floor(fit) : fit;
    const mw = Math.round(MAP_W * scale), mh = Math.round(MAP_H * scale);
    const x0 = Math.floor((W - mw) / 2), y0 = Math.floor((H - mh + 10) / 2);

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

    // squads: every living soldier at its world position, coloured by squad state
    let alive = 0, fallen = 0, resting = 0;
    for (const sq of state.squads) {
      for (const m of sq.members) {
        if (m.state === 'down') { fallen++; continue; }
        alive++;
        if (m.state === 'rest') resting++;
        const [px, py] = this.px(m.x, m.z, x0, y0, scale);
        g.fillStyle = '#000';
        g.fillRect(px - 1, py - 1, 3, 3);
        g.fillStyle = m.state === 'rest' ? SOLDIER_REST : SOLDIER;
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
    const sub = `${state.squads.length} SQUADS - ${alive} SOLDIERS (${resting} RESTING) - ${fallen} FALLEN`;
    drawText(g, sub, Math.floor(W / 2 - sub.length * 2), y0 + mh + 4, '#9aa8b8');
    const legend = 'RED PATROL  AMBER REST  TAN CAMP';
    drawText(g, legend, Math.floor(W / 2 - legend.length * 2), y0 + mh + 12, '#c8b088');
    const hint = v.gamepad ? 'R3: CLOSE' : 'TAB: CLOSE';
    drawText(g, hint, Math.floor(W / 2 - hint.length * 2), y0 + mh + 20, '#f8d848');
  }
}
