mission-control-oc — Required Fixes 
Target repo: marselnikolli/mission-control-oc Verified against: OpenClaw Gateway 2026.9.4 (build 2026.9.4
release-3a9d69db306c-2026-09-10T22-53-16.719Z), protocol 4, gateway.auth.mode: "token" Baseline commit:
158a07c (“Document proper installation steps in README”) Node: v24.21.0 (any >= 20 is fine) 
What this document is 
A fresh clone of this repo cannot connect to a current OpenClaw Gateway, and its UI is unusable once it does. Five independent
defects are documented below, each with the exact patch and the verification that proves it. Apply them top to bottom. 
Fixes 1–5 are already applied and committed on the deployment machine as: 22eaeaa (fixes 1–3), cd8b692 (fix 4), be6b2b8 (fix 5).
If you have access to that repo you can simply fetch/push those commits instead of re-applying. 
Preflight 
node --versionopenclaw statusgrep -n "MC_CLIENT_MODE" .envnpm install

# >= 20
# confirm the Gateway is running and its version
# deployment config, see "Deployment config" below
Run the built-in probe after the code fixes to confirm the handshake: 
npm run probe # expect no INVALID_REQUEST frames in logs/events.jsonl

Fix 1 — server.js: remove the root-level nonce from the connect frame 
Symptom. Every connect attempt is rejected: 
{"type":"res","ok":false,"error":{"code":"INVALID_REQUEST",
"message":"invalid connect params: at root: unexpected property 'nonce'"}}

The client reconnects forever (the log fills with connect.challenge / rejection pairs). 
Root cause. sendConnect() echoes the challenge nonce at the root of connect.params. Per the Gateway protocol the challenge
nonce belongs in connect.params.device.nonce and is only meaningful for device-identity clients. Mission Control
authenticates with the shared token over a device-less operator connection, so it must not send a root nonce. 
File: server.js, function sendConnect() (around line 259 in 158a07c). 
// BEFORE
auth: cfg.token ? { token: cfg.token } : {},
userAgent: 'openclaw-mission-control/0.1.0',
...(challenge ? { nonce: challenge.nonce } : {}),
},

// AFTER
auth: cfg.token ? { token: cfg.token } : {},
userAgent: 'openclaw-mission-control/0.1.0',
// No root-level `nonce`: the connect.challenge nonce belongs in `device.nonce` and is
// only meaningful for device-identity clients. Current Gateways reject a root `nonce`
// with "unexpected property 'nonce'". Mission Control authenticates with the shared
// token over a device-less operator connection, so the challenge is acknowledged and
// not echoed.
},

Verify. No unexpected property 'nonce' remains in logs/events.jsonl, and npm start logs [gateway] live. 
Fix 2 — server.js: only send includeApprovals when it is true 
Symptom. The handshake succeeds but every session subscription fails:invalid sessions.messages.subscribe params: at /includeApprovals: must be equal to constant

The map stays empty because no per-session message events ever arrive. 
Root cause. The Gateway schema declares includeApprovals as a literal true opt-in. Sending false violates the schema. The
field must be omitted entirely when approvals are off. 
File: server.js, in ingest() (around line 177 in 158a07c). 
// BEFORE
request('sessions.messages.subscribe', { key: s.key, includeApprovals: cfg.approvals })

// AFTER
// `includeApprovals` is a literal-true opt-in in the Gateway schema: sending `false` is
// rejected with "must be equal to constant". Omit it entirely when approvals are off.
request('sessions.messages.subscribe', { key: s.key, ...(cfg.approvals ? { includeApprovals: true }
Verify. No subscribeincreasing. 
failed warnings in the journal/log, and /api/health shows agent/session.message event counters
Fix 3 — client mode must be cli (not operator, not ui) 
Symptom. Either the connect is rejected outright: 
invalid connect params: at /client/mode: must be equal to one of the allowed values

…or it connects successfully but every scope is denied (missingworked. 
scope: operator.read), which is worse because it looks like it
Root cause. The allowed client.mode values for this Gateway are: 
backend, cli, node, probe, test, ui, webchat, worker

operator is not one of them (operator is a role, not a client mode — the repo conflates them). Measured behaviour for a device
less operator connection, same token, same scopes requested (["operator.read"]):client.id / mode resultcli / cli OK — granted ["operator.read"]cli / ui OK — granted [] (empty, so every RPC is refused)cli / backend OK — granted []cli / webchat FAIL — origin not allowedcli / operator FAIL — not an allowed value 
: {}) })
File: .env (deployment) — and fix the shipped default in .env.example so a fresh clone does not walk into it. 
# .env
MC_CLIENT_ID=cli
MC_CLIENT_MODE=cli

