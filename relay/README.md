# Team relay (reference server)

A small WebSocket + HTTP relay for the bot's **Team** mode. Each character's bot connects with a
**room key**; everyone with the same key lands in the same room. The relay forwards presence beats
between them, routes messages with `scope:"public"` to every room, keeps a small key-value store
per room (the team's shared memory: unique history, players seen, drops — persisted across
restarts in `relay-data.json`), and serves a **console page** at `/?key=<room key>`. It holds no
game logic and never sees game credentials — see `docs/TEAM.md` for the full plan.

## Run it

```bash
cd relay
npm install
npm start          # listens on port 4701; PORT=1234 npm start to change
node smoke-test.cjs   # optional: one-shot check of the protocol against a temporary instance
```

Node 18 or newer. The data file lands at `relay-data.json` (override with `DATA_FILE=`).

## Choose your hosting

Three supported paths — pick what the administrator prefers; the bot is identical for all of
them (same protocol, same `wss://` address in the Team page):

| Path | What you get | Where |
| --- | --- | --- |
| **Cloudflare Workers** | Zero administration, TLS automatic, free tier with WebSocket hibernation, store in Durable Objects | `relay/cloudflare/` — see its README (`wrangler deploy`) |
| **fly.io** | The Node relay as-is in a tiny VM with TLS, ~$2-3/month | `relay/` — `fly launch && fly deploy` (uses `Dockerfile` + `fly.toml`) |
| **Your own VPS** | The Node relay behind Caddy/nginx TLS, or a systemd service | this file + `relay/opensro-team-relay.service` |

Whatever you choose, verify it with the smoke test: `node smoke-test.cjs` locally, or
`WS_URL=wss://your-relay/ws node smoke-test.cjs` against the deployment.

## TLS is required

The game page is served over HTTPS, so browsers refuse plain `ws://` to anything that is not
localhost. Put the relay behind a TLS-terminating proxy and give the bots a `wss://` address.
With Caddy one line is enough (`relay.example.com` pointing at your server):

```
relay.example.com {
    reverse_proxy 127.0.0.1:4701
}
```

For quick local tests from the same machine you can point a bot at `ws://127.0.0.1:4701`
(browsers still allow plain WebSocket to localhost); anything remote needs `wss://`.

## Security notes

- The room key is the only access control: it decides who is in the room with you. Use a long
  random string, and a different key per circle of characters.
- Bind the proxy to the public port only after TLS is in place; keep the relay itself on
  127.0.0.1 when the proxy runs on the same machine.
- The relay sees character names and coarse state (hunting, alive, level). It never sees game
  credentials, and the bot never sends game commands through it.

## Protocol (v1)

Client → server:
- `{v:1, type:"hello", token, name, state}` — first message; joins (or creates) the room.
- `{type:"beat", name, state}` — every 5 s; silence for 30 s drops the connection.
- `{type:"msg", scope?, payload}` — routed to the room, or to every room when `scope:"public"`.
- `{type:"kv-put", key, value, scope?}` / `{type:"kv-get", key, scope?}` — the room's store
  (scope `"public"` addresses the shared pool). A put is broadcast to the room as a `kv-value`.

Server → client:
- `{type:"welcome", you, peers:[{name, state}]}`
- `{type:"peer", name, state}` — a member's beat, forwarded.
- `{type:"join", name}` / `{type:"leave", name}`
- `{type:"msg", from, payload}` — a room (or public) message; `from:"console"` ones are commands.
- `{type:"kv-value", key, value, from?}` — store read, or a member's put, forwarded.
- `{type:"error", message}` — then the connection is closed.

## Console

`http://your-relay/?key=<room key>` (only for rooms with characters connected) lists the fleet —
name, state, level, role, position, last beat — plus the tracked uniques, with **Stop everyone**
and **Town trip for everyone** buttons that reach only that room. `/state?key=` is the JSON feed
the page polls.
