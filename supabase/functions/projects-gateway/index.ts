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
// PER-INSTITUTE ISOLATION (שלב 4א): the token carries the roleKey it was minted for.
// For an institute-scoped role — institute_<id> (מנהל מכון) or staff_<id> (צוות מכון) —
// every action here is constrained to that one institute: it can only list, create,
// edit or delete projects/tasks/updates/documents whose project belongs to <id>, and
// cannot create a project in, or move one to, another institute. Org-wide roles
// (national / president / budgetManager / buildingManager) are unconstrained, exactly
// as before. push_subscriptions is per-device, not per-institute, so it is never
// scoped. This closes cross-institute access for the projects tables; the equivalent
// for app_state (budgets/salaries/employees) is a separate step.
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
// HMAC-SHA256 over payloadB64, with an exp claim) and returns the decoded payload
// (so callers can read roleKey), or null if the token is missing/forged/expired.
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

// The institute a token is confined to, or null for an org-wide role that may reach
// every institute. institute_<id> and staff_<id> are the only scoped roles.
function scopeOf(payload: { roleKey?: string } | null): string | null {
  const rk = payload?.roleKey || '';
  if (rk.startsWith('institute_')) return rk.slice('institute_'.length);
  if (rk.startsWith('staff_')) return rk.slice('staff_'.length);
  return null;
}

