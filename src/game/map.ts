import { Tile } from './constants';
import { WorldState, CHUNK_T, CHUNKS_X, CHUNKS_Z, type ChunkInfo } from './worldstate';
import { drawText } from './hud';

/**
 * World map screen (Tab / N): a debug view of the world state at chunk resolution.
 *
 * Every cell is one world-state chunk (CHUNK_T x CHUNK_T tiles) painted from the chunk aggregates —
 * dominant ground, water/tree cover — with the chunk road graph drawn as connecting lines and every
 * world-state soldier as a dot. This is intentionally the *world state's* view of the world, not a
 * minimap rendered from live tiles: what you see here is exactly what the background world
 * simulation will see and operate on, which makes it the debugging surface for that layer.
 *
 * Drawn straight onto the HUD canvas at HUD resolution, same pixel font, no DOM.
 */

/** map colour of each dominant ground tile */
const GROUND_COLOR: Record<number, string> = {
  [Tile.Grass]: '#4d9a42',
  [Tile.Path]: '#c9a05e',
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
const WATER = '#2d5fc2';
const FOREST = '#3a5c2a';
const ROAD = '#e8c890';
const ROAD_NODE = '#c9a05e';
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
  constructor(canvas: HTMLCanvasElement, private state: WorldState) {
    // same backing canvas as the HUD: the map draws after (over) the HUD while open
    this.g = canvas.getContext('2d')!;
  }

  /** blend two chunk-cell colours (hex) — cheap, no allocation beyond the string */
  private static mix(a: string, b: string, t: number): string {
    const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    const r = Math.round(((pa >> 16) & 255) + ((((pb >> 16) & 255) - ((pa >> 16) & 255)) * t));
    const g = Math.round(((pa >> 8) & 255) + ((((pb >> 8) & 255) - ((pa >> 8) & 255)) * t));
    const bl = Math.round((pa & 255) + (((pb & 255) - (pa & 255)) * t));
    return `rgb(${r},${g},${bl})`;
  }

  private cellColor(c: ChunkInfo): string {
    let col = GROUND_COLOR[c.ground] ?? '#4d9a42';
    if (c.water > 0.04 && c.ground !== Tile.Water) col = WorldMap.mix(col, WATER, Math.min(0.55, c.water * 1.1));
    if (c.trees > 0.08) col = WorldMap.mix(col, FOREST, Math.min(0.75, c.trees * 2.2));
    return col;
  }

  draw(v: MapView) {
    const g = this.g;
    const W = g.canvas.width, H = g.canvas.height;

    // dim the world behind the map
    g.fillStyle = 'rgba(6,10,14,0.86)';
    g.fillRect(0, 0, W, H);

    // fit the chunk grid, integer cell size, centred (leave a text row top + bottom)
    const cell = Math.max(4, Math.floor(Math.min((W - 16) / CHUNKS_X, (H - 34) / CHUNKS_Z)));
    const mw = cell * CHUNKS_X, mh = cell * CHUNKS_Z;
    const x0 = Math.floor((W - mw) / 2), y0 = Math.floor((H - mh + 8) / 2);

    // frame
    g.fillStyle = '#f8f0d8';
    g.fillRect(x0 - 2, y0 - 2, mw + 4, mh + 4);
    g.fillStyle = '#0a1016';
    g.fillRect(x0 - 1, y0 - 1, mw + 2, mh + 2);

    // chunk cells
    for (const c of this.state.chunks) {
      g.fillStyle = this.cellColor(c);
      g.fillRect(x0 + c.cx * cell, y0 + c.cz * cell, cell, cell);
    }
    // subtle chunk grid so the resolution of the world sim stays visible (this is a debug view)
    g.fillStyle = 'rgba(0,0,0,0.18)';
    for (let cx = 1; cx < CHUNKS_X; cx++) g.fillRect(x0 + cx * cell, y0, 1, mh);
    for (let cz = 1; cz < CHUNKS_Z; cz++) g.fillRect(x0, y0 + cz * cell, mw, 1);

    // road graph: a line from each road chunk's centre toward every connected neighbour.
    // Each edge is drawn from both sides, so together they form continuous routes.
    const half = Math.floor(cell / 2);
    g.fillStyle = ROAD;
    for (const c of this.state.chunks) {
      if (!c.road) continue;
      const cx = x0 + c.cx * cell + half, cy = y0 + c.cz * cell + half;
      if (c.roadN) g.fillRect(cx, cy - half, 1, half);
      if (c.roadS) g.fillRect(cx, cy, 1, half + 1);
      if (c.roadW) g.fillRect(cx - half, cy, half, 1);
      if (c.roadE) g.fillRect(cx, cy, half + 1, 1);
    }
    for (const c of this.state.chunks) {
      if (!c.road) continue;
      const cx = x0 + c.cx * cell + half, cy = y0 + c.cz * cell + half;
      const deg = (c.roadN ? 1 : 0) + (c.roadS ? 1 : 0) + (c.roadE ? 1 : 0) + (c.roadW ? 1 : 0);
      // nodes: junctions and dead ends get a knot, isolated road chunks a lone dot
      if (deg !== 2) { g.fillStyle = deg === 0 ? ROAD_NODE : ROAD; g.fillRect(cx - 1, cy - 1, 3, 3); }
    }

    // village bounds
    const vb = this.state.village;
    const vx = x0 + vb.cx0 * cell, vy = y0 + vb.cz0 * cell;
    const vw = (vb.cx1 - vb.cx0 + 1) * cell, vh = (vb.cz1 - vb.cz0 + 1) * cell;
    g.fillStyle = VILLAGE;
    g.fillRect(vx, vy, vw, 1); g.fillRect(vx, vy + vh - 1, vw, 1);
    g.fillRect(vx, vy, 1, vh); g.fillRect(vx + vw - 1, vy, 1, vh);

    // soldiers: world-state records at their world position (tile → map pixels)
    const sx = cell / CHUNK_T, sy = cell / CHUNK_T;
    for (const s of this.state.soldiers) {
      const px = x0 + Math.round(s.x * sx), py = y0 + Math.round(s.z * sy);
      if (s.state === 'down') { g.fillStyle = SOLDIER_DOWN; g.fillRect(px, py, 1, 1); continue; }
      g.fillStyle = '#000';
      g.fillRect(px - 1, py - 1, 3, 3);
      g.fillStyle = SOLDIER;
      g.fillRect(px - 1, py, 1, 1); g.fillRect(px + 1, py, 1, 1); g.fillRect(px, py - 1, 1, 1); g.fillRect(px, py + 1, 1, 1);
      g.fillStyle = '#ffb0a0';
      g.fillRect(px, py, 1, 1);
    }

    // player marker (blinking)
    if (Math.floor(v.time * 3) % 2 === 0) {
      const px = x0 + Math.round(v.px * sx), py = y0 + Math.round(v.pz * sy);
      g.fillStyle = '#000';
      g.fillRect(px - 2, py - 2, 5, 5);
      g.fillStyle = PLAYER;
      g.fillRect(px - 1, py - 1, 3, 3);
    }

    // header + legend
    const title = 'WORLD MAP';
    drawText(g, title, Math.floor(W / 2 - title.length * 2), Math.max(2, y0 - 12), '#f8f0d8');
    const sub = `DEBUG - ${CHUNKS_X}X${CHUNKS_Z} CHUNKS OF ${CHUNK_T} TILES - ${this.state.soldiers.length} SOLDIERS`;
    drawText(g, sub, Math.floor(W / 2 - sub.length * 2), y0 + mh + 4, '#9aa8b8');
    const hint = v.gamepad ? 'R3: CLOSE' : 'TAB: CLOSE';
    drawText(g, hint, Math.floor(W / 2 - hint.length * 2), y0 + mh + 12, '#f8d848');
  }
}
