// app-state-gateway: the only path index.html/projects.html use to read or write
// the shared app_state row (all institutes' budgets, salaries, employees, petty
// cash, faults, procurement, messages, etc). Before this existed, the browser
// talked to /rest/v1/app_state directly with the public anon key — anyone who
// knew that key (which is public by design) could read or overwrite the entire
// dataset with a single HTTP request, no login required. This function requires
// a real session token (minted by role-auth on a successful password check) for
// anything beyond the one public, low-sensitivity action.
//
// PER-INSTITUTE ISOLATION (שלב 4ב): the token carries the roleKey it was minted for.
// For an institute-scoped role — institute_<id> (מנהל מכון) or staff_<id> (צוות מכון):
//   * READ returns only that institute's entry inside `institutes` (and only its own
//     general reports), so another institute's budgets/salaries/employees never even
//     reach the browser.
//   * WRITE is merged server-side onto the authoritative blob: the scoped role can
//     replace ONLY its own institute entry and may APPEND to the shared feeds
//     (messages / generalReports / history) — it can never modify or delete another
//     institute, edit/remove others' messages/reports, or change national settings.
// Org-wide roles (national / president / budgetManager / buildingManager) resolve to
// no scope and read/write the whole blob exactly as before.
//
// NOTE: read-scoping and write-merging are deployed together on purpose. A scoped
// read hands the client only its own institute, so if writes still did a full
// replace the client would push a one-institute blob and wipe everyone else — the
// merge below is what makes the scoped read safe.
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

