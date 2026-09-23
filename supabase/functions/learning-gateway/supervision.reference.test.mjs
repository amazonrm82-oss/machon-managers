// Offline tests for the supervision logic added to learning-gateway: the
// admin check, the feedback-authorization rule (now including chapter
// managers), and the dual-token identify() dispatch. These mirror the real
// functions in index.ts (same checks); DB reads (roleOf, isChapterManagerFor)
// are passed in as plain lookup tables instead of hitting Supabase.
// Run: node supervision.reference.test.mjs

const ADMIN_EMAIL = 'matanz@icelp.org.il';
function isAdmin(email) { return String(email || '').trim().toLowerCase() === ADMIN_EMAIL; }

// ---- mirror of the real isAdmin(identity): hard-coded root OR a granted DB flag ----
function isAdminWithGrant(email, id, accountsById) {
  if (isAdmin(email)) return true;
  return !!accountsById[id]?.is_admin;
}

// ---- mirror of markTopicAttendance's `allowed` computation ----
function mayMarkAttendance(actorEmail, actorId, learnerId, chapterRef, roles, chapterManagers, accountsById) {
  if (isAdminWithGrant(actorEmail, actorId, accountsById)) return true;
  const actor = roles[actorId] ?? { role: 'learner' };
  const learner = roles[learnerId] ?? { role: 'learner' };
  if (actor.role === 'coordinator') return true;
  if (actor.role === 'manager' && learner.manager_id === actorId) return true;
  return (chapterManagers[actorId] || []).includes(chapterRef);
}

// ---- mirror of cohortOf's tie-break (most recently started cohort wins) ----
function pickCohort(cohorts) {
  if (!cohorts.length) return null;
  return cohorts.slice().sort((a, b) => String(b.start_date).localeCompare(String(a.start_date)))[0];
}

// ---- mirror of the 'feedback' action's `allowed` computation ----
function mayFeedback(actorEmail, actorId, target, kind, ref, roles, chapterManagers) {
  if (isAdmin(actorEmail)) return true;
  const actor = roles[actorId] ?? { role: 'learner' };
  const targetRole = roles[target] ?? { role: 'learner' };
  if (actor.role === 'coordinator') return true;
  if (actor.role === 'manager' && targetRole.manager_id === actorId) return true;
  if (kind === 'chapter' && (chapterManagers[actorId] || []).includes(ref)) return true;
  return false;
}

// ---- mirror of the 'team' action's chapter-roster gate ----
function maySeeChapterRoster(actorEmail, actorId, chapterRef, roles, chapterManagers) {
  if (isAdmin(actorEmail)) return true;
  const actor = roles[actorId] ?? { role: 'learner' };
  if (actor.role === 'coordinator') return true;
  return (chapterManagers[actorId] || []).includes(chapterRef);
}

// ---- mirror of identify()'s dispatch-by-part-count ----
function partsOf(token) { return token.split('.').length; }

let pass = 0, fail = 0;
const chk = (n, c) => { c ? pass++ : (fail++, console.log('FAIL:', n)); };

// admin check
chk('exact admin email matches', isAdmin('matanz@icelp.org.il'));
chk('admin email is case-insensitive', isAdmin('MatanZ@ICELP.ORG.IL'));
chk('admin email ignores surrounding space', isAdmin('  matanz@icelp.org.il  '));
chk('a different icelp address is NOT admin', !isAdmin('other@icelp.org.il'));
chk('empty email is NOT admin', !isAdmin(''));
chk('a lookalike domain is NOT admin', !isAdmin('matanz@icelp.org.il.evil.com'));

// feedback authorization
const roles = {
  mentorA: { role: 'manager' }, coord: { role: 'coordinator' },
  learnerX: { role: 'learner', manager_id: 'mentorA' },
  learnerY: { role: 'learner', manager_id: 'mentorB' },
  chapterMgr: { role: 'learner' }, // a chapter manager need not be a people-manager at all
};
const chapterManagers = { chapterMgr: ['s:0:1'] };

