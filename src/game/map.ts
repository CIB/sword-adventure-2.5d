import { MAP_W, MAP_H, Tile } from './constants';
import type { World } from './world';
import { WorldState, CHUNK_T, CHUNKS_X, CHUNKS_Z, CAMPS } from './worldstate';
import { drawText } from './hud';

/**
 * World map screen (Tab / N): terrain at tile resolution + the world state debug overlay.
 *
 * The terrain layer is pre-rendered once into an offscreen canvas at 1 px per tile (ground colour,
 * water, trees, height shading) and blitted at an integer scale — a real map now, not one colour
 * per chunk. On top of it the *world state's* view of the world stays visible: the chunk grid, the
 * chunk road graph (anchor-to-anchor routes the squads march), camps, village bounds, and every
 * squad as a cluster of soldier dots. What the overlay shows is exactly what the background world
 * simulation sees and operates on, which keeps this the debugging surface for that layer.
 *
 * Drawn straight onto the HUD canvas at HUD resolution, same pixel font, no DOM beyond one canvas.
 */

/** map colour of each ground tile (1 px per tile terrain layer) */
const TILE_COLOR: Record<number, string> = {
  [Tile.Grass]: '#4d9a42',
  [Tile.Path]: '#d3a868',
  [Tile.Water]: '#2d5fc2',
  [Tile.Bridge]: '#b98450',
  [Tile.Cliff]: '#7d5030',
  [Tile.Flowers]: '#5fae4c',
  [Tile.Cobble]: '#b3a488',
  [Tile.Bed]: '#7a5230',
  [Tile.Heather]: '#6f8a52',
  [Tile.Mud]: '#54452e',
  [Tile.ForestFloor]: '#54682f',
  [Tile.Gravel]: '#8a8478',
  [Tile.DryGrass]: '#b0923f',
};
const TREE = '#2f4d22';
const HOUSE = '#c0392b';
const ROAD = '#f0d8a0';
const CAMP = '#f09030';
const SOLDIER = '#f04838';
const SOLDIER_DOWN = '#5a3038';
const VILLAGE = '#f8d848';
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
  private terrain: HTMLCanvasElement | null = null;
  constructor(canvas: HTMLCanvasElement, private world: World, private state: WorldState) {
    // same backing canvas as the HUD: the map draws after (over) the HUD while open
    this.g = canvas.getContext('2d')!;
  }

  private static shade(hex: string, f: number): string {
    const p = parseInt(hex.slice(1), 16);
    const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
    return `rgb(${c((p >> 16) & 255)},${c((p >> 8) & 255)},${c(p & 255)})`;
  }

  /** Pre-render the terrain at 1 px per tile: ground colour + height shading, trees, houses. */
  private renderTerrain(): HTMLCanvasElement {
    const w = this.world;
    const cv = document.createElement('canvas');
    cv.width = MAP_W; cv.height = MAP_H;
    const g = cv.getContext('2d')!;
    for (let z = 0; z < MAP_H; z++) for (let x = 0; x < MAP_W; x++) {
      const t = w.tile(x, z);
      let col = TILE_COLOR[t] ?? '#4d9a42';
      if (t === Tile.Water) {
        // still water (ponds, bog pools) reads slightly darker than the running river
        col = WorldMap.shade(col, 0.9 + 0.15 * Math.min(1, w.tileH(x, z) + 1));
      } else {
        // height shading: high ground lighter, valleys darker (±18% over the level range)
        const h = w.tileH(x, z);
        col = WorldMap.shade(col, 0.92 + Math.max(-0.1, Math.min(0.28, h * 0.11)));
      }
      if (w.treeCell[w.idx(x, z)]) col = TREE;
      if (w.houseCell[w.idx(x, z)]) col = HOUSE;
      g.fillStyle = col;
      g.fillRect(x, z, 1, 1);
    }
    return cv;
  }

  /** 1-px line via fillRect steps (keeps the draw surface down to fillRect for tests) */
  private line(x0: number, y0: number, x1: number, y1: number, c: string) {
    const g = this.g;
    g.fillStyle = c;
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let i = 0; i <= n; i++) {
      g.fillRect(Math.round(x0 + (x1 - x0) * i / n), Math.round(y0 + (y1 - y0) * i / n), 1, 1);
    }
  }

  draw(v: MapView) {
    const g = this.g;
    const W = g.canvas.width, H = g.canvas.height;
    if (!this.terrain) this.terrain = this.renderTerrain();

    // dim the world behind the map
    g.fillStyle = 'rgba(6,10,14,0.86)';
    g.fillRect(0, 0, W, H);

    // integer pixels per tile, centred (leave a text row top + bottom)
    const ppt = Math.max(1, Math.floor(Math.min((W - 16) / MAP_W, (H - 34) / MAP_H)));
    const mw = ppt * MAP_W, mh = ppt * MAP_H;
    const x0 = Math.floor((W - mw) / 2), y0 = Math.floor((H - mh + 8) / 2);
    const tx = (x: number) => x0 + x * ppt; // world tile coord -> map px
    const ty = (z: number) => y0 + z * ppt;

    // frame + terrain
    g.fillStyle = '#f8f0d8';
    g.fillRect(x0 - 2, y0 - 2, mw + 4, mh + 4);
    g.fillStyle = '#0a1016';
    g.fillRect(x0 - 1, y0 - 1, mw + 2, mh + 2);
    const smooth = g.imageSmoothingEnabled;
    g.imageSmoothingEnabled = false;
    g.drawImage(this.terrain, x0, y0, mw, mh);
    g.imageSmoothingEnabled = smooth;

    // chunk grid (the resolution of the world sim — this stays a debug view)
    g.fillStyle = 'rgba(0,0,0,0.22)';
    for (let cx = 1; cx < CHUNKS_X; cx++) g.fillRect(x0 + cx * CHUNK_T * ppt, y0, 1, mh);
    for (let cz = 1; cz < CHUNKS_Z; cz++) g.fillRect(x0, y0 + cz * CHUNK_T * ppt, mw, 1);

    // road graph: anchor-to-anchor routes (each edge once), junction/dead-end knots
    for (const c of this.state.chunks) {
      if (!c.road) continue;
      const e = (nc: { ax: number; az: number }) => this.line(tx(c.ax), ty(c.az), tx(nc.ax), ty(nc.az), ROAD);
      if (c.roadE) e(this.state.chunk(c.cx + 1, c.cz));
      if (c.roadS) e(this.state.chunk(c.cx, c.cz + 1));
    }
    for (const c of this.state.chunks) {
      if (!c.road) continue;
      const deg = (c.roadN ? 1 : 0) + (c.roadS ? 1 : 0) + (c.roadE ? 1 : 0) + (c.roadW ? 1 : 0);
      if (deg !== 2) { g.fillStyle = deg === 0 ? '#c9a05e' : ROAD; g.fillRect(tx(c.ax) - 1, ty(c.az) - 1, 3, 3); }
    }

    // camps (squad rest stops)
    for (const camp of CAMPS) {
      const cx = tx(camp.x), cy = ty(camp.z);
      g.fillStyle = '#000';
      g.fillRect(cx - 2, cy - 2, 5, 5);
      g.fillStyle = CAMP;
      g.fillRect(cx - 1, cy - 1, 3, 3);
    }

    // village bounds
    const vb = this.world.village;
    const vx = tx(vb.x0), vy = ty(vb.z0), vw = (vb.x1 - vb.x0 + 1) * ppt, vh = (vb.z1 - vb.z0 + 1) * ppt;
    g.fillStyle = VILLAGE;
    g.fillRect(vx, vy, vw, 1); g.fillRect(vx, vy + vh - 1, vw, 1);
    g.fillRect(vx, vy, 1, vh); g.fillRect(vx + vw - 1, vy, 1, vh);

    // squads: every living soldier a red dot, squad leaders ringed; the fallen stay as dark marks
    let alive = 0;
    for (const sq of this.state.squads) {
      for (const m of sq.members) {
        const px = tx(m.x), py = ty(m.z);
        if (!m.alive) { g.fillStyle = SOLDIER_DOWN; g.fillRect(px, py, 1, 1); continue; }
        alive++;
        g.fillStyle = '#000';
        g.fillRect(px - 1, py - 1, 3, 3);
        g.fillStyle = SOLDIER;
        g.fillRect(px, py, 1, 1);
      }
      const lead = sq.members.find((m) => m.alive);
      if (lead) {
        const px = tx(lead.x), py = ty(lead.z);
        g.fillStyle = sq.state === 'rest' ? '#f0d060' : '#ffb0a0';
        g.fillRect(px - 1, py, 1, 1); g.fillRect(px + 1, py, 1, 1); g.fillRect(px, py - 1, 1, 1); g.fillRect(px, py + 1, 1, 1);
      }
    }

    // player marker (blinking)
    if (Math.floor(v.time * 3) % 2 === 0) {
      const px = tx(v.px), py = ty(v.pz);
      g.fillStyle = '#000';
      g.fillRect(px - 2, py - 2, 5, 5);
      g.fillStyle = PLAYER;
      g.fillRect(px - 1, py - 1, 3, 3);
    }

    // header + legend
    const title = 'WORLD MAP';
    drawText(g, title, Math.floor(W / 2 - title.length * 2), Math.max(2, y0 - 12), '#f8f0d8');
    const squadsLeft = this.state.squads.filter((s) => s.members.some((m) => m.alive)).length;
    const sub = `WORLD SIM - ${CHUNKS_X}X${CHUNKS_Z} CHUNKS - ${squadsLeft} SQUADS - ${alive} SOLDIERS`;
    drawText(g, sub, Math.floor(W / 2 - sub.length * 2), y0 + mh + 4, '#9aa8b8');
    const hint = v.gamepad ? 'R3: CLOSE' : 'TAB: CLOSE';
    drawText(g, hint, Math.floor(W / 2 - hint.length * 2), y0 + mh + 12, '#f8d848');
  }
}
