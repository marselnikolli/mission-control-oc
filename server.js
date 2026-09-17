import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createNormalizer, KNOWN_EVENTS } from './normalizer.js';
import { createGraph } from './graph.js';
import { createStore } from './store.js';
import { appendWithRotation } from './logrotate.js';
import { parseUsers, roleAtLeast, parseCookie, createAuth } from './auth.js';
import { createAudit } from './audit.js';
import { computeToolStats } from './toolstats.js';
import { createToolPolicy } from './toolpolicy.js';
import { createCircuitBreaker } from './circuitbreaker.js';
import { createLogger } from './log.js';
import { estimateCost, budgetStatus } from './budget.js';
import { parseWebhooks, fireWebhook } from './webhook.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// --- tiny .env loader (no dependency) ---
const envFile = path.join(here, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// Same parser as above, but returning the values instead of only filling in unset process.env
// vars -- used by /api/reload to pick up an edited .env without a restart.
function readEnvFile() {
  const out = {};
  if (!fs.existsSync(envFile)) return out;
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const cfg = {
  gatewayUrl: process.env.OPENCLAW_GATEWAY_URL || 'ws://127.0.0.1:18789',
  token: process.env.OPENCLAW_GATEWAY_TOKEN || '',
  host: process.env.MC_HOST || '127.0.0.1',
  port: Number(process.env.MC_PORT || 4400),
  agents: (process.env.MC_AGENTS || 'main,sysadmin,devops,security').split(',').map(s => s.trim()).filter(Boolean),
  clientId: process.env.MC_CLIENT_ID || 'cli',
  clientMode: process.env.MC_CLIENT_MODE || 'operator',
  approvals: process.env.MC_ENABLE_APPROVALS === '1',
  approvalMethod: process.env.MC_APPROVAL_METHOD || 'exec.approval.resolve',
  rawLog: path.resolve(here, process.env.MC_RAW_LOG || 'logs/events.jsonl'),
  rawLogMaxBytes: Number(process.env.MC_RAW_LOG_MAX_BYTES || 10 * 1024 * 1024),
  dataDir: path.resolve(here, process.env.MC_DATA_DIR || 'data'),
  authUsers: parseUsers(process.env.MC_AUTH_USERS),
  // Both of the below call Gateway RPCs whose exact name/params are unverified placeholders,
  // same caveat as MC_APPROVAL_METHOD in the README — check against your Gateway before relying on them.
  taskSubmit: process.env.MC_ENABLE_TASK_SUBMIT === '1',
  taskSubmitMethod: process.env.MC_TASK_SUBMIT_METHOD || 'session.message.send',
  toolOutputMethod: process.env.MC_TOOL_OUTPUT_METHOD || 'chat.message.get',
  // Agent management RPCs (start/stop/pause/resume, config edits, ad-hoc spawn) are unverified
  // placeholders too — OpenClaw's Gateway may not expose any of these yet. Calls fail loudly
  // (surfaced to the UI, audited either way) rather than pretending to work.
  agentControlMethod: process.env.MC_AGENT_CONTROL_METHOD || 'agent.control',
  agentConfigMethod: process.env.MC_AGENT_CONFIG_METHOD || 'agent.config.update',
  agentSpawnMethod: process.env.MC_AGENT_SPAWN_METHOD || 'agent.spawn',
  // Unverified placeholder too: attempts to push a per-agent tool enable/disable through to
  // OpenClaw's own config. The local tool-policy record (see toolpolicy.js) is kept either way,
  // so the UI stays consistent even when this call fails.
  toolToggleMethod: process.env.MC_TOOL_TOGGLE_METHOD || 'agent.tool.toggle',
  // If the Gateway connection fails this many times within the window, stop the normal
  // exponential backoff (which would otherwise retry forever, ever slower) and fall back to a
  // steady, infrequent retry instead -- avoids both a runaway reconnect loop and a "manual
  // restart required" dead end.
  reconnectMaxFailures: Number(process.env.MC_RECONNECT_MAX_FAILURES || 5),
  reconnectWindowMs: Number(process.env.MC_RECONNECT_WINDOW_MS || 5 * 60 * 1000),
  reconnectCooldownMs: Number(process.env.MC_RECONNECT_COOLDOWN_MS || 5 * 60 * 1000),
  // Token budgets, tracked from graph.js's now-cumulative tokensIn/tokensOut. 0 (the default)
  // means unlimited -- unset by default so nothing changes unless you opt in.
  budgetPerAgentTokens: Number(process.env.MC_BUDGET_TOKENS_PER_AGENT || 0),
  budgetGlobalTokens: Number(process.env.MC_BUDGET_TOKENS_GLOBAL || 0),
  budgetAutoPause: process.env.MC_BUDGET_AUTO_PAUSE === '1',
  probe: process.argv.includes('--probe'),
};
cfg.webhooks = parseWebhooks(process.env.MC_WEBHOOKS);
fs.mkdirSync(path.dirname(cfg.rawLog), { recursive: true });

const graph = createGraph({ agents: cfg.agents });
const normalize = createNormalizer({ agents: cfg.agents });
const store = createStore({ dir: cfg.dataDir });
const auth = createAuth({ users: cfg.authUsers });
const audit = createAudit({ dir: cfg.dataDir });
const breaker = createCircuitBreaker({ maxFailures: cfg.reconnectMaxFailures, windowMs: cfg.reconnectWindowMs });
const log = createLogger();
const unknownEventCounts = new Map();
const warnedUnknownEvents = new Set();
let reconnectCount = 0;
const budgetState = new Map(); // scope key -> last broadcast status, so we only alert on transitions
const toolPolicy = createToolPolicy({ dir: cfg.dataDir });
const authEnabled = cfg.authUsers.length > 0;
const SESSION_COOKIE = 'mc_session';
const clients = new Set();
let gatewayStatus = 'connecting';
let currentMissionId = null;

if (!authEnabled) log.warn('MC_AUTH_USERS is empty — Mission Control is open to anyone who can reach it.');

function loadTemplates() {
  try { return JSON.parse(fs.readFileSync(path.join(here, 'templates.json'), 'utf8')); }
  catch { return []; }
}

function loadPricing() {
  try { return JSON.parse(fs.readFileSync(path.join(here, 'pricing.json'), 'utf8')); }
  catch { return { default: { inputPer1k: 0, outputPer1k: 0 } }; }
}

// A session with no auth configured is treated as a full admin, matching the previous
// (pre-Phase-2) open-access behavior for anyone who hasn't opted in to MC_AUTH_USERS yet.
function sessionFor(req) {
  if (!authEnabled) return { username: 'anonymous', role: 'admin' };
  return auth.sessionFor(parseCookie(req.headers.cookie, SESSION_COOKIE));
}

function broadcast(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) res.write(data);
}
function setStatus(s, detail) {
  gatewayStatus = s;
  broadcast({ type: 'status', status: s, detail, approvals: cfg.approvals, taskSubmit: cfg.taskSubmit });
  log.info('gateway status', { status: s, detail });
}

// --- Gateway client ---
const subscribed = new Set();
let ws, reqSeq = 0, backoff = 1000;
let shuttingDown = false;
const pending = new Map();
const eventCounts = new Map();

function request(method, params = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error('gateway not connected'));
    const id = `mc-${++reqSeq}`;
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
    pending.set(id, { resolve, reject, t, method });
    ws.send(JSON.stringify({ type: 'req', id, method, params }));
  });
}

