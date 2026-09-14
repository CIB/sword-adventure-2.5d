import { useEffect, useRef, useState } from 'react';
import { Game, type Phase, type DialogueView } from './game/game';
import { AudioEngine } from './game/audio';
import { Input } from './game/input';
import { VIEW_W, VIEW_H, PX_PER_TILE, ZOOM_TARGET_CSS_PX, ZOOM_MIN_TILES_X, HUD_SCALE, HUD_SCALE_THOR } from './game/constants';

export interface Viewport {
  scale: number;
  /** integer magnification of the 3D view only (1 = render 1:1, 2 = render half size and upscale) */
  zoom: number;
  /** HUD / CSS layout resolution in game pixels — the whole window */
  vw: number;
  vh: number;
  /** 3D view resolution in game pixels: `vw / zoom` */
  worldW: number;
  worldH: number;
  /** true on the AYN Thor and other very wide viewports — larger HUD, frametime in the top row, bigger dialogs */
  isThor: boolean;
}

/**
 * Fit the game to the whole browser window.
 *
 * `scale` is the largest whole-number zoom that still fits, so pixels stay square; the internal resolution then
 * grows to cover the window (`ceil`), which shows *more map* on wide/tall screens instead of letterboxing.
 * The canvas is drawn at `vw x vh` game pixels and displayed at `vw*scale x vh*scale` CSS pixels — a pixel or two
 * of overshoot is cropped by the overflow-hidden wrapper.
 *
 * On windows too small for that to reach `ZOOM_TARGET_CSS_PX` per pixel — handhelds, phones — `zoom` adds a second
 * integer magnification that applies to the 3D view alone. `ZOOM_TARGET_CSS_PX` is 2, the midpoint between the
 * small-screen PR's full magnification (4) and no magnification (1), after the Ayn Thor proved the original 4 too
 * aggressive; the world renders at `vw/zoom x vh/zoom` and the CSS
 * upscale magnifies it, so texture pixels *and* the outline pass go chunky together (and a quarter of the
 * fragments get shaded at zoom 2). The HUD keeps `vw x vh`, since its layout is built for 320x240.
 */
function isThorViewport(vw: number, vh: number): boolean {
  // AYN Thor main screen is 16:9 and very wide in game pixels (vw ~ 480-640 at 1080p). On narrow 4:3-ish desktop
  // windows vw collapses to ~278-350 and the kill counter nearly touches the life hearts. A ratio >1.6 with
  // vw >= 360 reliably separates the two.
  return vw >= 360 && vw / vh > 1.6;
}

function calcViewport(): Viewport {
  const iw = Math.max(1, window.innerWidth), ih = Math.max(1, window.innerHeight);
  const scale = Math.max(1, Math.floor(Math.min(iw / VIEW_W, ih / VIEW_H)));
  const vw = Math.max(VIEW_W, Math.ceil(iw / scale));
  const vh = Math.max(VIEW_H, Math.ceil(ih / scale));
  // never trade away more map than ZOOM_MIN_TILES_X allows; stay integral so pixels stay even and the camera's
  // 1/20-tile snap doesn't shimmer
  const zoom = Math.max(1, Math.min(Math.round(ZOOM_TARGET_CSS_PX / scale), Math.floor(vw / PX_PER_TILE / ZOOM_MIN_TILES_X)));
  return { scale, zoom, vw, vh, worldW: Math.floor(vw / zoom), worldH: Math.floor(vh / zoom), isThor: isThorViewport(vw, vh) };
}

function useViewport(): Viewport {
  const [vp, setVp] = useState<Viewport>(calcViewport);
  useEffect(() => {
    const onChange = () => setVp(calcViewport());
    window.addEventListener('resize', onChange);
    window.addEventListener('orientationchange', onChange);
    return () => {
      window.removeEventListener('resize', onChange);
      window.removeEventListener('orientationchange', onChange);
    };
  }, []);
  return vp;
}

type FsElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type FsDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };

