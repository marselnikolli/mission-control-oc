# Mission Control HTTP API

Every route below is served by `server.js`. This is the same API the browser UI (`public/index.html`)
calls — nothing here is a separate integration surface to keep in sync, and `bin/mc-cli.js` is a
thin wrapper over exactly these routes.

**Auth model:** if `MC_AUTH_USERS` is unset, every request is treated as an authenticated admin
(today's open-access default — see `plan.md` Phase 2). Once `MC_AUTH_USERS` is set, `POST
/api/login` returns an `HttpOnly` session cookie that every other route (except `/api/health`)
requires. Roles are `viewer` < `operator` < `admin`; each route below lists its minimum role.

Routes marked **(placeholder RPC)** call a Gateway method whose exact name is an unverified
guess (see `.env.example`) — they fail with a clear error rather than a silent no-op if your
Gateway doesn't implement it.

## Auth

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/login` | — | Login page. Redirects to `/` if auth is disabled. |
| POST | `/api/login` | — | Body `{username, password}`. Sets the session cookie on success. |
| POST | `/api/logout` | — | Clears the session cookie. |
| GET | `/api/session` | viewer | Current `{username, role, authEnabled}`, or 401. |

## Read-only status

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/health` | — (always public) | `{gateway, approvals, events}` — meant for external monitoring. |
| GET | `/api/metrics` | viewer | Event throughput, unknown-event (protocol drift) counts, reconnect count, SSE client count, uptime. |
| GET | `/events` | viewer | Server-Sent Events stream: the live map's snapshot + ops. What the UI itself consumes. |

## Missions

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/missions` | viewer | List of recorded missions (id, label, status, start/end time). |
| GET | `/api/missions/:id/ops` | viewer | The full op history for one mission, for replay. |
| GET | `/api/templates` | viewer | Saved task-prompt templates (`templates.json`). |
| POST | `/api/task` | operator | **(placeholder RPC)** Submit a new task to the orchestrator. Body `{prompt}`. Disabled unless `MC_ENABLE_TASK_SUBMIT=1`. |

## Approvals

| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/api/approval` | operator | **(placeholder RPC)** Body `{approvalId, decision: "approve"\|"reject"}`. Disabled unless `MC_ENABLE_APPROVALS=1`. |
| POST | `/api/tool-output` | viewer | **(placeholder RPC)** Body `{sessionKey, callId}` — fetch a tool call's full output. |

## Agents

| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/api/agent/:id/control` | admin | **(placeholder RPC)** Body `{action: "start"\|"stop"\|"restart"\|"pause"\|"resume"}`. |
| POST | `/api/agent/:id/config` | admin | **(placeholder RPC)** Body `{config: {...}}` — arbitrary JSON pushed toward the Gateway. |
| POST | `/api/agent/spawn` | admin | **(placeholder RPC)** Body `{agentId, prompt}` — spawn an ad-hoc sub-agent. |

## Tools

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/tools` | viewer | Tool catalog + usage analytics, derived from mission history (`toolstats.js`). |
| GET | `/api/tool-policy` | viewer | Current per-agent-per-tool policy map (`allow`/`ask`/`deny`). |
| POST | `/api/tool-policy` | admin | **(placeholder RPC)** Body `{agentId, tool, policy}`. Saved locally regardless of whether the Gateway push succeeds. |
| GET | `/api/pricing` | viewer | The `pricing.json` cost table used for budget/cost estimates. |

## Audit

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/audit` | admin | Last 200 audit entries (logins, approvals, agent/tool mutations). |

## Config reload

| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/api/reload` | admin | Re-reads `.env` for just the budget and webhook settings (`MC_BUDGET_*`, `MC_WEBHOOKS`) without a restart. Gateway URL, auth users, and the agent roster are intentionally **not** reloadable this way — restart for those. `pricing.json`, `templates.json`, and `data/tool-policy.json` already re-read from disk on every request, so there's nothing to reload for them. |

## Webhooks (outbound, not an HTTP route)

Set `MC_WEBHOOKS` (see `.env.example`) to have Mission Control `POST` a JSON envelope
(`{event, at, ...payload}`) to your own URL(s) on `mission.start`, `approval.waiting`,
`agent.error`, or `mission.done` (the last one isn't reachable yet against a real Gateway — see
`plan.md` Phase 9's status note).

## CLI

`bin/mc-cli.js status|tasks|approve <id>|reject <id>` — a thin wrapper over the routes above.
Set `MC_CLI_URL` (default `http://127.0.0.1:4400`) and, if auth is enabled, `MC_CLI_USER`/
`MC_CLI_PASS`.

## Backup / restore

There's no database — `data/` and `logs/` already are the data (see `plan.md` Phase 1's status
note on the plain-file store). `bin/mc-backup.sh` tars both; restore with `tar xzf
<backup>.tar.gz` from the project root, ideally with the server stopped.