function persist(ops) {
  for (const op of ops) {
    if (op.op === 'mission') {
      currentMissionId = String(op.startedAt);
      store.startMission(currentMissionId, op.label, op.startedAt);
    }
    // _recordedAt rides alongside the op purely for history-replay pacing (see /api/missions/:id/ops);
    // it's ignored by graph.apply and by the live client's own op handling.
    if (currentMissionId) store.appendOp(currentMissionId, { ...op, _recordedAt: Date.now() });
  }
}

function ingest(event, payload) {
  if (!KNOWN_EVENTS.has(event)) {
    unknownEventCounts.set(event, (unknownEventCounts.get(event) || 0) + 1);
    if (!warnedUnknownEvents.has(event)) {
      warnedUnknownEvents.add(event);
      log.warn('unrecognized Gateway event -- normalizer.js has no case for it', { event });
    }
  }
  const ops = normalize(event, payload);
  const subs = ops.filter(o => o.op === 'subscribe');
  for (const s of subs) {
    if (subscribed.has(s.key) || subscribed.size >= 60) continue;
    subscribed.add(s.key);
    request('sessions.messages.subscribe', { key: s.key, includeApprovals: cfg.approvals })
      .catch(e => { subscribed.delete(s.key); log.warn('subscribe failed', { key: s.key, error: e.message }); });
  }
  const out = graph.apply(ops.filter(o => o.op !== 'subscribe'));
  persist(out);
  if (out.length) broadcast({ type: 'ops', ops: out });
  if (out.length) checkBudgets();
  fireEventWebhooks(out);
}

