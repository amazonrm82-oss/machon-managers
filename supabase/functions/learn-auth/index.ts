// learn-auth: the learning system's own email + password sign-in, with admin
// approval. Separate from Microsoft Entra ID and from the management system's
// role-auth. Passwords are salted+hashed here and never leave the server; a new
// account is `pending` until the configured administrator approves it.
//
// Environment (Supabase project secrets):
//   LEARN_TOKEN_SECRET   random string used to sign session tokens (HMAC-SHA256)
//   LEARN_ADMIN_EMAIL    the one address that is the system administrator; that
//                        account is auto-approved and admin, and is exempt from
//                        the @icelp.org.il rule that everyone else must meet.
//
// Deploy with: supabase functions deploy learn-auth

import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const TOKEN_SECRET = Deno.env.get('LEARN_TOKEN_SECRET') || '';
const ADMIN_EMAIL = (Deno.env.get('LEARN_ADMIN_EMAIL') || '').trim().toLowerCase();
const ALLOWED_DOMAIN = '@icelp.org.il';
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
function emailAllowed(email: string): boolean {
  return email.endsWith(ALLOWED_DOMAIN) || (!!ADMIN_EMAIL && email === ADMIN_EMAIL);
}
function randomId(): string {
  return 'usr_' + b64urlFromBytes(crypto.getRandomValues(new Uint8Array(12)));
}

/* ------------------------------------------------------------- admin notify */

// In-app notification is simply the pending list the admin sees on sign-in.
// Phone push, when VAPID is configured, is layered on here later; for now we
// record the intent by keeping the account pending, which the admin's badge
// reflects. (Push delivery is a follow-up — see the deploy notes.)
async function notifyAdminsOfRegistration(_acct: any) { /* in-app badge covers this today */ }

/* ----------------------------------------------------------------- handler */

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
  if (!TOKEN_SECRET) return json({ ok: false, error: 'not_configured' }, 503);

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'bad_request' }, 400); }
  const action = String(body?.action || '');

  try {
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
