/**
 * Relationship graph + suspect comparison.
 *
 * Strictly knowledge-gated: the graph shows public town facts (marriages,
 * households, workplaces) plus ONLY the relationship facts the detective has
 * learned through evidence and testimony. Nodes appear once a person is
 * connected to the case (victim, interviewed, or named in evidence).
 */

import { el, clear, tag } from "../components";
import type { UiCtx } from "./types";
import type { Npc, NpcId, World } from "../../world/types";
import { fullName, buildingById } from "../../world/types";
import { computeContradictions, type CaseFile, type RelationFactKind } from "../../investigation/casefile";
import { occupationById } from "../../data/occupations";
import { loadSettings } from "../settings";

interface GraphEdge {
  aId: NpcId;
  bId: NpcId;
  kind: RelationFactKind | "partner" | "household" | "colleagues";
  label: string;
}

const EDGE_COLORS: Record<GraphEdge["kind"], string> = {
  "partner": "#6a9fd8",
  "household": "#4d647e",
  "colleagues": "#55606e",
  "feud": "#c65f57",
  "affair": "#c675a8",
  "debt": "#d8a95b",
  "blackmail": "#b04a8f",
  "romance": "#c675a8",
  "theft-victim": "#a8703d",
};

/** Okabe–Ito hues — distinguishable under the common color-vision deficiencies. */
const EDGE_COLORS_CB: Record<GraphEdge["kind"], string> = {
  "partner": "#56B4E9",
  "household": "#8a94a0",
  "colleagues": "#b0b6bd",
  "feud": "#D55E00",
  "affair": "#CC79A7",
  "debt": "#E69F00",
  "blackmail": "#0072B2",
  "romance": "#CC79A7",
  "theft-victim": "#009E73",
};

/**
 * In colorblind mode, hue is never the only channel: each learned-edge kind
 * also gets its own dash pattern ([] = solid).
 */
const EDGE_DASHES_CB: Record<GraphEdge["kind"], number[]> = {
  "partner": [],
  "household": [2, 4],
  "colleagues": [2, 4],
  "feud": [],
  "affair": [2, 3],
  "debt": [8, 3],
  "blackmail": [8, 3, 2, 3],
  "romance": [2, 3],
  "theft-victim": [12, 4],
};

export function edgeStyle(kind: GraphEdge["kind"], colorblind: boolean): { color: string; dash: number[] } {
  return colorblind
    ? { color: EDGE_COLORS_CB[kind], dash: EDGE_DASHES_CB[kind] }
    : { color: EDGE_COLORS[kind], dash: [] };
}

const EDGE_LABELS: Record<GraphEdge["kind"], string> = {
  "partner": "partners",
  "household": "same household",
  "colleagues": "colleagues",
  "feud": "feud",
  "affair": "affair",
  "debt": "debt",
  "blackmail": "blackmail",
  "romance": "attraction",
  "theft-victim": "theft",
};

/** People connected to the case so far (never the whole town). */
export function knownNpcIds(cf: CaseFile): Set<NpcId> {
  const ids = new Set<NpcId>();
  ids.add(cf.victimId);
  for (const id of cf.interviewed) ids.add(id);
  for (const e of cf.evidence) for (const id of e.npcIds) ids.add(id);
  for (const f of cf.relationFacts) { ids.add(f.aId); ids.add(f.bId); }
  return ids;
}

/** Edges the detective may see: public facts among known people + learned facts. */
export function knownEdges(world: World, cf: CaseFile): GraphEdge[] {
  const known = knownNpcIds(cf);
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const push = (e: GraphEdge) => {
    const key = [e.aId, e.bId].sort().join("|") + "|" + e.kind;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(e);
  };
  // Public town knowledge, but only among people already in the case.
  for (const n of world.npcs) {
    if (!known.has(n.id)) continue;
    if (n.partnerId && known.has(n.partnerId)) {
      push({ aId: n.id, bId: n.partnerId, kind: "partner", label: "married/partners" });
    }
    for (const o of world.npcs) {
      if (o.id === n.id || !known.has(o.id)) continue;
      if (o.householdId === n.householdId && o.partnerId !== n.id) {
        push({ aId: n.id, bId: o.id, kind: "household", label: "share a home" });
      }
      if (n.workplaceId && n.workplaceId === o.workplaceId) {
        push({ aId: n.id, bId: o.id, kind: "colleagues", label: `both work at ${buildingById(world, n.workplaceId).name}` });
      }
    }
  }
  // Learned facts always shown (their people are in `known` by construction).
  for (const f of cf.relationFacts) {
    push({ aId: f.aId, bId: f.bId, kind: f.kind, label: f.label });
  }
  return edges;
}

