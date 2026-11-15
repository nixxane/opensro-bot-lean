# nixxane bot: project context and working guide

This is a handoff for DeepSeek or another coding assistant. Read this first, then inspect the current repository. This document is a snapshot, not a substitute for checking Git and the code.

## Current baseline

- Snapshot date: 2026-10-11.
- Authoritative repository: `C:\sroserver\opensro-bot-lean`.
- GitHub: https://github.com/nixxane/opensro-bot-lean
- Branch: `main`.
- Latest userscript release at this snapshot: **1.2.42**.
- Release commit: use `git log -1 -- bot.lean.user.js` for the latest release.
- Install/download: https://raw.githubusercontent.com/nixxane/opensro-bot-lean/main/bot.lean.user.js
- Update metadata: https://raw.githubusercontent.com/nixxane/opensro-bot-lean/main/bot.lean.meta.js
- Latest validation: **234 integration tests**, JavaScript syntax check and headless browser checks pass.
- Latest work: local hunting session stats under Settings, with active time, level-aware XP/hour, net gold and confirmed event counters. Isolated validation passes; live-server counter accuracy and earlier buff swapping remain unconfirmed.

Check `git status --short`, `git log -5 --oneline` and the generated metadata before assuming these facts are still current. A documentation-only commit may follow the release commit without changing the userscript version.

## What the project is

A compact Tampermonkey userscript for `https://opensro.online/play*`. It adapts a supplied full OpenSRO Assistant into a lean bot with a Silkroad-style interface. It runs in the page context at document start and observes the game's simulation worker through a retained worker hook.

It is not the game server or the main game client. Do not edit those projects to implement bot features. The original full bot remains unchanged; its reviewed source is retained in `vendor/bot.js` as build input.

The panel lives inside an open shadow root on `#sro-bot-lean`. Runtime diagnostics are exposed through `window.SROLean`. The script detects another running SRO assistant and refuses to initialize a second copy.

## Architecture and files

| File | Responsibility |
| --- | --- |
| `build-lean.py` | Extracts selected original core code, applies Lean adaptations, assembles modules and emits release files. Runs the wardrobe generator first. |
| `vendor/bot.js` | Original reviewed assistant; preserve it. Contains retained world, commands, combat, potion and utility code. |
| `build-wardrobe.py` | Generates the retained wardrobe core. |
| `lean-settings.js` | Defaults, per-character persistence/import and pet-alert audio. |
| `lean-stats.js` | Page-local hunting session time, progression deltas and confirmed event counters. |
| `lean-controller.js` | Coordinates hunting, restocking, return, loot and independent services. |
| `lean-loot.js` | Drop eligibility, categories, pet selection/setup, pickup confirmation/retries and full-bag alert. |
| `lean-alchemy.js` | Single bag-weapon reinforcement with native result confirmation and bounded attempts. |
| `lean-party.js` | Party-matching acceptance and saved-listing auto-recruit. |
| `lean-speed-scroll.js` | Opt-in beginner +100% speed-scroll activation, buff confirmation and bounded retry. |
| `lean-town.js` | Scroll-based town service, selective pet storage, refills, repairs and reverse return. |
| `lean-resurrect.js` | Auto-resurrect fallen party members with a learned corpse-targeted skill. |
| `lean-walkback.js` | Saved-spot return and optional hunting resume. |
| `lean-navigation.js` | Collision-data capture and waypoint planning. |
| `restock.js` | Merchant route recording, buying and return; build uses its logic before the original UI section. |
| `lean-skills.js`, `lean-icons.js` | Learned-skill metadata recovery and verified asset/icon loading. |
| `lean-wardrobe-core.js` | Generated wardrobe appearance core; edit its generator/input adaptation, not generated output alone. |
| `lean-wardrobe.js` | Compact wardrobe browser. |
| `lean-reports.js` | Manual frozen report preview, optional one-frame screen capture and bounded uploads to the report receiver. |
| `lean-support.js` | Party support: group heal, heal lowest member, party buffs from attached effects; in view and range only, never walks. Off by default. |
| `lean-map.js` | Map page: game minimap tiles on a canvas, hunting area, entities, party; click to set the hunting spot. Outdoors only. |
| `lean-ui.js`, `lean-skin.css` | Controls, shadow-DOM panel, refresh and styling. |
| `lean-boot.js` | Initialization, lifecycle resets, hotkeys and keyboard isolation. |
| `lean.test.cjs` | VM-based integration tests against the generated userscript. |
| `lean.browser.test.cjs` | Headless Edge/Playwright tests using an isolated mock game and local assets. |
| `bot.lean.user.js`, `bot.lean.meta.js` | Generated installable script and update header; commit both for releases. |

Important runtime objects: `World` mirrors observed game state; `Cmd` submits native gameplay commands; `Hunt` drives combat; `Loot`, `Restock`, `WalkBack`, `Party` and `Resurrect` own their state machines. `Controller.tick()` runs every 100 ms. UI/wardrobe updates run every 500 ms. A local command dispatch is not proof of server success: wait for matching state changes where required.

## Features and behaviour to preserve

- Combat rotations, buffs, imbue, berserk, potions, loot, merchant restocking and saved hunt spots.
- Skill icons and recovered missing Thunderdragon Force level 13 metadata. Only learned skills are offered.
- Collision-aware walk-back and restock travel use loaded navigation data. Recorded routes remain supported.
- Loot categories include elixirs, powders and other alchemy items. Ownership, exclusion and capacity checks apply even to name-included items.
- Pickup success requires a matching inventory/gold gain. Despawn alone is not success. These are correlated state changes, not transaction-ID receipts.
- Pet collector has **no character fallback**. Broad native auto-grab is disabled and server confirmation is required before selective pickup commands.
- As of **1.2.11**, pets collect alongside combat, including casting and incoming attacks. Their pending pickups and retries must not take over the character's combat tick. The finish-fight setting applies only to **character pickup**.
- Pet requests still wait for busy inventory transactions and potion priority. Manual pause, death, stop and restock interruption remain respected.
- Pet-full alert: optional soft three-note chime and notice, once per full-bag episode, with a 30-second cooldown. Frees/rearms when space returns. Existing stacks may still merge. Loot includes a test-sound button.
- Wardrobe retains compatible paid cosmetics as local appearance previews, without changing real inventory or granting ownership.
- `F8`: start/stop hunting or return. `F7`: fold. `F6`: minimise to the icon or restore, like the ×. `Shift+F7`: hide/show the entire panel without stopping the bot.
- Typing in bot fields must not activate game shortcuts. `lean-boot.js` stops keyboard propagation for bot editing controls without preventing native editing defaults. Shadow-root focus must be used when protecting controls from refresh overwrites.
- Automatic potions remain controlled by their own switch, separately from hunting.

### Party automation

The party switches default off and are saved per character. They operate whenever enabled, **even while hunting is stopped**. This was explicitly requested by the user.

- **Auto-accept party-matching joins** accepts applications to the local player's own matching listing when solo/forming or party leader, with capacity and expiry checks.
- Ordinary party invitations, guild invitations and trade requests are not automatically answered.
- **Auto-recruit** includes matching acceptance and registers a missing listing from saved title, level range, purpose and sharing choices.
- Existing listings are preserved. Existing party sharing options override saved new-party options.
- Registration requires solo level 5+ or leadership with room. Capacity is 4 without shared EXP or 8 with it. Current client listing range is 1-90; title length is 1-50 characters. Job-suit restrictions determine allowed purposes.
- Missing listings can be restored when space opens, with at least 30 seconds between registrations.
- Unconfirmed registration retries automatically at most once every 30 seconds, only after a fresh snapshot explicitly reports no listing and no pending matching request. Stale or incomplete state never authorizes a retry.
- **Auto-resurrect** casts a learned corpse-targeted row (DeadBody target bit 128 of the client catalogue, the Rebirth family) on a fallen party member whose corpse entity is in view, preferring the highest mastery requirement. The sim worker replaces a press gid with the newest selection intent (`core.ts`), so the corpse is selected immediately before the press; the server walks the caster into reach and proposes the revival. The dead member still has to accept; refusals and timeouts are invisible to the caster.
- Offers repeat per member only after the server's 30 second answer window (31 s here) and clear when the member revives or leaves the party. A fresh manual-control command pauses offers for `manualPauseS`. Dead targets stay refused for every other targeted skill.
- Turning off Auto-recruit leaves an existing listing in place. The separate auto-accept switch may still be on; disable both to stop all party automation.
- Native acceptance command: `{ kind: 'party-match-answer', a, b, answer: 1 }`. IDs come from the current request, and expiry uses simulation time.
- Native registration command: `{ kind: 'party-match-register', registration: { party: 0, type, purpose, min, max, title } }`.

