# Living Detective

A procedural detective simulation. Every new game generates a unique city full
of simulated residents who live their own lives — jobs, friendships, debts,
affairs, grudges. Eventually one of them kills another, for reasons the
simulation itself produced. You are the detective who arrives afterward.

**Nothing is fabricated for the player.** Every fingerprint traces to a hand
that touched the object. Every witness statement comes from a memory of an
event that really occurred. Every lie has a motive. Every record — phone,
camera, financial — was written by the simulation as it ran. At the end, the
game replays the complete true history of the crime from its own event log.

## Running

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # full suite: unit + integration + seed sweep
npm run build      # type-check + production bundle
```

## How to play

1. **Generate a city.** Enter a seed (or leave blank), pick a difficulty —
   Rookie (more cameras, sharper memories, a sloppier killer), Detective, or
   Inspector (sparse cameras, fading memories, a careful killer, cagey
   witnesses). The simulation runs a full week of city life, tension builds,
   and someone is murdered and found. Seed + difficulty always reproduces
   the identical case.
2. **Work the scene.** Travel there on the map, examine it: blood, prints,
   footprints, the victim's effects (their phone opens their call history on
   the spot), sometimes the weapon — if the killer was careless. If the
   victim fought back, the autopsy recovers DNA you can compare against a
   named suspect — confirmation or exoneration, never a fishing trip.
3. **Work the town.** Interview anyone: whereabouts, what they saw, and the
   question every detective asks first — *who had trouble with the victim?*
   Pull phone records, financial records, camera footage. Search buildings
   (homes need a warrant). Read the autopsy for the death window.
4. **Find the lie.** Statements make *claims*; evidence makes *placements*.
   When they collide, the Statements and Timeline panels flag the
   contradiction. The Relations panel grows a web of feuds, debts, affairs
   and blackmail as you uncover them — with a suspect comparison strip
   (shoe sizes vs. the scene prints, broken stories, evidence counts).
   Confront people with evidence — the guilty shift their story; the merely
   secretive crack and confess to smaller sins.
5. **Accuse.** One shot. A conviction needs pillars: a physical weapon link,
   placement near the scene, a documented motive, a broken alibi. Being right
   without proof means the killer walks.

Time keeps moving while you investigate — memories decay nightly, so
interview early. And the killer feels you coming: press them too obviously
and a nervous one may wipe the weapon, move it, lean on a witness, or creep
back to the scene — destroying old evidence while leaving new traces.
Everything autosaves; replaying a seed reproduces the exact same city and
crime.

### Profiles (optional sign-in)

There's no account system — just an optional name. Type one in on the menu
and your cases are saved under it in this browser, so entering the same
name later finds them again. Skip it and you're a guest: a guest case is
scratch paper. Close the tab and come back without signing in, and it's
gone. Signing in is per-session by design — reload the page and you're
still signed in, but a genuinely new visit starts back at guest until you
type your name again.

### Controls

| Input | Action |
| --- | --- |
| `1–8` | Switch panels (Map, Evidence, People, Statements, Timeline, Relations, Notebook, Accuse) |
| Mouse | Select buildings, travel, all actions |
| Gamepad | D-pad/stick moves focus, A activates, B closes, LB/RB cycle panels |
| `` ` `` | Developer console (log stream + debug commands incl. `perf`, `hud`, and spoilers) |
| `Esc` | Close dialog |
| ♪ | Toggle procedural audio (a noir score: breathing pad, distant piano, tension drone) |
| ⚙ | Settings: audio auto-start, colorblind-safe relations palette |

A Field Manual (six steps of detective procedure) opens automatically on
your first case and stays available from the left rail. Keyboard focus
rings, reduced-motion support, and ARIA labels on the canvases are built in.

## Design pillars

- **Honest simulation.** The investigation layer is a read-only projection of
  the world's event log. The killer is chosen by scoring real motives that
  accumulated during the simulated week (feuds, blackmail, debt, jealousy,
  inheritance, rivalry); the opportunity window comes from predicting real
  schedules; the weapon must already exist somewhere the killer can reach.
- **Emergent testimony.** NPCs answer from their own decaying memories, each
  in their own voice — curt, chatty, nervous, precise. Killers defend
  fabricated alibis. People with affairs or thefts in the window lie to
  cover them — red herrings that resolve into real secrets. Loyal partners
  cover for each other. Nosy neighbors remember comings and goings; "I saw
  him come in at 17:10" honestly implies he was out before. A bartender who
  worked the whole window can swear someone *never came in* — absence
  testimony that breaks venue alibis. And some witnesses won't talk at all
  until you show up with leverage.
- **Determinism.** One seed = one city = one crime, byte for byte. Sub-seeded
  RNG streams keep systems independent; the test suite locks this in.

## Project layout

```
src/
  core/           rng, event bus, sim clock, logging
  data/           name pools, occupations, item catalog
  world/          types (single source of truth), city gen, population gen
  sim/            engine (ticks, movement, records), interactions, memory
  crime/          motive scoring + planning, execution + discovery
  investigation/  case file, evidence actions, interviews, accusation
  game/           director (orchestration), save system
  ui/             app shell, canvas map, panels, audio, dev console
tests/            unit, integration, and seed-sweep suites
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the system map,
data-flow contracts, and the provenance invariants the tests enforce.