function rows(data: unknown) {
  return json({ ok: true, rows: Array.isArray(data) ? data : [] });
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// Which institute a given project belongs to (null if it doesn't exist).
async function projectInstitute(id: string): Promise<string | null> {
  if (!id) return null;
  const { data } = await supabase.from('projects').select('institute_id').eq('id', id).maybeSingle();
  return data ? (data.institute_id ?? null) : null;
}

// Which institute the project owning a row in `table` (project_tasks / project_updates
// / project_documents, all of which have a project_id) belongs to.
async function ownerInstitute(table: string, id: string): Promise<string | null> {
  if (!id) return null;
  const { data } = await supabase.from(table).select('project_id').eq('id', id).maybeSingle();
  if (!data) return null;
  return await projectInstitute(str(data.project_id));
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
  const payload = await verifyToken(String(body?.token || ''));
  if (!payload) return json({ ok: false, error: 'invalid_token' }, 401);

  // null => org-wide role (unconstrained); a string => confined to that institute.
  const scope = scopeOf(payload);
  const forbidden = () => json({ ok: false, error: 'forbidden' }, 403);

  try {
    switch (action) {
      // ---- projects ----
      case 'listProjectsByInstitute': {
        // A scoped role may only ever list its own institute, whatever it asked for.
        const instituteId = scope ?? str(body.instituteId);
        const { data, error } = await supabase.from('projects')
          .select(PROJECT_SELECT)
          .eq('institute_id', instituteId)
          .order('created_at', { ascending: false });
        if (error) throw error;
        return rows(data);
      }
      case 'projectCounts': {
        let q = supabase.from('projects').select('institute_id');
        if (scope) q = q.eq('institute_id', scope);
        const { data, error } = await q;
        if (error) throw error;
        return rows(data);
      }
      case 'listProjectsOverview': {
        let q = supabase.from('projects').select(PROJECT_SELECT);
        const instituteId = scope ?? str(body.instituteId);
        if (instituteId) q = q.eq('institute_id', instituteId);
        const { data, error } = await q.order('target_date', { ascending: true, nullsFirst: false });
        if (error) throw error;
        return rows(data);
      }
      case 'insertProject': {
        if (!body?.row || typeof body.row !== 'object') return json({ ok: false, error: 'bad_request' }, 400);
        const row = { ...body.row };
        // A scoped role can only create inside its own institute — force it.
        if (scope) row.institute_id = scope;
        const { error } = await supabase.from('projects').insert(row);
        if (error) throw error;
        return json({ ok: true });
      }
      case 'updateProject': {
        if (!str(body.id) || !body?.patch || typeof body.patch !== 'object') return json({ ok: false, error: 'bad_request' }, 400);
        const patch = { ...body.patch };
        if (scope) {
          if ((await projectInstitute(str(body.id))) !== scope) return forbidden();
          // Never let a scoped role move a project to another institute.
          delete patch.institute_id;
          delete patch.institute_name;
        }
        const { error } = await supabase.from('projects').update(patch).eq('id', str(body.id));
        if (error) throw error;
        return json({ ok: true });
      }
      case 'deleteProject': {
        if (!str(body.id)) return json({ ok: false, error: 'bad_request' }, 400);
        if (scope && (await projectInstitute(str(body.id))) !== scope) return forbidden();
        const { error } = await supabase.from('projects').delete().eq('id', str(body.id));
        if (error) throw error;
        return json({ ok: true });
      }

      // ---- project_tasks ----
      case 'listTasksByProject': {
        if (scope && (await projectInstitute(str(body.projectId))) !== scope) return rows([]);
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
        // Confine a scoped role to tasks whose project is in its own institute.
        const out = scope ? (data || []).filter((t: any) => t?.projects?.institute_id === scope) : data;
        return rows(out);
      }
      case 'insertTask': {
        if (!body?.row || typeof body.row !== 'object') return json({ ok: false, error: 'bad_request' }, 400);
        if (scope && (await projectInstitute(str(body.row.project_id))) !== scope) return forbidden();
        const { error } = await supabase.from('project_tasks').insert(body.row);
        if (error) throw error;
        return json({ ok: true });
      }
      case 'updateTask': {
        if (!str(body.id) || !body?.patch || typeof body.patch !== 'object') return json({ ok: false, error: 'bad_request' }, 400);
        if (scope && (await ownerInstitute('project_tasks', str(body.id))) !== scope) return forbidden();
        const { error } = await supabase.from('project_tasks').update(body.patch).eq('id', str(body.id));
        if (error) throw error;
        return json({ ok: true });
      }
      case 'deleteTask': {
        if (!str(body.id)) return json({ ok: false, error: 'bad_request' }, 400);
        if (scope && (await ownerInstitute('project_tasks', str(body.id))) !== scope) return forbidden();
        const { error } = await supabase.from('project_tasks').delete().eq('id', str(body.id));
        if (error) throw error;
        return json({ ok: true });
      }
      case 'deleteTasksByProject': {
        if (!str(body.projectId)) return json({ ok: false, error: 'bad_request' }, 400);
        if (scope && (await projectInstitute(str(body.projectId))) !== scope) return forbidden();
        const { error } = await supabase.from('project_tasks').delete().eq('project_id', str(body.projectId));
        if (error) throw error;
        return json({ ok: true });
      }

      // ---- project_updates ----
      case 'listUpdatesByProject': {
        if (scope && (await projectInstitute(str(body.projectId))) !== scope) return rows([]);
        const { data, error } = await supabase.from('project_updates')
          .select('*')
          .eq('project_id', str(body.projectId))
          .order('created_at', { ascending: false });
        if (error) throw error;
        return rows(data);
      }
      case 'insertUpdate': {
        if (!body?.row || typeof body.row !== 'object') return json({ ok: false, error: 'bad_request' }, 400);
        if (scope && (await projectInstitute(str(body.row.project_id))) !== scope) return forbidden();
        const { error } = await supabase.from('project_updates').insert(body.row);
        if (error) throw error;
        return json({ ok: true });
      }

      // ---- project_documents ----
      case 'listDocsByProject': {
        if (scope && (await projectInstitute(str(body.projectId))) !== scope) return rows([]);
        const { data, error } = await supabase.from('project_documents')
          .select('*')
          .eq('project_id', str(body.projectId))
          .order('created_at', { ascending: false });
        if (error) throw error;
        return rows(data);
      }
      case 'insertDoc': {
        if (!body?.row || typeof body.row !== 'object') return json({ ok: false, error: 'bad_request' }, 400);
        if (scope && (await projectInstitute(str(body.row.project_id))) !== scope) return forbidden();
        const { error } = await supabase.from('project_documents').insert(body.row);
        if (error) throw error;
        return json({ ok: true });
      }
      case 'deleteDoc': {
        if (!str(body.id)) return json({ ok: false, error: 'bad_request' }, 400);
        if (scope && (await ownerInstitute('project_documents', str(body.id))) !== scope) return forbidden();
        const { error } = await supabase.from('project_documents').delete().eq('id', str(body.id));
        if (error) throw error;
        return json({ ok: true });
      }

      // ---- push_subscriptions (called from index.html) ----
      // Per-device, not per-institute — any logged-in role may register/unregister its
      // own browser's push endpoint, so these are never institute-scoped.
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
