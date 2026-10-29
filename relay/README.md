# Team relay (reference server)

A small WebSocket relay for the bot's **Team** presence: each character's bot connects with a
**room key**; everyone with the same key lands in the same room and the relay forwards their
presence beats between them. That is all it does: no game logic, no storage, no commands —
and nothing about the bot depends on it.

## Run it

```bash
cd relay
npm install
npm start          # listens on port 4701; PORT=1234 npm start to change
node smoke-test.cjs   # optional: one-shot check of the protocol against a temporary instance
```

Node 18 or newer. The relay binds to **127.0.0.1 only** by default; `HOST=0.0.0.0 npm start`
exposes it directly (only when something in front does TLS and access control).

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
(the bot accepts plain WebSocket to localhost, matching the browser rule); anything remote
needs `wss://`.

## Security notes

- The room key is the only access control: it decides who is in the room with you. Use a long
  random string, and a different key per circle of characters.
- Keep the relay on 127.0.0.1 behind the proxy when the proxy runs on the same machine.
- The relay sees character names and coarse state (hunting, alive, level). It never sees game
  credentials, and the bot never sends game commands through it.

## Protocol

Client → server:
- `{v:1, type:"hello", token, name, state}` — first message; joins (or creates) the room.
- `{type:"beat", name, state}` — every 5 s; silence for 30 s drops the connection.

Server → client:
- `{type:"welcome", you, peers:[{name, state}]}`
- `{type:"peer", name, state}` — a member's beat, forwarded.
- `{type:"join", name}` / `{type:"leave", name}`
- `{type:"error", message}` — then the connection is closed.
