import { useEffect, useRef, useState } from 'react';
import { Game, type Phase, type DialogueView } from './game/game';
import { AudioEngine } from './game/audio';
import { Input } from './game/input';
import { VIEW_W, VIEW_H } from './game/constants';

function useScale() {
  const [scale, setScale] = useState(2);
  useEffect(() => {
    const calc = () => {
      const s = Math.min(window.innerWidth / VIEW_W, (window.innerHeight - 56) / VIEW_H);
      setScale(s >= 1 ? Math.floor(s) : Math.max(0.5, s));
    };
    calc();
    window.addEventListener('resize', calc);
    return () => window.removeEventListener('resize', calc);
  }, []);
  return scale;
}

/** Dialogue overlay: rendered at screen resolution with a readable font, portrait from the NPC's 3D model. */
function DialogueBox({ d, scale }: { d: DialogueView; scale: number }) {
  const shown = d.text.slice(0, d.chars);
  const done = d.chars >= d.text.length;
  const u = Math.max(1, scale); // layout unit: 1 game pixel
  return (
    <div className="absolute left-0 right-0 flex justify-center pointer-events-none" style={{ bottom: 10 * u, paddingLeft: 10 * u, paddingRight: 10 * u }}>
      <div className="relative w-full flex items-stretch font-dialogue" style={{ maxWidth: 300 * u, minHeight: 66 * u, background: '#101820', border: `${Math.max(2, u)}px solid #f8f0d8`, boxShadow: `0 0 0 ${Math.max(2, u)}px #000, inset 0 0 0 ${Math.max(1, u * 0.6)}px #000, inset 0 0 0 ${Math.max(2, u * 1.4)}px #f8f0d8`, borderRadius: 2 * u }}>
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
  const scale = useScale();

  useEffect(() => {
    if (!glRef.current || !hudRef.current) return;
    const audio = new AudioEngine();
    const input = new Input();
    const game = new Game(glRef.current, hudRef.current, audio, input);
    gameRef.current = game;
    game.onPhase = (p) => {
      setPhase(p);
      if (p === 'gameover') setStats({ kills: game.player.kills, rupees: game.player.rupees });
    };
    game.onMute = setMuted;
    game.onDialogue = setDialogue;
    game.start();
    return () => {
      game.dispose();
      input.dispose();
      gameRef.current = null;
    };
  }, []);

  const w = Math.round(VIEW_W * scale), h = Math.round(VIEW_H * scale);
  const startOrResume = () => {
    const g = gameRef.current;
    if (!g) return;
    if (g.phase === 'title') g.startGame();
    else if (g.phase === 'gameover') g.restart();
  };

  return (
    <div className="w-screen h-screen bg-[#07080c] flex flex-col items-center justify-center overflow-hidden select-none font-pixel text-white">
      <div className="relative shadow-[0_0_0_4px_#1a1f2e,0_0_60px_rgba(0,0,0,0.8)]" style={{ width: w, height: h }}>
        <canvas ref={glRef} className="absolute inset-0 w-full h-full pixelated" />
        <canvas ref={hudRef} className="absolute inset-0 w-full h-full pixelated pointer-events-none" />

        {phase === 'title' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/55 cursor-pointer" onClick={startOrResume}>
            <div className="text-center px-4">
              <div className="text-[10px] tracking-[0.35em] text-amber-200/90 mb-3">A 2.5D ACTION ADVENTURE</div>
              <h1 className="text-3xl md:text-5xl text-amber-300 drop-shadow-[4px_4px_0_#5a2a00] leading-tight">LEGEND OF ARIA</h1>
              <div className="text-[10px] md:text-xs text-emerald-200 mt-2">THISTLEDOWN &amp; THE MEADOW OF THE FALLEN KNIGHTS</div>
              <div className="mt-8 text-[11px] md:text-sm animate-pulse">PRESS ENTER TO START</div>
              <div className="mt-8 grid grid-cols-2 gap-x-8 gap-y-2 text-[9px] md:text-[11px] text-left text-gray-200">
                <div className="text-amber-200">LEFT HAND</div>
                <div className="text-amber-200">RIGHT HAND</div>
                <div>W A S D · MOVE</div>
                <div>J · SWORD (HOLD: SPIN)</div>
                <div className="text-gray-400">(OR ARROWS + Z / X)</div>
                <div>K · SHIELD</div>
                <div className="text-gray-400">E · TALK</div>
                <div className="text-gray-400">ENTER · PAUSE · M · MUTE</div>
              </div>
            </div>
          </div>
        )}

        {dialogue && <DialogueBox d={dialogue} scale={scale} />}

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
            <div className="mt-8 text-[11px] md:text-sm animate-pulse">PRESS ENTER TO TRY AGAIN</div>
          </div>
        )}

        {muted && <div className="absolute right-2 bottom-2 text-[9px] text-gray-300 bg-black/50 px-2 py-1">MUTED</div>}
      </div>
      <div className="mt-3 text-[9px] md:text-[10px] text-gray-500 tracking-wider text-center px-2">
        WASD MOVE · J SWORD (HOLD FOR SPIN ATTACK) · K SHIELD · E TALK · ENTER PAUSE · M MUTE
      </div>
    </div>
  );
}