# .env.example (BEFORE -> AFTER)
-# Handshake client identity. The docs example uses "cli"/"operator"; change if your Gateway rejects it.
-MC_CLIENT_ID=cli
-MC_CLIENT_MODE=operator
+# Handshake client identity. `mode` must be one of:
+# backend | cli | node | probe | test | ui | webchat | worker
+# `operator` is the ROLE (see `role` in the connect frame), not a mode, and is rejected.
+# Only mode=cli grants a device-less operator connection its scopes; ui/backend connect but
+# come back with an empty scope grant.
+MC_CLIENT_ID=cli
+MC_CLIENT_MODE=cli

Verify. The startup log line must read [gateway] live – scopes: operator.read (not scopes: with nothing after it). 
Fix 4 — normalizer.js: recognise heartbeat/catalog events instead of reporting
drift 
Symptom. The Health panel permanently lists healthy traffic as an error: 
Unrecognized events (Gateway protocol drift)
tick: 3
health: 2
chat.metadata.changed: 1

Root cause. These are stable Gateway protocol events that the map has no representation for. Because normalize() falls through
to default: return [] and server.js checks each event against KNOWN_EVENTS, every single frame is counted as
unrecognised. The drift detector is supposed to catch only genuinely new or renamed events after an upgrade.Event Payload Meaningtick {ts} (~every 30s) Gateway heartbeathealth {ok, ts, durationMs, …} periodic gateway health snapshotchat.metadata.changed session metadata session metadata churnskills.changed {reason} skill catalog changed 
File: normalizer.js — two edits. 
// BEFORE (top of file, ~line 13)
export const KNOWN_EVENTS = new Set([
'sessions.snapshot', 'sessions.changed', 'agent', 'session.tool', 'session.message', 'chat',
'session.approval', 'exec.approval.requested', 'exec.approval.resolved',
'plugin.approval.requested', 'plugin.approval.resolved',
]);

// AFTER
export const KNOWN_EVENTS = new Set([
'sessions.snapshot', 'sessions.changed', 'agent', 'session.tool', 'session.message', 'chat',
'session.approval', 'exec.approval.requested', 'exec.approval.resolved',
'plugin.approval.requested', 'plugin.approval.resolved',
// Stable Gateway events this map deliberately does not visualize. They are listed so the
// Health panel reserves "protocol drift" for genuinely new/renamed events after an upgrade.
'tick', 'health', 'chat.metadata.changed', 'skills.changed',
]);

// BEFORE (inside the returned normalize() switch)
case 'plugin.approval.requested':
case 'plugin.approval.resolved':
return onApproval(event, p);
default: return [];

// AFTER
case 'plugin.approval.requested':
case 'plugin.approval.resolved':
return onApproval(event, p);
// Acknowledged, no map op: the Gateway heartbeat (`policy.tickIntervalMs`), its periodic
// health snapshot, and session-metadata / skill-catalog churn. Previously these fell
// through to `default` and were reported as unrecognized protocol drift on every frame.
case 'tick':
case 'health':
case 'chat.metadata.changed':
case 'skills.changed':
return [];
default: return [];

