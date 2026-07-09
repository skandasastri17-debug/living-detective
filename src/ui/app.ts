/**
 * Application shell: screens (menu → generating → investigation → verdict),
 * top bar, tab rail, keyboard shortcuts, autosave, audio hookup, and the
 * shared UI context handed to panels.
 */

import { el, button, clear, openModal, closeModal, isModalOpen, toast } from "./components";
import { AudioDirector } from "./audio";
import { DevConsole } from "./devconsole";
import { GamepadNav } from "./gamepad";
import { MapPanel } from "./panels/mapPanel";
import { EvidencePanel } from "./panels/evidencePanel";
import { SuspectsPanel } from "./panels/suspectsPanel";
import { StatementsPanel } from "./panels/statementsPanel";
import { TimelinePanel } from "./panels/timelinePanel";
import { RelationsPanel } from "./panels/relationsPanel";
import { AccusePanel } from "./panels/accusePanel";
import type { TabId, UiCtx } from "./panels/types";
import { Game, type ActionOutcome } from "../game/director";
import { AUTOSAVE_SLOT, SLOTS, listSaves, loadGame, migrateLegacySaves, saveGame, wipeProfile } from "../game/save";
import { GUEST_PROFILE, activeProfile, currentProfileKey, reconcileSessionOnBoot, signIn, signOut } from "../game/profile";
import { fmtTimeLong } from "../core/time";
import { fullName, buildingById } from "../world/types";
import { DEFAULT_DIFFICULTY, DIFFICULTIES, type DifficultyId } from "../world/difficulty";
import { loadSettings, updateSettings } from "./settings";
import { log } from "../core/log";
import { computeContradictions } from "../investigation/casefile";

const TABS: Array<{ id: TabId; label: string; key: string }> = [
  { id: "map", label: "City Map", key: "1" },
  { id: "evidence", label: "Evidence", key: "2" },
  { id: "suspects", label: "People", key: "3" },
  { id: "statements", label: "Statements", key: "4" },
  { id: "timeline", label: "Timeline", key: "5" },
  { id: "relations", label: "Relations", key: "6" },
  { id: "notes", label: "Notebook", key: "7" },
  { id: "accuse", label: "Accuse", key: "8" },
];

export class App {
  private root: HTMLElement;
  private game: Game | null = null;
  private audio = new AudioDirector();
  private devConsole = new DevConsole(() => this.game);
  private tab: TabId = "map";
  private uiCtx: UiCtx | null = null;
  private panels: Partial<Record<TabId, { root: HTMLElement; render(): void }>> = {};
  private clockEl: HTMLElement | null = null;
  private locEl: HTMLElement | null = null;
  private panelHost: HTMLElement | null = null;
  private mapPanel: MapPanel | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    // Dev-only QA hook: lets automated tests and the console reach the live
    // game (stripped from production by the DEV guard).
    if (import.meta.env.DEV) {
      Object.defineProperty(window, "__LD", { get: () => this.game, configurable: true });
    }
    window.addEventListener("keydown", (e) => this.onKey(e));
    // Audio can only start from a user gesture; honor the auto-start setting
    // on the first click anywhere.
    const startAudioOnce = () => {
      if (loadSettings().audioAutoStart && !this.audio.isEnabled) this.audio.toggle();
      window.removeEventListener("pointerdown", startAudioOnce);
    };
    window.addEventListener("pointerdown", startAudioOnce);
    // Controller: cycles panels with the bumpers, navigates with d-pad/stick.
    new GamepadNav((dir) => {
      if (!this.game || this.game.phase === "verdict") return;
      const idx = TABS.findIndex((t) => t.id === this.tab);
      const next = TABS[(idx + dir + TABS.length) % TABS.length]!;
      this.switchTab(next.id);
    });

    // One-time migration from the pre-profile save format, then decide
    // whether this is a fresh browser session (tab/window just opened, not
    // just reloaded). A guest case is scratch paper: if nobody signed in
    // and this is a fresh visit, whatever guest save is left over from last
    // time is now out of scope.
    migrateLegacySaves();
    const erasedGuestCase = reconcileSessionOnBoot(() => wipeProfile(GUEST_PROFILE));

