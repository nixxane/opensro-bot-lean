# Team edition — the multi-character plan

This extension adds a **team layer** to the lean bot: a private,
player-operated relay that lets several characters share what they see and coordinate. The base
bot stays untouched in behaviour until the Team page is configured; with the relay off or
unreachable, everything works exactly as before.

## Design rules

1. **The relay is an enhancement, never a dependency.** A bot alone must behave exactly like
   the lean bot. Relay down ⇒ silently fall back; hunting never stops or waits on it.
2. **The game stays authoritative.** The relay carries observations and intents between bot
   instances. It never proxies game commands: every action still goes through the local `Cmd`
   layer with its own rate limits and refusal handling. A compromised relay can, at worst,
   suggest safe high-level actions (go to town, regroup); it cannot press game buttons.
3. **Independent services.** The team bus runs with hunting stopped, across world transitions
   and character switches. Party automation already must not depend on hunting; neither does
   the team layer.
4. **Room key = trust circle.** One shared secret per group of characters (the "room key").
   Nothing fancier until there is a reason.

## What the game gives us (verified against the OpenSRO source)

Read-only analysis of the game server (Go) and client engine contracts, which grounds every
later phase:

- **Entity gids are the cross-client key.** Players: `100000 + characterID` (deterministic).
  Monsters: one server-wide counter, never reused within a process lifetime. Caveat: a server
  restart resets the monster counter — shared monster intel must carry short TTLs (a restart
  also disconnects everyone, which flushes live state naturally).
- **Three detection radii per client**, all of them worth reporting:
  1. the interest view (320-unit blocks, 3×3 neighbourhood ≈ ±640 units; a dungeon region is
     one block),
  2. division-wide broadcasts received *without seeing anything*: unique spawn/death notices
     (`0x3058`, by RefObjID), monster HP ticks from damage-over-time, and the optional beta
     player map (`0x3FB0`, flag `SRO_BETA_PLAYER_MAP`, all players every 2 s),
  3. party data (member positions and HP/MP tenths every second, regardless of distance).
- **Who attacks what is observable.** Cast packets (`0xB245`) carry caster gid, target gid and
  exact per-hit damage, and are delivered to every client that has the *caster* in view — so
  a fight can be known even when the target itself is out of view. There is no target-of-
  target; assist is inferred from casts.
- **Monster HP is exact on selection** (`0x745A` → `0xB45A`) and on DoT ticks; otherwise it is
  an estimate summed from cast damage. Shared HP is always labelled an estimate.
- **Dead bodies persist** until the server despawns them (a stable window for coordinated
  resurrection).
- The game's own commands include `chat`, `party-invite/leave/kick`; the lean build strips
  them. If an in-game channel is ever wanted, it is a deliberate re-add, not a discovery.

## Architecture

```
TeamBus       transport: one WebSocket, rooms by key, reconnect/backoff, heartbeats   [shipped, 1.3.0]
TeamIntel     live shared world: entity digests, combat edges, shared map layer       [shipped, 1.4.0]
TeamKnowledge persistent via the relay's room store: unique tracker with respawn
              windows, player DB with hostility, shared drop log                       [shipped, 1.4.0]
TeamArbiter   decisions: roles, assist, spot-claim warnings, town sync,
              resurrection claims, console commands                                    [shipped, 1.4.0]
              missions: automatic party composition, job caravans                      [designed, deferred]
```

What 1.4.0 delivers per phase, honestly:

- **Phase 2 (live intel)** — complete: digests of interesting monsters (champion and up, party
  mobs, uniques with an HP estimate), players in view, and combat edges from every cast around
  (observed via the bot's own cast bus event); merged by gid with source, TTLs and a
  region-plausibility filter; drawn as a dimmed layer on the map, own view always winning.
- **Phase 3 (knowledge)** — complete for its first scope: the relay keeps a per-room key-value
  store (persisted across restarts) holding the team's shared memory; the unique tracker runs on
  the game's own division-wide announcements (UIIT_MSG_APPEAR/DEAD notices already reach the
  bot's bus) plus sightings and fatal casts, with respawn windows (timer restarts at death,
  3-6 h per unique); the player database records names, positions, levels and hostility (a
  player casting at a teammate outside a party); drops are counted per item name.