## Local evidence for game behaviour

The separate checkout `C:\sroserver\opensro` has been used read-only to verify native client contracts. Useful locations under `apps\client-next\src\engine`:

- `foundation\gameplay\party-matching.ts`: matching state, request correlation, deadlines, registration fields, capacity and purpose restrictions.
- `foundation\gameplay\social.ts`: party identity, leader, options and members.
- `runtime\simulation\worker\session\world\gameplay\gameplay.ts`: command dispatch and published gameplay state.
- `runtime\simulation\worker\session\world\gameplay\cos-pickup.ts`: native pet collection behaviour.
- `runtime\platform\platform.ts`: game keyboard listeners that can consume typed keys.
- `runtime\ui\ui.ts`: native UI command payloads.

Read applicable `AGENTS.md` files before working in any repository. Rules in the separate game repository are scoped there; this bot task does not authorize modifying it. Prefer verified contracts over guessed command names or fields.

## How we work

1. Inspect current files, Git status and relevant callers/tests. Preserve unrelated user changes.
2. For reported bugs, reproduce the behaviour with a meaningful regression test when practical. Explain the confirmed cause, then fix it in source modules.
3. Keep the bot lean. Avoid bringing back unrelated full-assistant panels or adding broad rewrites for a small feature.
4. Keep independent actions independent: pet pickup must not pause combat; party automation must not depend on hunting. Preserve explicit manual controls and lifecycle resets.
5. Test state-machine failures: missing state, pending transactions, expiry, duplicate commands, disconnect/reset and feature-disable paths.
6. Use plain language in UI labels and short progress updates. The user prefers implementation over repeated permission questions for already-authorized work.
7. Be accurate about evidence: mock tests are not live-account testing. Do not claim a sound was audibly verified merely because Web Audio nodes were scheduled.
8. Do not spawn subagents unless explicitly requested or required by applicable instructions.
9. Use UTF-8 explicitly for Python reads/writes and preserve LF. Windows default encodings caused a documentation write failure earlier; avoid implicit encodings and PowerShell output redirection for source edits.
10. Do not publish browser profiles, generated screenshots, personal settings, secrets or unrelated files. Stage explicit paths and review the diff.

## Versioning and release workflow

We use incrementing `major.minor.patch` versions. Recent small feature/fix releases advanced from 1.2.5 through 1.2.11. **1.2.11 is newer than 1.2.9**; the patch component is an integer, not a decimal digit. Do not reuse a published version for changed script behaviour.

For a userscript release:

1. Edit source modules. Update documentation and meaningful regression tests.
2. Increase **both** version strings in `build-lean.py`: the userscript `@version` and runtime `VERSION`.
3. Build and validate from the authoritative repo:

```powershell
python build-lean.py
node --check bot.lean.user.js
node lean.test.cjs
node lean.browser.test.cjs C:\Users\nizam\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules
git diff --check
```

The browser test needs elevated execution in the current Codex environment. It launches headless Edge with the isolated `browser-test-profile/` directory, generates local screenshots and uses simulated game state. Do not substitute the user's browser profile or connect to their live account without authorization. On another machine, adapt the Playwright package directory and Edge executable path.

4. Review source and generated diffs. Check that both generated headers and runtime version agree.
5. Commit source, tests, relevant docs and both generated release files together. Push `main` to `origin`.
6. Verify the push. Where diagnosing delivery issues, fetch both public raw files and check their actual versions; local build success is insufficient.
7. Update local copies as below. Report version, commit, validation and limitations.

Documentation-only changes do not need a userscript version bump or regenerated artifacts.

### Local copies and authorization

The user has authorized committing/pushing bot updates to the public repo and updating the Downloads copy with a backup. Do not repeatedly ask for permission for these authorized actions; comply with any execution-environment approval requirements.

- `C:\sroserver\srobot`: development mirror. Copy changed Lean source/build/test files and generated artifacts. The repo README is copied there as **`LEAN-README.md`**, not over the original project's README.
- `C:\Users\nizam\Downloads\srobot`: install copy. Back up existing `bot.lean.user.js` and `bot.lean.meta.js`, then replace them and verify hashes against the authoritative repo.
- Backup naming used: `<filename>.before-<new-version>-yyyyMMdd-HHmmss.bak`.
- Never overwrite original `bot.js` or `bot.original.js` copies.
- Latest completed install-copy update: 1.2.11, backup suffix `before-1.2.11-20261010-105257.bak`.

## Tampermonkey update issue: last diagnosis

Immediately after publishing 1.2.11, the user reported "found no update."

Direct HTTP checks showed:

- `main/bot.lean.meta.js` still served **1.2.10**.
- `main/bot.lean.user.js` served **1.2.11**.
- Metadata at immutable release commit `1b91c56` correctly served **1.2.11**.
- Raw responses advertised `Cache-Control: max-age=300`.
- Adding `?v=1.2.11` to the metadata URL still returned the older metadata during that check.

This was stale public metadata delivery, not a missing local version bump. Do not assume query parameters always bypass the cache. Suggest waiting and checking again, or opening the direct userscript install link and verifying the installer shows the desired version. Reload the game after updating. If it persists, inspect the installed version and update/download URLs before changing code.

## Recent release history

| Version | Commit | Change |
| --- | --- | --- |
| 1.2.5 | `f7d4e02` | Shift+F7 hides/restores the panel. |
| 1.2.6 | `6225f85` | Pet setup only during active hunting; deferred revival return; preserve resume intent on repeated walk-back. |
| 1.2.7 | `7db5468` | Pet-full chime, toggle and test button. |
| 1.2.8 | `78d8267` | Opt-in party-matching auto-accept. |
| 1.2.9 | `599c5a8` | Saved listing and independent auto-recruit. |
| 1.2.10 | `b585a53` | Isolate field typing from game shortcuts; preserve focused controls during refresh. |
| 1.2.11 | `1b91c56` | Pet collection runs alongside combat; finish-fight is character-only. |
| 1.2.12 | `0d4e1e3` | Auto-resurrect: Rebirth cast on fallen party members, opt-in and independent of hunting. |

## Remaining practical limitations

Live-server combat/pickup timing, navigation, merchant purchases and party registration/re-listing have not been validated on the user's account. Browser tests are deliberately isolated. Collision planning is conservative and mainly outdoor/town-oriented; dungeon routes and narrow passages may require recorded routes or manual intervention. The server remains authoritative over movement, loot, party membership and transactions.

Full-page reload matters: the worker hook and keyboard guard should install at document start, before game listeners. Updating the script file does not replace the already-running copy in an open game page.

## Resurrection during hunting: 1.2.13

The published v1.2.12 implementation runs independently of hunting, including while stopped. A regression test showed its cast could be overwritten by the hunting tick in the same controller iteration. v1.2.13 makes `Resurrect.tick()` report action ownership while casting; the controller keeps potions running and yields fighting/loot movement until the authored action duration plus a buffer (or 6.5-second fallback) ends and any observed cast settles. Hunting stays enabled and resumes afterward, without waiting for party acceptance. Existing casts, MP, inventory, sitting/mounting, manual control, return travel and shopping are respected. Visible corpses outside the native skill range are skipped when range is supplied. Five new regression tests cover actual hunting-target restoration under attack, cast priority, transaction/MP gates, travel/shop exclusion and observed cast holds. No live-account resurrection has been verified.

A concurrent v1.2.12 implementation was found on origin and preserved. An unpublished alternative remains recoverable at local branch `saved/auto-res-targeted-0709284`; it is not part of the installed script.

## Configurable res travel and beginner speed scroll: 1.2.14