    this.showMenu();
    if (erasedGuestCase) {
      toast("Starting fresh — your previous guest case wasn't saved. Sign in next time to keep one across visits.");
    }
  }

  // ------------------------------------------------------------------ menu

  private showMenu(): void {
    this.game = null;
    clear(this.root);
    const seedInput = el("input", { type: "text", placeholder: "Leave blank for a random city, or type any word or phrase as your seed" });
    // Difficulty picker.
    const diffRow = el("div");
    diffRow.style.cssText = "display:grid;grid-template-columns:repeat(3,1fr);gap:6px;";
    let chosenDifficulty: DifficultyId = DEFAULT_DIFFICULTY;
    const diffButtons = new Map<DifficultyId, HTMLButtonElement>();
    for (const def of Object.values(DIFFICULTIES)) {
      const b = button(def.label, () => {
        chosenDifficulty = def.id;
        for (const [id, btn] of diffButtons) btn.classList.toggle("primary", id === def.id);
        diffBlurb.textContent = def.blurb;
      }, def.id === chosenDifficulty ? "small primary" : "small");
      b.title = def.blurb;
      diffButtons.set(def.id, b);
      diffRow.append(b);
    }
    const diffBlurb = el("div", { className: "meta", text: DIFFICULTIES[chosenDifficulty].blurb });
    diffBlurb.style.cssText = "color:var(--text-dim);font-size:12px;min-height:32px;";

    const card = el("div", { className: "menu-card" }, [
      el("div", { className: "kicker", text: "New investigation" }),
      seedInput,
      el("div", { className: "kicker", text: "Difficulty" }),
      diffRow,
      diffBlurb,
      button("Generate a city — and wait for the worst", () => this.startNewGame(seedInput.value, chosenDifficulty), "primary"),
    ]);

    const saves = listSaves(currentProfileKey());
    if (saves.length > 0) {
      card.append(el("div", { className: "kicker", text: "Continue" }));
      for (const s of saves) {
        const row = el("div", { className: "occupant" }, [
          el("span", { text: `${s.slot === AUTOSAVE_SLOT ? "Autosave" : s.label} — ${s.seedPhrase}` }),
          button("Load", () => this.loadSlot(s.slot), "small"),
        ]);
        card.append(row);
      }
    }

    // Profile: tucked in the corner, revealed only on click. Signing in is
    // just a name (no password, no server) that namespaces saves in this
    // browser; skipping it plays as a guest.
    const corner = el("div", { className: "corner-profile" }, [this.profileCornerButton(() => this.showMenu())]);

    this.root.append(
      corner,
      el("div", { className: "screen-center" }, [
        el("div", { className: "title-block" }, [
          el("h1", { html: "LIVING <b>DETECTIVE</b>" }),
          el("p", { text: "A city that lives. A murder that truly happened. Every clue has an origin." }),
        ]),
        card,
      ])
    );
  }

  /**
   * Small "Sign in" / "<name>" button that opens the profile modal. Shared
   * between the menu (fixed to the corner) and the in-game top bar (part of
   * its usual right-aligned button cluster). `onChange` decides what else
   * needs refreshing after a sign-in/out — a full menu rebuild on the menu
   * screen, nothing extra mid-game.
   */
  private profileCornerButton(onChange: () => void): HTMLButtonElement {
    const label = () => activeProfile() ?? "Sign in";
    const btn = button(label(), () => {
      this.profileModal(() => {
        btn.textContent = label();
        onChange();
      });
    }, "small");
    btn.setAttribute("aria-label", "Sign in / profile");
    return btn;
  }

  private profileModal(onChange: () => void): void {
    const active = activeProfile();
    const body = el("div");
    let actions: HTMLElement[];
    let focusEl: HTMLElement | null = null;

    if (active) {
      body.append(
        el("div", { className: "card-meta", text: `Signed in as ${active}. Cases are namespaced under this name in this browser — no password, no server.` })
      );
      actions = [
        button("Sign out", () => { signOut(); closeModal(); onChange(); }, "small"),
        button("Close", () => closeModal()),
      ];
    } else {
      const nameInput = el("input", { type: "text", placeholder: "Name" });
      const errorEl = el("div", { className: "card-meta" });
      errorEl.style.color = "var(--danger)";
      const doSignIn = () => {
        const res = signIn(nameInput.value);
        if ("error" in res) { errorEl.textContent = res.error; return; }
        closeModal();
        onChange();
      };
      nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doSignIn(); });
      body.append(
        el("div", { className: "card-meta", text: "Optional — sign in to keep your cases across visits on this browser. Skip it and you're a guest: a guest case doesn't survive leaving and coming back." }),
        nameInput,
        errorEl,
      );
      actions = [
        button("Sign in", doSignIn, "primary"),
        button("Cancel", () => closeModal()),
      ];
      focusEl = nameInput;
    }

    openModal(active ? "Profile" : "Sign in", body, actions);
    focusEl?.focus();
  }

  private async startNewGame(seedPhrase: string, difficulty: DifficultyId = DEFAULT_DIFFICULTY): Promise<void> {
    clear(this.root);
    const label = el("div", { className: "progress-label", text: "Preparing…" });
    const bar = el("div");
    const barWrap = el("div", { className: "progress-bar" }, [bar]);
    bar.style.width = "0%";
    this.root.append(
      el("div", { className: "screen-center" }, [
        el("div", { className: "title-block" }, [el("h1", { html: "LIVING <b>DETECTIVE</b>" })]),
        el("div", { className: "progress-wrap" }, [label, barWrap]),
      ])
    );
    try {
      const game = await Game.generate(seedPhrase, difficulty, (text, frac) => {
        label.textContent = text;
        bar.style.width = `${Math.round(frac * 100)}%`;
      });
      this.game = game;
      this.autosave();
      this.showBriefing();
    } catch (err) {
      log.error("app", `Generation failed: ${String(err)}`);
      toast(`Generation failed: ${String(err)}. Try another seed.`);
      this.showMenu();
    }
  }

  private loadSlot(slot: string): void {
    const loaded = loadGame(currentProfileKey(), slot);
    if (!loaded) {
      toast("That save could not be loaded.");
      return;
    }
    this.game = Game.fromLoaded(loaded.world, loaded.casefile, loaded.phase);
    if (this.game.phase === "verdict" && this.game.casefile.accusation) {
      this.showGameShell();
      this.showVerdict();
    } else {
      this.showGameShell();
    }
    toast("Case file reopened.");
  }

  // -------------------------------------------------------------- briefing

  private showBriefing(): void {
    const game = this.game!;
    const crime = game.world.crime!;
    const victim = game.npc(crime.victimId);
    const scene = buildingById(game.world, crime.sceneBuildingId);
    const discoverer = crime.discoveredBy ? game.npc(crime.discoveredBy) : null;

    this.showGameShell();
    const body = el("div", {}, [
      el("div", { className: "card-body", text:
        `${game.world.cityName}. ${fmtTimeLong(game.world.time)}.\n\n` +
        `${fullName(victim)}, ${victim.age}, was found dead in ${scene.name}` +
        `${discoverer ? ` by ${fullName(discoverer)}` : ""}` +
        `${crime.discoveryTime ? ` at ${fmtTimeLong(crime.discoveryTime)}` : ""}.\n\n` +
        `The city has been living its own life for a week — arguments, debts, affairs, routines. ` +
        `Somewhere in that week is the reason this happened. The scene is untouched and waiting for you. ` +
        `People's memories fade by the day; the sooner you ask, the more they'll remember.\n\n` +
        `Seed: ${game.world.seedPhrase}` }),
    ]);
    openModal("A body has been found", body, [
      button("Take the case", () => {
        closeModal();
        this.refresh();
        // First case ever: hand the rookie the field manual.
        if (!loadSettings().tutorialSeen) this.fieldManual(true);
      }, "primary"),
    ]);
  }

  // ------------------------------------------------------------ game shell

  private showGameShell(): void {
    const game = this.game!;
    clear(this.root);
    this.panels = {};
    this.tab = "map";

    // Shared context.
    const ctx: UiCtx = {
      game,
      audio: this.audio,
      refresh: () => this.refresh(),
      switchTab: (t) => this.switchTab(t),
      openSuspect: (id) => {
        ctx.selectedSuspectId = id;
        this.switchTab("suspects");
      },
      confrontWith: (evidenceId) => this.confrontFlow(evidenceId),
      runAction: (label, fn, present) => this.runAction(label, fn, present),
      selectedBuildingId: game.casefile.detectiveAt,
      selectedSuspectId: null,
    };
    this.uiCtx = ctx;

    // Top bar.
    this.clockEl = el("span", { className: "clock" });
    this.locEl = el("span", { className: "loc" });
    const audioBtn = button(this.audio.isEnabled ? "♪ on" : "♪ off", () => {
      const on = this.audio.toggle();
      audioBtn.textContent = on ? "♪ on" : "♪ off";
    }, "small");
    const settingsBtn = button("⚙", () => this.settingsModal(), "small");
    settingsBtn.setAttribute("aria-label", "Settings");
    const topbar = el("div", { className: "topbar" }, [
      el("span", { className: "city", text: game.world.cityName }),
      this.clockEl,
      this.locEl,
      el("span", { className: "spacer" }),
      audioBtn,
      settingsBtn,
      this.profileCornerButton(() => {}),
      button("Save", () => this.saveModal(), "small"),
      button("Menu", () => this.confirmToMenu(), "small"),
    ]);

    // Nav rail.
    const rail = el("div", { className: "nav-rail" });
    for (const t of TABS) {
      const b = el("button", { html: `${t.label} <span class="key">${t.key}</span>` });
      b.dataset.tab = t.id;
      b.addEventListener("click", () => this.switchTab(t.id));
      rail.append(b);
    }
    const railFooter = el("div", { className: "rail-footer" });
    railFooter.append(
      button("Wait 1 hour", () => this.runAction("Waited", () => {
        game.advance(60);
        return { minutes: 60 };
      }), "small"),
      button("Field Manual", () => this.fieldManual(), "small"),
    );
    rail.append(railFooter);

    this.panelHost = el("div", { className: "main-panel" });
    const layout = el("div", { className: "layout" }, [rail, this.panelHost]);
    const hints = el("div", { className: "hint-bar" }, [
      el("span", { html: "<b>1–8</b> panels" }),
      el("span", { html: "<b>`</b> console" }),
      el("span", { html: "<b>Esc</b> close" }),
      el("span", { html: "Memories decay daily — interview early." }),
    ]);
    this.root.append(topbar, layout, hints);

    // Panels (lazy-constructed once).
    this.mapPanel = new MapPanel(ctx);
    this.panels = {
      map: this.mapPanel,
      evidence: new EvidencePanel(ctx),
      suspects: new SuspectsPanel(ctx),
      statements: new StatementsPanel(ctx),
      timeline: new TimelinePanel(ctx),
      relations: new RelationsPanel(ctx),
      notes: new NotesPanel(ctx),
      accuse: new AccusePanel(ctx),
    };
    this.switchTab("map");
  }

  private switchTab(tab: TabId): void {
    if (!this.panelHost || !this.game) return;
    if (this.game.phase === "verdict") {
      this.showVerdict();
      return;
    }
    this.tab = tab;
    for (const b of this.root.querySelectorAll<HTMLButtonElement>(".nav-rail button[data-tab]")) {
      b.classList.toggle("active", b.dataset.tab === tab);
    }
    clear(this.panelHost);
    const panel = this.panels[tab];
    if (panel) {
      this.panelHost.append(panel.root);
      panel.render();
    }
    this.updateTopbar();
  }

  private refresh(): void {
    if (!this.game) return;
    if (this.game.phase === "verdict") {
      this.showVerdict();
      return;
    }
    this.updateTopbar();
    this.panels[this.tab]?.render();
    // Tension follows how hot the file is.
    const contradictions = computeContradictions(this.game.casefile).length;
    this.audio.setTension(Math.min(1, this.game.casefile.evidence.length / 40 + contradictions * 0.12));
  }

  private updateTopbar(): void {
    if (!this.game || !this.clockEl || !this.locEl) return;
    this.clockEl.textContent = fmtTimeLong(this.game.world.time);
    const here = buildingById(this.game.world, this.game.casefile.detectiveAt);
    this.locEl.innerHTML = `at <b></b>`;
    this.locEl.querySelector("b")!.textContent = here.name;
  }

  // ---------------------------------------------------------------- actions

  private runAction(label: string, fn: () => ActionOutcome | void, present?: (out: ActionOutcome) => void): void {
    if (!this.game) return;
    try {
      const out = fn();
      if (present && out) {
        present(out);
      } else {
        const minutes = out && "minutes" in out ? out.minutes : 0;
        toast(`${label}${minutes ? ` · ${minutes} min` : ""}${out?.note ? ` — ${out.note}` : ""}`);
      }
      this.audio.blip("act");
      this.autosave();
      this.refresh();
    } catch (err) {
      toast(String(err instanceof Error ? err.message : err));
      this.audio.blip("bad");
    }
  }

  private confrontFlow(evidenceId: string): void {
    const game = this.game!;
    const cf = game.casefile;
    const body = el("div");
    // Evidence picker (when not launched from a specific piece).
    let chosenEvidence = evidenceId;
    if (!chosenEvidence) {
      body.append(el("div", { className: "kicker", text: "Which evidence?" }));
      const evSel = el("select");
      for (const e of cf.evidence) {
        const opt = document.createElement("option");
        opt.value = e.id;
        opt.textContent = e.title;
        evSel.append(opt);
      }
      evSel.style.cssText = "width:100%;margin-bottom:10px;";
      evSel.addEventListener("change", () => { chosenEvidence = evSel.value; });
      chosenEvidence = cf.evidence[0]?.id ?? "";
      body.append(evSel);
    } else {
      const e = cf.evidence.find((x) => x.id === evidenceId);
      body.append(el("div", { className: "dialogue", text: e?.title ?? "" }));
    }
    if (!chosenEvidence && cf.evidence.length === 0) {
      toast("You have no evidence to confront anyone with.");
      return;
    }
    body.append(el("div", { className: "kicker", text: "Confront whom?" }));
    const sel = el("select");
    for (const n of game.world.npcs.filter((x) => x.alive)) {
      const opt = document.createElement("option");
      opt.value = n.id;
      opt.textContent = fullName(n);
      if (n.id === this.uiCtx?.selectedSuspectId) opt.selected = true;
      sel.append(opt);
    }
    sel.style.cssText = "width:100%;";
    body.append(sel);
    openModal("Confrontation", body, [
      button("Put it to them (30 min)", () => {
        closeModal();
        this.runAction("Confrontation", () => {
          const out = game.actConfront(sel.value, chosenEvidence);
          if (out.statement) {
            const speaker = game.npc(sel.value);
            openModal(fullName(speaker), el("div", {}, [
              el("div", { className: "meta", text: out.statement.question }),
              el("div", { className: "dialogue", text: `“${out.statement.answer}”` }),
            ]));
          }
          return out;
        });
      }, "primary"),
      button("Cancel", () => closeModal()),
    ]);
  }

  // ------------------------------------------------------------------ save

  private autosave(): void {
    if (!this.game) return;
    const g = this.game;
    saveGame(currentProfileKey(), AUTOSAVE_SLOT, g.world, g.casefile, g.phase, `Case of ${fullName(g.npc(g.casefile.victimId))}`);
  }

  private saveModal(): void {
    const g = this.game!;
    const profileKey = currentProfileKey();
    const body = el("div");
    body.append(el("div", { className: "card-meta", text: activeProfile() ? `Saving as ${activeProfile()}` : "Saving as guest — sign in from the menu to keep this across visits." }));
    for (const slot of SLOTS.filter((s) => s !== AUTOSAVE_SLOT)) {
      const existing = listSaves(profileKey).find((s) => s.slot === slot);
      const row = el("div", { className: "occupant" }, [
        el("span", { text: existing ? `${slot}: ${existing.label} (${existing.seedPhrase})` : `${slot}: empty` }),
        button("Save here", () => {
          const ok = saveGame(profileKey, slot, g.world, g.casefile, g.phase, `Case of ${fullName(g.npc(g.casefile.victimId))}`);
          toast(ok ? "Saved." : "Save failed.");
          closeModal();
        }, "small"),
      ]);
      body.append(row);
    }
    openModal("Save case file", body);
  }

  private settingsModal(): void {
    const s = loadSettings();
    const body = el("div");
    const mkToggle = (label: string, sub: string, checked: boolean, onChange: (v: boolean) => void) => {
      const cb = el("input", { type: "checkbox" });
      cb.checked = checked;
      cb.addEventListener("change", () => onChange(cb.checked));
      const row = el("label", { className: "occupant" }, [
        el("span", {}, [
          el("div", { text: label }),
          el("div", { className: "card-meta", text: sub }),
        ]),
        cb,
      ]);
      row.style.cursor = "pointer";
      return row;
    };
    body.append(
      mkToggle("Start ambience automatically", "Procedural audio begins on your first click each session.", s.audioAutoStart, (v) => updateSettings({ audioAutoStart: v })),
      mkToggle("Colorblind-safe relations palette", "Okabe–Ito hues plus distinct line patterns in the Web of Relations.", s.colorblind, (v) => {
        updateSettings({ colorblind: v });
        this.refresh();
      }),
    );
    if (this.game) {
      body.append(el("div", { className: "card-meta", text: `Current case difficulty: ${DIFFICULTIES[this.game.world.difficulty ?? DEFAULT_DIFFICULTY].label} (chosen per case on the menu).` }));
    }
    openModal("Settings", body);
  }

  private fieldManual(markSeen = false): void {
    if (markSeen) updateSettings({ tutorialSeen: true });
    const steps: Array<[string, string]> = [
      ["1 · Work the scene", "Travel to the marked building and examine it. Blood, prints, footprints, the victim's effects — and read the autopsy when the lab is done for the time-of-death window."],
      ["2 · Canvass", "Interview widely and early — memories fade every night. Ask who had trouble with the victim; that names your first suspects."],
      ["3 · Follow the paper", "Phone records, financials, camera footage. Warrants open private homes. Search parks and warehouses — things get hidden there."],
      ["4 · Break the story", "Statements make claims; evidence makes placements. When they collide, the Statements and Timeline panels flag it. Confront people — liars shift, the secretive crack."],
      ["5 · Mind the killer", "Time keeps moving. Press someone too obviously and they may wipe prints, move the weapon, or lean on a witness — destroying evidence but leaving new traces."],
      ["6 · Accuse once", "A conviction needs pillars: weapon link, placement, motive, a broken account. Check them on the Accuse panel before you commit."],
    ];
    const body = el("div");
    for (const [h, t] of steps) {
      body.append(el("div", { className: "card" }, [
        el("div", { className: "card-title", text: h }),
        el("div", { className: "card-body", text: t }),
      ]));
    }
    openModal("Field Manual", body);
  }

  private confirmToMenu(): void {
    openModal("Leave the case?", el("div", { className: "card-body", text: "Progress is autosaved. You can reopen the case from the menu." }), [
      button("Back to menu", () => { closeModal(); this.showMenu(); }, "primary"),
      button("Stay", () => closeModal()),
    ]);
  }

  // --------------------------------------------------------------- verdict

  private showVerdict(): void {
    const game = this.game!;
    const result = game.casefile.accusation;
    if (!result || !this.panelHost) return;
    this.autosave();
    clear(this.panelHost);
    const accused = game.npc(result.accusedId);

    const cls = result.verdict === "conviction" ? "win" : result.verdict === "walks-free" ? "partial" : "lose";
    const headline =
      result.verdict === "conviction" ? "CASE CLOSED" :
      result.verdict === "walks-free" ? "NOT ENOUGH" :
      "THE WRONG PERSON";
    const subline =
      result.verdict === "conviction" ? `${fullName(accused)} was convicted. Your case held.` :
      result.verdict === "walks-free" ? `You were right about ${fullName(accused)} — but the case was too thin, and they walked.` :
      `${fullName(accused)} was innocent. The real killer is still out there.`;

    const wrap = el("div", { className: "panel-scroll" }, [
      el("div", { className: "verdict-wrap" }, [
        el("div", { className: `verdict-banner ${cls}` }, [
          el("h1", { text: headline }),
          el("div", { text: subline }),
          el("div", { className: "strength-bar" }, [(() => {
            const bar = el("div");
            bar.style.width = `${result.caseStrength}%`;
            bar.style.background = cls === "win" ? "var(--success)" : cls === "partial" ? "var(--accent)" : "var(--danger)";
            return bar;
          })()]),
          el("div", { className: "meta", text: `Case strength: ${result.caseStrength}/100 · Motive named: ${result.motiveGuess}` }),
        ]),
        el("div", { className: "card" }, [
          el("div", { className: "kicker", text: "The prosecutor's view" }),
          ...result.breakdown.map((b) => el("div", { className: "pillar", text: b })),
        ]),
        el("div", { className: "card" }, [
          el("div", { className: "kicker", text: "What actually happened" }),
          ...result.revealText.map((line, i) => el("div", {
            className: i === 0 ? "tl-window" : "card-body",
            text: line,
          })),
        ]),
        (() => {
          const row = el("div");
          row.style.cssText = "display:flex;gap:10px;margin:16px 0;";
          row.append(
            button("New case (new city)", () => this.startNewGame("", game.world.difficulty ?? DEFAULT_DIFFICULTY), "primary"),
            button(`Replay this seed (${game.world.seedPhrase})`, () => this.startNewGame(game.world.seedPhrase, game.world.difficulty ?? DEFAULT_DIFFICULTY)),
            button("Menu", () => this.showMenu()),
          );
          return row;
        })(),
      ]),
    ]);
    this.panelHost.append(wrap);
  }

  // ------------------------------------------------------------- shortcuts

  private onKey(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) {
      if (e.key === "Escape") (e.target as HTMLElement).blur();
      return;
    }
    if (e.key === "`") {
      e.preventDefault();
      this.devConsole.toggle();
      return;
    }
    if (e.key === "Escape") {
      if (isModalOpen()) closeModal();
      return;
    }
    if (!this.game || this.game.phase === "verdict") return;
    const tab = TABS.find((t) => t.key === e.key);
    if (tab) this.switchTab(tab.id);
  }
}

/** Free-form notebook persisted in the case file. */
class NotesPanel {
  readonly root: HTMLElement;
  private ctx: UiCtx;

  constructor(ctx: UiCtx) {
    this.ctx = ctx;
    this.root = el("div", { className: "panel-scroll" });
  }

  render(): void {
    clear(this.root);
    const cf = this.ctx.game.casefile;
    this.root.append(
      el("div", { className: "panel-header" }, [
        el("h2", { text: "Notebook" }),
        el("div", { className: "sub", text: "Your own working theory. Saved with the case." }),
      ])
    );
    const ta = document.createElement("textarea");
    ta.value = cf.notes.join("\n");
    ta.style.cssText =
      "width:100%;height:60vh;background:var(--bg-raised);color:var(--text);border:1px solid var(--border-strong);" +
      "border-radius:8px;padding:14px;font-family:var(--mono);font-size:13px;line-height:1.6;outline:none;resize:vertical;";
    ta.addEventListener("input", () => {
      cf.notes = ta.value.split("\n");
    });
    this.root.append(ta);
  }
}
