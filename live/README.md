# NIX live

Watch your bots from your phone: status, HP/MP/XP, XP per hour, gold, kills, drops and the activity log, one card per character, refreshed every few seconds.

This is an optional companion, separate from the bot: the bot itself is unchanged and sends nothing. Everything runs on your own machine. There is no account and no quota, and nothing is stored. With the phone link on, traffic passes through Cloudflare's tunnel. For a summary every few minutes instead, see Discord session reports in the bot's Settings.

## What you need

- The bot running in a browser with Tampermonkey (or Violentmonkey)
- This `live` folder on the machine the bots run on
- [Node.js](https://nodejs.org/) 18 or newer
- `cloudflared`, for the phone link
  - macOS: `brew install cloudflared`
  - Windows: `winget install Cloudflare.cloudflared`
  - Linux: see [Cloudflare's downloads](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/)

Without `cloudflared` the dashboard still works, but only on the machine itself.

## Start

1. Start the hub and leave its window open.
   - macOS / Linux: `node hub.js` in this folder
   - Windows: double-click `start.bat`
2. It prints three links:
   - **Install reporter**: open it in the browser where the game runs, accept it in Tampermonkey, then reload the game tab. If Tampermonkey asks whether the script may connect to `127.0.0.1`, choose "Always allow". You do this once.
   - **Phone link**: open it on your phone. Your characters appear a few seconds after they enter the game.
   - **Dashboard**: the same page, for this machine only.

## Good to know

- **The phone link is private.** Anyone who has the full link can watch your stats. The part after `#` is your code; it is created on first start and kept in the `.code` file. Never share that file or the link. The install link carries the same code, so treat it the same way. On Windows the `.code` file is not locked to your user the way it is on macOS and Linux, so keep the folder private. To get a new code, delete `.code`, restart the hub and install the reporter again.
- **The phone link changes on every start.** Only the address changes; your code stays the same. The link is printed once its address resolves, which the hub checks with the public resolver `1.1.1.1`; on a network that blocks it, the link appears after 30 seconds instead.
- **Local only.** Set `TUNNEL=off` to skip the phone link (macOS / Linux: `TUNNEL=off node hub.js`).
- **"Offline" appears after 90 seconds without a report.** A background game tab can report as rarely as once a minute, so a late report first shows its age ("Hunting · fight · 40s ago"). A character that has not reported for a day is dropped.
- **The hub must be running** on the machine with the bots. If that machine sleeps, the dashboard shows the bots as offline.
- **Several bots** on the same machine all report to the same hub. Nothing extra to set up.
- **Nothing is stored.** The hub keeps only each character's latest report in memory.
- **It is read-only.** The reporter reads what the bot shows and never sends anything to the game.

## If something is wrong

| You see | What to do |
| --- | --- |
| "Waiting for a bot to report…" | Check the reporter is enabled in Tampermonkey and reload the game tab. |
| "wrong code" | Open the phone link exactly as the hub printed it. |
| "hub unreachable, retrying…" | The hub or tunnel stopped. Start it again and use the new phone link. |
| "Port 4173 is in use" | The hub is already running in another window. To use another port, set the `PORT` environment variable (macOS / Linux: `PORT=4180 node hub.js`), then install the reporter again. |
| Stats stop after a NIX update | NIX changed what the reporter reads. The browser console shows `[NIX live] bot layout changed`. |

## Files

- `hub.js`: the hub, with no dependencies
- `reporter.user.js`: the Tampermonkey script; install it from the hub's link, which fills in your code
- `dashboard/index.html`: the dashboard page
- `reporter.test.cjs`, `hub.test.cjs`: self-checks, run with `node reporter.test.cjs` and `node hub.test.cjs`

The reporter reads the bot's diagnostics on `window.SROLean` (`stats`, `world`, `hunt`, `log`, `activity.userMessage`). If those change, update `snapshot()` in `reporter.user.js` and its test.
