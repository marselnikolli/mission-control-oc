#!/usr/bin/env node
// Thin CLI over Mission Control's own HTTP API -- same routes the browser UI calls, so nothing
// here is a separate integration surface to keep in sync. Requires Node's built-in fetch
// (Node 18+; this project already requires Node 20+).
const BASE = process.env.MC_CLI_URL || 'http://127.0.0.1:4400';
let cookie = '';

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers || {}) },
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

async function login() {
  const username = process.env.MC_CLI_USER;
  const password = process.env.MC_CLI_PASS;
  if (!username || !password) return; // auth may not be enabled server-side (MC_AUTH_USERS unset)
  await api('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) });
}

function usage() {
  console.log(`usage: mc-cli <command> [args]

Commands:
  status              Gateway connection status and event counts
  tasks                List recorded missions
  approve <approvalId> Approve a pending approval
  reject <approvalId>  Reject a pending approval

Env:
  MC_CLI_URL   Mission Control base URL (default http://127.0.0.1:4400)
  MC_CLI_USER  Username, if MC_AUTH_USERS is configured server-side
  MC_CLI_PASS  Password, if MC_AUTH_USERS is configured server-side`);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (!cmd || cmd === '-h' || cmd === '--help') { usage(); process.exitCode = cmd ? 0 : 1; return; }

  await login();

  if (cmd === 'status') {
    const h = await api('/api/health');
    console.log(`gateway: ${h.gateway}`);
    console.log(`approvals: ${h.approvals ? 'on' : 'off'}`);
    for (const [event, count] of Object.entries(h.events || {})) console.log(`  ${event}: ${count}`);
  } else if (cmd === 'tasks') {
    const j = await api('/api/missions');
    for (const m of j.missions) console.log(`${m.id}\t${m.status}\t${m.label}`);
    if (!j.missions.length) console.log('(no missions recorded yet)');
  } else if (cmd === 'approve' || cmd === 'reject') {
    if (!arg) throw new Error(`usage: mc-cli ${cmd} <approvalId>`);
    await api('/api/approval', { method: 'POST', body: JSON.stringify({ approvalId: arg, decision: cmd === 'approve' ? 'approve' : 'reject' }) });
    console.log('ok');
  } else {
    usage();
    process.exitCode = 1;
  }
}

main().catch(e => { console.error(e.message); process.exitCode = 1; });
