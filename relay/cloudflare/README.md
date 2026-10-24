# Team relay — Cloudflare Workers edition

The same relay as `relay/server.js`, rewritten for Cloudflare Workers: one Durable Object holds
every room, WebSockets use hibernation (billing follows messages, not connections, so the free
tier is comfortable), and the room store lives in Durable Object storage, durable across
restarts. TLS is automatic — the bot connects to `wss://<your-worker>.<your-subdomain>.workers.dev/ws?key=<room key>`.

## Deploy

```bash
cd relay/cloudflare
npm install -g wrangler   # once
wrangler login
wrangler deploy
```

The command prints your URL. Point every character's Team page at
`wss://<that-url>/ws` — the bot adds `?key=<room key>` itself — and open the console at
`https://<that-url>/?key=<room key>`.

## Verify the deployment

From the repository root, with the Node relay's `ws` client installed (`cd relay && npm install`):

```bash
WS_URL=wss://<that-url>/ws node smoke-test.cjs
```

The smoke test exercises hello/welcome, beat forwarding, the store round trip and public events
against the live worker.

## Notes

- The free tier includes Durable Objects with SQLite storage; with hibernation, an idle
  connection costs nothing until a message arrives.
- The room key is the only access control, both for WebSockets and for the console page — use a
  long random one.
- One Durable Object instance holds all rooms of this worker. That is far more than a fleet
  needs; if you ever run a public service with many rooms, shard by hashing the room key in
  `fetch` instead of the fixed `'global'` name.
- Everything the relay sees is character names and coarse state; no game credentials ever reach it.