export class RelationsPanel {
  readonly root: HTMLElement;
  private ctx: UiCtx;
  private canvas: HTMLCanvasElement;
  private legend: HTMLElement;
  private compare: HTMLElement;
  private nodePositions = new Map<NpcId, { x: number; y: number }>();
  private hoverId: NpcId | null = null;

  constructor(ctx: UiCtx) {
    this.ctx = ctx;
    this.canvas = el("canvas");
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute("aria-label", "Relationship graph of people connected to the case. Click a person to open their profile; the comparison list below repeats the same information as text.");
    this.canvas.style.cssText = "width:100%;height:380px;display:block;background:#0a0d11;border:1px solid var(--border);border-radius:8px;cursor:pointer;";
    this.legend = el("div", { className: "filter-row" });
    this.compare = el("div");
    this.root = el("div", { className: "panel-scroll" });

    this.canvas.addEventListener("mousemove", (e) => {
      const id = this.nodeAt(e);
      if (id !== this.hoverId) {
        this.hoverId = id;
        this.canvas.style.cursor = id ? "pointer" : "default";
        this.draw();
      }
    });
    this.canvas.addEventListener("click", (e) => {
      const id = this.nodeAt(e);
      if (id) this.ctx.openSuspect(id);
    });
  }

  private nodeAt(e: MouseEvent): NpcId | null {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    for (const [id, p] of this.nodePositions) {
      if (Math.hypot(p.x - x, p.y - y) < 18) return id;
    }
    return null;
  }

  render(): void {
    clear(this.root);
    this.root.append(
      el("div", { className: "panel-header" }, [
        el("h2", { text: "Web of Relations" }),
        el("div", { className: "sub", text: "Only what you've learned. Interview people and dig through records to grow the web." }),
      ])
    );

    // Legend (follows the active palette).
    clear(this.legend);
    const cb = loadSettings().colorblind;
    for (const kind of Object.keys(EDGE_COLORS) as Array<GraphEdge["kind"]>) {
      const { color } = edgeStyle(kind, cb);
      const chip = el("span", { className: "tag", text: EDGE_LABELS[kind] });
      chip.style.borderColor = color;
      chip.style.color = color;
      this.legend.append(chip);
    }
    this.root.append(this.legend, this.canvas);

    this.root.append(el("div", { className: "kicker", text: "Suspect comparison" }));
    this.renderCompare();
    this.root.append(this.compare);

    // Draw after attach so the canvas has a size.
    requestAnimationFrame(() => this.draw());
  }

  private draw(): void {
    const { game } = this.ctx;
    const world = game.world;
    const cf = game.casefile;
    const r = this.canvas.getBoundingClientRect();
    if (r.width < 10) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = r.width * dpr;
    this.canvas.height = r.height * dpr;
    const g = this.canvas.getContext("2d")!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, r.width, r.height);

    const known = knownNpcIds(cf);
    const edges = knownEdges(world, cf);
    const people = world.npcs.filter((n) => known.has(n.id));
    this.nodePositions.clear();
    if (people.length === 0) return;

    // Layout: victim at center, everyone else on rings ordered by connection count.
    const cx = r.width / 2;
    const cy = r.height / 2;
    const victim = people.find((n) => n.id === cf.victimId);
    const others = people.filter((n) => n.id !== cf.victimId);
    const degree = (id: NpcId) => edges.filter((e) => e.aId === id || e.bId === id).length;
    others.sort((a, b) => degree(b.id) - degree(a.id));
    if (victim) this.nodePositions.set(victim.id, { x: cx, y: cy });
    const inner = others.slice(0, 8);
    const outer = others.slice(8);
    inner.forEach((n, i) => {
      const a = (i / Math.max(1, inner.length)) * Math.PI * 2 - Math.PI / 2;
      this.nodePositions.set(n.id, { x: cx + Math.cos(a) * Math.min(cx, cy) * 0.5, y: cy + Math.sin(a) * Math.min(cx, cy) * 0.5 });
    });
    outer.forEach((n, i) => {
      const a = (i / Math.max(1, outer.length)) * Math.PI * 2 - Math.PI / 2 + 0.2;
      this.nodePositions.set(n.id, { x: cx + Math.cos(a) * Math.min(cx, cy) * 0.85, y: cy + Math.sin(a) * Math.min(cx, cy) * 0.85 });
    });

