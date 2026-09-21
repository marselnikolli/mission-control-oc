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

## Installation

### Prerequisites

- **Node.js ≥ 20** (`node --version`) — nothing else is installed beyond the single runtime
  dependency `ws`.
- An **OpenClaw Gateway** already running and reachable over `ws://`. The default
  `OPENCLAW_GATEWAY_URL` in `.env.example` points at the Gateway's default
  `ws://127.0.0.1:18789`, so this flows if the Gateway runs on the same host.
- Optional but recommended: the `openclaw` CLI available in `PATH` on the deploy host. It lets
  the token resolver read the Gateway's existing token and, when none exists, provision one for
  both sides automatically.

### Steps

```bash
# 1. Get the code (and change into the directory)
git clone https://github.com/marselnikolli/mission-control-oc.git mission-control
cd mission-control

# 2. Install dependencies (one runtime dependency: ws)
npm install

# 3. Create the config file from the example
cp .env.example .env

# 4. Resolve/provision the shared Gateway token (idempotent; safe to run on every deploy)
bin/mc-gateway-token.sh        # same as: npm run env:token

# 5. First run only: check the event shapes against your OpenClaw version
npm run probe                 # prints every Gateway event it receives, then exits

# 6. Start Mission Control
npm start

# Expect: [gateway] live – scopes: operator.read, then open http://localhost:4400
```

Step 4, `bin/mc-gateway-token.sh` (also `npm run env:token`), looks for the shared token the
Gateway is already configured with — `OPENCLAW_GATEWAY_TOKEN` in the environment, `openclaw
gateway auth-token --show` (config token / SecretRefs), or `gateway.auth.token` in
`~/.openclaw/openclaw.json` — and writes whichever it finds into `.env`. If nothing is configured
anywhere it runs `openclaw doctor --generate-gateway-token`, or as a last resort generates a
random token itself (warning you to restart the Gateway so it binds it). It's idempotent: once
`.env` has a token it does nothing, so it's safe to run on every deploy. `--force` regenerates.

### Access it

The server listens on `127.0.0.1:4400` only, so reach it over an SSH tunnel from your laptop:

```bash
ssh -L 4400:127.0.0.1:4400 you@your-vps
# then open http://localhost:4400
```

Don't expose port 4400 publicly: anyone who can load the page sees your agents' commands, and
(if you've opted into `MC_AUTH_USERS`) only a login stands between them and the admin actions.
Open `index.html?demo`, or click the **Demo** button in the header, to run the scripted demo mission
instead of live data — **"Take the new Pro tier from proposal to launch"**, a ~50s loop in which every
role does real work: corporate-strategy sizes the market, finance clears the unit economics, product
writes the spec, technology builds (fails on a stale lockfile, recovers, and spawns a canary sub-agent
on its own orbit), marketing drafts the launch copy, security finds the CVE that the one approval
patches, and legal-risk clears the terms amendment before the tier ships. Approve to watch it finish,
reject to see the mission stop cleanly, then it loops.

## First-run checklist

1. **Handshake.** `npm start` should log `[gateway] live – scopes: operator.read`.
   Mission Control generates a stable Ed25519 device identity under `data/` on first run and signs
   the Gateway's `connect.challenge` with it (required by current Gateways; the nonce is signed
   into `connect.params.device`, not sent as a top-level param). If the Gateway still rejects the
   connect, check the token, then `MC_CLIENT_ID` / `MC_CLIENT_MODE` (`mode` must be one of
   `webchat`, `cli`, `ui`, `backend`, `node`, `worker`, `probe`, `test`). On a Gateway that
   enforces pairing, approve the new device on the Gateway side the first time; after that the
   same `data/device-identity.json` reconnects without re-pairing. If the connection succeeds but
   no session events arrive, see docs.openclaw.ai/gateway/protocol/auth.
2. **Event shapes.** Trigger a small task ("check disk usage on the VPS"), then read `logs/events.jsonl`.
   The normalizer reads fields defensively, but payload field names vary between OpenClaw versions.
   If something doesn't appear on the map, find the frame in the log and add its field path to the
   matching `pick(...)` call in `normalizer.js`. That file is the only place that knows about the Gateway's shapes.
3. **Pin your OpenClaw version** once it works, and recheck the log after upgrades.

## The roster and the skill catalog

