// projects-gateway: the only path projects.html (and index.html, for push
// subscriptions) uses to read or write the project-management tables — projects,
// project_tasks, project_updates, project_documents — and push_subscriptions.
//
// Before this existed, the browser talked to /rest/v1/<table> directly with the
// public anon key. Those tables had an "anon can manage ..." policy (COMMAND=ALL),
// so anyone who knew the anon key (which is public by design) could read, change or
// delete every institute's projects, tasks, uploaded documents and push endpoints
// with a single HTTP request, no login required. This is the exact same class of
// hole that app-state-gateway closed for app_state (see SECURITY_FIX_README.md,
// "שלב 3"). This function requires a real session token (minted by role-auth on a
// successful password check) for every action.
//
// Scope note (same as app-state-gateway): this only closes off callers who never
// logged in at all. It does NOT yet enforce that institute manager X can only touch
// institute X's projects — every logged-in role can still reach every row, exactly
// as before. Per-institute scoping is a separate, larger follow-up.
//
// Deploy with: supabase functions deploy projects-gateway
// See ../../../SECURITY_FIX_README.md for the full migration + deploy steps.

import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Same project-wide secret as role-auth/app-state-gateway. role-auth mints tokens,
// this function only verifies them.
const TOKEN_SECRET = Deno.env.get('AUTH_TOKEN_SECRET') || '';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

const PROJECT_SELECT = '*,project_tasks(id,status)';
const MY_TASKS_SELECT = '*,projects(id,name,status,institute_id,institute_name)';

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

// Verifies a token minted by role-auth's issueToken (payloadB64.signatureB64,
// HMAC-SHA256 over payloadB64, with an exp claim). Identical logic to
// app-state-gateway.verifyToken.
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

function rows(data: unknown) {
  return json({ ok: true, rows: Array.isArray(data) ? data : [] });
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
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

  // Every action requires a valid session token — there is no public action here.
  if (!(await verifyToken(String(body?.token || '')))) {
    return json({ ok: false, error: 'invalid_token' }, 401);
  }

  try {
    switch (action) {
      // ---- projects ----
      case 'listProjectsByInstitute': {
        const { data, error } = await supabase.from('projects')
          .select(PROJECT_SELECT)
          .eq('institute_id', str(body.instituteId))
          .order('created_at', { ascending: false });
        if (error) throw error;
        return rows(data);
      }
      case 'projectCounts': {
        const { data, error } = await supabase.from('projects').select('institute_id');
        if (error) throw error;
        return rows(data);
      }
      case 'listProjectsOverview': {
        let q = supabase.from('projects').select(PROJECT_SELECT);
        if (str(body.instituteId)) q = q.eq('institute_id', str(body.instituteId));
        const { data, error } = await q.order('target_date', { ascending: true, nullsFirst: false });
        if (error) throw error;
        return rows(data);
      }
      case 'insertProject': {
        if (!body?.row || typeof body.row !== 'object') return json({ ok: false, error: 'bad_request' }, 400);
        const { error } = await supabase.from('projects').insert(body.row);
        if (error) throw error;
        return json({ ok: true });
      }
      case 'updateProject': {
        if (!str(body.id) || !body?.patch || typeof body.patch !== 'object') return json({ ok: false, error: 'bad_request' }, 400);
        const { error } = await supabase.from('projects').update(body.patch).eq('id', str(body.id));
        if (error) throw error;
        return json({ ok: true });
      }
      case 'deleteProject': {
        if (!str(body.id)) return json({ ok: false, error: 'bad_request' }, 400);
        const { error } = await supabase.from('projects').delete().eq('id', str(body.id));
        if (error) throw error;
        return json({ ok: true });
      }

      // ---- project_tasks ----
      case 'listTasksByProject': {
        const { data, error } = await supabase.from('project_tasks')
          .select('*')
          .eq('project_id', str(body.projectId))
          .order('created_at', { ascending: true });
        if (error) throw error;
        return rows(data);
      }
      case 'tasksByAssignee': {
        const { data, error } = await supabase.from('project_tasks')
          .select(MY_TASKS_SELECT)
          .eq('assignee', str(body.assignee))
          .order('due_date', { ascending: true, nullsFirst: false });
        if (error) throw error;
        return rows(data);
      }
      case 'insertTask': {
        if (!body?.row || typeof body.row !== 'object') return json({ ok: false, error: 'bad_request' }, 400);
        const { error } = await supabase.from('project_tasks').insert(body.row);
        if (error) throw error;
        return json({ ok: true });
      }
      case 'updateTask': {
        if (!str(body.id) || !body?.patch || typeof body.patch !== 'object') return json({ ok: false, error: 'bad_request' }, 400);
        const { error } = await supabase.from('project_tasks').update(body.patch).eq('id', str(body.id));
        if (error) throw error;
        return json({ ok: true });
      }
      case 'deleteTask': {
        if (!str(body.id)) return json({ ok: false, error: 'bad_request' }, 400);
        const { error } = await supabase.from('project_tasks').delete().eq('id', str(body.id));
        if (error) throw error;
        return json({ ok: true });
      }
      case 'deleteTasksByProject': {
        if (!str(body.projectId)) return json({ ok: false, error: 'bad_request' }, 400);
        const { error } = await supabase.from('project_tasks').delete().eq('project_id', str(body.projectId));
        if (error) throw error;
        return json({ ok: true });
      }

      // ---- project_updates ----
      case 'listUpdatesByProject': {
        const { data, error } = await supabase.from('project_updates')
          .select('*')
          .eq('project_id', str(body.projectId))
          .order('created_at', { ascending: false });
        if (error) throw error;
        return rows(data);
      }
      case 'insertUpdate': {
        if (!body?.row || typeof body.row !== 'object') return json({ ok: false, error: 'bad_request' }, 400);
        const { error } = await supabase.from('project_updates').insert(body.row);
        if (error) throw error;
        return json({ ok: true });
      }

      // ---- project_documents ----
      case 'listDocsByProject': {
        const { data, error } = await supabase.from('project_documents')
          .select('*')
          .eq('project_id', str(body.projectId))
          .order('created_at', { ascending: false });
        if (error) throw error;
        return rows(data);
      }
      case 'insertDoc': {
        if (!body?.row || typeof body.row !== 'object') return json({ ok: false, error: 'bad_request' }, 400);
        const { error } = await supabase.from('project_documents').insert(body.row);
        if (error) throw error;
        return json({ ok: true });
      }
      case 'deleteDoc': {
        if (!str(body.id)) return json({ ok: false, error: 'bad_request' }, 400);
        const { error } = await supabase.from('project_documents').delete().eq('id', str(body.id));
        if (error) throw error;
        return json({ ok: true });
      }

      // ---- push_subscriptions (called from index.html) ----
      case 'upsertPushSubscription': {
        if (!body?.row || typeof body.row !== 'object' || !str(body.row.endpoint)) return json({ ok: false, error: 'bad_request' }, 400);
        const { error } = await supabase.from('push_subscriptions').upsert(body.row, { onConflict: 'endpoint' });
        if (error) throw error;
        return json({ ok: true });
      }
      case 'deletePushSubscription': {
        if (!str(body.endpoint)) return json({ ok: false, error: 'bad_request' }, 400);
        const { error } = await supabase.from('push_subscriptions').delete().eq('endpoint', str(body.endpoint));
        if (error) throw error;
        return json({ ok: true });
      }

      default:
        return json({ ok: false, error: 'unknown_action' }, 400);
    }
  } catch (e) {
    console.error('projects-gateway error:', e);
    return json({ ok: false, error: 'server_error' }, 500);
  }
});
