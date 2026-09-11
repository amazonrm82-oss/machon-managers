// learn-auth: the learning system's own email + password sign-in, with admin
// approval. Separate from Microsoft Entra ID and from the management system's
// role-auth. Passwords are salted+hashed here and never leave the server; a new
// account is `pending` until the configured administrator approves it.
//
// Environment (Supabase project secrets):
//   LEARN_TOKEN_SECRET   random string used to sign session tokens (HMAC-SHA256)
//   LEARN_ADMIN_EMAIL    the one address that is the system administrator; that
//                        account is auto-approved and is the only approver. It
//                        must itself be a name@icelp.org.il address, like everyone.
//
// Deploy with: supabase functions deploy learn-auth
// (Single file on purpose — Web Push is inlined below so this deploys as one
//  file, including via the Supabase dashboard editor.)

import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const TOKEN_SECRET = Deno.env.get('LEARN_TOKEN_SECRET') || '';
const ADMIN_EMAIL = (Deno.env.get('LEARN_ADMIN_EMAIL') || '').trim().toLowerCase();
const VAPID_PUBLIC = (Deno.env.get('LEARN_VAPID_PUBLIC') || '').trim();
const VAPID_PRIVATE = (Deno.env.get('LEARN_VAPID_PRIVATE') || '').trim();
const VAPID_SUBJECT = (Deno.env.get('LEARN_VAPID_SUBJECT') || 'mailto:admin@icelp.org.il').trim();
const PUSH_ENABLED = !!(VAPID_PUBLIC && VAPID_PRIVATE);
const TOKEN_TTL = 12 * 60 * 60;          // 12h sessions
const PBKDF2_ITER = 210000;              // OWASP-recommended for PBKDF2-HMAC-SHA256
const MIN_PASSWORD = 8;
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
const enc = new TextEncoder();

function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function bytesFromB64url(str: string): Uint8Array {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------------------------------------------------------- password hashing */

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' }, key, 256);
  return `pbkdf2$${PBKDF2_ITER}$${b64urlFromBytes(salt)}$${b64urlFromBytes(new Uint8Array(bits))}`;
}
async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iter = parseInt(parts[1], 10) || PBKDF2_ITER;
  const salt = bytesFromB64url(parts[2]);
  const expected = bytesFromB64url(parts[3]);
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, key, expected.length * 8));
  if (bits.length !== expected.length) return false;
  let diff = 0; for (let i = 0; i < bits.length; i++) diff |= bits[i] ^ expected[i];   // constant-time
  return diff === 0;
}

/* ------------------------------------------------------------ session tokens */

async function hmacKey(usage: KeyUsage[]) {
  return crypto.subtle.importKey('raw', enc.encode(TOKEN_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, usage);
}
async function issueToken(acct: any): Promise<string> {
  const payload = { sub: acct.id, email: acct.email, name: acct.full_name, role: acct.role, admin: !!acct.is_admin, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + TOKEN_TTL };
  const p = b64urlFromBytes(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(['sign']), enc.encode(p));
  return `${p}.${b64urlFromBytes(new Uint8Array(sig))}`;
}
async function verifyToken(token: string): Promise<any | null> {
  if (!TOKEN_SECRET || !token) return null;
  const parts = token.split('.'); if (parts.length !== 2) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(['verify']), bytesFromB64url(parts[1]).buffer as ArrayBuffer, enc.encode(parts[0]));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(bytesFromB64url(parts[0])));
    if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

/* -------------------------------------------------------------- validation */

// Israeli national id (ת"ז) checksum. Accepts up to 9 digits, left-pads, and
// runs the standard weighted-digit-sum mod 10.
function validIsraeliId(raw: string): boolean {
  const s = String(raw || '').trim();
  if (!/^\d{5,9}$/.test(s)) return false;
  const id = s.padStart(9, '0');
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let n = Number(id[i]) * ((i % 2) + 1);
    if (n > 9) n -= 9;
    sum += n;
  }
  return sum % 10 === 0;
}
function normalizeEmail(e: string): string { return String(e || '').trim().toLowerCase(); }
// Every account — the administrator included — must be name@icelp.org.il: exactly
// one local part, then the fixed institute domain.
function emailAllowed(email: string): boolean {
  return /^[^@\s]+@icelp\.org\.il$/.test(email);
}
function randomId(): string {
  return 'usr_' + b64urlFromBytes(crypto.getRandomValues(new Uint8Array(12)));
}

/* ---------------------------------------------------------------- web push
   RFC 8291 payload encryption (aes128gcm) + RFC 8292 VAPID request auth, using
   WebCrypto only (no npm deps). The crypto is verified offline by
   webpush.reference.test.mjs (encrypt->decrypt round-trip, VAPID signature
   verification, tamper detection). Inlined here so learn-auth is a single file. */

