/**
 * The accusation: pick a suspect and a motive, review the four pillars of
 * the case as they stand in the file, and commit. Irreversible.
 *
 * The pillar checklist is computed ONLY from collected evidence — it tells
 * the player what a prosecutor would see, not what the simulation knows.
 */

import { el, button, clear, openModal, closeModal } from "../components";
import type { UiCtx } from "./types";
import type { MotiveKind, NpcId } from "../../world/types";
import { fullName } from "../../world/types";
import { computeContradictions } from "../../investigation/casefile";
import { MOTIVE_LABELS } from "../../investigation/accusation";

const MOTIVES = Object.entries(MOTIVE_LABELS) as Array<[MotiveKind, string]>;

export class AccusePanel {
  readonly root: HTMLElement;
  private ctx: UiCtx;
  private accusedId: NpcId | null = null;
  private motive: MotiveKind = "revenge";

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
        el("h2", { text: "Make the Accusation" }),
        el("div", { className: "sub", text: "One shot. The prosecutor needs pillars: weapon, placement, motive, a broken story." }),
      ])
    );

    const wrap = el("div", { className: "verdict-wrap" });
    this.root.append(wrap);

    // Suspect select.
    const suspectSel = el("select");
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "— choose a suspect —";
    suspectSel.append(none);
    for (const n of game.world.npcs.filter((x) => x.alive)) {
      const opt = document.createElement("option");
      opt.value = n.id;
      opt.textContent = fullName(n);
      if (n.id === this.accusedId) opt.selected = true;
      suspectSel.append(opt);
    }
    suspectSel.addEventListener("change", () => {
      this.accusedId = suspectSel.value || null;
      this.render();
    });

    const motiveSel = el("select");
    for (const [k, label] of MOTIVES) {
      const opt = document.createElement("option");
      opt.value = k;
      opt.textContent = label;
      if (k === this.motive) opt.selected = true;
      motiveSel.append(opt);
    }
    motiveSel.addEventListener("change", () => {
      this.motive = motiveSel.value as MotiveKind;
    });

    const row = el("div");
    row.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:18px;";
    row.append(
      el("div", {}, [el("div", { className: "kicker", text: "The accused" }), suspectSel]),
      el("div", {}, [el("div", { className: "kicker", text: "The motive" }), motiveSel]),
    );
    suspectSel.style.width = "100%";
    motiveSel.style.width = "100%";
    wrap.append(row);

    // Pillars for the selected suspect.
    if (this.accusedId) {
      const pillars = this.pillarsFor(this.accusedId);
      const box = el("div", { className: "card" });
      box.append(el("div", { className: "kicker", text: "What the file shows" }));
      for (const p of pillars) {
        box.append(
          el("div", { className: `pillar ${p.ok ? "ok" : "no"}` }, [
            el("div", { className: "p-ico", text: p.ok ? "✔" : "○" }),
            el("div", { text: p.label }),
          ])
        );
      }
      wrap.append(box);

      const okCount = pillars.filter((p) => p.ok).length;
      const warn = el("div", { className: "meta" });
      warn.style.cssText = "margin:10px 0;color:var(--text-dim);";
      warn.textContent =
        okCount >= 3 ? "A strong case. The prosecutor will take it." :
        okCount === 2 ? "Borderline. A conviction is possible but not assured." :
        "Thin. Even if you're right, they may walk.";
      wrap.append(warn);

      const accuseBtn = button(`Accuse ${fullName(game.npc(this.accusedId))}`, () => this.confirm(), "primary danger");
      accuseBtn.style.cssText = "width:100%;padding:12px;font-size:15px;";
      wrap.append(accuseBtn);
    } else {
      wrap.append(el("div", { className: "card" }, [
        el("div", { className: "card-body", text: `Interviewed so far: ${cf.interviewed.length}. Evidence collected: ${cf.evidence.length}. Choose a suspect to see how the case holds up.` }),
      ]));
    }
  }

  /** Player-facing mirror of the scoring pillars (collected evidence only). */
  private pillarsFor(accusedId: NpcId): Array<{ label: string; ok: boolean }> {
    const { game } = this.ctx;
    const cf = game.casefile;
    const victimId = cf.victimId;
    const weaponEvidence = cf.evidence.filter((e) => e.itemLink && e.npcIds.includes(accusedId));
    const autopsy = cf.evidence.find((e) => e.kind === "autopsy");
    const wFrom = autopsy?.placesFrom ?? null;
    const wTo = autopsy?.placesTo ?? null;
    const sceneId = game.world.crime?.sceneBuildingId ?? null;
    const placed = cf.evidence.some((e) => {
      if (!e.npcIds.includes(accusedId) || e.placesAtBuildingId === null) return false;
      if (e.placesFrom === null || e.placesTo === null || wFrom === null || wTo === null) return false;
      const overlap = Math.min(e.placesTo, wTo + 90) - Math.max(e.placesFrom, wFrom - 90);
      return overlap > 0 && (e.placesAtBuildingId === sceneId || e.placesAtBuildingId.startsWith("street:"));
    });
    const motive = cf.evidence.some(
      (e) => e.motiveHint && e.npcIds.includes(accusedId) && (e.npcIds.includes(victimId) || e.kind === "financial-records")
    );
    const broken = computeContradictions(cf).some((c) => c.npcId === accusedId);
    return [
      { label: "Physical link to the murder weapon", ok: weaponEvidence.length > 0 },
      { label: "Placed at or near the scene in the death window", ok: placed },
      { label: "Documented motive against the victim", ok: motive },
      { label: "Their account contradicted by evidence", ok: broken },
    ];
  }

  private confirm(): void {
    const { game } = this.ctx;
    if (!this.accusedId) return;
    const accused = game.npc(this.accusedId);
    const body = el("div", {}, [
      el("div", { className: "card-body", text: `You are about to formally accuse ${fullName(accused)} of the murder, naming ${MOTIVE_LABELS[this.motive]} as the motive. There is no taking this back.` }),
    ]);
    openModal("Commit to the accusation?", body, [
      button("Accuse", () => {
        closeModal();
        game.actAccuse(this.accusedId!, this.motive);
        this.ctx.refresh();
      }, "danger"),
      button("Not yet", () => closeModal()),
    ]);
  }
}
