// role-auth: the ONLY place in this project that ever reads or writes a real
// password value. index.html and projects.html call this over HTTPS with the
// public anon key (which only authorizes *calling* the function — it carries
// no password data) and get back a plain {ok: boolean} — never the password
// itself. This function is the one piece of code allowed to use the
// service_role key, which is what actually bypasses RLS on role_passwords /
// role_auth_lockout.
//
// Deploy with: supabase functions deploy role-auth
// See ../../../SECURITY_FIX_README.md for the full migration + deploy steps.

import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  // Supabase injects this automatically into every Edge Function — never the anon key.
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

// Constant-time-ish string compare — a plain `===` short-circuits on the first
// differing byte, which leaks a tiny timing signal about how many leading
// characters were guessed correctly. Not the biggest risk in this system (the
// lockout below matters far more) but cheap to close.
function safeEqual(a: string, b: string): boolean {
  const bufA = new TextEncoder().encode(a);
  const bufB = new TextEncoder().encode(b);
  if (bufA.length !== bufB.length) {
    // Still walk a same-length buffer so the branch above isn't a distinguishing
    // timing signal by itself for near-miss lengths.
    let diff = 0;
    for (let i = 0; i < bufA.length; i++) diff |= bufA[i] ^ (bufB[i % bufB.length] || 0);
    return false;
  }
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) diff |= bufA[i] ^ bufB[i];
  return diff === 0;
}

async function isLocked(lockKey: string): Promise<boolean> {
  const { data } = await supabase
    .from('role_auth_lockout')
    .select('locked_until')
    .eq('role_key', lockKey)
    .maybeSingle();
  return !!data?.locked_until && new Date(data.locked_until).getTime() > Date.now();
}

async function recordAttempt(lockKey: string, success: boolean): Promise<void> {
  if (success) {
    await supabase.from('role_auth_lockout').delete().eq('role_key', lockKey);
    return;
  }
  const { data } = await supabase
    .from('role_auth_lockout')
    .select('failed_count')
    .eq('role_key', lockKey)
    .maybeSingle();
  const nextCount = (data?.failed_count || 0) + 1;
  if (nextCount >= MAX_ATTEMPTS) {
    await supabase.from('role_auth_lockout').upsert({
      role_key: lockKey,
      failed_count: 0,
      locked_until: new Date(Date.now() + LOCKOUT_MS).toISOString(),
    });
  } else {
    await supabase.from('role_auth_lockout').upsert({ role_key: lockKey, failed_count: nextCount, locked_until: null });
  }
}

// Verifies `password` against the real stored value for `roleKey`. Every caller
// below that needs to authorize an action funnels through this so lockout is
// applied uniformly, whether it's a login attempt or someone re-proving their
// password to authorize a write.
async function verifyAgainstStore(roleKey: string, password: string): Promise<{ ok: boolean; locked?: boolean }> {
  if (await isLocked(roleKey)) return { ok: false, locked: true };
  const { data } = await supabase.from('role_passwords').select('password').eq('role_key', roleKey).maybeSingle();
  const actual = data?.password;
  const ok = typeof actual === 'string' && actual.length > 0 && safeEqual(String(password || ''), actual);
  await recordAttempt(roleKey, ok);
  return { ok };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'bad_request' }, 400);
  }

  const action = body?.action;

  try {
    if (action === 'status') {
      const { data } = await supabase.from('role_passwords').select('role_key').eq('role_key', 'nationalRecoveryCode').maybeSingle();
      return json({ ok: true, hasRecoveryCode: !!data });
    }

    if (action === 'verify') {
      const roleKey = String(body?.roleKey || '');
      if (!roleKey) return json({ ok: false, error: 'bad_request' }, 400);
      const result = await verifyAgainstStore(roleKey, String(body?.password || ''));
      return json(result);
    }

    if (action === 'setPassword') {
      const roleKey = String(body?.roleKey || '');
      const newPassword = String(body?.newPassword || '');
      const authRoleKey = String(body?.authRoleKey || '');
      const authPassword = String(body?.authPassword || '');
      if (!roleKey || !newPassword || !authRoleKey) return json({ ok: false, error: 'bad_request' }, 400);
      // Admin override (national can set anyone's password) or self-service
      // (a role changing its own password) — nothing else is a valid combination.
      const isAdminOverride = authRoleKey === 'national' && roleKey !== 'national';
      const isSelfService = authRoleKey === roleKey;
      if (!isAdminOverride && !isSelfService) return json({ ok: false, error: 'forbidden' }, 403);
      const auth = await verifyAgainstStore(authRoleKey, authPassword);
      if (!auth.ok) return json(auth);
      await supabase.from('role_passwords').upsert({ role_key: roleKey, password: newPassword, updated_at: new Date().toISOString() });
      return json({ ok: true });
    }

    if (action === 'deletePasswords') {
      const roleKeys = Array.isArray(body?.roleKeys) ? body.roleKeys.map(String) : [];
      const authPassword = String(body?.authPassword || '');
      if (!roleKeys.length) return json({ ok: true }); // nothing to do
      const auth = await verifyAgainstStore('national', authPassword);
      if (!auth.ok) return json(auth);
      await supabase.from('role_passwords').delete().in('role_key', roleKeys);
      return json({ ok: true });
    }

    if (action === 'setRecoveryCode') {
      const newRecoveryCode = String(body?.newRecoveryCode || '');
      const authPassword = String(body?.authPassword || '');
      if (!newRecoveryCode) return json({ ok: false, error: 'bad_request' }, 400);
      const auth = await verifyAgainstStore('national', authPassword);
      if (!auth.ok) return json(auth);
      await supabase.from('role_passwords').upsert({ role_key: 'nationalRecoveryCode', password: newRecoveryCode, updated_at: new Date().toISOString() });
      return json({ ok: true });
    }

    if (action === 'recoverNational') {
      const recoveryCode = String(body?.recoveryCode || '');
      const newPassword = String(body?.newPassword || '');
      if (!newPassword) return json({ ok: false, error: 'bad_request' }, 400);
      const { data } = await supabase.from('role_passwords').select('role_key').eq('role_key', 'nationalRecoveryCode').maybeSingle();
      if (!data) return json({ ok: false, error: 'no_recovery_code' });
      const result = await verifyAgainstStore('nationalRecoveryCode', recoveryCode);
      if (!result.ok) return json(result);
      await supabase.from('role_passwords').upsert({ role_key: 'national', password: newPassword, updated_at: new Date().toISOString() });
      return json({ ok: true });
    }

    return json({ ok: false, error: 'unknown_action' }, 400);
  } catch (e) {
    console.error('role-auth error:', e);
    return json({ ok: false, error: 'server_error' }, 500);
  }
});