`party.resRadius` defaults to 300 game units (30 m), controlled in Settings → Party. During hunting, only visible corpses within this radius of the saved hunt spot are eligible; while stopped, the trip starts and returns at the current position. `Resurrect.trip` owns approach/cast/return movement via `Navigation.next` and keeps combat from replacing it. Cast range remains the native skill range (150-unit conservative fallback for absent metadata). Each leg has 30-second absolute and 12-second no-progress limits. Radius changes, member loss/revival, manual control, F8/Stop all, blocked paths and return failure are handled; return failure stops hunting. Native collision coverage is required for res travel, with no blind fallback.

`potion.speedScroll` defaults off. `lean-speed-scroll.js` uses only beginner scroll item 24198 (`ITEM_ETC_SPEED_UP_BASIC`), whose buff is skill 31107 (+100% for one hour); local game source confirms both. The code also recognizes the existing mall +100% buff 5411 and active catalogued speed buffs, without consuming paid items. It runs during hunting, walk-back, restock or res travel, after potion priority. Item dispatch is not confirmation: it waits for the buff, backs off on missing confirmation and caps attempts at three. Buff appearance rearms it; UI toggle resets attempts. Scrolls cannot interrupt an unobserved resurrection cast hold.

83 VM integration tests and the isolated browser UI checks passed. New tests cover approach/cast/return, radius anchoring and changes, collision detours, blocked/missing coverage, cancellation, revived targets, return timeout, exact scroll identity, existing buffs, no paid consumption, gating, activation confirmation and bounded retries. Live trips, scroll activation and resurrection remain untested on the user account.

## Hotan scroll town cycle: 1.2.15

The user authorized the return-scroll → Hotan storage/refill/repair → reverse-return cycle. `lean-town.js` owns `Town.trip`; its opt-in settings live at `potion.restock.town`. Enabled town service takes precedence over the existing walking restock. It uses the HP/MP selections and low/refill counts already in Supplies. A pickup-pet trigger defaults to ≤1 free slot. Store filters cover equipment/elixirs/powders/alchemy, with Other off and Keep name exclusions. Potions, cures, selected supplies, travel scrolls and beginner speed scrolls are protected; existing character bag items are never selected for storage.

Setup is deliberate: manually bind recall to Hotan, save the scroll arrival point, then stand near and select/save warehouse, potion merchant (shop must be open), smith and teleport NPC. Each service saves the user's reachable standing position plus the NPC identity/location. Town walking requires collision coverage, with no blind fallback. Arrival validates against the saved town point; no hardcoded Hotan NPC IDs and no automatic recall-binding change.

Native contract verified in the separate game checkout: return item type `0x09ec` uses `item-use`; reverse type `0x19ec` is consumed through the teleport NPC menu, `travel-gate {gid,type:5,target:2}` (last recall point). This is not a bag item-use or premium-package command. Select NPC, request `npc-talk`, wait for matching `npcConversation.phase === 'menu'` and capability `0x20000000` before reverse. `action/reversereturn.go`, `foundation/ui/npc-talk.ts` and runtime UI/core show this flow.

Pet storage requires `cos-transfer {gid,toCos:false,source,destination}` into one reserved character bag slot, then `storage-move {move:{type:2,source,destination,quantity:0,gold:0}}`. Correlated source disappearance and exact destination reference/quantity confirm each move. Staged items can remain in the character bag after failure; do not silently deposit other character items. Storage full stops before another transfer. Potion purchases require exact requested quantity gain. Travel scrolls refill to two only from single-item gold offers; if unavailable, spares must already be carried. No Item Mall buying. Repairs use `shop-repair {mode:2,slot:0}` and require restored durability, using native variance and magic-option maximum calculations.

`Controller` gives town service priority while retaining independent Party and emergency Potion ticks. It suspends combat, loot, auto-res and speed-scroll activation during the trip. Expected entering-world/reset transitions during recall/reverse waits preserve the trip; disconnects, unexpected resets, manual control, settings/profile changes and F8 cancel. Scroll arrival has a 90-second timeout even outside world, town legs 20-second no-progress/120-second total bounds, inventory operations 15-second confirmation limits with no repeat sends, and the whole trip a 15-minute cap. Stop requests `return-cancel` for an observed owned scroll cast. Final supplies, spare travel scrolls and durability must be valid before returning. No unfinished trip survives a full page reload.

99 integration tests, JavaScript syntax and isolated headless Edge checks passed. Sixteen new tests cover the full cycle, storage filters/protections, setup capture, bounded failures, fresh shop acknowledgement, exact quantity confirmation, scroll replenishment, repair confirmation, phase/reset persistence, manual/F8 cancellation and independent services. Browser tests exercise the actual toggle, saved arrival point, pet threshold and storage/Keep controls. Live-account travel, transfer fees and scroll/repair timing have not been tested. Update README/source/tests/build/artifacts in the development mirror and back up the Downloads install artifacts per the normal release workflow.

## Pet-full departure fix: 1.2.16

User reported the pet-full chime without a return. Reproduced a controller starvation bug with a failing regression test: Town.tick returned false before creating a trip whenever World.isCasting or inventoryPending was true, handing control back to hunting and allowing it to perpetuate those busy states. Town now latches a trip immediately on the enabled trigger, stops worker attack/movement with a move to current pose, then waits in recall phase for cast/inventory settlement. No more combat/loot ticks run during that wait. A 30-second settlement timeout fails safely. Existing opt-in, manual/travel exclusions and preflight prerequisites remain. This confirms a code defect, not the user's exact live settings; an asynchronous question requested their town-toggle state/status.

Town.status() reports disabled automation, readiness or missing setup/scrolls before triggering. Full-pet toast explains that the chime alone does not enable automatic return. Three new tests cover full-pet latching during casts/pending pickups, settlement timeout and readiness messages. Total 102 integration tests plus syntax and isolated browser checks pass. Live return remains unverified.

## Repair merchant and world statue: 1.2.17

User's screenshot showed arrival/warehouse/potion merchant saved, with smith and gate missing. User then reported Hotan's weapon merchant was rejected and the teleport target is a world statue. A new regression test failed before fixing the smith bit: native `NpcTalkFlagRepair` is `0x8`, whereas previous code incorrectly used special-trade `0x800`. Both save and open now require the repair bit. `serviceEntity` admits native `teleport` entities for gate save/lookup, preserving NPC support. The full-cycle fixture now uses an actual teleport-kind gate and smith capability `9`.

Native selection opens `npcConversation` directly. `npc-talk` requires capability `2` and is invalid on a statue that offers teleport/reverse only. Gate opening now waits for confirmed selection, reverse capability and matching menu without dispatching Talk. Evidence: game `npccapability.go`, worker `entities/entities.ts`, `gameplay/npc/npc.ts` and `gameplay.ts` selection/talk handling. UI labels are Repair merchant and World statue / teleport. Validation lists only missing services, and saving a service clears an old failure status. Existing saved points remain compatible. 104 integration tests, syntax and isolated browser checks passed; no live-account validation.

## Variable recall landing area: 1.2.18

User reported return-scroll use followed by a stall and explained that landing coordinates vary around the same area. Reproduced a nearby landing stuck in recall-wait with a failing test: the previous fixed 120-unit (12 m) arrival radius was too tight. New `potion.restock.town.arrivalRadius` defaults to 500 units (50 m), adjustable 10–150 m under Supplies. Old profiles inherit the default. Reverse return retains its 120-unit destination radius.

Expected world reset during recall-wait/reverse-wait now marks travel confirmation, and the tick still requires world state, fresh local entity, settled inventory and no return cast before accepting the destination. `Town.enter` clears the transition flag for each phase so reverse arrival cannot reuse recall confirmation. Both reset-only and phase-based transitions are tested. Status reports missing travel confirmation, unsettled scroll state, actual distance versus accepted tolerance, and collision-map waits during town walking. Four new tests bring the suite to 108; syntax and isolated browser tests also passed, including persistence of the tolerance control. Live-account arrival/navigation remains unverified. An asynchronous question requested the user's exact stalled status; no reply at implementation time.

## Town movement waits: 1.2.19

User reported slow loading ending with town movement blocked or collision data unavailable and requested waiting. Reproduced cancellation in the collision-wait regression after advancing 16 minutes. Town.walk now waits on missing collision coverage and no-route results, retrying every five seconds without blind movement. After 20 seconds without progress it clears the stale route and waits five seconds before replanning. Removed the two-minute movement leg limit and whole-trip 15-minute cap so they cannot cancel these waits. Individual scroll, service and transaction confirmation timeouts remain. Town.enter clears retry state; manual control, F8, settings changes and unexpected travel still cancel. The updated long-wait regression verifies automatic recovery when collision data arrives; a new test verifies retry spacing, no command flood, no-progress replanning and F8 cancellation. 109 integration tests, syntax and isolated browser checks pass. Live-account navigation remains unverified.

