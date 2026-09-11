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

/**
 * Gamepad → virtual key codes (standard mapping, e.g. Xbox layout / Android handhelds like the Ayn Thor).
 * Buttons are translated into the same key codes as the keyboard so all game logic stays key-based.
 */
const PAD_BUTTONS: Record<number, string> = {
  0: 'KeyJ',       // A  – sword / talk / confirm
  1: 'KeyK',       // B  – shield
  2: 'KeyE',       // X  – talk
  3: 'KeyK',       // Y  – shield
  4: 'KeyQ',       // LB – rotate view ccw
  5: 'KeyR',       // RB – rotate view cw
  6: 'KeyQ',       // LT
  7: 'KeyR',       // RT
  8: 'KeyM',       // Select/Back – mute
  9: 'Enter',      // Start – pause / confirm
  12: 'ArrowUp', 13: 'ArrowDown', 14: 'ArrowLeft', 15: 'ArrowRight', // d-pad
};
const STICK_DEADZONE = 0.35;

export class Input {
  private keys = new Set<string>();
  private pressed = new Set<string>();
  /** virtual keys currently held via gamepad (kept separate so a released button can't clear a physically held key) */
  private padKeys = new Set<string>();
  /** true once any gamepad input has been seen — lets the UI show controller hints */
  gamepadActive = false;
  private onPadUse: () => void = () => {};
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
  /** Poll connected gamepads; call once per frame before reading input. */
  pollGamepads() {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    const next = new Set<string>();
    for (const gp of pads) {
      if (!gp || !gp.connected) continue;
      gp.buttons.forEach((b, i) => { const code = PAD_BUTTONS[i]; if (code && (b.pressed || b.value > 0.5)) next.add(code); });
      const [lx = 0, ly = 0] = gp.axes;
      if (Math.hypot(lx, ly) > STICK_DEADZONE) {
        // 8-way digitise the stick so it behaves exactly like the d-pad / WASD
        const ang = Math.atan2(ly, lx);
        const sector = Math.round(ang / (Math.PI / 4));
        const dx = Math.round(Math.cos(sector * Math.PI / 4)), dy = Math.round(Math.sin(sector * Math.PI / 4));
        if (dx > 0) next.add('ArrowRight'); else if (dx < 0) next.add('ArrowLeft');
        if (dy > 0) next.add('ArrowDown'); else if (dy < 0) next.add('ArrowUp');
      }
    }
    for (const code of next) if (!this.padKeys.has(code)) { this.pressed.add(code); if (!this.gamepadActive) { this.gamepadActive = true; this.onPadUse(); } }
    this.padKeys = next;
  }
  /** Called the first time a gamepad button/stick is used. */
  onGamepadUse(fn: () => void) { this.onPadUse = fn; }

  down(codes: string[]): boolean { return codes.some((c) => this.keys.has(c) || this.padKeys.has(c)); }
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
