/**
 * Map panel: the city, plus a context pane for the selected building with
 * every location-bound action (travel, search, warrants, cameras, people
 * present).
 */

import { el, button, tag, clear } from "../components";
import { MapView, TYPE_LABELS } from "../mapview";
import type { UiCtx } from "./types";
import { buildingById, fullName, occupantsOf } from "../../world/types";
import { WARRANT_COST_MIN } from "../../game/director";
import { showCameraReveal, showFindingsReveal } from "../reveal";

export class MapPanel {
  readonly root: HTMLElement;
  private mapView: MapView;
  private contextPane: HTMLElement;
  private ctx: UiCtx;

  constructor(ctx: UiCtx) {
    this.ctx = ctx;
    this.contextPane = el("div", { className: "context-pane" });
    this.mapView = new MapView({
      onSelect: (id) => {
        this.ctx.selectedBuildingId = id;
        this.renderContext();
      },
    });
    this.root = el("div", { className: "layout map-layout" }, [this.mapView.root, this.contextPane]);
    this.root.style.flex = "1";
    this.root.style.minHeight = "0";
  }

  render(): void {
    const { game } = this.ctx;
    this.mapView.update(
      game.world,
      game.casefile.detectiveAt,
      game.world.crime?.sceneBuildingId ?? null,
      this.ctx.selectedBuildingId
    );
    this.renderContext();
  }

  destroy(): void {
    this.mapView.destroy();
  }

  private renderContext(): void {
    const { game } = this.ctx;
    const pane = this.contextPane;
    clear(pane);
    const id = this.ctx.selectedBuildingId;
    if (!id) {
      pane.append(
        el("div", { className: "kicker", text: "The City" }),
        el("h3", { text: game.world.cityName }),
        el("div", { className: "meta", text: "Click a building to inspect it. Amber dot marks your position; red outline marks the crime scene. Blue pips mark camera coverage." })
      );
      return;
    }
    const b = buildingById(game.world, id);
    const here = game.casefile.detectiveAt === id;
    const isScene = game.world.crime?.sceneBuildingId === id;
    const travelCost = game.travelMinutes(id);

    pane.append(
      el("div", { className: "kicker", text: TYPE_LABELS[b.type] }),
      el("h3", { text: b.name }),
    );
    const tags = el("div", {}, []);
    tags.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;";
    if (isScene) tags.append(tag("Crime scene", "danger"));
    if (b.hasCamera) tags.append(tag("Camera", "info"));
    if (here) tags.append(tag("You are here", "accent"));
    if (game.casefile.searchedBuildings.includes(id)) tags.append(tag("Searched", "success"));
    pane.append(tags);

    // Ownership / occupants — general knowledge in a small town.
    const owner = b.ownerId ? game.world.npcs.find((n) => n.id === b.ownerId) : null;
    const meta: string[] = [];
    if (owner) meta.push(`${b.type === "house" || b.type === "apartment" ? "Owner" : "Run by"}: ${fullName(owner)}`);
    if (b.residentIds.length > 0) {
      meta.push(`Residents: ${b.residentIds.map((rid) => fullName(game.npc(rid))).join(", ")}`);
    }
    if (b.employeeIds.length > 0) {
      meta.push(`Staff: ${b.employeeIds.map((eid) => fullName(game.npc(eid))).join(", ")}`);
    }
    pane.append(el("div", { className: "meta", text: meta.join("\n") }));

    const actions = el("div", { className: "actions" });
    if (!here) {
      actions.append(button(`Travel here (~${travelCost} min)`, () => {
        this.ctx.runAction(`Travelled to ${b.name}`, () => this.ctx.game.travelTo(id));
      }, "primary"));
    }
    if (isScene && game.world.scene) {
      actions.append(button("Examine crime scene (60 min)", () => {
        this.ctx.runAction(
          "Examined the crime scene",
          () => this.ctx.game.actExamineScene(),
          (out) => showFindingsReveal("Crime Scene", b.name, out.evidence ?? [])
        );
      }, "primary"));
    }
    if (game.needsWarrant(id)) {
      actions.append(button(`Obtain search warrant (${WARRANT_COST_MIN} min)`, () => {
        this.ctx.runAction(`Warrant obtained for ${b.name}`, () => this.ctx.game.actObtainWarrant(id));
      }));
    } else {
      actions.append(button("Search building (90 min)", () => {
        this.ctx.runAction(
          `Searched ${b.name}`,
          () => this.ctx.game.actSearch(id),
          (out) => showFindingsReveal("Search", b.name, out.evidence ?? [])
        );
      }));
    }
    actions.append(button(`Pull camera records (60 min)`, () => {
      this.ctx.runAction(
        `Requested camera records from ${b.name}`,
        () => this.ctx.game.actPullCamera(id),
        (out) => showCameraReveal(this.ctx.game.world, id, out.evidence ?? [])
      );
    }));
    pane.append(actions);

    // Who is physically here right now (only visible when present).
    if (here) {
      pane.append(el("div", { className: "kicker", text: "Present now" }));
      const people = occupantsOf(game.world, id);
      if (people.length === 0) {
        pane.append(el("div", { className: "meta", text: "Nobody here at the moment." }));
      }
      for (const n of people) {
        const row = el("div", { className: "occupant" }, [
          el("span", { text: fullName(n) }),
          button("Talk", () => this.ctx.openSuspect(n.id), "small"),
        ]);
        pane.append(row);
      }
    }
  }
}
