/**
 * Gamepad support: a focus-navigation layer over the DOM UI.
 *
 * D-pad / left stick moves focus between interactive elements, A activates,
 * B closes dialogs, LB/RB cycle panels. Activates only while a gamepad is
 * connected; keyboard and mouse are untouched.
 */

import { closeModal, isModalOpen } from "./components";
import { log } from "../core/log";

const FOCUSABLE = "button, select, input, textarea, .person-row, .card.clickable";

export class GamepadNav {
  private rafId: number | null = null;
  private prevButtons: boolean[] = [];
  private lastMove = 0;
  private focused: HTMLElement | null = null;
  private onTabCycle: (dir: 1 | -1) => void;

  constructor(onTabCycle: (dir: 1 | -1) => void) {
    this.onTabCycle = onTabCycle;
    window.addEventListener("gamepadconnected", (e) => {
      log.info("gamepad", `Connected: ${(e as GamepadEvent).gamepad.id}`);
      this.start();
    });
    window.addEventListener("gamepaddisconnected", () => {
      if (![...navigator.getGamepads()].some((g) => g !== null)) this.stop();
    });
    // A pad may already be connected at boot.
    if (typeof navigator.getGamepads === "function" && [...navigator.getGamepads()].some((g) => g !== null)) {
      this.start();
    }
  }

  private start(): void {
    if (this.rafId !== null) return;
    const loop = () => {
      this.poll();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private stop(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.setFocus(null);
  }

  private candidates(): HTMLElement[] {
    // Modal traps focus while open.
    const scope: ParentNode = isModalOpen() ? document.querySelector(".modal") ?? document : document;
    return [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => {
      const r = n.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight + 200;
    });
  }

  private setFocus(node: HTMLElement | null): void {
    this.focused?.classList.remove("pad-focus");
    this.focused = node;
    if (node) {
      node.classList.add("pad-focus");
      node.scrollIntoView({ block: "nearest" });
    }
  }

  /** Nearest candidate in a direction (spatial navigation). */
  private move(dx: number, dy: number): void {
    const items = this.candidates();
    if (items.length === 0) return;
    if (!this.focused || !items.includes(this.focused)) {
      this.setFocus(items[0]!);
      return;
    }
    const from = this.focused.getBoundingClientRect();
    const fx = from.left + from.width / 2;
    const fy = from.top + from.height / 2;
    let best: { node: HTMLElement; score: number } | null = null;
    for (const node of items) {
      if (node === this.focused) continue;
      const r = node.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const vx = cx - fx;
      const vy = cy - fy;
      // Must be in the requested half-plane.
      const along = vx * dx + vy * dy;
      if (along <= 4) continue;
      const across = Math.abs(vx * dy) + Math.abs(vy * dx);
      const score = along + across * 2.5;
      if (!best || score < best.score) best = { node, score };
    }
    if (best) this.setFocus(best.node);
  }

  private poll(): void {
    const pads = navigator.getGamepads();
    const pad = [...pads].find((g) => g !== null);
    if (!pad) return;

    const pressed = (i: number) => pad.buttons[i]?.pressed ?? false;
    const justPressed = (i: number) => pressed(i) && !this.prevButtons[i];
    const now = performance.now();

    // Movement: d-pad 12/13/14/15 or left stick, rate-limited.
    const ax = pad.axes[0] ?? 0;
    const ay = pad.axes[1] ?? 0;
    const wantX = pressed(15) ? 1 : pressed(14) ? -1 : Math.abs(ax) > 0.55 ? Math.sign(ax) : 0;
    const wantY = pressed(13) ? 1 : pressed(12) ? -1 : Math.abs(ay) > 0.55 ? Math.sign(ay) : 0;
    if ((wantX !== 0 || wantY !== 0) && now - this.lastMove > 180) {
      this.lastMove = now;
      this.move(wantX, wantY);
    }

    if (justPressed(0) && this.focused) {
      // A: activate. Selects open natively on click in most browsers; inputs focus.
      if (this.focused instanceof HTMLInputElement || this.focused instanceof HTMLTextAreaElement || this.focused instanceof HTMLSelectElement) {
        this.focused.focus();
      } else {
        this.focused.click();
      }
    }
    if (justPressed(1)) {
      if (isModalOpen()) closeModal();
      else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    }
    if (justPressed(4)) this.onTabCycle(-1);
    if (justPressed(5)) this.onTabCycle(1);

    this.prevButtons = pad.buttons.map((b) => b.pressed);
  }
}