- **Phase 4 (arbiter)** — complete for its first scope: roles are declared and displayed (they
  do not yet drive behaviour beyond presence); assist targets the monster a teammate or party
  member is fighting; spot claims warn when two characters start on top of each other. Team
  etiquette between unpartied characters is the bot's existing no-KS rule by design.
- **Phase 5 (coordinated cycles)** — complete for its first scope: synchronized town trips
  (optional follow), deterministic resurrection claims (the dead member waits up to 60 s), and
  the fleet console (relay page `/?key=…` with Stop everyone / Town trip buttons). A shared
  trip window negotiated by a coordinator is future work.
- **Phase 6 (missions)** — unique converge is shipped opt-in (a unique with a known position
  moves the hunting character's spot there until it dies or 20 minutes pass; the saved spot is
  restored after); automatic party composition and job caravans need live verification of
  trade mechanics and are deferred until the rest is field-tested.
- **Public pool** — the per-category checkboxes (monsters, players, uniques) fan live events to
  every room, and with uniques ticked the tracker also reads and writes the relay's public
  store, so the spawn history is shared across rooms.

**The team is defined by the relay, not by the game party.** Fleet → squads (each with a
mission) → characters with roles (tank, healer, buffer, dps, puller, scout, mule,
coordinator). Roles are inferred from the observed build (masteries/skills), manually
overridable, several per character. The coordinator is a role with deterministic succession
(lowest characterID), not an election; coordination may also come from a fleet console served
by the relay. The in-game party is a tool the orchestrator composes (Auto Share 8 / Each Get 4,
weighted exp, item rotation), not the source of truth.

**Two visibility lanes.** A private lane (the room, everything flows) and an optional public
pool: per-class "share with everyone" checkboxes — unique notices and sightings, monster
presence, zone occupancy, player observations, drop logs — while own live state (position,
build, inventory) and all coordination stay private. Public entries stay attributed to their
source, private beats win conflicts over public claims, and server-announced events (unique
notices) outrank individual sightings.

**Display.** The existing map (`lean-map.js`) gains a shared layer: same pictograms, reduced
opacity, fading with age, source on hover; pinned uniques; a Team panel listing peers, zones
and states; toasts and sounds for unique spawns and contacts. All of it works with hunting
stopped — the extension is useful on its own.

## Phase 1 — presence (implemented in 1.3.0, extended ever since)

`lean-team.js` + the Team page + `relay/` (reference server). Each character announces
`{hunting, alive, mode, level, role, townTrip, hasRes, pos}` every 5 s; peers expire after 15 s
of silence; reconnects back off 5→60 s; every failure path degrades to "team relay off"
behaviour. Settings are per character (`team: {enabled, url, token, role, assist, townSync,
share}`), stored under the usual profile prefix.

Tested in simulation (452 integration tests: presence, digests, edges, unique announcements,
assist, resurrection claims, town sync, console commands, drops, spot moves) and against a live
local relay (`relay/smoke-test.cjs`: hello/welcome, beat forwarding, the KV round trip, public
events). None of it has run with real characters on a live server yet — that is the one thing
simulation cannot replace.

## Verification honesty

Everything so far is verified by reading the game source and by mocked tests — neither is a
live-server confirmation. Each phase's notes must say what was only simulated. The relay URL
and room key are the player's own infrastructure; the bot never connects anywhere else.

## Maintenance

- Update URLs (`build-lean.py`, `lean-update.js`) keep pointing at this repository's builds.
- Team code lives in `lean-team*.js` with small integration points (settings key, one guard
  call in the controller, UI page, boot export) so merges stay clean.
- `relay/` is the one place with a `package.json` (the userscript itself stays bundler-free,
  plain JavaScript); the reference relay uses `ws` and nothing else.

## Open decisions (with the fork owner)

- Amend the base repo's AGENTS.md "no radar" rule deliberately when phase 2 lands: proposed
  wording — *an opt-in team intel layer shared through the player's own relay is allowed; the
  old self-contained radar panel stays out*. Until then, phase 1 changes nothing observable.
- Privacy posture: phase 3's player observations carry other players' names/positions to the
  player's own relay; the diagnostics "omit names and locations" promise needs a matching
  sentence here.
- Whether the beta player map flag is enabled on the target server (it would give every
  client all players in the division natively).
