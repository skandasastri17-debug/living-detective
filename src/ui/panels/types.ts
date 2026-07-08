/** Shared UI context passed to every panel. */

import type { ActionOutcome, Game } from "../../game/director";
import type { AudioDirector } from "../audio";
import type { NpcId } from "../../world/types";

export type TabId = "map" | "evidence" | "suspects" | "statements" | "timeline" | "relations" | "notes" | "accuse";

export interface UiCtx {
  game: Game;
  audio: AudioDirector;
  /** Re-render the active panel and the top bar (after any action). */
  refresh(): void;
  switchTab(tab: TabId): void;
  /** Jump to the suspects panel focused on a person. */
  openSuspect(id: NpcId): void;
  /** Begin the confront flow for a piece of evidence. */
  confrontWith(evidenceId: string): void;
  /**
   * Wrap a game action: runs it, refreshes, and reports the outcome.
   * With no `present` callback the outcome is toasted as text; pass one to
   * show a richer presentation instead (e.g. the search/camera reveals).
   */
  runAction(label: string, fn: () => ActionOutcome | void, present?: (out: ActionOutcome) => void): void;
  selectedBuildingId: string | null;
  selectedSuspectId: NpcId | null;
}