function fireEventWebhooks(ops) {
  const onError = (url, e) => log.warn('webhook delivery failed', { url, error: e.message });
  for (const op of ops) {
    if (op.op === 'mission') {
      fireWebhook(cfg.webhooks, 'mission.start', { label: op.label, startedAt: op.startedAt }, { onError });
    } else if (op.op === 'upsert' && op.node.kind === 'approval' && op.node.status === 'waiting') {
      fireWebhook(cfg.webhooks, 'approval.waiting', { approvalId: op.node.approvalId, label: op.node.label }, { onError });
    } else if (op.op === 'upsert' && op.node.kind === 'agent' && op.node.status === 'error') {
      fireWebhook(cfg.webhooks, 'agent.error', { agentId: op.node.label || op.node.id, detail: op.node.detail }, { onError });
    } else if (op.op === 'upsert' && op.node.kind === 'mission' && op.node.status === 'done') {
      // Not currently reachable -- no Gateway event this project has seen sets the mission
      // node to 'done' (see Phase 9's status note on notifications). Wired anyway so it fires
      // the day such a signal exists, instead of needing another round of changes then.
      fireWebhook(cfg.webhooks, 'mission.done', { label: graph.snapshot().mission.label }, { onError });
    }
  }
}

function checkBudgets() {
  if (!cfg.budgetPerAgentTokens && !cfg.budgetGlobalTokens) return;
  let globalTokens = 0;
  for (const n of graph.snapshot().nodes) {
    if (n.kind !== 'agent') continue;
    const agentId = n.label || n.id.replace(/^agent:/, '');
    const used = (n.tokensIn || 0) + (n.tokensOut || 0);
    globalTokens += used;
    const status = budgetStatus({ used, limit: cfg.budgetPerAgentTokens });
    const key = `agent:${agentId}`;
    if (budgetState.get(key) === status) continue;
    budgetState.set(key, status);
    if (status === 'ok') { broadcast({ type: 'budget', scope: 'agent', agentId, status }); continue; }
    const estCost = estimateCost(n, loadPricing()); // read fresh every time -- pricing.json is meant to be hand-edited live, no restart needed
    broadcast({ type: 'budget', scope: 'agent', agentId, status, usedTokens: used, limitTokens: cfg.budgetPerAgentTokens, estCost });
    log.warn('agent token budget', { agentId, status, usedTokens: used, limitTokens: cfg.budgetPerAgentTokens, estCost });
    if (status === 'exceeded' && cfg.budgetAutoPause) {
      request(cfg.agentControlMethod, { agentId, action: 'pause' })
        .then(() => audit.record({ user: 'system', action: 'agent-control', target: agentId, decision: 'pause', result: 'auto-budget' }))
        .catch(e => { log.warn('auto-pause failed', { agentId, error: e.message }); audit.record({ user: 'system', action: 'agent-control', target: agentId, decision: 'pause', result: 'auto-budget-failed', error: e.message }); });
    }
  }
  if (!cfg.budgetGlobalTokens) return;
  const globalStatus = budgetStatus({ used: globalTokens, limit: cfg.budgetGlobalTokens });
  if (budgetState.get('global') === globalStatus) return;
  budgetState.set('global', globalStatus);
  broadcast({ type: 'budget', scope: 'global', status: globalStatus, usedTokens: globalTokens, limitTokens: cfg.budgetGlobalTokens });
  if (globalStatus !== 'ok') log.warn('global token budget', { status: globalStatus, usedTokens: globalTokens, limitTokens: cfg.budgetGlobalTokens });
}