    // Edges.
    g.lineWidth = 1.5;
    g.font = "10px ui-sans-serif";
    for (const e of edges) {
      const pa = this.nodePositions.get(e.aId);
      const pb = this.nodePositions.get(e.bId);
      if (!pa || !pb) continue;
      const isLearned = !["partner", "household", "colleagues"].includes(e.kind);
      const style = edgeStyle(e.kind, loadSettings().colorblind);
      g.strokeStyle = style.color;
      g.globalAlpha = isLearned ? 0.9 : 0.35;
      g.setLineDash(isLearned ? style.dash : [3, 4]);
      g.beginPath();
      g.moveTo(pa.x, pa.y);
      g.lineTo(pb.x, pb.y);
      g.stroke();
      if (isLearned) {
        g.fillStyle = style.color;
        g.fillText(EDGE_LABELS[e.kind], (pa.x + pb.x) / 2 + 4, (pa.y + pb.y) / 2 - 2);
      }
    }
    g.setLineDash([]);
    g.globalAlpha = 1;

    // Nodes.
    const contradicted = new Set(computeContradictions(cf).map((c) => c.npcId));
    for (const n of people) {
      const p = this.nodePositions.get(n.id)!;
      const isVictim = n.id === cf.victimId;
      const isHover = n.id === this.hoverId;
      g.beginPath();
      g.arc(p.x, p.y, isVictim ? 14 : 11, 0, Math.PI * 2);
      g.fillStyle = isVictim ? "#3d2226" : "#1a212c";
      g.fill();
      g.strokeStyle = isVictim ? "#c65f57" : contradicted.has(n.id) ? "#c65f57" : isHover ? "#d8a95b" : "#34404f";
      g.lineWidth = isHover || isVictim || contradicted.has(n.id) ? 2 : 1;
      g.stroke();
      g.fillStyle = "#cdd6e1";
      g.font = "bold 9px ui-sans-serif";
      g.textAlign = "center";
      g.fillText(`${n.first[0]}${n.last[0]}`, p.x, p.y + 3);
      g.font = "10px ui-sans-serif";
      g.fillStyle = isVictim ? "#c65f57" : "#8494a7";
      g.fillText(`${n.first} ${n.last}`, p.x, p.y + (isVictim ? 28 : 24));
      g.textAlign = "start";
    }
  }

  /** Side-by-side comparison of everyone connected to the case. */
  private renderCompare(): void {
    const { game } = this.ctx;
    const world = game.world;
    const cf = game.casefile;
    clear(this.compare);

    const footprint = cf.evidence.find((e) => e.kind === "footprint");
    const sizeMatch = footprint ? Number(/size (\d+)/.exec(footprint.title)?.[1] ?? NaN) : NaN;
    const contradicted = new Set(computeContradictions(cf).map((c) => c.npcId));
    const known = [...knownNpcIds(cf)]
      .map((id) => world.npcs.find((n) => n.id === id))
      .filter((n): n is Npc => n !== undefined && n.id !== cf.victimId && n.alive);
    known.sort((a, b) => {
      const score = (n: Npc) =>
        (contradicted.has(n.id) ? 4 : 0) +
        cf.evidence.filter((e) => e.npcIds.includes(n.id)).length;
      return score(b) - score(a);
    });

    if (known.length === 0) {
      this.compare.append(el("div", { className: "card" }, [
        el("div", { className: "card-body", text: "Nobody is connected to the case yet." }),
      ]));
      return;
    }
    for (const n of known.slice(0, 12)) {
      const evCount = cf.evidence.filter((e) => e.npcIds.includes(n.id)).length;
      const interviewed = cf.interviewed.includes(n.id);
      const row = el("div", { className: "card clickable" });
      const title = el("div", { className: "card-title" }, [
        el("span", { text: fullName(n) }),
        contradicted.has(n.id) ? tag("story broken", "danger") : null,
        interviewed && !Number.isNaN(sizeMatch) && n.shoeSize === sizeMatch ? tag(`shoe size ${n.shoeSize} = scene`, "accent") : null,
      ]);
      const bits: string[] = [occupationById(n.occupation).label];
      if (interviewed) bits.push(`shoe size ${n.shoeSize}${!Number.isNaN(sizeMatch) ? (n.shoeSize === sizeMatch ? " (matches scene)" : ` (scene: ${sizeMatch})`) : ""}`);
      bits.push(`${evCount} evidence item${evCount === 1 ? "" : "s"} mention${evCount === 1 ? "s" : ""} them`);
      row.append(title, el("div", { className: "card-meta", text: bits.join(" · ") }));
      row.addEventListener("click", () => this.ctx.openSuspect(n.id));
      this.compare.append(row);
    }
  }
}
