/**
 * The game director: builds a world, lets it live, waits for a murder to
 * emerge, and then runs the investigation loop.
 *
 * The simulation keeps running while the player investigates — witnesses'
 * memories decay, gossip spreads, people go about their week. Time is the
 * player's real adversary.
 */

import { Rng, randomSeedPhrase, seedFromPhrase } from "../core/rng";
import { EventBus } from "../core/events";
import { log } from "../core/log";
import { MINUTES_PER_DAY, TICK_MINUTES, at, dayOf, fmtTimeLong, type SimTime } from "../core/time";
import { generateCity, roadPath } from "../world/citygen";
import { assignItemOwnership, generatePopulation } from "../world/npcgen";
import type { BuildingId, MotiveKind, Npc, NpcId, World } from "../world/types";
import { buildingById, fullName } from "../world/types";
import { SimEngine } from "../sim/engine";
import { planCrime, motiveThresholdForDay } from "../crime/planner";
import { CrimeExecutor } from "../crime/executor";
import { CoverupDirector } from "../crime/coverup";
import { DEFAULT_DIFFICULTY, DIFFICULTIES, type DifficultyId } from "../world/difficulty";
import {
  computeContradictions, newCaseFile,
  type AccusationResult, type CaseFile, type EvidenceEntry, type Statement,
} from "../investigation/casefile";
import {
  compareDna, examineScene, pullCameraLogs, pullFinancialRecords, pullPhoneRecords,
  readAutopsy, searchBuilding,
} from "../investigation/actions";
import {
  askAboutPerson, askAnythingUnusual, askLastSawVictim,
  askRelationshipWithVictim, askWhereabouts, askWhoHadTrouble, confront,
} from "../investigation/interview";
import { evaluateAccusation } from "../investigation/accusation";

export type GamePhase = "menu" | "generating" | "briefing" | "investigating" | "verdict";

export interface GameEvents extends Record<string, unknown> {
  "game:phase": { phase: GamePhase };
  "game:time": { t: SimTime };
  "case:updated": Record<string, never>;
  "game:toast": { text: string };
}

export interface ActionOutcome {
  minutes: number;
  evidence?: EvidenceEntry[];
  statement?: Statement;
  note?: string;
}

const PLAYER_SPEED = 14; // road cells per tick-equivalent
export const WARRANT_COST_MIN = 120;

export class Game {
  world: World;
  engine: SimEngine;
  casefile: CaseFile;
  phase: GamePhase = "investigating";
  readonly bus = new EventBus<GameEvents>();
  private executor: CrimeExecutor | null = null;
  private coverup: CoverupDirector;

  private constructor(world: World, engine: SimEngine, casefile: CaseFile, executor: CrimeExecutor | null) {
    this.world = world;
    this.engine = engine;
    this.casefile = casefile;
    this.executor = executor;
    this.coverup = new CoverupDirector(world);
  }

  // ------------------------------------------------------------- generation