## Elixir storage and weapon-merchant sales: 1.2.20

User reported a no-walkable-route wait after storage, requested storing only elixirs and selling the rest at the weapon store. Town.eligible now selects only unprotected elixirs regardless of legacy store category settings. Town.sellable selects other unprotected pet loot; supplies, travel scrolls, beginner speed item, unknown types and Keep names remain protected. UI replaces category controls with the fixed policy. Weapon/repair shop now enters sell before repair; native cos-shop-sell sells directly from the pet bag. Native command, ownership, shop and payload contract verified read-only in game gameplay.ts, inventory.ts cosTrade and merchant.ts. Full-stack disappearance confirms each sale; no repeat on rejection/partial or missing acknowledgement. Selection and pet identity are checked; original bag items are never sold. Capacity is checked after sales instead of after storage.

Town movement accepts a collision-checked reachable point within up to 60 units of the saved approach, reduced to preserve native 200-unit service range. Navigation.next first attempts the exact goal, then retries A* with a bounded arrival radius only when no exact route exists. Other callers retain exact-goal routing. Waiting status names the service. A blocked saved-tile test verifies recovery and collision clearance; this does not prove the cause of the user screenshot, which does not expose the live collision map. Full-cycle test now confirms elixir-only storage plus non-elixir sales and protected survivors. New tests cover pending/partial sale timeout without duplication, wrong merchant, pet replacement and approach routing. 112 integration tests, syntax and isolated browser checks pass. Live-server selling and the reported Hotan route remain unverified.

## Valuable equipment sale protection: 1.2.21

User requested SoS and other good equipment never be sold. Reproduced a failing test showing the 1.2.20 sale predicate accepted native rarity-2 equipment. Native tooltip/item-slot code confirms rarity 2 for all seal tiers, ordinary rarity 0; InventoryItem carries plus and magic. Town.disposable now admits equipment only if tooltip.fields.rarity is exactly 0, plus is exactly 0, magic is an explicit empty array, and codename does not end in RARE/MAGIC/LEGEND/MYTH (optional HONOR). Thus enhanced, blue/magic, nonordinary and incomplete equipment metadata remain protected in the pet, not storage. Existing name exclusions and supply protections still apply. UI documents the policy. Two regression tests cover seals, other rarity, enhancements, magic, missing fields and confirmed ordinary-only sale followed by repair with valuable gear retained. 114 integration tests, syntax and isolated browser checks pass; live server sale behavior remains unverified.

## Native Hotan collision investigation: 1.2.22

User reported persistent collision-map/no-route wait after warehouse deposit on the way to Manina and requested thorough investigation. Traced worker navigation capture, reset handling, product schema, native terrain contact and A* parsing. Game source stayed read-only. Native object-navigation.ts navContactDetail ignores zero-flag outlines; terrain-indexed objects ignore internal edges and 0x10 surface borders and use terrainVisit registration. The bot converted these into global 2D walls. It also blocked both directions of native one-way edges. Fixed these edge rules, ignored empty terrain registrations and retained winding/source-cell direction for flags 1/2 with conservative handling of missing or degenerate winding. Real blocking outlines and terrain remain enforced.

Added lean.navigation.native.test.mjs (optional game-root argument, read-only licensed local assets). It uses the game generatedRoot resolver, native navigation resource loader, NPC 2083 warehouse and 2074 Manina at region 23687, and native createNavigation clipper. Resolved map contains nine regions and 67 objects. Before the fix all 36 sampled warehouse/manina approach pairs failed. Afterward 30 connected pairs route; every chord passes native clipping with sequential resolved height. The remaining six share the sample 60 units north of the warehouse, behind its structure; native grid traversal is confined there too (53 visited centres), so the test retains that limitation explicitly. No timeout extension or unchecked straight-line fallback was added. Two portable regressions cover ignored edges, retained walls and directional crossing rules; 116 integration tests plus browser/syntax/native checks pass. Exact user-saved coordinates and live account movement remain unverified.

## X-Large town potions and revised equipment sales: 1.2.23

User confirmed the collision fix works, withdrawing the preceding route-failure report. They requested X-Large purchases and selling all ordinary equipment regardless of plus. Town.supplies forces native ITEM_ETC_HP_POTION_05 ref 8 and ITEM_ETC_MP_POTION_05 ref 15, verified against local native itemdata/textdataname. It preserves enabled kinds/thresholds/targets from Restock and is used for trigger, validation and trip snapshot; buy/final checks use that snapshot. Offers still need matching native potion type and single-item gold semantics. Missing X-Large stock stops instead of substituting small. Walking-route buyer remains selectable; UI explicitly describes the town override.

Town.disposable now permits equipment rarity 0 or 1 regardless of plus/magic options; rarity 2 (all seals), rare/magic/legend/myth codenames, other/unknown rarity and Keep names remain protected. Missing plus/magic alone no longer protects ordinary gear. Updated actual-sale regression sells +12 blue ordinary gear while retaining sealed gear. Two new tests verify both X-Large purchases despite old small selections and no small substitution. 118 integration tests plus syntax/browser checks pass. No navigation changes were made following the withdrawn screenshot. Live purchases and sales remain unverified by the assistant.

## Editable town stack targets: 1.2.24

User explicitly confirmed they prefer 2 stacks HP and 6 stacks MP, with editable amounts. Added potion.restock.town.stacks {hp:2,mp:6}; existing profiles inherit through deepMerge. Town.supplies now maps those counts to totals at native 50 potions per X-Large stack (100 HP / 300 MP). Buy switches and low thresholds still come from Restock, while old walking-route target quantities no longer control the town cycle. UI adds distinct labelled whole-stack fields (1–200). Preflight rejects fractional/out-of-range stacks and low thresholds not below target. Purchases count current bag stock and buy the difference, retaining gold/space/pending confirmation rules. Trip snapshot and final reverse checks use the computed targets; editing stack config during a trip triggers existing settings-change cancellation. Two tests cover defaults/top-ups and invalid target handling; browser checks exercise editable stack controls. 120 integration tests, syntax and browser checks pass. Live purchase execution remains unverified by the assistant.


## Departure and death recovery: 1.2.25

Reproduced return-scroll starvation with repeated potion dispatch in a controller regression: each potion renews the 350 ms hold before Town can send the scroll. Active recall now reserves the next settled item-use window after one emergency potion opportunity; busy cast/inventory states retain potions. Departure timeout is checked before the potion hold. Character bag capacity <=1 now also triggers recall. Full-character/protected-only-pet checks run after town arrival, so they cannot strand the character hunting; unresolved bag space stops in town with explicit instructions. Existing character bag items are still never sold or stored. Final reverse requires at least two free slots to avoid repeat capacity recalls.

Town.revive defaults true (effective only with the town cycle enabled), overriding the old stop-on-death default while allowing opt-out. Controller handles death before town actions, sends native rebirth choice 1, preserves recovery intent through bootstrap, waits for inventory/local-player settlement, and begins services at the saved town arrival area without consuming another return scroll. Reverse still uses gate type 5/target 2. Confirmed prior recall origin is remembered for arrival verification within the session, reset on profile/character changes; saved hunt center is the fallback. Nearby party resurrection resumes in place. Death during a town trip, F8 cancellation, opt-out and same-character bootstrap are tested.

127 integration tests plus syntax and isolated browser checks pass. Live-account death/travel behavior remains unverified.


## Standing publication preference (2026-10-10)

After the 1.2.25 push was blocked by automatic approval review, the user explicitly instructed: "always publish tog github." Publish completed bot updates to https://github.com/nixxane/opensro-bot-lean as part of the release workflow, including the prepared 1.2.25 release. This is standing authorization for this bot repository.


## Standing Discord release preference (2026-11-15)

The user instructed: "always do a release on discord." Every bot release is also announced on the project's Discord: creating the GitHub release fires the `release` event that runs `.github/workflows/discord-release.yml`, which posts the release notes to the `DISCORD_WEBHOOK` secret. A manual release must therefore create the GitHub release (e.g. `gh release create v<version> --notes-file notes/<version>.md`), not just push the commit. The automated `release.yml` workflow already does this for merged PRs.


