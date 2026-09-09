// learning-gateway: the only path learn.html uses to read or write learning
// data. It is the learning system's counterpart to app-state-gateway, and the
// separation is deliberate:
//
//   * It touches learning_state, learning_submissions, learning_roles and
//     learning_assets — and nothing else. There is no code path in this file
//     that names app_state, role_passwords or any management table, so a bug
//     or a compromise here cannot reach institute operations data.
//   * It trusts a completely different credential. Management sessions are
//     role passwords checked by role-auth and a token signed with
//     AUTH_TOKEN_SECRET. This function does not know that secret and will not
//     accept those tokens. It accepts only a Microsoft Entra ID token from the
//     institute's tenant, verified against Microsoft's published keys.
//
// The two systems share a database server. They share nothing else.
//
// Environment (Supabase project secrets):
//   MS_TENANT_ID   the institute's Entra tenant id — tokens from any other
//                  tenant are refused
//   MS_CLIENT_ID   the app registration's client id — must match the token's
//                  audience, so a token minted for some other application
//                  cannot be replayed here
//
// Deploy with: supabase functions deploy learning-gateway

import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const TENANT = Deno.env.get('MS_TENANT_ID') ?? '';
const CLIENT_ID = Deno.env.get('MS_CLIENT_ID') ?? '';

// service_role is what bypasses RLS; it never leaves this function.
const db = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });

/* -------------------------------------------------- Microsoft token check */

type Claims = { oid: string; email: string; name: string };

let jwksCache: { keys: any[]; at: number } | null = null;

async function jwks(): Promise<any[]> {
  // Microsoft rotates signing keys; an hour-old cache is the documented
  // trade-off between key rotation and hammering the endpoint.
  if (jwksCache && Date.now() - jwksCache.at < 60 * 60 * 1000) return jwksCache.keys;
  const res = await fetch(`https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`);
  if (!res.ok) throw new Error('could not fetch Microsoft signing keys');
  const { keys } = await res.json();
  jwksCache = { keys, at: Date.now() };
  return keys;
}

