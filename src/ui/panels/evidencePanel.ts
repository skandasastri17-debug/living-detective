/**
 * Evidence board: everything collected, filterable by kind, with detail
 * view and the confront flow entry point.
 */

import { el, button, tag, clear, openModal, closeModal } from "../components";
import type { UiCtx } from "./types";
import type { EvidenceEntry, EvidenceKind } from "../../investigation/casefile";
import { computeContradictions } from "../../investigation/casefile";
import { fmtTimeLong } from "../../core/time";
import { fullName } from "../../world/types";
import { EVIDENCE_KIND_LABELS as KIND_LABELS, EVIDENCE_KIND_TAGS as KIND_TAGS } from "../evidenceKinds";

export class EvidencePanel {
  readonly root: HTMLElement;
  private ctx: UiCtx;
  private filter: EvidenceKind | "all" = "all";

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
        el("h2", { text: "Evidence Board" }),
        el("div", { className: "sub", text: `${cf.evidence.length} pieces collected. Every one of them traces to something that really happened.` }),
      ])
    );

    // Filter row.
    const kindsPresent = [...new Set(cf.evidence.map((e) => e.kind))];
    const filterRow = el("div", { className: "filter-row" });
    const mk = (label: string, value: EvidenceKind | "all") => {
      const b = button(label, () => { this.filter = value; this.render(); }, this.filter === value ? "small primary" : "small");
      return b;
    };
    filterRow.append(mk(`All (${cf.evidence.length})`, "all"));
    for (const k of kindsPresent) {
      filterRow.append(mk(`${KIND_LABELS[k]} (${cf.evidence.filter((e) => e.kind === k).length})`, k));
    }
    this.root.append(filterRow);

    const contradictions = computeContradictions(cf);
    const shown = cf.evidence.filter((e) => this.filter === "all" || e.kind === this.filter);
    if (shown.length === 0) {
      this.root.append(el("div", { className: "card" }, [
        el("div", { className: "card-body", text: cf.evidence.length === 0 ? "Nothing yet. Start at the crime scene." : "No evidence of this kind." }),
      ]));
    }
    for (const e of [...shown].reverse()) {
      const card = el("div", { className: "card clickable" });
      const title = el("div", { className: "card-title" }, [
        tag(KIND_LABELS[e.kind], KIND_TAGS[e.kind] ?? ""),
        el("span", { text: e.title }),
      ]);
      const involved = e.npcIds
        .map((id) => this.ctx.game.world.npcs.find((n) => n.id === id))
        .filter((n) => n !== undefined)
        .map((n) => fullName(n!));
      const meta = el("div", {
        className: "card-meta",
        text: `${fmtTimeLong(e.discoveredAt)}${involved.length > 0 ? ` · involves ${involved.slice(0, 4).join(", ")}${involved.length > 4 ? "…" : ""}` : ""}`,
      });
      card.append(title, meta);
      if (contradictions.some((c) => c.evidenceId === e.id)) {
        card.append(el("div", { className: "card-body" }, [tag("contradicts a statement", "danger")]));
      }
      card.addEventListener("click", () => this.showDetail(e));
      this.root.append(card);
    }
  }

  private showDetail(e: EvidenceEntry): void {
    const { game } = this.ctx;
    const body = el("div", {}, [
      el("div", { className: "card-body", text: e.detail }),
    ]);
    body.querySelector<HTMLElement>(".card-body")!.style.cssText = "font-family:var(--mono);font-size:12.5px;max-height:46vh;overflow-y:auto;";
    const conflicts = computeContradictions(game.casefile).filter((c) => c.evidenceId === e.id);
    if (conflicts.length > 0) {
      body.append(el("div", { className: "kicker", text: "Contradicts" }));
      for (const c of conflicts) {
        body.append(el("div", { className: "dialogue", text: c.summary }));
      }
    }
    const actions: HTMLElement[] = [
      button("Confront someone with this…", () => {
        closeModal();
        this.ctx.confrontWith(e.id);
      }, "primary"),
      button("Close", () => closeModal()),
    ];
    openModal(e.title, body, actions);
  }
}
