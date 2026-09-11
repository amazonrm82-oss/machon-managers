// Web Push for Deno / Supabase Edge Functions: RFC 8291 payload encryption
// (aes128gcm) + RFC 8292 VAPID request auth, using WebCrypto only (no npm deps).
// The crypto here is verified offline by webpush.reference.mjs / webpush.test.mjs
// (encrypt->decrypt round-trip, VAPID signature verification, tamper detection).
//
// Secrets used by sendWebPush():
//   LEARN_VAPID_PUBLIC    base64url uncompressed P-256 point (65 bytes)
//   LEARN_VAPID_PRIVATE   base64url raw P-256 scalar d (32 bytes)
//   LEARN_VAPID_SUBJECT   contact, e.g. mailto:admin@icelp.org.il

const enc = new TextEncoder();

function b64u(bytes: Uint8Array): string {
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function unb64u(str: string): Uint8Array {
  str = String(str);
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concat(...arrs: Uint8Array[]): Uint8Array {
  let n = 0; for (const a of arrs) n += a.length;
  const o = new Uint8Array(n); let i = 0; for (const a of arrs) { o.set(a, i); i += a.length; }
  return o;
}

async function hmac(keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
// HKDF-Extract then HKDF-Expand to `len` bytes (len <= 32 for all uses here).
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const prk = await hmac(salt, ikm);
  const out = await hmac(prk, concat(info, new Uint8Array([1])));
  return out.slice(0, len);
}

// P-256 key: private = raw 32-byte scalar; public = 65-byte uncompressed point.
function jwkFromVapid(pubB64u: string, privB64u?: string): JsonWebKey {
  const pub = unb64u(pubB64u);   // 0x04 || X(32) || Y(32)
  const jwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), ext: true };
  if (privB64u) jwk.d = b64u(unb64u(privB64u));
  return jwk;
}

export async function buildVapidJwt(audience: string, subject: string, pubB64u: string, privB64u: string, ttlSec = 12 * 3600): Promise<string> {
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = { aud: audience, exp: Math.floor(Date.now() / 1000) + ttlSec, sub: subject };
  const signingInput = b64u(enc.encode(JSON.stringify(header))) + '.' + b64u(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey('jwk', jwkFromVapid(pubB64u, privB64u), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(signingInput)));
  return signingInput + '.' + b64u(sig);   // ES256 signature is raw R||S (64 bytes)
}

interface Subscription { endpoint: string; keys: { p256dh: string; auth: string }; }

// RFC 8291 §3.4 + RFC 8188: encrypt a UTF-8 payload for one subscription.
async function encryptPayload(subscription: Subscription, payloadStr: string): Promise<Uint8Array> {
  const uaPublic = unb64u(subscription.keys.p256dh);   // 65 bytes
  const authSecret = unb64u(subscription.keys.auth);   // 16 bytes

  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, kp.privateKey, 256));

  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublicRaw);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const record = concat(enc.encode(payloadStr), new Uint8Array([2]));   // single record, 0x02 delimiter
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, record));

  const rs = 4096;
  const header = concat(salt, new Uint8Array([(rs >>> 24) & 255, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255]), new Uint8Array([asPublicRaw.length]), asPublicRaw);
  return concat(header, ct);
}

// Send one push. Returns { ok, status, gone } — `gone` means the endpoint is
// dead (404/410) and its subscription should be dropped.
export async function sendWebPush(subscription: Subscription, payloadStr: string, vapid: { publicKey: string; privateKey: string; subject: string }): Promise<{ ok: boolean; status: number; gone: boolean }> {
  const audience = new URL(subscription.endpoint).origin;
  const jwt = await buildVapidJwt(audience, vapid.subject, vapid.publicKey, vapid.privateKey);
  const body = await encryptPayload(subscription, payloadStr);
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'TTL': '86400',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'Authorization': `vapid t=${jwt}, k=${vapid.publicKey}`,
    },
    body,
  });
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}