function sendConnect(challenge) {
  const scopes = ['operator.read'];
  if (cfg.approvals) scopes.push('operator.approvals');
  const id = `mc-${++reqSeq}`;
  pending.set(id, {
    method: 'connect',
    t: setTimeout(() => ws.close(4000, 'connect timeout'), 15000),
    resolve: async (hello) => {
      backoff = 1000;
      breaker.recordSuccess();
      const granted = hello?.auth?.scopes || hello?.scopes;
      setStatus('live', granted ? `scopes: ${[].concat(granted).join(', ')}` : undefined);
      subscribed.clear();
      try {
        const res = await request('sessions.subscribe', { limit: 60, ownerFirst: true });
        ingest('sessions.snapshot', res?.list || res);
      } catch (e) { log.warn('sessions.subscribe failed', { error: e.message }); }
    },
    reject: (err) => setStatus('error', `connect rejected: ${err?.message || JSON.stringify(err)}`),
  });
  ws.send(JSON.stringify({
    type: 'req', id, method: 'connect',
    params: {
      minProtocol: 3, maxProtocol: 4,
      client: { id: cfg.clientId, version: '0.1.0', platform: process.platform, mode: cfg.clientMode },
      role: 'operator', scopes, caps: ['tool-events'], commands: [], permissions: {},
      auth: cfg.token ? { token: cfg.token } : {},
      userAgent: 'openclaw-mission-control/0.1.0',
      ...(challenge ? { nonce: challenge.nonce } : {}),
    },
  }));
}

function connectGateway() {
  setStatus('connecting', cfg.gatewayUrl);
  ws = new WebSocket(cfg.gatewayUrl);
  let connectSent = false;
  const fallback = setTimeout(() => { if (!connectSent) { connectSent = true; sendConnect(null); } }, 2500);

  ws.on('message', (buf) => {
    let f; try { f = JSON.parse(buf.toString()); } catch { return; }
    appendWithRotation(cfg.rawLog, JSON.stringify({ at: Date.now(), ...f }).slice(0, 20000) + '\n', { maxBytes: cfg.rawLogMaxBytes });

    if (f.type === 'event' && f.event === 'connect.challenge' && !connectSent) {
      connectSent = true; clearTimeout(fallback); sendConnect(f.payload); return;
    }
    if (f.type === 'res' && pending.has(f.id)) {
      const p = pending.get(f.id); pending.delete(f.id); clearTimeout(p.t);
      if (f.ok === false || f.error) p.reject(f.error || f); else p.resolve(f.payload ?? f.result);
      return;
    }
    if (f.type === 'event') {
      eventCounts.set(f.event, (eventCounts.get(f.event) || 0) + 1);
      if (cfg.probe) log.info('event', { event: f.event, payload: JSON.stringify(f.payload).slice(0, 300) });
      ingest(f.event, f.payload);
    }
  });
  ws.on('close', (code, reason) => {
    clearTimeout(fallback);
    for (const [, p] of pending) { clearTimeout(p.t); p.reject(new Error('socket closed')); }
    pending.clear();
    if (shuttingDown) return;
    breaker.recordFailure();
    reconnectCount += 1;
    if (breaker.isOpen()) {
      setStatus('error', `Gateway unreachable after repeated failures — retrying every ${Math.round(cfg.reconnectCooldownMs / 1000)}s`);
      setTimeout(connectGateway, cfg.reconnectCooldownMs);
      return;
    }
    setStatus('reconnecting', `closed ${code} ${reason || ''}`.trim());
    setTimeout(connectGateway, backoff);
    backoff = Math.min(backoff * 2, 30000);
  });
  ws.on('error', (e) => log.warn('gateway socket error', { error: e.message }));
}

// --- HTTP: UI, SSE stream, auth, approvals, mission history, tasks ---
const indexHtml = () => fs.readFileSync(path.join(here, 'public', 'index.html'));
const loginHtml = () => fs.readFileSync(path.join(here, 'public', 'login.html'));

