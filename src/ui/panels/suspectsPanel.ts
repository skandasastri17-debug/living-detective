/**
 * Suspects panel: the town roster, profiles built from what the detective
 * has actually learned, and every people-bound action (interview topics,
 * records pulls, confrontations).
 */

import { el, button, tag, clear, openModal, closeModal } from "../components";
import type { UiCtx } from "./types";
import type { Npc, NpcId } from "../../world/types";
import { buildingById, fullName } from "../../world/types";
import { computeContradictions, evidenceAbout } from "../../investigation/casefile";
import { occupationById } from "../../data/occupations";
import { fmtTimeLong } from "../../core/time";

export class SuspectsPanel {
  readonly root: HTMLElement;
  private ctx: UiCtx;
  private search = "";

  constructor(ctx: UiCtx) {
    this.ctx = ctx;
    this.root = el("div", { className: "panel-scroll" });
  }

  render(): void {
    const { game } = this.ctx;
    clear(this.root);
    this.root.append(
      el("div", { className: "panel-header" }, [
        el("h2", { text: "People of " + game.world.cityName }),
        el("div", { className: "sub", text: "Everyone is a suspect until the timeline says otherwise." }),
      ])
    );

    const grid = el("div", { className: "two-col" });
    const listCol = el("div");
    const profileCol = el("div");
    grid.append(listCol, profileCol);
    this.root.append(grid);

    // Search.
    const searchInput = el("input", { type: "text", placeholder: "Search people…", value: this.search });
    searchInput.style.cssText = "width:100%;margin-bottom:10px;";
    searchInput.addEventListener("input", () => {
      this.search = searchInput.value;
      renderList();
      // keep focus
    });
    listCol.append(searchInput);
    const listWrap = el("div");
    listCol.append(listWrap);

    const cf = game.casefile;
    const contradictions = computeContradictions(cf);

    const renderList = () => {
      clear(listWrap);
      const q = this.search.toLowerCase();
      const people = game.world.npcs
        .filter((n) => fullName(n).toLowerCase().includes(q))
        .sort((a, b) => {
          // Victim first, then interviewed, then alphabetical.
          if (a.id === cf.victimId) return -1;
          if (b.id === cf.victimId) return 1;
          return fullName(a).localeCompare(fullName(b));
        });
      for (const n of people) {
        const row = el("div", { className: `person-row ${n.alive ? "" : "dead"} ${this.ctx.selectedSuspectId === n.id ? "selected" : ""}` });
        const initials = `${n.first[0] ?? ""}${n.last[0] ?? ""}`;
        row.append(
          el("div", { className: "avatar", text: initials }),
          el("div", {}, [
            el("div", { className: "p-name", text: fullName(n) }),
            el("div", { className: "p-sub", text: occupationById(n.occupation).label }),
          ])
        );
        const badges = el("div");
        badges.style.cssText = "margin-left:auto;display:flex;gap:4px;";
        if (n.id === cf.victimId) badges.append(tag("victim", "danger"));
        if (cf.interviewed.includes(n.id)) badges.append(tag("met", "success"));
        if (contradictions.some((c) => c.npcId === n.id)) badges.append(tag("lied?", "danger"));
        row.append(badges);
        row.addEventListener("click", () => {
          this.ctx.selectedSuspectId = n.id;
          this.render();
        });
        listWrap.append(row);
      }
    };
    renderList();

    // Profile.
    const sel = this.ctx.selectedSuspectId
      ? game.world.npcs.find((n) => n.id === this.ctx.selectedSuspectId)
      : undefined;
    if (!sel) {
      profileCol.append(el("div", { className: "card" }, [
        el("div", { className: "card-body", text: "Select a person to see their profile and question them." }),
      ]));
      return;
    }
    this.renderProfile(profileCol, sel);
  }

