// app-state-gateway: the only path index.html/projects.html use to read or write
// the shared app_state row (all institutes' budgets, salaries, employees, petty
// cash, faults, procurement, messages, etc). Before this existed, the browser
// talked to /rest/v1/app_state directly with the public anon key — anyone who
// knew that key (which is public by design) could read or overwrite the entire
// dataset with a single HTTP request, no login required. This function requires
// a real session token (minted by role-auth on a successful password check) for
// anything beyond the one public, low-sensitivity action.
//
// Deploy with: supabase functions deploy app-state-gateway
// See ../../../SECURITY_FIX_README.md for the full migration + deploy steps.

import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Same secret as role-auth (a project-wide Supabase secret, not one of the
// auto-injected ones) — role-auth mints tokens, this function only verifies them.
const TOKEN_SECRET = Deno.env.get('AUTH_TOKEN_SECRET') || '';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function b64urlDecode(str: string): Uint8Array {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(TOKEN_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
}

// Verifies a token minted by role-auth's issueToken. Doesn't care WHICH roleKey it
// was issued to — every logged-in role is allowed to read/write the shared state
// today, same as the old direct-anon-key behavior; this only closes off callers
// who never logged in at all. Per-role/per-institute scoping is a separate,
// larger follow-up (see SECURITY_FIX_README.md).
async function verifyToken(token: string): Promise<boolean> {
  if (!TOKEN_SECRET || !token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payloadB64, sigB64] = parts;
  try {
    const valid = await crypto.subtle.verify('HMAC', await hmacKey(), b64urlDecode(sigB64).buffer as ArrayBuffer, new TextEncoder().encode(payloadB64));
    if (!valid) return false;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)));
    return typeof payload?.exp === 'number' && payload.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
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
    // No token needed — this is the one thing an as-yet-unauthenticated visitor is
    // meant to see: just institute names/ids, for the login screen's picker. Not the
    // budgets/salaries/employees that live inside each institute.
    if (action === 'publicInstitutes') {
      const { data } = await supabase.from('app_state').select('data').eq('id', 1).maybeSingle();
      const institutes = Array.isArray(data?.data?.institutes) ? data.data.institutes : [];
      return json({ ok: true, institutes: institutes.map((i: any) => ({ id: i?.id, name: i?.name })) });
    }

    if (action === 'read') {
      if (!(await verifyToken(String(body?.token || '')))) return json({ ok: false, error: 'invalid_token' }, 401);
      const { data } = await supabase.from('app_state').select('data,updated_at').eq('id', 1).maybeSingle();
      return json({ ok: true, data: data?.data ?? null, updated_at: data?.updated_at ?? null });
    }

    if (action === 'write') {
      if (!(await verifyToken(String(body?.token || '')))) return json({ ok: false, error: 'invalid_token' }, 401);
      const data = body?.data;
      const updatedAt = String(body?.updatedAt || new Date().toISOString());
      if (!data || typeof data !== 'object') return json({ ok: false, error: 'bad_request' }, 400);
      const { error } = await supabase.from('app_state').update({ data, updated_at: updatedAt }).eq('id', 1);
      if (error) {
        console.error('app-state-gateway write error:', error);
        return json({ ok: false, error: 'server_error' }, 500);
      }
      return json({ ok: true });
    }

    return json({ ok: false, error: 'unknown_action' }, 400);
  } catch (e) {
    console.error('app-state-gateway error:', e);
    return json({ ok: false, error: 'server_error' }, 500);
  }
});