async function readJsonBody(req) {
  let body = ''; for await (const c of req) body += c;
  return JSON.parse(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/login') {
    if (!authEnabled) { res.writeHead(302, { location: '/' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(loginHtml());
  }

  if (url.pathname === '/api/login' && req.method === 'POST') {
    if (!authEnabled) { res.writeHead(404); return res.end(); }
    try {
      const { username, password } = await readJsonBody(req);
      const session = auth.login(username, password);
      audit.record({ user: username, action: 'login', result: session ? 'ok' : 'failed' });
      if (!session) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'Invalid username or password' })); }
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': `${SESSION_COOKIE}=${session.token}; HttpOnly; SameSite=Strict; Path=/`,
      });
      return res.end(JSON.stringify({ ok: true, username: session.username, role: session.role }));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
    }
  }

  if (url.pathname === '/api/logout' && req.method === 'POST') {
    if (authEnabled) {
      const token = parseCookie(req.headers.cookie, SESSION_COOKIE);
      const session = auth.sessionFor(token);
      auth.logout(token);
      if (session) audit.record({ user: session.username, action: 'logout', result: 'ok' });
    }
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': `${SESSION_COOKIE}=; Max-Age=0; Path=/` });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (url.pathname === '/api/session') {
    const session = sessionFor(req);
    if (!session) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false })); }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, ...session, authEnabled }));
  }

  if (url.pathname === '/api/audit') {
    const session = sessionFor(req);
    if (!session || !roleAtLeast(session.role, 'admin')) { res.writeHead(403); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, entries: audit.list(200) }));
  }

  if (url.pathname === '/api/reload' && req.method === 'POST') {
    const session = sessionFor(req);
    if (!session || !roleAtLeast(session.role, 'admin')) { res.writeHead(403); return res.end('Requires an admin session.'); }
    // Deliberately narrow: only the "non-structural" settings the plan calls out (budgets,
    // webhooks) are safe to hot-swap. Gateway URL, auth users, and the agent roster are not
    // reloaded here -- re-seeding those mid-process risks leaving graph.js/auth.js in an
    // inconsistent state (an open session for a removed user, a half-reseeded map). Restart
    // for those. tool-policy.json, pricing.json, and templates.json already re-read from disk
    // on every request, so there was nothing to add here for them.
    const fresh = readEnvFile();
    const get = (key, fallback) => (fresh[key] !== undefined ? fresh[key] : (process.env[key] !== undefined ? process.env[key] : fallback));
    cfg.budgetPerAgentTokens = Number(get('MC_BUDGET_TOKENS_PER_AGENT', 0));
    cfg.budgetGlobalTokens = Number(get('MC_BUDGET_TOKENS_GLOBAL', 0));
    cfg.budgetAutoPause = get('MC_BUDGET_AUTO_PAUSE', '0') === '1';
    cfg.webhooks = parseWebhooks(get('MC_WEBHOOKS', ''));
    budgetState.clear(); // let the next check re-announce the current state under the new limits
    audit.record({ user: session.username, action: 'config-reload', result: 'ok' });
    log.info('config reloaded', { budgetPerAgentTokens: cfg.budgetPerAgentTokens, budgetGlobalTokens: cfg.budgetGlobalTokens, budgetAutoPause: cfg.budgetAutoPause });
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      reloaded: {
        budgetPerAgentTokens: cfg.budgetPerAgentTokens,
        budgetGlobalTokens: cfg.budgetGlobalTokens,
        budgetAutoPause: cfg.budgetAutoPause,
        webhookEvents: [...cfg.webhooks.keys()],
      },
    }));
  }

  if (url.pathname === '/api/missions') {
    if (authEnabled && !sessionFor(req)) { res.writeHead(401); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, missions: store.listMissions() }));
  }

  const missionOpsMatch = url.pathname.match(/^\/api\/missions\/([^/]+)\/ops$/);
  if (missionOpsMatch) {
    if (authEnabled && !sessionFor(req)) { res.writeHead(401); return res.end(); }
    try {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, ops: store.loadMissionOps(missionOpsMatch[1]) }));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
    }
  }

  if (url.pathname === '/api/templates') {
    if (authEnabled && !sessionFor(req)) { res.writeHead(401); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, templates: loadTemplates() }));
  }

  if (url.pathname === '/api/tool-output' && req.method === 'POST') {
    const session = sessionFor(req);
    if (!session) { res.writeHead(401); return res.end(); }
    try {
      const { sessionKey, callId } = await readJsonBody(req);
      if (!sessionKey || !callId) throw new Error('sessionKey and callId are required');
      const result = await request(cfg.toolOutputMethod, { sessionKey, toolCallId: callId });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, result }));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
    }
  }

  if (url.pathname === '/api/task' && req.method === 'POST') {
    if (!cfg.taskSubmit) { res.writeHead(403); return res.end('Task submission is disabled. Set MC_ENABLE_TASK_SUBMIT=1.'); }
    const session = sessionFor(req);
    if (!session || !roleAtLeast(session.role, 'operator')) { res.writeHead(403); return res.end('Requires an operator or admin session.'); }
    let prompt;
    try {
      ({ prompt } = await readJsonBody(req));
      if (!prompt || typeof prompt !== 'string') throw new Error('prompt is required');
      const result = await request(cfg.taskSubmitMethod, { agentId: cfg.agents[0], message: prompt });
      audit.record({ user: session.username, action: 'task-submit', result: 'ok', detail: prompt.slice(0, 200) });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, result }));
    } catch (e) {
      audit.record({ user: session.username, action: 'task-submit', result: 'error', detail: (prompt || '').slice(0, 200), error: e.message || String(e) });
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
    }
  }

  if (url.pathname === '/api/pricing') {
    if (authEnabled && !sessionFor(req)) { res.writeHead(401); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, pricing: loadPricing() }));
  }

  if (url.pathname === '/api/tools') {
    if (authEnabled && !sessionFor(req)) { res.writeHead(401); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, tools: computeToolStats(store) }));
  }

  if (url.pathname === '/api/tool-policy' && req.method === 'GET') {
    if (authEnabled && !sessionFor(req)) { res.writeHead(401); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, policy: toolPolicy.list() }));
  }

  if (url.pathname === '/api/tool-policy' && req.method === 'POST') {
    const session = sessionFor(req);
    if (!session || !roleAtLeast(session.role, 'admin')) { res.writeHead(403); return res.end('Requires an admin session.'); }
    let agentId, tool, policy;
    try {
      ({ agentId, tool, policy } = await readJsonBody(req));
      if (!agentId || !tool) throw new Error('agentId and tool are required');
      toolPolicy.set(agentId, tool, policy);
      let rpcResult = null, rpcError = null;
      try { rpcResult = await request(cfg.toolToggleMethod, { agentId, tool, policy }); }
      catch (e) { rpcError = e.message || String(e); }
      audit.record({ user: session.username, action: 'tool-policy', target: `${agentId}:${tool}`, decision: policy, result: rpcError ? 'local-only' : 'ok', error: rpcError || undefined });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, policy: toolPolicy.list(), rpcResult, rpcError }));
    } catch (e) {
      audit.record({ user: session.username, action: 'tool-policy', target: agentId && tool ? `${agentId}:${tool}` : agentId, decision: policy, result: 'error', error: e.message || String(e) });
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
    }
  }

  const agentControlMatch = url.pathname.match(/^\/api\/agent\/([^/]+)\/control$/);
  if (agentControlMatch && req.method === 'POST') {
    const session = sessionFor(req);
    if (!session || !roleAtLeast(session.role, 'admin')) { res.writeHead(403); return res.end('Requires an admin session.'); }
    const agentId = agentControlMatch[1];
    let action;
    try {
      ({ action } = await readJsonBody(req));
      if (!['start', 'stop', 'restart', 'pause', 'resume'].includes(action)) throw new Error('action must be start/stop/restart/pause/resume');
      const result = await request(cfg.agentControlMethod, { agentId, action });
      audit.record({ user: session.username, action: 'agent-control', target: agentId, decision: action, result: 'ok' });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, result }));
    } catch (e) {
      audit.record({ user: session.username, action: 'agent-control', target: agentId, decision: action, result: 'error', error: e.message || String(e) });
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
    }
  }

  const agentConfigMatch = url.pathname.match(/^\/api\/agent\/([^/]+)\/config$/);
  if (agentConfigMatch && req.method === 'POST') {
    const session = sessionFor(req);
    if (!session || !roleAtLeast(session.role, 'admin')) { res.writeHead(403); return res.end('Requires an admin session.'); }
    const agentId = agentConfigMatch[1];
    let config;
    try {
      ({ config } = await readJsonBody(req));
      if (!config || typeof config !== 'object') throw new Error('config object is required');
      const result = await request(cfg.agentConfigMethod, { agentId, config });
      audit.record({ user: session.username, action: 'agent-config', target: agentId, result: 'ok', detail: JSON.stringify(config).slice(0, 200) });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, result }));
    } catch (e) {
      audit.record({ user: session.username, action: 'agent-config', target: agentId, result: 'error', error: e.message || String(e) });
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
    }
  }

  if (url.pathname === '/api/agent/spawn' && req.method === 'POST') {
    const session = sessionFor(req);
    if (!session || !roleAtLeast(session.role, 'admin')) { res.writeHead(403); return res.end('Requires an admin session.'); }
    let agentId, prompt;
    try {
      ({ agentId, prompt } = await readJsonBody(req));
      if (!agentId || !prompt) throw new Error('agentId and prompt are required');
      const result = await request(cfg.agentSpawnMethod, { agentId, prompt });
      audit.record({ user: session.username, action: 'agent-spawn', target: agentId, result: 'ok', detail: String(prompt).slice(0, 200) });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, result }));
    } catch (e) {
      audit.record({ user: session.username, action: 'agent-spawn', target: agentId, result: 'error', error: e.message || String(e) });
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
    }
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    if (authEnabled && !sessionFor(req)) { res.writeHead(302, { location: '/login' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(indexHtml());
  }
  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, gateway: gatewayStatus, approvals: cfg.approvals, events: Object.fromEntries(eventCounts) }));
  }
  if (url.pathname === '/api/metrics') {
    if (authEnabled && !sessionFor(req)) { res.writeHead(401); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      gatewayStatus,
      uptimeSec: Math.round(process.uptime()),
      sseClients: clients.size,
      reconnectCount,
      eventCounts: Object.fromEntries(eventCounts),
      unknownEventCounts: Object.fromEntries(unknownEventCounts),
    }));
  }
  if (url.pathname === '/events') {
    if (authEnabled && !sessionFor(req)) { res.writeHead(401); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'snapshot', ...graph.snapshot(), status: gatewayStatus, approvals: cfg.approvals, taskSubmit: cfg.taskSubmit })}\n\n`);
    clients.add(res);
    const ka = setInterval(() => res.write(': keepalive\n\n'), 20000);
    req.on('close', () => { clearInterval(ka); clients.delete(res); });
    return;
  }
  if (url.pathname === '/api/approval' && req.method === 'POST') {
    if (!cfg.approvals) { res.writeHead(403); return res.end('Approvals are disabled. Set MC_ENABLE_APPROVALS=1.'); }
    const session = sessionFor(req);
    if (!session || !roleAtLeast(session.role, 'operator')) { res.writeHead(403); return res.end('Requires an operator or admin session.'); }
    // Only accept same-origin requests from the UI.
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) { res.writeHead(403); return res.end('Cross-origin request refused'); }
    let approvalId, decision;
    try {
      ({ approvalId, decision } = await readJsonBody(req));
      if (!approvalId || !['approve', 'reject'].includes(decision)) throw new Error('approvalId and decision are required');
      const result = await request(cfg.approvalMethod, { id: approvalId, decision: decision === 'approve' ? 'allow-once' : 'deny' });
      audit.record({ user: session.username, action: 'approval', target: approvalId, decision, result: 'ok' });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, result }));
    } catch (e) {
      audit.record({ user: session.username, action: 'approval', target: approvalId, decision, result: 'error', error: e.message || String(e) });
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
    }
  }
  res.writeHead(404); res.end();
});

server.listen(cfg.port, cfg.host, () => {
  log.info('Mission Control listening', { host: cfg.host, port: cfg.port, agents: cfg.agents, approvals: cfg.approvals, authEnabled });
  if (!cfg.token) log.warn('OPENCLAW_GATEWAY_TOKEN is empty');
  connectGateway();
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutdown', { signal });
  for (const res of clients) { try { res.end(); } catch { /* already closed */ } }
  clients.clear();
  if (ws) { try { ws.close(); } catch { /* already closed */ } }
  server.close(() => process.exit(0));
  // Force-exit if something (a slow client, a stuck socket) is still open after 3s.
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
