// Parses MC_WEBHOOKS ("event:url,event:url,...") into event -> [urls]. A URL's own "://" colon
// is fine -- we split on the *first* colon only, not every colon in the entry.
export function parseWebhooks(spec) {
  const map = new Map();
  for (const entry of (spec || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const i = entry.indexOf(':');
    if (i === -1) continue;
    const event = entry.slice(0, i);
    const url = entry.slice(i + 1);
    if (!event || !url) continue;
    if (!map.has(event)) map.set(event, []);
    map.get(event).push(url);
  }
  return map;
}

// Fire-and-forget POST to every URL registered for this event. Never throws -- a broken
// webhook receiver shouldn't take down mission control's own event handling.
export function fireWebhook(webhooks, event, payload, { onError } = {}) {
  const urls = webhooks.get(event);
  if (!urls || !urls.length) return;
  for (const url of urls) {
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event, at: Date.now(), ...payload }),
    }).catch(e => onError && onError(url, e));
  }
}