Verify. With the admin session cookie: 
curl -s -b cookies.txt http://HOST:4400/api/metrics
# expect: "unknownEventCounts":{} and the listed events still present under "eventCounts"
Their throughput should still appear under Event throughput — that is normal and useful. Only the Unrecognized events block
must be empty. 
Fix 5 — public/index.html: all five overlays render permanently (the big one) 
Symptom. After login the UI appears to be “just the Health panel”. Clicking Close or Refresh does nothing at all. The execution map
appears to be missing entirely, and the page looks very dark. 
Root cause. The stylesheet never defines a [hidden] rule (grep count: 0), while the .overlay rule declares display: flex: 
.overlay { position: fixed; inset: 0; background: rgba(0,0,0,.5); display: flex; … z-index: 50; }

Author-origin CSS beats the user-agent rule [hidden] { display: none } in the cascade. So the hidden attribute on all five
overlays (historyOverlay, taskOverlay, agentsOverlay, toolsOverlay, healthOverlay) had no effect: every overlay
rendered, stacked, all with z-index: 50. healthOverlay is last in the DOM, so it painted on top — that is why “after login”
showed the Health table. The handlers only toggle .hidden, which the CSS ignored, hence “Close is not clickable, nothing happens”.
The map was never absent: it sat behind five stacked 50%-black scrims (~97% opaque). 
Note this also silently affected every other element that combines an author display rule with the hidden attribute — including
.conn (display: inline-flex), i.e. the #healthBadge “Mission Control unreachable” pill. 
File: public/index.html, in the <style> block (~line 29 in 158a07c, between the *body rule). 
{ box-sizing } reset and the html,
* { box-sizing: border-box; }
/* The `hidden` attribute must win over the author rules below: `.overlay { display: flex }` is
author-origin and otherwise overrides the UA stylesheet's `[hidden] { display: none }`, which
leaves all five overlay panels permanently visible and stacked (health last, so on top). */
[hidden] { display: none !important; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--ink); font-family: var(--sans);
Verify. With a session cookie: 
}
curl -s -b cookies.txt http://HOST:4400/ | grep -c '\[hidden\] { display: none !important; }'
# expect: 1

Then hard-reload the browser (Cmd/Ctrl-Shift-R) — the page is served with cache-control: no-store, so a normal reload
usually suffices. You should land on the execution map (mission node + agents) with the Selected and Activity sidebar. 
Deployment config (.env) — required for a working install 
These are not code fixes but the install is not correct without them. Full reference is .env.example. 
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789 # the local Gateway
OPENCLAW_GATEWAY_TOKEN= # leave empty; bin/mc-gateway-token.sh fills it
MC_HOST=127.0.0.1 # or the LAN IP / 0.0.0.0 if proxied (see below)
MC_PORT=4400
MC_CLIENT_ID=cli
MC_CLIENT_MODE=cli # Fix 3
MC_AGENTS=main,sysadmin,devops,security # must match the Gateway's real agent ids
MC_ENABLE_APPROVALS=0 # read-only; the approve/reject RPCs are placeholders
MC_AUTH_USERS= # empty = open to anyone who can reach the page