  /**
   * Build a world and simulate until a murder has occurred and been
   * discovered. Async so the UI can show progress between simulated days.
   */
  static async generate(
    seedPhrase: string | null,
    difficulty: DifficultyId = DEFAULT_DIFFICULTY,
    onProgress: (label: string, frac: number) => void = () => {}
  ): Promise<Game> {
    const phrase = seedPhrase && seedPhrase.trim() !== "" ? seedPhrase.trim() : randomSeedPhrase();
    const seed = seedFromPhrase(phrase);
    const rng = new Rng(seed);
    const diff = DIFFICULTIES[difficulty];
    log.info("director", `Generating world from seed "${phrase}" (${seed}), difficulty ${difficulty}`);

    onProgress("Surveying the land…", 0.05);
    await yieldFrame();
    const cityRes = generateCity(rng, { cameraChanceMul: diff.cameraChanceMul, extraHouses: diff.extraHouses });

    onProgress("Moving people in…", 0.15);
    await yieldFrame();
    const popRes = generatePopulation(rng, cityRes.city.buildings, cityRes.nextItemId);

    const world: World = {
      seedPhrase: phrase,
      seed,
      difficulty,
      cityName: cityRes.city.name,
      city: cityRes.city,
      npcs: popRes.npcs,
      items: { ...cityRes.items, ...popRes.items },
      secrets: popRes.secrets,
      eventLog: [],
      phoneLog: [],
      transactions: [],
      cameraLog: [],
      time: 0,
      crime: null,
      scene: null,
      nextIds: {
        npc: popRes.nextNpcId, building: cityRes.nextBuildingId, room: cityRes.nextRoomId,
        item: popRes.nextItemId, event: 0, secret: popRes.nextSecretId,
      },
    };
    // Householders own what's in their homes; owners own their venues' stock.
    assignItemOwnership(world.city.buildings, world.npcs, world.items);
    // Sanity: every possession referenced by an NPC must exist in the table.
    for (const n of world.npcs) {
      for (const iid of n.inventoryIds) {
        if (!world.items[iid]) throw new Error(`npcgen item ${iid} missing from world`);
      }
    }

    const engine = new SimEngine(world);

    // Let the city live for five days. Simulate in 6-hour slices with real
    // yields so the browser main thread never blocks long enough to look
    // unresponsive.
    for (let day = 0; day < 5; day++) {
      onProgress(`The city lives — day ${day + 1} of its week…`, 0.2 + day * 0.09);
      for (let quarter = 1; quarter <= 4; quarter++) {
        engine.runUntil(at(day, 0) + quarter * 6 * 60);
        await yieldFrame();
      }
    }

    // From day 6, look for a murder to emerge; keep simulating until it does.
    let executor: CrimeExecutor | null = null;
    let attempt = 0;
    let guard = 0;
    const maxIterations = 12 * MINUTES_PER_DAY / TICK_MINUTES; // hard stop: 12 sim-days of stepping
    while (!world.crime || !executor || !executor.discovered) {
      if (++guard > maxIterations) {
        throw new Error(`Generation stalled after ${guard} steps (crime=${world.crime !== null}, discovered=${executor?.discovered ?? false}) — seed rejected`);
      }
      if (!executor || executor.status === "failed") {
        const day = dayOf(world.time);
        if (day > 14) throw new Error("No viable murder emerged by day 14 — seed rejected");
        onProgress("Tensions are rising…", 0.68 + Math.min(0.2, attempt * 0.04));
        await yieldFrame();
        const plan = planCrime(engine, rng.stream(`attempt:${attempt}`), motiveThresholdForDay(day));
        attempt++;
        if (plan) {
          executor = new CrimeExecutor(plan, seed);
        } else {
          engine.runUntil(world.time + 6 * 60); // let pressure build
          continue;
        }
      }
      const stepTo = world.time + TICK_MINUTES;
      engine.runUntil(stepTo);
      executor.step(engine);
      // Breathe every simulated hour so the tab stays responsive.
      if (guard % 6 === 0) await yieldFrame();
    }

    onProgress("A body has been found.", 0.95);
    await yieldFrame();
    // Give the town two hours to absorb the news before the detective arrives.
    engine.runUntil(world.time + 120, () => executor?.step(engine));

    const crime = world.crime!;
    const start = world.city.buildings.find((b) => b.type === "police-station") ?? world.city.buildings[0]!;
    const casefile = newCaseFile(world, crime.victimId, start.id);
    const game = new Game(world, engine, casefile, executor);
    log.info("director", `Case opened at ${fmtTimeLong(world.time)} — victim ${fullName(world.npcs.find((n) => n.id === crime.victimId)!)}`);
    return game;
  }

  static fromLoaded(world: World, casefile: CaseFile, phase: GamePhase): Game {
    // Saves from before newer case-file fields load with sane defaults.
    casefile.relationFacts ??= [];
    casefile.openedUp ??= [];
    const engine = new SimEngine(world);
    const g = new Game(world, engine, casefile, null);
    g.phase = phase;
    return g;
  }

  // ------------------------------------------------------------ time & travel

  /** Advance world time; the city keeps living underneath the investigation. */
  advance(minutes: number): void {
    const target = this.world.time + Math.max(TICK_MINUTES, Math.round(minutes / TICK_MINUTES) * TICK_MINUTES);
    this.engine.runUntil(target, () => {
      this.executor?.step(this.engine);
      // The killer keeps thinking too.
      this.coverup.step(this.engine);
    });
    this.bus.emit("game:time", { t: this.world.time });
  }

