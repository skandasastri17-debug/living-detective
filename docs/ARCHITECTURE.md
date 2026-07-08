# Living Detective — Architecture

## The one rule

**The investigation layer may only project truth that the simulation wrote.**

Every artifact the player can find carries provenance:

| Artifact | Provenance |
| --- | --- |
| `Item.fingerprints[]` | `eventId` of the touch/theft/purchase/murder that deposited them; plus implicit "routine use" for the owner and their household (ownership is assigned at generation: householders own home items) |
| `Item.bloodOfNpcId` | `bloodEventId` = the murder event |
| `MemoryRecord` | `eventId` of the event the NPC participated in, witnessed, heard, or received as gossip |
| `PhoneCallRecord`, `TransactionRecord`, `CameraLogEntry` | `eventId` of the call/purchase/entry event |
| `CrimeRecord.motiveEventIds` | the actual arguments/fights/demands that built the motive |
| `Secret.originEventId` | the event that minted it (null only for pre–day-0 backstory) |

`tests/simulation.test.ts` enforces these invariants on generated worlds.

## System map & data flow

```
core/rng ── seeded sfc32, named sub-streams (order-independent determinism)
core/events ── typed pub/sub bus (UI decoupling)
core/time ── SimTime = minutes; 10-minute ticks

world/types ── the single source of truth for all shared shapes
world/citygen ── road grid (named streets), 3×3 lots, buildings/rooms/items,
                 cameras, opening hours; BFS pathfinding over road cells
world/npcgen ── households → jobs → finances → schedules → social graph
                (friendships, grudges, exes, debts, one seeded affair)
                → possessions → item ownership

sim/engine ── tick(): schedule resolution (predictTarget is PURE so the
              planner can predict the future), street travel with real paths,
              arrivals/departures (+camera logs, +nosy-neighbor witnesses),
              street sightings, interactions, phone calls, purchases,
              salaries/rent, nightly memory decay.
              emit() is the single choke point: assigns witnesses
              (perception × salience × light), writes memories, appends to
              the event log.
sim/interactions ── utility-weighted pair beats: chat/gossip/argue/fight/
              flirt/affair/loan-demand/blackmail/theft; per-pair cooldown;
              these grow relationships, secrets — and motives.
sim/memory ── strength decay by personality; recall quality tiers drive
              testimony precision ("vivid" = exact, "vague" = ±the hour)

crime/planner ── scoreMotives() reads the real relationship/secret/event
              state; findOpportunity() scans predicted schedules for windows
              where the victim is isolated; weapon sourced from what the
              killer owns/can reach/can buy. Thresholds relax day by day —
              quiet cities simmer longer.
crime/executor ── drives the killer through waypoints with the same movement
              machinery as everyone else (purchases and camera hits happen
              naturally), waits for actual isolation, murders, leaves traces,
              disposes of the weapon, goes home. Discovery = whoever the sim
              brings to the body; fallback chain: missed work → unanswered
              call → someone checks → someone searches.
crime/coverup ── killer counter-play. Detective actions touching the killer
              (interviews, confrontations, record pulls, home searches) add
              PRESSURE; a pressured killer acts by temperament in the quiet
              hours, at most once a day: wipe the weapon (destroys prints,
              sets wipedAt — visible tampering, 30% panic print), retrieve &
              re-hide it (fresh handling prints, new hiding spot), intimidate
              the witness they remember noticing them (that witness clams up
              until leveraged, then the intimidation itself becomes
              consciousness-of-guilt evidence with placement), or revisit the
              scene (cameras/neighbors catch it). The killer acts only on
              what they know — never on the player's case file. Careful
              killers (gloves, clean night) correctly have nothing to do and
              sit tight.

investigation/casefile ── what the player KNOWS. Statements carry Claims
              (person, window, place); evidence carries placements.
              computeContradictions() = claims × collected placements only.
investigation/actions ── scene exam, searches (warrants for homes), records
              pulls, autopsy: pure projections of world truth.
              DNA: frenzied (non-premeditated) murders record the killer's
              DNA under the victim's nails (murder-event provenance). The
              autopsy flags the material; compareDna() only works against a
              NAMED suspect — it confirms (physical-link placement at the
              scene at murder time) or honestly clears them. It never goes
              fishing. The victim's dropped phone doubles as an instant
              records pull when examined at the scene.
investigation/interview ── answers reconstructed from the speaker's actual
              event trail and memories; killer defends a fabricated alibi;
              secret-holders cover their secret segments; household loyalty
              can cover for a spouse; witnessed arrivals imply "was out
              just before" (street placements that break alibis). Every
              event a witness recounts is narrated by
              investigation/narration.ts (see below) — role-correct
              pronouns and seeded phrasing variety, never a raw summary
              string substitution.
              Absence testimony: a witness who spent 60+ min of the murder
              window at their workplace / an attended venue can testify that
              X never came in — recorded as a NEGATIVE placement
              (absentFromBuildingId), verified against the event log at
              creation, and matched against claims by a second contradiction
              rule. The killer never gives absence testimony (it would pin
              their own true position), so a negative can never break a true
              alibi. Narration (investigation/narration.ts): turns a SimEvent
              into a sentence FROM A GIVEN SPEAKER'S POINT OF VIEW by role —
              subject (they did it, "I argued with..."), object (it was
              done to them, "...came at me"), or witness (both real names,
              third person) — never blind name→"I" substitution on the
              canonical summary (that produced nonsense like "argued
              heatedly with I"). Phrasing is seeded per (event, speaker):
              stable on re-ask, but different witnesses of the same event
              phrase it differently. Voices (investigation/voice.ts):
              deterministic personality-driven phrasing (curt/chatty/
              nervous/precise) layered on top — words only, never
              mechanics. Cooperation (cooperationOf):
              traits + stakes make witnesses cooperative, reluctant (vivid
              memories only, coarse whereabouts — honest omissions, so no
              false contradictions), or hostile (refusals); confronting them
              with evidence that touches them opens them up permanently.
              The killer always presents as cooperative — the alibi needs an
              audience.
investigation/accusation ── four 25-point pillars (weapon link, placement,
              documented motive, broken account) + consciousness-of-guilt
              and motive-match bonuses; conviction ≥ 50 AND correct.
              Reveal = the true chain of events straight from the log, told
              in sections (motive with per-kind coda / the night / the means
              / the lie / the cover-up); motive summaries draw from seeded
              phrasing variants so cases read differently.
              RelationFacts: casefile stores relationship edges (feud, debt,
              affair, blackmail, theft) ONLY when a piece of evidence or
              testimony reveals them (learnFactFromSecret / addRelationFact at
              each disclosure point). The Relations panel renders these plus
              public town facts (marriages, households, workplaces) among
              case-connected people — never the whole town.

world/difficulty ── presets (Rookie/Detective/Inspector) stored on the world:
              seed + difficulty = identical case. Knobs are honest sim
              parameters only — camera density multiplier, memory-decay
              bonus, killer competence (shifts glove/disposal thresholds,
              tamper nerve, panic-print odds), witness cooperation penalty,
              extra houses. No knob fabricates or deletes evidence.

game/director ── Game.generate(seed, difficulty): city → population → 5 days
              of life → plan/execute/discover loop (hard iteration guard) →
              case file. Generation yields via MessageChannel between slices
              (immune to background-tab timer throttling). Player actions
              advance time; the city keeps living underneath.
game/profile ── local-only "sign in" (a name, no password, no server).
              activeProfile()/currentProfileKey() live in sessionStorage, so
              both the signed-in state and the guest/session-marker survive
              reloads but vanish when the tab/window actually closes — by
              design, sign-in is re-entered fresh each session, not a
              persistent login. reconcileSessionOnBoot() runs once at boot:
              if the session marker is absent (a genuinely new visit, not a
              reload), any leftover guest-namespaced save is erased before
              the menu renders — a guest case is scratch paper that does not
              survive being left and returned to. Named profiles are never
              auto-erased. Falls back to an in-memory store wherever
              sessionStorage is unavailable (Node tests included).
game/save ── versioned JSON in localStorage, namespaced per profile key
              (`living-detective:save:<profile>:<slot>`, "guest" or a
              signed-in name); roads Map ⇄ array; autosave on every action;
              manual slots; seed replay regenerates identically.
              migrateLegacySaves() folds any save written before profiles
              existed into the guest namespace once, so upgrading never
              silently drops progress. Storage access is probed live
              (`typeof localStorage`) rather than cached at import time, and
              only a genuinely absent API falls back to an in-memory map —
              a real write failure (quota, private-mode) still propagates as
              an honest save failure instead of being masked as success.

ui/ ── vanilla TS + canvas. App shell (screens, tabs, shortcuts, toasts),
       MapView (not omniscient: no NPC positions), panels per concern
       (including the knowledge-gated Relations graph + suspect comparison),
       procedural WebAudio noir score (a breathing Am7 pad through a feedback
       delay, sparse un-gridded pentatonic piano plucks, a tension drone that
       rises with the case, action blips — no noise generators), gamepad
       focus navigation (d-pad/stick + A/B + bumpers), dev console (` ) with
       spoiler/QA commands plus `perf` and a `hud` overlay fed by the
       engine's tick-duration ring buffer.
       ui/reveal.ts ── cinematic findings presentations layered purely over
       already-collected evidence (no new fabrication): a staggered
       "evidence sweep" reveal (searches, scene work) and a CCTV-monitor-
       styled camera review (scanlines, terminal rows, murder-window hits
       pulsed and flagged) that re-reads world.cameraLog — the same source
       pullCameraLogs already queried — purely to lay it out as rows.
       ui/settings ── persisted player settings (audio auto-start on first
       gesture, colorblind-safe Relations palette: Okabe–Ito hues + per-kind
       dash patterns so hue is never the only channel, tutorial-seen flag);
       Field Manual tutorial auto-opens on the first case; :focus-visible
       rings, prefers-reduced-motion support, ARIA-labelled canvases.
