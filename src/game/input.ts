const GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyJ', 'KeyK', 'KeyZ', 'KeyX', 'KeyE', 'KeyC', 'Space', 'ShiftLeft', 'ShiftRight', 'Enter', 'KeyM', 'KeyP', 'Escape',
]);

export const ATTACK_KEYS = ['KeyJ', 'KeyZ', 'Space'];
export const SHIELD_KEYS = ['KeyK', 'KeyX', 'ShiftLeft', 'ShiftRight'];
export const PAUSE_KEYS = ['Enter', 'KeyP', 'Escape'];
export const MUTE_KEYS = ['KeyM'];
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

  get moveX(): number {
    return (this.down(['KeyD', 'ArrowRight']) ? 1 : 0) - (this.down(['KeyA', 'ArrowLeft']) ? 1 : 0);
  }
  get moveZ(): number {
    return (this.down(['KeyS', 'ArrowDown']) ? 1 : 0) - (this.down(['KeyW', 'ArrowUp']) ? 1 : 0);
  }
}