  /**
   * Word travels in a small town: actions that touch the killer raise the
   * pressure they feel (interviews are face to face; record pulls and home
   * searches get talked about).
   */
  private feelPressure(touchedNpcId: NpcId | null, source: Parameters<CoverupDirector["notePressure"]>[0]): void {
    const crime = this.world.crime;
    if (crime && touchedNpcId === crime.killerId) this.coverup.notePressure(source);
  }

  travelMinutes(toBuildingId: BuildingId): number {
    const from = buildingById(this.world, this.casefile.detectiveAt);
    const to = buildingById(this.world, toBuildingId);
    if (from.id === to.id) return 0;
    const path = roadPath(this.world.city, from.door, to.door);
    return Math.max(10, Math.ceil(path.length / PLAYER_SPEED) * TICK_MINUTES);
  }

  travelTo(buildingId: BuildingId): ActionOutcome {
    const minutes = this.travelMinutes(buildingId);
    this.casefile.detectiveAt = buildingId;
    this.advance(minutes || TICK_MINUTES);
    this.bus.emit("case:updated", {});
    return { minutes };
  }

  /** Where an NPC can be found right now (public knowledge in a small town). */
  locateNpc(npcId: NpcId): BuildingId {
    const npc = this.npc(npcId);
    if (npc.position.kind === "building") return npc.position.buildingId;
    return npc.position.toBuildingId;
  }

  npc(id: NpcId): Npc {
    const n = this.world.npcs.find((x) => x.id === id);
    if (!n) throw new Error(`No NPC ${id}`);
    return n;
  }

  // ---------------------------------------------------------------- actions

  actExamineScene(): ActionOutcome {
    const scene = this.world.scene!;
    if (this.casefile.detectiveAt !== scene.buildingId) {
      const t = this.travelTo(scene.buildingId);
      void t;
    }
    const evidence = examineScene(this.world, this.casefile);
    this.advance(60);
    this.bus.emit("case:updated", {});
    return { minutes: 60, evidence };
  }

  needsWarrant(buildingId: BuildingId): boolean {
    const b = buildingById(this.world, buildingId);
    const isHome = b.type === "house" || b.type === "apartment";
    const isScene = this.world.crime?.sceneBuildingId === buildingId;
    const victimHome = this.npc(this.casefile.victimId).homeId === buildingId;
    return isHome && !isScene && !victimHome && !this.casefile.warrants.includes(buildingId);
  }

  actObtainWarrant(buildingId: BuildingId): ActionOutcome {
    if (!this.casefile.warrants.includes(buildingId)) this.casefile.warrants.push(buildingId);
    this.advance(WARRANT_COST_MIN);
    this.bus.emit("case:updated", {});
    return { minutes: WARRANT_COST_MIN, note: `Warrant issued for ${buildingById(this.world, buildingId).name}.` };
  }

  actSearch(buildingId: BuildingId): ActionOutcome {
    if (this.needsWarrant(buildingId)) throw new Error("Warrant required");
    if (this.casefile.detectiveAt !== buildingId) this.travelTo(buildingId);
    const evidence = searchBuilding(this.world, this.casefile, buildingId);
    const crime = this.world.crime;
    if (crime && this.npc(crime.killerId).homeId === buildingId) {
      this.feelPressure(crime.killerId, "home-searched");
    }
    this.advance(90);
    this.bus.emit("case:updated", {});
    return { minutes: 90, evidence };
  }

  autopsyReadyAt(): SimTime {
    return (this.world.crime?.discoveryTime ?? 0) + 4 * 60;
  }

  actAutopsy(): ActionOutcome {
    if (this.world.time < this.autopsyReadyAt()) throw new Error("Autopsy not ready yet");
    const e = readAutopsy(this.world, this.casefile);
    this.advance(30);
    this.bus.emit("case:updated", {});
    return { minutes: 30, evidence: [e] };
  }

  /** Is a DNA comparison possible at all (material recovered + autopsy read)? */
  dnaComparisonAvailable(): boolean {
    return this.casefile.autopsyDone && this.world.scene?.struggleDnaOfNpcId != null;
  }

  actCompareDna(npcId: NpcId): ActionOutcome {
    const e = compareDna(this.world, this.casefile, npcId);
    // The lab takes half a day; word of a DNA request travels.
    this.feelPressure(npcId, "records-pulled");
    this.advance(6 * 60);
    this.bus.emit("case:updated", {});
    return { minutes: 6 * 60, evidence: [e] };
  }

