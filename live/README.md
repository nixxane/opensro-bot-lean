# NIX live

Watch your bots from your phone: status, HP/MP/XP, XP per hour, gold, kills, drops and the activity log, one card per character, refreshed every 10 seconds.

The bot has a built-in **Live dashboard** in Settings. It is off by default. When you turn it on, the bot sends a small snapshot of itself to a hub that you run yourself, every 10 seconds by default (3 to 60). Nothing goes through nixxane bot servers, there is no account, and the address and code stay in your browser. For a summary every few minutes instead, see Discord session reports in the same Settings.

You need one hub, reachable over HTTPS. Pick one:

| | Needs | Phone link stays the same | PC must be on |
| --- | --- | --- | --- |
| 1. Cloudflare Worker (recommended) | free Cloudflare and GitHub (or GitLab) accounts, nothing to install | yes | no |
| 2. Your PC with a named Cloudflare tunnel | a domain on Cloudflare, `cloudflared` | yes | yes |
| 3. Local only | Node.js 18+, the separate reporter script | n/a (this machine only) | yes |

## 1. Cloudflare Worker (recommended)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nixxane/opensro-bot-lean/tree/main/live/worker)

The Worker and one Durable Object run on your own Cloudflare account and serve the dashboard at a stable `https://nix-live.<your-name>.workers.dev` address. No PC has to stay on, no tunnel is needed, and you install nothing. You need a free Cloudflare account and a free GitHub (or GitLab) account: Cloudflare copies the Worker into your own repository and builds it from there.

1. Click the button above (or **Set up free on Cloudflare** in NIX, Settings, Live dashboard). Sign in to Cloudflare and to GitHub (or GitLab) when asked, and accept the defaults. Wait for the build to finish.
2. Open the worker address Cloudflare shows (`https://nix-live.<your-name>.workers.dev`). You see "Your NIX live hub is running."
3. Press **Create my private link**. This makes your private code. It can only be done once.
4. On the page that follows, press **Pair NIX in this browser** in the browser where the game runs. NIX asks "Pair with a live hub?"; press **Pair**. That saves the hub and turns the dashboard on. Nothing is saved until you press Pair.
5. Scan the QR code with your phone, or copy the link under it. Your characters appear within about 10 seconds of entering the game. Bookmark the page: `<address>/pair/<code>` shows it again.

Do steps 2 and 3 right after the build: whoever presses Create first owns the hub.

### Lost your link?

In Cloudflare open **Workers & Pages**, your worker (`nix-live`), **Settings**, **Variables and secrets**, and add a secret named `LIVE_CODE` with any 16 to 64 letters, numbers, `-` or `_`. Then open `<address>/pair/<that code>` to pair NIX again, and `<address>/#<that code>` on your phone. A `LIVE_CODE` secret always wins over the code made by the Create button, so deleting the secret brings the first code back.

### For technical users

With Node.js 22+ you can deploy from this folder instead of the button:

1. `cd worker`, then `npm install`.
2. `npx wrangler login` (once; opens a browser to sign in to your Cloudflare account).
3. `npm run setup`. It makes a private code, deploys the Worker, stores the code as the Worker secret `LIVE_CODE` and prints two links. Run `npm run setup -- --keep-code` later to redeploy with the same code.
4. Open the **pair link** in the browser where the game runs and press **Pair** in NIX. Open the **dashboard link** on your phone.

`wrangler.jsonc` has no rate limit binding because the button deploy may not support one; the Worker runs without it. To add a per-IP limit by hand, see the comment in that file.

Cost: the free plan is enough. One character reporting every 10 seconds plus one open dashboard polling every 10 seconds is about 17,000 requests a day against the 100,000 daily limit. Reporting every 3 seconds, or several characters or open dashboards, uses more; when the daily limit is hit Cloudflare refuses requests until it resets, and the bot just waits and retries.

## 2. Your PC with a named Cloudflare tunnel

1. Start the hub and leave its window open, with `PUBLIC_URL` set to the tunnel's HTTPS address.
   - macOS / Linux: `PUBLIC_URL=https://live.example.com node hub.js` in this folder
   - Windows: set `PUBLIC_URL` first, then double-click `start.bat`
