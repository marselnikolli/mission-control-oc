import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createNormalizer } from './normalizer.js';
import { createGraph } from './graph.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// --- tiny .env loader (no dependency) ---
const envFile = path.join(here, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
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
  probe: process.argv.includes('--probe'),
};
fs.mkdirSync(path.dirname(cfg.rawLog), { recursive: true });

const graph = createGraph({ agents: cfg.agents });
const normalize = createNormalizer({ agents: cfg.agents });
const clients = new Set();
let gatewayStatus = 'connecting';

function broadcast(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) res.write(data);
}
function setStatus(s, detail) {
  gatewayStatus = s;
  broadcast({ type: 'status', status: s, detail, approvals: cfg.approvals });
  console.log(`[gateway] ${s}${detail ? ' – ' + detail : ''}`);
}

// --- Gateway client ---
const subscribed = new Set();
let ws, reqSeq = 0, backoff = 1000;
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

function ingest(event, payload) {
  const ops = normalize(event, payload);
  const subs = ops.filter(o => o.op === 'subscribe');
  for (const s of subs) {
    if (subscribed.has(s.key) || subscribed.size >= 60) continue;
    subscribed.add(s.key);
    request('sessions.messages.subscribe', { key: s.key, includeApprovals: cfg.approvals })
      .catch(e => { subscribed.delete(s.key); console.warn(`[gateway] subscribe ${s.key}: ${e.message}`); });
  }
  const out = graph.apply(ops.filter(o => o.op !== 'subscribe'));
  if (out.length) broadcast({ type: 'ops', ops: out });
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
      const granted = hello?.auth?.scopes || hello?.scopes;
      setStatus('live', granted ? `scopes: ${[].concat(granted).join(', ')}` : undefined);
      subscribed.clear();
      try {
        const res = await request('sessions.subscribe', { limit: 60, ownerFirst: true });
        ingest('sessions.snapshot', res?.list || res);
      } catch (e) { console.warn('[gateway] sessions.subscribe failed:', e.message); }
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
    fs.appendFile(cfg.rawLog, JSON.stringify({ at: Date.now(), ...f }).slice(0, 20000) + '\n', () => {});

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
      if (cfg.probe) console.log(`[event] ${f.event}`, JSON.stringify(f.payload).slice(0, 300));
      ingest(f.event, f.payload);
    }
  });
  ws.on('close', (code, reason) => {
    clearTimeout(fallback);
    for (const [, p] of pending) { clearTimeout(p.t); p.reject(new Error('socket closed')); }
    pending.clear();
    setStatus('reconnecting', `closed ${code} ${reason || ''}`.trim());
    setTimeout(connectGateway, backoff);
    backoff = Math.min(backoff * 2, 30000);
  });
  ws.on('error', (e) => console.warn('[gateway] socket error:', e.message));
}

// --- HTTP: UI, SSE stream, approvals ---
const indexHtml = () => fs.readFileSync(path.join(here, 'public', 'index.html'));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(indexHtml());
  }
  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, gateway: gatewayStatus, approvals: cfg.approvals, events: Object.fromEntries(eventCounts) }));
  }
  if (url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'snapshot', ...graph.snapshot(), status: gatewayStatus, approvals: cfg.approvals })}\n\n`);
    clients.add(res);
    const ka = setInterval(() => res.write(': keepalive\n\n'), 20000);
    req.on('close', () => { clearInterval(ka); clients.delete(res); });
    return;
  }
  if (url.pathname === '/api/approval' && req.method === 'POST') {
    if (!cfg.approvals) { res.writeHead(403); return res.end('Approvals are disabled. Set MC_ENABLE_APPROVALS=1.'); }
    // Only accept same-origin requests from the UI.
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) { res.writeHead(403); return res.end('Cross-origin request refused'); }
    let body = ''; for await (const c of req) body += c;
    try {
      const { approvalId, decision } = JSON.parse(body);
      if (!approvalId || !['approve', 'reject'].includes(decision)) throw new Error('approvalId and decision are required');
      const result = await request(cfg.approvalMethod, { id: approvalId, decision: decision === 'approve' ? 'allow-once' : 'deny' });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, result }));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
    }
  }
  res.writeHead(404); res.end();
});

server.listen(cfg.port, cfg.host, () => {
  console.log(`Mission Control on http://${cfg.host}:${cfg.port}  (agents: ${cfg.agents.join(', ')}; approvals ${cfg.approvals ? 'on' : 'off'})`);
  if (!cfg.token) console.warn('[warn] OPENCLAW_GATEWAY_TOKEN is empty');
  connectGateway();
});