chk('own mentor may grade their learner', mayFeedback('mentorA@icelp.org.il', 'mentorA', 'learnerX', 'chapter', 's:0:1', roles, chapterManagers));
chk('a mentor may NOT grade someone else\'s learner', !mayFeedback('mentorA@icelp.org.il', 'mentorA', 'learnerY', 'chapter', 's:0:1', roles, chapterManagers));
chk('coordinator may grade anyone', mayFeedback('coord@icelp.org.il', 'coord', 'learnerY', 'chapter', 's:0:1', roles, chapterManagers));
chk('chapter manager may grade any learner for THEIR chapter', mayFeedback('cm@icelp.org.il', 'chapterMgr', 'learnerY', 'chapter', 's:0:1', roles, chapterManagers));
chk('chapter manager may NOT grade a different chapter', !mayFeedback('cm@icelp.org.il', 'chapterMgr', 'learnerY', 'chapter', 's:0:9', roles, chapterManagers));
chk('chapter-manager grant does not extend to the final exam (kind=final)', !mayFeedback('cm@icelp.org.il', 'chapterMgr', 'learnerY', 'final', 's:0:1', roles, chapterManagers));
chk('the admin may grade anyone for anything, even with no role row', mayFeedback('matanz@icelp.org.il', 'matanz', 'learnerY', 'chapter', 's:9:9', roles, chapterManagers));
chk('a plain learner may not grade another learner', !mayFeedback('learnerX@icelp.org.il', 'learnerX', 'learnerY', 'chapter', 's:0:1', roles, chapterManagers));

// chapter-roster visibility
chk('the assigned chapter manager sees their roster', maySeeChapterRoster('cm@icelp.org.il', 'chapterMgr', 's:0:1', roles, chapterManagers));
chk('a manager not assigned to the chapter cannot see its roster', !maySeeChapterRoster('mentorA@icelp.org.il', 'mentorA', 's:0:1', roles, chapterManagers));
chk('coordinator sees every chapter roster', maySeeChapterRoster('coord@icelp.org.il', 'coord', 's:9:9', roles, chapterManagers));
chk('admin sees every chapter roster', maySeeChapterRoster('matanz@icelp.org.il', 'matanz', 's:9:9', roles, chapterManagers));

// token dispatch (three parts = Microsoft-shaped, two parts = learn-auth-shaped)
chk('a Microsoft-shaped token has 3 parts', partsOf('header.payload.signature') === 3);
chk('a learn-auth-shaped token has 2 parts', partsOf('payload.signature') === 2);

// multi-admin: the hard-coded root, plus anyone granted the DB flag
const accountsById = { matanz: { is_admin: true /* irrelevant, root wins on email */ }, granted: { is_admin: true }, plain: { is_admin: false } };
chk('root admin (by email) needs no DB flag', isAdminWithGrant('matanz@icelp.org.il', 'matanz', {}));
chk('a granted account is admin via the DB flag', isAdminWithGrant('granted@icelp.org.il', 'granted', accountsById));
chk('an ungranted account is not admin', !isAdminWithGrant('plain@icelp.org.il', 'plain', accountsById));
chk('an unknown id with no account row is not admin', !isAdminWithGrant('nobody@icelp.org.il', 'nobody', accountsById));

// topic attendance: never self-marked, but mentor / chapter-manager / coordinator / admin may
chk('own mentor may mark attendance for their learner', mayMarkAttendance('mentorA@icelp.org.il', 'mentorA', 'learnerX', 's:0:1', roles, chapterManagers, {}));
chk('a mentor may NOT mark attendance for someone else\'s learner', !mayMarkAttendance('mentorA@icelp.org.il', 'mentorA', 'learnerY', 's:0:1', roles, chapterManagers, {}));
chk('the chapter manager may mark attendance for ANY learner in their chapter', mayMarkAttendance('cm@icelp.org.il', 'chapterMgr', 'learnerY', 's:0:1', roles, chapterManagers, {}));
chk('the chapter manager may NOT mark attendance for a different chapter', !mayMarkAttendance('cm@icelp.org.il', 'chapterMgr', 'learnerY', 's:0:9', roles, chapterManagers, {}));
chk('a learner can never mark their own attendance', !mayMarkAttendance('learnerX@icelp.org.il', 'learnerX', 'learnerX', 's:0:1', roles, chapterManagers, {}));
chk('a granted (non-root) admin may mark any attendance', mayMarkAttendance('granted@icelp.org.il', 'granted', 'learnerY', 's:9:9', roles, chapterManagers, accountsById));

// cohort tie-break: most recently started cohort wins if a learner is somehow in more than one
const cohorts = [
  { id: 'a', start_date: '2026-01-05' },
  { id: 'b', start_date: '2026-03-10' },
  { id: 'c', start_date: '2025-11-01' },
];
chk('the most recently started cohort is picked', pickCohort(cohorts).id === 'b');
chk('a single cohort is returned as-is', pickCohort([{ id: 'solo', start_date: '2026-01-01' }]).id === 'solo');
chk('no cohorts returns null', pickCohort([]) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