function fullscreenElement(): Element | null {
  const d = document as FsDocument;
  return document.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

/** Enter fullscreen and lock to landscape where the platform allows it (phones, handhelds). */
function enterFullscreen() {
  if (fullscreenElement()) return;
  const el = document.documentElement as FsElement;
  const p = el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : el.webkitRequestFullscreen?.();
  void Promise.resolve(p)
    .then(() => {
      const o = screen.orientation as ScreenOrientation & { lock?: (orient: string) => Promise<void> };
      return o.lock?.('landscape');
    })
    .catch(() => {}); // not allowed without a user gesture / unsupported: keep playing windowed
}

function exitFullscreen() {
  if (!fullscreenElement()) return;
  const d = document as FsDocument;
  void Promise.resolve(d.exitFullscreen ? d.exitFullscreen() : d.webkitExitFullscreen?.()).catch(() => {});
}

/** F key / gamepad Y / the ⛶ button. */
function toggleFullscreen() {
  if (fullscreenElement()) exitFullscreen();
  else enterFullscreen();
}

/** Dialogue overlay: rendered at screen resolution with a readable font, portrait from the NPC's 3D model. */
function DialogueBox({ d, scale, isThor }: { d: DialogueView; scale: number; isThor?: boolean }) {
  const shown = d.text.slice(0, d.chars);
  const done = d.chars >= d.text.length;
  // On the AYN Thor the dialog was way too small — make it 2-3× larger. We do that by scaling the layout unit
  // (u) by 2.5× when isThor, which also scales maxWidth/minHeight/fonts together.
  const baseU = Math.max(1, scale);
  const u = isThor ? baseU * 2.5 : baseU; // 2.5× on Thor → 2-3× larger dialog
  // maxWidth scales with u, so Thor is automatically 2.5× wider; we allow a bit extra on Thor since the screen is wide.
  const maxW = isThor ? 400 * u : 300 * u; // Thor: 400*2.5*scale = 1000*scale CSS px, ~2.5-3× larger than normal 300*scale
  return (
    <div className="absolute left-0 right-0 flex justify-center pointer-events-none" style={{ bottom: 10 * u, paddingLeft: 10 * u, paddingRight: 10 * u }}>
      <div className="relative w-full flex items-stretch font-dialogue" style={{ maxWidth: maxW, minHeight: 66 * u, background: '#101820', border: `${Math.max(2, u)}px solid #f8f0d8`, boxShadow: `0 0 0 ${Math.max(2, u)}px #000, inset 0 0 0 ${Math.max(1, u * 0.6)}px #000, inset 0 0 0 ${Math.max(2, u * 1.4)}px #f8f0d8`, borderRadius: 2 * u }}>
        <div className="flex-none flex items-center justify-center" style={{ width: 58 * u, padding: 6 * u }}>
          <div className="pixelated overflow-hidden" style={{ width: 46 * u, height: 46 * u, background: 'linear-gradient(#2b3a5a,#16202f)', border: `${Math.max(1, u * 0.6)}px solid ${d.color}`, borderRadius: 2 * u }}>
            <img src={d.portrait} alt="" className="pixelated" style={{ width: '100%', height: '100%', display: 'block' }} draggable={false} />
          </div>
        </div>
        <div className="flex-1 flex flex-col" style={{ padding: `${7 * u}px ${10 * u}px ${7 * u}px 0` }}>
          <div className="font-bold tracking-wide" style={{ color: d.color, fontSize: 7 * u, lineHeight: 1.2, marginBottom: 3 * u, textShadow: `0 ${Math.max(1, u * 0.5)}px 0 #000` }}>{d.name}</div>
          <div className="text-[#f8f8f8]" style={{ fontSize: 8 * u, lineHeight: 1.35, textShadow: `0 ${Math.max(1, u * 0.5)}px 0 #000` }}>
            {shown}<span className="opacity-0">{d.text.slice(d.chars)}</span>
          </div>
        </div>
        {done && (
          <div className="absolute animate-bounce" style={{ right: 8 * u, bottom: 4 * u, color: '#f8d848', fontSize: 8 * u, lineHeight: 1 }}>{d.more ? '▼' : '■'}</div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const glRef = useRef<HTMLCanvasElement>(null);
  const hudRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Game | null>(null);
  const [phase, setPhase] = useState<Phase>('title');
  const [muted, setMuted] = useState(false);
  const [stats, setStats] = useState({ kills: 0, rupees: 0 });
  const [dialogue, setDialogue] = useState<DialogueView | null>(null);
  const [gamepad, setGamepad] = useState(false);
  const [help, setHelp] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const vp = useViewport();

  useEffect(() => {
    if (!glRef.current || !hudRef.current) return;
    const audio = new AudioEngine();
    const input = new Input();
    const game = new Game(glRef.current, hudRef.current, audio, input);
    gameRef.current = game;
    if (import.meta.env.DEV) (window as unknown as { __game?: Game }).__game = game; // dev console / screenshot tooling
    game.onPhase = (p) => {
      setPhase(p);
      if (p === 'gameover') setStats({ kills: game.player.kills, rupees: game.player.rupees });
    };
    game.onMute = setMuted;
    game.onDialogue = setDialogue;
    game.onFullscreen = toggleFullscreen;
    game.onHelp = () => setHelp((h) => !h);
    input.onGamepadUse(() => setGamepad(true));
    // HUD renders at 1/HUD_SCALE of the window res and is stretched to fill, so it reads HUD_SCALE× larger on screen.
    // On Thor we use HUD_SCALE_THOR (~50% larger).
    const hs0 = vp.isThor ? HUD_SCALE_THOR : HUD_SCALE;
    game.resize(vp.worldW, vp.worldH, Math.max(1, Math.round(vp.vw / hs0)), Math.max(1, Math.round(vp.vh / hs0)), vp.isThor);
    game.start();
    return () => {
      game.dispose();
      input.dispose();
      gameRef.current = null;
    };
    // mount only — later viewport changes are pushed by the effect below
  }, []);

  // keep the game's internal resolution (and HUD) in sync with the window
  useEffect(() => {
    const hs = vp.isThor ? HUD_SCALE_THOR : HUD_SCALE;
    gameRef.current?.resize(vp.worldW, vp.worldH, Math.max(1, Math.round(vp.vw / hs)), Math.max(1, Math.round(vp.vh / hs)), vp.isThor);
  }, [vp.worldW, vp.worldH, vp.vw, vp.vh, vp.isThor]);

  // the user can leave fullscreen with Esc / the OS gesture — mirror that in our state
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!fullscreenElement());
    onChange();
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, []);

  const w = vp.vw * vp.scale, h = vp.vh * vp.scale;
  const startOrResume = () => {
    const g = gameRef.current;
    if (!g) return;
    if (navigator.maxTouchPoints > 0) enterFullscreen();
    if (g.phase === 'title') g.startGame();
    else if (g.phase === 'gameover') g.restart();
  };

  return (
    <div className="w-screen h-screen bg-[#07080c] flex flex-col items-center justify-center overflow-hidden select-none font-pixel text-white">
      <div className="relative" style={{ width: w, height: h }}>
        <canvas ref={glRef} className="absolute inset-0 w-full h-full pixelated" />
        <canvas ref={hudRef} className="absolute inset-0 w-full h-full pixelated pointer-events-none" />

        {phase === 'title' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/55 cursor-pointer" onClick={startOrResume}>
            <div className="text-center px-4">
              <div className="text-[10px] tracking-[0.35em] text-amber-200/90 mb-3">A 2.5D ACTION ADVENTURE</div>
              <h1 className="text-3xl md:text-5xl text-amber-300 drop-shadow-[4px_4px_0_#5a2a00] leading-tight">LEGEND OF ARIA</h1>
              <div className="text-[10px] md:text-xs text-emerald-200 mt-2">THISTLEDOWN &amp; THE MEADOW OF THE FALLEN KNIGHTS</div>
              <div className="mt-8 text-[11px] md:text-sm animate-pulse">PRESS {gamepad ? 'START' : 'ENTER'} TO START</div>
              <div className="mt-8 grid grid-cols-2 gap-x-8 gap-y-2 text-[9px] md:text-[11px] text-left text-gray-200">
                <div className="text-amber-200">LEFT HAND</div>
                <div className="text-amber-200">RIGHT HAND</div>
                <div>W A S D · MOVE</div>
                <div>J · SWORD (HOLD: SPIN)</div>
                <div className="text-gray-400">(OR ARROWS + Z / X)</div>
                <div>K · SHIELD</div>
                <div className="text-gray-400">E · TALK</div>
                <div className="text-gray-400">Q / R · ROTATE VIEW</div>
                <div className="text-gray-400">TAB · WORLD MAP</div>
                <div className="text-gray-400">ENTER · PAUSE · M · MUTE</div>
              </div>
              <div className="mt-6 text-[9px] md:text-[11px] text-amber-200/80">
                {gamepad ? 'SELECT: CONTROLS · Y: FULLSCREEN' : 'H: CONTROLS · F: FULLSCREEN'}
              </div>
            </div>
          </div>
        )}

        {dialogue && <DialogueBox d={dialogue} scale={vp.scale} isThor={vp.isThor} />}

        {phase === 'paused' && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40">
            <div className="text-xl md:text-2xl text-amber-200 drop-shadow-[3px_3px_0_#000]">PAUSED</div>
          </div>
        )}

        {phase === 'gameover' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/65 cursor-pointer" onClick={startOrResume}>
            <div className="text-2xl md:text-4xl text-red-400 drop-shadow-[4px_4px_0_#3a0000]">GAME OVER</div>
            <div className="mt-6 text-[10px] md:text-xs text-gray-200 space-y-2 text-center">
              <div>SOLDIERS DEFEATED: {stats.kills}</div>
              <div>RUPEES: {stats.rupees}</div>
            </div>
            <div className="mt-8 text-[11px] md:text-sm animate-pulse">PRESS {gamepad ? 'START' : 'ENTER'} TO TRY AGAIN</div>
          </div>
        )}

        {muted && <div className="absolute right-2 bottom-8 text-[9px] text-gray-300 bg-black/50 px-2 py-1">MUTED</div>}
        {document.fullscreenEnabled && (
          <button onClick={toggleFullscreen} title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'} className="absolute right-2 top-2 text-[9px] text-gray-300/70 hover:text-white bg-black/40 px-2 py-1 cursor-pointer">{isFullscreen ? '🗗' : '⛶'}</button>
        )}

        {help && phase !== 'title' && !dialogue && (
          <div className="absolute left-0 right-0 bottom-0 text-center text-[8px] md:text-[10px] leading-relaxed tracking-wider text-gray-200 bg-black/55 px-2 py-1 pointer-events-none">
            {gamepad
              ? 'STICK/D-PAD MOVE · A SWORD (HOLD FOR SPIN ATTACK) · B SHIELD · X TALK · L/R ROTATE VIEW · R3 MAP · START PAUSE · Y FULLSCREEN · SELECT HIDE THIS · L3 MUTE'
              : 'WASD MOVE · J SWORD (HOLD FOR SPIN ATTACK) · K SHIELD · E TALK · Q/R ROTATE VIEW · TAB MAP · ENTER PAUSE · F FULLSCREEN · H HIDE THIS · M MUTE'}
          </div>
        )}
      </div>
    </div>
  );
}