2. Point a named tunnel at `http://127.0.0.1:4173` ([Cloudflare's guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)).
3. The hub prints a **Pair link** (`<PUBLIC_URL>/pair/<code>`). Open it in the game browser and press **Pair** in NIX, as above. Open `<PUBLIC_URL>/#<code>` on your phone.

A quick tunnel (`cloudflared tunnel --url`, which the hub starts for you when `cloudflared` is installed) needs no account but gets a new address on every start, so it is for testing only: you would have to pair again each time.

## 3. Local only

The separate **NIX live reporter** userscript sends from the browser to a hub on the same machine, with no Cloudflare involved.

1. Start the hub: `node hub.js` here, or double-click `start.bat` on Windows (set `TUNNEL=off` to skip the phone link).
2. It prints an **Install reporter** link. Open it in the browser where the game runs, accept it in Tampermonkey, reload the game tab. If Tampermonkey asks whether the script may connect to `127.0.0.1`, choose "Always allow".
3. Open the **Dashboard** link on this machine.

Do not also turn on the bot's Live dashboard for the same hub; the two would report twice.

## Good to know

- **The code is private.** Anyone who has a dashboard or pair link can watch your stats. The part after `#` (or after `/pair/`) is the code. For the Node hub it is created on first start and kept in the `.code` file; for a Worker made with the button it is kept inside your Worker and shown on its pair page; for `npm run setup` it is in `worker/.code` and in the Worker secret. Never share those files, pages or links. To get a new code, delete `.code` and restart the hub, run `npm run setup` without `--keep-code`, or set a new `LIVE_CODE` secret on the Worker (see Lost your link?), then pair again.
- **Pairing never applies by itself.** A pair link only asks; a crafted link cannot point your bot at someone else's hub unless you press Pair. Only pair with a hub you set up yourself.
- **What is sent**: character name, level, HP/MP/XP, state, position, session totals and the last 12 activity lines. It never includes game commands, account details or inventory contents.
- **What stays in your browser**: the hub address and code. They are not part of share codes, backups, bug reports or the log.
- **"Offline" appears after 90 seconds without a report.** A background game tab can report as rarely as once a minute, so a late report first shows its age. A character that has not reported for a day is dropped.
- **Several bots** report to the same hub; the Worker keeps up to 50 characters.
- **The Worker stores** each character's latest report (updated about once a minute) so it survives a restart. The Node hub keeps it in memory only.
- **It is read-only.** The bot sends its own stats and never takes anything from the hub.

## If something is wrong

| You see | What to do |
| --- | --- |
| "Waiting for a bot to report…" | Turn on Live dashboard in the bot's Settings (or pair), and check the status line there. |
| "This page needs your private link" or "wrong code" on the dashboard | Open the link from your hub's setup page (scan its QR code). If you lost it, see Lost your link? |
| "This hub is not set up yet" | Open the worker address without anything after it and press Create my private link. |
| "Off: Hub refused the code." in NIX | The code changed. Pair again with the new pair link. |
| "No answer from the hub" in NIX | The hub address is wrong or unreachable, or it is not HTTPS. Test the address in a browser. |
| "hub unreachable, retrying…" on the dashboard | The hub or tunnel stopped. |
| "Port 4173 is in use" | The hub is already running in another window. To use another port, set `PORT` (macOS / Linux: `PORT=4180 node hub.js`). |
| Stats stop after a NIX update (reporter script only) | NIX changed what the reporter reads. The console shows `[NIX live] bot layout changed`. The built-in dashboard does not have this problem. |

## Files

- `hub.js`: the Node hub, no dependencies. `hub.test.cjs`: its self-check (`node hub.test.cjs`).
- `worker/`: everything the Cloudflare button deploys, self-contained: the Worker and Durable Object (`worker.mjs`), its pages (`pages.mjs`), the QR code (`qr.mjs`, using the pinned `qrcode-generator` package), `dashboard/index.html` (the dashboard page, also served by `hub.js`), `wrangler.jsonc`, `setup.mjs`, and tests. After `npm install` there, `npm test` runs them locally with Miniflare; they are not part of the release checks.
- `reporter.user.js`: the separate Tampermonkey script for the local-only option; install it from the hub's link, which fills in your code. `reporter.test.cjs`: its self-check.

Both hubs speak the same small protocol: `POST /report` with an `X-Code` header, `GET /state`, `GET /pair/<code>`, and `OPTIONS` answered without a code. The Worker adds `POST /setup` (the Create button). The built-in client is `lean-live.js`; the reporter script reads the bot's diagnostics on `window.SROLean` (`stats`, `world`, `hunt`, `log`, `activity.userMessage`), so if those change, update `snapshot()` in `reporter.user.js` and its test.