function b64url(input: string): Uint8Array {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  const bin = atob(input.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function verifyMicrosoftToken(token: string): Promise<Claims | null> {
  if (!TENANT || !CLIENT_ID || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headB64, payloadB64, sigB64] = parts;

  let head: any, payload: any;
  try {
    head = JSON.parse(new TextDecoder().decode(b64url(headB64)));
    payload = JSON.parse(new TextDecoder().decode(b64url(payloadB64)));
  } catch { return null; }

  if (head.alg !== 'RS256') return null;                     // no alg confusion

  const jwk = (await jwks()).find((k) => k.kid === head.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    'jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key,
    b64url(sigB64).buffer as ArrayBuffer,
    new TextEncoder().encode(`${headB64}.${payloadB64}`),
  );
  if (!ok) return null;

  // Signature alone is not enough: the token must be for this application,
  // from this tenant, and still valid.
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== CLIENT_ID) return null;
  if (payload.tid !== TENANT) return null;
  if (typeof payload.exp !== 'number' || payload.exp < now - 60) return null;
  if (typeof payload.nbf === 'number' && payload.nbf > now + 60) return null;
  if (!String(payload.iss || '').includes(TENANT)) return null;
  if (!payload.oid) return null;

  return {
    oid: String(payload.oid),
    email: String(payload.preferred_username ?? payload.email ?? ''),
    name: String(payload.name ?? ''),
  };
}

/* ------------------------------------------------------------ permissions */

async function roleOf(userId: string) {
  const { data } = await db.from('learning_roles').select('role, manager_id, department').eq('user_id', userId).maybeSingle();
  // An account nobody has classified is a learner. Least privilege by default.
  return data ?? { role: 'learner', manager_id: null, department: null };
}

// May `actor` see `target`'s file?
async function mayRead(actorId: string, targetId: string) {
  if (actorId === targetId) return true;
  const actor = await roleOf(actorId);
  if (actor.role === 'coordinator') return true;
  if (actor.role === 'manager') {
    const target = await roleOf(targetId);
    return target.manager_id === actorId;
  }
  return false;
}

/* ------------------------------------------------------------- the routes */

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  if (!TENANT || !CLIENT_ID) {
    return json({ error: 'not configured: set MS_TENANT_ID and MS_CLIENT_ID' }, 503);
  }

  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const me = await verifyMicrosoftToken(bearer);
  if (!me) return json({ error: 'sign in again' }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'bad request' }, 400); }
  const action = String(body?.action ?? '');

  // Keep the learner's identity row current — the name and mail come from the
  // verified token, never from the request body.
  await db.from('learning_state').upsert(
    { user_id: me.oid, email: me.email, display_name: me.name },
    { onConflict: 'user_id', ignoreDuplicates: false },
  );

  switch (action) {

    case 'load': {
      const target = String(body.userId ?? me.oid);
      if (!(await mayRead(me.oid, target))) return json({ error: 'not your file' }, 403);
      const { data } = await db.from('learning_state').select('data, display_name, email').eq('user_id', target).maybeSingle();
      const { data: subs } = await db.from('learning_submissions').select('*').eq('user_id', target);
      return json({ ok: true, state: data?.data ?? {}, submissions: subs ?? [], role: await roleOf(me.oid) });
    }

    case 'save': {
      // A learner saves only their own progress. There is no userId parameter
      // here on purpose — it is always the signed-in person.
      if (typeof body.state !== 'object' || body.state === null) return json({ error: 'bad state' }, 400);
      await db.from('learning_state')
        .update({ data: body.state, updated_at: new Date().toISOString() })
        .eq('user_id', me.oid);
      return json({ ok: true });
    }

    case 'submit': {
      const kind = String(body.kind ?? '');
      const ref = String(body.ref ?? '');
      if (!['chapter', 'final', 'session_quiz'].includes(kind) || !ref) return json({ error: 'bad submission' }, 400);
      await db.from('learning_submissions').upsert({
        user_id: me.oid, kind, ref,
        answers: body.answers ?? [], submitted_at: new Date().toISOString(),
      }, { onConflict: 'user_id,kind,ref' });
      return json({ ok: true });
    }

    case 'feedback': {
      // Only the learner's own manager, or the coordinator, may write back.
      const target = String(body.userId ?? '');
      const actor = await roleOf(me.oid);
      const targetRole = await roleOf(target);
      const allowed = actor.role === 'coordinator' || (actor.role === 'manager' && targetRole.manager_id === me.oid);
      if (!allowed) return json({ error: 'not your team' }, 403);
      await db.from('learning_submissions')
        .update({ feedback: body.feedback ?? [], feedback_by: me.name, feedback_at: new Date().toISOString() })
        .eq('user_id', target).eq('kind', String(body.kind ?? '')).eq('ref', String(body.ref ?? ''));
      return json({ ok: true });
    }

    case 'team': {
      const actor = await roleOf(me.oid);
      if (actor.role === 'learner') return json({ error: 'not a manager' }, 403);
      const q = db.from('learning_roles').select('user_id, role, department');
      if (actor.role === 'manager') q.eq('manager_id', me.oid);
      const { data: members } = await q;
      return json({ ok: true, members: members ?? [] });
    }

    case 'assets': {
      const { data } = await db.from('learning_assets').select('*').order('created_at', { ascending: false }).limit(200);
      return json({ ok: true, assets: data ?? [] });
    }

    case 'addAsset': {
      const title = String(body.title ?? '').trim();
      if (!title) return json({ error: 'a title is required' }, 400);
      await db.from('learning_assets').insert({
        title, topic: body.topic ?? null, kind: body.kind ?? null,
        audience: body.audience ?? null, body: body.body ?? {}, created_by: me.oid,
      });
      return json({ ok: true });
    }

    default:
      return json({ error: 'unknown action' }, 400);
  }
});
