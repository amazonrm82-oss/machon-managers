// app-state-gateway: the only path index.html/projects.html use to read or write
// the shared app_state row (all institutes' budgets, salaries, employees, petty
// cash, faults, procurement, messages, etc). Before this existed, the browser
// talked to /rest/v1/app_state directly with the public anon key — anyone who
// knew that key (which is public by design) could read or overwrite the entire
// dataset with a single HTTP request, no login required. This function requires
// a real session token (minted by role-auth on a successful password check) for
// anything beyond the one public, low-sensitivity action.
//
// PER-INSTITUTE ISOLATION + ROLE PERMISSIONS (שלב 4ב + 4ג): the token carries the
// roleKey it was minted for.
//   * institute_<id> (מנהל מכון): READ returns only that institute (and only its own
//     reports/history). WRITE is merged onto the authoritative blob — it fully
//     controls its own institute entry, manages its own reports/history in place, and
//     appends chat messages; it can never touch another institute, others' feed items,
//     or national settings.
//   * staff_<id> (צוות מכון): same read scope, but WRITE may change ONLY its own
//     institute's pettyCashTransactions (and only while the institute's
//     staffCanEditPettyCash flag is not false), and may append (not edit/delete) its
//     own general reports. Nothing else.
//   * national / president / budgetManager / buildingManager: no scope — read/write the
//     whole blob exactly as before.
//
// Read-scoping and the write-merge ship together on purpose: a scoped read hands the
// client only its own institute, so a full-replace write would wipe everyone else —
// the merge is what makes the scoped read safe. The merge logic is mirrored from
// scoped_merge.reference.js (32 offline unit tests incl. attack + role cases).
//
// Deploy with: supabase functions deploy app-state-gateway
// See ../../../SECURITY_FIX_README.md for the full migration + deploy steps.

import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const TOKEN_SECRET = Deno.env.get('AUTH_TOKEN_SECRET') || '';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
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

// null => org-wide role; otherwise the institute id and whether it's a manager or staff.
function scopeOf(payload: { roleKey?: string } | null): { id: string; role: 'manager' | 'staff' } | null {
  const rk = payload?.roleKey || '';
  if (rk.startsWith('institute_')) return { id: rk.slice('institute_'.length), role: 'manager' };
  if (rk.startsWith('staff_')) return { id: rk.slice('staff_'.length), role: 'staff' };
  return null;
}

// ---------------------------------------------------------------------------
// Scoped-write merge — kept in sync with scoped_merge.reference.js (32 unit tests).
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

// Keep every server item belonging to ANOTHER institute; replace the scope's own slice
// with exactly what the client submitted for its own institute (add/edit/delete-own).
function replaceOwnSlice(serverArr: any, clientArr: any, scope: string): any[] {
  const kept = (Array.isArray(serverArr) ? serverArr : []).filter((it: any) => !it || it.instituteId !== scope);
  const mine = (Array.isArray(clientArr) ? clientArr : []).filter((it: any) => it && it.instituteId === scope);
  return kept.concat(mine);
}

function appendKeys(serverMap: any, clientMap: any): any {
  const out: any = isObj(serverMap) ? { ...serverMap } : {};
  if (!isObj(clientMap)) return out;
  for (const k of Object.keys(clientMap)) if (!(k in out)) out[k] = clientMap[k];
  return out;
}

function mergePresence(serverP: any, clientP: any): any {
  const out: any = isObj(serverP) ? { ...serverP } : {};
  if (isObj(clientP)) for (const k of Object.keys(clientP)) out[k] = clientP[k];
  return out;
}

function mergeOwnInstitute(sOwn: any, cOwn: any, role: string): any {
  if (!sOwn) return sOwn;
  if (!cOwn || cOwn.id !== sOwn.id) return sOwn;
  if (role === 'manager') return cOwn;
  if (sOwn.staffCanEditPettyCash === false) return sOwn;
  const next: any = { ...sOwn };
  if (Array.isArray(cOwn.pettyCashTransactions)) next.pettyCashTransactions = cOwn.pettyCashTransactions;
  return next;
}

function mergeScopedWrite(S: any, C: any, instituteId: string, role: string): any {
  const server: any = isObj(S) ? S : {};
  const client: any = isObj(C) ? C : {};
  const R: any = JSON.parse(JSON.stringify(server));
  const isManager = role === 'manager';

  if (Array.isArray(server.institutes)) {
    const sOwn = server.institutes.find((i: any) => i && i.id === instituteId) || null;
    const cOwn = Array.isArray(client.institutes) ? client.institutes.find((i: any) => i && i.id === instituteId) : null;
    const newOwn = mergeOwnInstitute(sOwn, cOwn, role);
    R.institutes = server.institutes.map((i: any) => (i && i.id === instituteId ? newOwn : i));
  }

  R.messages = appendByKey(server.messages, client.messages, 'id');

  if (isManager) {
    R.generalReports = replaceOwnSlice(server.generalReports, client.generalReports, instituteId);
    R.historyEvents = replaceOwnSlice(server.historyEvents, client.historyEvents, instituteId);
    R.procurementHistoryEvents = replaceOwnSlice(server.procurementHistoryEvents, client.procurementHistoryEvents, instituteId);
  } else {
    R.generalReports = appendByEquality(server.generalReports, client.generalReports, (r: any) => r && r.instituteId === instituteId);
    R.historyEvents = Array.isArray(server.historyEvents) ? server.historyEvents : [];
    R.procurementHistoryEvents = Array.isArray(server.procurementHistoryEvents) ? server.procurementHistoryEvents : [];
  }

  R.taskJournals = appendKeys(server.taskJournals, client.taskJournals);
  R.threadReadCounts = appendKeys(server.threadReadCounts, client.threadReadCounts);
  R.presence = mergePresence(server.presence, client.presence);
  return R;
}

// A scoped role sees only its own institute and only its own reports/history. Every
// other top-level field (chat messages, national settings, etc.) is returned as-is.
function scopeReadData(data: any, scope: { id: string; role: string } | null): any {
  if (!scope || !isObj(data)) return data;
  const id = scope.id;
  const out: any = { ...data };
  if (Array.isArray(data.institutes)) out.institutes = data.institutes.filter((i: any) => i && i.id === id);
  if (Array.isArray(data.generalReports)) out.generalReports = data.generalReports.filter((r: any) => r && r.instituteId === id);
  if (Array.isArray(data.historyEvents)) out.historyEvents = data.historyEvents.filter((h: any) => h && h.instituteId === id);
  if (Array.isArray(data.procurementHistoryEvents)) out.procurementHistoryEvents = data.procurementHistoryEvents.filter((p: any) => p && p.instituteId === id);
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
    // No token needed — just institute names/ids for the login picker.
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
        const { data: cur } = await supabase.from('app_state').select('data').eq('id', 1).maybeSingle();
        if (!cur || !cur.data) return json({ ok: true }); // scoped roles never seed
        toWrite = mergeScopedWrite(cur.data, data, scope.id, scope.role);
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
