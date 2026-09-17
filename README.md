# OpenClaw Mission Control

A live execution map and management console for your multi-agent OpenClaw setup. It's a client
of the Gateway, not a replacement for it: everything it can do goes through the Gateway's own
RPCs, and it changes nothing in your OpenClaw config directly.

**Read-only by default.** Watching the map, the activity feed, mission history, and the tool
catalog needs no configuration. Everything that can *change* something — approving a request,
submitting a task, controlling an agent, editing a tool policy — is off until you explicitly opt
in via `.env`, the same way approvals always were. See `.env.example` for every flag, and
`API.md` for the full list of routes and which ones call an unverified-placeholder Gateway RPC
(a best-guess method name that fails with a clear error if your Gateway doesn't implement it,
rather than pretending to work).

```
OpenClaw Gateway ──ws──▶ server.js ──▶ normalizer.js ──▶ graph.js ──SSE──▶ public/index.html
 (source of truth)       handshake,     raw frames →      state +          map, particles,
                         subscriptions  graph ops         pruning          feed, replay, panels
```

`server.js` also persists mission history (`store.js`), authenticates operators (`auth.js`),
records an audit trail (`audit.js`), tracks tool usage and policy (`toolstats.js`/
`toolpolicy.js`), enforces token budgets (`budget.js`), and fires outbound webhooks
(`webhook.js`). See [Files](#files) below for the full list, [`API.md`](API.md) for every HTTP
route, and [`plan.md`](plan.md) for the implementation history and what's deliberately deferred
(a mission task queue, cancel/abort, and multi-Gateway support — all documented there with why).

## Run it on the VPS

```bash
cd mission-control
npm install            # one runtime dependency: ws
cp .env.example .env
bin/mc-gateway-token.sh  # resolves OPENCLAW_GATEWAY_TOKEN from the Gateway, or generates one
npm run probe          # first run: prints every Gateway event it receives
npm start
```

`bin/mc-gateway-token.sh` (also `npm run env:token`) looks for the shared token the Gateway is
already configured with — `OPENCLAW_GATEWAY_TOKEN` in the environment, `openclaw gateway
auth-token --show` (config token / SecretRefs), or `gateway.auth.token` in
`~/.openclaw/openclaw.json` — and writes whichever it finds into `.env`. If nothing is configured
anywhere it runs `openclaw doctor --generate-gateway-token`, or as a last resort generates a
random token itself (warning you to restart the Gateway so it binds it). It's idempotent: once
`.env` has a token it does nothing, so it's safe to run on every deploy. `--force` regenerates.

It listens on `127.0.0.1:4400` only. From your laptop:

```bash
ssh -L 4400:127.0.0.1:4400 you@your-vps
# then open http://localhost:4400
```

Don't expose port 4400 publicly: anyone who can load the page sees your agents' commands, and
(if you've opted into `MC_AUTH_USERS`) only a login stands between them and the admin actions.
Open `index.html?demo`, or click the **Demo** button in the header, to see scripted demo data
instead of live data.

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

Each agent keeps its 6 most recent tool/approval cards; older finished ones drop off (they're
still in mission history — see below).

An event Mission Control doesn't recognize is counted and logged instead of silently vanishing
(the **Health** panel calls this "protocol drift" — it means a Gateway version bump added or
renamed something `normalizer.js` doesn't know about yet).

## Features

Everything below is opt-in unless noted; see `.env.example` for the exact flag and `API.md` for
the route.

- **Login & roles** (`MC_AUTH_USERS`): viewer / operator / admin. Unset (the default) means
  everyone who can reach the page is treated as an admin — today's original open-access
  behavior, unchanged.
- **Audit log** (admin panel): every login, approval, and admin action, who did it and when.
- **Mission history**: past missions are persisted and replayable from the **History** button,
  independent of the live SSE stream.
- **Task submission** (`MC_ENABLE_TASK_SUBMIT`): a **New Task** panel with saved templates
  (`templates.json`).
- **Agent management** (admin): a panel showing every agent's model, status, delegation
  chain, and token usage, with Stop/Restart/Pause/Resume, a config editor, and ad-hoc spawn.
- **Tool catalog & policy**: usage analytics per tool (call counts, success rate, average
  duration) derived from mission history, plus a per-agent-per-tool allow/ask/deny policy
  editor.
- **Token budgets** (`MC_BUDGET_TOKENS_*`): a warning banner at 80% of a limit, "exceeded" at
  100%+, with an optional auto-pause.
- **Outbound webhooks** (`MC_WEBHOOKS`): POST a JSON envelope to your own URL on
  `mission.start`, `approval.waiting`, or `agent.error`.
- **CLI companion**: `bin/mc-cli.js status|tasks|approve <id>|reject <id>` against the same API.
- **Backup**: `bin/mc-backup.sh` tars the plain-file store — there's no database to dump.
- Search/filter, collapse/expand long agent subtrees, desktop notifications, a theme toggle,
  and keyboard shortcuts (`g` recenter, `y`/`n` approve/reject, `m` toggle demo) round out the UI.

## Approvals (off by default)

The map shows approval requests either way. To approve from Mission Control:

1. Confirm the approval-resolve RPC name and params for your OpenClaw version
   (Gateway RPC reference → approval families). The defaults in `server.js`
   (`exec.approval.resolve` with `{ id, decision: "allow-once" | "deny" }`) are **unverified placeholders**.
2. Set `MC_ENABLE_APPROVALS=1`. Mission Control then requests `operator.approvals` in addition to `operator.read`.

This widens what a compromised browser session could do, so keep it behind the SSH tunnel (and
consider setting `MC_AUTH_USERS` too, once you're granting real write access).

## Files

- `server.js`: Gateway client (challenge → connect → `sessions.subscribe` → per-session `sessions.messages.subscribe`), reconnect with a circuit breaker, SSE, and every `/api/*` route (see `API.md`)
- `normalizer.js`: raw Gateway frames → `mission` / `upsert` / `pulse` / `log` ops
- `graph.js`: server-side graph state (including token accumulation and SLA tracking), so a reloaded browser gets the current map immediately
- `store.js`: per-mission op history on disk (no database — see `plan.md`'s Phase 1 notes)
- `auth.js` / `audit.js`: login sessions and the audit trail
- `toolstats.js` / `toolpolicy.js`: tool usage analytics and the per-agent-per-tool policy store
- `budget.js` / `pricing.json`: token budget thresholds and the cost-estimate table
- `webhook.js`: outbound webhook config parsing and delivery
- `circuitbreaker.js` / `log.js`: reconnect backoff and structured logging
- `public/index.html`: the whole UI, no build step; also contains the demo script
- `public/login.html`: the sign-in page, served when `MC_AUTH_USERS` is set
- `bin/mc-cli.js`, `bin/mc-backup.sh`, `bin/mc-gateway-token.sh`: the CLI companion, backup
  script, and the deploy-time token resolver/provisioner
- `test/`: `node --test` suite covering every module above
- `API.md`: every HTTP route, its auth requirement, and its Gateway RPC (if any)
- `features.md` / `plan.md`: the original feature gap analysis and the phased implementation
  plan (including status notes on what's deferred and why)

## Deployment

- **systemd user service:** copy `mission-control.service` to `~/.config/systemd/user/`, then
  `systemctl --user daemon-reload && systemctl --user enable --now mission-control`. The unit's
  `ExecStartPre` runs `bin/mc-gateway-token.sh` on every start, so a fresh clone provisions
  `.env` automatically before the server's first connect.
- **Docker:** on the host, run `bin/mc-gateway-token.sh` once so `.env` has the token, then
  `docker compose up -d` (see `docker-compose.yml` / `Dockerfile`). The container binds
  `0.0.0.0` internally, but the compose file only publishes it on the host's
  `127.0.0.1:4400` — same "don't expose this publicly" guarantee as running it bare-metal.
- Either way, `SIGTERM`/`SIGINT` (what both `systemctl stop` and `docker stop` send) now shut
  the process down cleanly instead of just being killed.

## Ideas for V3

- A real mission task queue (multiple concurrent missions) and cancel/abort for a running one —
  scoped out of this round as an architecture change, not an additive feature; see `plan.md`
  Phase 3's status notes for exactly what's blocking it.
- Multi-Gateway support (one UI, several Gateways) — same category of change; see `plan.md`
  Phase 11.
- A minimal UI plugin interface, so a deployment-specific panel doesn't require forking
  `public/index.html`.
