const GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyJ', 'KeyK', 'KeyZ', 'KeyX', 'KeyE', 'KeyC', 'Space', 'ShiftLeft', 'ShiftRight', 'Enter', 'KeyM', 'KeyP', 'Escape',
]);

export const ATTACK_KEYS = ['KeyJ', 'KeyZ', 'Space'];
export const SHIELD_KEYS = ['KeyK', 'KeyX', 'ShiftLeft', 'ShiftRight'];
export const PAUSE_KEYS = ['Enter', 'KeyP', 'Escape'];
export const MUTE_KEYS = ['KeyM'];
export const ROTATE_CCW_KEYS = ['KeyQ', 'Comma'];
export const ROTATE_CW_KEYS = ['KeyR', 'Period'];
/** Talk / advance dialogue. The attack keys also work so a Zelda-style "A to talk" feels natural. */
export const TALK_KEYS = ['KeyE', 'KeyC', 'KeyJ', 'KeyZ', 'Space', 'Enter'];

export class Input {
  private keys = new Set<string>();
  private pressed = new Set<string>();
  private onDown = (e: KeyboardEvent) => {
    if (GAME_KEYS.has(e.code)) e.preventDefault();
    if (!this.keys.has(e.code)) this.pressed.add(e.code);
    this.keys.add(e.code);
  };
  private onUp = (e: KeyboardEvent) => { this.keys.delete(e.code); };
  private onBlur = () => { this.keys.clear(); };

  constructor() {
    window.addEventListener('keydown', this.onDown);
    window.addEventListener('keyup', this.onUp);
    window.addEventListener('blur', this.onBlur);
  }
  dispose() {
    window.removeEventListener('keydown', this.onDown);
    window.removeEventListener('keyup', this.onUp);
    window.removeEventListener('blur', this.onBlur);
  }
  down(codes: string[]): boolean { return codes.some((c) => this.keys.has(c)); }
  justPressed(codes: string[]): boolean { return codes.some((c) => this.pressed.has(c)); }
  endFrame() { this.pressed.clear(); }

  /** Camera yaw in radians (set by the game when the view is rotated); movement keys are screen-relative */
  viewAngle = 0;
  private get rawX(): number { return (this.down(['KeyD', 'ArrowRight']) ? 1 : 0) - (this.down(['KeyA', 'ArrowLeft']) ? 1 : 0); }
  private get rawZ(): number { return (this.down(['KeyS', 'ArrowDown']) ? 1 : 0) - (this.down(['KeyW', 'ArrowUp']) ? 1 : 0); }
  /** movement in world axes, so "up" on the keyboard is always "up" on the screen */
  get moveX(): number { const [x] = rotateView(this.rawX, this.rawZ, this.viewAngle); return x; }
  get moveZ(): number { const [, z] = rotateView(this.rawX, this.rawZ, this.viewAngle); return z; }
}

/** rotate a screen-space (x right, z down) vector into world space for a camera yawed by `a` radians (about +Y) */
export function rotateView(x: number, z: number, a: number): [number, number] {
  const c = Math.cos(a), s = Math.sin(a);
  // screen-up (0,-1) maps to world (-sin a, 0, -cos a): same rotation as camera.up in game.ts
  const wx = x * c + z * s, wz = -x * s + z * c;
  return [Math.abs(wx) < 1e-9 ? 0 : wx, Math.abs(wz) < 1e-9 ? 0 : wz];
}
