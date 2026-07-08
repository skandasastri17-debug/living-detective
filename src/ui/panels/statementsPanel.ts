/**
 * Interview log: every statement in chronological order, with the claims it
 * contains and any contradictions the evidence has exposed.
 */

import { el, tag, clear, button } from "../components";
import type { UiCtx } from "./types";
import { computeContradictions } from "../../investigation/casefile";
import { fmtTimeLong } from "../../core/time";
import { fullName } from "../../world/types";

export class StatementsPanel {
  readonly root: HTMLElement;
  private ctx: UiCtx;
  private onlyContradicted = false;

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
        el("h2", { text: "Interview Log" }),
        el("div", { className: "sub", text: `${cf.statements.length} statements on record. Liars have reasons; find the reason.` }),
      ])
    );

    const contradictions = computeContradictions(cf);
    const filterRow = el("div", { className: "filter-row" });
    filterRow.append(
      button(this.onlyContradicted ? "Show all" : `Show contradicted only (${new Set(contradictions.map((c) => c.statementId)).size})`, () => {
        this.onlyContradicted = !this.onlyContradicted;
        this.render();
      }, "small")
    );
    this.root.append(filterRow);

    let statements = [...cf.statements].reverse();
    if (this.onlyContradicted) {
      const flagged = new Set(contradictions.map((c) => c.statementId));
      statements = statements.filter((s) => flagged.has(s.id));
    }
    if (statements.length === 0) {
      this.root.append(el("div", { className: "card" }, [
        el("div", { className: "card-body", text: cf.statements.length === 0 ? "No interviews yet. Find the people in the victim's life and start asking questions." : "Nothing here under this filter." }),
      ]));
      return;
    }

    for (const s of statements) {
      const speaker = game.npc(s.npcId);
      const flagged = contradictions.filter((c) => c.statementId === s.id);
      const card = el("div", { className: "card" });
      const title = el("div", { className: "card-title" }, [
        el("span", { text: fullName(speaker) }),
        flagged.length > 0 ? tag("contradicted", "danger") : null,
        s.topic === "confront" ? tag("confrontation", "accent") : null,
        s.guarded ? tag("holding back", "info") : null,
      ]);
      card.append(
        title,
        el("div", { className: "card-meta", text: `${fmtTimeLong(s.t)} — ${s.question}` }),
        el("div", { className: "dialogue", text: `“${s.answer}”` }),
      );
      if (s.claims.length > 0) {
        const claimsBox = el("div", { className: "card-body" });
        claimsBox.append(el("div", { className: "kicker", text: "Claims made" }));
        for (const c of s.claims) {
          claimsBox.append(el("div", { text: `· ${c.description}` }));
        }
        card.append(claimsBox);
      }
      for (const c of flagged) {
        card.append(el("div", { className: "tl-window", text: `⚠ ${c.summary}` }));
      }
      const jump = button("View speaker", () => this.ctx.openSuspect(s.npcId), "small");
      jump.style.marginTop = "8px";
      card.append(jump);
      this.root.append(card);
    }
  }
}
