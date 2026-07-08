/**
 * Canvas city map.
 *
 * Renders roads with street names, buildings tinted by type, the crime
 * scene, and the detective's position. Deliberately NOT omniscient: NPC
 * positions are never drawn — the detective learns where people are by
 * going places, like everyone else.
 */

import type { Building, BuildingType, World } from "../world/types";
import { isNight } from "../core/time";
import { el } from "./components";

const TYPE_COLORS: Record<BuildingType, string> = {
  "house": "#31404f",
  "apartment": "#37475a",
  "police-station": "#2d4a66",
  "hospital": "#2d5a55",
  "store": "#5a5136",
  "restaurant": "#5a4436",
  "bar": "#553a50",
  "cafe": "#4f4633",
  "park": "#2c4a34",
  "factory": "#4a4038",
  "office": "#3d4456",
  "warehouse": "#463f33",
  "school": "#3d5058",
};

export const TYPE_LABELS: Record<BuildingType, string> = {
  "house": "House", "apartment": "Apartments", "police-station": "Police Station",
  "hospital": "Hospital", "store": "Store", "restaurant": "Restaurant", "bar": "Bar",
  "cafe": "Café", "park": "Park", "factory": "Factory", "office": "Office",
  "warehouse": "Warehouse", "school": "School",
};

export interface MapCallbacks {
  onSelect: (buildingId: string | null) => void;
}

export class MapView {
  readonly root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private tooltip: HTMLElement;
  private world: World | null = null;
  private detectiveAt: string | null = null;
  private sceneId: string | null = null;
  private selectedId: string | null = null;
  private hoverId: string | null = null;
  private callbacks: MapCallbacks;
  private resizeObserver: ResizeObserver;

  constructor(callbacks: MapCallbacks) {
    this.callbacks = callbacks;
    this.canvas = el("canvas");
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute("aria-label", "City map. Buildings are selectable; your position and the crime scene are marked.");
    this.tooltip = el("div", { className: "map-tooltip" });
    this.tooltip.style.display = "none";
    this.root = el("div", { className: "map-wrap" }, [this.canvas, this.tooltip]);

    this.canvas.addEventListener("mousemove", (e) => this.onMove(e));
    this.canvas.addEventListener("mouseleave", () => {
      this.hoverId = null;
      this.tooltip.style.display = "none";
      this.draw();
    });
    this.canvas.addEventListener("click", (e) => {
      const b = this.buildingAt(e);
      this.selectedId = b?.id ?? null;
      this.callbacks.onSelect(this.selectedId);
      this.draw();
    });
    this.resizeObserver = new ResizeObserver(() => this.draw());
    this.resizeObserver.observe(this.root);
  }

  update(world: World, detectiveAt: string, sceneId: string | null, selectedId: string | null): void {
    this.world = world;
    this.detectiveAt = detectiveAt;
    this.sceneId = sceneId;
    this.selectedId = selectedId;
    this.draw();
  }

  destroy(): void {
    this.resizeObserver.disconnect();
  }

  // ----------------------------------------------------------------- layout

  private metrics(): { cell: number; ox: number; oy: number } | null {
    if (!this.world) return null;
    const rect = this.root.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return null;
    const pad = 24;
    const cell = Math.min(
      (rect.width - pad * 2) / this.world.city.width,
      (rect.height - pad * 2) / this.world.city.height
    );
    const ox = (rect.width - cell * this.world.city.width) / 2;
    const oy = (rect.height - cell * this.world.city.height) / 2;
    return { cell, ox, oy };
  }

  private buildingAt(e: MouseEvent): Building | null {
    const m = this.metrics();
    if (!m || !this.world) return null;
    const rect = this.canvas.getBoundingClientRect();
    const gx = (e.clientX - rect.left - m.ox) / m.cell;
    const gy = (e.clientY - rect.top - m.oy) / m.cell;
    for (const b of this.world.city.buildings) {
      if (gx >= b.lot.x && gx <= b.lot.x + b.lot.w && gy >= b.lot.y && gy <= b.lot.y + b.lot.h) {
        return b;
      }
    }
    return null;
  }

  private onMove(e: MouseEvent): void {
    const b = this.buildingAt(e);
    const newHover = b?.id ?? null;
    if (newHover !== this.hoverId) {
      this.hoverId = newHover;
      this.draw();
    }
    if (b) {
      const rect = this.root.getBoundingClientRect();
      this.tooltip.style.display = "block";
      this.tooltip.style.left = `${Math.min(e.clientX - rect.left + 14, rect.width - 250)}px`;
      this.tooltip.style.top = `${e.clientY - rect.top + 14}px`;
      const hours = b.openMin === 0 && b.closeMin >= 1440
        ? "always open"
        : `${fmtHour(b.openMin)}–${fmtHour(b.closeMin % 1440)}`;
      this.tooltip.replaceChildren(
        el("div", { text: b.name }),
        el("div", { className: "t-sub", text: `${TYPE_LABELS[b.type]} · ${hours}${b.hasCamera ? " · camera" : ""}` })
      );
    } else {
      this.tooltip.style.display = "none";
    }
  }

