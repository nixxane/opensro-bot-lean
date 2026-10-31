# NIX (the nixxane bot)

A compact OpenSRO bot for hunting, potions, pet loot and automatic town trips.

[Install / update the bot](https://raw.githubusercontent.com/nixxane/opensro-bot-lean/main/bot.lean.user.js)

## Quick start

1. Install the script with **Tampermonkey**. Disable any other OpenSRO bot script.
2. Reload the game after installing or updating.
3. In **Combat**, save your hunting spot and choose your attack skills, buffs and imbue.
4. In **Combat**, tick the monster kinds **Berserk** should be used on (only Giants by default; it fires once the gauge is full, so the gauge waits for a Giant). In **Loot**, choose what to collect, including **Magic stones** and **Attribute stones**. Tick **Equipment: only SoX** to take only Seal of Star, Moon and Sun equipment; gold, potions and other items follow their own switches. For pet collection, summon your pickup pet and select it as the collector.
5. In **Supplies**, set your HP/MP potion thresholds. Enable **Use beginner +100% speed scroll automatically** if wanted.
6. Press **F8** to start hunting.

Settings are saved separately for each character. The bot checks for updates on load and every 15 minutes; click **Update** beside the version when it appears, install, then reload when ready.

## Setup page

The **Setup** page is the first page and opens by itself for a character that has no hunting spot or attack skills yet. It is a live checklist: character and weapon, hunting spot, attack skills, potions, what to pick up, town trips, pet, and what happens on death. Each row says what is missing and has one button (**Set here**, **Pick skills**, **Turn on**, **Set up town**, **Safe preset**). **Fix the next thing** jumps to the first red item. **Starter settings** (**Level up**, **Farm drops**, **Safe AFK**) are laid over your current settings, so your skills, hunting spot and town stay; the page lists every change first, applies nothing until **Apply**, and **Undo last change** brings your old settings back. The page only reads the game and your settings until you press a button.

## Session window and logs

The **Session** button (or **Pop out session totals and log** under **Settings → Recent activity**) opens **Current session**, a floating window with live hunting totals. The **▼ Show logs** button expands the shared activity history downward. It never opens by itself, it stays on screen when you minimise the bot with the × button, and closing it does not stop hunting. Use **Reset session totals** to clear the totals explicitly. The status lines, the feedback line under the buttons and the wide window's Activity box stay on the main panel; the same history also shows in Settings.

Activity is available under **Settings → Recent activity** and in the session window. Both lists scroll and follow incoming entries only while you are at the bottom. Normal history retains the newest 400 events. Categories, outcomes (requested/confirmed/refused/unconfirmed) and repeat counts help distinguish dispatch from observed results. Alchemy outcomes, game refusals and town-state changes appear here too.

Visible messages use monster names and plain language, such as **Targeting Mangyang**. Technical IDs, selection policy, outcomes and distances remain in diagnostic exports rather than being printed before each message. Standard exports omit names; raw exports explicitly include the original technical message and the readable message. Select log text and press **Ctrl+C** to copy only that selection.

Use category/severity filters and search to narrow the view. **Pause log** freezes that view while collection continues; **Follow latest** resumes it. Both views share filters and keep independent reading positions. **Clear history** requires a second click within five seconds and does not reset session statistics.

**Detailed capture (10 minutes)** enables a separate, bounded 1,000-event command trace. Routine commands cannot evict normal warnings. Capture automatically stops after ten minutes; all history is local to this page and is lost on reload. Potion consumption is summarized rather than logging every routine use; detailed capture includes individual observed consumptions.

**Export preview** shows exactly what will be downloaded or selected for copying. Standard JSON/text export omits free-form messages, player names and precise locations. **Include raw local messages** explicitly includes text that may contain private details; review before sharing. Export never uploads anything, and the existing bug-report upload does not silently include this history.

Routine **Cast rejected: 5** events appear as one informational **Skill not ready yet** row, with a repeat count on the right. They have separate bounded retention so repeated cast readiness messages do not evict normal history. In OpenSRO this means the skill is cooling down or its action is still recovering. A persistent readiness stall without an observed local cast can raise one warning per minute. Refusal evidence is included in exports even when a view filter hides it: request type, decoded explanation, client state and nearby commands, with up to eight recent context examples per group. Nearby commands are explicitly possible context, not an exact request match, because the refusal packet has no request identifier. Other channels' error code 5 is not treated as a skill cooldown.

Under **Supplies → Automatic potion use**, enter **Potion delay (ms)** as a whole number from 0 to 60000. The default is 350 ms. This minimum interval is saved per character; item cooldowns and inventory admission still apply.

Under **Town → Scroll town cycle**, enable the cycle, set up your recall town and services, and enable **Revive in town and go back to the hunting spot**. Choose **Last return-scroll location (hunting area)**, the default, or **Death location** for revival trips. The death location is used only when you died inside the hunting area; a death further away reverses to the last return-scroll point, because hunting starts again only from inside the hunting area. Ordinary repair/sell/refill trips reverse to their departure point. Missing or refused reverse destinations stop the trip without silently switching destinations. Without a reverse scroll, or with **Back to the hunting spot** set to **Walk**, the trip walks back to the saved hunting spot instead (see below). Existing protections for your character's inventory remain unchanged.

## Item rules

The **Items** page lists every item in the game with sBot-style filters under **Filter items** (group, race, gender, type, SoX (Star / Moon / Sun), degree, search, only items with a rule). Per item choose **Pick** always/never and one action: **Store** (warehouse on town trips), **Sell** (pet loot at the repair merchant), **Keep**, or **Drop** (thrown away from your bag or the pet while hunting, never picked up again). Click a cell, right-click a row, or use the bulk buttons for everything shown (second click confirms). Rules come first; other items follow the Loot switches. Your own bag is never sold, and supplies the town trip needs are never stored from it.

**Combat → Buffs & imbue → Weapons and shield** sets your **Primary weapon**, **Secondary weapon** and **Shield**, picked from what you wear or carry. A choice stays when you wear the item, when it is in the warehouse or the pet, and when alchemy changes its plus or stones. Chosen gear is never sold, stored, dropped, moved to the pet or offered in your stall, whatever its item rule or stall price. **Balance free slots with the pickup pet** is under **Loot → Bag and pet space**.

While hunting, the primary weapon is the combat weapon. When something else is worn (after a reconnect or a manual change), the bot puts it back on, with the chosen shield when it is one-handed; a bow wears arrows and a crossbow bolts: the worn stack when it fits, otherwise the biggest stack in your bag, and the next one when a stack runs out. A secondary bow or crossbow gets its ammunition the same way. Under each buff, **Gear for <skill>** can be **Primary weapon**, **Secondary weapon** or **Shield (with a one-handed weapon)**: the bot wears it, casts the buff, then goes back to the primary weapon. Automatic buff swaps try the secondary weapon first, then the primary. A primary weapon or shield the game will not equip is not tried again until you pick it again, and the gear worn before goes back on; any other refused move waits five minutes. Hunting goes on either way. Without a primary weapon chosen, whatever is worn stays the combat gear.

## Vigor and pet potions

Under **Supplies → Automatic potion use**:

- **Vigor potions:** tick **Use vigor potions** and set **Vigor when HP below** and **Vigor when MP below**. Vigor potions are used when your HP or MP drops that low and the normal HP and MP potions have not been enough.
- **Buying vigor potions:** under **Supplies → Potion restock**, tick **Buy vigor potions**, pick the **Vigor potion size** (Herb, Small, Medium, Large or X-Large; X-Large by default) and set **Vigor low stock** and **Vigor refill to**. Town trips and walking restock buy that size, and a trip is also started when the vigor stock runs low. If the potion merchant does not sell the size you picked, the trip stops with a message so you can choose another.
- **Buying arrows and bolts:** under **Town → Arrows and bolts**, tick **Buy arrows** and/or **Buy bolts** and set the **go to town at or below** count and the **refill to** count (2000 each by default, off by default). They are bought on a town trip at the repair merchant, after selling pet loot and before repairing. The count includes the stack in your ammunition slot and spare stacks in your bag, and a trip also starts when it falls to the low number. If the merchant does not sell the item, there is no bag space or not enough gold, that item is skipped with a notice and the rest of the trip goes on. Equipping the bought ammunition is up to you.
- **Pet recovery kits:** tick **Use recovery kits on my pets** and set **Pet HP below**. When an attack or pickup pet drops below that HP, the bot uses one recovery kit on it, choosing the smallest kit that covers the missing HP (or the largest if none does). Your own potions always go first. The pet's maximum HP is learned from its own HP — the highest value seen while the bot watches (a freshly summoned pet starts full, so that read is the maximum) — and a rested pet is healed again as soon as its HP moves. Each kit has to be seen consumed before the next one is used; a pet that does not take a kit is left alone for 30 seconds, and one whose HP does not rise on confirmed kits rests for five minutes, so a wrong HP reading cannot drain your kits. It is off by default and needs the master **Use potions automatically** switch.
- **Pet HGP (satiety):** tick **Use HGP recovery potions on my pet** and set **Pet HGP below**. When the attack pet's HGP gauge drops below that percentage, the bot feeds it one HGP recovery potion (the smallest that covers the missing satiety, or the largest if none does). Pickup pets have no HGP gauge and are never fed. Each potion has to be seen consumed before the next one; a pet that does not take one is left alone for 30 seconds. It is off by default and needs the master **Use potions automatically** switch.
- **Buying HGP recovery potions:** under **Supplies → Potion restock**, tick **Buy HGP recovery potions**, pick the pet food the recorded merchant sells, and set the low-stock and refill numbers. It is bought on the same refill trips as the potions; a merchant that does not sell pet food skips it with a notice instead of stopping the trip.
- **Buying pet recovery kits:** under **Supplies → Potion restock**, tick **Buy pet recovery kits**, pick the kit the recorded merchant sells, and set the low-stock and refill numbers. It is bought on the same refill trips as the potions; a merchant that does not sell kits skips them with a notice instead of stopping the trip.

## Automatic town trips

With the town cycle on, the walking-route restock controls are hidden because every trip buys potions in town. The **On death** setting is replaced by the town revive option, and the rest thresholds only show while **Rest when low** is ticked.

Set this up once on the **Town** page, under **Scroll town cycle**:

1. Bind your recall to **Hotan, Jangan, Donwhang, Constantinople or Samarkand** in the game. Stop the bot, pick your town in the **Town** list and click **Set up this town**; you do not have to be in town. It saves the town's known arrival point (where its return scroll always lands) and fills the **Warehouse**, **Potion merchant**, **Repair merchant** and **World statue / teleport** from the server's NPC data, each as a spot a few metres from the NPC. It only fills what is empty; **Redo all automatically** replaces every saved point, and an arrival point from another town is replaced automatically. **Auto-set town services** does the same for the town you are standing in. If the saved arrival point is not where the scroll actually lands, the bot corrects it itself: after a recall it confirmed, once the character has stood still for three seconds in a known town, it saves that spot as the arrival point and carries on. This is only done in the town the saved services belong to.
2. To do it by hand instead, stand near and select each service, then save its point: **Warehouse**, **Potion merchant**, **Repair merchant** and **World statue / teleport**. Open the potion shop before saving its merchant. Manual saves override the automatic ones.
3. Enable **Buy HP** and/or **Buy MP**, and set the low-stock thresholds. Set **HP refill to** and **MP refill to** in potion counts (defaults: **100 HP / 300 MP**). These targets apply to walking restock and every town trip, including full bags and revival. Town buys X-Large potions.
4. Enable **Use return scroll → town services → back to the hunting spot**. Enable the pickup-pet capacity option if wanted.
5. **Revive a dead pet with a Grass of life**: a dead attack or pickup pet waits in your bag as its summoner item. With this on, that alone starts a town trip; once in town the bot uses a Grass of life from your bag on it (it only works in town) and summons the pet again before the services, so it carries loot again for the rest of the trip. Carry the grass: stable-keepers sell it and the bot does not buy it. A grass that is not accepted, or a pet that cannot be summoned again, only warns — the town services continue without it and the pet is retried at the earliest ten minutes later.
5. Choose **Back to the hunting spot**: **Reverse return scroll** (the default) or **Walk**.
6. Carry gold, spare return scrolls (and reverse scrolls for the reverse choice) and at least **two free character bag slots**. Save your hunting spot and start the bot.

When supplies run low or a bag reaches its capacity trigger, the bot recalls to town, handles pet loot, refills pots, repairs gear and reverses to the **last return-scroll point**. With **Walk**, or when no reverse scroll is carried and none could be bought in town, it skips the world statue and walks back to the saved hunting spot, then hunts again. A walk that cannot reach the spot stops the bot with a message, as **Return & hunt** does.

- **Pet elixirs, magic stones and attribute stones:** stored in the warehouse. Stones are also deposited from your own bag; elixirs stay in your bag so alchemy can use them. Magic stones include the Astral, Luck, Steady and Immortal stones. Attribute tablets are not stones and count as other alchemy items.
- **SoX gear:** Star, Moon and Sun equipment is deposited in the warehouse from your own bag and from the pet, on the next trip that visits the warehouse. Nothing is stored right after pickup. SoX gear that is part of a saved buff set, the weapon chosen for alchemy, or matches the **Keep in pet (names)** list is never deposited. Switch it off with **Deposit SoX gear in the warehouse**.
- **Sell Star gear instead:** switch on **Sell Star gear too (instead of depositing it)** and Star gear (not Moon or Sun) is sold like ordinary gear (pet loot, and the character bag when bag selling is on) rather than deposited. Keep names, buff-set gear, the alchemy weapon and the level list still protect it. Off by default.
- **Gear by required level:** list levels in **Also deposit gear requiring level** (for example `85`, or `80-90, 100`) and equipment of any kind that requires one of those character levels is deposited the same way, from your bag and from the pet. Listed gear is never sold, even if the warehouse cannot be used. The same protections apply as for SoX. Empty by default.
- **Other unprotected pet loot:** sold at the repair merchant. Ordinary equipment can be sold even with + or blue options.
- **Other seal/rare gear, supplies and matching Keep names:** protected. Character bag items are sold only when you switch on **Sell ordinary gear from the character bag too** (off by default). From the bag it sells only ordinary Chinese and European weapons, armour, shields and accessories that pet-loot rules would sell; any other bag item is sold only with a Sell rule. Pet summon scrolls and flutes, avatars, devil spirits, job suits, fortress weapons, item mall and event items, tablets, powders, potions, scrolls, supplies, Keep names, buff-set gear and the alchemy weapon are never sold from the bag. With the switch on, the trip visits the repair merchant (sell, ammunition, repair) before the potion merchant, so a full bag is emptied before potions are bought and the trip does not stop at arrival for lack of a free slot; with a full bag it also goes there before the warehouse, because pet loot reaches the warehouse through a free bag slot. Items the game does not let merchants buy (quest and event items) and pet summon scrolls and flutes, in the pet or the bag, are never offered, even with a Sell rule; if the merchant still refuses an item, it is kept and the rest is sold.

If protected items fill a bag, the bot stays in town and asks you to free space.

### What starts a town trip

The **Town** page shows the trip as a row of pictures (return scroll, warehouse, potions, repair, way back) with what each step still needs, and lists what starts a trip under **Go to town when…**:

- Always: the character bag has one free slot or less. Potions, vigor potions and pills at their low-stock numbers (Supplies), and arrows and bolts at theirs (Town).
- **Return when pickup pet is nearly full**, with **Pet free slots ≤**.
- **Weapon is broken**: the equipped weapon is at 0 durability. On by default.
- **Gear is worn**: the most worn repairable item you are wearing is below **Gear durability below (%)** of its own maximum (15% by default). The trip repairs it. Off by default.
- **No XP for a while**: no experience for **No XP for (minutes)** (10 by default). Off by default.
- **On a timer**: every **Every (minutes)** (60 by default). Off by default.

The XP and timer clocks run only while hunting and restart with every trip, so a long trip never starts the next one. All of these need the town cycle on.

## Buff weapon swapping

With **Swap weapons for buffs** and **Wear the weapon each buff needs** on, a buff your current weapon cannot cast is cast with a matching weapon from your bag (taken from the skill's own weapon requirement), then your combat weapon and shield are restored. No saved set is needed. Keep one bag slot free. Imbues and attack skills are not swapped.

Saved sets, described below, are for buffs you assign to one.

In **Combat → Buffs & imbue**, equip your buff weapon and optional shield, name the set and click **Save equipped buff set**. Repeat for other sets (such as cleric and bard), then put your combat gear back on.

Assign each selected buff to its set and enable **Swap weapons for buffs**. While hunting, the bot equips each needed set, casts its buffs and restores your original combat weapon and off-hand. Keep one bag slot free. Assigned buffs are skipped while swapping is off.

The Buffs & imbue page shows, for each buff assigned to a set, how long it has left and what the swap is waiting for, and says why when a buff is due but the swap cannot start (for example a saved weapon that cannot be found in the bag). The swap happens when a buff is about to end, not when you start hunting.

One weapon change covers what uses the same gear. That is your own buffs assigned to it and up to 10 party buff casts (Party → Party buffs) that need it, on the members and on you, cast one after another before the combat weapon comes back. After a minute it stops starting casts and puts the combat weapon back; the rest goes in the next change. Buffs that would run out within a minute are renewed in the same change, so the next change does not follow a minute later. A buff whose cast was only unconfirmed is tried again after two minutes.

Some buffs end when their weapon is removed. If observed, the bot skips that buff until its buff settings change. Interrupted or unconfirmed swaps stop hunting; use **Restore combat gear**, or inspect your equipment and choose **Use current gear**. Reloads discard unfinished recovery. Live-server swapping still needs confirmation.

## Item alchemy

Stop hunting/travel and put the item in your bag: a weapon, shield, armour piece or accessory. In **Alchemy**, select it, set **Target +** and **Maximum attempts** (up to 9999), choose an elixir (the list shows the elixirs of that item's kind) and optionally enable matching-degree lucky powder and the plus **Lucky powder from +**, then click **Start alchemy**. The tab shows the chance of the next attempt and how many elixirs to expect to reach the target, calculated from the server's own data (powder and Luck are counted the way the server counts them; skill and avatar bonuses are not), and a **Results** panel with attempts, successes, failures, destroyed items, the highest plus, what was used and a log of every attempt and fusion.

Under **Stones that help and protect** tick **Use Luck / Steady / Immortal / Astral stones while enhancing** for the helpers you want, set how many charges to keep on the item (1 to 6) and the plus each is used **from** (defaults: Luck 0, Steady 5, Immortal 5, Astral 4). Before every attempt at or above that plus, if the item has fewer charges than you asked to keep, one is fused automatically from a stone of the item's degree in your bag. Nothing is fused for a helper that is not ticked. **Fuse stones now** ignores the plus and only fills the charges. Each stone adds 1 to that attribute: Luck raises the enhancement success chance, Steady stops durability damage and Immortal stops destruction when an enhancement fails (none of them stops the + from resetting; an Astral stone does, from +4). The game takes an Astral charge only while the weapon has more Immortal charges than Astral ones, so before an Astral stone the bot fuses an Immortal stone when the weapon needs one, even below Immortal's own plus or with Immortal not ticked; without an Immortal stone in the bag it stops and says so. The stone must be of the weapon's degree and in your bag, and adding a kind the weapon does not have yet needs a free magic option slot. The bot reads the weapon's current counts and only fuses what is missing, confirms each fusion by the stone leaving the bag, counts a failed fusion (the stone is used up and nothing changes) and carries on, and stops if a stone is missing, the game refuses, the counts cannot be read, or when it reaches the optional **Stop after this many fusions** limit (0 = no limit, the default).

Stops at the target, attempt limit or missing materials. Failures can reduce +, damage or destroy the weapon. **Stop alchemy**, **Stop all** or **F8** prevents further attempts; a sent attempt can still finish. Unconfirmed results pause without retrying.

### Item attributes

Under **Item attributes (stat percentages)** pick, for the item selected above, the lowest percentage you want for each stat (for a weapon: Phy. reinforce, Mag. reinforce, attack rating, Phy. and Mag. attack power, critical; armour, shields and accessories have their own list). Press **Fuse attribute stones**: the bot fuses attribute stones of the item's degree, working down the list, until every picked stat reaches its target. A successful fusion rolls the stat again, so it can come out lower, and it can re-roll another stat of the item, so the bot keeps checking all picked stats. The stone chance is 50% before bonuses and the high steps (80%, 100%) are rare, so set **Stop after this many attribute stones** (100 by default). A stat whose stones run out, or that has none of the item's degree in the bag, is passed over and the next picked stat is done; the log says which. It stops when every picked stat has reached its target, or when the ones still below it have no stones left, and then names the stones that ran out.

## Auto stall

Sell bag items from your own street stall, like sBot's stall tab. On the **Stall** page, give the items a price: **Add a bag item to sell** lists what is in your bag (a new entry starts at 100 gold), and each row keeps its price. Prices are per exact item and saved per character, so the same drop sells at the same price on the next stall. Set a **Stall name** (defaults to your character name), a **Greeting** for visitors, whether to **List the stall on the stall network**, and whether to **Close when everything is sold**.

**Open stall** requires town, standing still, and hunting, travel and alchemy stopped. The bot names and creates the stall, registers one offer per priced stack (the whole stack at your price, up to the stall's slot limit), then opens it for business and watches it: sales are confirmed only when the offer disappears and gold arrives, and the status line shows offers left, visitors and gold earned. A step the game does not confirm within 15 seconds is skipped (an unconfirmed item is not re-offered and the rest of the stall still opens); **Stop stall**, **Stop all** or **F8** closes a stall this page opened. Items already in a stall you opened yourself in the game are left alone; hunting refuses to start while any stall is open. Only the game's own stall state is used — the wire contract was read from the live client, but the flow has only been exercised in simulation, not against the live server.

## Healing and buffing the party

On the **Party** page tick **Buff and heal party members** (off by default). The bot then supports the party with your own skills, one cast at a time, in this order:

1. **Group heal skill** (a skill without a target), when **Group heal when this many are low** members are below **Group heal below (%)**.
2. **Heal skill** on the member with the lowest HP below **Heal below (%)**; tick **Heal myself too** to include yourself.
3. **Party buffs**: pick them from your learned skills that can target a party member. Each goes to every member who does not show it, or only to the names you list under **Only these members**. With **Swap weapons for buffs** on (Combat → Buffs & imbue), **Gear for <skill>** decides what is worn for it: **Automatic** wears the weapon the skill needs from your bag (with **Wear the weapon each buff needs** on), or pick **Primary weapon**, **Secondary weapon** or **Shield**. The bot changes weapons, casts the buff, then puts your primary weapon (or what you wore) back, also while hunting is stopped. A party buff that ends when the weapon changes back waits ten minutes before the next try. Party buffs that need the same weapon go out in one weapon change, up to 10 casts on the members and on you, before your combat weapon comes back. A member who does not take one does not hold up the others. A member whose buff has less than a minute left is renewed in that change too. If the game will not renew a buff the member still wears, the bot waits until it runs out. When the game refuses a buff because the member already wears one it does not stack with (for example Earth Fire Protection or Might Guard of Ice), that member is skipped until that buff ends, at most 30 minutes, and the other members still get theirs. The status line lists who is skipped.

It casts only on members you can see within **Support range (m)** (30 by default) and never walks to them. HP is exact for members in view and in tenths otherwise, as the game's party window shows it. A buff that does not appear on the member after two tries waits a minute before the next. It runs while hunting; tick **Also while hunting is stopped** to support a party while you stand still. For a character that only supports, untick **Attack monsters** (Combat → Hunt area). It then never starts a fight, not even with monsters that hit it, and while hunting it keeps picking up loot, its own buffs and party support, at the hunting spot or beside the member it follows (**Following a party member**). Town trips, revival and the walk back work as usual, and the anti-stuck watchdog does not count the time without kills. The top of the page lists the party with HP and MP bars, distance and which assigned buffs each member has. The party matching, resurrection and recruit options are on the same page.

## Resurrecting party members

Tick **Auto-resurrect party members** on the **Party** page to cast your learned Rebirth skill on a dead party member in view. The party list shows HP in tenths, so 0 there can also mean nearly dead.

A member who died while out of view is often drawn standing when you get back to them, because the game only shows deaths it saw. A standing member at 0 in the party list therefore counts as dead, unless the HP the server sent when the player came into view says otherwise. The bot casts Rebirth and the server decides: a nearly dead member refuses it, and the offer is not repeated within its 30-second answer window. A member the server's HP shows alive is checked again after 30 seconds.

## Accepting resurrection

Tick **Accept resurrection from party members** on the **Party** page. When you are dead and a party member casts Rebirth on you, the bot answers Yes, whether or not hunting is running. Offers from players outside your party, and mutation offers, are left to you. The switch is off by default and saved per character.

If hunting was running when the character died, it resumes after a resurrection you accepted, whatever **On death** is set to: at the hunting spot it simply starts, otherwise it walks back first, however far the spot is (up to about 14 km, walked in short legs), and only stops when the spot is out of reach, in another world or in a dungeon. The memory lasts 15 minutes; a revive you or the bot does yourselves resumes nothing. While this switch is on and an online party member is in view, a bot set to revive (or the town cycle's revive) waits up to 20 seconds instead of 5 before reviving itself, and never revives while a resurrection offer is open.

## Joining the main account's party

For your other accounts. On the **Party** page tick **Join the main account's party** and type the main character's name. While the character is not in a party, the bot accepts a party invitation from that character, or pages the party-matching board for their listing and applies to it (every 20 seconds at most). It does nothing while the character is in another party, and stops when the party is full or the character's level is outside the listing's range; the status line says which. The main account needs **Auto-recruit** and **Auto-accept party-matching joins** ticked and must not use this option itself. After a disconnect the party is rejoined as soon as automatic reconnect has the character back in the game.

**Leave someone else's party when the party leader is back** makes an alt leave a party led by another character, so it can join the main's party again. It leaves only when the main character is in view and within 30 m of the hunting area (anywhere in view without a saved hunting spot). When the main disconnects, the game makes another member the leader; the party then stays together, with its shared experience, buffs and resurrections, until the main is back at the hunting spot.

The main answers an application within one tick, also while dead or busy. The game refuses an application that is not answered within 10 seconds, so a main that is loading (a teleport, a town scroll) can still refuse one. The alt then applies again, 20 seconds after its last application. Before each new application it reads the party board again: the main's listing gets a new number each time it is registered again (after a disconnect, or when the party broke up), and an application to the old number never reaches the main.

## Starting the bot when you enter the game

Tick **Start the bot when this character enters the game** under **Settings → Behaviour** (off by default, saved per character). Each time the character enters the game (after logging in or after going back to character select), the bot waits about 5 seconds for the game to settle: the character loaded, the inventory known, no manual-control pause, and collision data for up to 20 more seconds. Then it continues from where the character stands, the same way as after a reconnect:

- **At the hunting spot:** it starts hunting.
- **In the town of your saved town services, far from the spot:** with the scroll town cycle on, it does the town services from where it stands, without a return scroll, then reverses or walks back to the hunting spot.
- **Anywhere else:** it walks back to the hunting spot, as **Return & hunt** does.
- **Dead:** it starts hunting so your death handling revives it and returns. With **On death: Stop** and the town revive off, it stays stopped and says so.

It acts once per entry. A teleport or a town scroll is not a new entry. Pressing **Stop all**, **F8** or **Start / stop** before it fires cancels it for that entry, and after a reconnect the reconnect decides, so a bot you had stopped stays stopped. Without a saved hunting spot it does nothing and tells you. The status line shows what it is waiting for.

**It remembers your last Start or Stop.** The bot keeps, per character and across reloads, whether you last started it (**F8**, **Start / stop**, **Return & hunt**, **Start training**) or stopped it (**F8**, **Start / stop**, **Stop all**, **Stop training**).

- **You stopped it last:** auto-start leaves the character stopped on the next entry and says so.
- **You started it last, or never chose:** auto-start starts it.
- **Stops the bot makes by itself** do not change the choice and do not cancel an auto-start that is waiting. Examples: a world transition, a page reload or the settings loading after login.
- **Connection lost while auto-start waits:** the reconnect counts the bot as running and resumes hunting once the character is back.
- **You stop the bot during a reconnect, or just before the page reloads:** hunting does not come back when the character is back.

## Starting again after the bot stops by itself

Tick **Start again when the bot stops by itself** under **Settings → Behaviour** (off by default, saved per character). It is for stops nobody chose, for example a town trip that failed, a walk back that got stuck or a stop on a world change.

**When it starts again**

- The bot was running and stopped on its own.
- Your last choice was Start, or you never chose (see **It remembers your last Start or Stop** above).
- It waits 2 minutes, and also 2 minutes after your last manual move, so it does not take over while you play.
- Then it does what **Return & hunt** does: hunting at the spot, town services in your town, or the walk back.
- The status line counts down and names the reason it stopped.

**When it does not**

- **Stops you chose:** out of HP potions, bag full, **On death: Stop**, the anti-stuck and trapped limits, a trip interrupted by manual control, no saved hunting spot. These are final.
- **A stop right after your own action in the game:** for example a scroll you read or a portal you took by hand. You moved on, so it is final.
- **You pressed Stop:** the bot stays stopped.
- **The character leaves the game or you change character:** a waiting retry is dropped. A reconnect or auto-start handles the next entry.
- **The same reason twice within 30 minutes:** it stays stopped, writes a warning to the log and shows it on screen. Check the character.
- **A fourth stop within an hour:** the same.
- **A reconnect or an auto-start is already bringing it back:** it leaves that to them.

## The Start / stop light

A small light in the left corner of **Start / stop** shows whether the bot is running:

- **Green:** hunting, also while dead and waiting to revive.
- **Yellow:** a town trip, a walk back, a reconnect or other bot work.
- **Grey:** stopped.

Point at the button to read the state.

## Automatic reconnect

This is always on; there is no switch. When the connection to the game is lost (a server restart, a network drop), the bot waits for the game's own retries, then asks the game to resume, and if that fails re-enters the world with the login the page already holds, exactly like pressing Enter at character select. It keeps trying every few seconds, then every 30 seconds, for up to 12 hours. It never types or stores your password: if the login itself is gone after a restart, the status line says so and the bot waits for you.

Once the character is back, hunting that was running resumes: at the hunting spot it simply starts again, otherwise it walks back first, however far the spot is (up to about 14 km, walked in short legs), and if the spot is out of reach, in another world or in a dungeon, it stays stopped and tells you to use **Return & hunt**. A bot that was stopped is reconnected but not started, and a dead character is never started. Choosing logout, disconnect, exit or restart yourself, or logging in or entering a character by hand, cancels automatic reconnect.

### When the game fails to load

If the game's loading screen shows **Unable to finish loading** (for example "Renderer failed: Invalid particle graph time"), the bot waits 15 seconds and reloads the page. It remembers the character and whether hunting was running; after the reload the game restores your login from its own session cookie, the bot enters the character again and hunting resumes as described above. If it still cannot get back in, every further reload in a row waits twice as long as the one before: 15 seconds, 30 seconds, 1 minute, 2, 4, 8, 16, then every 30 minutes, each with a small random extra delay so many bots do not reload at the same moment after a server restart. Once the character is back in the game the count starts over. After 12 hours of reloads without getting back in it stops and says so. If the login cannot be restored, the status line says so and the bot waits for you. Logging out or entering a character yourself cancels it.

If the game shows **Your session ended while the connection was gone. Please log in again.**, the server dropped the session (it only holds a lost connection for about 30 seconds), so resuming is pointless. The bot enters the character afresh instead; if that has not worked after 30 seconds it reloads the page the same way, and further reloads in a row wait twice as long each time (1 minute, 2, 4 and so on, up to 30 minutes). It never presses that window's Confirm button, which would log you out.

If the character was killed while the connection was gone, the bot starts hunting again once it is back, so the usual death handling revives it and walks it back to the hunting spot (subject to your **On death** setting).

An application to the main's party that has not been answered after 30 seconds is sent again, so several alt accounts can join one main.

If the character is back in a known town, far from the hunting spot, and the town cycle's revive option is on, the bot does the town services first (the same trip as after a death), then reverses with the scroll or walks back.

If the plain **Disconnected from the server.** box stays up and the resume and three fresh entries have not brought the character back, the bot reloads the page the same way, with the same growing wait between reloads in a row. A server that is down for hours is still retried every 30 minutes, for up to 12 hours.

## Returning after death

Leave **Revive in town and go back to the hunting spot** enabled under **Town → Go to town when…**. With the town cycle enabled, the bot revives, completes town services and reverses back to hunt. Hunting resumes within 30 metres of the last scroll point, or within your saved hunting area after death. Without a reverse scroll, or with **Back to the hunting spot** set to **Walk**, it walks back to the saved hunting spot instead.

Updates, suggestions and bug reports are on Discord (https://discord.gg/Y5H5ZyfQ7u); the **Discord** button at the top of the panel opens the invite. After an update, a window beside the panel shows the patch notes of every version since the one you used before; the bot keeps running while it is open. Click the version number at the top of the panel to read them again. When a newer version is out, the top of the panel names it and its headline ("Update 1.2.77 available: …") next to the **Update** button.

If something stalls, use **Settings → Send bug report**, which opens a draggable report window over the game. Preview the diagnostics, optionally add an explanation and screenshot, then click **Send to developer**. Check screenshots for private details. Nothing sends automatically.

## Auto mastery and skills

Under **Settings → Auto mastery and skills** the bot can spend skill points for you, one confirmed level at a time. It is off by default and saved per character.

- **Masteries:** tick **Raise selected masteries automatically** and tick the masteries you want, in the order you want them raised. A mastery stops at your character level (or 120) minus **Keep this many levels below my level**. Level 0 is free; otherwise the price is the table cost of its current level.
- **Skills:** tick **Upgrade my rotation and buff skills automatically** to learn the next level of the attack, buff and imbue skills you already use. It applies the game's own requirements: the skill must be trainable and the next level of its group, and your mastery levels, prerequisite skills, STR, INT and skill points must be enough. Skills outside your rotations, buffs and imbue are never touched.
- **Reserve:** **Keep this many skill points unspent** is never spent on masteries or skills, for example to save points for something you will learn by hand.
- **Max every skill:** the **Max every skill now** button (same page, below the options) learns and upgrades every skill, level by level, including skill lines you have not started, as fast as the game answers. It raises a mastery only when that mastery is what blocks a skill (up to your character level, or 120), ignores the gap and reserve settings, and when nothing more is allowed it stops and says what is left (for example skill points, strength or intelligence). **Stop** ends it early.
- **Order:** **Spend skill points on** chooses masteries first, skills first, or alternating after each confirmed level.

It works while hunting is stopped and does nothing while you are dead or during a town trip. If the server refuses a level (for example its mastery total limit) the bot waits a minute before trying that one again.

## Luring monsters to the party

For a tank whose party does the killing. Under **Combat → Hunt area → Lure** (the Training page in the classic window), save a hunting spot, then walk to each place you want monsters pulled from and click **Add pull point here** (points A, B, C…, up to 26). Choose a **Single-target taunt** and an **Area taunt**, and tick **Lure instead of hunting**. Start / stop (F8) and **Stop all** work as for hunting.

Each round the character walks to the next point, taunts the monster nearest to it (within **Search radius at a point**), walks back to the spot and holds there for **Hold at the spot (s)** (10 s by default) so the damage dealers take the monsters over, then goes to the next point. On the way back with monsters it stops for **Pause length (s)** after every **On the way back, pause every (m)** (4 s every 10 m by default; 0 m turns the pauses off) so they keep up. The area taunt is cast whenever it is ready and a monster is near, except while holding. The lure never attacks. Below **Back to the party below HP (%)** it gives up the pull and walks straight back without pauses. A point with no monster sends it back with no hold. Potions, town trips, manual pause and death handling work as for hunting; each start begins at the spot. If a point cannot be reached, hunting stops with the reason. Pull points are kept per character and in shared settings' personal part.

## Following a party member

Under **Party → Follow a party member**, tick **Follow a party member while hunting**, choose the member (the default is the party leader) and **Stay within (m)**. While hunting, the bot stays within that distance of the member and hunts around them instead of around your saved hunting spot. The game tells the party where each member is, so it also follows them across the map, up to 300 m, walking around obstacles when collision data is loaded and stopping beside them. **Fight monsters that attack on the way** lets it defend itself instead of walking on. Your saved hunting spot is never changed; it is used again whenever following is off or the member is not in the party, dead, in another area or too far. It does not follow into a dungeon or another area. The stuck check does not count waiting for the member. The status line says what it is doing.

## Auto stat points

Under **Settings → Stat points** tick **Spend stat points automatically** and the bot spends your unspent stat points on Strength and Intelligence as you level up, one point at a time, each confirmed by your unspent count going down. **Strength share** and **Intelligence share** are a ratio: 1 and 0 puts everything into Strength, 0 and 1 everything into Intelligence, 2 and 1 spends two Strength points for every Intelligence point (counted from the points this bot spent since it loaded). **Keep this many points unspent** holds some back. A point the game does not accept is not resent for a minute. It does nothing while you are dead and is off by default.

## When the character uses normal attacks instead of skills

The main panel's status line now says why, for example "Combat: normal attack (1 cooling down)". The reasons are: not learned, paused after a server rejection (the bot skips a skill the game keeps refusing, for 5 to 40 seconds), cooling down, not enough MP, MP below your configured minimum, or no skills in the rotation for that monster class. The same reason is written to Settings → Recent activity (at most every 30 seconds) and included in bug reports as counts only, never skill names. A skill is only treated as rejected after a newer game update arrived and its cooldown still had not started.

When no monster is being attacked, the status line says why, counted from the monsters in view: for example "Monsters in view: 5. Skipped: 3: monster type is switched off (Combat > Hunt area > Monster classes); 2: too far (Hunt radius or Chase distance)." The reasons are: monster type switched off, level outside your minimum or maximum, name filters, too far, another player is fighting it, and recently given up. With nothing in view it says so. The same line is part of bug reports, as counts only.

**Small monsters first** (always on): while fighting a stronger monster, the bot switches to a weaker one that is hitting you, kills it and goes back. It only counts monsters that hit you in the last few seconds within chase distance, only switches to a weaker class (normal, champion, elite, party, giant, titan, unique, weakest first), finishes a target that is below 25% HP, and never switches during a cast. The status line says "switched to … (hitting you); back to … after".

**Avoid other players' targets** (on by default) skips a monster another player has just hit. Hits by your party members, and by their pets, do not count, so the bot joins the monsters your party is fighting.

**Weapon imbue** is renewed as soon as it runs out, also in the middle of another skill's cast and before a normal attack. A skill takes the imbue when its cast ends, not when it starts, and the game accepts an imbue during a cast, so the skill being cast still gets it. An imbue's cooldown is as long as the imbue itself, so it cannot be renewed earlier; the 1.2.74 setting **Renew imbue when seconds left** was removed in 1.2.75 because of that.

When the pickup pet is ready but collects nothing, the status line says why, counted from the drops in view: for example "Drops in view: 4, ready to collect: 1. Not collected: 2: not wanted by your Loot settings (1 equipment, 1 other items); 1: too far from you (Pickup radius)." The part in brackets names the item kinds that are switched off, so you can see exactly what to switch on. The reasons are: type switched off or excluded or SoX only, too far from you, outside the hunting area, belongs to another player, too far from the pet, the pet is not ready, no room in the bag, and recently failed. **Finish current fight before character pickup** only affects a character collector; a pickup pet collects during fights whatever it is set to.

## Auto skill upgrades: which skills

**Upgrade my rotation and buff skills automatically** (Settings → Auto mastery and skills) raises the next level of skills you have **already learned** and that are in your attack rotations, buffs or weapon imbue on the Combat tab. A skill that is in none of those lists is never raised, and new skills are never learned. The status line under the switches names each skill it is not raising and why (not learned yet, already at its highest level, mastery or strength too low, prerequisite missing, not enough skill points). **Skills to upgrade** can be switched from the default (only those lists) to **All skills I have learned**: the skills you use are raised first, then every other skill line you already have, still only the next level of skills you already know. The order dropdown only matters when both the mastery and the skill switches are ticked.

## Waiting for a party resurrection

With **Accept resurrection from party members** on, the bot waits 20 seconds after dying before it revives itself whenever a living party member is in view (seen in the last 15 seconds counts), so the member has time to resurrect it. Without a helper in view it revives after 5 seconds. The Activity log says which when the character dies, and an open resurrection offer is always answered first.

## A character that cannot move

A character that should be walking (chasing, returning or picking up) but has not moved at all for 20 seconds, with nothing being damaged, is treated as stuck, for example inside a tree. The bot first steps back to the last position it was walking from, then walks to the nearest open ground (this needs the game's collision data). If both fail it stops hunting with an alert chime and a message, instead of standing there for minutes; it never uses a return scroll by itself. The Activity log and the bug report say whether the collision data thinks the character's tile is blocked. Switch it off or change the time under **Settings → Obstacles**.

## Why did it go to town?

Every town trip writes its reason to the **Activity** log, for example "Town trip started: potions running low", and the town status line repeats it during the trip. The Activity log is in the Wide window (press **Wide** in the title bar). The reasons are: character bag nearly full (always on), pickup pet nearly full, potions or ammunition low, weapon broken, gear worn down, no XP for a while, every set number of minutes, returning after a death, or started by you. The bug report includes the reason of the current or last trip.

## Picking up one item without its whole kind

On the **Items** page, **Pick always** takes one exact item whatever the Loot switches say, so you do not have to switch on potions, equipment and so on just to get one item. A rule is for that exact item: each size or degree is its own item. Tick **Only items on the ground now** to list just the drops in view and set the rule on exactly what is dropping. When something is skipped, the pickup status line shows the item numbers behind it (for example "12 potions #19 #20"); the Items table shows the same number when you point at an item.

## Who picks up what

In **Loot → Who picks up what**, every kind of drop (gold, potions, equipment, elixirs, lucky powders, magic stones, attribute stones, other alchemy items, other items) is set to **Leave on the ground**, **Pickup pet** or **Character**, so the pet and the character can work side by side. The pet collects during fights and fills its own bag; the character walks to the item and uses your bag, so give it only the kinds you want on you, for example potions or pills. **Default collector** decides for kinds you have not set yourself and for names under **Always include**. One pickup runs at a time; the pet's drops go first. **Finish the current fight before picking up** applies to the character only.

## Walking around obstacles

While chasing a mob the game walks the character straight at it, so a tree or wall in between stops it dead. Under **Settings → Obstacles** (on by default), when the character has stood still for 2.5 seconds without hurting its target and the game's collision data says the straight line is blocked, the bot walks the planned route around the obstacle until the straight line is clear, then the normal attack takes over. After three detours on one mob it drops that mob for a minute and picks another. It needs the collision data the game loads and works outdoors only; in a dungeon the existing no-damage timeout still applies.

## Anti-stuck

Under **Settings → Anti-stuck**, the bot watches for progress while hunting: a confirmed kill, XP, gold, a pickup, or damage to your target. If nothing happens for the set time (default 3 minutes), it recovers in steps: first it drops the current target, then it walks back to the saved hunting spot and resumes, and after the set number of failed recoveries (default 3) it stops hunting. Any confirmed gain clears the count. Resting, buffing, looting, shopping, town trips and manual control do not count as stuck.

## SoX alerts

When the bot confirms a pickup of Star, Moon or Sun equipment, it shows the item name and tier and plays a short chime. Turn it off with **Chime and notice when a SoX item is picked up** in **Loot**; **Test SoX chime** previews the sound. The count also appears under Session stats. It needs the item catalogue, which loads automatically when hunting starts, and it only announces bot pickups.

## Session stats

Open **Settings → Session stats** for hunting time, XP/hour, net gold, confirmed kills, deaths, potion use, pickups and SoX found. Totals pause when hunting stops and stay across toggles. **Reset session**, reloading or changing character clears them. Stats stay local to the page.

## Map

The **Map** page draws the game's minimap around you with your hunt radius (yellow circle) and chase distance (dashed ring), and shows you, monsters, party members (also ones out of sight, at the edge), other players, NPCs and pets. Click the map to mark a point and press **Make this the hunting spot** to hunt there; the point uses your current height, as the game's own map does. Under the map, **Hunting area** also takes outdoor **X** / **Y** coordinates in whole metres: **Set spot** saves them as the hunting spot, **Set actual position** saves where you stand, and **Get position** and **Copy** show and copy your current coordinates without changing the spot. Drag to look around, use **+** and **−** or the mouse wheel to zoom, and **Follow me** to centre on yourself again. Hunt radius and chase distance can be changed under the map. Dungeons have no map yet.

## Wide window

Click **Wide** at the top of the panel for a wider window: a status strip with HP, MP and EXP bars and what the bot is doing, the pages as a list on the left, session numbers and supplies always on the right, and the activity log along the bottom. The pages hold the same settings as in the compact window, in two columns. **Compact** switches back; the compact window is the default. The choice is remembered, and screens narrower than 900 pixels always get the compact window.

## Classic window

Click **Classic** at the top of the panel (screens at least 900 px wide) for a fixed-size window laid out like SBot: a menu bar (Settings, Lists, Help), HP, MP and EXP bars with the bot status beside them, three wide buttons (Start / stop, Return & hunt, Stop all), the tabs down the left, and your session numbers, supplies and **Start training / Stop training** always on the right. The tabs are Settings, Skills, Items/Storage, Stall, Training place, Party/Autores, Player buffing, Auto alchemy and Extra, then Map, Wardrobe and Setup. They hold the same settings as the compact and wide pages, regrouped under SBot's headings, so a change made in one window shows in the others. SBot tabs for things the bot cannot do yet (Chat, Union Party, Auto quest, Other players, Alarms) are not shown. **Compact** brings the small window back; a narrow screen always shows the compact window.

## Minimised panel

The **×** at the top right of the panel, or **F6**, minimises it to a small icon, so it stays out of the way while the bot keeps running. Its dot shows the state: green while hunting, yellow during a town trip, walk back, alchemy or reconnect, and red when stopped, dead or in error. Hover the icon for the current status, HP and MP. It glows when something needs you (a warning, a SoX pickup or a death) until you hover it or open the panel. Drag it anywhere; it keeps its spot and stays minimised after a reload. The panel itself also reopens where you last dragged it. Click it or press **F6** or **F7** to bring the panel back.

## Controls

| Control | Action |
| --- | --- |
| **F8** | Start or stop the bot |
| **×** (top right) | Minimise the panel to a small icon; the bot keeps running |
| **F6** | Minimise the panel to a small icon, or bring it back; also shows a panel hidden with Shift+F7 |
| **F7** | Fold or unfold the panel; brings a minimised panel back |
| **Shift+F7** | Hide or show the panel; the bot keeps running |
| **Return & hunt** | Walk to the saved hunting spot, then start hunting |
| **Stop all** | Cancel hunting and automated trips; potion use has its own switch |

## Long walks are checked against the game map (beta)

A long walk back follows a corridor from the converted route data, which was made from another map and is wrong in places (a slope it climbs can be a cliff here). Before walking it, the bot asks the game for the collision of each region on the way, the same data the game loads when you get there, and walks every step of the corridor with the game's own movement rules. A step that does not walk is left out and the corridor is planned again around it, so the walk takes a way that exists, for example round the rim from Hotan to the Karakoram aircraft dock instead of through the crater. While it checks, the status says so and the character waits; a long corridor takes a few seconds to a minute. On the way, a corridor point the character cannot stand on (a rock edge) is passed close by or skipped. If the game's asset loader was not seen (the bot attached after the game started), the corridor is walked unchecked, as before.

## Teleports and ferries on the way back (beta)

When the hunting spot cannot be reached on foot from where the character stands (across a river, or between parts of the map with no walking connection), walking back uses the game's teleporters and ferries, the same ones you would click. Hotan to the western bank, for example, walks to the ferry on the Hotan side, pays its fee, crosses, and walks on to the spot. The bot picks the cheapest mix of walking and hops it can afford, selects the teleporter, waits for its menu and asks for the destination, exactly as the menu does. A teleporter that refuses (not enough gold, level too low, a trade cart) is left out and another way is tried; with no other way the walk stops and says why. A world change other than the hop itself, manual control, Stop or F8 ends the trip. Switch it off with **Walking back may use teleports and ferries (beta)** under **Combat → Hunting area**; then such a walk stops as before. The bot stops about 15 m from the teleporter, within talking range, because many stand on a dock or a ship.

Both are beta: they were tested on the Hotan to Karakoram aircraft dock route. If a walk takes an odd way, send the log; the **Route check** and **Travel** lines show what was checked and used.

## If a town trip stalls on the way to a merchant

The main panel's status line and Send bug report now name what the walk is waiting for, for example "Town movement to the potion merchant: waiting; retrying collision route. No walkable route found through the loaded collision map." The bot never walks blindly through obstacles, so it keeps retrying until the route works or you press F8.

Before it retries, two things happen on their own. If the character stands where the collision map has no way out (on a blocked tile or right against a wall, which can happen after logging in), it first takes a short step to the nearest open ground that is not behind a wall. And if a walk to a service finds no route or cannot get around an obstacle, it walks to the town start (the saved arrival point, where the return scroll lands) once and tries the service again from there.

- **"Waiting for game collision data" / "Waiting for collision coverage":** the game has not given the bot a collision map for the town you arrived in. Reload the game and try again.
- **"No walkable route found":** save that service point again from open ground a few steps in front of the NPC (stop hunting, stand there, select the NPC and click its Save button).
- **"Blocked route (no progress for 20 s)":** something is physically in the way; check the character is not stuck behind another player or object.

## If a sale, purchase or deposit gets no answer

Sometimes the game never answers a sale, purchase or warehouse move, or the result does not show up in the bag within 15 seconds. The game's replies carry no request number, so the bot never sends the same command again: a late answer could sell or buy twice. Instead it continues in four steps:

1. It waits for the game to finish the inventory action. The status line says "waiting for the game to finish the last inventory action".
2. It closes the open shop or warehouse window.
3. It starts that service again (the warehouse, the potion merchant or the repair merchant) from what the bag and the pet hold now. An item that was already sold is not offered again, and potions are bought only up to the refill target. An item whose deposit did not happen is deposited first.
4. If the game is still busy after a minute, the bot reloads the page, and the reconnect enters the world again. With **Revive in town and go back to the hunting spot** on, it then does the town services from where the character stands. With it off, it resumes hunting as after any reconnect. The bot reloads for this at most once in 30 minutes: if the game hangs again within that time, the trip stops.

The second time this happens in the same trip, the trip stops with "Town cycle stopped: Inventory transaction timed out. No repeat command sent." In that case, reload the game and check the bag before hunting again. An error the game reports still stops the trip at once, as before. The one exception is a sale the merchant refuses: that item is kept and the rest is sold.

## Sharing and importing settings

Under **Settings → Share and import settings**, **Copy share code** or **Save share file** makes a short code or a file holding only the settings you changed from the defaults, ready to post in Discord. A share never contains your hunting spot, town and merchant points, walking routes, buff weapon sets or wardrobe, so it works on any character. To import, paste a code or **Open file…** and press **Preview import**: it lists exactly which settings would change and nothing happens until you press **Apply import**. Your own positions, town points, buff weapon sets and wardrobe are kept, and **Undo last import** brings your previous settings back. Files that are not a share, contain unsafe keys or are too large are refused. **Export full backup (with my positions)** saves everything, including your positions, for your own use.

## If something gets stuck

Read the return status on the main panel. Use **Settings → Send bug report**; the diagnostics it previews include recent return states, even after toggling the bot. Reloading clears that history.

After an update, reload the game and check the version shown in the panel.

## License

GNU General Public License v2.0 or later, copyright nixxane. See [LICENSE](LICENSE). You may use, change and share it, but a version you share has to stay under the same license with its source available.

## Obstacle pursuit and escape recovery

Version 1.2.101 checks blocked approaches before repeating attacks, keeps detour movement exclusive, and abandons unreachable enemies with bounded retries. Escape requires collision-checked destinations and fresh movement confirmation. Under Settings, optional recovery recall and detailed local diagnostics both default off. Recovery recall completes town services and stops in town instead of reversing into the trap. See [OBSTACLE-RECOVERY.md](OBSTACLE-RECOVERY.md) for behavior, limits and validation commands.

### 1.2.102 targeting correction

The 1.2.101 preflight was too aggressive on sloped terrain. Version 1.2.102 removes the horizontal planner's height cutoff and requires observed native approach failure before abandoning an initially unrouteable target. Missing coverage and exhausted searches keep normal targeting active; failure memory never excludes a different nearby monster.
