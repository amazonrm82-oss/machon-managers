// learning-gateway: the only path learn.html uses to read or write learning
// data. It is the learning system's counterpart to app-state-gateway, and the
// separation is deliberate:
//
//   * It touches learning_state, learning_submissions, learning_roles,
//     learning_assets, learning_content, learning_session_registrations,
//     learning_chapter_managers and (read-only, for the admin's assignment
//     screen) learning_accounts — and nothing else. There is no code path in
//     this file that names app_state, role_passwords or any management
//     table, so a bug or a compromise here cannot reach institute operations
//     data.
//   * It trusts credentials the management system does not know. Two are
//     accepted, both scoped to the learning system only:
//       - a Microsoft Entra ID token from the institute's tenant, verified
//         against Microsoft's published keys (kept for when Entra sign-in is
//         switched on);
//       - the learn-auth session token (HMAC-signed with LEARN_TOKEN_SECRET,
//         the same secret learn-auth itself uses), which is what real users
//         sign in with today.
//     Management sessions are role passwords checked by role-auth and a
//     token signed with AUTH_TOKEN_SECRET — a completely different secret
//     this function does not know and will not accept.
//
// The two systems (learning vs. management) share a database server. They
// share nothing else.
//
// Administration: matanz@icelp.org.il (ROOT_ADMIN_EMAIL below) always has
// full admin power — hard-coded, never revocable through this API, so there
// is always one way in. Any approved account may be granted the same power
// via learning_accounts.is_admin, toggled only by an existing admin (see
// learn-auth's 'setAdmin' action). An admin may edit shared content
// (curriculum, sessions), assign mentors/chapter managers, list a session's
// registrants, and grant/revoke admin on other accounts.
//
// Environment (Supabase project secrets):
//   MS_TENANT_ID        the institute's Entra tenant id (Microsoft path)
//   MS_CLIENT_ID        the app registration's client id (Microsoft path)
//   LEARN_TOKEN_SECRET  same secret learn-auth signs session tokens with
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
const LEARN_TOKEN_SECRET = Deno.env.get('LEARN_TOKEN_SECRET') ?? '';

// service_role is what bypasses RLS; it never leaves this function.
const db = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });

/* -------------------------------------------------- Microsoft token check */

type Identity = { id: string; email: string; name: string };

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

async function verifyMicrosoftToken(token: string): Promise<Identity | null> {
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
    id: String(payload.oid),
    email: String(payload.preferred_username ?? payload.email ?? ''),
    name: String(payload.name ?? ''),
  };
}

/* ---------------------------------------------- learn-auth (password) check
   Mirrors issueToken/verifyToken in supabase/functions/learn-auth/index.ts.
   Same secret, same two-part `payload.sig` shape — deliberately NOT the
   three-part JWT shape Microsoft tokens use, so the two never collide. */

function bytesFromB64url(str: string): Uint8Array {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function hmacKey() {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(LEARN_TOKEN_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
}
async function verifyLearnAuthToken(token: string): Promise<Identity | null> {
  if (!LEARN_TOKEN_SECRET || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(), bytesFromB64url(parts[1]).buffer as ArrayBuffer, new TextEncoder().encode(parts[0]));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(bytesFromB64url(parts[0])));
    if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    if (!payload.sub) return null;
    return { id: String(payload.sub), email: String(payload.email ?? ''), name: String(payload.name ?? '') };
  } catch { return null; }
}

// Try Microsoft first (three-part JWT), then learn-auth (two-part token).
// Whichever verifies wins; if neither does, the caller is not signed in.
async function identify(token: string): Promise<Identity | null> {
  if (!token) return null;
  const parts = token.split('.').length;
  if (parts === 3) return (await verifyMicrosoftToken(token)) ?? (await verifyLearnAuthToken(token));
  if (parts === 2) return (await verifyLearnAuthToken(token)) ?? (await verifyMicrosoftToken(token));
  return null;
}

// The learning system administrator(s): matanz@icelp.org.il always has full
// admin power — a hard-coded constant, never revocable through this API, so
// there is always at least one way in. Any account may be granted the same
// power via learning_accounts.is_admin (toggled through learn-auth's
// 'setAdmin' action, itself restricted to an existing admin) — once granted,
// that person can do everything matanz can: edit shared content, assign
// mentors/chapter managers, see session registrants, grant/revoke admin on
// others.
const ROOT_ADMIN_EMAIL = 'matanz@icelp.org.il';

