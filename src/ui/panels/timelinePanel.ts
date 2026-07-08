/**
 * Timeline reconstruction: every time-anchored fact in the case file laid
 * out chronologically around the estimated murder window. This is where
 * alibis visibly collide with evidence.
 */

import { el, clear, tag } from "../components";
import type { UiCtx } from "./types";
import { fmtClock, fmtTimeLong } from "../../core/time";
import { fullName } from "../../world/types";

interface TimelineNode {
  t: number;
  tEnd: number | null;
  title: string;
  sub: string;
  kind: "evidence" | "claim" | "window";
  flagged?: boolean;
}

export class TimelinePanel {
  readonly root: HTMLElement;
  private ctx: UiCtx;

  constructor(ctx: UiCtx) {
    this.ctx = ctx;
    this.root = el("div", { className: "panel-scroll" });
  }

  render(): void {
    const { game } = this.ctx;
    const cf = game.casefile;
    clear(this.root);
    this.root.append(
      el("div", { className: "panel-header" }, [
        el("h2", { text: "Timeline" }),
        el("div", { className: "sub", text: "Time-anchored facts from the case file. The autopsy window frames the night." }),
      ])
    );

    const nodes: TimelineNode[] = [];

    // Autopsy window (only if the player has it).
    const autopsy = cf.evidence.find((e) => e.kind === "autopsy");
    if (autopsy && autopsy.placesFrom !== null && autopsy.placesTo !== null) {
      nodes.push({
        t: autopsy.placesFrom, tEnd: autopsy.placesTo,
        title: "Estimated time of death",
        sub: `Between ${fmtTimeLong(autopsy.placesFrom)} and ${fmtClock(autopsy.placesTo)} (autopsy)`,
        kind: "window",
      });
    }

    // Placement-grade evidence.
    for (const e of cf.evidence) {
      if (e.placesFrom === null || e.placesAtBuildingId === null || e.kind === "autopsy") continue;
      const who = e.npcIds
        .map((id) => game.world.npcs.find((n) => n.id === id))
        .filter((n) => n !== undefined)
        .map((n) => fullName(n!))
        .join(", ");
      nodes.push({
        t: e.placesFrom, tEnd: e.placesTo,
        title: e.title,
        sub: who ? `Places: ${who}` : "",
        kind: "evidence",
      });
    }

    // Claims from statements.
    for (const s of cf.statements) {
      for (const c of s.claims) {
        nodes.push({
          t: c.from, tEnd: c.to,
          title: c.description,
          sub: `Claimed by ${fullName(game.npc(s.npcId))} under questioning`,
          kind: "claim",
        });
      }
    }

    if (nodes.length === 0) {
      this.root.append(el("div", { className: "card" }, [
        el("div", { className: "card-body", text: "No time-anchored facts yet. The autopsy, camera pulls, and testimony will populate this." }),
      ]));
      return;
    }

    nodes.sort((a, b) => a.t - b.t);
    const wrap = el("div");
    for (const n of nodes) {
      if (n.kind === "window") {
        wrap.append(el("div", { className: "tl-window", text: `☠ ${n.title} — ${n.sub}` }));
        continue;
      }
      const row = el("div", { className: "tl-row" });
      const time = el("div", { className: "tl-time", text: n.tEnd && n.tEnd - n.t > 15 ? `${fmtTimeLong(n.t)}\n– ${fmtClock(n.tEnd)}` : fmtTimeLong(n.t) });
      time.style.whiteSpace = "pre";
      const line = el("div", { className: "tl-line" }, [
        el("div", { className: `tl-dot ${n.kind === "claim" ? "" : "accent"}` }),
      ]);
      const body = el("div", { className: "tl-body" }, [
        el("div", { className: "tl-title" }, [
          n.kind === "claim" ? tag("claim", "") : tag("evidence", "accent"),
          el("span", { text: " " + n.title }),
        ]),
        n.sub ? el("div", { className: "tl-sub", text: n.sub }) : null,
      ]);
      row.append(time, line, body);
      wrap.append(row);
    }
    this.root.append(wrap);
  }
}