## Toggle-required departure stall: 1.2.26

User clarified that on the latest version the bot only notices low potions/full inventory and recalls after toggling off/on. Status text was unavailable. Reproduced a matching failure in 1.2.25: Town.begin ignored a false Cmd.move result when a hunting move had just used the 550 ms rate limit. The worker could continue its combat loop while Town waited for combat to settle; toggle sends another stop. Town now tracks successful halt dispatch, retries rejected stops through normal Cmd.move guards, and allows at most three successful stop sends spaced by 1.5 seconds while casting continues. The existing 30-second departure limit remains; no repeated scroll dispatch is introduced.

A dormant Restock.trip also excluded Town.tick while the enabled town setting prevented Restock.tick from running. Eligible town departure now clears that old walking trip and takes ownership. Recording, walk-back, open shops/storage, manual control, and disabled automation remain exclusions. Added regression coverage for both low-stock and pet-capacity triggers, recent-move rejection, ignored initial stops, pending movement queues, dormant restock state and F8 cancellation. 131 integration tests, syntax and isolated browser checks pass. These reproduce code defects matching the symptom; the exact live stalled state is still unverified.


## Native scroll acknowledgement and live diagnostics: 1.2.27

User still reports the toggle-required stall after 1.2.26 and requests thorough investigation. Browser inspection via cua failed to initialize because the sandbox launcher cannot enumerate D:. No live snapshot was obtained, so the exact user's runtime cause remains unconfirmed. Audited ticker, controller/toggle ownership, movement admission, World.applyGameplay, native gameplay/inventory use and server returnscroll.go. Native item-use can be refused before dispatch (inventory busy/cooldown); successful server return consumes a scroll and publishes returnScroll/travel. The old bot treated local Cmd.raw success as acceptance and only waited 90 seconds. A new regression reproduces a busy-lane rejection followed by fresh idle state remaining stuck until toggle.

Town.sentScroll/checkScroll now track slot/ref/count, original game snapshot, acceptance and attempt count for recall and reverse. After five seconds, retry only with a new snapshot explicitly reporting inventoryPending false, the unchanged scroll, no return cast, no world transition and no character cast. Any observed consumption, return cast or transition permanently marks that attempt accepted. Stale/missing/busy state never authorizes resending. Maximum three sends per leg; recall attempts reset after confirmed town arrival. Inventory timeout/resynchronization errors stop with reconnect guidance because native replies lack transaction IDs. Existing travel, manual stop, death and transaction safeguards remain.

Town.blocked provides precise gating reasons; main status shows town messages on every tab, and the header shows the runtime version. Town.history records up to 120 changed state snapshots and records before stopAll clears anything. Supplies exports these via Save return diagnostics; history survives bot toggles within the loaded page, not reload. Snapshot fields cover controller/phase/trigger, blocked reason, inventory pending/casting/scroll acceptance, supplies/capacity and error, not full inventories. UI download and visible version are browser-tested. 139 integration tests, syntax and isolated browser checks pass. These tests include fresh native-style gameplay snapshots, accepted/spent/last-stack/transition cases, reverse refusal, stale/missing state, timeout, retry caps and F8. Live account confirmation remains required.


## Death-return hunting handoff: 1.2.28 (2026-10-11)

User confirms revival, services and reverse travel succeed but hunting does not resume. Reproduced a death trip landing 250 units from hunt center (within 400-unit hunt radius), with no remembered scroll point: reverse-wait required <=120 units from the assumed center and never released the controller. Death trips now snapshot the hunting area at begin and accept either the known scroll origin within 120 units or the saved hunt area after confirmed settled travel. Ordinary town trips retain the precise origin check. Arrival updates the remembered scroll point from actual pose.

Also removed the global potion cooldown guard from command-free recall/reverse/revival arrival confirmation; fresh emergency potion use could otherwise postpone the hunting handoff indefinitely. Guards for transition, inventoryPending, active returnScroll and fresh local entity remain. Five regressions cover actual native attack dispatch after off-center arrival, potion starvation, stale remembered points, negative travel/area cases and manual stop. 144 integration tests, syntax and isolated browser checks pass. Exact live stalled status was not observed. Keep README simple; no release history there.

Browser validation initially failed at download.path with the reused test profile. A fresh isolated profile passed the complete suite; the browser harness now creates a fresh run directory under ignored browser-test-profile/ and explicitly enables downloads.


## Reverse arrival tolerance: 1.2.29

User requested 30 m arrival tolerance. Changed reverse-wait radius from 120 to 300 game units (12 to 30 m), applying to normal and death town trips. Death-trip hunting-area acceptance and all travel/settlement checks remain. Town recall tolerance remains independently configurable (50 m default). Existing 144 integration tests and JavaScript syntax check pass.


## Beginner speed scroll during combat: 1.2.30

User reports the beginner scroll is still unused and confirms Grass Walk is not active; the exact live Supplies status is unknown. Reproduced a controller failure with a native-shaped unresolved combat cast: even after inventory settlement, SpeedScroll.tick refused every attempt while World.isCasting() remained true. Read-only native verification shows gameplay.ts sends item-use directly to inventory.use; skillitemuse.go installs the beginner scroll timed effect without initiating or waiting for a combat cast. Removed only the ordinary combat-cast gate. Resurrection holds, pending inventory, emergency potion priority, sitting/mounting, manual pauses, shops/storage, existing speed buffs and bounded confirmation retries remain. An active return-scroll cast explicitly blocks speed-item dispatch.

Supplies now reports inventory, item-use, manual, resurrection, sitting/mounting and service waits instead of retaining an unrelated old message. README keeps a single optional setup instruction. Three new regressions cover activation/confirmation during combat after inventory settlement, emergency potion priority during a cast, and visible wait reasons followed by automatic recovery. Updated exclusion coverage includes return-scroll travel. 147 integration tests, syntax and isolated browser checks pass. This fixes a reproduced code defect; the user's exact live failure and successful scroll activation remain unverified. Publish and mirror using the normal release workflow; reload the game after installing.


## Pet pickup delays and skipped drops: 1.2.31

User reports late/missed pet pickup with Finish current fight disabled. Screenshot confirms pickup-pet mode, collection enabled, 30 m pickup radius, two retries and ten free pet slots. The finish-fight switch was already character-only. Reproduced pet dispatch and retry starvation at HP 65% with a 60% potion threshold, and MP 45% with a 40% threshold: Loot.pressed used a ten-percentage-point margin, so it blocked pickup when no potion was due. It now reserves only 350 ms after an actual Potion.lastUse send, with native inventoryPending still blocking transactions. Controller continues to run potions first and combat alongside pet actions.

Loot.init previously assigned every shared game-error to the pending pickup. The capacity regex classified any mention of inventory as full, so Inventory command unavailable / Inventory rejected could suppress a drop until the unchanged pet bag changed. Pet failures now accept only the native COS-ground/transaction refusal strings verified in read-only gameplay.ts and inventory/inventory.ts; unrelated combat/item-use errors are ignored. Generic inventory refusals use bounded retry/backoff instead of capacity suppression. Capacity recognition requires explicit full/space/capacity wording; character full-bag coverage remains. Native manual cos-pickup owns the shared inventory lane and can approach before granting, so pending transactions and confirmation checks remain necessary. No game/server or original-bot changes.

Drop selection now ranks by pet distance while retaining the configured player/hunting range, pet 50 m reach, ownership, category, exclusions and capacity checks. Pet status reports collecting, retry pending, actual potion wait or inventory wait. Six new regressions cover the HP/MP margin, retry recovery, unrelated errors, temporary native inventory failures, nearest-pet selection and actual potion/pending priority with ongoing combat. All 153 integration tests, syntax and isolated browser checks pass. These reproduce code defects matching the symptoms; live account pickup timing and successful collection remain unverified. Publish, mirror and back up install copies using the normal release workflow.


## Auto-recruit registration recovery: 1.2.32