async function isAdmin(identity: Identity): Promise<boolean> {
  if (String(identity.email || '').trim().toLowerCase() === ROOT_ADMIN_EMAIL) return true;
  const { data } = await db.from('learning_accounts').select('is_admin').eq('id', identity.id).maybeSingle();
  return !!data?.is_admin;
}


/* ------------------------------------------------------------ permissions */

async function roleOf(userId: string) {
  const { data } = await db.from('learning_roles').select('role, manager_id, department').eq('user_id', userId).maybeSingle();
  // An account nobody has classified is a learner. Least privilege by default.
  return data ?? { role: 'learner', manager_id: null, department: null };
}

async function isChapterManagerFor(userId: string, chapterRef: string): Promise<boolean> {
  if (!chapterRef) return false;
  const { data } = await db.from('learning_chapter_managers').select('user_id').eq('user_id', userId).eq('chapter_ref', chapterRef).maybeSingle();
  return !!data;
}

// A learner's cohort ("תקופה") — the group whose start date their 90-day
// track is counted from. If somehow enrolled in more than one, the most
// recently started cohort wins; that should not normally happen since
// setCohortMembers replaces a cohort's whole roster rather than adding to it.
async function cohortOf(userId: string): Promise<{ id: string; name: string; startDate: string; endDate: string | null } | null> {
  const { data } = await db.from('learning_cohort_members')
    .select('cohort_id, learning_cohorts(id, name, start_date, end_date)')
    .eq('user_id', userId);
  const rows = (data ?? []).map((r: any) => r.learning_cohorts).filter(Boolean);
  if (!rows.length) return null;
  rows.sort((a: any, b: any) => String(b.start_date).localeCompare(String(a.start_date)));
  const c = rows[0];
  return { id: c.id, name: c.name, startDate: c.start_date, endDate: c.end_date ?? null };
}

