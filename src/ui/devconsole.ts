/**
 * Developer console overlay (` to toggle).
 *
 * Streams the log ring buffer and accepts debug commands. The "reveal"
 * command spoils the case on purpose — it is the developer's window into
 * the simulation truth for debugging emergent cases.
 */

import { log, type LogEntry } from "../core/log";
import { fmtTimeLong } from "../core/time";
import { el } from "./components";
import type { Game } from "../game/director";
import { fullName, buildingById } from "../world/types";

export class DevConsole {
  private root: HTMLElement | null = null;
  private logPane: HTMLElement | null = null;
  private unsub: (() => void) | null = null;
  private getGame: () => Game | null;
  private hud: HTMLElement | null = null;
  private hudTimer: number | null = null;

  constructor(getGame: () => Game | null) {
    this.getGame = getGame;
  }

  /** Small always-on-top performance overlay. Returns new on/off state. */
  toggleHud(): boolean {
    if (this.hud) {
      if (this.hudTimer !== null) clearInterval(this.hudTimer);
      this.hudTimer = null;
      this.hud.remove();
      this.hud = null;
      return false;
    }
    this.hud = el("div", { className: "perf-hud" });
    document.body.append(this.hud);
    const update = () => {
      const game = this.getGame();
      if (!game || !this.hud) return;
      const p = game.engine.perfStats();
      const memories = game.world.npcs.reduce((s, n) => s + n.memories.length, 0);
      this.hud.textContent =
        `tick avg ${p.avgMs.toFixed(2)}ms · max ${p.maxMs.toFixed(1)}ms · ` +
        `events ${game.world.eventLog.length} · memories ${memories} · ` +
        `evidence ${game.casefile.evidence.length}`;
    };
    update();
    this.hudTimer = window.setInterval(update, 1000);
    return true;
  }

  toggle(): void {
    if (this.root) this.close();
    else this.open();
  }

  get isOpen(): boolean {
    return this.root !== null;
  }

  private open(): void {
    const logPane = el("div", { className: "dc-log" });
    const input = el("input", { type: "text", placeholder: "command… (help)" });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const cmd = input.value.trim();
        input.value = "";
        if (cmd) this.run(cmd);
      }
      e.stopPropagation();
    });
    this.root = el("div", { className: "dev-console" }, [logPane, input]);
    this.logPane = logPane;
    document.body.append(this.root);

    for (const entry of log.buffer.slice(-300)) this.append(entry);
    this.unsub = log.onEntry((entry) => this.append(entry));
    input.focus();
  }

  private close(): void {
    this.unsub?.();
    this.unsub = null;
    this.root?.remove();
    this.root = null;
    this.logPane = null;
  }

  private append(entry: LogEntry): void {
    if (!this.logPane) return;
    const line = el("div", {
      className: `dc-line ${entry.level}`,
      text: `[${entry.tag}] ${entry.message}`,
    });
    this.logPane.append(line);
    // Cap DOM size.
    while (this.logPane.childElementCount > 500) this.logPane.firstElementChild?.remove();
    this.logPane.scrollTop = this.logPane.scrollHeight;
  }

  private print(msg: string, level: "info" | "warn" | "error" = "info"): void {
    log[level]("console", msg);
  }

  private run(cmd: string): void {
    const game = this.getGame();
    const [verb, ...rest] = cmd.split(/\s+/);
    const arg = rest.join(" ").toLowerCase();
    switch ((verb ?? "").toLowerCase()) {
      case "help":
        this.print("commands: help | seed | time | stats | perf | hud | reveal | events <name fragment> | where <name fragment>");
        break;
      case "perf": {
        if (!game) { this.print("no active game"); break; }
        const p = game.engine.perfStats();
        this.print(`sim ticks sampled=${p.ticks} avg=${p.avgMs.toFixed(2)}ms max=${p.maxMs.toFixed(2)}ms; events=${game.world.eventLog.length}`);
        break;
      }
      case "hud":
        this.print(this.toggleHud() ? "perf HUD on" : "perf HUD off");
        break;
      case "seed":
        this.print(game ? `seed phrase: "${game.world.seedPhrase}" (${game.world.seed})` : "no active game");
        break;
      case "time":
        this.print(game ? fmtTimeLong(game.world.time) : "no active game");
        break;
      case "stats": {
        if (!game) { this.print("no active game"); break; }
        const w = game.world;
        this.print(
          `npcs=${w.npcs.length} buildings=${w.city.buildings.length} items=${Object.keys(w.items).length} ` +
          `events=${w.eventLog.length} calls=${w.phoneLog.length} txns=${w.transactions.length} camera=${w.cameraLog.length} ` +
          `memories=${w.npcs.reduce((s, n) => s + n.memories.length, 0)}`
        );
        break;
      }
      case "reveal": {
        if (!game?.world.crime) { this.print("no crime yet"); break; }
        const c = game.world.crime;
        const killer = game.npc(c.killerId);
        const victim = game.npc(c.victimId);
        this.print(`SPOILER: ${fullName(killer)} killed ${fullName(victim)} (${c.motive}) at ${fmtTimeLong(c.murderTime)} in ${buildingById(game.world, c.sceneBuildingId).name}`, "warn");
        this.print(`SPOILER: ${c.motiveSummary}; disposal=${c.weaponDisposal}; gloves=${c.woreGloves}; alibi="${c.alibiClaim}"`, "warn");
        break;
      }
      case "events": {
        if (!game) { this.print("no active game"); break; }
        if (!arg) { this.print("usage: events <name fragment>"); break; }
        const matches = game.world.eventLog.filter((e) => e.summary.toLowerCase().includes(arg)).slice(-25);
        if (matches.length === 0) this.print("no matching events");
        for (const e of matches) this.print(`${fmtTimeLong(e.t)} — ${e.summary}`);
        break;
      }
      case "where": {
        if (!game) { this.print("no active game"); break; }
        const npc = game.world.npcs.find((n) => fullName(n).toLowerCase().includes(arg));
        if (!npc) { this.print("no such NPC"); break; }
        const pos = npc.position.kind === "building"
          ? buildingById(game.world, npc.position.buildingId).name
          : `on the street, heading to ${buildingById(game.world, npc.position.toBuildingId).name}`;
        this.print(`${fullName(npc)}: ${pos} (${npc.activity}${npc.alive ? "" : ", DECEASED"})`);
        break;
      }
      default:
        this.print(`unknown command "${verb}" — try help`, "warn");
    }
  }
}