User reports Auto-recruit needs toggling off/on to form a party. Reproduced the registration latch: after a local Cmd.raw send, Party.registration remained set indefinitely, including after a fresh native-style rejection with own:null and pending:null. Toggle cleared this latch. Party now retains the send snapshot, waits 15 seconds for confirmation, and releases the latch only after a newer gameplay snapshot explicitly reports own:null and pending:null with no application or join in progress. Existing 30-second lastRegisterAt throttle bounds automatic retries while enabled; each attempt revalidates leadership, capacity, level, saved title/range, job purpose and party sharing. A confirmed listing clears the latch and is preserved. Unknown/stale state or an outstanding native matching request never authorizes resending.

Read-only party-matching.ts verification confirms register sets pending:'register'; a rejection clears matching pending and returns result, while success publishes own immediately. Native request admission rejects both an outstanding request and an existing owned listing. Auto-recruit still runs with hunting stopped and accepts applicants through the existing correlated matching path; it does not invite arbitrary players or fabricate party members. UI describes automatic recovery rather than requiring a toggle.

Four new regressions cover fresh rejection recovery at the 30-second boundary, pending/stale/incomplete state and applications/joins, repeated bounded retries plus disabling, and leadership/capacity/settings revalidation. The first regression failed before the fix (one registration instead of two). All 157 integration tests, syntax and isolated browser checks pass. Live account registration and party formation remain unverified. Publish and mirror through the usual workflow; README remains simple and unchanged.


## Shared-EXP join cutoff investigation: 2026-10-11

User reports matching acceptance stopped after four people were in the party and confirms Share EXP was enabled. Could not reproduce on 1.2.32 in isolated simulation. Added three regression tests: successive correlated applications from one through eight members for all shared-EXP option combinations (1, 3, 5, 7), using either Auto-recruit alone or the separate acceptance switch; a full eight-member party losing a member and accepting a replacement; and native party options overriding contrary saved recruitment settings. Successive requests also cover no observed intervening request:null snapshot and repeated ticks without duplicate acceptance. All 160 integration tests pass. Read-only native party-matching.ts confirms capacity is eight with options bit 1 set and four otherwise; social.ts member snapshots include the entire roster.

No runtime change or userscript version bump: these tests pass against the existing published 1.2.32. This does not reproduce or resolve the reported live failure. Further diagnosis needs live party/matching state during the stall (owned listing, native sharing options, leader identity, incoming correlated request and its deadline); a Share EXP checkbox alone does not identify which gate blocked acceptance. No live-account interaction was performed.


## Shared potion refill counts: 1.2.33

Replaced separate town stack targets with the common potion.restock.hp/mp.target counts. Supplies now labels these HP refill to / MP refill to; entering 1000 means a total of 1000 MP potions after refill. Walking restock, low-supply town trips, full-bag trips and revival use these same counts, with existing buy switches and low-stock thresholds. Town still buys X-Large potions, counts existing stock, respects gold/space and confirms each purchase. Trips retain their starting supply snapshot; target edits apply to the next trip.

Defaults remain town-equivalent 100 HP / 300 MP. Profile migration preserves enabled legacy town mode's stack amounts by converting to counts; otherwise walking-only saved counts are preserved. Legacy stacks are then removed so later reloads cannot overwrite edited shared targets. Two additional integration tests cover 1000 MP on all town triggers, buying only a missing 25, and one-time migration. Browser checks edit the shared MP field to 1000. README stays short. Live town purchases remain unverified.


## In-panel update notice: 1.2.34

Added lean-update.js. Updates.start runs at boot once, checks immediately and every 15 minutes independently of bot/character state. Fetches the public GitHub commits/main SHA, validates a full lowercase 40-character hash, then reads bot.lean.meta.js at that immutable commit. Numeric three-component version comparison handles patch 100 versus 34. A newer release shows an Update <version> button beside the installed version; clicking opens bot.lean.user.js at the same SHA in a new tab with noopener/noreferrer. No fetched code is executed, no automatic install/reload occurs, and no hunting commands are issued. Tampermonkey's existing update/download URLs remain on main.

Requests omit credentials/referrer and use no-store; a 15-second AbortController bounds the two-request check, with no overlapping checks. Offline failures, HTTP errors, rate limits and malformed replies stay silent and leave any previously valid notice intact. Checks need page fetch access to api.github.com and raw.githubusercontent.com; verified API HTTP 200 with CORS * from this environment, but the live game's policy/network and Tampermonkey installation prompt remain unverified. Tests mock network responses rather than use the user's account.

Four new integration checks cover numeric comparisons, pinned metadata/installer URL and manual opening, malformed/offline recovery and retained notice, overlap prevention and exactly one 15-minute schedule. Browser checks mock a newer release and click the real header button, verifying the exact install URL; desktop/mobile screenshots inspected. All 166 integration tests, syntax, browser and whitespace checks pass. Update module is included by build-lean.py and exposed as SROLean.updates for diagnostics. README adds one sentence about updates.


## Waiting reasons and shareable bug reports: 1.2.35

Added lean-diagnostics.js and a persistent Copy diagnostics button below the main status. Waiting lines explain hunting/manual/shop waits, pet setup/potion/inventory/pickup-confirmation waits, party listing/leadership/capacity/expiry/correlation gates, missing town service points and scrolls. During buying, shows current HP/MP stock versus trip target. This observes existing state and never submits gameplay commands or changes automation gates. A sent party acceptance is described as waiting for confirmation, not confirmed membership. Generic messages are used when exact native causes are unknown.

Reports include version, a current snapshot, at most 30 recent changed snapshots and 12 error categories. Selected settings are numeric/boolean only. Snapshot fields include capacity, pending transactions, safe phase enums, clock/deadline state and attempt counts. Raw profiles, logs, errors, chat, names, account/character IDs, listing text, name filters, locations, inventory items and target IDs are excluded. Error/warning events are reduced to a small category allowlist (or unclassified-error); raw text is never retained in this report. Read-only snapshots are sampled by the existing UI update timer and tolerate missing game state. History remains in memory across bot toggles and clears on page reload. Existing Supplies return-diagnostics download remains separate and unchanged.

Copy uses the browser clipboard only on explicit click. Success says Copied—paste this into your bug report. If permission/access is blocked, a read-only selected textarea appears near the top of the panel with Close report; nothing is sent externally. Added five tests for party gates, pet and refill reasons, privacy with injected identifying strings, bounded/toggle-retained/missing-state history, and clipboard success/fallback. Browser checks exercise real Copy diagnostics and fallback selection/close at desktop and mobile widths. Initial fallback placement below the settings pane failed the close-button viewport test; moved above the pane. All 171 integration tests, syntax, browser and whitespace checks pass. Live-account stall diagnosis still awaits real reports; simulated tests do not prove reported stalls are fixed.


## Weapon auto alchemy: 1.2.36

Added Alchemy tab and lean-alchemy.js. User explicitly authorized the proposed first version: one bag weapon, desired + level, attempt limit, compatible weapon elixirs and optional lucky powder. Defaults target +3 / 20 attempts / any compatible weapon elixir / powder off. Only these choices persist per character; weapon selection and running/pending attempts never auto-resume on reload. Selectors show bag slot and current +, with icon/degree preview and attempt/success/failure/confirmed-material counters. UI supports native target 1..250 and attempt limit 1..1000. README adds a short usage section.

Verified read-only native contracts in contracts/item-process.ts, inventory/alchemy/alchemy.ts, inventory/inventory.ts and server item/alchemy/reinforce.go/catalog.go. Native commands: alchemy-open, alchemy-start {mode:'reinforce',slots:[weapon,elixir,powder?]}. Result is gp.alchemy {visible,pending,mode,slot,flags,error}; result masks success 0x10, failure 0x20 (additional downgrade/durability bits), destruction 0x40. Server spends one elixir and optional powder per completed attempt. Standard weapon elixir IDs 3675/3679 verified against local itemdata params/category 6, flags 0x0d6c. Powder IDs 3683..3694 (A) / 3695..3706 (B) have degree 1..12 and flags 0x156c. Requires exact known types and quantities; custom/unrecognized materials are not guessed. Weapon degree comes from native tooltip.fields.itemClass: floor((class-1)/3)+1. Unknown degree refuses optional powder selection. No game/server/original-bot changes.