```

## Key decisions

- **Building-level occupancy, street-level travel.** Rooms exist for items
  and scenes; presence is tracked per building, travel per road cell. This
  keeps the sim cheap (~40 NPCs × ~1000 ticks in well under a second) while
  still producing street sightings ("saw her on Mercer, heading north").
- **Pure schedule prediction.** `predictTarget(npc, t)` derives dynamic
  destinations from `hash(seed, npc, day, block)` — no shared RNG state — so
  the crime planner can simulate the future without mutating it.
- **Claims vs placements.** Lies are not flagged by fiat; they are claims
  that mechanically collide with collected evidence. The player's
  contradiction list is exactly what a prosecutor could argue.
- **Deliberate imperfection.** Witness perception rolls, memory decay, vague
  time reporting, gloves, hidden weapons, and lying secret-holders make
  cases textured rather than checklists; the seed sweep test guarantees
  every case still has investigative surface.

## Testing

- `tests/core.test.ts` — RNG determinism/stream independence, bus isolation,
  clock math.
- `tests/world.test.ts` — citygen invariants (doors on roads, pathability,
  item-room provenance), population invariants (homes, jobs, schedules,
  partners, possessions).
- `tests/simulation.test.ts` — full pipeline: murder consistency (killer's
  real trail includes the scene), provenance of prints/blood/memories/
  records, seed reproducibility, killer-lies/honest-witness properties,
  a thorough sweep reaching a conviction, wrongful accusations rejected.
- `tests/robustness.test.ts` — seed sweep: multiple cities must generate a
  discovered, solvable case within a wall-clock budget (guards quadratic
  regressions and stalls).
- `tests/testimony.test.ts` — absence testimony provenance (every negative
  placement re-verified against the log; absence contradictions only break
  false claims; the killer never gives one), voice determinism/variety, and
  the hostile-witness refusal → leverage → unlock flow.
- `tests/coverup.test.ts` — no tampering without pressure; tampering events
  carry full provenance (wipe referenced by the item, intimidation
  remembered by the witness); the clam-up → leverage → consciousness-of-
  guilt evidence chain; mid-coverup save round-trips.
- `tests/playtest.test.ts` — the fair-play bot (scene → autopsy → full
  canvass incl. "who had trouble with the victim?" → follow the evidence →
  alibi checks with venue staff → iterative deepening → cold-case re-sweep)
  must convict the true killer on all 15 sweep seeds, no case may be
  convictable from the scene alone, the killer must rank top-2 in an honest
  suspect ranking in ≥70% of towns, and difficulty knobs must provably
  change worlds (camera counts, killer carefulness) while staying
  deterministic per seed+difficulty.
- `tests/content.test.ts` — struggle DNA exists only for frenzied murders
  and always carries murder-event provenance; comparison confirms the
  killer / clears innocents / requires the autopsy; the victim's phone
  shortcut; reveal sectioning and determinism; motive phrasing variety.
- `tests/settings.test.ts` — settings round-trip (with Node fallback);
  colorblind edge styles never rely on hue alone.
- `tests/profile.test.ts` — slug normalization; sign-in/out and the guest
  default; a fresh session wipes guest saves exactly once and leaves a
  signed-in profile's saves untouched; profile-namespaced saves never
  collide; legacy (pre-profile) saves migrate into guest without
  clobbering an existing guest save.
- `tests/narration.test.ts` — role-correct pronouns (subject/object/witness)
  for every narrated event kind, determinism per (event, speaker) with
  variety across different speakers, venue inclusion; a general-purpose
  regression guard (preposition immediately followed by "I" — always wrong
  English) swept across real generated interviews on multiple seeds and
  every topic, plus a direct check that independent witnesses of the same
  event produce different testimony text.