  private renderProfile(col: HTMLElement, n: Npc): void {
    const { game } = this.ctx;
    const cf = game.casefile;
    const isVictim = n.id === cf.victimId;
    const interviewed = cf.interviewed.includes(n.id);
    const box = el("div", { className: "profile-box" });
    col.append(box);

    const uncooperative =
      !cf.openedUp.includes(n.id) &&
      cf.statements.some((s) => s.npcId === n.id && s.guarded);
    const head = el("div", { className: "profile-head" }, [
      el("h2", { text: fullName(n) }),
      isVictim ? tag("victim", "danger") : null,
      !n.alive && !isVictim ? tag("deceased", "danger") : null,
      uncooperative ? tag("uncooperative — bring leverage", "info") : null,
    ]);
    box.append(head);

    const home = buildingById(game.world, n.homeId);
    const work = n.workplaceId ? buildingById(game.world, n.workplaceId) : null;
    const kv = el("div", { className: "kv" });
    const put = (k: string, v: string) => kv.append(el("div", { className: "k", text: k }), el("div", { text: v }));
    put("Age", String(n.age));
    put("Occupation", occupationById(n.occupation).label);
    put("Home", home.name);
    if (work) put("Works at", work.name);
    if (n.partnerId) put("Partner", fullName(game.npc(n.partnerId)));
    if (interviewed || isVictim) {
      put("Shoe size", String(n.shoeSize));
      if (n.habits.length > 0) put("Known habits", n.habits.join("; "));
    } else {
      put("Notes", "Interview them to build a profile.");
    }
    box.append(kv);

    // Actions.
    if (n.alive) {
      box.append(el("div", { className: "kicker", text: "Questioning (30 min + travel)" }));
      const acts = el("div", { className: "actions" });
      acts.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:6px;";
      acts.append(
        button("Whereabouts that night", () => this.interview(n.id, "whereabouts"), "small"),
        button("Last saw the victim", () => this.interview(n.id, "last-saw-victim"), "small"),
        button("Relationship to victim", () => this.interview(n.id, "relationship-victim"), "small"),
        button("Anything unusual?", () => this.interview(n.id, "anything-unusual"), "small"),
        button("Who had trouble with the victim?", () => this.interview(n.id, "enemies"), "small"),
        button("Ask about someone…", () => this.pickAboutTarget(n.id), "small"),
        button("Confront with evidence…", () => this.ctx.confrontWith(""), "small"),
      );
      box.append(acts);

      box.append(el("div", { className: "kicker", text: "Records (60 min)" }));
      const recs = el("div", { className: "actions" });
      recs.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:6px;";
      recs.append(
        button(cf.phoneRecordsPulled.includes(n.id) ? "Phone records ✓" : "Pull phone records", () => {
          this.ctx.runAction(`Pulled phone records for ${fullName(n)}`, () => game.actPullPhone(n.id));
        }, "small"),
        button(cf.financialRecordsPulled.includes(n.id) ? "Financials ✓" : "Pull financial records", () => {
          this.ctx.runAction(`Pulled financial records for ${fullName(n)}`, () => game.actPullFinance(n.id));
        }, "small"),
      );
      if (game.dnaComparisonAvailable()) {
        const alreadyCompared = cf.evidence.some(
          (e) => e.kind === "dna" && e.npcIds.includes(n.id)
        );
        recs.append(
          button(alreadyCompared ? "DNA compared ✓" : "Compare DNA vs. nail sample (6 h)", () => {
            if (!alreadyCompared) {
              this.ctx.runAction(`DNA comparison ordered for ${fullName(n)}`, () => game.actCompareDna(n.id));
            }
          }, "small" + (alreadyCompared ? "" : " primary"))
        );
      }
      box.append(recs);
    } else if (isVictim) {
      const acts = el("div", { className: "actions" });
      const ready = game.world.time >= game.autopsyReadyAt();
      acts.append(
        button(
          cf.autopsyDone ? "Autopsy report ✓ (see Evidence)" : ready ? "Read autopsy report (30 min)" : "Autopsy in progress…",
          () => {
            if (!cf.autopsyDone && ready) this.ctx.runAction("Read the autopsy report", () => game.actAutopsy());
          },
          "small" + (cf.autopsyDone || !ready ? "" : " primary")
        ),
        button(cf.phoneRecordsPulled.includes(n.id) ? "Phone records ✓" : "Pull phone records", () => {
          this.ctx.runAction(`Pulled phone records for ${fullName(n)}`, () => game.actPullPhone(n.id));
        }, "small"),
        button(cf.financialRecordsPulled.includes(n.id) ? "Financials ✓" : "Pull financial records", () => {
          this.ctx.runAction(`Pulled financial records for ${fullName(n)}`, () => game.actPullFinance(n.id));
        }, "small"),
      );
      box.append(el("div", { className: "kicker", text: "The victim" }));
      box.append(acts);
    }

    // What we have on them.
    const about = evidenceAbout(cf, n.id);
    const statements = cf.statements.filter((s) => s.npcId === n.id);
    const contradictions = computeContradictions(cf).filter((c) => c.npcId === n.id);

    if (contradictions.length > 0) {
      box.append(el("div", { className: "kicker", text: "Inconsistencies" }));
      for (const c of contradictions) {
        box.append(el("div", { className: "tl-window", text: c.summary }));
      }
    }

    if (about.length > 0) {
      box.append(el("div", { className: "kicker", text: `Evidence involving them (${about.length})` }));
      for (const e of about.slice(-6).reverse()) {
        const card = el("div", { className: "card clickable" }, [
          el("div", { className: "card-title", text: e.title }),
          el("div", { className: "card-meta", text: fmtTimeLong(e.discoveredAt) }),
        ]);
        card.addEventListener("click", () => this.ctx.switchTab("evidence"));
        box.append(card);
      }
    }

    if (statements.length > 0) {
      box.append(el("div", { className: "kicker", text: "Their statements" }));
      for (const s of statements.slice(-4).reverse()) {
        box.append(
          el("div", { className: "card" }, [
            el("div", { className: "card-meta", text: `${fmtTimeLong(s.t)} — ${s.question}` }),
            el("div", { className: "dialogue", text: `“${s.answer}”` }),
          ])
        );
      }
    }
  }