  // ------------------------------------------------------------------ paint

  private draw(): void {
    const m = this.metrics();
    if (!m || !this.world) return;
    const world = this.world;
    const rect = this.root.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    const ctx = this.canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);

    const night = isNight(world.time);
    // Ground.
    ctx.fillStyle = night ? "#080a0e" : "#0c0f14";
    ctx.fillRect(0, 0, rect.width, rect.height);

    const px = (x: number) => m.ox + x * m.cell;
    const py = (y: number) => m.oy + y * m.cell;

    // Roads.
    ctx.fillStyle = night ? "#151a22" : "#1a212c";
    for (const cell of world.city.roads.values()) {
      ctx.fillRect(px(cell.x), py(cell.y), m.cell + 0.5, m.cell + 0.5);
    }

    // Street name labels (once per road line, at the edges); skipped when
    // the map is too small for them to be legible.
    ctx.fillStyle = "#48566a";
    ctx.font = `${Math.max(9, m.cell * 0.62)}px ui-sans-serif`;
    const seenStreets = new Set<string>();
    const labelCells = m.cell >= 7 ? [...world.city.roads.values()] : [];
    for (const cell of labelCells) {
      if (seenStreets.has(cell.streetName)) continue;
      if (cell.streetName.endsWith("Street") && cell.y === 0) {
        seenStreets.add(cell.streetName);
        ctx.save();
        ctx.translate(px(cell.x) + m.cell * 0.75, py(0.4));
        ctx.rotate(Math.PI / 2);
        ctx.fillText(cell.streetName, 0, 0);
        ctx.restore();
      } else if (cell.streetName.endsWith("Avenue") && cell.x === 0) {
        seenStreets.add(cell.streetName);
        ctx.fillText(cell.streetName, px(0.3), py(cell.y) + m.cell * 0.75);
      }
    }

    // Buildings.
    for (const b of world.city.buildings) {
      const x = px(b.lot.x) + 1.5;
      const y = py(b.lot.y) + 1.5;
      const w = b.lot.w * m.cell - 3;
      const h = b.lot.h * m.cell - 3;
      const isScene = b.id === this.sceneId;
      const isHover = b.id === this.hoverId;
      const isSelected = b.id === this.selectedId;

      ctx.fillStyle = TYPE_COLORS[b.type];
      if (night) {
        // Lit windows at night for open/occupied venues; dark otherwise.
        ctx.globalAlpha = 0.75;
      }
      roundRect(ctx, x, y, w, h, 3);
      ctx.fill();
      ctx.globalAlpha = 1;

      if (isScene) {
        ctx.strokeStyle = "#c65f57";
        ctx.lineWidth = 2;
        roundRect(ctx, x - 1, y - 1, w + 2, h + 2, 4);
        ctx.stroke();
        ctx.fillStyle = "#c65f57";
        ctx.font = `700 ${Math.max(9, m.cell * 0.55)}px ui-sans-serif`;
        ctx.fillText("SCENE", x + 3, y - 4);
      } else if (isSelected) {
        ctx.strokeStyle = "#d8a95b";
        ctx.lineWidth = 2;
        roundRect(ctx, x - 1, y - 1, w + 2, h + 2, 4);
        ctx.stroke();
      } else if (isHover) {
        ctx.strokeStyle = "#8494a7";
        ctx.lineWidth = 1;
        roundRect(ctx, x, y, w, h, 3);
        ctx.stroke();
      }

      // Type glyph.
      ctx.fillStyle = "rgba(230, 236, 244, 0.55)";
      ctx.font = `${Math.max(8, m.cell * 0.8)}px ui-sans-serif`;
      const glyphs: Partial<Record<BuildingType, string>> = {
        "police-station": "✦", "hospital": "+", "bar": "◗", "cafe": "◖",
        "store": "▤", "restaurant": "♨", "park": "❧", "factory": "⚙",
        "office": "▥", "warehouse": "▦", "school": "◫",
      };
      const g = glyphs[b.type];
      if (g) ctx.fillText(g, x + w / 2 - m.cell * 0.3, y + h / 2 + m.cell * 0.3);

      // Camera pip.
      if (b.hasCamera) {
        ctx.fillStyle = "#6a9fd8";
        ctx.beginPath();
        ctx.arc(x + w - 4, y + 4, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Detective marker.
    if (this.detectiveAt) {
      const b = world.city.buildings.find((x) => x.id === this.detectiveAt);
      if (b) {
        const cx = px(b.lot.x + b.lot.w / 2);
        const cy = py(b.lot.y + b.lot.h / 2);
        ctx.fillStyle = "#d8a95b";
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(4, m.cell * 0.3), 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#0d1015";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    // Night vignette.
    if (night) {
      const grad = ctx.createRadialGradient(
        rect.width / 2, rect.height / 2, rect.height * 0.3,
        rect.width / 2, rect.height / 2, rect.height * 0.85
      );
      grad.addColorStop(0, "rgba(4,6,10,0)");
      grad.addColorStop(1, "rgba(4,6,10,0.55)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, rect.width, rect.height);
    }
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fmtHour(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}
