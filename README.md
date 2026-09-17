# OpenClaw Mission Control

A live execution map for your four-agent OpenClaw setup (main, sysadmin, devops, security).
It is a read-only operator client of the Gateway: it does not touch agents directly and changes nothing in your OpenClaw config.

```
OpenClaw Gateway ──ws──▶ server.js ──▶ normalizer.js ──▶ graph.js ──SSE──▶ public/index.html
 (source of truth)       handshake,     raw frames →      state +          map, particles,
                         subscriptions  graph ops         pruning          feed, replay
```

## Run it on the VPS

```bash
cd mission-control
npm install            # one dependency: ws
cp .env.example .env   # set OPENCLAW_GATEWAY_TOKEN
npm run probe          # first run: prints every Gateway event it receives
npm start
```

It listens on `127.0.0.1:4400` only. From your laptop:

```bash
ssh -L 4400:127.0.0.1:4400 you@your-vps
# then open http://localhost:4400
```

Don't expose port 4400 publicly: anyone who can load the page sees your agents' commands.
Open `index.html?demo` to see the scripted demo instead of live data.

## First-run checklist

1. **Handshake.** `npm start` should log `[gateway] live – scopes: operator.read`.
   If the Gateway rejects the connect, check the token, then `MC_CLIENT_ID` / `MC_CLIENT_MODE`.
   Newer Gateways may require a paired device identity (signed challenge) for operator scopes. If the connection
   succeeds but no session events arrive, that's the likely cause: see docs.openclaw.ai/gateway/protocol/auth.
2. **Event shapes.** Trigger a small task ("check disk usage on the VPS"), then read `logs/events.jsonl`.
   The normalizer reads fields defensively, but payload field names vary between OpenClaw versions.
   If something doesn't appear on the map, find the frame in the log and add its field path to the
   matching `pick(...)` call in `normalizer.js`. That file is the only place that knows about the Gateway's shapes.
3. **Pin your OpenClaw version** once it works, and recheck the log after upgrades.

## What maps to what

| Gateway event | On the map |
|---|---|
| `session.message` (user, in main) | New mission, map resets, replay recording starts |
| `sessions.changed` with `spawnedBy` / `parentSessionKey` | Agent attaches under whoever delegated to it, delegation particle |
| `agent` lifecycle start / end / error | Agent status: thinking, done, failed |
| `session.tool` start / end | Tool card under the agent, exec and result particles |
| `exec.approval.*`, `session.approval` | Amber approval card |
| `chat` with `state: "error"` | Agent turns red with the error |

Each agent keeps its 6 most recent tool/approval cards; older finished ones drop off.

## Approvals (off by default)

The map shows approval requests either way. To approve from Mission Control:

1. Confirm the approval-resolve RPC name and params for your OpenClaw version
   (Gateway RPC reference → approval families). The defaults in `server.js`
   (`exec.approval.resolve` with `{ id, decision: "allow-once" | "deny" }`) are **unverified placeholders**.
2. Set `MC_ENABLE_APPROVALS=1`. Mission Control then requests `operator.approvals` in addition to `operator.read`.

This widens what a compromised browser session could do, so keep it behind the SSH tunnel.

## Files

- `server.js`: Gateway client (challenge → connect → `sessions.subscribe` → per-session `sessions.messages.subscribe`), reconnect with backoff, SSE, approval endpoint
- `normalizer.js`: raw Gateway frames → `mission` / `upsert` / `pulse` / `log` ops
- `graph.js`: server-side graph state, so a reloaded browser gets the current map immediately
- `public/index.html`: the whole UI, no build step; also contains the demo script

## Ideas for V2

- Persist ops per mission to disk so replay survives restarts and you can browse past missions
- Click a tool card to fetch the full output via `chat.message.get`
- Collapse/expand agent subtrees for long missions
- Run it as a systemd user service next to the Gateway
