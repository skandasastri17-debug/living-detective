/**
 * Cinematic findings presentations.
 *
 * A search or a camera pull already collects real evidence via the honest
 * investigation actions (searchBuilding / pullCameraLogs) — these modals are
 * a presentation layer only: a staggered "evidence sweep" reveal for
 * searches and scene work, and a CCTV-monitor-styled log for camera footage.
 * Nothing here invents a clue; the camera reveal re-reads world.cameraLog —
 * the exact same source pullCameraLogs already queried — purely to lay the
 * full log out as rows instead of one joined string.
 */

import { el, button, tag, openModal, closeModal } from "./components";
import { EVIDENCE_KIND_LABELS, EVIDENCE_KIND_TAGS } from "./evidenceKinds";
import type { EvidenceEntry } from "../investigation/casefile";
import type { BuildingId, World } from "../world/types";
import { buildingById, fullName } from "../world/types";
import { fmtTime } from "../core/time";

/** Staggered "evidence sweep" reveal shared by scene work and building searches. */
export function showFindingsReveal(heading: string, subject: string, evidence: EvidenceEntry[]): void {
  const body = el("div");
  body.append(el("div", { className: "sweep-bar" }));

  const list = el("div");
  body.append(list);

  if (evidence.length === 0) {
    list.append(el("div", { className: "finding-empty", text: "Nothing further came of it." }));
  } else {
    evidence.forEach((e, i) => {
      const card = el("div", { className: "card finding-card" });
      card.style.animationDelay = `${i * 90}ms`;
      card.append(
        el("div", { className: "card-title" }, [
          tag(EVIDENCE_KIND_LABELS[e.kind], EVIDENCE_KIND_TAGS[e.kind] ?? ""),
          el("span", { text: e.title }),
        ]),
        el("div", { className: "card-body", text: e.detail })
      );
      list.append(card);
    });
  }

  const count = evidence.length;
  openModal(
    `${heading}: ${subject}`,
    body,
    [button(`Close${count ? ` (${count} finding${count === 1 ? "" : "s"})` : ""}`, () => closeModal(), "primary")],
    "reveal-modal"
  );
}

/** CCTV-monitor-styled camera footage review, with murder-window hits flagged. */
export function showCameraReveal(world: World, buildingId: BuildingId, evidenceFromPull: EvidenceEntry[]): void {
  const b = buildingById(world, buildingId);
  const body = el("div");
  const header = el("div", { className: "cctv-header" }, [
    el("span", { className: "cctv-rec-dot" }),
    el("span", { text: `CAM · ${b.name.toUpperCase()}` }),
  ]);
  const frame = el("div", { className: "cctv-frame" }, [header]);
  body.append(frame);

  if (!b.hasCamera) {
    frame.append(
      el("div", { className: "cctv-nosignal" }, [
        el("div", { className: "cctv-static" }),
        el("div", { text: "NO SIGNAL — no camera coverage at this location" }),
      ])
    );
    openModal(`Camera check: ${b.name}`, body, [button("Close", () => closeModal(), "primary")], "reveal-modal");
    return;
  }

  // Same source pullCameraLogs already read; this only re-lays it out as rows.
  const entries = world.cameraLog.filter((e) => e.buildingId === buildingId).slice(-60);
  const hitKeys = new Set(
    evidenceFromPull
      .filter((e): e is EvidenceEntry & { placesFrom: number } => e.kind === "camera-log" && e.placesAtBuildingId !== null && e.placesFrom !== null && e.npcIds.length > 0)
      .map((e) => `${e.npcIds[0]}@${e.placesFrom + 10}`)
  );

  const log = el("div", { className: "cctv-log" });
  frame.append(log);
  if (entries.length === 0) {
    log.append(el("div", { text: "No entries in the retention window." }));
  } else {
    entries.forEach((entry, i) => {
      const n = world.npcs.find((x) => x.id === entry.npcId);
      const flagged = hitKeys.has(`${entry.npcId}@${entry.t}`);
      const row = el("div", { className: `cctv-row${flagged ? " flagged" : ""}` }, [
        el("span", { className: "cctv-time", text: fmtTime(entry.t) }),
        el("span", { className: "cctv-dir", text: entry.direction === "in" ? "ENTERS" : "EXITS" }),
        el("span", { className: "cctv-name", text: n ? fullName(n) : "unidentified" }),
        flagged ? tag("near time of death", "danger") : null,
      ]);
      row.style.animationDelay = `${Math.min(i, 40) * 55}ms`;
      log.append(row);
    });
  }

  const flaggedCount = new Set([...hitKeys]).size;
  openModal(
    `Camera footage: ${b.name}`,
    body,
    [button(`Close${flaggedCount ? ` (${flaggedCount} flagged)` : ""}`, () => closeModal(), "primary")],
    "reveal-modal"
  );
}