function u8concat(...arrs: Uint8Array[]): Uint8Array {
  let n = 0; for (const a of arrs) n += a.length;
  const o = new Uint8Array(n); let i = 0; for (const a of arrs) { o.set(a, i); i += a.length; }
  return o;
}
async function pushHmac(keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
// HKDF-Extract then HKDF-Expand to `len` bytes (len <= 32 for all uses here).
async function pushHkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const prk = await pushHmac(salt, ikm);
  const out = await pushHmac(prk, u8concat(info, new Uint8Array([1])));
  return out.slice(0, len);
}
// P-256 key: private = raw 32-byte scalar; public = 65-byte uncompressed point.
function jwkFromVapid(pubB64u: string, privB64u?: string): JsonWebKey {
  const pub = bytesFromB64url(pubB64u);   // 0x04 || X(32) || Y(32)
  const jwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: b64urlFromBytes(pub.slice(1, 33)), y: b64urlFromBytes(pub.slice(33, 65)), ext: true };
  if (privB64u) jwk.d = b64urlFromBytes(bytesFromB64url(privB64u));
  return jwk;
}
async function buildVapidJwt(audience: string, subject: string, pubB64u: string, privB64u: string, ttlSec = 12 * 3600): Promise<string> {
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = { aud: audience, exp: Math.floor(Date.now() / 1000) + ttlSec, sub: subject };
  const signingInput = b64urlFromBytes(enc.encode(JSON.stringify(header))) + '.' + b64urlFromBytes(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey('jwk', jwkFromVapid(pubB64u, privB64u), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(signingInput)));
  return signingInput + '.' + b64urlFromBytes(sig);   // ES256 signature is raw R||S (64 bytes)
}
interface PushSubscription { endpoint: string; keys: { p256dh: string; auth: string }; }
// RFC 8291 §3.4 + RFC 8188: encrypt a UTF-8 payload for one subscription.
async function encryptPushPayload(subscription: PushSubscription, payloadStr: string): Promise<Uint8Array> {
  const uaPublic = bytesFromB64url(subscription.keys.p256dh);   // 65 bytes
  const authSecret = bytesFromB64url(subscription.keys.auth);   // 16 bytes
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, kp.privateKey, 256));
  const keyInfo = u8concat(enc.encode('WebPush: info\0'), uaPublic, asPublicRaw);
  const ikm = await pushHkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await pushHkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await pushHkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const record = u8concat(enc.encode(payloadStr), new Uint8Array([2]));   // single record, 0x02 delimiter
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, record));
  const rs = 4096;
  const hdr = u8concat(salt, new Uint8Array([(rs >>> 24) & 255, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255]), new Uint8Array([asPublicRaw.length]), asPublicRaw);
  return u8concat(hdr, ct);
}
// Send one push. `gone` (404/410) means the endpoint is dead and should be dropped.
async function sendWebPush(subscription: PushSubscription, payloadStr: string, vapid: { publicKey: string; privateKey: string; subject: string }): Promise<{ ok: boolean; status: number; gone: boolean }> {
  const audience = new URL(subscription.endpoint).origin;
  const jwt = await buildVapidJwt(audience, vapid.subject, vapid.publicKey, vapid.privateKey);
  const body = await encryptPushPayload(subscription, payloadStr);
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

/* ------------------------------------------------------------- admin notify */

// Notify the administrator of a new pending registration. In-app: the pending
// list / badge the admin sees on sign-in. Phone: a Web Push to each device the
// admin has registered — sent only when VAPID secrets are configured. Dead
// endpoints (404/410) are pruned. Push failures never fail the registration.
async function notifyAdminsOfRegistration(acct: any) {
  if (!PUSH_ENABLED) return;
  try {
    const { data: admins } = await db.from('learning_accounts').select('id').eq('is_admin', true).eq('status', 'approved');
    const adminIds = (admins ?? []).map((a: any) => a.id);
    if (!adminIds.length) return;
    const { data: subs } = await db.from('learning_push').select('endpoint, subscription').in('user_id', adminIds);
    if (!subs?.length) return;
    const payload = JSON.stringify({
      title: 'הרשמה חדשה למערכת הלמידה',
      body: `${acct.full_name || 'משתמש חדש'} (${acct.role || 'ללא תפקיד'}) ממתין לאישור`,
      url: '/machon-managers/learn.html',
      tag: 'learn-registration',
    });
    const vapid = { publicKey: VAPID_PUBLIC, privateKey: VAPID_PRIVATE, subject: VAPID_SUBJECT };
    await Promise.all((subs as any[]).map(async (row) => {
      try {
        const res = await sendWebPush(row.subscription, payload, vapid);
        if (res.gone) await db.from('learning_push').delete().eq('endpoint', row.endpoint);
      } catch (e) { console.error('push send failed:', e); }
    }));
  } catch (e) {
    console.error('notifyAdminsOfRegistration failed:', e);
  }
}

/* ----------------------------------------------------------------- handler */

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
  if (!TOKEN_SECRET) return json({ ok: false, error: 'not_configured' }, 503);

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'bad_request' }, 400); }
  const action = String(body?.action || '');

  try {
    // Public config: lets the client fetch the VAPID public key (not a secret)
    // so it can subscribe for push. Empty string when push isn't configured.
    if (action === 'config') {
      return json({ ok: true, vapidPublic: PUSH_ENABLED ? VAPID_PUBLIC : '', pushEnabled: PUSH_ENABLED });
    }

    if (action === 'register') {
      const email = normalizeEmail(body.email);
      const fullName = String(body.fullName || '').trim();
      const role = String(body.role || '').trim();
      const nationalId = String(body.nationalId || '').trim();
      const password = String(body.password || '');
      if (!fullName) return json({ ok: false, error: 'name_required' }, 400);
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ ok: false, error: 'email_invalid' }, 400);
      if (!emailAllowed(email)) return json({ ok: false, error: 'email_domain' }, 400);
      if (!validIsraeliId(nationalId)) return json({ ok: false, error: 'id_invalid' }, 400);
      if (password.length < MIN_PASSWORD) return json({ ok: false, error: 'password_short' }, 400);

      const { data: existing } = await db.from('learning_accounts').select('id').eq('email', email).maybeSingle();
      if (existing) return json({ ok: false, error: 'email_taken' }, 409);

      const isAdmin = !!ADMIN_EMAIL && email === ADMIN_EMAIL;
      const acct = {
        id: randomId(), full_name: fullName, role, email, national_id: nationalId,
        pwd: await hashPassword(password),
        status: isAdmin ? 'approved' : 'pending',
        is_admin: isAdmin,
        approved_by: isAdmin ? 'system' : null,
        approved_at: isAdmin ? new Date().toISOString() : null,
      };
      const { error } = await db.from('learning_accounts').insert(acct);
      if (error) return json({ ok: false, error: 'server_error' }, 500);
      if (!isAdmin) await notifyAdminsOfRegistration(acct);
      // Never return a token for a pending account — approval must come first.
      return json({ ok: true, status: acct.status, isAdmin });
    }

    if (action === 'login') {
      const email = normalizeEmail(body.email);
      const password = String(body.password || '');
      const { data: acct } = await db.from('learning_accounts').select('*').eq('email', email).maybeSingle();
      // Same generic answer whether the email is unknown or the password is wrong.
      const ok = acct ? await verifyPassword(password, acct.pwd) : false;
      if (!acct || !ok) return json({ ok: false, error: 'bad_credentials' }, 401);
      if (acct.status === 'pending') return json({ ok: false, error: 'pending' }, 403);
      if (acct.status !== 'approved') return json({ ok: false, error: 'rejected' }, 403);
      return json({ ok: true, token: await issueToken(acct), user: { id: acct.id, name: acct.full_name, role: acct.role, email: acct.email, isAdmin: !!acct.is_admin } });
    }

    // Everything below needs a valid session.
    const me = await verifyToken(String(body.token || ''));
    if (!me) return json({ ok: false, error: 'unauthorized' }, 401);

    if (action === 'me') {
      const { data: acct } = await db.from('learning_accounts').select('id, full_name, role, email, is_admin, status').eq('id', me.sub).maybeSingle();
      if (!acct || acct.status !== 'approved') return json({ ok: false, error: 'unauthorized' }, 401);
      return json({ ok: true, user: { id: acct.id, name: acct.full_name, role: acct.role, email: acct.email, isAdmin: !!acct.is_admin } });
    }

    if (action === 'registerPush') {
      const sub = body.subscription;
      if (!sub || typeof sub !== 'object' || !sub.endpoint) return json({ ok: false, error: 'bad_request' }, 400);
      await db.from('learning_push').upsert({ endpoint: String(sub.endpoint), subscription: sub, user_id: me.sub }, { onConflict: 'endpoint' });
      return json({ ok: true });
    }

    // ---- admin-only from here ----
    if (!me.admin) return json({ ok: false, error: 'forbidden' }, 403);

    if (action === 'pending') {
      const { data } = await db.from('learning_accounts').select('id, full_name, role, email, national_id, created_at').eq('status', 'pending').order('created_at', { ascending: true });
      return json({ ok: true, pending: data ?? [] });
    }
    if (action === 'list') {
      const { data } = await db.from('learning_accounts').select('id, full_name, role, email, status, is_admin, created_at, approved_at').order('created_at', { ascending: false });
      return json({ ok: true, accounts: data ?? [] });
    }
    if (action === 'approve' || action === 'reject') {
      const id = String(body.id || '');
      if (!id) return json({ ok: false, error: 'bad_request' }, 400);
      const status = action === 'approve' ? 'approved' : 'rejected';
      const { error } = await db.from('learning_accounts')
        .update({ status, approved_by: me.sub, approved_at: new Date().toISOString() })
        .eq('id', id).eq('status', 'pending');
      if (error) return json({ ok: false, error: 'server_error' }, 500);
      return json({ ok: true });
    }

    return json({ ok: false, error: 'unknown_action' }, 400);
  } catch (e) {
    console.error('learn-auth error:', e);
    return json({ ok: false, error: 'server_error' }, 500);
  }
});
