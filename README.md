# NIX

OpenSRO bot: hunting, potions, pet loot and automatic town trips. Developed by 100.

**[Install](https://raw.githubusercontent.com/nixxane/opensro-bot-lean/main/bot.lean.user.js)** with Violentmonkey (disable any other OpenSRO bot), then reload the game. It checks for updates itself.

## Start

1. **Combat:** save your hunting spot, pick attack skills, buffs, imbue.
2. **Loot:** choose what to collect. Summon your pickup pet and set it as collector.
3. **Supplies:** set HP/MP potion thresholds.
4. **F8** starts and stops.

The **Setup** page checks all this for you and fixes the next missing thing.

## Features

- Combat rotation, buffs with weapon swapping, imbue, party heal/buff, resurrection
- Pet and character looting with per-item rules (pick, store, sell, keep, drop)
- Optional pickup-pet slot balancing, and a primary/secondary weapon and shield that are never sold, stored or dropped
- Town trips by return scroll: potions, repair, warehouse, selling, reverse back
- Optional selling of ordinary gear from the character bag on town trips (off by default)
- Item alchemy, auto mastery and skills, stat points
- Auto trade: buy specialty goods in one town, walk to another and sell them (needs a trader suit and a transport)
- Automatic reconnect, optional start on entering the game, walk-back after death, anti-stuck, obstacle detours
- Minimap, session stats, wardrobe, share and import settings

Settings are saved per character.

## Keys

| Key | Action |
| --- | --- |
| **F8** | Start / stop |
| **F6** | Minimise to an icon / bring the panel back |
| **F7** | Fold panel (brings a minimised one back) |
| **Shift+F7** | Hide / show panel |
| **×** | Minimise to an icon, bot keeps running |

## More

- [Full manual](docs/manual.md)
- [Obstacle recovery](OBSTACLE-RECOVERY.md)
- Help, suggestions, bug reports: [Discord](https://discord.gg/Y5H5ZyfQ7u), or **Settings → Send bug report** in the panel

## License

GPL-2.0-or-later, copyright nixxane. See [LICENSE](LICENSE).