Notes: 
bin/mc-gateway-token.sh is idempotent. It resolves the token from openclaw gateway auth-token --show (run
under a PTY via script), else gateway.auth.token in ~/.openclaw/openclaw.json, else provisions one. On a Gateway
whose auth.token is a SecretRef, the PTY path is the one that resolves — verify .env ends up with a non-empty
OPENCLAW_GATEWAY_TOKEN.
MC_AUTH_USERS is a plaintext credential list in a file. Keep .env at mode 600.
If you bind to a LAN IP rather than loopback (i.e. you are proxying it, e.g. tailscale serve --bg http://LAN_IP:4400),
set MC_AUTH_USERS too — otherwise the login is the only thing between the network and your agents' commands. README’s
own warning applies: “Don’t expose port 4400 publicly.”
Binding to a DHCP-assigned address means the service fails to bind if the lease changes. Prefer MC_HOST=0.0.0.0 behind aproxy, with a login set. 
systemd user service 
cp mission-control.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now mission-control
loginctl enable-linger "$USER" # survive logout/reboot

The unit’s ExecStartPre re-runs the token resolver on every start. Confirm WorkingDirectory=%h/mission-control
matches where you actually cloned it — a mismatched path fails with status=200/CHDIR and the service restart-loops. 
Verification checklist (end to end) 
npm run probe → no INVALID_REQUEST frames in logs/events.jsonl.
Startup log: [gateway] live – scopes: operator.read — scopes must not be empty.
No subscribe failed and no unrecognized Gateway event warnings in the log.
GET /api/health → {"ok":true,"gateway":"live","events":{…}} with counters increasing.
GET /events (with session cookie) → a {"type":"snapshot","nodes":[…],"mission":{…}} frame containing a
mission node plus one node per configured agent, and mission.startedAt set.
In the browser: land on the map, open and close Health / History / Agents / Tools.
curl -s -b cookies.txt /api/metrics → "unknownEventCounts":{}. 
Not applied — open items and known limitations 
The header clock (#clock) 
It is a mission-elapsed timer (mm:ss from mission.startedAt, recomputed every 500ms), not a wall clock. Two consequences
that read as bugs: 
It resets on every new mission. Every user message to the orchestrator emits {op:'mission'} (normalizer.js
onMessage), so the clock snaps back to 00:00 constantly and can never accumulate past the current turn.
It never stops. Nothing emits a mission-completion signal, so the mission node stays thinking and the count runs until the
next message resets it. 
Also a genuine defect: in @media (max-width: 860px) the rule .clock { display: none; } (alongside #inspector {
display: none; }) hides the timer entirely on viewports under 860 CSS px — a phone in landscape is ~852px, and browser zoom
does the same. 
Options, smallest first: 
/* A. make it visible on narrow viewports — remove this line from the 860px media query */
.clock { display: none; }

// B. keep mission semantics but stop the clock when the mission ends:
// add a mission-completion case in normalizer.js (mission node -> status 'done')
// and stop the interval when state.mission.endedAt is set.

// C. make it a wall clock instead (always meaningful, never resets):
setInterval(() => {
$('clock').textContent = new Date().toTimeString().slice(0, 5); // HH:MM
}, 1000);

Pick one before changing it — A and C are one-liners, B needs a new Gateway signal. 
Unverified placeholder RPCs 
MC_APPROVAL_METHOD=exec.approval.resolve, MC_TASK_SUBMIT_METHOD=session.message.send,
MC_TOOL_OUTPUT_METHOD=chat.message.get, and the three MC_AGENT_* methods are best-guess placeholders, as the
README and .env.example say. They fail visibly in the UI. Do not enable MC_ENABLE_APPROVALS / MC_ENABLE_TASK_SUBMIT
until the method names and params are confirmed against your Gateway’s RPC reference. 
Other protocol drifttick, health, chat.metadata.changed and skills.changed are handled by Fix 4. Any other event appearing under
Unrecognized events is a real version-drift signal: find the frame in logs/events.jsonl and add its field path to the matching
pick(…) call in normalizer.js. 
Appendix — evidence and commands used 
Which client mode grants scopes (device-less operator connection, shared token, requesting ["operator.read"]): 
[{"mode":"ui","scopes":["operator.read"]},{"mode":"ui"},{"mode":"cli","scopes":["operator.read"]},
{"mode":"cli"},{"mode":"webchat","scopes":["operator.read"]},{"mode":"backend","scopes":["operator.read"]}]

OK id=cli mode=uiOK id=cli mode=cliFAIL id=cli mode=webchatOK id=cli mode=backend
scopes=["operator.read"] -> granted=[] deviceToken=no
scopes=["operator.read"] -> granted=["operator.read"] deviceToken=no
-> origin not allowed
scopes=["operator.read"] -> granted=[]
Confirming the snapshot carries the mission (so the clock has data): 
curl -s -N -b cookies.txt http://HOST:4400/events | head -1 | sed 's/^data: //'
# {"type":"snapshot","nodes":[…],"log":[…],"mission":{"label":"…","startedAt":1789684388464},
# "status":"live","approvals":false,"taskSubmit":false}

Diff of the applied fixes on the deployment machine: 
git log --oneline -5
# be6b2b8 Fix overlays rendering permanently: make the hidden attribute win
# cd8b692 Recognize heartbeat and catalog events instead of reporting protocol drift
# 22eaeaa Fix Gateway handshake for current protocol