// Verifies a token minted by role-auth's issueToken and returns the decoded payload
// (so callers can read roleKey), or null if missing/forged/expired.
async function verifyToken(token: string): Promise<{ roleKey?: string; exp?: number } | null> {
  if (!TOKEN_SECRET || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  try {
    const valid = await crypto.subtle.verify('HMAC', await hmacKey(), b64urlDecode(sigB64).buffer as ArrayBuffer, new TextEncoder().encode(payloadB64));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)));
    if (typeof payload?.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// The institute a token is confined to, or null for an org-wide role. institute_<id>
// and staff_<id> are the only scoped roles.
function scopeOf(payload: { roleKey?: string } | null): string | null {
  const rk = payload?.roleKey || '';
  if (rk.startsWith('institute_')) return rk.slice('institute_'.length);
  if (rk.startsWith('staff_')) return rk.slice('staff_'.length);
  return null;
}

// ---------------------------------------------------------------------------
// Scoped-write merge. Kept byte-for-byte in sync with the offline-tested module
// scratchpad/scoped_merge.js (28 unit tests incl. attack cases). Start from the
// AUTHORITATIVE server blob and apply only what a scoped role may change.
// ---------------------------------------------------------------------------
function isObj(v: any): boolean { return v && typeof v === 'object' && !Array.isArray(v); }

function appendByKey(serverArr: any, clientArr: any, keyField: string, keepItem?: (it: any) => boolean): any[] {
  const out: any[] = Array.isArray(serverArr) ? serverArr.slice() : [];
  if (!Array.isArray(clientArr)) return out;
  const seen = new Set(out.map((it) => it && it[keyField]));
  for (const it of clientArr) {
    if (!it || typeof it !== 'object') continue;
    const k = it[keyField];
    if (k === undefined || k === null || seen.has(k)) continue;
    if (keepItem && !keepItem(it)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

function appendByEquality(serverArr: any, clientArr: any, keepItem?: (it: any) => boolean): any[] {
  const out: any[] = Array.isArray(serverArr) ? serverArr.slice() : [];
  if (!Array.isArray(clientArr)) return out;
  const sigs = new Set(out.map((it) => JSON.stringify(it)));
  for (const it of clientArr) {
    if (!it || typeof it !== 'object') continue;
    const sig = JSON.stringify(it);
    if (sigs.has(sig)) continue;
    if (keepItem && !keepItem(it)) continue;
    sigs.add(sig);
    out.push(it);
  }
  return out;
}

function appendKeys(serverMap: any, clientMap: any): any {
  const out: any = isObj(serverMap) ? { ...serverMap } : {};
  if (!isObj(clientMap)) return out;
  for (const k of Object.keys(clientMap)) {
    if (!(k in out)) out[k] = clientMap[k];
  }
  return out;
}

function mergePresence(serverP: any, clientP: any): any {
  const out: any = isObj(serverP) ? { ...serverP } : {};
  if (isObj(clientP)) for (const k of Object.keys(clientP)) out[k] = clientP[k];
  return out;
}

function mergeScopedWrite(S: any, C: any, instituteId: string): any {
  const server: any = isObj(S) ? S : {};
  const client: any = isObj(C) ? C : {};
  const R: any = JSON.parse(JSON.stringify(server));

  if (Array.isArray(server.institutes)) {
    const own = Array.isArray(client.institutes)
      ? client.institutes.find((i: any) => i && i.id === instituteId)
      : null;
    if (own && own.id === instituteId) {
      R.institutes = server.institutes.map((i: any) => (i && i.id === instituteId ? own : i));
    } else {
      R.institutes = server.institutes;
    }
  }

  R.messages = appendByKey(server.messages, client.messages, 'id');
  R.generalReports = appendByEquality(server.generalReports, client.generalReports,
    (r: any) => r && r.instituteId === instituteId);
  R.historyEvents = appendByKey(server.historyEvents, client.historyEvents, 'key');
  R.procurementHistoryEvents = appendByKey(server.procurementHistoryEvents, client.procurementHistoryEvents, 'key');
  R.taskJournals = appendKeys(server.taskJournals, client.taskJournals);
  R.threadReadCounts = appendKeys(server.threadReadCounts, client.threadReadCounts);
  R.presence = mergePresence(server.presence, client.presence);

  return R;
}

// A scoped role sees only its own institute (and only its own general reports); every
// other top-level feed is returned unchanged (managers share the chat/reports channel).
function scopeReadData(data: any, scope: string | null): any {
  if (!scope || !isObj(data)) return data;
  const out: any = { ...data };
  if (Array.isArray(data.institutes)) out.institutes = data.institutes.filter((i: any) => i && i.id === scope);
  if (Array.isArray(data.generalReports)) out.generalReports = data.generalReports.filter((r: any) => r && r.instituteId === scope);
  return out;
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
      const payload = await verifyToken(String(body?.token || ''));
      if (!payload) return json({ ok: false, error: 'invalid_token' }, 401);
      const scope = scopeOf(payload);
      const { data } = await supabase.from('app_state').select('data,updated_at').eq('id', 1).maybeSingle();
      const scoped = scopeReadData(data?.data ?? null, scope);
      return json({ ok: true, data: scoped, updated_at: data?.updated_at ?? null });
    }

    if (action === 'write') {
      const payload = await verifyToken(String(body?.token || ''));
      if (!payload) return json({ ok: false, error: 'invalid_token' }, 401);
      const scope = scopeOf(payload);
      const data = body?.data;
      const updatedAt = String(body?.updatedAt || new Date().toISOString());
      if (!data || typeof data !== 'object') return json({ ok: false, error: 'bad_request' }, 400);

      let toWrite = data;
      if (scope) {
        // Merge the scoped role's submission onto the authoritative server blob so it
        // can only ever touch its own institute + append to shared feeds.
        const { data: cur } = await supabase.from('app_state').select('data').eq('id', 1).maybeSingle();
        if (!cur || !cur.data) return json({ ok: true }); // nothing to merge into; a scoped role never seeds
        toWrite = mergeScopedWrite(cur.data, data, scope);
      }

      const { error } = await supabase.from('app_state').update({ data: toWrite, updated_at: updatedAt }).eq('id', 1);
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