  private interview(npcId: NpcId, topic: "whereabouts" | "last-saw-victim" | "relationship-victim" | "anything-unusual" | "enemies"): void {
    const { game } = this.ctx;
    const n = game.npc(npcId);
    this.ctx.runAction(`Interviewed ${fullName(n)}`, () => {
      const out = game.actInterview(npcId, topic);
      if (out.statement) this.showStatementModal(fullName(n), out.statement.question, out.statement.answer);
      return out;
    });
  }

  private pickAboutTarget(npcId: NpcId): void {
    const { game } = this.ctx;
    const speaker = game.npc(npcId);
    const body = el("div");
    body.append(el("div", { className: "meta", text: `Who should ${speaker.first} talk about?` }));
    const sel = el("select");
    for (const other of game.world.npcs.filter((o) => o.id !== npcId)) {
      const opt = document.createElement("option");
      opt.value = other.id;
      opt.textContent = fullName(other) + (other.alive ? "" : " (deceased)");
      sel.append(opt);
    }
    sel.style.cssText = "width:100%;margin-top:10px;";
    body.append(sel);
    openModal(`Ask about someone`, body, [
      button("Ask (30 min)", () => {
        closeModal();
        this.ctx.runAction(`Asked ${speaker.first} about someone`, () => {
          const out = game.actInterview(npcId, "about-person", sel.value);
          if (out.statement) this.showStatementModal(fullName(speaker), out.statement.question, out.statement.answer);
          return out;
        });
      }, "primary"),
      button("Cancel", () => closeModal()),
    ]);
  }

  private showStatementModal(name: string, question: string, answer: string): void {
    const body = el("div", {}, [
      el("div", { className: "meta", text: question }),
      el("div", { className: "dialogue", text: `“${answer}”` }),
    ]);
    openModal(name, body);
  }
}
