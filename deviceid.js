// Ed25519 device identity for the Gateway handshake.
//
// Current Gateways reject a device-less operator connect (or silently clear self-declared
// scopes), and the connect.challenge nonce must be signed into connect.params.device — it is
// NOT a top-level connect param. This module mirrors the reference gateway-client's device
// auth: a stable keypair under MC_DATA_DIR, the v3 signed payload, and the device proof object.
// See docs.openclaw.ai/gateway/protocol/auth.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Ed25519 SubjectPublicKeyInfo DER prefix; the raw public key is the 32 bytes after it.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const RAW_KEY_LENGTH = 32;

function base64url(buf) {
  return buf.toString('base64url');
}

// Optional metadata is lowercased/trimmed before signing so different hosts produce the same
// signature over the same logical facts (the Gateway byte-for-byte compares the payload).
function normalizeMetadata(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed ? trimmed.toLowerCase() : '';
}

export function deriveRawPublicKeyFromPem(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('device key must be Ed25519');
  const spki = key.export({ type: 'spki', format: 'der' });
  if (spki.length !== ED25519_SPKI_PREFIX.length + RAW_KEY_LENGTH
    || !spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    throw new Error('noncanonical Ed25519 public key encoding');
  }
  return spki.subarray(ED25519_SPKI_PREFIX.length);
}

export function publicKeyRawBase64Url(publicKeyPem) {
  return base64url(deriveRawPublicKeyFromPem(publicKeyPem));
}

// Stable device id the Gateway derives independently from the raw public key.
export function deriveDeviceIdFromPublicKey(publicKeyPem) {
  return crypto.createHash('sha256').update(deriveRawPublicKeyFromPem(publicKeyPem)).digest('hex');
}

export function signDevicePayload(privateKeyPem, payload) {
  const key = crypto.createPrivateKey(privateKeyPem);
  return base64url(crypto.sign(null, Buffer.from(payload, 'utf8'), key));
}

// Canonical signed payload, byte-for-byte the same as the Gateway's
// buildDeviceAuthPayloadV3 (packages/gateway-client/src/device-auth.ts).
export function buildDeviceAuthPayloadV3({
  deviceId, clientId, clientMode, role, scopes, signedAtMs, token = null, nonce,
  platform = null, deviceFamily = null,
}) {
  return [
    'v3',
    deviceId,
    clientId,
    clientMode,
    role,
    (scopes || []).join(','),
    String(signedAtMs),
    token ?? '',
    nonce,
    normalizeMetadata(platform),
    normalizeMetadata(deviceFamily),
  ].join('|');
}

// Load the persisted identity or create one. Stored 0600 under data/ (gitignored) so the
// device keeps the same id across restarts instead of re-pairing every time.
export function loadOrCreateDeviceIdentity(dir) {
  const file = path.join(dir, 'device-identity.json');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.privateKeyPem && saved.publicKeyPem && saved.deviceId) return saved;
  } catch { /* missing or invalid -> create below */ }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const identity = {
    deviceId: deriveDeviceIdFromPublicKey(publicKeyPem),
    publicKeyPem,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    createdMs: Date.now(),
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(identity, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort (e.g. Windows) */ }
  return identity;
}

// Build connect.params.device for a received connect.challenge. Returns undefined when there's
// no identity or no challenge nonce, so callers can omit the field (older Gateways).
export function buildDeviceProof(identity, {
  clientId, clientMode, role, scopes, token, challenge, platform, deviceFamily = null,
}) {
  const nonce = typeof challenge?.nonce === 'string' ? challenge.nonce.trim() : '';
  if (!identity || !nonce) return undefined;
  const signedAt = Number.isInteger(challenge?.ts) && challenge.ts >= 0 ? challenge.ts : Date.now();
  const payload = buildDeviceAuthPayloadV3({
    deviceId: identity.deviceId,
    clientId,
    clientMode,
    role,
    scopes,
    signedAtMs: signedAt,
    token,
    nonce,
    platform,
    deviceFamily,
  });
  return {
    id: identity.deviceId,
    publicKey: publicKeyRawBase64Url(identity.publicKeyPem),
    signature: signDevicePayload(identity.privateKeyPem, payload),
    signedAt,
    nonce,
  };
}