// May `actor` see `target`'s file? (whole-file access — the team list, the
// learner's own submissions overview). Chapter-scoped access is separate,
// see isChapterManagerFor / the 'chapterRoster' action. `actorIsAdmin` is
// passed in already resolved (once per request) rather than re-derived here.
async function mayRead(actorId: string, actorIsAdmin: boolean, targetId: string) {
  if (actorId === targetId) return true;
  if (actorIsAdmin) return true;
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

  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const me = await identify(bearer);
  if (!me) return json({ error: 'sign in again' }, 401);
  const admin = await isAdmin(me);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'bad request' }, 400); }
  const action = String(body?.action ?? '');

  // Keep the learner's identity row current — the name and mail come from the
  // verified token, never from the request body. Works the same regardless
  // of which credential (Microsoft or learn-auth) verified them.
  const { error: identityErr } = await db.from('learning_state').upsert(
    { user_id: me.id, email: me.email, display_name: me.name },
    { onConflict: 'user_id', ignoreDuplicates: false },
  );
  if (identityErr) {
    console.error('learning_state identity upsert failed:', identityErr);
    return json({ error: 'server error (identity)', detail: identityErr.message }, 500);
  }

  switch (action) {

    case 'load': {
      const target = String(body.userId ?? me.id);
      if (!(await mayRead(me.id, admin, target))) return json({ error: 'not your file' }, 403);
      const { data } = await db.from('learning_state').select('data, display_name, email').eq('user_id', target).maybeSingle();
      const { data: subs } = await db.from('learning_submissions').select('*').eq('user_id', target);
      const { data: attendance } = await db.from('learning_topic_attendance').select('chapter_ref, topic_index, marked_by, marked_at').eq('user_id', target);
      const cohort = await cohortOf(target);
      // Which chapters (if any) the caller themself manages — only meaningful
      // for the caller's own load (target may be someone else's, e.g. an
      // admin browsing a learner's file, where it is simply omitted).
      let chapterManagerOf: string[] = [];
      let sessionRegistrations: string[] = [];
      if (target === me.id) {
        const { data: cm } = await db.from('learning_chapter_managers').select('chapter_ref').eq('user_id', me.id);
        chapterManagerOf = (cm ?? []).map((r: any) => r.chapter_ref);
        const { data: regs } = await db.from('learning_session_registrations').select('session_ref').eq('user_id', me.id);
        sessionRegistrations = (regs ?? []).map((r: any) => r.session_ref);
      }
      return json({ ok: true, state: data?.data ?? {}, submissions: subs ?? [], attendance: attendance ?? [], cohort, role: await roleOf(me.id), isAdmin: admin, chapterManagerOf, sessionRegistrations });
    }

    case 'save': {
      // A learner saves only their own progress. There is no userId parameter
      // here on purpose — it is always the signed-in person. Upsert, not a
      // bare update: the row is guaranteed to exist (identity upsert above
      // already checked for an error), but upsert is the robust choice
      // regardless of ordering.
      if (typeof body.state !== 'object' || body.state === null) return json({ error: 'bad state' }, 400);
      const { error } = await db.from('learning_state')
        .upsert({ user_id: me.id, email: me.email, display_name: me.name, data: body.state, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
      if (error) { console.error('save failed:', error); return json({ error: 'server error', detail: error.message }, 500); }
      return json({ ok: true });
    }

    case 'submit': {
      const kind = String(body.kind ?? '');
      const ref = String(body.ref ?? '');
      if (!['chapter', 'final', 'session_quiz'].includes(kind) || !ref) return json({ error: 'bad submission' }, 400);
      const { error } = await db.from('learning_submissions').upsert({
        user_id: me.id, kind, ref,
        answers: body.answers ?? [], submitted_at: new Date().toISOString(),
      }, { onConflict: 'user_id,kind,ref' });
      if (error) { console.error('submit failed:', error); return json({ error: 'server error', detail: error.message }, 500); }
      return json({ ok: true });
    }

    case 'feedback': {
      // Only the learner's own mentor, the chapter's chapter-manager, the
      // coordinator, or the administrator may write back — and only once.
      // A grade that already carries feedback_by/feedback_at is final: no
      // route in this file updates those columns a second time.
      const target = String(body.userId ?? '');
      const kind = String(body.kind ?? '');
      const ref = String(body.ref ?? '');
      if (!target || !kind || !ref) return json({ error: 'bad request' }, 400);
      const actor = await roleOf(me.id);
      const targetRole = await roleOf(target);
      const allowed = admin
        || actor.role === 'coordinator'
        || (actor.role === 'manager' && targetRole.manager_id === me.id)
        || (kind === 'chapter' && await isChapterManagerFor(me.id, ref));
      if (!allowed) return json({ error: 'not your team' }, 403);

      const { data: existing } = await db.from('learning_submissions')
        .select('feedback_by, feedback_at')
        .eq('user_id', target).eq('kind', kind).eq('ref', ref).maybeSingle();
      if (existing?.feedback_by) {
        return json({ error: 'already graded', feedbackBy: existing.feedback_by, feedbackAt: existing.feedback_at }, 409);
      }

      const { error } = await db.from('learning_submissions')
        .update({ feedback: body.feedback ?? [], feedback_by: me.name || me.email, feedback_at: new Date().toISOString() })
        .eq('user_id', target).eq('kind', kind).eq('ref', ref).is('feedback_by', null);
      if (error) { console.error('db write failed:', error); return json({ error: 'server error', detail: error.message }, 500); }
      return json({ ok: true });
    }

    case 'submission': {
      // The one submission a grader needs to actually read to grade it —
      // load() cannot serve this to a chapter manager (mayRead does not know
      // about chapter grants), so this uses the exact same allow-check as
      // 'feedback' itself: whoever may grade this submission may read it.
      const target = String(body.userId ?? '');
      const kind = String(body.kind ?? '');
      const ref = String(body.ref ?? '');
      if (!target || !kind || !ref) return json({ error: 'bad request' }, 400);
      const actor = await roleOf(me.id);
      const targetRole = await roleOf(target);
      const allowed = admin
        || actor.role === 'coordinator'
        || (actor.role === 'manager' && targetRole.manager_id === me.id)
        || (kind === 'chapter' && await isChapterManagerFor(me.id, ref));
      if (!allowed) return json({ error: 'not your team' }, 403);
      const { data } = await db.from('learning_submissions').select('*').eq('user_id', target).eq('kind', kind).eq('ref', ref).maybeSingle();
      if (!data) return json({ error: 'no submission' }, 404);
      return json({ ok: true, submission: data });
    }

    case 'team': {
      const actor = await roleOf(me.id);
      const chapterRef = body.chapterRef ? String(body.chapterRef) : '';

      // A chapter roster: every approved learner's status for one specific
      // chapter — submission, grade, and per-topic attendance — visible to
      // that chapter's manager (or the coordinator/admin), regardless of who
      // each learner's ordinary mentor is. Lists every approved learner, not
      // just those who already submitted the exam, since attendance is
      // marked during the chapter, before any exam is handed in.
      if (chapterRef) {
        const canSeeChapter = admin || actor.role === 'coordinator' || (await isChapterManagerFor(me.id, chapterRef));
        if (!canSeeChapter) return json({ error: 'not your chapter' }, 403);
        const { data: accounts } = await db.from('learning_accounts').select('id, full_name, email').eq('status', 'approved');
        const { data: subs } = await db.from('learning_submissions').select('user_id, submitted_at, feedback_by, feedback_at').eq('kind', 'chapter').eq('ref', chapterRef);
        const { data: marks } = await db.from('learning_topic_attendance').select('user_id, topic_index').eq('chapter_ref', chapterRef);
        const subByUser: Record<string, any> = {};
        (subs ?? []).forEach((s: any) => { subByUser[s.user_id] = s; });
        const attByUser: Record<string, number[]> = {};
        (marks ?? []).forEach((m: any) => { (attByUser[m.user_id] ??= []).push(m.topic_index); });
        const roster = (accounts ?? []).map((a: any) => {
          const s = subByUser[a.id];
          return {
            userId: a.id, name: a.full_name || a.email,
            submittedAt: s?.submitted_at ?? null, graded: !!s?.feedback_by, feedbackBy: s?.feedback_by ?? null, feedbackAt: s?.feedback_at ?? null,
            attendance: (attByUser[a.id] ?? []).sort((x: number, y: number) => x - y),
          };
        });
        return json({ ok: true, chapterRef, roster });
      }

      if (actor.role === 'learner' && !admin) return json({ error: 'not a manager' }, 403);
      const q = db.from('learning_roles').select('user_id, role, department');
      if (actor.role === 'manager' && !admin) q.eq('manager_id', me.id);
      const { data: members } = await q;
      const ids = (members ?? []).map((m: any) => m.user_id);
      const { data: people } = ids.length ? await db.from('learning_state').select('user_id, display_name, email').in('user_id', ids) : { data: [] };
      // Real per-learner status: how many chapter/final exams they have
      // handed in, and how many of those are still waiting on a grade —
      // this is the "status + exams" a mentor/coordinator actually needs.
      const { data: subs } = ids.length ? await db.from('learning_submissions').select('user_id, kind, ref, feedback_by, submitted_at').in('user_id', ids).in('kind', ['chapter', 'final']) : { data: [] };
      const byId: Record<string, any> = {};
      (people ?? []).forEach((p: any) => { byId[p.user_id] = p; });
      const subsByUser: Record<string, any[]> = {};
      (subs ?? []).forEach((s: any) => { (subsByUser[s.user_id] ??= []).push(s); });
      return json({
        ok: true,
        members: (members ?? []).map((m: any) => {
          const mySubs = subsByUser[m.user_id] ?? [];
          const pendingList = mySubs.filter((s: any) => !s.feedback_by).map((s: any) => ({ kind: s.kind, ref: s.ref, submittedAt: s.submitted_at }));
          return {
            ...m, name: byId[m.user_id]?.display_name || byId[m.user_id]?.email || m.user_id,
            submitted: mySubs.length, graded: mySubs.length - pendingList.length, pending: pendingList.length, pendingList,
          };
        }),
      });
    }

    case 'markTopicAttendance': {
      // Never self-reported: only the learner's mentor, that chapter's
      // chapter-manager, the coordinator, or the administrator may mark it —
      // it represents attendance the supervisor themself observed.
      const learnerId = String(body.learnerId ?? '');
      const chapterRef = String(body.chapterRef ?? '');
      const topicIndex = Number(body.topicIndex);
      if (!learnerId || !chapterRef || !Number.isInteger(topicIndex) || topicIndex < 0) return json({ error: 'bad request' }, 400);
      const actor = await roleOf(me.id);
      const learnerRole = await roleOf(learnerId);
      const allowed = admin
        || actor.role === 'coordinator'
        || (actor.role === 'manager' && learnerRole.manager_id === me.id)
        || (await isChapterManagerFor(me.id, chapterRef));
      if (!allowed) return json({ error: 'not your student' }, 403);

      const attResult = body.present === false
        ? await db.from('learning_topic_attendance').delete().eq('user_id', learnerId).eq('chapter_ref', chapterRef).eq('topic_index', topicIndex)
        : await db.from('learning_topic_attendance').upsert(
          { user_id: learnerId, chapter_ref: chapterRef, topic_index: topicIndex, marked_by: me.name || me.email },
          { onConflict: 'user_id,chapter_ref,topic_index' },
        );
      if (attResult.error) { console.error('markTopicAttendance failed:', attResult.error); return json({ error: 'server error', detail: attResult.error.message }, 500); }
      return json({ ok: true });
    }

    case 'assets': {
      const { data } = await db.from('learning_assets').select('*').order('created_at', { ascending: false }).limit(200);
      return json({ ok: true, assets: data ?? [] });
    }

    case 'addAsset': {
      const title = String(body.title ?? '').trim();
      if (!title) return json({ error: 'a title is required' }, 400);
      const { error } = await db.from('learning_assets').insert({
        title, topic: body.topic ?? null, kind: body.kind ?? null,
        audience: body.audience ?? null, body: body.body ?? {}, created_by: me.id,
      });
      if (error) { console.error('addAsset failed:', error); return json({ error: 'server error', detail: error.message }, 500); }
      return json({ ok: true });
    }

    /* ------------------------------------------------------ shared content
       Curriculum + enrichment-session schedule: one row, everyone reads it,
       only the administrator writes it. */

    case 'content': {
      const { data } = await db.from('learning_content').select('curriculum, sessions, updated_at').eq('id', 1).maybeSingle();
      return json({ ok: true, curriculum: data?.curriculum ?? null, sessions: data?.sessions ?? null, updatedAt: data?.updated_at ?? null });
    }

    case 'saveContent': {
      if (!admin) return json({ error: 'administrators only' }, 403);
      if (body.curriculum === undefined && body.sessions === undefined) return json({ error: 'nothing to save' }, 400);
      const { data: existing } = await db.from('learning_content').select('curriculum, sessions').eq('id', 1).maybeSingle();
      const patch: Record<string, unknown> = {
        id: 1,
        curriculum: body.curriculum !== undefined ? body.curriculum : (existing?.curriculum ?? {}),
        sessions: body.sessions !== undefined ? body.sessions : (existing?.sessions ?? []),
        updated_by: me.email, updated_at: new Date().toISOString(),
      };
      const { error } = await db.from('learning_content').upsert(patch, { onConflict: 'id' });
      if (error) { console.error('db write failed:', error); return json({ error: 'server error', detail: error.message }, 500); }
      return json({ ok: true });
    }

    /* --------------------------------------------------- session sign-up */

    case 'registerSession': {
      const ref = String(body.ref ?? '');
      if (!ref) return json({ error: 'bad request' }, 400);
      const { error } = await db.from('learning_session_registrations').upsert(
        { user_id: me.id, session_ref: ref },
        { onConflict: 'user_id,session_ref', ignoreDuplicates: true },
      );
      if (error) { console.error('registerSession failed:', error); return json({ error: 'server error', detail: error.message }, 500); }
      return json({ ok: true });
    }

    case 'sessionRegistrants': {
      if (!admin) return json({ error: 'administrators only' }, 403);
      const ref = String(body.ref ?? '');
      if (!ref) return json({ error: 'bad request' }, 400);
      const { data: regs } = await db.from('learning_session_registrations').select('user_id, registered_at').eq('session_ref', ref).order('registered_at', { ascending: true });
      const ids = (regs ?? []).map((r: any) => r.user_id);
      const { data: people } = ids.length ? await db.from('learning_state').select('user_id, display_name, email').in('user_id', ids) : { data: [] };
      const byId: Record<string, any> = {};
      (people ?? []).forEach((p: any) => { byId[p.user_id] = p; });
      const registrants = (regs ?? []).map((r: any) => ({
        userId: r.user_id, name: byId[r.user_id]?.display_name || byId[r.user_id]?.email || r.user_id, registeredAt: r.registered_at,
      }));
      return json({ ok: true, ref, registrants });
    }

    /* --------------------------------------------------- administration
       Everything below is restricted to ADMIN_EMAIL. */

    case 'people': {
      if (!admin) return json({ error: 'administrators only' }, 403);
      const { data: accounts } = await db.from('learning_accounts').select('id, full_name, email, status, is_admin').eq('status', 'approved');
      const { data: roles } = await db.from('learning_roles').select('user_id, role, manager_id, department');
      const { data: chapterMgrs } = await db.from('learning_chapter_managers').select('user_id, chapter_ref');
      const roleById: Record<string, any> = {};
      (roles ?? []).forEach((r: any) => { roleById[r.user_id] = r; });
      const chaptersById: Record<string, string[]> = {};
      (chapterMgrs ?? []).forEach((c: any) => { (chaptersById[c.user_id] ??= []).push(c.chapter_ref); });
      const people = (accounts ?? []).map((a: any) => ({
        id: a.id, name: a.full_name, email: a.email, isAdmin: !!a.is_admin || a.email?.trim().toLowerCase() === ROOT_ADMIN_EMAIL,
        isRoot: a.email?.trim().toLowerCase() === ROOT_ADMIN_EMAIL,
        role: roleById[a.id]?.role ?? 'learner',
        managerId: roleById[a.id]?.manager_id ?? null,
        chapterRefs: chaptersById[a.id] ?? [],
      }));
      return json({ ok: true, people });
    }

    case 'assignMentor': {
      if (!admin) return json({ error: 'administrators only' }, 403);
      const learnerId = String(body.learnerId ?? '');
      const mentorId = String(body.mentorId ?? '');
      if (!learnerId || !mentorId) return json({ error: 'bad request' }, 400);
      // The mentor must be at least 'manager' to be visible as one; never
      // downgrade an existing coordinator.
      const mentorRole = await roleOf(mentorId);
      if (mentorRole.role === 'learner') {
        const { error: e1 } = await db.from('learning_roles').upsert({ user_id: mentorId, role: 'manager' }, { onConflict: 'user_id' });
        if (e1) { console.error('assignMentor (promote) failed:', e1); return json({ error: 'server error', detail: e1.message }, 500); }
      }
      const { error: e2 } = await db.from('learning_roles').upsert({ user_id: learnerId, manager_id: mentorId }, { onConflict: 'user_id' });
      if (e2) { console.error('assignMentor failed:', e2); return json({ error: 'server error', detail: e2.message }, 500); }
      return json({ ok: true });
    }

    case 'unassignMentor': {
      if (!admin) return json({ error: 'administrators only' }, 403);
      const learnerId = String(body.learnerId ?? '');
      if (!learnerId) return json({ error: 'bad request' }, 400);
      const { error } = await db.from('learning_roles').upsert({ user_id: learnerId, manager_id: null }, { onConflict: 'user_id' });
      if (error) { console.error('unassignMentor failed:', error); return json({ error: 'server error', detail: error.message }, 500); }
      return json({ ok: true });
    }

    case 'assignChapterManager': {
      if (!admin) return json({ error: 'administrators only' }, 403);
      const userId = String(body.userId ?? '');
      const chapterRef = String(body.chapterRef ?? '');
      if (!userId || !chapterRef) return json({ error: 'bad request' }, 400);
      const { error } = await db.from('learning_chapter_managers').upsert(
        { user_id: userId, chapter_ref: chapterRef, assigned_by: me.email },
        { onConflict: 'user_id,chapter_ref' },
      );
      if (error) { console.error('assignChapterManager failed:', error); return json({ error: 'server error', detail: error.message }, 500); }
      return json({ ok: true });
    }

    case 'removeChapterManager': {
      if (!admin) return json({ error: 'administrators only' }, 403);
      const userId = String(body.userId ?? '');
      const chapterRef = String(body.chapterRef ?? '');
      if (!userId || !chapterRef) return json({ error: 'bad request' }, 400);
      const { error } = await db.from('learning_chapter_managers').delete().eq('user_id', userId).eq('chapter_ref', chapterRef);
      if (error) { console.error('removeChapterManager failed:', error); return json({ error: 'server error', detail: error.message }, 500); }
      return json({ ok: true });
    }

    /* ------------------------------------------------------------ cohorts
       A cohort ("תקופה") is a group of learners moving through the track
       together, on their own start date. Several may run at once. */

    case 'cohorts': {
      if (!admin) return json({ error: 'administrators only' }, 403);
      const { data: cohorts } = await db.from('learning_cohorts').select('id, name, start_date, end_date').order('start_date', { ascending: false });
      const { data: members } = await db.from('learning_cohort_members').select('cohort_id, user_id');
      const counts: Record<string, number> = {};
      (members ?? []).forEach((m: any) => { counts[m.cohort_id] = (counts[m.cohort_id] ?? 0) + 1; });
      return json({ ok: true, cohorts: (cohorts ?? []).map((c: any) => ({ id: c.id, name: c.name, startDate: c.start_date, endDate: c.end_date, memberCount: counts[c.id] ?? 0 })) });
    }

    case 'saveCohort': {
      if (!admin) return json({ error: 'administrators only' }, 403);
      const name = String(body.name ?? '').trim();
      const startDate = String(body.startDate ?? '');
      if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return json({ error: 'bad request' }, 400);
      const id = body.id ? String(body.id) : 'cohort_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const endDate = body.endDate ? String(body.endDate) : null;
      const { error } = await db.from('learning_cohorts').upsert(
        { id, name, start_date: startDate, end_date: endDate, created_by: me.email },
        { onConflict: 'id' },
      );
      if (error) { console.error('db write failed:', error); return json({ error: 'server error', detail: error.message }, 500); }
      return json({ ok: true, id });
    }

    case 'deleteCohort': {
      if (!admin) return json({ error: 'administrators only' }, 403);
      const id = String(body.id ?? '');
      if (!id) return json({ error: 'bad request' }, 400);
      const { error } = await db.from('learning_cohorts').delete().eq('id', id);
      if (error) { console.error('deleteCohort failed:', error); return json({ error: 'server error', detail: error.message }, 500); }
      return json({ ok: true });
    }

    case 'cohortMembers': {
      if (!admin) return json({ error: 'administrators only' }, 403);
      const cohortId = String(body.cohortId ?? '');
      if (!cohortId) return json({ error: 'bad request' }, 400);
      const { data: rows } = await db.from('learning_cohort_members').select('user_id').eq('cohort_id', cohortId);
      const ids = (rows ?? []).map((r: any) => r.user_id);
      const { data: accounts } = ids.length ? await db.from('learning_accounts').select('id, full_name, email').in('id', ids) : { data: [] };
      return json({ ok: true, cohortId, members: (accounts ?? []).map((a: any) => ({ id: a.id, name: a.full_name, email: a.email })) });
    }

    case 'setCohortMembers': {
      if (!admin) return json({ error: 'administrators only' }, 403);
      const cohortId = String(body.cohortId ?? '');
      const userIds = Array.isArray(body.userIds) ? body.userIds.map(String) : null;
      if (!cohortId || !userIds) return json({ error: 'bad request' }, 400);
      // Full replace, so the admin screen's roster is always exactly what
      // gets saved — no separate add/remove calls to keep in sync.
      const { error: delErr } = await db.from('learning_cohort_members').delete().eq('cohort_id', cohortId);
      if (delErr) { console.error('setCohortMembers (clear) failed:', delErr); return json({ error: 'server error', detail: delErr.message }, 500); }
      if (userIds.length) {
        const { error: insErr } = await db.from('learning_cohort_members').insert(userIds.map((uid) => ({ cohort_id: cohortId, user_id: uid, added_by: me.email })));
        if (insErr) { console.error('setCohortMembers (insert) failed:', insErr); return json({ error: 'server error', detail: insErr.message }, 500); }
      }
      return json({ ok: true });
    }

    default:
      return json({ error: 'unknown action' }, 400);
  }
});