Both come from one place: **the org chart** — [cbrock84/headcount](https://github.com/cbrock84/headcount),
published at <https://cbrock84.github.io/headcount/org-chart.html> and transcribed verbatim into
`org.js`. Nothing in it is invented or paraphrased.

- **The roster** is that chart's sixteen departments, in the chart's own order. `executive` (the
  Office of the CEO) is `agents[0]` and orchestrates; the other fifteen report to it. That is also
  where the chart hangs its two **reviewer-class** departments, `security` and `legal-risk`, since
  their blocking findings are not overrulable by the department under review.
- **The skill catalog** is that chart's skill set — every skill a department installs, seeded
  `installed` and `enabled`, tagged with the department it comes from, a link to its `SKILL.md`, and
  how many outside authorities it checks against. The Skills panel shows all of it with a filter box.
- **`MC_AGENTS` overrides the roster** if you want your own. Leaving it unset uses the chart's.
- A Gateway that reports its own `skills.changed` catalog still merges on top of the seed, so a live
  Gateway wins over the chart.

## What maps to what

The map always shows **the whole roster** — every configured agent (plus anyone the Gateway reports)
keeps its node whether it is running, idle, waiting or finished, so the canvas is a stable picture of
your setup instead of one that empties out between runs. What changes is motion: **only an agent that
is actually working animates.** A running agent's node lights up in its own colour, a snake of light
runs the branch from its parent to it, and its name and current tool call are written out beside it.
Everything else sits still; a finished agent keeps the lit "unlocked" look, a quiet one recedes, and
an approval paints its ring amber until you answer it.

The map is a **skill tree**: the orchestrator is the root node at the centre and every agent it reports
to is a skill on a ring around it, evenly spaced with its name and live status written outward from
the node. Each lead's sub-agents **fork off their own lead** as a branch, fanned across that lead's
sector, so the delegation tree reads as one tree rather than a flat ring of two dozen nodes. Each node
carries a sharp line glyph for its department, taken from the org chart itself (a bank for finance, a
shield for security, scales for legal-risk, a rising line for revenue, and so on) — the same glyph set
appears in the Agents table.

Only a working agent animates: its disk fills with its identity colour, an energy arc sweeps the ring,
the ring breathes, an arrival ping fires when the signal snake reaches it, and the branch itself lights
up with a travelling head. Idle agents sit still and dim; a finished agent stays lit as an unlocked
node; an approval turns the ring amber; a failure turns it red. The root throws a ripple outward when
work is delegated, and the whole tree assembles itself on connect — root first, then every lead
clockwise, each lead's branches following their parent (`i` replays it).

Names are progressive disclosure, the way the reference panel does it: a name is shown for the root,
for any agent that is running, waiting or failed, and for whatever you select or point at. Fifteen
leads on a ring leave roughly 90px of arc each once the tree is fitted to the stage, so a name on every
node would be an unreadable smear — the full roster is one click away in the Agents table.

Tool calls and approvals are never cards on the canvas. They surface as the live caption, in the
**Selected** panel's task list (Approve/Reject and **Full output** live there), and in the Activity
feed, which can be filtered by kind (Delegation / Tools / Approvals / Errors).

| Gateway event | On the map |
|---|---|
| `session.message` (user, in main) | New mission, map resets, replay recording starts |
| `sessions.changed` with `spawnedBy` / `parentSessionKey` | Agent attaches under whoever delegated to it, delegation burst |
| `agent` lifecycle start / end / error | Running: signal snake on its branch + caption. Done: lit as an unlocked node. Error: red ring |
| `session.tool` start / end | Outbound burst when the call starts, inbound + caption update when it ends |
| `exec.approval.*`, `session.approval` | The agent's node gets an amber ring; Approve/Reject in its task panel |
| `chat` with `state: "error"` | Agent turns red with the error |

An agent's task panel (Selected, right-hand side) lists what is waiting on you first, then its 6
most recent tool/approval records; older finished ones drop off (they're still in mission history —
see below).

With nothing selected the same panel shows **Live now**: who is running or waiting, what they are
doing, and a click straight through to their full task list.

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
  chain, and token usage, with Stop/Restart/Pause/Resume, ad-hoc spawn, and a **proper config
  form** (model, temperature, max tokens/retries/timeout, system prompt, per-run token cap,
  skill assignment, plus a raw-JSON escape hatch for anything not covered).
- **Sub-agent squads** (`MC_SUBAGENTS_PER_AGENT`): give every agent except the orchestrator a squad
  of N named sub-agents (`technology-1`, `technology-2`, …) parented to it. **They stay off the map until
  they are needed**: a squad member appears while it is working (or waiting on an approval, or
  failed) and leaves again when it finishes, and clicking a lead — or its `▸ N` chip — pins the whole
  squad open around it on its own branch. So the canvas stays readable with a big roster instead
  of turning into two dozen idle nodes. Each member wears its lead's role glyph; the Agents table
  lists them all, nested under that lead and tagged `sub`; and selecting a lead shows a **Squad**
  section plus its squad's tool calls, tagged with which sub-agent ran each one. Squad members the
  Gateway spawns at runtime (`spawnedBy`/`parentSessionKey`) get the same treatment automatically.
- **Skills catalog** (admin): a panel listing each skill's department, version, status, source and
  description with Install / Enable / Disable / Update / Remove, a filter box, and the same set in the
  agent-config form. The catalog is mirrored in `data/skills.json` — seeded from `org.js` (the org
  chart's own skill set), merged from the Gateway's `skills.changed` frames, and kept locally even if
  the Gateway doesn't implement the placeholder RPCs (`MC_SKILLS_INSTALL_METHOD` /
  `MC_SKILLS_CONTROL_METHOD`).
- **Tool catalog & policy**: usage analytics per tool (call counts, success rate, average
  duration) derived from mission history, plus a per-agent-per-tool allow/ask/deny policy
  editor.
- **Token budgets** (`MC_BUDGET_TOKENS_*`): a warning banner at 80% of a limit, "exceeded" at
  100%+, with an optional auto-pause.
- **Outbound webhooks** (`MC_WEBHOOKS`): POST a JSON envelope to your own URL on
  `mission.start`, `approval.waiting`, or `agent.error`.
- **CLI companion**: `bin/mc-cli.js status|tasks|approve <id>|reject <id>` against the same API.
- **Backup**: `bin/mc-backup.sh` tars the plain-file store — there's no database to dump.
- Search/filter, a state legend, kind filters on the activity feed, and keyboard-first navigation
  (collapse/expand subtrees, desktop notifications, a theme toggle, and `g` recenter, `y`/`n`
  approve/reject, `m` toggle demo, `v` map/list on a phone) round out the UI. The camera re-fits
  smoothly with GSAP, which also animates the HUD counts; anime.js runs the edge dataflow and event
  bursts.
- **Discoverable map detail.** Agents are drawn as icon-only rings, so everything the map knows
  about one — status, detail, model, reports-to, children, last tool call — is on a **hover/focus
  card** (the same rows the inspector shows), instead of a `title` attribute that needed a mouse,
  a dwell, and did not exist for keyboard or touch users at all. A running agent also reveals its
  task line on hover.
- **The mission instrument in the hub.** The centre of the diagram used to be ~500px of decoration
  ring around an orb carrying only the word "EXECUTIVE". It now carries the mission clock, agents
  running, tool calls in flight, approvals waiting (amber when non-zero) and a one-line "what is
  running now", all refreshed on a ticker rather than only when an event arrives.
- **An approval bar, not a feed row.** A pending approval used to be a row in the scrolling activity
  feed plus a card inside a panel you had to open. One sticky strip now appears whenever something
  is actually waiting on a human, with the command, **Show agent**, and Approve/Reject — and it is
  hidden entirely when nothing is waiting.
- **A quieter activity feed.** Consecutive same-agent events of the same kind collapse into one row
  with a `+N` chip that expands, and the fixed 58px clock column became a relative "now / 12s / 3m"
  (the exact timestamp stays in the `title`). Five identical tool results are one line, not five.
- **Phone layout.** Under 700px the map is opt-in: the default is the list you can actually read
  (status, agents, feed) in a single scroll with no nested scroll regions, and a **Map / List**
  button (or `v`) swaps to the diagram. The diagram also scales its own geometry down on a narrow
  stage and its fit no longer floors the zoom above what the height-fit wants, so the whole roster
  lands inside the stage instead of the outer departments falling off the bottom. The header became
  two rows — title, then a scrolling button strip — rather than wrapping to four lines.
- **Soft-console skin** over Pico CSS: every view (history, tasks, agents, tools, skills, health,
  audit) is built from Pico's tables, forms and cards, re-skinned through Pico's own custom
  properties — a muted violet page, softly rounded cards and pills, a glyph in a tinted chip on each
  section heading, saturated accent pills for status, one rounded type family (`Nunito`) with a
  monospace reserved for machine data, and a sidebar status readout (agents / tasks / gateway) that
  is visible from every view. The map is the one exception: it borrows a game skill tree's language —
  luminous nodes on a near-black starfield — and keeps its own surface tokens so it reads as a
  viewport into the tree rather than a page. "Ice" light mode is a deliberate cool-paper variant,
  including an inverted (paper-on-indigo) skill tree rather than a hole punched in a light layout.

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
- `deviceid.js`: the Ed25519 device identity and the signed `connect.challenge` proof used at
  handshake time (see [First-run checklist](#first-run-checklist))
- `toolstats.js` / `toolpolicy.js`: tool usage analytics and the per-agent-per-tool policy store
- `org.js`: the org chart (cbrock84/headcount, MIT) transcribed verbatim — the sixteen departments that
  make up the default roster and the full skill catalog the Skills panel seeds from
- `skills.js`: the skills catalog mirror (`data/skills.json`) behind the Skills panel
- `budget.js` / `pricing.json`: token budget thresholds and the cost-estimate table
- `webhook.js`: outbound webhook config parsing and delivery
- `circuitbreaker.js` / `log.js`: reconnect backoff and structured logging
- `public/index.html`: the whole UI, no build step; also contains the demo script
- `public/vendor/`: the three frontend libraries, served from an explicit filename allowlist in
  `server.js` — **Pico CSS** is the dashboard's structural layer (panels, tables, forms), **GSAP**
  drives the map camera and HUD count-ups, **anime.js** drives the SVG dataflow
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