Only runs while hunting/travel/recording/revival and collection are stopped, alive, not casting/under attack/moving, with closed shop/storage/trade/stall and settled known alchemy/inventory. Manual native gameplay commands stop the run; own Cmd.raw bypasses that observer. F8 and Stop all stop alchemy rather than start hunting. Hunting, walk-back and route recording are blocked during a run or unresolved attempt. Alchemy owns the inventory lane; potion, pickup, town and resurrection ticks are held until it settles; independent party service continues.

Weapon locked by bag slot/ref/type/variance plus full mutable fingerprint between attempts. Confirmed result may legitimately change plus/durability/magic protection charges, so refresh the fingerprint only after a matching reinforcement result AND exactly one consumed elixir/powder, with inventoryPending false and verified expected plus change. Success must increase plus by one; failure may retain/reduce plus. Acknowledgement can occur entirely between ticks: material and result proof handles this without requiring an observed pending:true snapshot. Stale flags, wrong result slot/mode, inconsistent plus, changed identity, ambiguous consumption, unknown responses and 15-second timeout never authorize another spend. Stops leave a sent attempt pending until confirmed or world reset; reinforcement cannot be cancelled natively. Confirmed destruction clears selection. Window opening is sent once and times out after five seconds. After a confirmed result, wait one second before the next attempt. Native rejection stops without auto retry. Settings/manual/character changes stop; reset clears selection and unresolved local state. No persistent item UID is exposed by the native bag mirror, so manual interference stops rather than relocating/following a weapon.

Fourteen new integration tests cover native slot order, confirmation and failure/downgrade, targets/limits, validation and matching materials, stale/partial/pending state, timeout/rejection/destruction, item identity/edit/manual/character guards, Stop/F8 and late results, reset/death, window opening, material depletion/stack rollover, mismatched result and dispatch failure. Browser tests select a weapon, set controls and powder, click Start, verify exact command, apply a native-shaped result and verify target stop/counters; desktop/mobile Alchemy screenshots inspected. Diagnostics include only numeric/boolean alchemy fields, with no weapon names/IDs. All 185 integration tests, syntax and browser checks pass. Actual live enhancement and material consumption remain unverified; tests did not spend real items.


## Alchemy stop cleanup: 1.2.37

User confirms enhancement works live in 1.2.36, but ground clicks fail after stopping. Their copied report shows alchemyActive:false, alchemyPending:false and inventoryPending:false; the report does not support an outstanding enhancement transaction as the movement blocker. Repeated travel-error categories hide the original messages; the user had played further and could not recover them. Do not claim the movement freeze is reproduced or definitively resolved.

Reproduced a cleanup defect with a failing regression: Stop never sent alchemy-close. Track a native session only after a successful open/start dispatch, and close it once on manual stop, target/attempt completion, refusal or timeout. Queue close even while open acknowledgement is outstanding. The read-only native alchemy contract confirms close hides the window without cancelling reinforcement, so retain and confirm any sent attempt as before. Do not close an unrelated native compound/advanced/dissolve process or dispatch cleanup into a reset/different character. No movement commands, inventory-state clearing, game/server or original-bot edits.

Copy diagnostics now includes allowlisted native alchemy mode, window visibility, native pending, queued movement and active return-scroll booleans. Four new integration tests cover stop/late results/idempotence, target completion/open ordering, unrelated processes/reset and diagnostic privacy. Existing timeout and no-resend assertions now distinguish close from material-spending commands. Browser test verifies native close dispatch after target completion. All 189 integration tests, syntax and isolated browser checks pass. README unchanged. Publish/mirror/back up installation copies through the usual workflow; live ground-click recovery remains unverified.


## Best abnormal-pill restocking: 1.2.38

User requested automatic buying of the best abnormal-status pills, without cheaper substitutes. Verified read-only local retail itemdata_5000.txt and textdataname.txt: ref 58, ITEM_ETC_CURE_ALL_04, English name Special Universal Pill (small), cure power 172 versus ordinary large ref 57 power 108 (small/medium refs 55/56 power 36/68). Native type flags 12652 are the universal-cure category. refshopgoods.txt lists PACKAGE_ITEM_ETC_CURE_ALL_04 in Hotan potion merchant STORE_KT_POTION_TAB1. Purification/random pills are a different family and are not selected. No game/server/original-bot edits.

Supplies adds Buy abnormal pills (best), Pills low stock and Pills refill to. Defaults off, low 10, target 50; existing profiles acquire these defaults without changing HP/MP settings. Enabled supplies always resolve cure to ref 58 even if an imported profile supplies a cheaper ID. Both town and recorded walking restock share the cure threshold/target; low pills trigger a refill and full-bag/revival trips also top them up. Count existing best pills, respect stack/space/gold limits, require normal single-item gold offers and stop with a specific message if the best pill is unavailable. Existing Use cure pills switch remains separate. Existing cure protection prevents pet pills from being sold.

Walking purchases now retain requested quantity and wait for the complete expected stock increase, with the existing 12-second timeout and no repeat while unconfirmed; partial gains no longer authorize another purchase. Town already uses complete quantity confirmation. Diagnostics reports best-pill stock, switch, threshold and target and labels pill refill progress correctly. Five new integration tests cover defaults/profile preservation, fixed best selection and invalid offers, missing-amount town buying/settlement, missing best pills/gold, walking low-stock and partial confirmation, plus all town triggers with frozen trip targets (combined assertions across five tests). Browser checks toggle the new switch and edit thresholds/targets. All 194 integration tests, syntax and isolated browser checks pass. README unchanged. Live purchases remain unverified; publish/mirror/back up through the usual workflow.


## Manual reports and optional screenshots: 1.2.39

Settings → Send bug report opens an in-memory preview of the existing allowlisted diagnostics snapshot/history. Optional explanation is capped at 1000 characters and appears in the JSON preview; it is user-entered text, not automatically scrubbed. Game state changes never silently replace the preview. Only Send to developer uploads the exact displayed JSON and selected screenshot to https://nixbot.nixxane.workers.dev/report. No automatic reports, capture, retries, persistent identifier, local storage or settings change. Existing Copy diagnostics and return-diagnostics export remain available. Close discards the draft; successful sends prevent duplicate sending of that draft and release its screenshot.

Optional Add screenshot invokes getDisplayMedia directly from the click with audio:false. The user chooses a tab/window/screen in the browser permission picker each time. A single decoded frame is resized to at most 1280px on its longest side and JPEG encoded at 0.85 quality (PNG fallback accepted), capped at 2 MiB. Screenshot preview and removal are provided; the UI explicitly warns that explanation/screenshots may contain private names/chat/details. Every acquired track is stopped on success, failure or close, including a picker resolving after close. Frame preparation is bounded by 10 seconds after selection. Unsupported/denied capture still permits diagnostics-only reports. No real screen is captured during tests.

Uploads use multipart report and optional screenshot, omit credentials/referrer, reject redirects and have a 20-second abort timeout. No overlap, no automatic retry, no gameplay commands. Only HTTP success with JSON ok:true confirms delivery. HTTP 429 honors Retry-After (default60s, capped3600s) with a countdown disabled Send button; cooldown persists across closing/reopening the preview in this page. Ambiguous network/timeout/server replies retain the draft and warn users to check with the developer before manually resending. Other validation/service failures show generic messages, never raw server errors. Live game-to-Discord delivery with a screenshot was confirmed by the user after the receiver runtime fix below.

Separate receiver source/config lives at C:\sroserver\opensro-bot-reports-worker, not in the bot repository. Cloudflare nixbot Worker receiverVersion4 is deployed with ready:true and spamProtection:cloudflare-rate-limits. Existing production DISCORD_WEBHOOK_URL stays only in Cloudflare; it is not included in the userscript or repo. Limits are 3 attempts/minute/IP and 20 attempts/minute/Cloudflare location, approximate and local to the location. Receiver refuses uploads if bindings fail/missing. Health/preflight were checked live; no Discord test reports were sent.

Six new integration tests cover frozen/redacted previews, exact multipart payload and send consent, duplicate/overlap protection, uncertain delivery and timeout, rate-limit recovery across preview close, capture cleanup/cancellation and late picker resolution, plus size/description bounds. Browser tests exercise actual UI, real canvas-generated JPEG capture/resizing with synthetic media tracks, track shutdown, removal, diagnostics-only and attached-image uploads, rate-limit feedback and desktop/mobile bounds. All 200 integration tests, syntax and isolated browser checks pass. Every reporting upload is mocked in tests; no real Discord messages or personal screenshots are sent. Publish/mirror/back up through the normal release workflow.