  actPullPhone(npcId: NpcId): ActionOutcome {
    const e = pullPhoneRecords(this.world, this.casefile, npcId);
    this.feelPressure(npcId, "records-pulled");
    this.advance(60);
    this.bus.emit("case:updated", {});
    return { minutes: 60, evidence: [e] };
  }

  actPullFinance(npcId: NpcId): ActionOutcome {
    const e = pullFinancialRecords(this.world, this.casefile, npcId);
    this.feelPressure(npcId, "records-pulled");
    this.advance(60);
    this.bus.emit("case:updated", {});
    return { minutes: 60, evidence: [e] };
  }

  actPullCamera(buildingId: BuildingId): ActionOutcome {
    const evidence = pullCameraLogs(this.world, this.casefile, buildingId);
    this.advance(60);
    this.bus.emit("case:updated", {});
    return { minutes: 60, evidence };
  }

  actInterview(
    npcId: NpcId,
    topic: "whereabouts" | "last-saw-victim" | "relationship-victim" | "anything-unusual" | "about-person" | "enemies",
    aboutId?: NpcId
  ): ActionOutcome {
    const npc = this.npc(npcId);
    if (!npc.alive) throw new Error("You can't interview the dead");
    // Go to them.
    const where = this.locateNpc(npcId);
    let minutes = 0;
    if (this.casefile.detectiveAt !== where) {
      minutes += this.travelTo(where).minutes;
    }
    const cf = this.casefile;
    const crime = this.world.crime!;
    let statement: Statement;
    switch (topic) {
      case "whereabouts": {
        const from = crime.murderTime - 150;
        const to = crime.murderTime + 90;
        statement = askWhereabouts(this.world, cf, npc, from, to);
        break;
      }
      case "last-saw-victim":
        statement = askLastSawVictim(this.world, cf, npc);
        break;
      case "relationship-victim":
        statement = askRelationshipWithVictim(this.world, cf, npc);
        break;
      case "anything-unusual":
        statement = askAnythingUnusual(this.world, cf, npc);
        break;
      case "about-person":
        if (!aboutId) throw new Error("about-person needs a subject");
        statement = askAboutPerson(this.world, cf, npc, aboutId);
        break;
      case "enemies":
        statement = askWhoHadTrouble(this.world, cf, npc);
        break;
    }
    if (!cf.interviewed.includes(npcId)) cf.interviewed.push(npcId);
    this.feelPressure(npcId, "interviewed");
    this.advance(30);
    minutes += 30;
    this.bus.emit("case:updated", {});
    return { minutes, statement };
  }

  actConfront(npcId: NpcId, evidenceId: string): ActionOutcome {
    const npc = this.npc(npcId);
    const evidence = this.casefile.evidence.find((e) => e.id === evidenceId);
    if (!evidence) throw new Error("Unknown evidence");
    const where = this.locateNpc(npcId);
    let minutes = 0;
    if (this.casefile.detectiveAt !== where) minutes += this.travelTo(where).minutes;
    const statement = confront(this.world, this.casefile, npc, evidence);
    if (!this.casefile.interviewed.includes(npcId)) this.casefile.interviewed.push(npcId);
    this.feelPressure(npcId, "confronted");
    if (computeContradictions(this.casefile).some((c) => c.npcId === npcId)) {
      this.feelPressure(npcId, "contradicted");
    }
    this.advance(30);
    minutes += 30;
    this.bus.emit("case:updated", {});
    return { minutes, statement };
  }

  actAccuse(npcId: NpcId, motive: MotiveKind): AccusationResult {
    const result = evaluateAccusation(this.world, this.casefile, npcId, motive);
    this.phase = "verdict";
    this.bus.emit("game:phase", { phase: this.phase });
    this.bus.emit("case:updated", {});
    return result;
  }
}

/**
 * Yield the main thread between generation slices. Uses MessageChannel
 * rather than setTimeout: background tabs throttle timers to ≥1s, which
 * would stretch generation into minutes, while port messages run at full
 * speed and still let the event loop breathe.
 */
function yieldFrame(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(null);
  });
}
