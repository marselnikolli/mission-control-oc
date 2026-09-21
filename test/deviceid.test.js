import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildDeviceAuthPayloadV3,
  buildDeviceProof,
  deriveDeviceIdFromPublicKey,
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64Url,
  signDevicePayload,
} from '../deviceid.js';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-deviceid-'));
}

// Mirrors the Gateway's verification: rebuild the raw SPKI from the base64url key material.
function verifyRaw(publicKeyBase64Url, payload, signatureBase64Url) {
  const raw = Buffer.from(publicKeyBase64Url, 'base64url');
  const key = crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    type: 'spki',
    format: 'der',
  });
  return crypto.verify(null, Buffer.from(payload, 'utf8'), key, Buffer.from(signatureBase64Url, 'base64url'));
}

describe('buildDeviceAuthPayloadV3', () => {
  test('joins the canonical v3 fields in the Gateway order', () => {
    const payload = buildDeviceAuthPayloadV3({
      deviceId: 'abc',
      clientId: 'cli',
      clientMode: 'cli',
      role: 'operator',
      scopes: ['operator.read', 'operator.approvals'],
      signedAtMs: 1737264000000,
      token: 'sekret',
      nonce: 'n-1',
      platform: 'linux',
      deviceFamily: null,
    });
    assert.equal(payload, 'v3|abc|cli|cli|operator|operator.read,operator.approvals|1737264000000|sekret|n-1|linux|');
  });

  test('normalizes optional metadata to lowercase and treats absent token as empty', () => {
    const payload = buildDeviceAuthPayloadV3({
      deviceId: 'd', clientId: 'cli', clientMode: 'ui', role: 'operator',
      scopes: [], signedAtMs: 1, token: null, nonce: 'n', platform: ' Linux ', deviceFamily: ' Desktop ',
    });
    assert.equal(payload, 'v3|d|cli|ui|operator||1||n|linux|desktop');
  });
});

describe('device identity', () => {
  test('generates a stable Ed25519 identity persisted under the data dir', () => {
    const dir = tmpDir();
    const first = loadOrCreateDeviceIdentity(dir);
    assert.match(first.deviceId, /^[0-9a-f]{64}$/);
    assert.equal(first.deviceId, deriveDeviceIdFromPublicKey(first.publicKeyPem));

    const second = loadOrCreateDeviceIdentity(dir);
    assert.equal(second.deviceId, first.deviceId);
    assert.equal(second.privateKeyPem, first.privateKeyPem);

    const mode = fs.statSync(path.join(dir, 'device-identity.json')).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  test('public key exports as unpadded base64url of the 32 raw bytes', () => {
    const identity = loadOrCreateDeviceIdentity(tmpDir());
    const raw = Buffer.from(publicKeyRawBase64Url(identity.publicKeyPem), 'base64url');
    assert.equal(raw.length, 32);
    assert.equal(deriveDeviceIdFromPublicKey(identity.publicKeyPem), crypto.createHash('sha256').update(raw).digest('hex'));
  });

  test('buildDeviceProof signs a payload the Gateway can verify and echoes the challenge', () => {
    const identity = loadOrCreateDeviceIdentity(tmpDir());
    const challenge = { nonce: 'nonce-123', ts: 1737264000000 };
    const args = {
      clientId: 'cli', clientMode: 'cli', role: 'operator', scopes: ['operator.read'],
      token: 'sekret', challenge, platform: 'linux',
    };
    const proof = buildDeviceProof(identity, args);
    assert.equal(proof.id, identity.deviceId);
    assert.equal(proof.nonce, 'nonce-123');
    assert.equal(proof.signedAt, 1737264000000);

    const payload = buildDeviceAuthPayloadV3({
      deviceId: identity.deviceId, clientId: 'cli', clientMode: 'cli', role: 'operator',
      scopes: ['operator.read'], signedAtMs: 1737264000000, token: 'sekret',
      nonce: 'nonce-123', platform: 'linux', deviceFamily: null,
    });
    assert.equal(verifyRaw(proof.publicKey, payload, proof.signature), true);
  });

  test('signature does not verify once the signed facts change', () => {
    const identity = loadOrCreateDeviceIdentity(tmpDir());
    const proof = buildDeviceProof(identity, {
      clientId: 'cli', clientMode: 'cli', role: 'operator', scopes: ['operator.read'],
      token: 'sekret', challenge: { nonce: 'n', ts: 1737264000000 }, platform: 'linux',
    });
    const tampered = buildDeviceAuthPayloadV3({
      deviceId: identity.deviceId, clientId: 'cli', clientMode: 'cli', role: 'operator',
      scopes: ['operator.read', 'operator.approvals'], signedAtMs: 1737264000000,
      token: 'sekret', nonce: 'n', platform: 'linux', deviceFamily: null,
    });
    assert.equal(verifyRaw(proof.publicKey, tampered, proof.signature), false);
  });

  test('falls back to local time when the challenge has no integer ts', () => {
    const identity = loadOrCreateDeviceIdentity(tmpDir());
    const before = Date.now();
    const proof = buildDeviceProof(identity, {
      clientId: 'cli', clientMode: 'cli', role: 'operator', scopes: [],
      token: null, challenge: { nonce: 'n' }, platform: 'linux',
    });
    assert.ok(proof.signedAt >= before && proof.signedAt <= Date.now());
  });

  test('returns undefined without a nonce or without an identity', () => {
    const identity = loadOrCreateDeviceIdentity(tmpDir());
    const base = { clientId: 'cli', clientMode: 'cli', role: 'operator', scopes: [], token: null, platform: 'linux' };
    assert.equal(buildDeviceProof(identity, { ...base, challenge: null }), undefined);
    assert.equal(buildDeviceProof(identity, { ...base, challenge: { nonce: '  ' } }), undefined);
    assert.equal(buildDeviceProof(null, { ...base, challenge: { nonce: 'n', ts: 1 } }), undefined);
  });

  test('signDevicePayload output verifies against the matching public key', () => {
    const identity = loadOrCreateDeviceIdentity(tmpDir());
    const sig = signDevicePayload(identity.privateKeyPem, 'hello');
    assert.equal(verifyRaw(publicKeyRawBase64Url(identity.publicKeyPem), 'hello', sig), true);
  });
});