## Report delivery receiver fix (bot remains 1.2.39)

User's Edge screenshot reports reached the Worker but failed before any Discord HTTP response. The initially missing API User-Agent was corrected but did not resolve this stall. Reproduced the confirmed cause in Cloudflare workerd/Miniflare with zero outbound requests: redirect:'error' throws TypeError, "Invalid redirect value, must be one of follow or manual". Node fetch mocks accepted this option and missed the incompatibility. The receiver now uses redirect:'manual' and explicitly rejects 3xx; uploads are never followed to another destination. ReceiverVersion4 is deployed, ready:true, with existing spam bindings and secret preserved. Bot 1.2.39 needs no update/reload for this server-side fix. User confirmed the report sent successfully after this fix. Live report delivery with the screenshot is now confirmed.

Receiver tests now include worker.runtime.test.mjs, running the entire receiver in workerd with every outbound request intercepted, fake webhook values and synthetic reports/images. Confirms diagnostics-only and JPEG multipart delivery and refusal of redirects. Node tests also verify the Discord User-Agent, safe fixed failure categories/HTTP status, timeouts, and response cleanup not masking confirmation. No real Discord test messages were sent by tools. The temporary wrangler tail was stopped after live confirmation. Failure traces report only fixed failure categories, not raw errors, webhook URLs, IPs, report text or screenshots. Worker observability remains disabled. Separate backend source/config/package lock stay in C:\sroserver\opensro-bot-reports-worker; no game/server/original-bot edits or bot version bump.


## nixxane bot branding: 1.2.40

Renamed the visible userscript name, panel heading, ready/console messages, README, export labels/filenames and diagnostic report app to nixxane bot. Repository/folder/generated script paths, namespace, update/download URLs, existing localStorage profile keys, export-format identity, DOM host and SROLean debugging API remain stable. Saved per-character profiles are preserved. The original vendor/game/server are untouched. Use Tampermonkey's update check on the existing script and reload to pick up the branding release.

Deployed receiverVersion5 before publishing the bot: accepts both new nixxane bot and legacy OpenSRO Bot Lean reports, rejects unrelated app names, and uses nixxane bot in health/Discord labels. Existing production secret and rate limits are preserved. Node and full workerd tests cover both names with diagnostics-only and synthetic screenshot uploads; every outbound call is mocked. Prior live screenshot delivery confirmation still stands for the receiver fix, but no real branded report was sent by tools.

The separate opensro-bot-lean-site repo uses nixxane bot in the title, heading, description, README and an n favicon. Added 1.2.40 patch notes and retained the KISS layout, saved dark mode and stable install/repo links. All 200 bot integration tests, syntax and isolated browser checks pass; site theme/responsive checks pass. Publish both repositories, mirror changed Lean files and back up/update Downloads userscripts through the usual release workflow.

## Discord report description (receiverVersion6; bot remains 1.2.40)

The receiver now includes the user explanation directly below the version heading in the Discord message. Diagnostics JSON and optional screenshot remain attachments. Explanations are trimmed and capped at 1000 characters in message content; missing, blank or non-string explanations receive a readable fallback. Allowed mentions remain disabled, including @everyone/user/role mentions. Original report contents remain in the attachment. Older bot reports are supported; no bot update or reload is required.

Syntax, Node receiver tests and full workerd tests pass, including multiline descriptions, content bounds, attachment preservation, legacy fallback and disabled mentions. All outbound test requests are intercepted; no real Discord messages sent by tools. Deployed Worker version f5766264-ba8b-43c6-9e37-e15005f637db; live health confirms receiverVersion6 and ready:true.

## Multiple buff weapon sets: 1.2.41

lean-buff-gear.js owns BuffGear, with macro.buffSwap off by default and macro.buffSets saved per character. Save up to eight sets from currently equipped slot6 weapon and optional slot7 shield in Combat → Buffs & imbue; return to combat gear before hunting. Each selected buff gets a gearSet ID (0 = ordinary current-gear buff). Assigned buffs are excluded from the original Combat.buffs loop even while swapping is off. Existing profiles keep ordinary buff behavior.

A hunting-only cycle snapshots the actual combat weapon/off-hand, groups due self-buffs by assigned set, stops combat movement, explicitly removes incompatible off-hand equipment to one free bag slot, swaps the weapon, equips the selected shield, then casts. Uses verified native inventory-move {source,destination,quantity:0} into sockets6/7. Each move must show the exact source/destination exchange in settled inventory before advancing; no repeat of unconfirmed moves (15s timeout). Item identities include reference/type/plus/variance/magic and ignore durability, slot and stack quantity. Duplicate identities are refused. Original combat gear can be any weapon, with shield, ammunition or empty off-hand; no hardcoded staff/cleric/bard types. Saved buff sets require a weapon plus optional actual shield.

Buff casts wait for an observed cast event or active buff, plus authored actionMs+500ms (6s fallback) and observed casting settlement before the next swap. Unconfirmed casts restore gear and suppress that buff until configuration changes. After home gear is restored, a 1s hold checks previously observed buffs for disappearance; weapon-bound buffs are suppressed until buff settings change to prevent swap loops. Native server itemmove_door_test.go proves reqi-bound buffs can end on equipment removal; no claim that every cleric/bard buff survives. Full cycle is bounded to120s.

Party and emergency potions continue during swaps. Combat, town, walk-back, resurrection, collection and alchemy yield; new travel/hunting/alchemy starts are refused while gear restoration/review is outstanding. Stop/F8/feature-disable finishes pending moves/casts then restores without further buffs. Manual control/equipment commands, death, disconnect and world reset stop hunting and preserve a manual recovery snapshot in this page; Restore combat gear retries only when explicitly clicked with settled state, Use current gear clears recovery after inspection. Character/profile change or reload discards recovery without touching new gear. Missing gear, ambiguous copies, capacity failures or unconfirmed restoration never resume hunting automatically.

219 integration tests, syntax and isolated Edge browser checks pass. New tests cover two alternate sets, arbitrary combat gear/ammunition, exact confirmation, stale/busy inventory, action holds, disabled paths, missing/full/duplicate gear, interrupted/rejected restoration, death/manual/profile isolation, independent services, cast timeout and lost-buff suppression. Browser tests save two sets and assign/remove them through actual controls. No live game/account equipment was changed; native swapping and buff survival need user confirmation. Publish and mirror through the standing workflow.


## Local session stats: 1.2.42

Settings → Session stats shows hunting time, XP gained and XP/hour, signed net gold, confirmed kills, deaths, confirmed potion uses and item pickup units. Tracks while Hunt.running and World.inWorld, pauses across stops/disconnects and retains totals across toggles. Town services count while hunting stays enabled; separate walking returns can pause hunting. Reset session, character changes and reload clear totals. No persistence, telemetry, uploads or new gameplay commands. Existing diagnostic-report contents are unchanged.

lean-stats.js owns Stats. Samples native progression experience/gold with BigInt, rebases across stopped periods/world epochs and lazily loads the verified local /assets/data/levelData.json for level rollovers. XP counts positive observed gains rather than net death losses; unresolved transitions are bounded and labelled partial. XP/hour appears after 30 active seconds. Net gold includes observed purchases and repairs. Missing progression displays unavailable rather than invented totals.

Kill counts require a monster fatal cast result from the local player or their owned COS, deduplicated until respawn; party XP and despawns are not kill proof. Potion counts require inventory decreases correlated with recent bot Potion.use dispatches; expired/stopped/unconfirmed requests do not count. HP/MP/vigor/cure share this counter. Items count confirmed bot pickup quantity gains in character/pet inventory; gold drops are excluded. These are observed correlations, not transaction-ID receipts; unobserved/manual actions are not comprehensive gameplay accounting.

Fifteen new integration tests cover active/paused time, multi-level XP and exact large integers, signed supply spending, rates, fatal-result ownership/deduplication, death transitions, potion settlement/expiry/missing inventory, item units, reset, character/world isolation and bounded pending asset resolution. Browser tests exercise Start/F8, rendered values and Reset session in actual Settings controls. All 234 integration tests, syntax and isolated Edge browser checks pass, with zero page errors. No live character was used; live counter accuracy still needs user confirmation. Publish/mirror/back up through the standing release workflow.
