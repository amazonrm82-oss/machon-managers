/* ==========================================================================
   מכון פוירשטיין · מערכת למידה וניהול ידע — v3
   A dependency-free single-page app: works on a desktop browser and on a
   phone (installable), keeps its state in localStorage, and renders the
   23 screens of the v3 design.
   ========================================================================== */

(function () {
  'use strict';

  /* ---------------------------------------------------------------- helpers */

  var ICONS = window.ICONS || {};

  function icon(name, cls) {
    var body = ICONS[name];
    if (!body) return '';
    return '<svg class="i ' + (cls || '') + '" viewBox="0 0 256 256" aria-hidden="true" focusable="false">' + body + '</svg>';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function cls() {
    return Array.prototype.filter.call(arguments, Boolean).join(' ');
  }

  /* ------------------------------------------------------------------ state */

  var STORAGE_KEY = 'feuerstein-lms-v3';

  var defaults = {
    preview: 'auto',        // auto | phone | desktop
    lang: 'he',
    day: 1,
    screen: 'register',
    dept: 'head',
    name: '',
    userEmail: '',          // which signed-in account this local data belongs to
    registered: false,
    libTab: 'assets',
    reviewTarget: '',
    chapterRosterRef: '',
    cohortEditId: '',
    confirmDeleteId: '',
    newCohortName: '',
    newCohortStart: '',
    newCohortEnd: '',
    // null means "the institute's original programme"; the builder clones it
    // on the first edit so the default is never mutated.
    curriculum: null,
    editRef: 's:0:0',
    sessions: null,
    assets: null,
    libTopic: 'שיקום קוגניטיבי',
    libSort: 'used',
    scheduleFilter: 'all',
    testSubmitted: false,
    practiceAdded: false,
    uploadPrivate: false,
    quizDone: false,
    readNotifs: false,
    rubric: [2, 1, 2, 3],
    relevance: 2,

    // Everything a person types, keyed by screen + field label. Written on
    // every keystroke so nothing is lost to a refresh or a closed tab.
    forms: {},
    // Work that has been handed in: chapter tests, the final exam, practice
    // records, observations, stage meetings, file notes, uploaded assets.
    submissions: {},
    practiceEntries: [],
    feedback: {},
    records: { observations: [], meetings: [], notes: [] },
    userAssets: [],
    // Real, self-computed learning time per chapter (ms), toward the
    // certificate's 60-hour requirement — never approved by anyone, unlike
    // the separate supervised-practice hours above.
    chapterTime: {},
    // Self-marked "I watched/covered this topic" checkmarks, per chapter ref
    // -> array of topic indices. Self-reported by design (distinct from
    // topic attendance, which only a mentor/chapter-manager may mark).
    topicsWatched: {}
  };

  var state = load();
  var currentUser = null;   // set by auth.js once someone is signed in
  var authApi = null;       // { signOut }
  var accountOpen = false;  // account menu in the header

  // Repair a loaded state object to the shapes the app relies on. Shared by the
  // local load() and the remote pull, so server data is guarded exactly like
  // localStorage data.
  function normalizeState(s) {
    if (!Array.isArray(s.rubric) || s.rubric.length !== 4) s.rubric = defaults.rubric.slice();
    if (!s.forms || typeof s.forms !== 'object') s.forms = {};
    if (!s.submissions || typeof s.submissions !== 'object') s.submissions = {};
    if (!Array.isArray(s.practiceEntries)) s.practiceEntries = [];
    if (!s.feedback || typeof s.feedback !== 'object') s.feedback = {};
    if (!s.records || typeof s.records !== 'object') s.records = { observations: [], meetings: [], notes: [] };
    ['observations', 'meetings', 'notes'].forEach(function (k) {
      if (!Array.isArray(s.records[k])) s.records[k] = [];
    });
    if (!Array.isArray(s.userAssets)) s.userAssets = [];
    if (!s.chapterTime || typeof s.chapterTime !== 'object') s.chapterTime = {};
    if (!s.topicsWatched || typeof s.topicsWatched !== 'object') s.topicsWatched = {};
    if (s.curriculum && (!Array.isArray(s.curriculum.stages) || !s.curriculum.tracks)) s.curriculum = null;
    return s;
  }

  function load() {
    var s = {};
    for (var k in defaults) s[k] = defaults[k];
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        for (var key in saved) if (key in defaults) s[key] = saved[key];
      }
      normalizeState(s);
    } catch (e) { /* private mode, cleared storage — start fresh */ }
    return s;
  }

  function save() {
    // localStorage is always written — it is the offline cache, and the only
    // store at all for the demo entrance.
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
    // When signed in with a real account, mirror personal progress to the
    // server, and — only from the administrator's session — mirror any
    // locally-edited shared content too.
    remotePush();
    pushContentIfAdmin();
  }

  /* ------------------------------------------------------ remote sync (server)

     The learning-gateway Edge Function persists each learner's state on the
     server, isolated by their verified Microsoft identity — see
     supabase/functions/learning-gateway. This layer activates ONLY when auth.js
     hands boot() a getToken() (a real Microsoft sign-in). With no token — the
     demo entrance, or a plain standalone open — everything here is inert and the
     app is exactly the local-only app it was before: localStorage is the store.

     Model: localStorage is the offline cache; the server is the source of truth.
     boot() pulls the server copy once; every save() mirrors the state up
     (debounced). A failed call (offline, or Entra/gateway not configured yet)
     is swallowed — the local cache carries on and the next save() retries. */

  var LG_URL = 'https://tnfjcmmblrkhypprjacq.supabase.co/functions/v1/learning-gateway';
  var LEARN_AUTH_URL = 'https://tnfjcmmblrkhypprjacq.supabase.co/functions/v1/learn-auth';
  // Public anon key — it only authorizes *calling* the function; the function
  // accepts nothing but a verified Microsoft token for the actual identity.
  var LG_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRuZmpjbW1ibHJraHlwcHJqYWNxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc2NTE5ODMsImV4cCI6MjEwMzIyNzk4M30.SWp32bN-Pm-X4qDX8QbGQED5DYJBZQBg28C4vJ17gns';
  var remotePushTimer = null;

  function remoteActive() { return !!(authApi && typeof authApi.getToken === 'function'); }

  async function remoteCall(action, extra) {
    var token = await authApi.getToken();
    if (!token) throw new Error('no-token');
    var res = await fetch(LG_URL, {
      method: 'POST',
      headers: { apikey: LG_ANON, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action: action }, extra || {}))
    });
    var json = await res.json().catch(function () { return {}; });
    if (!res.ok || json.ok === false) {
      var err = new Error((json && json.error) || ('http-' + res.status));
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  // Pull the learner's saved state from the server and merge it over what is in
  // memory, then re-render. Server wins for any key it carries.
  var myCohort = null;       // { id, name, startDate, endDate } | null — the learner's cohort
  var myAttendance = [];     // [{chapter_ref, topic_index, marked_by, marked_at}] — never self-set
  var myRole = { role: 'learner', manager_id: null, department: null };
  var myChapterManagerOf = []; // chapter refs the signed-in person manages, if any
  var mySubmissions = [];    // this learner's own learning_submissions rows, incl. real feedback
  var mySessionRegs = [];    // session refs this person has really registered for
  var sessionRegistrants = {}; // session ref -> registrants array | 'loading', admin-only
  async function remotePull() {
    if (!remoteActive()) return;
    try {
      var r = await remoteCall('load', {});
      var data = (r && r.state && typeof r.state === 'object') ? r.state : null;
      if (data) {
        for (var key in data) if (key in defaults) state[key] = data[key];
        normalizeState(state);
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
      }
      myCohort = (r && r.cohort) || null;
      myAttendance = (r && Array.isArray(r.attendance)) ? r.attendance : [];
      myRole = (r && r.role) || myRole;
      myChapterManagerOf = (r && Array.isArray(r.chapterManagerOf)) ? r.chapterManagerOf : [];
      mySubmissions = (r && Array.isArray(r.submissions)) ? r.submissions : [];
      mySessionRegs = (r && Array.isArray(r.sessionRegistrations)) ? r.sessionRegistrations : [];
      render();
    } catch (e) {
      // Offline, or Entra/gateway not configured yet: keep the local cache.
    }
    pullContent();
  }

  /* -------------------------------------------------- supervision data
     Loaded on demand (not on every boot) and cached until a write forces a
     refresh, since it is only needed on the admin/mentor screens. */
  var myTeam = null;         // [{user_id, role, department, name, submitted, graded, pending, pendingList}] | null
  var teamLoading = false;
  var chapterRosters = {};   // chapterRef -> roster array | 'loading'
  var gradingSub = {};       // 'userId|kind|ref' -> submission row | 'loading' | 'missing' | 'error'
  var gradeTarget = null;    // { userId, name, kind, ref, label } — set when a grader opens one submission

  function ensureTeamLoaded() {
    if (!remoteActive() || myTeam !== null || teamLoading) return;
    teamLoading = true;
    remoteCall('team', {}).then(function (r) {
      myTeam = (r && Array.isArray(r.members)) ? r.members : [];
      teamLoading = false;
      render();
    }).catch(function () { myTeam = []; teamLoading = false; });
  }

  function ensureChapterRoster(chapterRef) {
    if (!remoteActive() || !chapterRef) return [];
    if (chapterRosters[chapterRef]) return chapterRosters[chapterRef];
    chapterRosters[chapterRef] = 'loading';
    remoteCall('team', { chapterRef: chapterRef }).then(function (r) {
      chapterRosters[chapterRef] = (r && Array.isArray(r.roster)) ? r.roster : [];
      render();
    }).catch(function () { delete chapterRosters[chapterRef]; });
    return chapterRosters[chapterRef];
  }

  // Only learn-auth (not learning-gateway) owns learning_accounts.is_admin —
  // used for the one admin-promotion action, setAdmin.
  async function remoteCallAuth(action, extra) {
    var token = await authApi.getToken();
    if (!token) throw new Error('no-token');
    var res = await fetch(LEARN_AUTH_URL, {
      method: 'POST',
      headers: { apikey: LG_ANON, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action: action }, extra || {}))
    });
    var json = await res.json().catch(function () { return {}; });
    if (!res.ok || json.ok === false) {
      var err = new Error((json && json.error) || ('http-' + res.status));
      err.status = res.status; err.body = json;
      throw err;
    }
    return json;
  }

  var myPeople = null;       // [{id, name, email, role, managerId, chapterRefs}] | null, admin-only
  var peopleLoading = false;
  function ensurePeopleLoaded() {
    if (!remoteActive() || myPeople !== null || peopleLoading) return;
    peopleLoading = true;
    remoteCall('people', {}).then(function (r) {
      myPeople = (r && Array.isArray(r.people)) ? r.people : [];
      peopleLoading = false;
      render();
    }).catch(function () { myPeople = []; peopleLoading = false; });
  }

  var myCohorts = null;      // [{id, name, startDate, endDate, memberCount}] | null, admin-only
  var cohortsLoading = false;
  function ensureCohortsLoaded() {
    if (!remoteActive() || myCohorts !== null || cohortsLoading) return;
    cohortsLoading = true;
    remoteCall('cohorts', {}).then(function (r) {
      myCohorts = (r && Array.isArray(r.cohorts)) ? r.cohorts : [];
      cohortsLoading = false;
      render();
    }).catch(function () { myCohorts = []; cohortsLoading = false; });
  }

  var cohortMembersCache = {}; // cohortId -> [{id,name,email}] | 'loading'
  function ensureCohortMembers(cohortId) {
    if (!remoteActive() || !cohortId) return [];
    if (cohortMembersCache[cohortId]) return cohortMembersCache[cohortId];
    cohortMembersCache[cohortId] = 'loading';
    remoteCall('cohortMembers', { cohortId: cohortId }).then(function (r) {
      cohortMembersCache[cohortId] = (r && Array.isArray(r.members)) ? r.members : [];
      render();
    }).catch(function () { delete cohortMembersCache[cohortId]; });
    return cohortMembersCache[cohortId];
  }

  function ensureSessionRegistrants(ref) {
    if (!remoteActive() || !ref) return [];
    if (sessionRegistrants[ref]) return sessionRegistrants[ref];
    sessionRegistrants[ref] = 'loading';
    remoteCall('sessionRegistrants', { ref: ref }).then(function (r) {
      sessionRegistrants[ref] = (r && Array.isArray(r.registrants)) ? r.registrants : [];
      render();
    }).catch(function () { delete sessionRegistrants[ref]; });
    return sessionRegistrants[ref];
  }

  function ensureSubmissionLoaded(userId, kind, ref) {
    var key = userId + '|' + kind + '|' + ref;
    if (gradingSub[key]) return gradingSub[key];
    gradingSub[key] = 'loading';
    remoteCall('submission', { userId: userId, kind: kind, ref: ref }).then(function (r) {
      gradingSub[key] = (r && r.submission) || 'missing';
      render();
    }).catch(function (e) {
      gradingSub[key] = (e && e.status === 404) ? 'missing' : 'error';
      render();
    });
    return gradingSub[key];
  }

  // The shared curriculum + enrichment-session schedule: admin-edited,
  // everyone reads. Pulled once on boot; an admin's own edits are pushed by
  // pushContentIfAdmin() below, and reach everyone else on their next pull
  // (a fresh load, or their own next remotePull()).
  async function pullContent() {
    if (!remoteActive()) return;
    try {
      var r = await remoteCall('content', {});
      // An empty override (curriculum with no stages, or a zero-length
      // session list) is treated the same as no override at all — a real
      // row exists the moment anyone saves *anything*, so "never touched"
      // and "customized down to nothing" are otherwise indistinguishable
      // from here. Matches curriculum()/sessions()'s own fallback rule.
      if (r && r.curriculum && Array.isArray(r.curriculum.stages) && r.curriculum.stages.length && r.curriculum.tracks) state.curriculum = r.curriculum;
      if (r && Array.isArray(r.sessions) && r.sessions.length) state.sessions = r.sessions;
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
      render();
    } catch (e) { /* offline — local cache, or the built-in defaults, carries on */ }
  }

  var contentPushTimer = null;
  // Mirrors a locally-edited curriculum/session schedule up to the shared
  // row, debounced — but only from the administrator's own session. Anyone
  // else's local curriculum object only exists because editableCurriculum()
  // clones the default the moment a non-admin screen happens to touch it;
  // that clone must never overwrite the real shared content.
  function pushContentIfAdmin() {
    if (!remoteActive() || !(currentUser && currentUser.isAdmin)) return;
    if (state.curriculum == null && state.sessions == null) return;
    clearTimeout(contentPushTimer);
    contentPushTimer = setTimeout(function () {
      var payload = {};
      if (state.curriculum != null) payload.curriculum = state.curriculum;
      if (state.sessions != null) payload.sessions = state.sessions;
      if (!payload.curriculum && !payload.sessions) return;
      remoteCall('saveContent', payload).catch(function () { /* offline — next save() retries */ });
    }, 1200);
  }

  // Mirror the current state to the server, debounced. No-op unless a real
  // Microsoft session is active.
  function remotePush() {
    if (!remoteActive()) return;
    clearTimeout(remotePushTimer);
    remotePushTimer = setTimeout(function () {
      remoteCall('save', { state: state }).catch(function () { /* stays cached; next save retries */ });
    }, 1200);
  }

  function set(patch, opts) {
    for (var k in patch) state[k] = patch[k];
    save();
    render(opts || {});
  }

  // Only the administrator may edit shared content — curriculum, chapters,
  // the session schedule, the knowledge-base library. Enforced for real in
  // learning-gateway's saveContent (admin-only); this is the UI-level guard
  // so a non-admin never even sees the editing screens.
  var ADMIN_ONLY_SCREENS = ['coordinator', 'curriculum', 'chapterEdit', 'sessionsEdit', 'libraryEdit', 'peopleAdmin', 'cohortsAdmin'];
  // Real, self-computed time-on-task: accumulates while the lesson screen is
  // open, attributed to whichever chapter was current when it opened.
  // Nobody approves this — it is the learner's own device clock, same as the
  // "כמה זמן הייתי" the person asked for. Sanity-bounded so a tab left open
  // overnight cannot inflate the total.
  var lessonTimerStart = null;
  var lessonTimerRef = null;
  function flushLessonTimer() {
    if (lessonTimerStart && lessonTimerRef) {
      var elapsed = Date.now() - lessonTimerStart;
      if (elapsed > 1000 && elapsed < 6 * 3600000) {
        state.chapterTime[lessonTimerRef] = (state.chapterTime[lessonTimerRef] || 0) + elapsed;
        save();
      }
    }
    lessonTimerStart = null;
    lessonTimerRef = null;
  }
  if (typeof window !== 'undefined') window.addEventListener('beforeunload', flushLessonTimer);

  function go(screen) {
    accountOpen = false;
    if (ADMIN_ONLY_SCREENS.indexOf(screen) !== -1 && !(currentUser && currentUser.isAdmin)) {
      toast('מסך זה פתוח למנהל המערכת בלבד');
      set({ screen: 'admin' }, { top: true });
      return;
    }
    if (state.screen === 'lesson' && screen !== 'lesson') flushLessonTimer();
    if (screen === 'lesson' && state.screen !== 'lesson') {
      lessonTimerStart = Date.now();
      lessonTimerRef = derive().current.ref;
    }
    set({ screen: screen }, { top: true });
  }

  /* ----------------------------------------------------------------- content */

  var MANAGER = 'רון שקד';

  /* ------------------------------------------------------------ curriculum

     The 90-day path is data, not code: the training coordinator builds it in
     the curriculum screen and everything else — the stages on the home
     screen, the chapters, the number of chapter tests the certificate asks
     for, the hour targets — is derived from it. What follows is the default
     the institute started with; nothing changes until someone edits it. */

  var DEFAULT_CURRICULUM = {
    stages: [
      {
        title: 'שיטת פוירשטיין', days: 'ימים 1–30',
        hours: '20 שעות תוכן · 20 שעות פרקטיקה',
        chapters: ['חזון המכון וסיפור פוירשטיין', 'למידה מתווכת ושינוי מבני',
          'שנים-עשר קריטריוני התיווך', 'מכשירי ההעשרה האינסטרומנטלית',
          'מבוא ל-LPAD ולהערכה דינמית', 'אתיקה, גבולות ופרטיות מטופלים']
      },
      {
        title: 'שיקום קוגניטיבי', days: 'ימים 31–60',
        hours: '20 שעות תוכן · 20 שעות פרקטיקה',
        chapters: ['יסודות נוירו-קוגניטיביים ופלסטיות', 'קשב וזיכרון עבודה',
          'זיכרון ואסטרטגיות חיצוניות', 'תפקודים ניהוליים, מודעות וויסות',
          'תקשורת חברתית ותפקוד חזותי-מרחבי', 'קביעת מטרות, תכנון טיפול ומעקב']
      },
      {
        title: 'הכשרת אגף', days: 'ימים 61–90',
        hours: '20 שעות תוכן · 20 שעות פרקטיקה',
        byTrack: true, chapters: []
      }
    ],
    tracks: {
      head: {
        name: 'פגועי ראש',
        blurb: 'שיקום קוגניטיבי לאחר פגיעה מוחית נרכשת',
        chapters: ['סוגי פגיעה, מסלולי שיקום ופרוגנוזה', 'אבחון קוגניטיבי וקביעת מטרות',
          'עייפות קוגניטיבית, מודעות ותסכול', 'עבודה עם המשפחה והמסגרת']
      },
      ptsd: {
        name: 'פוסט-טראומה',
        blurb: 'עבודה קוגניטיבית מיודעת-טראומה',
        chapters: ['טראומה ותגובות פוסט-טראומטיות', 'עקרונות טיפול מיודע-טראומה',
          'שיקום קוגניטיבי בהקשר טראומטי', 'גבולות התפקיד, הפניה ושמירה על העובד']
      }
    },
    practiceTarget: 60,
    ceTarget: 10,
    finalQuestions: 12,
    chapterQuestions: 4,
    /* Used for any chapter whose own bank is still empty, so the system works
       from day one and the coordinator can replace it chapter by chapter. */
    defaultBank: [
      'תאר/י רגע מהשבוע האחרון שבו הפרק הזה שינה משהו במה שעשית — או במה שהיית עושה.',
      'בחר/י מושג אחד מהפרק והסבר/י אותו למטופל או להורה — במילים שלהם.',
      'מטופל לא מתקדם אחרי שלושה מפגשים. מה תבדוק/י קודם, ומה תשנה/י?',
      'איזו שאלה נשארה לך פתוחה?'
    ],
    finalBank: [
      'בחר/י שלושה קריטריוני תיווך והראה/י איך הם הופיעו — או נעדרו — במפגש אמיתי אחד.',
      'מה ההבדל בין הערכה דינמית להערכה סטטית, ולמה זה משנה למטופל שלך?',
      'תאר/י מקרה שבו שינית תוכנית טיפול באמצע. מה גרם לשינוי?',
      'איך את/ה מסביר/ה למשפחה מה זה שינוי מבני, בלי מונחים מקצועיים?'
    ]
  };

  /* A chapter may be written as a bare title (that is how the institute's
     original programme is expressed) or as a full record with its content and
     its question bank. Everything downstream sees the full record. */
  function asChapter(c) {
    if (typeof c === 'string') return { title: c, summary: '', minutes: 55, video: '', outline: [], materials: [], questions: [] };
    return {
      title: c.title || '',
      summary: c.summary || '',
      minutes: Number(c.minutes) || 55,
      video: c.video || '',
      outline: Array.isArray(c.outline) ? c.outline : [],
      materials: Array.isArray(c.materials) ? c.materials : [],
      questions: Array.isArray(c.questions) ? c.questions : []
    };
  }

  function curriculum() {
    var c = state.curriculum;
    if (!c || !Array.isArray(c.stages) || !c.stages.length || !c.tracks) return DEFAULT_CURRICULUM;
    return c;
  }

  /* Reads a chapter out of the programme by stage/track and index. */
  function chapterAt(ref) {
    var CUR = curriculum();
    var parts = String(ref).split(':');
    var list = parts[0] === 't'
      ? (CUR.tracks[parts[1]] && CUR.tracks[parts[1]].chapters) || []
      : (CUR.stages[Number(parts[1])] && CUR.stages[Number(parts[1])].chapters) || [];
    return { list: list, index: Number(parts[2]), chapter: asChapter(list[Number(parts[2])] || '') };
  }

  /* Turns a chapter into an editable record in place, so content can be
     attached to a programme that was written as bare titles. */
  function chapterFor(ref) {
    editableCurriculum();
    var parts = String(ref).split(':');
    var c = state.curriculum;
    var list = parts[0] === 't' ? c.tracks[parts[1]].chapters : c.stages[Number(parts[1])].chapters;
    var i = Number(parts[2]);
    if (typeof list[i] === 'string') list[i] = asChapter(list[i]);
    if (!list[i]) list[i] = asChapter('');
    return list[i];
  }

  /* A working copy to edit, cloned from the default the first time. */
  function editableCurriculum() {
    if (!state.curriculum) state.curriculum = JSON.parse(JSON.stringify(DEFAULT_CURRICULUM));
    var c = state.curriculum;
    // Normalise once, so every path the editor writes to is the same shape.
    c.stages.forEach(function (st) {
      st.chapters = (st.chapters || []).map(asChapter);
    });
    Object.keys(c.tracks).forEach(function (k) {
      c.tracks[k].chapters = (c.tracks[k].chapters || []).map(asChapter);
    });
    return c;
  }

  /* The enrichment schedule and the knowledge base, as the institute's
     starting content. Both are editable; `state.sessions` / `state.assets`
     replace these once the coordinator touches them. */
  var DEFAULT_SESSIONS = [
    { id: 's1', month: 'ספטמבר', day: '14', dow: 'יום א׳', live: true, dept: 'head', registered: true, recorded: false,
      when: '16:00–17:30 · Zoom', title: 'קשב לאחר פגיעת ראש — מהקליניקה לשגרה',
      who: 'ד״ר יעל אברמסון · מרצה חיצונית', hours: 1.5, link: '' },
    { id: 's2', month: 'ספטמבר', day: '7', dow: 'יום א׳', dept: 'all', registered: true, recorded: true,
      when: 'הסתיים · הקלטה זמינה', title: 'מקרה מהשדה: שיקום קוגניטיבי אחרי אירוע מוחי בגיל צעיר',
      who: 'אבי כהן · שיתוף ידע פנימי · ירושלים', hours: 2, link: '' },
    { id: 's3', month: 'ספטמבר', day: '28', dow: 'יום א׳', dept: 'ptsd', registered: false, recorded: false,
      when: '16:00–17:00 · Zoom', title: 'טיפול מיודע-טראומה: מה משתנה בחדר',
      who: 'צוות אגף פוסט-טראומה · מומלץ לשני האגפים', hours: 1, link: '' },
    { id: 's4', month: 'אוקטובר', day: '12', dow: 'יום ב׳', dept: 'all', registered: false, recorded: false,
      when: '09:30–13:00 · תל אביב', title: 'סדנת מכשירי העשרה אינסטרומנטלית — עבודה בזוגות',
      who: 'צוות ההדרכה · סדנה פרונטלית', hours: 3.5, link: '' },
    { id: 's5', month: 'אוקטובר', day: '26', dow: 'יום ב׳', dept: 'all', registered: false, recorded: false,
      when: '16:00–17:00 · Zoom · הרצאת רענון שנתית', title: 'רענון שנתי: עדכוני נהלים, פרטיות וחידושים מקצועיים',
      who: 'רכז הדרכה · עם שאלון קצר בסיום · תנאי חידוש התעודה', hours: 1, link: '' }
  ];

  function sessions() { return (Array.isArray(state.sessions) && state.sessions.length) ? state.sessions : DEFAULT_SESSIONS; }
  function editableSessions() {
    if (!Array.isArray(state.sessions)) state.sessions = JSON.parse(JSON.stringify(DEFAULT_SESSIONS));
    return state.sessions;
  }

  var TOPICS = [
    { name: 'שיטת פוירשטיין', n: 48 },
    { name: 'שיקום קוגניטיבי', n: 41 },
    { name: 'פגועי ראש', n: 29 },
    { name: 'פוסט-טראומה', n: 21 },
    { name: 'נהלים ותבניות', n: 15 },
    { name: 'ארגון', n: 8 }
  ];

  var ASSETS = [
    {
      id: 'plan', icon: 'file-doc', kind: 'תבנית', kindClass: 'neutral', uses: 61, fresh: 3,
      title: 'תבנית תכנון טיפול קוגניטיבי 2026',
      desc: 'מטרות, מדדים, תדירות ונקודת מעקב — התבנית שממלאים בפרק 2.6.',
      meta: 'רכז הדרכה · לפני יומיים', open: true
    },
    {
      id: 'wm', icon: 'video', kind: 'כתוביות', kindClass: '', uses: 84, fresh: 1,
      title: 'זיכרון עבודה בשגרה — הקלטת סדנה',
      desc: 'סדנת בסיס עם דוגמאות מהשדה, מתאימה גם כרענון.',
      meta: 'ד״ר יעל אברמסון · נצרך 84 פעמים'
    },
    {
      id: 'research', icon: 'file-pdf', kind: 'לסקירה בקרוב', kindClass: 'warn', uses: 22, fresh: 2,
      title: 'סיכום מחקר: שיקום קשב והישגים ארוכי טווח',
      desc: 'תקציר בעברית של מחקר אורך, עם שאלות לדיון צוותי.',
      meta: 'אבי כהן · תוקף עד 12/2026'
    },
    {
      id: 'field', icon: 'chats-circle', kind: 'משאלה מהשדה', kindClass: '', uses: 37, fresh: 4,
      title: 'מה עושים כשמטופל מסרב לתרגל בבית?',
      desc: 'תשובה של ד״ר אברמסון שהפכה לנכס ידע בלחיצה אחת.',
      meta: 'אגף פגועי ראש · לפני שבוע'
    }
  ];

  /* Each learner gets a different slice of the bank, but always the SAME
     slice — a reshuffle on every render would orphan answers already saved
     against the previous questions. */
  function drawQuestions(bank, count, seedText) {
    if (!bank || !bank.length) return [];
    var seed = 0;
    for (var i = 0; i < seedText.length; i++) seed = (seed * 31 + seedText.charCodeAt(i)) >>> 0;
    var pool = bank.slice();
    var out = [];
    while (pool.length && out.length < count) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      out.push(pool.splice(seed % pool.length, 1)[0]);
    }
    return out;
  }

  /* ------------------------------------------------------------ view model */

  function assets() { return Array.isArray(state.assets) ? state.assets : ASSETS; }
  function editableAssets() {
    if (!Array.isArray(state.assets)) state.assets = JSON.parse(JSON.stringify(ASSETS));
    return state.assets;
  }

  function derive() {
    var lang = state.lang;
    var T = lang === 'en'
      ? {
        brand: 'Feuerstein Institute · Learn', home: 'My path', file: 'My file', schedule: 'Sessions',
        library: 'Knowledge', admin: 'Team', desktop: 'Desktop', phone: 'Phone', auto: 'Auto',
        time: 'Skip ahead', day: 'Day', search: 'Search all institute knowledge', notif: 'Notifications',
        install: 'Install on your phone', hint: 'Interface in English · content authored in Hebrew'
      }
      : {
        brand: 'מכון פוירשטיין · לומדים', home: 'המסלול שלי', file: 'התיק שלי', schedule: 'שיעורים',
        library: 'מאגר הידע', admin: 'ניהול', desktop: 'מחשב', phone: 'טלפון', auto: 'אוטומטי',
        time: 'קדימה בזמן', day: 'יום', search: 'חיפוש בכל הידע של המכון', notif: 'התראות',
        install: 'התקנה על הטלפון', hint: ''
      };

    var wide = typeof window !== 'undefined' && window.innerWidth >= 900;
    var isPhone = state.preview === 'phone' || (state.preview === 'auto' && !wide);
    var isDesktop = !isPhone;

    // Real cohort timing when the admin has placed this person in one: the
    // track's day-count comes from the cohort's own start date, not a
    // global clock — several cohorts can be mid-programme at once. With no
    // cohort assigned, the demo slider (state.day) still drives the preview.
    var day = state.day;
    if (myCohort && myCohort.startDate) {
      var elapsedMs = Date.now() - new Date(myCohort.startDate + 'T00:00:00').getTime();
      day = Math.max(1, Math.floor(elapsedMs / 86400000) + 1);
    }
    var registered = state.registered;
    var screen = state.screen;
    var dept = state.dept;
    var isHead = dept === 'head';
    var deptName = isHead ? 'פגועי ראש' : 'פוסט-טראומה';
    var otherDeptName = isHead ? 'פוסט-טראומה' : 'פגועי ראש';

    var name = (state.name || '').trim() || 'מתן זזון';
    var first = name.split(/\s+/)[0];
    var initials = name.split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join('');
    var managerName = MANAGER;

    var stageCount = Math.max(1, curriculum().stages.length);
    var stageIdx = day >= 90 ? stageCount + 1 : day >= 60 ? Math.min(3, stageCount) : day >= 30 ? Math.min(2, stageCount) : 1;
    var done = stageIdx > stageCount;

    var CUR = curriculum();
    var stageDefs = CUR.stages;
    var trackKey = isHead ? 'head' : 'ptsd';
    var chaptersOf = function (st) { return st.byTrack ? (CUR.tracks[trackKey].chapters || []) : (st.chapters || []); };
    var refOf = function (stageIndex, i) {
      return stageDefs[stageIndex].byTrack ? 't:' + trackKey + ':' + i : 's:' + stageIndex + ':' + i;
    };
    var otherTrackKey = isHead ? 'ptsd' : 'head';

    // Real, merit-based chapter status — no lock between chapters (chapters
    // are shown in fixed order, but every one is reachable): a chapter is
    // 'done' once its exam is graded, 'submitted' while awaiting a grade,
    // otherwise simply available. Sourced from the server (mySubByRef),
    // never guessed from the day counter.
    var mySubByRef = {};
    mySubmissions.forEach(function (s) { mySubByRef[s.kind + ':' + s.ref] = s; });

    function mk(list, no) {
      return list.map(function (raw, i) {
        var content = asChapter(raw);
        var title = content.title;
        var ref = refOf(no - 1, i);
        var subRow = mySubByRef['chapter:' + ref];
        var graded = !!(subRow && subRow.feedback_by);
        var submitted = !!subRow && !graded;
        var st = graded ? 'done' : submitted ? 'submitted' : 'current';
        var notes = graded && Array.isArray(subRow.feedback) ? subRow.feedback.length : 0;
        return {
          id: no + '.' + (i + 1), title: title, no: no, status: st,
          content: content, ref: ref,
          done: st === 'done', submitted: st === 'submitted',
          current: st === 'current', locked: false,
          hasNotes: notes > 0, notes: notes,
          icon: st === 'done' ? 'fill:check-circle' : st === 'submitted' ? 'hourglass-medium' : 'play-circle',
          iconColor: 'var(--color-accent-700)',
          textColor: 'var(--color-neutral-900)',
          statusText: st === 'done' ? 'נבדק · ' + (notes ? notes + ' משובים' : 'ללא משוב')
            : st === 'submitted' ? 'ממתין למשוב'
              : 'טרם הוגש'
        };
      });
    }

    var perStage = stageDefs.map(function (st, i) { return mk(chaptersOf(st), i + 1); });
    var c1 = perStage[0] || [];
    var chapters = perStage.reduce(function (a, b) { return a.concat(b); }, []);
    var totalChapters = chapters.length;
    var bonusList = (CUR.tracks[otherTrackKey].chapters || []).map(function (raw, i) {
      return { id: 'ב.' + (i + 1), title: asChapter(raw).title };
    });

    function stState(no) { return done || no < stageIdx ? 'done' : no === stageIdx ? 'active' : 'locked'; }
    function badge(st) {
      return st === 'done' ? { text: 'הושלם', cls: 'solid' }
        : st === 'active' ? { text: 'פעיל', cls: '' }
          : { text: 'נעול', cls: 'neutral' };
    }

    var stages = stageDefs.map(function (def, i) {
      var no = i + 1;
      var st = { no: no, title: def.byTrack ? def.title + ' · ' + deptName : def.title,
                 days: def.days, items: perStage[i], hours: def.hours };
      var sSt = stState(no), b = badge(sSt);
      st.state = sSt; st.badgeText = b.text; st.badgeCls = b.cls;
      return st;
    });

    var testsDone = chapters.filter(function (c) { return c.done; }).length;
    var testsSubmitted = chapters.filter(function (c) { return c.submitted; }).length;

    // Real, self-computed learning time — never approved by a manager, per
    // request: finishing a chapter simply adds the time spent to the
    // record. The certificate needs at least 60 of these hours, plus every
    // chapter graded.
    var learningMs = 0;
    for (var ctKey in state.chapterTime) learningMs += Number(state.chapterTime[ctKey]) || 0;
    var learningHours = Math.round(learningMs / 3600000 * 10) / 10;
    var learningTarget = 60;
    var certReal = learningHours >= learningTarget && totalChapters > 0 && testsDone >= totalChapters;

    var practiceTarget = Number(CUR.practiceTarget) || 60;
    var ceTarget = Number(CUR.ceTarget) || 10;
    var perStageHours = practiceTarget / stageCount;
    var practiceBase = Math.min(practiceTarget, (stageIdx - 1) * perStageHours);
    var ownPracticeHours = state.practiceEntries.reduce(function (a, e) { return a + (Number(e.hours) || 0); }, 0);
    var practiceHours = Math.round((practiceBase + ownPracticeHours) * 10) / 10;
    var practicePct = Math.min(100, Math.round(practiceHours / practiceTarget * 100));
    var observations = ([0, 1, 3, 4][Math.min(3, stageIdx - 1)] || 0) + state.records.observations.length;
    var meetings = Math.min(stageCount, (stageIdx - 1) + state.records.meetings.length);
    var ceHours = ([0, 1.5, 3.5, 5][Math.min(3, stageIdx - 1)] || 0) + (state.quizDone ? 2 : 0);
    var progressPct = done ? 100
      : totalChapters ? Math.round((testsDone + testsSubmitted) / totalChapters * 100) : 0;

    var current = chapters.filter(function (c) { return c.current; })[0]
      || chapters.filter(function (c) { return c.submitted; })[0]
      || chapters[0];

    // Real grading target: whichever submission a mentor/chapter-manager/
    // coordinator/admin last opened via the team roster (openGrading action).
    // Its content is fetched from the server, never assumed locally, since
    // the grader is very often not the learner whose exam this is.
    var gradeSubmission = gradeTarget ? ensureSubmissionLoaded(gradeTarget.userId, gradeTarget.kind, gradeTarget.ref) : null;
    // Whichever chapter the learner opened, falling back to the first one
    // that has feedback on it.
    var reviewChapter = chapters.filter(function (c) { return c.id === state.reviewTarget; })[0]
      || chapters.filter(function (c) { return c.done && c.hasNotes; })[0] || c1[0];
    var stageLabel = done ? 'מוסמך' : stageIdx + ' · ' + ['פוירשטיין', 'שיקום', 'אגף'][stageIdx - 1];

    var practiceAll = [
      { date: '8.9', dur: '1.5 ש׳', stage: 1, sup: managerName, tool: 'ארגון נקודות', note: 'צפייה במפגש ראשון' },
      { date: '15.9', dur: '2 ש׳', stage: 1, sup: 'דנה שרון', tool: 'השוואות', note: 'הובלת חלק מהמפגש' },
      { date: '22.9', dur: '1.5 ש׳', stage: 1, sup: managerName, tool: 'התמצאות במרחב', note: '' },
      { date: '12.10', dur: '2 ש׳', stage: 2, sup: managerName, tool: 'תרגול קשב', note: 'עייפות אחרי 20 דקות — עצרנו' },
      { date: '20.10', dur: '1.5 ש׳', stage: 2, sup: 'אבי כהן', tool: 'זיכרון עבודה', note: '' },
      { date: '9.11', dur: '2 ש׳', stage: 3, sup: managerName, tool: 'תכנון טיפול', note: 'פגישה עם המשפחה' }
    ].filter(function (e) { return e.stage < stageIdx || done; })
      .map(function (e) {
        return {
          date: e.date, dur: e.dur, sup: e.sup, tool: e.tool, note: e.note,
          stageText: 'שלב ' + e.stage,
          appIcon: 'fill:check-circle', appText: 'אושר', appColor: 'var(--color-accent-700)'
        };
      });

    state.practiceEntries.slice().reverse().forEach(function (e) {
      practiceAll.unshift({
        date: e.date, dur: e.hours + ' ש׳', stageText: e.stage,
        sup: e.sup, tool: e.tool, note: e.note,
        appIcon: e.approved ? 'fill:check-circle' : 'hourglass-medium',
        appText: e.approved ? 'אושר' : 'ממתין לאישור',
        appColor: e.approved ? 'var(--color-accent-700)' : 'var(--color-neutral-700)'
      });
    });
    var practice = practiceAll.slice(0, 6);

    var ceList = [
      { date: '14.9', title: 'קשב לאחר פגיעת ראש — מהקליניקה לשגרה', hrs: '1.5', src: 'מרצה חיצונית' },
      { date: '21.9', title: 'מקרה מהשדה: שיקום קוגניטיבי אחרי אירוע מוחי', hrs: '2', src: 'שיתוף ידע פנימי' },
      { date: '12.10', title: 'סדנת מכשירי העשרה — עבודה בזוגות', hrs: '1.5', src: 'סדנה פרונטלית' }
    ].slice(0, [0, 1, 2, 3][stageIdx - 1]);

    if (state.quizDone) {
      ceList.unshift({
        date: 'היום', title: 'מקרה מהשדה: שיקום קוגניטיבי אחרי אירוע מוחי — שאלון הוגש',
        hrs: '2', src: 'שיתוף ידע פנימי'
      });
    }

    var notifs = [
      { d: 90, icon: 'certificate', text: 'התעודה שלך הונפקה ונשלחה למייל · תוקף עד 5.12.2028', time: 'היום' },
      { d: 90, icon: 'gift', text: 'בונוס: הכשרת אגף ' + otherDeptName + ' נפתחה לך', time: 'היום' },
      { d: 90, icon: 'chat-circle-text', text: managerName + ' הגיב/ה על המבחן המסכם', time: 'אתמול' },
      { d: 60, icon: 'lock-open', text: 'שלב 3 נפתח — הכשרת אגף ' + deptName, time: 'יום 60' },
      { d: 60, icon: 'calendar-check', text: 'שיחת סיכום שלב 2 עם ' + managerName + ' — יום ג׳ 10:00', time: 'יום 59' },
      { d: 60, icon: 'chat-circle-text', text: 'משוב חדש על 2.5 תקשורת חברתית', time: 'יום 58' },
      { d: 30, icon: 'lock-open', text: 'שלב 2 נפתח — שיקום קוגניטיבי', time: 'יום 30' },
      { d: 30, icon: 'clock-clockwise', text: '3.5 שעות פרקטיקה אושרו על ידי ' + managerName, time: 'יום 29' },
      { d: 30, icon: 'chat-circle-text', text: 'משוב חדש על 1.3 קריטריוני התיווך · 2 הערות', time: 'יום 27' },
      { d: 1, icon: 'hand-waving', text: 'ברוך הבא, ' + first + '! שלב 1 — שיטת פוירשטיין — פתוח', time: 'היום' },
      { d: 1, icon: 'calendar-dots', text: 'שיעור העשרה ביום א׳: קשב לאחר פגיעת ראש · 16:00', time: 'היום' }
    ].filter(function (n) { return n.d <= day; });

    // Real team roster: a mentor's own learners, or — for a coordinator/
    // admin — everyone. Loaded from the server on demand (ensureTeamLoaded
    // guards against reloading on every render) since it is real, shared
    // data, never invented locally.
    var isPeopleManager = myRole.role === 'manager' || myRole.role === 'coordinator' || (currentUser && currentUser.isAdmin);
    if (isPeopleManager) ensureTeamLoaded();
    var team = (myTeam || []).map(function (r) {
      return {
        userId: r.user_id, name: r.name, department: r.department || '',
        role: r.role, submitted: r.submitted || 0, graded: r.graded || 0,
        pending: r.pending || 0, pendingList: r.pendingList || [],
        waitingText: r.pending ? r.pending + ' ממתין למשוב' : 'הכל נבדק'
      };
    });
    var waitingTotal = team.reduce(function (a, r) { return a + r.pending; }, 0);

    // Chapters this person manages (if any), with a real, live pending count
    // per chapter — the "מנהל פרק" view.
    var myChapters = myChapterManagerOf.map(function (ref) {
      var c = chapterAt(ref).chapter;
      return { ref: ref, title: c.title };
    });

    var titles = {
      register: 'הרשמה', home: T.home, lesson: 'פרק ' + current.id, test: 'מבחן הפרק',
      review: 'משוב מנהל', final: 'מבחן מסכם', file: T.file, practiceNew: 'רשומת פרקטיקה',
      notifications: T.notif, search: 'חיפוש', schedule: T.schedule, session: 'דף שיעור',
      sessionAfter: 'דף שיעור', library: T.library, upload: 'העלאה למאגר', asset: 'נכס ידע',
      admin: T.admin, curriculum: 'תוכנית הלימודים', chapterEdit: 'תוכן הפרק', sessionsEdit: 'ניהול השיעורים', libraryEdit: 'ניהול המאגר', managerTest: 'בדיקת מבחן', chapterRoster: 'סטטוס פרק', peopleAdmin: 'ניהול אנשים', cohortsAdmin: 'ניהול תקופות', observation: 'תצפית שדה',
      stageMeeting: 'שיחת סיכום שלב', fileReview: 'סקירת תיק', coordinator: 'רכז הדרכה'
    };

    return {
      T: T, lang: lang, isPhone: isPhone, isDesktop: isDesktop,
      day: day, registered: registered, screen: screen,
      dept: dept, isHead: isHead, deptName: deptName, otherDeptName: otherDeptName,
      name: name, first: first, initials: initials, managerName: managerName,
      stageIdx: stageIdx, done: done, notDone: !done, day1: day === 1,
      stages: stages, chapters: chapters, bonusList: bonusList,
      current: current, currentStage: ['שיטת פוירשטיין', 'שיקום קוגניטיבי', 'הכשרת אגף'][current.no - 1],
      gradeTarget: gradeTarget, gradeSubmission: gradeSubmission, mySubByRef: mySubByRef, mySessionRegs: mySessionRegs,
      isAdmin: !!(currentUser && currentUser.isAdmin),
      isPeopleManager: isPeopleManager, myChapters: myChapters, myChapterManagerOf: myChapterManagerOf,
      reviewChapter: reviewChapter, hasReview: testsDone > 0,
      tests: chapters.filter(function (c) { return c.done || c.submitted; }).reverse(),
      hasTests: testsDone + testsSubmitted > 0,
      testsDone: testsDone, testsSubmitted: testsSubmitted,
      testsText: testsDone + ' נבדקו · ' + testsSubmitted + ' ממתין',
      practice: practice, hasPractice: practice.length > 0,
      practiceHours: practiceHours, practicePct: practicePct,
      observations: observations, meetings: meetings,
      ceHours: ceHours, ceList: ceList, hasCe: ceList.length > 0,
      progressPct: progressPct, stageLabel: stageLabel,
      notifs: notifs, hasUnread: !state.readNotifs && notifs.length > 0,
      team: team, waitingTotal: waitingTotal,
      titles: titles, phoneTitle: titles[screen] || T.brand,
      nextDay: day >= 90 ? 1 : day >= 60 ? 90 : day >= 30 ? 60 : 30,
      dayText: 'יום ' + day + ' מתוך 90',
      certValid: 'עד 5.12.2028',
      ownSubmissions: state.submissions, ownFeedback: state.feedback,
      ownRecords: state.records, ownAssets: state.userAssets,
      finalSubmitted: !!state.submissions.final,
      totalChapters: totalChapters, practiceTarget: practiceTarget, ceTarget: ceTarget,
      finalQuestions: Number(CUR.finalQuestions) || 12,
      chapterQuestions: Number(CUR.chapterQuestions) || 4,
      cond1: done || testsDone >= totalChapters, cond2: done || !!state.submissions.final,
      cond3: practiceHours >= practiceTarget,
      cond1Text: (done ? totalChapters : testsDone) + ' מתוך ' + totalChapters + ' מבחני פרק עם משוב',
      cond3Text: practiceHours + ' מתוך ' + practiceTarget + ' שעות פרקטיקה מאושרות',
      learningHours: learningHours, learningTarget: learningTarget, certReal: certReal,
      cond4: learningHours >= learningTarget, cond4Text: learningHours + ' מתוך ' + learningTarget + ' שעות למידה במערכת',
      heroKicker: done ? 'הכשרה הושלמה · יום ' + day
        : 'שלב ' + stageIdx + ' מתוך 3 · ' + ['שיטת פוירשטיין', 'שיקום קוגניטיבי', 'הכשרת אגף ' + deptName][stageIdx - 1] + ' · יום ' + day,
      heroTitle: done ? first + ', ההכשרה הושלמה — התעודה שלך מוכנה'
        : day === 1 ? 'שלום, ' + first + ' — מתחילים בשיטת פוירשטיין'
          : 'שלום, ' + first + ' — ממשיכים ב' + current.title,
      heroBody: done
        ? 'תעודת מדריך/ה מוסמך/ת בתוקף עד 5.12.2028. הכשרת אגף ' + otherDeptName + ' נפתחה לך כבונוס — ' + bonusList.length * 4 + ' שעות שנזקפות כשעות המשך.'
        : 'פרק ' + current.id + ' · כ-55 דקות. בסופו מבחן קצר ללא ציון — ' + managerName + ' קורא/ת ומגיב/ה, והתשובות עם ההערות נשמרות בתיק שלך.'
    };
  }

  /* ----------------------------------------------------------- area mapping */

  var AREAS = {
    home: ['home', 'lesson', 'test', 'review', 'final', 'register', 'notifications', 'search'],
    file: ['file', 'practiceNew'],
    schedule: ['schedule', 'session', 'sessionAfter'],
    library: ['library', 'upload', 'asset'],
    admin: ['admin', 'managerTest', 'chapterRoster', 'observation', 'stageMeeting', 'fileReview', 'coordinator', 'curriculum', 'chapterEdit', 'sessionsEdit', 'libraryEdit', 'peopleAdmin', 'cohortsAdmin']
  };

  function areaOf(screen) {
    for (var a in AREAS) if (AREAS[a].indexOf(screen) !== -1) return a;
    return 'home';
  }

  /* --------------------------------------------------------------- chrome */

  function topbar(v) {
    var area = areaOf(v.screen);
    var items = [
      ['home', v.T.home], ['file', v.T.file], ['schedule', v.T.schedule],
      ['library', v.T.library], ['admin', v.T.admin]
    ];
    return '' +
      '<header class="topbar"><div class="topbar-inner">' +
      '<div class="brand"><div class="brand-mark">' + icon('fill:brain') + '</div>' +
      '<div class="brand-name">' + esc(v.T.brand) + '</div></div>' +
      '<nav class="mainnav" aria-label="' + esc(v.T.brand) + '">' +
      items.map(function (it) {
        return '<button type="button" data-act="go" data-arg="' + it[0] + '"' +
          (area === it[0] ? ' aria-current="page"' : '') + '>' +
          '<span>' + esc(it[1]) + '</span><span class="ind"></span></button>';
      }).join('') +
      '</nav>' +
      '<div class="spacer"></div>' +
      '<button type="button" class="searchbtn" data-act="go" data-arg="search">' +
      icon('magnifying-glass') + '<span>' + esc(v.T.search) + '</span></button>' +
      '<button type="button" class="iconbtn" data-act="go" data-arg="notifications" aria-label="' + esc(v.T.notif) + '">' +
      icon('bell') + (v.hasUnread ? '<span class="dot"></span>' : '') + '</button>' +
      '<div class="accountwrap">' +
      '<button type="button" class="avatar" data-act="account" aria-haspopup="menu" aria-expanded="' + accountOpen + '"' +
      ' aria-label="' + esc(v.name) + '">' + esc(v.initials) + '</button>' +
      accountMenu(v) + '</div>' +
      '</div></header>';
  }

  function mobilebar(v) {
    return '' +
      '<header class="mobilebar">' +
      '<div class="brand-mark">' + icon('fill:brain') + '</div>' +
      '<div class="title">' + esc(v.phoneTitle) + '</div>' +
      '<button type="button" class="iconbtn" data-act="go" data-arg="search" aria-label="' + esc(v.T.search) + '">' + icon('magnifying-glass') + '</button>' +
      '<button type="button" class="iconbtn" data-act="go" data-arg="notifications" aria-label="' + esc(v.T.notif) + '">' +
      icon('bell') + (v.hasUnread ? '<span class="dot"></span>' : '') + '</button>' +
      '<div class="accountwrap">' +
      '<button type="button" class="avatar" data-act="account" aria-haspopup="menu" aria-expanded="' + accountOpen + '"' +
      ' aria-label="' + esc(v.name) + '">' + esc(v.initials) + '</button>' +
      accountMenu(v) + '</div>' +
      '</header>';
  }

  function tabbar(v) {
    var area = areaOf(v.screen);
    var items = [
      ['home', v.T.home, 'graduation-cap'], ['file', v.T.file, 'folder-user'],
      ['schedule', v.T.schedule, 'calendar-dots'], ['library', v.T.library, 'books'],
      ['admin', v.T.admin, 'users-three']
    ];
    return '<nav class="tabbar" aria-label="' + esc(v.T.brand) + '">' +
      items.map(function (it) {
        return '<button type="button" data-act="go" data-arg="' + it[0] + '"' +
          (area === it[0] ? ' aria-current="page"' : '') + '>' +
          icon(it[2]) + '<span>' + esc(it[1]) + '</span></button>';
      }).join('') + '</nav>';
  }

  function accountMenu(v) {
    if (!accountOpen) return '';
    var who = currentUser && currentUser.email
      ? esc(currentUser.email)
      : (currentUser && currentUser.via === 'demo' ? 'מצב הדגמה · ללא התחברות' : 'מחובר/ת מקומית');
    return '<div class="accountmenu" role="menu">' +
      '<div class="who"><span class="n">' + esc(v.name) + '</span><span class="e">' + who + '</span></div>' +
      '<div class="langrow" role="group" aria-label="שפת הממשק">' +
      '<span>שפה</span>' +
      '<span class="seg">' +
      '<button type="button" data-act="lang" data-arg="he" aria-pressed="' + (v.lang === 'he') + '">עברית</button>' +
      '<button type="button" data-act="lang" data-arg="en" aria-pressed="' + (v.lang === 'en') + '">EN</button>' +
      '</span></div>' +
      '<a role="menuitem" href="./">' + icon('house') + '<span>בחירת מערכת</span></a>' +
      '<button type="button" role="menuitem" data-act="signOut">' + icon('x') + '<span>יציאה</span></button>' +
      '</div>';
  }

  /* The demo controls — time travel, reset, the phone preview — exist to show
     the system, not to use it. A learner signed in with a real account never
     sees them; they appear for the demo session and for anyone who asks with
     ?demo=1. The language switch is a real feature and lives in the account
     menu instead. */
  function isDemoMode() {
    if (typeof location !== 'undefined' && /[?&]demo=1/.test(location.search)) return true;
    return !!(currentUser && currentUser.via === 'demo');
  }

  function demobar(v) {
    if (!isDemoMode()) return '';
    var p = state.preview;
    return '' +
      '<div class="demobar">' +
      '<span class="demotag">מצב הדגמה</span>' +
      '<div class="seg" role="group" aria-label="תצוגה">' +
      '<button type="button" data-act="preview" data-arg="auto" aria-pressed="' + (p === 'auto') + '">' + icon('desktop') + '<span>' + esc(v.T.auto) + '</span></button>' +
      '<button type="button" data-act="preview" data-arg="phone" aria-pressed="' + (p === 'phone') + '">' + icon('device-mobile') + '<span>' + esc(v.T.phone) + '</span></button>' +
      '</div>' +
      '<button type="button" class="timebtn" data-act="advanceDay">' + icon('fast-forward') +
      '<span>' + esc(v.T.time) + ' · ' + esc(v.T.day) + ' ' + v.day + '</span></button>' +
      '<button type="button" class="timebtn" data-act="reset">' + icon('clock-clockwise') + '<span>איפוס הדמו</span></button>' +
      (v.T.hint ? '<span class="demohint">' + esc(v.T.hint) + '</span>' : '') +
      '</div>';
  }

  /* -------------------------------------------------------------- fragments */

  function back(target, label) {
    return '<button type="button" class="back" data-act="go" data-arg="' + target + '">' +
      icon('arrow-right', 'flip') + '<span>' + esc(label) + '</span></button>';
  }

  function bar(pct, cls2) {
    return '<div class="bar ' + (cls2 || '') + '"><i style="width:' + pct + '%"></i></div>';
  }

  /* `label` names the box for a screen reader when it is not already wrapped
     in a <label> — the open questions, whose prompt sits in its own element. */
  function textarea(rows, placeholder, value, label) {
    return '<textarea class="textarea" rows="' + rows + '"' +
      (placeholder ? ' placeholder="' + esc(placeholder) + '"' : '') +
      (label ? ' aria-label="' + esc(label) + '"' : '') +
      '>' + esc(value || '') + '</textarea>';
  }

  function field(label, control) {
    return '<label class="field">' + esc(label) + control + '</label>';
  }

  // Real registrants for one session, admin-only — who actually clicked
  // "הרשמה", loaded from learning_session_registrations.
  function registrantsBlock(ref) {
    if (!(currentUser && currentUser.isAdmin) || !remoteActive()) return '';
    var list = ensureSessionRegistrants(ref);
    if (list === 'loading') return '<div class="tiny muted">טוען נרשמים…</div>';
    if (!Array.isArray(list) || !list.length) return '<div class="tiny muted">אין עדיין נרשמים.</div>';
    return '<div class="stack s6"><span class="tiny muted">' + list.length + ' נרשמו:</span>' +
      '<div class="row tight">' + list.map(function (r) {
        return '<span class="tag neutral">' + esc(r.name) + '</span>';
      }).join('') + '</div></div>';
  }

  function select(options, extra) {
    return '<select class="select"' + (extra || '') + '>' +
      options.map(function (o) { return '<option>' + esc(o) + '</option>'; }).join('') + '</select>';
  }

  function chapterLine(c) {
    return '<div class="chapter">' +
      icon(c.icon, '') .replace('class="i ', 'style="color:' + c.iconColor + '" class="i ') +
      '<span class="t" style="color:' + c.textColor + '">' + esc(c.id + ' ' + c.title) + '</span>' +
      (c.hasNotes ? '<span class="tag">' + c.notes + ' הערות</span>' : '') +
      '</div>';
  }

  function condIcon(ok) {
    return ok ? icon('fill:check-circle', 'ok') : icon('circle-dashed', 'pending');
  }

  /* --------------------------------------------------------------- screens */

  var screens = {};

  /* 1 — הרשמה */
  screens.register = function (v) {
    return '<div class="page" style="max-width:860px;gap:24px">' +
      '<div class="stack">' +
      '<span class="tag big" style="align-self:flex-start">שלב 0 · הרשמה להכשרה · יום 1</span>' +
      '<h1 class="h1">ברוכים הבאים למכון פוירשטיין</h1>' +
      '<p class="lead">כמה פרטים ונפתח לך מסלול הכשרה של 90 יום: שיטת פוירשטיין, שיקום קוגניטיבי, והכשרת האגף שלך. בסיום — תעודה, ובונוס: הכשרת האגף השני.</p>' +
      '</div>' +
      '<div class="card pad stack s20">' +
      '<div class="grid-fields">' +
      field('שם מלא', '<input class="input" data-bind="name" value="' + esc(state.name) + '" placeholder="מתן זזון">') +
      field('מייל', '<input class="input ltr" type="email" placeholder="matan@feuerstein.org">') +
      field('מספר טלפון', '<input class="input ltr" type="tel" placeholder="050-0000000">') +
      field('מקום מגורים', '<input class="input" placeholder="עיר / יישוב">') +
      field('אזור עבודה', select(['ירושלים והסביבה', 'מרכז', 'צפון', 'חיפה', 'דרום', 'שלוחה בחו״ל'])) +
      field('סניף', select(['ירושלים — המרכז', 'תל אביב', 'חיפה', 'באר שבע'])) +
      field('תפקיד', select(['טיפולי — מדריך/ה, מנחה', 'מנהלה'])) +
      field('שפה מועדפת', select(['עברית', 'English'])) +
      '</div>' +
      '<div class="card mutedbg" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;padding:14px 16px;font-size:13px">' +
      '<div class="stack s6"><span class="muted">מנהל/ת ישיר/ה · נשלף מרשומת העובד</span><span style="font-size:14px">' + esc(v.managerName) + '</span></div>' +
      '<div class="stack s6"><span class="muted">תאריך תחילת עבודה</span><span style="font-size:14px">6 בספטמבר 2026</span></div>' +
      '</div>' +
      '<div class="stack">' +
      '<div class="small muted">אגף שיוך <span>— קובע איזו הכשרת אגף תיפתח בשלב 3</span></div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px">' +
      '<button type="button" class="pickcard" data-act="dept" data-arg="head" aria-pressed="' + v.isHead + '">' +
      icon('head-circuit') + '<span class="stack s6"><span class="h5" style="font-family:var(--font-heading)">פגועי ראש</span>' +
      '<span class="small muted">שיקום קוגניטיבי לאחר פגיעה מוחית נרכשת</span></span></button>' +
      '<button type="button" class="pickcard" data-act="dept" data-arg="ptsd" aria-pressed="' + (!v.isHead) + '">' +
      icon('heartbeat') + '<span class="stack s6"><span class="h5" style="font-family:var(--font-heading)">פוסט-טראומה</span>' +
      '<span class="small muted">עבודה קוגניטיבית מיודעת-טראומה</span></span></button>' +
      '</div></div>' +
      '<div class="row" style="padding-top:6px;border-top:1px solid var(--color-neutral-300);gap:14px">' +
      '<button type="button" class="btn btn-primary btn-lg" data-act="register"><span>פתיחת מסלול ההכשרה</span>' + icon('arrow-left', 'flip') + '</button>' +
      '<span class="tiny muted" style="max-width:42ch;line-height:1.5">הפרטים נשמרים בתיק העובד ומשמשים לתזכורות (Teams, מייל, SMS) ולדוח המנהל הישיר.</span>' +
      '</div>' +
      '</div></div>';
  };

  /* 2 — המסלול שלי */
  screens.home = function (v) {
    var h = '<div class="page">';

    if (state.testSubmitted) {
      h += '<div class="notice">' + icon('fill:check-circle') +
        '<span>המבחן נשלח ל' + esc(v.managerName) + '. תקבל/י התראה כשהמשוב יהיה מוכן — הפרק הבא כבר פתוח.</span></div>';
    }

    h += '<div class="cols">' +
      '<div class="hero flex-hero">' +
      '<div class="kicker">' + esc(v.heroKicker) + '</div>' +
      '<h1 class="hero-title">' + esc(v.heroTitle) + '</h1>' +
      '<div class="hero-body">' + esc(v.heroBody) + '</div>' +
      '<div class="row">' +
      (v.notDone
        ? '<button type="button" class="btn btn-onDark" data-act="go" data-arg="lesson">' + icon('play') + '<span>לפרק ' + esc(v.current.id) + '</span></button>'
        : '<button type="button" class="btn btn-onDark" data-act="go" data-arg="file">' + icon('certificate') + '<span>לתעודה בתיק שלי</span></button>') +
      '<div class="meta">התקדמות במסלול · ' + v.progressPct + '%</div>' +
      '</div>' + bar(v.progressPct) + '</div>' +

      '<div class="card pad flex-side stack s14">' +
      '<div class="kicker">לקראת התעודה</div>' +
      '<div class="stack" style="font-size:14px">' +
      '<div class="row between nowrap"><span>מבחני פרק עם משוב</span><span class="muted">' + v.testsDone + ' מתוך ' + v.totalChapters + '</span></div>' +
      '<div class="row between nowrap"><span>שעות פרקטיקה מאושרות</span><span class="muted">' + v.practiceHours + ' מתוך ' + v.practiceTarget + '</span></div>' +
      bar(v.practicePct) +
      '<div class="row between nowrap"><span>תצפיות שדה · לפי שיקול המנהל</span><span class="muted">' + v.observations + '</span></div>' +
      '<div class="row between nowrap"><span>שיחות סיכום שלב</span><span class="muted">' + v.meetings + ' מתוך 3</span></div>' +
      '</div>' +
      '<div class="row between" style="margin-top:auto;padding-top:12px;border-top:1px solid var(--color-neutral-300)">' +
      '<span class="small muted">' + esc(v.dayText) + ' · ' + esc(v.deptName) + '</span>' +
      '<button type="button" class="btn btn-outline btn-sm" data-act="go" data-arg="practiceNew">' + icon('plus') + '<span>רשומת פרקטיקה</span></button>' +
      '</div></div></div>';

    h += '<div class="stack s14">' +
      '<div class="row between" style="align-items:baseline">' +
      '<div class="h2">מסלול ההכשרה · 90 יום</div>' +
      '<div class="small muted">שלב נפתח מיד עם הגשת המבחן האחרון בשלב הקודם</div></div>' +
      '<div class="grid stages">' +
      v.stages.map(function (st) {
        return '<div class="' + cls('stagecard', st.state === 'active' && 'active', st.state === 'locked' && 'locked') + '">' +
          '<div class="head"><div class="stack s6">' +
          '<span class="no">שלב ' + st.no + ' · ' + esc(st.days) + '</span>' +
          '<span class="name">' + esc(st.title) + '</span></div>' +
          '<span class="tag ' + st.badgeCls + '">' + esc(st.badgeText) + '</span></div>' +
          '<div class="body">' + st.items.map(chapterLine).join('') +
          '<div class="foot">' + esc(st.hours) + '</div></div></div>';
      }).join('') +
      '<div class="stagecard locked">' +
      '<div class="head"><div class="stack s6"><span class="no">בונוס · אחרי התעודה</span>' +
      '<span class="name">הכשרת אגף · ' + esc(v.otherDeptName) + '</span></div>' +
      (v.done ? '<span class="tag">פתוח</span>' : icon('gift', 'muted')) + '</div>' +
      '<div class="body muted">' +
      v.bonusList.map(function (b) {
        return '<div class="chapter">' + icon('circle-dashed') + '<span class="t">' + esc(b.id + ' ' + b.title) + '</span></div>';
      }).join('') +
      '<div class="foot">' + (v.bonusList.length * 4) + ' שעות תוכן · נזקפות כשעות המשך · ללא פרקטיקום חובה</div></div></div>' +
      '</div></div>';

    h += '<div class="cols">' +
      '<div class="flex-half">' +
      '<div class="row between" style="align-items:baseline"><div class="h3">המבחנים שלי</div>' +
      '<button type="button" class="btn-link" data-act="go" data-arg="file">הכל בתיק</button></div>';

    if (v.hasTests) {
      h += '<div class="card"><div class="rows">' +
        (v.hasReview
          ? '<button type="button" class="rowitem" data-act="review" data-arg="' + esc(v.reviewChapter.id) + '">' +
          icon('fill:chat-circle-text', 'ok') +
          '<span class="body"><span class="t">' + esc(v.reviewChapter.id + ' ' + v.reviewChapter.title) + '</span>' +
          '<span class="s" style="color:var(--color-accent-700)">נבדק · 2 הערות מ' + esc(v.managerName) + ' · לצפייה</span></span>' +
          icon('arrow-left', 'flip ok') + '</button>'
          : '') +
        v.tests.map(function (t) {
          return '<div class="rowitem">' +
            icon(t.icon, '').replace('class="i ', 'style="color:' + t.iconColor + '" class="i ') +
            '<span class="body"><span class="t">' + esc(t.id + ' ' + t.title) + '</span>' +
            '<span class="s">' + esc(t.statusText) + '</span></span></div>';
        }).join('') +
        '</div></div>';
    }
    if (v.day1) {
      h += '<div class="card pad row" style="gap:14px;flex-wrap:nowrap">' + icon('chat-circle-text', 'ok') +
        '<div class="small muted" style="font-size:14px;line-height:1.6">עדיין אין מבחנים. כל פרק נחתם ב-4 שאלות פתוחות מהמחסן — בלי ציון, עם משוב אישי מ' + esc(v.managerName) + '.</div></div>';
    }
    h += '</div>';

    h += '<div class="flex-third">' +
      '<div class="h3">בקרוב</div>' +
      '<button type="button" class="card sessionitem" data-act="go" data-arg="session">' +
      '<span class="datechip"><span class="d">14</span><span class="m">בספט׳</span></span>' +
      '<span class="body">' +
      '<span class="row tight"><span class="livedot"></span><span class="tiny" style="color:var(--color-live)">משודר עכשיו</span></span>' +
      '<span class="name">קשב לאחר פגיעת ראש — מהקליניקה לשגרה</span>' +
      '<span class="sub">ד״ר יעל אברמסון · Zoom · 1.5 שעות המשך</span></span>' +
      icon('arrow-left', 'flip ok') + '</button>' +
      '<button type="button" class="card flat rowitem" style="padding:14px 18px" data-act="go" data-arg="asset">' +
      icon('books', 'ok') +
      '<span class="body"><span class="t">חדש במאגר: תבנית תכנון טיפול קוגניטיבי 2026</span>' +
      '<span class="s">שיקום קוגניטיבי · לפני יומיים</span></span></button>' +
      '</div></div>';

    return h + '</div>';
  };

  /* 3 — פרק */
  screens.lesson = function (v) {
    var content = v.current.content;
    var outline = content.outline.length ? content.outline : [
      'המושגים המרכזיים ומאיפה הם באים',
      'שני קטעי וידאו מהשדה לניתוח',
      'איך זה נראה במפגש אמיתי — ומה עוצרים',
      'דף עבודה לרשומת הפרקטיקה הבאה'
    ];
    return '<div class="page narrow">' +
      back('home', 'חזרה למסלול שלי') +
      '<div class="stack s8">' +
      '<div class="kicker accent">' + esc(v.currentStage) + ' · פרק ' + esc(v.current.id) + '</div>' +
      '<h1 class="h1">' + esc(v.current.title) + '</h1>' +
      (content.summary ? '<p class="lead">' + esc(content.summary) + '</p>' : '') +
      '<div class="small muted">כ-' + content.minutes + ' דקות · וידאו עם כתוביות · בסופו מבחן פרק ללא ציון</div></div>' +
      '<div class="video"><button type="button" class="play" aria-label="הפעלת הווידאו של הפרק" data-act="toast" data-arg="הווידאו יתנגן במערכת החיה">' + icon('fill:play') + '</button>' +
      '<div class="controls"><span class="track"><i style="width:22%"></i></span>' +
      '<span>12:10 מתוך 55:00</span>' + icon('closed-captioning') + icon('download-simple') + '</div></div>' +
      '<div class="card pad stack s14">' +
      '<div class="h4">מה בפרק</div>' +
      '<div class="small muted">סימון עצמי — לחיצה על נושא מסמנת שסיימת אותו, בלי אישור מנהל</div>' +
      '<div class="stack" style="font-size:14px;color:var(--color-neutral-800)">' +
      outline.map(function (line, i) {
        var no = (i < 9 ? '0' : '') + (i + 1);
        var watchedList = state.topicsWatched[v.current.ref] || [];
        var watched = watchedList.indexOf(i) !== -1;
        return '<button type="button" style="all:unset;cursor:pointer;display:flex;gap:10px;align-items:center;width:100%" data-act="toggleTopicWatched" data-arg="' + esc(v.current.ref) + '|' + i + '">' +
          icon(watched ? 'fill:check-circle' : 'circle-dashed', watched ? 'ok' : '') +
          '<span style="color:var(--color-accent-700);font-family:var(--font-heading)">' + no + '</span>' +
          '<span style="' + (watched ? 'color:var(--color-neutral-600);text-decoration:line-through' : '') + '">' + esc(line) + '</span></button>';
      }).join('') +
      '</div>' +
      '<div class="row" style="border-top:1px solid var(--color-neutral-300);padding-top:14px;gap:16px">' +
      content.materials.filter(function (m) { return m.name; }).map(function (m) {
        return m.url
          ? '<a class="btn-link" href="' + esc(m.url) + '" target="_blank" rel="noopener">' + icon('file-doc') + esc(m.name) + '</a>'
          : '<span class="small muted">' + icon('file-doc') + ' ' + esc(m.name) + '</span>';
      }).join('') +
      '<button type="button" class="btn-link" data-act="go" data-arg="library">' + icon('books') + 'הנושא במאגר הידע</button>' +
      '</div></div>' +
      '<div class="card tintbg pad row" style="gap:20px">' +
      '<div class="iconwrap" style="width:46px;height:46px;background:var(--color-accent-700);color:var(--color-neutral-100);font-size:24px">' + icon('chat-circle-text') + '</div>' +
      '<div class="stack s6" style="flex:1;min-width:220px">' +
      '<div class="h4" style="color:var(--color-accent-800)">מבחן הפרק — ' + v.chapterQuestions + ' שאלות פתוחות מהמחסן</div>' +
      '<div style="font-size:14px;line-height:1.6;color:var(--color-accent-700)">אין ציון. כל עובד מקבל שאלות שונות. ' + esc(v.managerName) + ' קורא/ת ומגיב/ה לכל שאלה — והפרק הבא נפתח מיד עם השליחה.</div></div>' +
      '<button type="button" class="btn btn-primary btn-lg" data-act="go" data-arg="test">למבחן הפרק</button>' +
      '</div></div>';
  };

  /* 4 — מבחן פרק */
  screens.test = function (v) {
    var own = v.current.content.questions.filter(function (q) { return String(q).trim(); });
    var usingDefault = !own.length;
    var bank = usingDefault
      ? (curriculum().defaultBank || DEFAULT_CURRICULUM.defaultBank).filter(function (q) { return String(q).trim(); })
      : own;
    var drawn = drawQuestions(bank, v.chapterQuestions, (currentUser && currentUser.id || 'me') + v.current.id);

    // Nothing authored yet: the coordinator has not filled this chapter's bank.
    if (!drawn.length) {
      return '<div class="page read">' +
        back('lesson', 'חזרה לפרק') +
        '<div class="stack s8">' +
        '<div class="kicker accent">מבחן פרק · ' + esc(v.current.id + ' ' + v.current.title) + '</div>' +
        '<h1 class="h1">המבחן עדיין לא נפתח</h1></div>' +
        '<div class="notice quiet">' + icon('hourglass-medium') +
        '<span>לפרק הזה עוד לא הוזנו שאלות. רכז ההדרכה מזין אותן במסך תוכנית הלימודים, ואז המבחן ייפתח כאן.</span></div>' +
        '<button type="button" class="btn btn-quiet" style="align-self:flex-start" data-act="go" data-arg="home">חזרה למסלול</button>' +
        '</div>';
    }

    var qs = drawn.map(function (q, i) { return [i === drawn.length - 1 ? 3 : 4, q]; });
    return '<div class="page read">' +
      back('lesson', 'חזרה לפרק') +
      '<div class="stack s8">' +
      '<div class="row tight">' +
      '<span class="kicker accent">מבחן פרק · ' + esc(v.current.id + ' ' + v.current.title) + '</span>' +
      '<span class="tag outline">גרסה אישית · ' + drawn.length + ' מתוך ' + bank.length + ' שאלות במחסן</span>' +
      (usingDefault ? '<span class="tag neutral">מחסן כללי</span>' : '') + '</div>' +
      '<h1 class="h1">' + drawn.length + ' שאלות, בלי ציון</h1>' +
      '<p class="lead">כתוב/כתבי מהניסיון והמחשבה שלך — אין תשובה אחת נכונה. אין מגבלת זמן. ' + esc(v.managerName) + ' יקרא/תקרא ויגיב/תגיב לכל שאלה, והכל נשמר בתיק שלך.</p></div>' +
      '<div class="notice quiet">' + icon('shield-check', 'ok') +
      '<span>הצהרת פרטיות: בתשובות אין שמות או פרטים מזהים של מטופלים.</span></div>' +
      '<div class="stack s14">' +
      qs.map(function (q, i) {
        return '<div class="card pad stack s12">' +
          '<div class="qline"><span class="qno">' + (i + 1) + '</span><span class="qtext">' + esc(q[1]) + '</span></div>' +
          textarea(q[0], 'התשובה שלך…', '', 'שאלה ' + (i + 1) + ': ' + q[1]) + '</div>';
      }).join('') +
      '</div>' +
      '<div class="row" style="gap:14px">' +
      '<button type="button" class="btn btn-primary btn-lg" data-act="submitTest">' + icon('paper-plane-tilt') + '<span>שליחה ל' + esc(v.managerName) + '</span></button>' +
      '<button type="button" class="btn btn-quiet btn-lg" data-act="toast" data-arg="הטיוטה נשמרת מעצמה — אפשר לסגור ולחזור">שמירת טיוטה</button>' +
      '</div></div>';
  };

  /* 5 — משוב מנהל (תצוגת עובד) */
  screens.review = function (v) {
    // Real status, from the server: what the learner actually submitted for
    // this chapter, and what (if anything) their grader wrote back.
    var subRow = v.mySubByRef['chapter:' + v.reviewChapter.ref];

    if (!subRow) {
      return '<div class="page read">' +
        back('file', 'חזרה לתיק שלי') +
        '<div class="stack s8">' +
        '<span class="kicker accent">מבחן פרק · ' + esc(v.reviewChapter.id + ' ' + v.reviewChapter.title) + '</span>' +
        '<h1 class="h1">עדיין לא הוגש מבחן לפרק הזה</h1></div>' +
        '<button type="button" class="btn btn-quiet" style="align-self:flex-start" data-act="go" data-arg="home">חזרה למסלול</button>' +
        '</div>';
    }

    var answers = Array.isArray(subRow.answers) ? subRow.answers : [];
    var fbByLabel = {};
    if (Array.isArray(subRow.feedback)) subRow.feedback.forEach(function (f) { fbByLabel[f.label] = f; });
    var graded = !!subRow.feedback_by;
    var submittedDate = subRow.submitted_at ? new Date(subRow.submitted_at).toLocaleDateString('he-IL') : '';
    var gradedDate = subRow.feedback_at ? new Date(subRow.feedback_at).toLocaleDateString('he-IL') : '';

    return '<div class="page read">' +
      back('file', 'חזרה לתיק שלי') +
      '<div class="stack s8">' +
      '<div class="row tight">' +
      '<span class="kicker accent">מבחן פרק · ' + esc(v.reviewChapter.id + ' ' + v.reviewChapter.title) + '</span>' +
      (graded
        ? '<span class="tag">נבדק</span>'
        : '<span class="tag neutral">ממתין למשוב</span>') + '</div>' +
      '<h1 class="h1">' + (graded ? 'התשובות שלך והמשוב שקיבלת' : 'התשובות שלך') + '</h1>' +
      '<div class="small muted">' + (submittedDate ? 'הוגש ' + esc(submittedDate) : '') +
      (graded ? ' · משוב ניתן על ידי ' + esc(subRow.feedback_by) + (gradedDate ? ' ב-' + esc(gradedDate) : '') : '') + '</div></div>' +
      '<div class="stack s14">' +
      answers.map(function (a, i) {
        var note = fbByLabel[a.label];
        return '<div class="qa"><div class="q">' +
          '<div class="qline"><span class="qno">' + (i + 1) + '</span>' +
          '<span class="qtext">' + esc(a.label) + '</span></div>' +
          '<div class="answer">' + esc(a.value) + '</div></div>' +
          (note
            ? '<div class="fb"><div class="stack s6"><span class="label">משוב</span>' +
              '<span class="val">' + esc(note.value) + '</span></div></div>'
            : '<div class="none">' + icon('hourglass-medium') + '<span>ממתין למשוב</span></div>') +
          '</div>';
      }).join('') +
      '</div></div>';
  };

  /* 6 — מבחן מסכם */
  screens.final = function (v) {
    var CUR = curriculum();
    var finalBank = (CUR.finalBank || []).filter(function (q) { return String(q).trim(); });
    var finalDrawn = drawQuestions(finalBank, v.finalQuestions, (currentUser && currentUser.id || 'me') + 'final');
    return '<div class="page read">' +
      back('file', 'חזרה לתיק שלי') +
      '<div class="stack s8">' +
      '<div class="row tight"><span class="kicker accent">מבחן מסכם · שלושת השלבים</span>' +
      '<span class="tag outline">גרסה אישית · ' + finalDrawn.length + ' מתוך ' + finalBank.length + ' שאלות במחסן</span></div>' +
      '<h1 class="h1">' + (finalDrawn.length || v.finalQuestions) + ' שאלות פתוחות, בלי ציון</h1>' +
      '<p class="lead">ארבע שאלות מכל שלב. ' + esc(v.managerName) + ' קורא/ת ומגיב/ה כמו במבחני הפרקים. ההגשה היא אחד משלושת התנאים לתעודה — יחד עם ' + v.totalChapters + ' מבחני פרק עם משוב ו-' + v.practiceTarget + ' שעות פרקטיקה מאושרות.</p></div>' +
      (v.done
        ? '<div class="notice">' + icon('fill:check-circle') +
        '<span>הוגש ביום 88 · המשוב של ' + esc(v.managerName) + ' ניתן ביום 90 · 12 שאלות, 5 הערות</span></div>'
        : '') +
      '<div class="stack s12">' +
      (finalDrawn.length
        ? finalDrawn.map(function (q, i) {
            return '<div class="card pad stack s12"><div class="qline"><span class="qno">' + (i + 1) + '</span>' +
              '<span class="qtext">' + esc(q) + '</span></div>' +
              textarea(4, 'התשובה שלך…', '', 'שאלה ' + (i + 1) + ': ' + q) + '</div>';
          }).join('')
        : '<div class="notice quiet">' + icon('hourglass-medium') +
          '<span>מחסן השאלות של המבחן המסכם עדיין ריק. רכז ההדרכה מזין אותו במסך תוכנית הלימודים.</span></div>') +
      '</div>' +
      '<div class="row" style="gap:14px">' +
      (v.notDone && finalDrawn.length
        ? '<button type="button" class="btn btn-primary btn-lg" data-act="submitFinal">' + icon('paper-plane-tilt') + '<span>הגשה ל' + esc(v.managerName) + '</span></button>'
        : '') +
      '<button type="button" class="btn btn-quiet btn-lg" data-act="toast" data-arg="הטיוטה נשמרת מעצמה — אפשר לסגור ולחזור">שמירת טיוטה</button>' +
      '<span class="tiny muted">אפשר לכתוב לאורך כמה ימים.</span>' +
      '</div></div>';
  };

  /* 7 — התיק שלי */
  screens.file = function (v) {
    var h = '<div class="page" style="gap:24px">' +
      '<div class="row between" style="align-items:flex-end;gap:16px">' +
      '<div class="stack s6"><h1 class="h1">התיק של ' + esc(v.name) + '</h1>' +
      '<div class="small muted">' + esc(v.deptName) + ' · מנהל/ת ישיר/ה ' + esc(v.managerName) + ' · ' + esc(v.dayText) + ' · המנהל/ת רואה את אותו תיק</div></div>' +
      '<button type="button" class="btn btn-primary" data-act="go" data-arg="practiceNew">' + icon('plus') + '<span>רשומת פרקטיקה</span></button>' +
      '</div>';

    h += '<div class="card pad" style="display:flex;gap:22px;flex-wrap:wrap;align-items:flex-start">' +
      '<div class="stack s12" style="flex:1 1 300px">' +
      '<div class="h4">התעודה · שלושה תנאים, נשלחת אוטומטית</div>' +
      '<div class="stack">' +
      '<div class="condline">' + condIcon(v.cond1) + '<span>' + esc(v.cond1Text) + '</span></div>' +
      '<div class="condline">' + condIcon(v.cond2) + '<span>מבחן מסכם הוגש</span>' +
      '<button type="button" class="btn-link" data-act="go" data-arg="final">לצפייה</button></div>' +
      '<div class="condline">' + condIcon(v.cond3) + '<span>' + esc(v.cond3Text) + '</span></div>' +
      '<div class="condline">' + condIcon(v.cond4) + '<span>' + esc(v.cond4Text) + '</span></div>' +
      '</div>' +
      '<div class="small muted" style="line-height:1.55">שעות הלמידה נספרות אוטומטית לפי הזמן שבו פרק פתוח אצלך, בלי אישור מנהל. תצפיות שדה (' + v.observations + ') ושיחות סיכום (' + v.meetings + ' מתוך 3) נרשמות בתיק אך אינן תנאי — לפי שיקול המנהל.</div>' +
      '</div>';

    if (v.done) {
      h += '<div class="cert">' +
        '<div class="row tight">' + icon('certificate') + '<span class="kicker">תעודת מדריך/ה מוסמך/ת · מכון פוירשטיין</span></div>' +
        '<div class="name">' + esc(v.name) + '</div>' +
        '<div class="lines">שיטת פוירשטיין · שיקום קוגניטיבי · אגף ' + esc(v.deptName) + '<br>מס׳ 2026-0417 · הונפקה 5.12.2026 · תוקף ' + esc(v.certValid) + '</div>' +
        '<div class="renew">חידוש: 10 שעות המשך בשנה + הרצאת רענון שנתית עם שאלון. שעות ההמשך שלך: ' + v.ceHours + '.</div>' +
        '<div class="row tight">' +
        '<button type="button" class="btn btn-onDark btn-sm" data-act="print">' + icon('download-simple') + '<span>PDF</span></button>' +
        '<button type="button" class="btn btn-onDark btn-sm" data-act="go" data-arg="home">' + icon('gift') + '<span>לבונוס: ' + esc(v.otherDeptName) + '</span></button>' +
        '</div></div>';
    } else {
      h += '<div class="card mutedbg pad stack s8" style="flex:1 1 280px">' +
        '<div class="kicker">מה יקרה כשהכל יסומן</div>' +
        '<div style="font-size:14px;line-height:1.65;color:var(--color-neutral-800)">התעודה (PDF ממותג) נוצרת ונשלחת למייל ולתיק — בלי אישור ידני. תוקף שנתיים. חידוש: 10 שעות המשך בשנה משני מקורות + הרצאת רענון שנתית עם שאלון קצר. ואז נפתח הבונוס: הכשרת אגף ' + esc(v.otherDeptName) + '.</div></div>';
    }
    h += '</div>';

    h += '<div class="grid split">' +
      '<div class="card clip">' +
      '<div class="card-head"><span class="h4">מבחנים ומשובים</span><span class="small muted">' + esc(v.testsText) + '</span></div>' +
      (v.hasTests
        ? '<div class="rows">' + v.tests.map(function (t) {
          return '<button type="button" class="rowitem" data-act="review" data-arg="' + esc(t.id) + '">' +
            icon(t.icon, '').replace('class="i ', 'style="color:' + t.iconColor + '" class="i ') +
            '<span class="body"><span class="t">' + esc(t.id + ' ' + t.title) + '</span>' +
            '<span class="s">' + esc(t.statusText) + '</span></span>' + icon('arrow-left', 'flip ok') + '</button>';
        }).join('') + '</div>'
        : '<div style="padding:20px;font-size:14px;line-height:1.6;color:var(--color-neutral-700)">עדיין לא הוגשו מבחנים. המבחן הראשון — בסוף פרק 1.1.</div>') +
      '</div>' +

      '<div class="stack s20">' +
      '<div class="card clip">' +
      '<div class="card-head"><span class="h4">יומן פרקטיקה</span><span class="small muted">' + v.practiceHours + ' מתוך ' + v.practiceTarget + ' שעות</span></div>' +
      '<div style="padding:12px 20px 0">' + bar(v.practicePct) + '</div>' +
      (v.hasPractice
        ? '<div class="rows">' + v.practice.map(function (e) {
          return '<div class="rowitem">' +
            '<span class="stack s6" style="align-items:center;min-width:44px;font-size:12px;color:var(--color-neutral-700)">' +
            '<span style="font-family:var(--font-heading);font-size:14px;color:var(--color-neutral-900)">' + esc(e.date) + '</span>' +
            '<span>' + esc(e.dur) + '</span></span>' +
            '<span class="body"><span class="t">' + esc(e.tool + ' · ' + e.stageText) + '</span>' +
            '<span class="s">ליווי: ' + esc(e.sup) + (e.note ? ' · ' + esc(e.note) : '') + '</span></span>' +
            '<span class="row tight nowrap" style="gap:5px;font-size:12px;color:' + e.appColor + '">' +
            icon(e.appIcon) + '<span>' + esc(e.appText) + '</span></span></div>';
        }).join('') + '</div>'
        : '<div style="padding:16px 20px 20px;font-size:14px;line-height:1.6;color:var(--color-neutral-700)">אין רשומות עדיין. 30 שניות בטלפון בסוף כל מפגש — ' + esc(v.managerName) + ' מאשר/ת בלחיצה.</div>') +
      '</div>' +

      '<div class="card clip">' +
      '<div class="card-head"><span class="h4">פנקס שעות המשך</span><span class="small muted">' + v.ceHours + ' מתוך ' + v.ceTarget + ' בשנה</span></div>' +
      (v.hasCe
        ? '<div class="rows">' + v.ceList.map(function (c) {
          return '<div class="rowitem">' + icon('fill:check-circle', 'ok') +
            '<span class="body"><span class="t">' + esc(c.title) + '</span>' +
            '<span class="s">' + esc(c.date + ' · ' + c.src) + ' · שאלון סיום הוגש</span></span>' +
            '<span class="small" style="font-family:var(--font-heading);white-space:nowrap">' + esc(c.hrs) + ' ש׳</span></div>';
        }).join('') + '</div>'
        : '<div style="padding:16px 20px 20px;font-size:14px;line-height:1.6;color:var(--color-neutral-700)">שיעור העשרה נזקף כשעות המשך אחרי נוכחות + שאלון של 3 שאלות. 10 שעות בשנה = תנאי חידוש התעודה.</div>') +
      '</div>' +

      '<div class="card pad-sm stack">' +
      '<span class="h4">תצפיות ושיחות סיכום</span>' +
      '<div class="row between nowrap" style="font-size:14px"><span>תצפיות שדה של ' + esc(v.managerName) + '</span><span class="muted">' + v.observations + ' · לפי שיקול המנהל</span></div>' +
      '<div class="row between nowrap" style="font-size:14px"><span>שיחות סיכום שלב</span><span class="muted">' + v.meetings + ' מתוך 3</span></div>' +
      '</div></div></div>';

    return h + '</div>';
  };

  /* 8 — רשומת פרקטיקה */
  screens.practiceNew = function (v) {
    return '<div class="page form">' +
      back('file', 'חזרה לתיק') +
      '<div class="stack s6"><h1 class="h1">רשומת פרקטיקה</h1>' +
      '<div class="small muted">30 שניות. ' + esc(v.managerName) + ' מאשר/ת בלחיצה, והשעות נזקפות לשלב.</div></div>' +
      '<div class="card pad stack s16">' +
      '<div class="grid-fields sm">' +
      field('תאריך', '<input class="input" value="היום">') +
      field('משך', select(['שעה', 'שעה וחצי', 'שעתיים', 'חצי יום'])) +
      '</div>' +
      field('שלב שאליו נזקפות השעות', select(['שלב ' + v.stageIdx + ' · הנוכחי', 'שלב 1 · שיטת פוירשטיין', 'שלב 2 · שיקום קוגניטיבי', 'שלב 3 · הכשרת אגף'])) +
      '<div class="grid-fields">' +
      field('מי ליווה', select([v.managerName, 'דנה שרון', 'אבי כהן'])) +
      field('מכשיר / כלי', select(['תרגול קשב', 'ארגון נקודות', 'השוואות', 'התמצאות במרחב', 'זיכרון עבודה', 'תכנון טיפול'])) +
      '</div>' +
      field('הערה קצרה (לא חובה)', textarea(2, 'מה קרה, מה למדת — בלי פרטים מזהים של מטופלים')) +
      '<button type="button" class="btn btn-primary btn-lg" style="align-self:flex-start" data-act="addPractice">שמירה ושליחה לאישור</button>' +
      '</div></div>';
  };

  /* 9 — התראות */
  screens.notifications = function (v) {
    return '<div class="page list">' +
      '<div class="stack s6"><h1 class="h1">' + esc(v.T.notif) + '</h1>' +
      '<div class="small muted">נשלחות גם ל-Teams, למייל וב-SMS לעובדי שדה</div></div>' +
      '<div class="card"><div class="rows">' +
      v.notifs.map(function (n) {
        return '<div class="rowitem" style="gap:14px;padding:13px 12px">' +
          '<span class="iconwrap">' + icon(n.icon) + '</span>' +
          '<span class="body"><span class="t" style="line-height:1.5">' + esc(n.text) + '</span>' +
          '<span class="s">' + esc(n.time) + '</span></span></div>';
      }).join('') +
      '</div></div></div>';
  };

  /* 10 — חיפוש מאוחד */
  screens.search = function () {
    var results = [
      { act: 'lesson', icon: 'graduation-cap', kicker: 'פרק במסלול · שלב 2', title: '2.2 קשב וזיכרון עבודה', desc: 'ארבעת סוגי הקשב ואיך הם נפגעים · 55 דקות' },
      { act: 'asset', icon: 'video', kicker: 'הקלטה · תמלול · קפיצה ל-14:32', title: 'קשב לאחר פגיעת ראש — מהקליניקה לשגרה', desc: '״…כשה<b>קשב</b> המתמשך נופל אחרי 20 דקות, זה לא חוסר מוטיבציה — זה עייפות…״', html: true },
      { act: 'asset', icon: 'file-doc', kicker: 'נכס ידע · תבנית · שיקום קוגניטיבי', title: 'דף עבודה: מיפוי קשב במפגש', desc: 'רכז הדרכה · תוקף עד 09/2028 · נצרך 47 פעמים' },
      { act: 'library', icon: 'user-focus', kicker: 'מומחה · מי יודע מה', title: 'ד״ר יעל אברמסון · קשב ותפקודים ניהוליים', desc: 'שעת זמינות: יום ג׳ 14:00–15:00 · שאלה ישירה ב-Teams' }
    ];
    return '<div class="page narrow">' +
      '<h1 class="sr-only">חיפוש בכל הידע של המכון</h1>' +
      '<div class="row nowrap" style="background:var(--color-neutral-100);border-radius:999px;box-shadow:var(--ring-accent);padding:6px 20px;min-height:48px;gap:12px">' +
      icon('magnifying-glass', 'ok') +
      '<input class="input" style="border:0;background:transparent;padding:6px 0;font-size:16px;min-height:44px" value="קשב" aria-label="חיפוש">' +
      '</div>' +
      '<div class="small muted">7 תוצאות · מהמאגר, מפרקי ההכשרה ומתמלולי ההקלטות</div>' +
      '<div class="stack">' +
      results.map(function (r) {
        return '<button type="button" class="card" style="padding:16px 18px;display:flex;gap:14px;align-items:flex-start" data-act="go" data-arg="' + r.act + '">' +
          icon(r.icon, 'ok') + '<span class="stack s6">' +
          '<span class="tiny" style="color:var(--color-accent-700)">' + esc(r.kicker) + '</span>' +
          '<span class="h5" style="font-family:var(--font-heading)">' + esc(r.title) + '</span>' +
          '<span class="small muted" style="line-height:1.55">' + (r.html ? r.desc : esc(r.desc)) + '</span></span></button>';
      }).join('') +
      '</div></div>';
  };

  /* 11 — לוח שיעורים */
  screens.schedule = function (v) {
    var list = sessions().map(function (ss) {
      return {
        id: ss.id, month: ss.month, day: ss.day, dow: ss.dow, live: !!ss.live,
        dept: ss.dept || 'all', registered: v.mySessionRegs.indexOf(ss.id) !== -1, recorded: !!ss.recorded,
        when: ss.when, title: ss.title, who: ss.who,
        hours: Number(ss.hours) || 0, link: ss.link || '',
        act: ss.live ? 'session' : ss.recorded ? 'sessionAfter' : ''
      };
    });

    var f = state.scheduleFilter;
    var shown = list.filter(function (ss) {
      if (f === 'all') return true;
      if (f === 'dept') return ss.dept === v.dept || ss.dept === 'all';
      if (f === 'registered') return ss.registered;
      if (f === 'recorded') return ss.recorded;
      return true;
    });

    var filters = [['all', 'הכל'], ['dept', v.deptName], ['registered', 'נרשמתי'], ['recorded', 'הוקלטו']];
    var months = [];
    shown.forEach(function (ss) { if (months.indexOf(ss.month) === -1) months.push(ss.month); });

    var h = '<div class="page" style="gap:22px">' +
      '<div class="row between" style="align-items:flex-end;gap:16px">' +
      '<div class="stack s6"><h1 class="h1">שיעורי העשרה</h1>' +
      '<div class="small muted">כל שיעור נזקף כשעות המשך אחרי נוכחות + שאלון 3 שאלות · שעות ההמשך שלך: ' + v.ceHours + ' מתוך ' + v.ceTarget + '</div></div>' +
      '<div class="chips">' + filters.map(function (x) {
        return '<button type="button" class="chip" data-act="scheduleFilter" data-arg="' + x[0] + '" aria-pressed="' + (f === x[0]) + '">' + esc(x[1]) + '</button>';
      }).join('') + '</div></div>';

    months.forEach(function (month) {
      var inMonth = shown.filter(function (ss) { return ss.month === month; });
      h += '<div class="stack"><div class="kicker">' + esc(month) + '</div>' +
        inMonth.map(function (ss) {
          var inner = '<span class="datechip' + (ss.live ? '' : ' quiet') + '"><span class="d">' + esc(ss.day) + '</span><span class="m">' + esc(ss.dow) + '</span></span>' +
            '<span class="body">' +
            (ss.live
              ? '<span class="row tight"><span class="livedot"></span><span class="tiny" style="color:var(--color-live)">משודר עכשיו</span><span class="when">' + esc(ss.when) + '</span></span>'
              : '<span class="when">' + esc(ss.when) + (ss.hours ? ' · ' + ss.hours + ' שעות המשך' : '') + '</span>') +
            '<span class="name">' + esc(ss.title) + '</span><span class="sub">' + esc(ss.who) + '</span></span>';
          var cta = ss.live
            ? '<span class="tag solid" style="padding:10px 18px;border-radius:var(--radius-md)">הצטרפות</span>'
            : ss.recorded
              ? '<span class="chip on">צפייה + שאלון</span>'
              : ss.registered
                ? '<span class="tag" style="padding:10px 18px;border-radius:var(--radius-md)">' + icon('check') + '<span>נרשמת</span></span>'
                : '<button type="button" class="btn btn-outline btn-sm" data-act="registerSession" data-arg="' + esc(ss.id) + '">הרשמה</button>';
          return ss.act
            ? '<button type="button" class="card sessionitem' + (ss.live ? ' ring-accent' : '') + '" data-act="go" data-arg="' + ss.act + '">' + inner + cta + '</button>'
            : '<div class="card sessionitem">' + inner + cta + '</div>';
        }).join('') + '</div>';
    });

    if (!shown.length) {
      h += '<div class="card pad stack s8" style="align-items:flex-start">' +
        '<span class="h4">אין שיעורים להצגה</span>' +
        '<span class="small muted">' + (list.length ? 'אין שיעורים בסינון הזה.' : 'רכז ההדרכה מזין את לוח השיעורים במסך ניהול השיעורים.') + '</span></div>';
    }
    return h + '</div>';
  };

  /* 12 — דף שיעור חי */
  screens.session = function () {
    return '<div class="page" style="gap:22px">' +
      back('schedule', 'חזרה ללוח השיעורים') +
      '<div class="card clip">' +
      '<div style="padding:clamp(18px,3vw,28px);display:flex;gap:22px;align-items:flex-start;flex-wrap:wrap;border-bottom:1px solid var(--color-neutral-300)">' +
      '<div class="stack s12" style="flex:1 1 300px;min-width:0">' +
      '<div class="row tight"><span class="tag live"><span class="livedot"></span>משודר עכשיו</span>' +
      '<span class="small muted">יום א׳, 14 בספטמבר · 16:00–17:30</span></div>' +
      '<h1 class="h1">קשב לאחר פגיעת ראש — מהקליניקה לשגרה</h1>' +
      '<div class="row nowrap"><div class="avatar-sm avatar-md tint">יא</div>' +
      '<div class="stack s6"><span style="font-size:14px">ד״ר יעל אברמסון</span>' +
      '<span class="tiny muted">מרצה חיצונית · נוירופסיכולוגית · אורחת ל-30 יום</span></div></div></div>' +
      '<div class="stack s8" style="flex:0 1 220px">' +
      '<button type="button" class="btn btn-primary btn-lg btn-block" data-act="toast" data-arg="נפתח Zoom · הקישור מגיע גם ב-Teams">' +
      icon('video-camera') + '<span>הצטרפות ל-Zoom</span></button>' +
      '<div class="tiny muted" style="text-align:center">32 נרשמו · 24 מחוברים · 1.5 שעות המשך</div></div>' +
      '</div>' +
      '<div style="padding:clamp(16px,3vw,24px) clamp(18px,3vw,28px);display:flex;gap:28px;flex-wrap:wrap">' +
      '<div class="stack" style="flex:2 1 300px">' +
      '<div class="kicker">על השיעור</div>' +
      '<p class="prose" style="margin:0">איך הופכים תרגול קשב מהקליניקה להרגל בבית ובעבודה? שלוש אסטרטגיות שנבחנו בשדה, קטעי וידאו מתומצתים ודיון על מקרי גבול.</p>' +
      '<div class="stack s6">' +
      ['לזהות שלושה סוגי קושי בקשב ולבחור אסטרטגיה',
        'לתכנן ״שיעורי בית״ שמטופל באמת יעשה',
        'לתעד העברה לשגרה בתיק המטופל'].map(function (t) {
          return '<div style="display:flex;gap:9px;font-size:14px">' + icon('target', 'ok') + '<span>' + esc(t) + '</span></div>';
        }).join('') +
      '</div></div>' +
      '<div class="stack" style="flex:1 1 220px">' +
      '<div class="kicker">פרטים</div>' +
      '<dl class="deflist" style="font-size:14px">' +
      '<dt>קהל</dt><dd>אגף פגועי ראש · פתוח לכולם</dd>' +
      '<dt>דרישת קדם</dt><dd>פרק 2.2 קשב וזיכרון עבודה</dd>' +
      '<dt>שעות המשך</dt><dd>1.5 · אחרי נוכחות + שאלון</dd>' +
      '<dt>נגישות</dt><dd>כתוביות בהקלטה</dd></dl>' +
      '</div></div></div>' +

      '<div class="cols">' +
      '<div class="flex-main">' +
      '<div class="card pad stack s12">' +
      '<div class="row between"><span class="h4">חומרים · לפני השיעור</span><span class="tiny muted">העלאה: מרצה ורכז</span></div>' +
      '<div class="filerow">' + icon('presentation-chart') +
      '<span class="body"><span class="t">מצגת השיעור</span><span class="s">PPTX · 4.2MB · לפני 3 ימים</span></span>' +
      '<button type="button" class="iconbtn" style="width:32px;height:32px;font-size:18px;color:var(--color-neutral-700)" data-act="toast" data-arg="הקובץ יורד במערכת החיה" aria-label="הורדה">' + icon('download-simple') + '</button></div>' +
      '<div class="filerow">' + icon('file-pdf') +
      '<span class="body"><span class="t">קריאה מקדימה: שני מאמרים קצרים</span><span class="s">PDF · 11 עמ׳</span></span>' +
      '<button type="button" class="iconbtn" style="width:32px;height:32px;font-size:18px;color:var(--color-neutral-700)" data-act="toast" data-arg="הקובץ יורד במערכת החיה" aria-label="הורדה">' + icon('download-simple') + '</button></div>' +
      '</div>' +
      '<div class="card pad stack s12">' +
      '<div class="row between"><span class="h4">חומרים · אחרי השיעור</span><span class="tiny muted">ייפתח בסיום</span></div>' +
      '<div class="filerow dashed">' + icon('video') +
      '<span class="body"><span class="t">הקלטת Zoom עם כתוביות</span>' +
      '<span class="s">נכנסת אוטומטית עד 4 שעות מהסיום · אז נפתח שאלון 3 השאלות</span></span></div>' +
      '<div class="stack" style="border-top:1px solid var(--color-neutral-300);padding-top:12px">' +
      '<div class="row tight">' + icon('users-three', 'ok') +
      '<span style="font-size:14px;font-family:var(--font-heading);font-weight:500">תוצרי משתתפים</span>' +
      '<span class="tiny muted">כל משתתף יכול להעלות</span></div>' +
      '<div class="filerow tint">' + icon('file-doc') +
      '<span class="body"><span class="t">תרגיל תכנון שיעורי בית — קבוצת ד׳</span>' +
      '<span class="s" style="color:var(--color-accent-700)">רוני מ׳ · לפני שעה</span></span></div>' +
      '<button type="button" class="uploadbtn" data-act="go" data-arg="upload">' + icon('upload-simple') + '<span>העלאת קובץ</span></button>' +
      '</div></div></div>' +

      '<div class="flex-rail">' +
      '<div class="card pad stack s14">' +
      '<span class="h4">דיון ושאלות</span>' +
      '<div class="msg"><div class="avatar-sm">אכ</div><div class="body">' +
      '<div class="who"><b>אבי כהן</b><span> · לפני 2 שעות</span></div>' +
      '<div class="txt">אפשר להתייחס גם למטופלים עם עייפות קוגניטיבית ולא רק קשב?</div></div></div>' +
      '<div class="msg"><div class="avatar-sm tint">יא</div><div class="body">' +
      '<div class="who"><b>ד״ר יעל אברמסון</b><span> · לפני שעה</span></div>' +
      '<div class="txt">כן — האסטרטגיה השלישית בנויה בדיוק לזה. נעצור עליה בחלק השני.</div></div></div>' +
      '<form class="askbox" data-act="ask"><input placeholder="שאלה למרצה…" aria-label="שאלה למרצה">' +
      '<button type="submit" aria-label="שליחה">' + icon('paper-plane-tilt', 'flip') + '</button></form>' +
      '</div>' +
      '<div class="card pad stack">' +
      '<span class="h4">המשך באותו נושא</span>' +
      '<button type="button" class="btn-link" style="font-size:14px" data-act="go" data-arg="lesson">' + icon('arrow-left', 'flip') + 'פרק 2.2 במסלול: קשב וזיכרון עבודה</button>' +
      '<button type="button" class="btn-link" style="font-size:14px" data-act="go" data-arg="asset">' + icon('arrow-left', 'flip') + 'תבנית תכנון טיפול קוגניטיבי במאגר</button>' +
      '</div></div></div></div>';
  };

  /* 13 — דף שיעור אחרי */
  screens.sessionAfter = function (v) {
    var rel = ['נמוכה', 'בינונית', 'גבוהה'];
    return '<div class="page" style="gap:22px">' +
      back('schedule', 'חזרה ללוח השיעורים') +
      '<div class="card pad" style="display:flex;gap:22px;align-items:flex-start;flex-wrap:wrap">' +
      '<div class="stack" style="flex:1 1 300px;min-width:0">' +
      '<div class="row tight"><span class="tag neutral">הסתיים · 7 בספטמבר</span>' +
      '<span class="small muted">10:00–12:00 · ירושלים + Zoom · 2 שעות המשך</span></div>' +
      '<h1 class="h1">מקרה מהשדה: שיקום קוגניטיבי אחרי אירוע מוחי בגיל צעיר</h1>' +
      '<div class="small muted">אבי כהן · שיתוף ידע פנימי · 41 נכחו · 33 הגישו שאלון</div></div></div>' +

      '<div class="cols">' +
      '<div class="flex-main">' +
      '<div class="video"><button type="button" class="play" aria-label="הפעלת הקלטת השיעור" data-act="toast" data-arg="ההקלטה תתנגן במערכת החיה">' + icon('fill:play') + '</button>' +
      '<div class="controls"><span class="track"><i style="width:100%"></i></span><span>1:52:10</span>' + icon('closed-captioning') + '</div></div>' +
      '<div class="card pad stack s12">' +
      '<span class="h4">חומרים · אחרי השיעור</span>' +
      '<div class="filerow">' + icon('note') +
      '<span class="body"><span class="t">סיכום השיעור — אבי כהן</span><span class="s">DOCX · הועלה יום אחרי · פורסם גם למאגר</span></span>' +
      '<button type="button" class="iconbtn" style="width:32px;height:32px;font-size:18px;color:var(--color-neutral-700)" data-act="toast" data-arg="הקובץ יורד במערכת החיה" aria-label="הורדה">' + icon('download-simple') + '</button></div>' +
      '<div class="filerow">' + icon('presentation-chart') +
      '<span class="body"><span class="t">מצגת השיעור</span><span class="s">PPTX · 6.1MB</span></span>' +
      '<button type="button" class="iconbtn" style="width:32px;height:32px;font-size:18px;color:var(--color-neutral-700)" data-act="toast" data-arg="הקובץ יורד במערכת החיה" aria-label="הורדה">' + icon('download-simple') + '</button></div>' +
      '</div></div>' +

      '<div class="flex-rail">' +
      (state.quizDone
        ? '<div class="card tintbg pad stack">' +
        '<div class="row tight">' + icon('fill:check-circle', 'ok') + '<span class="h4" style="color:var(--color-accent-800)">2 שעות המשך נזקפו</span></div>' +
        '<div style="font-size:14px;line-height:1.6;color:var(--color-accent-800)">השאלון הוגש. השעות נוספו לפנקס בתיק שלך — ' + v.ceHours + ' מתוך ' + v.ceTarget + ' לשנה.</div>' +
        '<button type="button" class="btn btn-outline btn-sm" style="align-self:flex-start;background:var(--color-neutral-100)" data-act="go" data-arg="file">לפנקס בתיק</button></div>'
        : '') +
      '<div class="card pad stack s14">' +
      '<div class="stack s6"><span class="h4">שאלון סיום · 3 שאלות</span>' +
      '<span class="small muted">נוכחות מדוח Zoom + שאלון = השעות נזקפות. אין ציון.</span></div>' +
      '<label class="field" style="font-size:14px;color:var(--color-neutral-900)">1 · דבר אחד שתנסה/י במפגש הבא' + textarea(2, '…') + '</label>' +
      '<label class="field" style="font-size:14px;color:var(--color-neutral-900)">2 · שאלה שנשארה פתוחה' + textarea(2, '…') + '</label>' +
      '<div class="stack s6" style="font-size:14px">3 · רלוונטיות לעבודה שלך' +
      '<div class="chips">' + rel.map(function (r, i) {
        return '<button type="button" class="chip" data-act="relevance" data-arg="' + i + '" aria-pressed="' + (state.relevance === i) + '">' + esc(r) + '</button>';
      }).join('') + '</div></div>' +
      (state.quizDone
        ? '<div class="small muted">השאלון הוגש · אפשר לעדכן את התשובות עד סוף השבוע.</div>'
        : '<button type="button" class="btn btn-primary" style="align-self:flex-start" data-act="submitQuiz">הגשה וזקיפת 2 שעות</button>') +
      '</div></div></div></div>';
  };

  /* 14 — מאגר הידע */
  screens.library = function (v) {
    var h = '<div class="page" style="gap:22px">' +
      '<div class="row between" style="align-items:flex-end;gap:16px">' +
      '<div class="stack s6"><h1 class="h1">מאגר הידע</h1>' +
      '<div class="small muted">' + (assets().length + v.ownAssets.length) + ' נכסים · ' + TOPICS.length + ' נושאים · העלאה חופשית לכל עובד</div></div>' +
      '<button type="button" class="btn btn-primary" data-act="go" data-arg="upload">' + icon('upload-simple') + '<span>העלאת נכס ידע</span></button>' +
      '</div>' +
      '<button type="button" class="searchbtn" style="flex:0 0 auto;width:100%;background:var(--color-neutral-100);box-shadow:var(--ring);border:0;padding:13px 20px;min-height:48px;font-size:15px" data-act="go" data-arg="search">' +
      icon('magnifying-glass', 'ok') + '<span>חיפוש בתוך מצגות, מסמכים ותמלולי הקלטות…</span></button>' +
      '<div class="tabs" role="tablist">' +
      [['assets', 'נכסים'], ['experts', 'מומחים · מי יודע מה'], ['questions', 'שאלה מהשדה']].map(function (t) {
        return '<button type="button" role="tab" data-act="libTab" data-arg="' + t[0] + '" aria-selected="' + (state.libTab === t[0]) + '">' + esc(t[1]) + '</button>';
      }).join('') + '</div>';

    if (state.libTab === 'assets') {
      var topic = TOPICS.filter(function (t) { return t.name === state.libTopic; })[0] || TOPICS[1];
      var list = assets().slice().sort(function (a, b) {
        return state.libSort === 'used' ? b.uses - a.uses : a.fresh - b.fresh;
      });
      // Anything this person published sits at the top — it is the newest
      // thing in the library and the reason they came back to look.
      v.ownAssets.forEach(function (a) {
        list.unshift({
          id: a.id, icon: 'file-doc', kind: a.kind, kindClass: '', uses: 0, fresh: 0,
          title: a.title,
          desc: 'הועלה על ידך · ' + a.topic + ' · קהל: ' + a.audience,
          meta: a.by + ' · ביום ' + a.day + ' · ממתין לתיוג רכז ההדרכה'
        });
      });
      h += '<div class="chips">' + TOPICS.map(function (t) {
        return '<button type="button" class="chip" data-act="libTopic" data-arg="' + esc(t.name) + '" aria-pressed="' + (t.name === topic.name) + '">' + esc(t.name + ' · ' + t.n) + '</button>';
      }).join('') + '</div>' +
        '<div class="row between">' +
        '<span class="small muted">' + topic.n + ' נכסים ב' + esc(topic.name) + ' · ״אבחון״ הוא פילטר סוג, לא קטגוריה</span>' +
        '<div class="row tight small">' +
        [['used', 'הנצרך ביותר'], ['new', 'החדש ביותר']].map(function (s) {
          return '<button type="button" class="chip" style="padding:6px 12px" data-act="libSort" data-arg="' + s[0] + '" aria-pressed="' + (state.libSort === s[0]) + '">' + esc(s[1]) + '</button>';
        }).join('') + '</div></div>' +
        '<div class="grid assets">' +
        list.map(function (a) {
          var body = '<span class="top"><span class="iconwrap square">' + icon(a.icon) + '</span>' +
            '<span class="tag ' + (a.kindClass || '') + '" style="font-size:11px;padding:4px 9px">' + esc(a.kind) + '</span></span>' +
            '<span class="title">' + esc(a.title) + '</span>' +
            '<span class="desc">' + esc(a.desc) + '</span>' +
            '<span class="meta">' + esc(a.meta) + '</span>';
          return a.url
          ? '<a class="card assetcard" href="' + esc(a.url) + '" target="_blank" rel="noopener">' + body + '</a>'
          : '<button type="button" class="card assetcard" data-act="go" data-arg="asset">' + body + '</button>';
        }).join('') + '</div>';
    }

    if (state.libTab === 'experts') {
      var experts = [
        { init: 'יא', tint: true, name: 'ד״ר יעל אברמסון', role: 'נוירופסיכולוגית · מרצה חיצונית קבועה', tags: ['קשב', 'תפקודים ניהוליים', 'פגיעות ראש'], hour: 'שעת זמינות: יום ג׳ 14:00–15:00' },
        { init: 'אכ', name: 'אבי כהן', role: 'מדריך בכיר · ירושלים · 14 שנים במכון', tags: ['LPAD', 'אירוע מוחי', 'עבודה עם משפחות'], hour: 'שעת זמינות: יום ה׳ 12:00–13:00' },
        { init: 'נב', name: 'נעמה ברק', role: 'ראש אגף פוסט-טראומה · תל אביב', tags: ['טיפול מיודע-טראומה', 'גבולות ושמירה על העובד'], hour: 'שעת זמינות: יום ב׳ 16:00–17:00' }
      ];
      h += '<div class="small muted" style="max-width:66ch;line-height:1.6;font-size:14px">אם פותרים את אותן בעיות שוב ושוב — צריך רשת, לא מאגר. כל מדריך/ה בכיר/ה מגדיר/ה תחומי מומחיות ושעת זמינות שבועית. שאלה ישירה ב-Teams, בלי לחפש קובץ.</div>' +
        '<div class="grid experts">' + experts.map(function (e) {
          return '<div class="card pad stack s12">' +
            '<div class="row nowrap"><div class="avatar-sm avatar-lg' + (e.tint ? ' tint' : '') + '">' + esc(e.init) + '</div>' +
            '<div class="stack s6"><span class="h5" style="font-family:var(--font-heading)">' + esc(e.name) + '</span>' +
            '<span class="tiny muted">' + esc(e.role) + '</span></div></div>' +
            '<div class="row tight">' + e.tags.map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('') + '</div>' +
            '<div class="row between" style="padding-top:10px;border-top:1px solid var(--color-neutral-300);font-size:13px">' +
            '<span class="muted">' + esc(e.hour) + '</span>' +
            '<button type="button" class="btn btn-outline btn-sm" data-act="toast" data-arg="נפתחת שיחה ב-Teams">שאלה ב-Teams</button></div></div>';
        }).join('') + '</div>';
    }

    if (state.libTab === 'questions') {
      h += '<div class="row between">' +
        '<div class="chips">' +
        '<button type="button" class="chip on">ערוץ ' + esc(v.deptName) + '</button>' +
        '<button type="button" class="chip" data-act="toast" data-arg="מעבר לערוץ ' + esc(v.otherDeptName) + '">ערוץ ' + esc(v.otherDeptName) + '</button>' +
        '<button type="button" class="chip" data-act="toast" data-arg="מעבר לערוץ הכללי">כללי</button></div>' +
        '<button type="button" class="btn btn-outline" data-act="toast" data-arg="השאלה נפתחה בערוץ האגף">' + icon('question') + '<span>שאלה חדשה</span></button></div>' +
        '<div class="stack s12">' +
        '<div class="qcard"><div class="ask">' +
        '<div class="meta"><b>מיכל אזולאי</b><span>· לפני 3 ימים · 6 עוקבים</span></div>' +
        '<div class="text">מטופל אחרי פגיעת ראש מגיע עייף מאוד למפגשי אחר הצהריים ומפסיק לשתף פעולה אחרי 15 דקות. להזיז את המפגש? לקצר? מישהו התמודד?</div></div>' +
        '<div class="ans"><div class="meta"><b>ד״ר יעל אברמסון</b><span>· מומחית · לפני יומיים</span></div>' +
        '<div class="text">זה דפוס קלאסי של עייפות קוגניטיבית ולא של מוטיבציה. שלושה דברים: מפגש בוקר אם אפשר; לחלק ל-2×12 דקות עם הפסקה אמיתית; ולסיים תמיד בהצלחה קטנה — לא במשימה הקשה.</div>' +
        '<div class="row tight" style="padding-top:6px">' +
        '<button type="button" class="btn btn-outline btn-sm" style="background:var(--color-neutral-100)" data-act="toast" data-arg="נשלח לרכז ההדרכה לתיוג ופרסום">' + icon('books') + '<span>הפוך לנכס ידע</span></button>' +
        '<span class="tiny" style="color:var(--color-accent-700)">רכז ההדרכה מתייג ומפרסם · 11 סימנו כמועיל</span></div></div></div>' +
        '<div class="qcard"><div class="ask">' +
        '<div class="meta"><b>עומר בר</b><span>· אתמול · ממתין לתשובה</span></div>' +
        '<div class="text">איך מתעדים בתיק המטופל תרגול שנעשה בבית עם בן משפחה — כשעת טיפול או כהערה?</div></div></div>' +
        '</div>';
    }

    return h + '</div>';
  };

  /* 15 — העלאה למאגר */
  screens.upload = function () {
    return '<div class="page form" style="max-width:680px">' +
      back('library', 'חזרה למאגר') +
      '<div class="stack s6"><h1 class="h1">העלאת נכס ידע</h1>' +
      '<div class="small muted">ללא אישור מוקדם — רכז ההדרכה מתייג ומנקה בדיעבד. שש שדות.</div></div>' +
      '<div class="card pad stack s16">' +
      '<button type="button" class="dropzone" data-act="toast" data-arg="בוחר הקבצים ייפתח במערכת החיה">' + icon('upload-simple') +
      '<span style="font-size:14px">גרירת קובץ או בחירה מהמחשב</span>' +
      '<span class="hint">מצגת · מסמך · סרטון · הקלטה · מאמר · תבנית</span></button>' +
      field('כותרת', '<input class="input" placeholder="שם ברור שמישהו יחפש">') +
      '<div class="grid-fields md">' +
      field('נושא', select(TOPICS.map(function (t) { return t.name; }))) +
      field('סוג', select(['מצגת', 'מסמך', 'סרטון', 'הקלטה', 'מאמר', 'תבנית', 'כלי אבחון'])) +
      field('קהל', select(['מדריכים', 'מנהלה', 'מנהלים', 'כולם'])) +
      '</div>' +
      '<div class="card mutedbg stack s8" style="padding:14px 16px">' +
      '<div class="row tight" style="font-size:14px;flex-wrap:nowrap">' + icon('shield-check', 'ok') +
      '<span>הקובץ מכיל מידע על מטופל (שם, פרטים מזהים, דוח אבחון)?</span></div>' +
      '<div class="row tight">' +
      '<button type="button" class="pill" data-act="uploadPrivate" data-arg="0" aria-pressed="' + (!state.uploadPrivate) + '">לא</button>' +
      '<button type="button" class="pill" data-act="uploadPrivate" data-arg="1" aria-pressed="' + (!!state.uploadPrivate) + '">כן</button></div>' +
      (state.uploadPrivate
        ? '<div class="notice danger">' + icon('prohibit') +
        '<span>הפרסום חסום. חומרי מטופלים אינם עולים למאגר בשום מצב. לחומרי הדגמה — הסר/י שמות ופרטים מזהים ונסה/י שוב.</span></div>'
        : '') +
      '</div>' +
      '<div class="row">' +
      '<button type="button" class="btn btn-primary btn-lg"' + (state.uploadPrivate ? ' disabled style="opacity:.45;cursor:not-allowed"' : ' data-act="publishAsset"') + '>פרסום למאגר</button>' +
      '<span class="tiny muted">תוקף ברירת מחדל: 24 חודשים · את/ה הבעל/ים ותקבל/י התראה לפני</span>' +
      '</div></div></div>';
  };

  /* 16 — דף נכס */
  screens.asset = function () {
    return '<div class="page" style="gap:20px">' +
      back('library', 'חזרה למאגר') +
      '<div class="cols">' +
      '<div class="flex-main">' +
      '<div class="stack s8">' +
      '<div class="row tight"><span class="tag">שיקום קוגניטיבי</span>' +
      '<span class="tag outline">תבנית</span><span class="tag outline">מדריכים</span></div>' +
      '<h1 class="h1">תבנית תכנון טיפול קוגניטיבי 2026</h1>' +
      '<div class="small muted" style="line-height:1.6">מטרות, מדדים, תדירות ונקודת מעקב. התבנית שממלאים בפרק 2.6 ובכל תיק מטופל חדש.</div></div>' +
      '<div class="preview"><div class="stack s8" style="align-items:center">' + icon('file-doc') +
      '<span class="small">תצוגה מקדימה של המסמך · 3 עמודים</span></div></div>' +
      '</div>' +
      '<div class="flex-rail">' +
      '<div class="card pad stack s12">' +
      '<button type="button" class="btn btn-primary btn-block" data-act="toast" data-arg="הקובץ יורד במערכת החיה">' +
      icon('download-simple') + '<span>הורדה · DOCX · 220KB</span></button>' +
      '<dl class="deflist" style="padding-top:6px">' +
      '<dt>בעל הנכס</dt><dd>רכז הדרכה</dd>' +
      '<dt>הועלה</dt><dd>4.9.2026</dd>' +
      '<dt>תוקף / סקירה</dt><dd>עד 09/2028</dd>' +
      '<dt>מקור</dt><dd>העלאה עצמאית</dd>' +
      '<dt>נגישות</dt><dd>כותרות סמנטיות · טקסט חלופי</dd>' +
      '<dt>מידע על מטופל</dt><dd>לא</dd>' +
      '<dt>נצרך</dt><dd>61 פעמים · 14 מדריכים</dd></dl></div>' +
      '<div class="card pad stack">' +
      '<span class="h5" style="font-family:var(--font-heading)">קשורים</span>' +
      '<button type="button" class="btn-link" style="font-size:14px" data-act="go" data-arg="lesson">' + icon('arrow-left', 'flip') + 'פרק 2.6 במסלול: תכנון טיפול ומעקב</button>' +
      '<button type="button" class="btn-link" style="font-size:14px" data-act="go" data-arg="sessionAfter">' + icon('arrow-left', 'flip') + 'הקלטה: מקרה מהשדה — אירוע מוחי בגיל צעיר</button>' +
      '<button type="button" class="btn-link" style="font-size:14px" data-act="toast" data-arg="הגרסה הקודמת נמצאת בארכיון">' + icon('arrow-left', 'flip') + 'גרסה קודמת (2024) · בארכיון</button>' +
      '</div></div></div></div>';
  };

  /* 17 — ניהול · הצוות של המנהל */
  screens.admin = function (v) {
    var hasChapters = v.myChapters && v.myChapters.length;
    return '<div class="page" style="gap:22px">' +
      '<div class="row between" style="align-items:flex-end;gap:16px">' +
      '<div class="stack s6"><h1 class="h1">הצוות שלי</h1>' +
      '<div class="small muted">' + v.team.length + ' תלמידים · סטטוס ומבחנים ממתינים לבדיקה</div></div>' +
      (v.isAdmin ? '<button type="button" class="btn btn-quiet btn-sm" data-act="go" data-arg="coordinator">' + icon('buildings') + '<span>מסך ניהול · כל הלומדים</span></button>' : '') +
      '</div>' +
      '<div class="grid stats">' +
      '<div class="card ring-accent stat accent"><span class="label">מבחנים ממתינים למשוב</span><span class="value">' + v.waitingTotal + '</span>' +
      '<span class="note">לחיצה על שורה בטבלה פותחת לבדיקה</span></div>' +
      '</div>' +
      (hasChapters
        ? '<div class="card pad stack s8"><span class="h5">הפרקים שאני מנהל/ת</span>' +
          '<div class="row tight">' + v.myChapters.map(function (c) {
            return '<button type="button" class="pill" data-act="chapterRoster" data-arg="' + esc(c.ref) + '">' + esc(c.ref + ' ' + c.title) + '</button>';
          }).join('') + '</div></div>'
        : '') +
      '<div class="card clip">' +
      '<div class="card-head"><span class="h4">דוח הצוות</span>' +
      '<span class="tiny muted">נתונים חיים מהשרת' +
      (v.isPhone ? ' · גלילה לצדדים לשאר העמודות' : '') + '</span></div>' +
      '<div class="tablewrap"><div class="inner">' +
      '<div class="trow head"><span>עובד/ת</span><span>תפקיד</span><span>הוגשו</span><span>נבדקו</span><span>ממתין</span><span>לבדיקה</span></div>' +
      (v.team.length ? v.team.map(function (r) {
        return '<div class="' + cls('trow', r.pending && 'late') + '">' +
          '<span class="name">' + esc(r.name) + '</span>' +
          '<span class="muted">' + esc(r.role === 'manager' ? 'מדריך/ה' : r.role === 'coordinator' ? 'רכז/ת' : 'לומד/ת') + '</span>' +
          '<span>' + r.submitted + '</span>' +
          '<span>' + r.graded + '</span>' +
          '<span>' + r.pending + '</span>' +
          '<span>' + (r.pendingList.length ? r.pendingList.map(function (p) {
            var lbl = p.kind === 'final' ? 'מבחן מסכם' : (chapterAt(p.ref).chapter.title || p.ref);
            return '<button type="button" class="btn-link" data-act="openGrading" data-arg="' + esc(r.userId) + '|' + esc(p.kind) + '|' + esc(p.ref) + '|' + encodeURIComponent(r.name) + '|' + encodeURIComponent(lbl) + '">' + esc(lbl) + '</button>';
          }).join(' · ') : '—') + '</span></div>';
      }).join('') : '<div class="trow"><span class="muted" style="grid-column:1/-1">אין עדיין תלמידים משויכים אליך.</span></div>') +
      '</div></div></div>' +
      '</div>';
  };

  /* Chapter-manager roster: every learner's status for one specific chapter,
     regardless of who their ordinary mentor is. */
  screens.chapterRoster = function (v) {
    var ref = state.chapterRosterRef || '';
    var chapter = chapterAt(ref).chapter;
    var roster = ensureChapterRoster(ref);
    var loading = roster === 'loading';
    var list = Array.isArray(roster) ? roster : [];
    var outline = chapter.outline || [];
    return '<div class="page" style="gap:20px">' +
      back('admin', 'חזרה לצוות') +
      '<div class="stack s6"><h1 class="h1">' + esc(ref + ' ' + chapter.title) + '</h1>' +
      '<div class="small muted">נוכחות לפי נושא וסטטוס מבחן — כל הלומדים, לא רק הצוות הישיר שלך</div></div>' +
      (loading ? '<div class="card pad small muted">טוען…</div>' :
        '<div class="card clip"><div class="tablewrap"><div class="inner">' +
        '<div class="trow head"><span>לומד/ת</span>' + outline.map(function (o, i) { return '<span>נושא ' + (i + 1) + '</span>'; }).join('') + '<span>מבחן</span></div>' +
        (list.length ? list.map(function (r) {
          return '<div class="trow"><span class="name">' + esc(r.name) + '</span>' +
            outline.map(function (o, i) {
              var present = r.attendance.indexOf(i) !== -1;
              return '<span><button type="button" class="pill' + (present ? ' active' : '') + '" data-act="markAttendance" data-arg="' + esc(r.userId) + '|' + esc(ref) + '|' + i + '|' + (present ? '0' : '1') + '">' + (present ? icon('check') : icon('circle-dashed')) + '</button></span>';
            }).join('') +
            '<span>' + (r.graded
              ? '<span class="tag">נבדק</span>'
              : r.submittedAt
                ? '<button type="button" class="btn-link" data-act="openGrading" data-arg="' + esc(r.userId) + '|chapter|' + esc(ref) + '|' + encodeURIComponent(r.name) + '|' + encodeURIComponent(ref + ' ' + chapter.title) + '">לבדיקה</button>'
                : '<span class="muted tiny">טרם הוגש</span>') + '</span></div>';
        }).join('') : '<div class="trow"><span class="muted" style="grid-column:1/-1">אין לומדים מאושרים במערכת.</span></div>') +
        '</div></div></div>') +
      '</div>';
  };

  /* 18 — בדיקת מבחן (מנהל) */
  screens.managerTest = function (v) {
    var t = v.gradeTarget;
    if (!t) {
      return '<div class="page" style="gap:20px">' + back('admin', 'חזרה לצוות') +
        '<div class="card pad small muted">לא נבחרה הגשה לבדיקה. חזרה לרשימת הצוות ובחירת מבחן לבדיקה משם.</div></div>';
    }
    var sub = v.gradeSubmission;
    if (sub === 'loading' || sub == null) {
      return '<div class="page" style="gap:20px">' + back('admin', 'חזרה לצוות') +
        '<div class="stack s8"><h1 class="h1">' + esc(t.name + ' · ' + t.label) + '</h1></div>' +
        '<div class="card pad small muted">טוען…</div></div>';
    }
    if (sub === 'missing' || sub === 'error') {
      return '<div class="page" style="gap:20px">' + back('admin', 'חזרה לצוות') +
        '<div class="stack s8"><h1 class="h1">' + esc(t.name + ' · ' + t.label) + '</h1></div>' +
        '<div class="card pad small muted">' + (sub === 'missing' ? 'לא נמצאה הגשה — ייתכן שעוד לא הוגשה, או שכבר אין לה קיום.' : 'שגיאה בטעינת ההגשה. נסה/י שוב.') + '</div></div>';
    }

    var answers = Array.isArray(sub.answers) ? sub.answers : [];
    var already = !!sub.feedback_by;
    var submittedDate = sub.submitted_at ? new Date(sub.submitted_at).toLocaleDateString('he-IL') : '';
    var gradedDate = sub.feedback_at ? new Date(sub.feedback_at).toLocaleDateString('he-IL') : '';

    var body = answers.length
      ? answers.map(function (a, i) {
        var existing = already && Array.isArray(sub.feedback)
          ? sub.feedback.filter(function (f) { return f.label === a.label; })[0]
          : null;
        return '<div class="qa"><div class="q">' +
          '<div class="qline"><span class="qno">' + (i + 1) + '</span><span class="qtext">' + esc(a.label) + '</span></div>' +
          '<div class="answer">' + esc(a.value) + '</div></div>' +
          (already
            ? '<div class="fb"><div class="stack s6"><span class="label">משוב</span>' +
              '<span class="val">' + (existing ? esc(existing.value) : 'ללא משוב לשאלה זו') + '</span></div></div>'
            : '<div class="fb"><label class="stack s6"><span class="label">משוב</span>' + textarea(2, '…', '', a.label) + '</label></div>') +
          '</div>';
      }).join('')
      : '<div class="card pad small muted">אין תשובות בהגשה זו.</div>';

    return '<div class="page" style="gap:20px">' +
      back('admin', 'חזרה לצוות') +
      '<div class="stack s8"><div class="kicker accent">' + (already ? 'משוב שניתן — לא ניתן לערוך' : 'מבחן לבדיקה') + '</div>' +
      '<h1 class="h1">' + esc(t.name + ' · ' + t.label) + '</h1>' +
      '<div class="small muted">' + (submittedDate ? 'הוגש ' + esc(submittedDate) : '') +
      (already ? ' · משוב ניתן על ידי ' + esc(sub.feedback_by) + (gradedDate ? ' ב-' + esc(gradedDate) : '') : '') + '</div></div>' +
      '<div style="display:flex;flex-direction:column;gap:14px">' + body + '</div>' +
      (already ? '' :
        '<div class="row"><button type="button" class="btn btn-primary btn-lg" data-act="sendFeedback">' + icon('check') + '<span>שליחת משוב</span></button></div>') +
      '</div>';
  };

  /* 19 — תצפית שדה */
  screens.observation = function (v) {
    var axes = ['תיווך', 'דיוק מקצועי', 'תיעוד', 'גבולות, אתיקה ופרטיות'];
    var levels = ['מתחיל', 'מתפתח', 'עצמאי', 'מוביל'];
    return '<div class="page form">' +
      back('admin', 'חזרה לצוות') +
      '<div class="stack s6"><h1 class="h1">תצפית שדה · ' + esc(v.name) + '</h1>' +
      '<div class="small muted">ממולא בטלפון תוך התצפית · 15 דקות · לפי שיקול המנהל, נרשם בתיק</div></div>' +
      '<div class="card pad stack" style="gap:18px">' +
      '<div class="grid-fields sm">' +
      field('תאריך', '<input class="input" value="היום">') +
      field('הקשר', select(['מפגש פרטני', 'קבוצה', 'פגישת משפחה'])) +
      '</div>' +
      '<div class="stack s14">' +
      axes.map(function (axis, ai) {
        return '<div class="stack s8"><span style="font-size:14px">' + esc(axis) + '</span>' +
          '<div class="scale" role="group" aria-label="' + esc(axis) + '">' +
          levels.map(function (l, li) {
            return '<button type="button" data-act="rubric" data-arg="' + ai + ':' + li + '" aria-pressed="' + (state.rubric[ai] === li) + '">' + esc(l) + '</button>';
          }).join('') + '</div></div>';
      }).join('') +
      '</div>' +
      field('שורת הערה לעובד/ת', textarea(2, 'דבר אחד לשמור, דבר אחד לנסות')) +
      '<button type="button" class="btn btn-primary btn-lg" style="align-self:flex-start" data-act="saveObservation">שמירה לתיק</button>' +
      '</div></div>';
  };

  /* 20 — שיחת סיכום שלב */
  screens.stageMeeting = function (v) {
    return '<div class="page form">' +
      back('admin', 'חזרה לצוות') +
      '<div class="stack s6"><h1 class="h1">שיחת סיכום שלב ' + v.stageIdx + ' · ' + esc(v.name) + '</h1>' +
      '<div class="small muted">20 דקות · תיעוד קצר · נרשם בתיק (השלב הבא כבר פתוח — השיחה אינה חוסמת)</div></div>' +
      '<div class="card pad stack s16">' +
      '<div class="grid-fields sm">' +
      field('מועד', '<input class="input" value="יום ג׳ · 10:00">') +
      field('איפה', select(['פנים אל פנים', 'Zoom'])) +
      '</div>' +
      '<div class="card mutedbg stack s6" style="padding:14px 16px;font-size:13px;color:var(--color-neutral-800)">' +
      '<span class="kicker" style="font-size:12px;letter-spacing:.06em">מה על השולחן</span>' +
      '<span>' + v.testsDone + ' מבחנים עם משוב · ' + v.practiceHours + ' שעות פרקטיקה · ' + v.observations + ' תצפיות · שאלות פתוחות מהמבחנים: 3</span></div>' +
      field('מה נלקח מהשלב', textarea(3, 'שני דברים שהתחזקו, דבר אחד לעבודה בשלב הבא')) +
      '<label class="check"><input type="checkbox"><span>השיחה התקיימה — לרשום בתיק כשיחת סיכום שלב ' + v.stageIdx + '</span></label>' +
      '<button type="button" class="btn btn-primary btn-lg" style="align-self:flex-start" data-act="saveMeeting">שמירה ושליחת סיכום לעובד/ת</button>' +
      '</div></div>';
  };

  /* 21 — סקירת תיק לתעודה */
  screens.fileReview = function (v) {
    return '<div class="page narrow" style="gap:18px">' +
      back('admin', 'חזרה לצוות') +
      '<div class="stack s6"><h1 class="h1">סקירת תיק לתעודה · ' + esc(v.name) + '</h1>' +
      '<div class="small muted">רכז ההדרכה והמנהל הישיר רואים את אותו מסך. התנאים נבדקים אוטומטית — התעודה נשלחת ברגע ששלושתם מסומנים. הערת הסיכום אינה חוסמת.</div></div>' +
      '<div class="card pad stack s14">' +
      '<div class="h4">שלושת התנאים</div>' +
      '<div class="stack">' +
      '<div class="condrow">' + condIcon(v.cond1) + '<span>' + esc(v.cond1Text) + '</span>' +
      '<button type="button" class="btn-link" data-act="go" data-arg="review">לקריאה</button></div>' +
      '<div class="condrow">' + condIcon(v.cond2) + '<span>מבחן מסכם · 12 שאלות · הוגש ונקרא על ידי ' + esc(v.managerName) + '</span>' +
      '<button type="button" class="btn-link" data-act="go" data-arg="final">לקריאה</button></div>' +
      '<div class="condrow">' + condIcon(v.cond3) + '<span>' + esc(v.cond3Text) + '</span>' +
      '<button type="button" class="btn-link" data-act="go" data-arg="file">ליומן</button></div>' +
      '<div class="condrow">' + condIcon(v.cond4) + '<span>' + esc(v.cond4Text) + ' · אוטומטי, ללא אישור</span></div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px" class="small muted">' +
      '<span>תצפיות שדה: ' + v.observations + ' · לפי שיקול המנהל</span>' +
      '<span>שיחות סיכום שלב: ' + v.meetings + ' מתוך 3</span>' +
      '<span>שעות המשך: ' + v.ceHours + '</span></div>' +
      '</div>' +
      (v.done
        ? '<div class="notice" style="border-radius:var(--radius-lg);padding:16px 18px">' + icon('fill:certificate', 'ok') +
        '<span>כל התנאים סומנו ביום 90 · התעודה מס׳ 2026-0417 נוצרה ונשלחה אוטומטית · תוקף ' + esc(v.certValid) + ' · הבונוס נפתח</span></div>'
        : '') +
      '<div class="card pad stack s12">' +
      '<div class="stack s6"><span class="h4">הערת סיכום לתיק</span>' +
      '<span class="small muted">לא חוסמת. נראית לעובד/ת ומצורפת לתעודה.</span></div>' +
      textarea(3, 'שורה-שתיים על המסלול: מה בלט, מה להמשיך לפתח', '', 'הערת סיכום לתיק') +
      '<div class="row">' +
      '<button type="button" class="btn btn-primary" data-act="saveNote">שמירת הערה</button>' +
      '<span class="tiny muted">חתימות: ' + esc(v.managerName) + ' (מנהל) · רכז הדרכה</span></div>' +
      '</div></div>';
  };

  /* 22 — רכז הדרכה */
  screens.coordinator = function (v) {
    ensurePeopleLoaded();
    var peopleCount = myPeople === null ? null : myPeople.length;
    var adminCount = myPeople === null ? null : myPeople.filter(function (p) { return p.isAdmin; }).length;
    return '<div class="page" style="gap:22px">' +
      back('admin', 'חזרה לתצוגת מנהל') +
      '<div class="stack s6"><h1 class="h1">מסך ניהול</h1>' +
      '<div class="small muted">כלי הניהול של מערכת הלמידה — כל הפעולות למטה משפיעות מיידית בצד השרת.</div></div>' +
      '<div class="grid stats">' +
      '<div class="card stat"><span class="label">חשבונות מאושרים</span><span class="value">' + (peopleCount == null ? '…' : peopleCount) + '</span></div>' +
      '<div class="card stat"><span class="label">מנהלי מערכת</span><span class="value">' + (adminCount == null ? '…' : adminCount) + '</span></div>' +
      '<div class="card stat"><span class="label">מבחנים ממתינים (הצוות שלי)</span><span class="value">' + v.waitingTotal + '</span></div>' +
      '</div>' +
      '<div style="max-width:420px;display:flex;flex-direction:column;gap:16px">' +
      '<div class="card pad-sm stack">' +
      '<span class="h4">פעולות</span>' +
      '<button type="button" class="btn btn-primary btn-block" style="justify-content:flex-start" data-act="go" data-arg="curriculum">' + icon('graduation-cap') + '<span>בניית תוכנית הלימודים</span></button>' +
      '<button type="button" class="btn btn-primary btn-block" style="justify-content:flex-start" data-act="go" data-arg="sessionsEdit">' + icon('calendar-plus') + '<span>ניהול השיעורים</span></button>' +
      '<button type="button" class="btn btn-primary btn-block" style="justify-content:flex-start" data-act="go" data-arg="libraryEdit">' + icon('books') + '<span>ניהול מאגר הידע</span></button>' +
      '<button type="button" class="btn btn-primary btn-block" style="justify-content:flex-start" data-act="go" data-arg="peopleAdmin">' + icon('users-three') + '<span>ניהול אנשים · מדריכים, מנהלי פרק ומנהלי מערכת</span></button>' +
      '<button type="button" class="btn btn-primary btn-block" style="justify-content:flex-start" data-act="go" data-arg="cohortsAdmin">' + icon('calendar-check') + '<span>ניהול תקופות</span></button>' +
      '<button type="button" class="btn btn-quiet btn-block" style="justify-content:flex-start" data-act="print">' + icon('file-arrow-down') + '<span>הדפסת המסך הנוכחי</span></button>' +
      '</div></div></div>';
  };

  /* ניהול אנשים — הרשאות מדריך / מנהל פרק / מנהל מערכת. מוגבל למנהל בלבד. */
  screens.peopleAdmin = function (v) {
    ensurePeopleLoaded();
    var list = myPeople;
    if (list === null) return '<div class="page" style="gap:20px">' + back('coordinator', 'חזרה לרכז ההדרכה') + '<div class="card pad small muted">טוען…</div></div>';
    var byId = {};
    list.forEach(function (p) { byId[p.id] = p; });
    var CUR = curriculum();
    var allChapterRefs = [];
    CUR.stages.forEach(function (st, si) {
      (st.chapters || []).forEach(function (c, i) { allChapterRefs.push({ ref: 's:' + si + ':' + i, title: (si + 1) + '.' + (i + 1) + ' ' + asChapter(c).title }); });
    });

    var h = '<div class="page narrow" style="gap:20px">' +
      back('coordinator', 'חזרה לרכז ההדרכה') +
      '<div class="stack s6"><h1 class="h1">ניהול אנשים</h1>' +
      '<div class="small muted">שיוך מדריכים, מנהלי פרק, והענקת הרשאת מנהל מערכת — הכל כאן משפיע מיידית בצד השרת.</div></div>' +
      (list.length ? list.map(function (p) {
        var mentor = p.managerId ? (byId[p.managerId] ? byId[p.managerId].name : p.managerId) : '';
        var chapterChips = p.chapterRefs.map(function (ref) {
          var ch = chapterAt(ref).chapter;
          return '<span class="tag neutral">' + esc(ref + ' ' + ch.title) +
            ' <button type="button" class="btn-link" data-act="removeChapterManager" data-arg="' + esc(p.id) + '|' + esc(ref) + '">✕</button></span>';
        }).join(' ');
        return '<div class="card pad stack s12">' +
          '<div class="row between"><span class="h5">' + esc(p.name) + '</span>' +
          '<span class="tiny muted">' + esc(p.email) + '</span></div>' +
          field('מדריך (מנהל אישי)', '<select class="select" data-act-change="assignMentorSelect" data-arg="' + esc(p.id) + '">' +
            '<option value="">ללא</option>' +
            list.filter(function (o) { return o.id !== p.id; }).map(function (o) {
              return '<option value="' + esc(o.id) + '"' + (p.managerId === o.id ? ' selected' : '') + '>' + esc(o.name) + '</option>';
            }).join('') + '</select>') +
          '<div class="stack s6"><span class="label">מנהל פרק עבור</span>' +
          '<div class="row tight">' + (chapterChips || '<span class="tiny muted">אין</span>') + '</div>' +
          '<select class="select" data-act-change="addChapterManagerSelect" data-arg="' + esc(p.id) + '">' +
            '<option value="">הוספת פרק לניהול…</option>' +
            allChapterRefs.filter(function (c) { return p.chapterRefs.indexOf(c.ref) === -1; }).map(function (c) {
              return '<option value="' + esc(c.ref) + '">' + esc(c.title) + '</option>';
            }).join('') + '</select></div>' +
          '<div class="row tight" style="align-items:center">' +
          '<button type="button" class="pill' + (p.isAdmin ? ' active' : '') + '" data-act="toggleAdmin" data-arg="' + esc(p.id) + '|' + (p.isAdmin ? '0' : '1') + '"' +
          (p.isRoot ? ' disabled' : '') + '>' + (p.isAdmin ? 'מנהל מערכת ✓' : 'הפיכה למנהל מערכת') + '</button>' +
          (p.isRoot ? '<span class="tiny muted">מנהל קבוע — לא ניתן לבטל</span>' : '') +
          '</div>' +
          '<div class="row tight" style="align-items:center;border-top:1px solid var(--color-neutral-300);padding-top:10px">' +
          '<input class="input" type="text" placeholder="סיסמה חדשה (8+ תווים)" style="max-width:220px" data-reset-pw="' + esc(p.id) + '">' +
          '<button type="button" class="btn btn-quiet btn-sm" data-act="resetPassword" data-arg="' + esc(p.id) + '">איפוס סיסמה</button>' +
          (p.isRoot ? '' :
            '<button type="button" class="btn-link" style="color:var(--color-danger-fg,#b42318);margin-inline-start:auto" data-act="deleteAccount" data-arg="' + esc(p.id) + '|' + encodeURIComponent(p.name) + '">' +
            (state.confirmDeleteId === p.id ? 'לחץ שוב לאישור מחיקה' : 'מחיקת חשבון') + '</button>') +
          '</div></div>';
      }).join('') : '<div class="card pad small muted">אין עדיין חשבונות מאושרים.</div>') +
      '</div>';
    return h;
  };

  /* ניהול תקופות ("כיתות") — הענקת חלון 90 הימים לפי קבוצה. מוגבל למנהל בלבד. */
  screens.cohortsAdmin = function (v) {
    ensureCohortsLoaded();
    var list = myCohorts;
    var editingId = state.cohortEditId || '';
    var membersList = editingId ? ensureCohortMembers(editingId) : null;
    ensurePeopleLoaded();

    var h = '<div class="page narrow" style="gap:20px">' +
      back('coordinator', 'חזרה לרכז ההדרכה') +
      '<div class="stack s6"><h1 class="h1">ניהול תקופות</h1>' +
      '<div class="small muted">כל תקופה פותחת את המסלול לפי תאריך ההתחלה שלה — אפשר כמה תקופות יחד, במקביל או ברצף.</div></div>';

    if (list === null) {
      h += '<div class="card pad small muted">טוען…</div></div>';
      return h;
    }

    h += (list.length ? list.map(function (c) {
      var isOpen = editingId === c.id;
      return '<div class="card pad stack s12">' +
        '<div class="row between"><span class="h5">' + esc(c.name) + '</span>' +
        '<button type="button" class="btn-link" data-act="deleteCohort" data-arg="' + esc(c.id) + '">מחיקה</button></div>' +
        '<div class="small muted">התחלה ' + esc(c.startDate) + (c.endDate ? ' · סיום ' + esc(c.endDate) : '') + ' · ' + c.memberCount + ' לומדים</div>' +
        '<button type="button" class="btn btn-quiet btn-sm" style="align-self:flex-start" data-act="cohortEditMembers" data-arg="' + esc(c.id) + '">' +
        (isOpen ? 'סגירת רשימת החברים' : 'עריכת חברי התקופה') + '</button>' +
        (isOpen ? cohortMembersEditor(c.id, membersList) : '') +
        '</div>';
    }).join('') : '<div class="card pad small muted">אין עדיין תקופות.</div>');

    h += '<div class="card pad stack s12">' +
      '<span class="h5">תקופה חדשה</span>' +
      field('שם', '<input class="input" data-bind="newCohortName" value="' + esc(state.newCohortName || '') + '">') +
      '<div class="grid-fields sm">' +
      field('תאריך התחלה', '<input class="input" type="date" data-bind="newCohortStart" value="' + esc(state.newCohortStart || '') + '">') +
      field('תאריך סיום (לא חובה)', '<input class="input" type="date" data-bind="newCohortEnd" value="' + esc(state.newCohortEnd || '') + '">') +
      '</div>' +
      '<button type="button" class="btn btn-primary" style="align-self:flex-start" data-act="saveCohort">' + icon('plus') + '<span>יצירת תקופה</span></button>' +
      '</div></div>';
    return h;
  };

  function cohortMembersEditor(cohortId, membersList) {
    if (membersList === 'loading' || membersList == null) return '<div class="tiny muted">טוען…</div>';
    var memberIds = membersList.map(function (m) { return m.id; });
    var people = myPeople || [];
    return '<div class="stack s8" style="border-top:1px solid var(--color-neutral-300);padding-top:10px">' +
      '<span class="tiny muted">סימון מי שייך לתקופה זו — שמירה מחליפה את כל הרשימה</span>' +
      '<div class="stack s6">' + people.map(function (p) {
        var checked = memberIds.indexOf(p.id) !== -1;
        return '<label class="check"><input type="checkbox" data-cohort-member="' + esc(p.id) + '"' + (checked ? ' checked' : '') + '>' +
          '<span>' + esc(p.name) + '</span></label>';
      }).join('') + '</div>' +
      '<button type="button" class="btn btn-primary btn-sm" style="align-self:flex-start" data-act="saveCohortMembers" data-arg="' + esc(cohortId) + '">שמירת חברי התקופה</button>' +
      '</div>';
  }

  /* 23 — בניית תוכנית הלימודים (רכז הדרכה) */
  screens.curriculum = function (v) {
    var CUR = curriculum();
    var edited = !!state.curriculum;

    function chapterRow(stageIdx, i, title, count, ref, rec) {
      var filled = (rec.summary || rec.video || (rec.outline || []).length);
      var qn = (rec.questions || []).length;
      return '<div class="curline">' +
        '<span class="curno">' + (stageIdx + 1) + '.' + (i + 1) + '</span>' +
        '<input class="input" value="' + esc(title) + '" aria-label="שם הפרק"' +
        ' data-cur="stages.' + stageIdx + '.chapters.' + i + '.title">' +
        '<button type="button" class="btn btn-outline btn-sm chapbtn" data-act="editChapter" data-arg="' + ref + '">' +
        icon('file-doc') + '<span>' + (filled ? 'תוכן' : 'הוספת תוכן') +
        (qn ? ' · ' + qn + ' שאלות' : '') + '</span></button>' +
        '<span class="row tight nowrap" style="gap:4px">' +
        '<button type="button" class="iconbtn" aria-label="הזזה למעלה" ' + (i === 0 ? 'disabled ' : '') +
        'data-act="curMove" data-arg="' + stageIdx + ':' + i + ':-1">' + icon('caret-up') + '</button>' +
        '<button type="button" class="iconbtn" aria-label="הזזה למטה" ' + (i === count - 1 ? 'disabled ' : '') +
        'data-act="curMove" data-arg="' + stageIdx + ':' + i + ':1">' + icon('caret-down') + '</button>' +
        '<button type="button" class="iconbtn" aria-label="מחיקת הפרק" data-act="curRemove" data-arg="' + stageIdx + ':' + i + '">' +
        icon('x') + '</button></span></div>';
    }

    function trackRow(key, i, title, count, rec) {
      var qn = (rec.questions || []).length;
      return '<div class="curline">' +
        '<span class="curno">' + (i + 1) + '</span>' +
        '<input class="input" value="' + esc(title) + '" aria-label="שם הפרק"' +
        ' data-cur="tracks.' + key + '.chapters.' + i + '.title">' +
        '<button type="button" class="btn btn-outline btn-sm chapbtn" data-act="editChapter" data-arg="t:' + key + ':' + i + '">' +
        icon('file-doc') + '<span>תוכן' + (qn ? ' · ' + qn + ' שאלות' : '') + '</span></button>' +
        '<span class="row tight nowrap" style="gap:4px">' +
        '<button type="button" class="iconbtn" aria-label="מחיקת הפרק" data-act="curRemoveTrack" data-arg="' + key + ':' + i + '">' +
        icon('x') + '</button></span></div>';
    }

    var h = '<div class="page narrow" style="gap:20px">' +
      back('coordinator', 'חזרה לרכז ההדרכה') +
      '<div class="row between" style="align-items:flex-end;gap:16px">' +
      '<div class="stack s6"><h1 class="h1">בניית תוכנית הלימודים</h1>' +
      '<div class="small muted">מה שנקבע כאן הוא המסלול שכל עובד רואה — השלבים, הפרקים, ומספר מבחני הפרק שהתעודה דורשת.</div></div>' +
      (edited
        ? '<button type="button" class="btn btn-quiet btn-sm" data-act="curReset">' + icon('clock-clockwise') + '<span>חזרה לתוכנית המקורית</span></button>'
        : '<span class="tag neutral">התוכנית המקורית</span>') +
      '</div>' +

      '<div class="notice quiet">' + icon('shield-check', 'ok') +
      '<span>שינוי התוכנית משפיע על כל הלומדים. פרק שנמחק — המבחן שכבר הוגש עליו נשאר בתיק.</span></div>';

    // stages
    h += '<div class="stack s16">';
    CUR.stages.forEach(function (st, si) {
      var list = (st.byTrack ? [] : (st.chapters || [])).map(asChapter);
      h += '<div class="card pad stack s12">' +
        '<div class="row between"><span class="kicker">שלב ' + (si + 1) + '</span>' +
        (CUR.stages.length > 1
          ? '<button type="button" class="btn-link" data-act="curRemoveStage" data-arg="' + si + '">מחיקת השלב</button>'
          : '') + '</div>' +
        '<div class="grid-fields sm">' +
        field('שם השלב', '<input class="input" value="' + esc(st.title) + '" data-cur="stages.' + si + '.title">') +
        field('טווח ימים', '<input class="input" value="' + esc(st.days) + '" data-cur="stages.' + si + '.days">') +
        '</div>' +
        field('שורת השעות', '<input class="input" value="' + esc(st.hours) + '" data-cur="stages.' + si + '.hours">');

      if (st.byTrack) {
        h += '<div class="notice">' + icon('gift') +
          '<span>השלב הזה נקבע לפי האגף של העובד — הפרקים שלו נערכים למטה, בשני המסלולים.</span></div>';
      } else {
        h += '<div class="stack s8">' +
          '<span class="small muted">פרקים · ' + list.length + '</span>' +
          (list.length
            ? list.map(function (t, i) { return chapterRow(si, i, t.title, list.length, 's:' + si + ':' + i, t); }).join('')
            : '<div class="small muted">אין פרקים בשלב הזה — עובד יעבור אותו בלי מבחן.</div>') +
          '<button type="button" class="uploadbtn" data-act="curAdd" data-arg="' + si + '">' +
          icon('plus') + '<span>הוספת פרק</span></button></div>';
      }
      h += '</div>';
    });
    h += '<button type="button" class="btn btn-quiet" style="align-self:flex-start" data-act="curAddStage">' +
      icon('plus') + '<span>הוספת שלב</span></button></div>';

    // department tracks
    h += '<div class="stack s16">' +
      '<div class="h2">מסלולי האגפים</div>' +
      ['head', 'ptsd'].map(function (key) {
        var tr = CUR.tracks[key];
        var list = (tr.chapters || []).map(asChapter);
        return '<div class="card pad stack s12">' +
          '<div class="grid-fields sm">' +
          field('שם האגף', '<input class="input" value="' + esc(tr.name) + '" data-cur="tracks.' + key + '.name">') +
          field('תיאור קצר', '<input class="input" value="' + esc(tr.blurb || '') + '" data-cur="tracks.' + key + '.blurb">') +
          '</div>' +
          '<div class="stack s8"><span class="small muted">פרקים · ' + list.length + '</span>' +
          list.map(function (t, i) { return trackRow(key, i, t.title, list.length, t); }).join('') +
          '<button type="button" class="uploadbtn" data-act="curAddTrack" data-arg="' + key + '">' +
          icon('plus') + '<span>הוספת פרק</span></button></div></div>';
      }).join('') + '</div>';

    // targets
    h += '<div class="card pad stack s12">' +
      '<span class="h4">תנאי התעודה</span>' +
      '<div class="grid-fields sm">' +
      field('שעות פרקטיקה נדרשות', '<input class="input" type="number" min="0" value="' + esc(CUR.practiceTarget) + '" data-cur="practiceTarget">') +
      field('שעות המשך בשנה', '<input class="input" type="number" min="0" value="' + esc(CUR.ceTarget) + '" data-cur="ceTarget">') +
      field('שאלות במבחן המסכם', '<input class="input" type="number" min="1" value="' + esc(CUR.finalQuestions) + '" data-cur="finalQuestions">') +
      field('שאלות בכל מבחן פרק', '<input class="input" type="number" min="1" value="' + esc(CUR.chapterQuestions) + '" data-cur="chapterQuestions">') +
      '</div>' +
      '<div class="condrow">' + icon('certificate', 'ok') +
      '<span>לפי התוכנית הזו התעודה דורשת <strong>' + v.totalChapters + '</strong> מבחני פרק עם משוב, ' +
      'מבחן מסכם, ו-<strong>' + v.practiceTarget + '</strong> שעות פרקטיקה מאושרות.</span></div>' +
      '</div>';

    // the programme-wide bank, used by any chapter without its own
    var db = CUR.defaultBank || DEFAULT_CURRICULUM.defaultBank;
    h += '<div class="card pad stack s12">' +
      '<div class="stack s6"><span class="h4">מחסן שאלות כללי</span>' +
      '<span class="small muted">משמש כל פרק שעדיין אין לו שאלות משלו. לפרק עם שאלות משלו — הן גוברות.</span></div>' +
      db.map(function (q, i) {
        return '<div class="curline">' +
          '<span class="curno">' + (i + 1) + '</span>' +
          '<input class="input" value="' + esc(q) + '" aria-label="שאלה כללית ' + (i + 1) + '" data-cur="defaultBank.' + i + '">' +
          '<button type="button" class="iconbtn" aria-label="מחיקת השאלה" data-act="curDelDefaultQ" data-arg="' + i + '">' + icon('x') + '</button>' +
          '</div>';
      }).join('') +
      '<button type="button" class="uploadbtn" data-act="curAddDefaultQ">' + icon('plus') + '<span>הוספת שאלה כללית</span></button>' +
      '</div>';

    // final exam bank
    var fb = CUR.finalBank || [];
    h += '<div class="card pad stack s12">' +
      '<div class="stack s6"><span class="h4">מחסן שאלות · מבחן מסכם</span>' +
      '<span class="small muted">כל עובד מקבל ' + (CUR.finalQuestions || 12) + ' שאלות מתוך ' + fb.length + ' שבמחסן.</span></div>' +
      fb.map(function (q, i) {
        return '<div class="curline">' +
          '<span class="curno">' + (i + 1) + '</span>' +
          '<input class="input" value="' + esc(q) + '" aria-label="שאלה ' + (i + 1) + '" data-cur="finalBank.' + i + '">' +
          '<button type="button" class="iconbtn" aria-label="מחיקת השאלה" data-act="curDelFinalQ" data-arg="' + i + '">' + icon('x') + '</button>' +
          '</div>';
      }).join('') +
      '<button type="button" class="uploadbtn" data-act="curAddFinalQ">' + icon('plus') + '<span>הוספת שאלה</span></button>' +
      '</div>';

    h += '<div class="row"><button type="button" class="btn btn-primary btn-lg" data-act="curDone">' +
      icon('check') + '<span>סיימתי</span></button>' +
      '<span class="tiny muted">השינויים נשמרים תוך כדי עריכה.</span></div>';

    return h + '</div>';
  };

  /* 24 — תוכן הפרק ומחסן השאלות (רכז הדרכה) */
  screens.chapterEdit = function (v) {
    var ref = state.editRef;
    var found = chapterAt(ref);
    var c = found.chapter;
    var where = ref.split(':')[0] === 't'
      ? 'מסלול ' + curriculum().tracks[ref.split(':')[1]].name
      : 'שלב ' + (Number(ref.split(':')[1]) + 1);
    var path = ref.split(':')[0] === 't'
      ? 'tracks.' + ref.split(':')[1] + '.chapters.' + found.index
      : 'stages.' + ref.split(':')[1] + '.chapters.' + found.index;

    var h = '<div class="page narrow" style="gap:20px">' +
      back('curriculum', 'חזרה לתוכנית הלימודים') +
      '<div class="stack s6">' +
      '<div class="kicker accent">' + esc(where) + ' · פרק ' + (found.index + 1) + '</div>' +
      '<h1 class="h1">' + esc(c.title || 'פרק ללא שם') + '</h1>' +
      '<div class="small muted">מה שנכתב כאן הוא מה שהעובד רואה בפרק, והשאלות הן המחסן שממנו נשלף המבחן.</div></div>' +

      '<div class="card pad stack s14">' +
      '<span class="h4">השיעור</span>' +
      field('שם הפרק', '<input class="input" value="' + esc(c.title) + '" data-cur="' + path + '.title">') +
      field('תיאור קצר — מופיע מתחת לכותרת', textarea(2, 'על מה הפרק', c.summary).replace('class="textarea"', 'class="textarea" data-cur="' + path + '.summary"')) +
      '<div class="grid-fields sm">' +
      field('אורך בדקות', '<input class="input" type="number" min="1" value="' + esc(c.minutes) + '" data-cur="' + path + '.minutes">') +
      field('קישור לווידאו', '<input class="input ltr" placeholder="https://…" value="' + esc(c.video) + '" data-cur="' + path + '.video">') +
      '</div></div>' +

      '<div class="card pad stack s12">' +
      '<div class="row between"><span class="h4">מה בפרק</span>' +
      '<span class="small muted">' + c.outline.length + ' סעיפים</span></div>' +
      (c.outline.length
        ? c.outline.map(function (line, i) {
            return '<div class="curline">' +
              '<span class="curno">' + (i < 9 ? '0' : '') + (i + 1) + '</span>' +
              '<input class="input" value="' + esc(line) + '" aria-label="סעיף ' + (i + 1) + '"' +
              ' data-cur="' + path + '.outline.' + i + '">' +
              '<button type="button" class="iconbtn" aria-label="מחיקת הסעיף" data-act="chapDelOutline" data-arg="' + i + '">' +
              icon('x') + '</button></div>';
          }).join('')
        : '<div class="small muted">אין עדיין סעיפים.</div>') +
      '<button type="button" class="uploadbtn" data-act="chapAddOutline">' + icon('plus') + '<span>הוספת סעיף</span></button>' +
      '</div>' +

      '<div class="card pad stack s12">' +
      '<div class="row between"><span class="h4">חומרים מצורפים</span>' +
      '<span class="small muted">' + c.materials.length + ' קבצים</span></div>' +
      (c.materials.length
        ? c.materials.map(function (m, i) {
            return '<div class="curline">' +
              '<input class="input" value="' + esc(m.name || '') + '" aria-label="שם הקובץ" placeholder="שם"' +
              ' data-cur="' + path + '.materials.' + i + '.name">' +
              '<input class="input ltr" value="' + esc(m.url || '') + '" aria-label="קישור" placeholder="https://…"' +
              ' data-cur="' + path + '.materials.' + i + '.url">' +
              '<button type="button" class="iconbtn" aria-label="מחיקת הקובץ" data-act="chapDelMaterial" data-arg="' + i + '">' +
              icon('x') + '</button></div>';
          }).join('')
        : '<div class="small muted">אין קבצים מצורפים. אפשר לקשר למצגת או למסמך ב-SharePoint.</div>') +
      '<button type="button" class="uploadbtn" data-act="chapAddMaterial">' + icon('plus') + '<span>הוספת קובץ</span></button>' +
      '</div>' +

      '<div class="card pad stack s12">' +
      '<div class="stack s6"><span class="h4">מחסן השאלות</span>' +
      '<span class="small muted">כל עובד מקבל ' + v.chapterQuestions + ' שאלות מתוך המחסן, בסדר אקראי. ' +
      'צריך לפחות ' + v.chapterQuestions + ' כדי שהמבחן ייפתח.</span></div>' +
      (!c.questions.length
        ? '<div class="notice quiet">' + icon('shield-check', 'ok') +
          '<span>לפרק הזה אין עדיין שאלות משלו, ולכן המבחן נשלף מהמחסן הכללי של התוכנית. ' +
          'ברגע שתוסיפו כאן שאלה אחת — הפרק יעבור להשתמש רק בשאלות שלו.</span></div>'
        : '') +
      (c.questions.length
        ? c.questions.map(function (q, i) {
            return '<div class="qa"><div class="q">' +
              '<div class="row between"><span class="qno">שאלה ' + (i + 1) + '</span>' +
              '<button type="button" class="btn-link" data-act="chapDelQuestion" data-arg="' + i + '">מחיקה</button></div>' +
              textarea(2, 'נוסח השאלה', q).replace('class="textarea"', 'class="textarea" aria-label="נוסח שאלה ' + (i + 1) + '" data-cur="' + path + '.questions.' + i + '"') +
              '</div></div>';
          }).join('')
        : '') +
      '<button type="button" class="uploadbtn" data-act="chapAddQuestion">' + icon('plus') + '<span>הוספת שאלה</span></button>' +
      (c.questions.length && c.questions.length < v.chapterQuestions
        ? '<div class="notice quiet">' + icon('shield-check') + '<span>יש ' + c.questions.length +
          ' שאלות במחסן ודרושות ' + v.chapterQuestions + '. העובדים יקבלו את כל מה שיש.</span></div>'
        : '') +
      '</div>' +

      '<div class="row"><button type="button" class="btn btn-primary btn-lg" data-act="go" data-arg="curriculum">' +
      icon('check') + '<span>סיימתי</span></button>' +
      '<span class="tiny muted">השינויים נשמרים תוך כדי עריכה.</span></div>';

    return h + '</div>';
  };

  /* 25 — ניהול השיעורים (רכז הדרכה) */
  screens.sessionsEdit = function (v) {
    var list = sessions();
    var edited = Array.isArray(state.sessions);

    var h = '<div class="page narrow" style="gap:20px">' +
      back('coordinator', 'חזרה לרכז ההדרכה') +
      '<div class="row between" style="align-items:flex-end;gap:16px">' +
      '<div class="stack s6"><h1 class="h1">ניהול השיעורים</h1>' +
      '<div class="small muted">לוח שיעורי ההעשרה שכל העובדים רואים. שיעור מסומן ״משודר״ נפתח כדף שיעור חי; ״הוקלט״ פותח את דף הצפייה והשאלון.</div></div>' +
      (edited
        ? '<button type="button" class="btn btn-quiet btn-sm" data-act="sessReset">' + icon('clock-clockwise') + '<span>חזרה ללוח המקורי</span></button>'
        : '<span class="tag neutral">הלוח המקורי</span>') + '</div>';

    h += list.map(function (ss, i) {
      var pathBase = 'sessions.' + i + '.';
      return '<div class="card pad stack s12">' +
        '<div class="row between"><span class="kicker">שיעור ' + (i + 1) + '</span>' +
        '<button type="button" class="btn-link" data-act="sessDelete" data-arg="' + i + '">מחיקת השיעור</button></div>' +
        field('כותרת', '<input class="input" value="' + esc(ss.title || '') + '" data-sess="' + pathBase + 'title">') +
        '<div class="grid-fields sm">' +
        field('חודש', '<input class="input" value="' + esc(ss.month || '') + '" data-sess="' + pathBase + 'month">') +
        field('יום בחודש', '<input class="input" value="' + esc(ss.day || '') + '" data-sess="' + pathBase + 'day">') +
        field('יום בשבוע', '<input class="input" value="' + esc(ss.dow || '') + '" data-sess="' + pathBase + 'dow">') +
        '</div>' +
        field('שעה ומקום', '<input class="input" value="' + esc(ss.when || '') + '" data-sess="' + pathBase + 'when">') +
        field('מרצה ופרטים', '<input class="input" value="' + esc(ss.who || '') + '" data-sess="' + pathBase + 'who">') +
        '<div class="grid-fields sm">' +
        field('שעות המשך', '<input class="input" type="number" min="0" step="0.5" value="' + esc(ss.hours || 0) + '" data-sess="' + pathBase + 'hours">') +
        field('קישור Zoom', '<input class="input ltr" placeholder="https://…" value="' + esc(ss.link || '') + '" data-sess="' + pathBase + 'link">') +
        field('קהל', '<select class="select" data-sess="' + pathBase + 'dept">' +
          [['all', 'כל העובדים'], ['head', 'פגועי ראש'], ['ptsd', 'פוסט-טראומה']].map(function (o) {
            return '<option value="' + o[0] + '"' + (String(ss.dept || 'all') === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
          }).join('') + '</select>') +
        '</div>' +
        '<div class="row tight">' +
        '<button type="button" class="pill" data-act="sessFlag" data-arg="' + i + ':live" aria-pressed="' + !!ss.live + '">משודר עכשיו</button>' +
        '<button type="button" class="pill" data-act="sessFlag" data-arg="' + i + ':recorded" aria-pressed="' + !!ss.recorded + '">הוקלט</button>' +
        '</div>' +
        registrantsBlock(ss.id) +
        '</div>';
    }).join('');

    if (!list.length) h += '<div class="card pad small muted">אין עדיין שיעורים בלוח.</div>';

    h += '<button type="button" class="btn btn-primary" style="align-self:flex-start" data-act="sessAdd">' +
      icon('plus') + '<span>הוספת שיעור</span></button>' +
      '<div class="row"><button type="button" class="btn btn-quiet btn-lg" data-act="go" data-arg="coordinator">' +
      icon('check') + '<span>סיימתי</span></button>' +
      '<span class="tiny muted">השינויים נשמרים תוך כדי עריכה.</span></div>';
    return h + '</div>';
  };

  /* 26 — ניהול מאגר הידע (רכז הדרכה) */
  screens.libraryEdit = function (v) {
    var list = assets();
    var edited = Array.isArray(state.assets);

    var h = '<div class="page narrow" style="gap:20px">' +
      back('coordinator', 'חזרה לרכז ההדרכה') +
      '<div class="row between" style="align-items:flex-end;gap:16px">' +
      '<div class="stack s6"><h1 class="h1">ניהול מאגר הידע</h1>' +
      '<div class="small muted">הנכסים שכל העובדים רואים. עובדים יכולים להוסיף נכסים בעצמם — מה שהם מעלים מופיע כאן לתיוג.</div></div>' +
      (edited
        ? '<button type="button" class="btn btn-quiet btn-sm" data-act="libReset">' + icon('clock-clockwise') + '<span>חזרה למאגר המקורי</span></button>'
        : '<span class="tag neutral">המאגר המקורי</span>') + '</div>';

    h += list.map(function (a, i) {
      var b = 'assets.' + i + '.';
      return '<div class="card pad stack s12">' +
        '<div class="row between"><span class="kicker">נכס ' + (i + 1) + '</span>' +
        '<button type="button" class="btn-link" data-act="libDelete" data-arg="' + i + '">מחיקה</button></div>' +
        field('כותרת', '<input class="input" value="' + esc(a.title || '') + '" data-asset="' + b + 'title">') +
        field('תיאור', textarea(2, 'מה יש בנכס', a.desc || '').replace('class="textarea"', 'class="textarea" data-asset="' + b + 'desc"')) +
        '<div class="grid-fields sm">' +
        field('נושא', '<select class="select" data-asset="' + b + 'topic">' +
          TOPICS.map(function (t) {
            return '<option' + (a.topic === t.name ? ' selected' : '') + '>' + esc(t.name) + '</option>';
          }).join('') + '</select>') +
        field('סוג', '<input class="input" value="' + esc(a.kind || '') + '" data-asset="' + b + 'kind">') +
        field('קישור', '<input class="input ltr" placeholder="https://…" value="' + esc(a.url || '') + '" data-asset="' + b + 'url">') +
        '</div>' +
        field('שורת מקור', '<input class="input" value="' + esc(a.meta || '') + '" data-asset="' + b + 'meta">') +
        '</div>';
    }).join('');

    if (!list.length) h += '<div class="card pad small muted">המאגר ריק.</div>';

    h += '<button type="button" class="btn btn-primary" style="align-self:flex-start" data-act="libAdd">' +
      icon('plus') + '<span>הוספת נכס</span></button>' +
      '<div class="row"><button type="button" class="btn btn-quiet btn-lg" data-act="go" data-arg="coordinator">' +
      icon('check') + '<span>סיימתי</span></button>' +
      '<span class="tiny muted">השינויים נשמרים תוך כדי עריכה.</span></div>';
    return h + '</div>';
  };

  /* --------------------------------------------------------------- actions */

  var actions = {
    go: function (arg) { go(arg); },

    // Open one specific chapter's test and feedback.
    review: function (arg) {
      accountOpen = false;
      set({ reviewTarget: arg || '', screen: 'review' }, { top: true });
    },

    chapterRoster: function (arg) {
      accountOpen = false;
      set({ chapterRosterRef: arg || '', screen: 'chapterRoster' }, { top: true });
    },

    // Open one real submission for grading. arg: userId|kind|ref|name|label
    // (name/label are URI-encoded since a display name may contain '|').
    openGrading: function (arg) {
      var parts = String(arg || '').split('|');
      gradeTarget = {
        userId: parts[0], kind: parts[1], ref: parts[2],
        name: decodeURIComponent(parts[3] || ''), label: decodeURIComponent(parts[4] || parts[2])
      };
      accountOpen = false;
      set({ screen: 'managerTest' }, { top: true });
    },

    // Self-reported, unlike topic attendance (mentor/chapter-manager only).
    toggleTopicWatched: function (arg) {
      var parts = String(arg || '').split('|');
      var ref = parts[0], i = Number(parts[1]);
      var list = (state.topicsWatched[ref] || []).slice();
      var at = list.indexOf(i);
      if (at === -1) list.push(i); else list.splice(at, 1);
      state.topicsWatched[ref] = list;
      save();
      render();
    },

    registerSession: function (arg) {
      var ref = String(arg || '');
      if (!ref) return;
      if (!remoteActive()) { toast('אין חיבור לשרת — לא ניתן להירשם כרגע'); return; }
      remoteCall('registerSession', { ref: ref }).then(function () {
        if (mySessionRegs.indexOf(ref) === -1) mySessionRegs.push(ref);
        render();
        toast('נרשמת · תזכורת תישלח יום לפני');
      }).catch(function () { toast('שגיאה בהרשמה — נסה/י שוב'); });
    },

    assignMentorSelect: function (mentorId, el) {
      var learnerId = el.getAttribute('data-arg');
      if (!remoteActive()) { toast('אין חיבור לשרת'); return; }
      var call = mentorId
        ? remoteCall('assignMentor', { learnerId: learnerId, mentorId: mentorId })
        : remoteCall('unassignMentor', { learnerId: learnerId });
      call.then(function () { myPeople = null; render(); toast('עודכן'); })
        .catch(function () { toast('שגיאה בעדכון'); });
    },

    addChapterManagerSelect: function (chapterRef, el) {
      var userId = el.getAttribute('data-arg');
      if (!chapterRef || !remoteActive()) return;
      remoteCall('assignChapterManager', { userId: userId, chapterRef: chapterRef })
        .then(function () { myPeople = null; render(); toast('שויך כמנהל פרק'); })
        .catch(function () { toast('שגיאה בשיוך'); });
    },

    removeChapterManager: function (arg) {
      var parts = String(arg || '').split('|');
      if (!remoteActive()) return;
      remoteCall('removeChapterManager', { userId: parts[0], chapterRef: parts[1] })
        .then(function () { myPeople = null; render(); })
        .catch(function () { toast('שגיאה בהסרה'); });
    },

    toggleAdmin: function (arg) {
      var parts = String(arg || '').split('|');
      var id = parts[0], wantAdmin = parts[1] === '1';
      if (!remoteActive()) return;
      remoteCallAuth('setAdmin', { id: id, isAdmin: wantAdmin })
        .then(function () { myPeople = null; render(); toast(wantAdmin ? 'הוענקה הרשאת מנהל מערכת' : 'הרשאת מנהל מערכת בוטלה'); })
        .catch(function (e) { toast((e && e.body && e.body.error === 'cannot_demote_self') ? 'לא ניתן לבטל את ההרשאה לעצמך' : 'שגיאה בעדכון'); });
    },

    // No self-service "forgot password" flow exists (no email sending is
    // wired up) — an admin sets a new password directly instead.
    resetPassword: function (id) {
      var el = root && root.querySelector('[data-reset-pw="' + id + '"]');
      var pw = el ? el.value : '';
      if (!pw || pw.length < 8) { toast('הסיסמה החדשה חייבת להיות באורך 8 תווים לפחות'); return; }
      if (!remoteActive()) return;
      remoteCallAuth('resetPassword', { id: id, newPassword: pw })
        .then(function () { if (el) el.value = ''; toast('הסיסמה אופסה'); })
        .catch(function () { toast('שגיאה באיפוס הסיסמה'); });
    },

    // Two-click confirm: the button itself shows "press again" the second
    // time, no native confirm() dialog (matches the rest of the app's UI).
    deleteAccount: function (arg) {
      var parts = String(arg || '').split('|');
      var id = parts[0], name = decodeURIComponent(parts[1] || '');
      if (state.confirmDeleteId !== id) { set({ confirmDeleteId: id }); return; }
      if (!remoteActive()) return;
      remoteCallAuth('deleteAccount', { id: id })
        .then(function () { myPeople = null; set({ confirmDeleteId: '' }); toast('החשבון של ' + name + ' נמחק'); })
        .catch(function (e) { toast((e && e.body && e.body.error === 'cannot_delete_self') ? 'לא ניתן למחוק את עצמך' : 'שגיאה במחיקה'); set({ confirmDeleteId: '' }); });
    },

    saveCohort: function () {
      var name = (state.newCohortName || '').trim();
      var startDate = state.newCohortStart || '';
      var endDate = state.newCohortEnd || '';
      if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) { toast('צריך שם ותאריך התחלה תקין'); return; }
      if (!remoteActive()) { toast('אין חיבור לשרת'); return; }
      remoteCall('saveCohort', { name: name, startDate: startDate, endDate: endDate || undefined }).then(function () {
        myCohorts = null;
        set({ newCohortName: '', newCohortStart: '', newCohortEnd: '' });
        toast('התקופה נוצרה');
      }).catch(function () { toast('שגיאה ביצירת התקופה'); });
    },

    deleteCohort: function (arg) {
      if (!remoteActive()) return;
      remoteCall('deleteCohort', { id: arg }).then(function () { myCohorts = null; render(); toast('התקופה נמחקה'); })
        .catch(function () { toast('שגיאה במחיקה'); });
    },

    cohortEditMembers: function (arg) {
      set({ cohortEditId: state.cohortEditId === arg ? '' : arg });
    },

    saveCohortMembers: function (arg) {
      var cohortId = arg;
      var boxes = root ? root.querySelectorAll('[data-cohort-member]') : [];
      var userIds = [];
      for (var i = 0; i < boxes.length; i++) if (boxes[i].checked) userIds.push(boxes[i].getAttribute('data-cohort-member'));
      if (!remoteActive()) { toast('אין חיבור לשרת'); return; }
      remoteCall('setCohortMembers', { cohortId: cohortId, userIds: userIds }).then(function () {
        delete cohortMembersCache[cohortId];
        myCohorts = null;
        render();
        toast('רשימת התקופה נשמרה');
      }).catch(function () { toast('שגיאה בשמירה'); });
    },

    // Attendance is never self-reported — only reachable from the
    // chapter-manager roster. arg: learnerId|chapterRef|topicIndex|present(0/1)
    markAttendance: function (arg) {
      var parts = String(arg || '').split('|');
      var learnerId = parts[0], chapterRef = parts[1], topicIndex = Number(parts[2]), present = parts[3] === '1';
      if (!remoteActive()) { toast('אין חיבור לשרת'); return; }
      remoteCall('markTopicAttendance', { learnerId: learnerId, chapterRef: chapterRef, topicIndex: topicIndex, present: present })
        .then(function () { delete chapterRosters[chapterRef]; render(); })
        .catch(function () { toast('שגיאה בסימון הנוכחות'); });
    },

    preview: function (arg) { set({ preview: arg }); },

    lang: function (arg) { accountOpen = true; set({ lang: arg }); },

    reset: function () {
      var keep = { preview: state.preview, lang: state.lang };
      for (var k in defaults) state[k] = defaults[k];
      state.preview = keep.preview; state.lang = keep.lang;
      save();
      render({ top: true });
      toast('הדמו אופס — יום 1, לפני הרשמה');
    },

    advanceDay: function () {
      var v = derive();
      var next = v.nextDay;
      set({
        day: next, registered: next > 1, screen: next > 1 ? 'home' : 'register',
        testSubmitted: false, practiceAdded: false, quizDone: false, readNotifs: false
      }, { top: true });
      toast(next === 1 ? 'חזרה ליום 1 — הדמו מתחיל מחדש' : 'קפצנו ליום ' + next);
    },

    dept: function (arg) { set({ dept: arg }); },

    register: function () {
      set({ registered: true, screen: 'home' }, { top: true });
      toast('מסלול ההכשרה נפתח — 90 יום');
    },

    submitTest: function () {
      var v = derive();
      var prefix = 'test/' + v.current.id + '|';
      var answers = formsFor(prefix);
      state.submissions['chapter:' + v.current.id] = {
        chapter: v.current.id, title: v.current.title, day: v.day,
        answers: answers
      };
      set({ testSubmitted: true, screen: 'home' }, { top: true });
      if (remoteActive()) {
        remoteCall('submit', { kind: 'chapter', ref: v.current.ref, answers: answers })
          .catch(function () { /* stays in the local record; nothing else retries this one */ });
      }
      toast('המבחן נשלח ל' + MANAGER + ' · התשובות נשמרו בתיק');
    },

    submitFinal: function () {
      var v = derive();
      var answers = formsFor('final/|');
      state.submissions.final = { day: v.day, answers: answers };
      save();
      render();
      if (remoteActive()) {
        remoteCall('submit', { kind: 'final', ref: 'final', answers: answers })
          .catch(function () { /* stays in the local record; nothing else retries this one */ });
      }
      toast('המבחן המסכם הוגש ל' + MANAGER + ' · התשובות נשמרו');
    },

    addPractice: function () {
      var v = derive();
      var dur = formValue('practiceNew', 'משך', 'שעה וחצי');
      var hours = { 'שעה': 1, 'שעה וחצי': 1.5, 'שעתיים': 2, 'חצי יום': 4 }[dur] || 1.5;
      state.practiceEntries.push({
        date: formValue('practiceNew', 'תאריך', 'היום'),
        hours: hours,
        stage: formValue('practiceNew', 'שלב', 'שלב ' + v.stageIdx),
        sup: formValue('practiceNew', 'מי ליווה', MANAGER),
        tool: formValue('practiceNew', 'מכשיר', 'תרגול קשב'),
        note: formValue('practiceNew', 'הערה', ''),
        approved: false
      });
      clearForms('practiceNew/');
      set({ screen: 'file' }, { top: true });
      toast(hours + ' שעות נרשמו · ממתין לאישור ' + MANAGER);
    },

    submitQuiz: function () {
      state.submissions.sessionQuiz = { day: state.day, answers: formsFor('sessionAfter/|') };
      set({ quizDone: true });
      toast('2 שעות המשך נזקפו לפנקס');
    },

    relevance: function (arg) { set({ relevance: Number(arg) }); },

    uploadPrivate: function (arg) { set({ uploadPrivate: arg === '1' }); },

    publishAsset: function () {
      var v = derive();
      var title = formValue('upload', 'כותרת', '');
      if (!title.trim()) { toast('צריך כותרת לפני פרסום'); return; }
      state.userAssets.unshift({
        id: 'u' + Date.now(),
        title: title,
        topic: formValue('upload', 'נושא', TOPICS[1].name),
        kind: formValue('upload', 'סוג', 'מסמך'),
        audience: formValue('upload', 'קהל', 'מדריכים'),
        by: v.name, day: v.day
      });
      clearForms('upload/');
      set({ screen: 'library', libTab: 'assets', uploadPrivate: false }, { top: true });
      toast('״' + title + '״ פורסם למאגר');
    },

    libTab: function (arg) { set({ libTab: arg }); },
    libTopic: function (arg) { set({ libTopic: arg }); },
    libSort: function (arg) { set({ libSort: arg }); },
    scheduleFilter: function (arg) { set({ scheduleFilter: arg }); },

    rubric: function (arg) {
      var parts = arg.split(':');
      var r = state.rubric.slice();
      r[Number(parts[0])] = Number(parts[1]);
      set({ rubric: r });
    },

    saveObservation: function () {
      var v = derive();
      state.records.observations.push({
        day: v.day, stage: v.stageIdx,
        date: formValue('observation', 'תאריך', 'היום'),
        context: formValue('observation', 'הקשר', 'מפגש פרטני'),
        levels: state.rubric.slice(),
        note: formValue('observation', 'הערה', '')
      });
      clearForms('observation/');
      set({ screen: 'admin' }, { top: true });
      toast('התצפית נשמרה בתיק של ' + v.first);
    },

    saveMeeting: function () {
      var v = derive();
      state.records.meetings.push({
        day: v.day, stage: v.stageIdx,
        when: formValue('stageMeeting', 'מועד', 'יום ג׳ · 10:00'),
        where: formValue('stageMeeting', 'איפה', 'פנים אל פנים'),
        takeaway: formValue('stageMeeting', 'מה נלקח', '')
      });
      clearForms('stageMeeting/');
      set({ screen: 'admin' }, { top: true });
      toast('סיכום השיחה נשלח ל' + v.first);
    },

    sendFeedback: function () {
      var t = gradeTarget;
      if (!t) { toast('אין הגשה נבחרת'); return; }
      var prefix = 'managerTest/' + t.userId + '/' + t.kind + '/' + t.ref + '|';
      var written = formsFor(prefix);
      if (!written.length) { toast('אין עדיין מה לשלוח — כתוב/כתבי משוב לפחות לשאלה אחת'); return; }
      if (!remoteActive()) { toast('אין חיבור לשרת — לא ניתן לשלוח משוב'); return; }
      remoteCall('feedback', { userId: t.userId, kind: t.kind, ref: t.ref, feedback: written }).then(function () {
        clearForms(prefix);
        delete gradingSub[t.userId + '|' + t.kind + '|' + t.ref];
        delete chapterRosters[t.ref];
        myTeam = null;
        gradeTarget = null;
        set({ screen: 'admin' }, { top: true });
        toast('המשוב נשלח ונשמר בתיק');
      }).catch(function (e) {
        if (e && e.status === 409) {
          toast('כבר ניתן משוב על ידי ' + ((e.body && e.body.feedbackBy) || 'מישהו אחר'));
          delete gradingSub[t.userId + '|' + t.kind + '|' + t.ref];
          render();
        } else {
          toast('שגיאה בשליחת המשוב — נסה/י שוב');
        }
      });
    },

    saveNote: function () {
      var v = derive();
      var text = formValue('fileReview', 'שורה-שתיים', '');
      if (!text.trim()) { toast('אין מה לשמור — ההערה ריקה'); return; }
      state.records.notes.push({ day: v.day, by: MANAGER, text: text });
      clearForms('fileReview/');
      set({ screen: 'admin' }, { top: true });
      toast('הערת הסיכום נשמרה בתיק');
    },

    /* -------------------------------------------------- curriculum builder */

    curAdd: function (arg) {
      var c = editableCurriculum();
      c.stages[Number(arg)].chapters.push(asChapter('פרק חדש'));
      set({}, { top: false });
    },

    curRemove: function (arg) {
      var p = arg.split(':'), c = editableCurriculum();
      c.stages[Number(p[0])].chapters.splice(Number(p[1]), 1);
      set({});
    },

    curMove: function (arg) {
      var p = arg.split(':'), c = editableCurriculum();
      var list = c.stages[Number(p[0])].chapters;
      var from = Number(p[1]), to = from + Number(p[2]);
      if (to < 0 || to >= list.length) return;
      var moved = list.splice(from, 1)[0];
      list.splice(to, 0, moved);
      set({});
    },

    curAddStage: function () {
      var c = editableCurriculum();
      c.stages.push({ title: 'שלב חדש', days: '', hours: '', chapters: [asChapter('פרק חדש')] });
      set({});
    },

    curRemoveStage: function (arg) {
      var c = editableCurriculum();
      if (c.stages.length <= 1) { toast('חייב להישאר לפחות שלב אחד'); return; }
      c.stages.splice(Number(arg), 1);
      set({});
    },

    curAddTrack: function (arg) {
      var c = editableCurriculum();
      c.tracks[arg].chapters.push(asChapter('פרק חדש'));
      set({});
    },

    curRemoveTrack: function (arg) {
      var p = arg.split(':'), c = editableCurriculum();
      c.tracks[p[0]].chapters.splice(Number(p[1]), 1);
      set({});
    },

    editChapter: function (arg) {
      set({ editRef: arg, screen: 'chapterEdit' }, { top: true });
    },

    chapAddOutline: function () { chapterFor(state.editRef).outline.push(''); set({}); },
    chapDelOutline: function (i) { chapterFor(state.editRef).outline.splice(Number(i), 1); set({}); },
    chapAddMaterial: function () { chapterFor(state.editRef).materials.push({ name: '', url: '' }); set({}); },
    chapDelMaterial: function (i) { chapterFor(state.editRef).materials.splice(Number(i), 1); set({}); },
    chapAddQuestion: function () { chapterFor(state.editRef).questions.push(''); set({}); },
    chapDelQuestion: function (i) { chapterFor(state.editRef).questions.splice(Number(i), 1); set({}); },

    curAddDefaultQ: function () {
      var c = editableCurriculum();
      if (!Array.isArray(c.defaultBank)) c.defaultBank = DEFAULT_CURRICULUM.defaultBank.slice();
      c.defaultBank.push('');
      set({});
    },
    curDelDefaultQ: function (i) {
      var c = editableCurriculum();
      if (!Array.isArray(c.defaultBank)) c.defaultBank = DEFAULT_CURRICULUM.defaultBank.slice();
      c.defaultBank.splice(Number(i), 1);
      set({});
    },

    curAddFinalQ: function () {
      var c = editableCurriculum();
      if (!Array.isArray(c.finalBank)) c.finalBank = [];
      c.finalBank.push('');
      set({});
    },
    curDelFinalQ: function (i) {
      var c = editableCurriculum();
      c.finalBank.splice(Number(i), 1);
      set({});
    },

    curReset: function () {
      state.curriculum = null;
      save();
      render();
      toast('התוכנית חזרה למקור');
    },

    curDone: function () {
      set({ screen: 'coordinator' }, { top: true });
      toast('תוכנית הלימודים עודכנה');
    },

    /* ------------------------------------------------ sessions and library */

    sessAdd: function () {
      editableSessions().push({ id: 'n' + Date.now(), month: 'ספטמבר', day: '1', dow: 'יום א׳',
        when: '16:00–17:00 · Zoom', title: 'שיעור חדש', who: '', hours: 1, dept: 'all', link: '' });
      set({});
    },
    sessDelete: function (i) { editableSessions().splice(Number(i), 1); set({}); },
    sessFlag: function (arg) {
      var p = arg.split(':'), list = editableSessions(), ss = list[Number(p[0])];
      ss[p[1]] = !ss[p[1]];
      // A session cannot be broadcasting and already recorded at once.
      if (p[1] === 'live' && ss.live) ss.recorded = false;
      if (p[1] === 'recorded' && ss.recorded) ss.live = false;
      set({});
    },
    sessReset: function () { state.sessions = null; save(); render(); toast('הלוח חזר למקור'); },

    libAdd: function () {
      editableAssets().unshift({ id: 'n' + Date.now(), icon: 'file-doc', kind: 'מסמך', kindClass: '',
        uses: 0, fresh: 0, title: 'נכס חדש', desc: '', topic: TOPICS[0].name, meta: '', url: '' });
      set({});
    },
    libDelete: function (i) { editableAssets().splice(Number(i), 1); set({}); },
    libReset: function () { state.assets = null; save(); render(); toast('המאגר חזר למקור'); },

    print: function () { window.print(); },

    account: function () { accountOpen = !accountOpen; render(); },

    signOut: function () {
      accountOpen = false;
      // Clear this user's local data so the next person to sign in on this
      // device starts clean — otherwise the previous user's name and data
      // linger (the auth token alone lives under a different key). For a real
      // account the server copy is the source of truth and re-hydrates on the
      // next sign-in; the demo entrance simply starts fresh.
      try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
      state = load();
      if (authApi && authApi.signOut) authApi.signOut();
      else location.reload();
    },

    toast: function (arg) { toast(arg); }
  };

  /* ------------------------------------------------------------ form state

     Every field on every screen is persisted without each screen having to
     opt in. After a render, each input/select/textarea is given a stable key
     built from the screen, the instance it belongs to (which chapter's test,
     whose file) and the field's own label — so the same question keeps its
     answer, and the same question on a different chapter does not collide.
     Values are written back on input, which never re-renders, so typing is
     never interrupted. */

  function instanceOf(v) {
    switch (v.screen) {
      case 'test': case 'lesson': return v.current.id;
      case 'review': return v.reviewChapter.id;
      case 'managerTest': return v.gradeTarget ? (v.gradeTarget.userId + '/' + v.gradeTarget.kind + '/' + v.gradeTarget.ref) : '';
      case 'observation': case 'stageMeeting': case 'fileReview': return v.name + '/' + v.stageIdx;
      default: return '';
    }
  }

  function labelOf(el) {
    var lab = el.closest('label');
    var text = '';
    if (lab) {
      // The label's own words only. Reading textContent directly would sweep
      // in whatever is typed into the field, and the key would then change on
      // every keystroke — orphaning what was already saved.
      var copy = lab.cloneNode(true);
      var controls = copy.querySelectorAll('input, select, textarea');
      for (var i = 0; i < controls.length; i++) controls[i].remove();
      text = (copy.textContent || '').trim();
    }
    if (!text) {
      var q = el.closest('.qa, .card, .stack');
      var qt = q && q.querySelector('.qtext, .label');
      if (qt) text = qt.textContent.trim();
    }
    if (!text) text = el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.tagName;
    return text.replace(/\s+/g, ' ').slice(0, 60);
  }

  function fieldKey(v, el, seen) {
    var base = v.screen + '/' + instanceOf(v) + '|' + labelOf(el);
    seen[base] = (seen[base] || 0) + 1;
    return base + '#' + seen[base];
  }

  function bindForms(v) {
    var seen = {};
    var fields = root.querySelectorAll('input, select, textarea');
    for (var i = 0; i < fields.length; i++) {
      var el = fields[i];
      if (el.getAttribute('data-bind')) continue;      // handled separately (the name field)
      if (el.getAttribute('data-cur')) continue;       // the curriculum builder writes by path
      if (el.getAttribute('data-sess') || el.getAttribute('data-asset')) continue;
      if (el.closest('.demobar')) continue;
      var key = fieldKey(v, el, seen);
      el.setAttribute('data-field', key);
      if (!(key in state.forms)) continue;
      var saved = state.forms[key];
      if (el.type === 'checkbox') el.checked = !!saved;
      else if (saved !== '' && saved != null) el.value = saved;
    }
  }

  /* Reads a saved field by screen and a fragment of its label. */
  function formValue(screenName, labelFragment, fallback) {
    for (var k in state.forms) {
      if (k.indexOf(screenName + '/') !== 0) continue;
      if (k.indexOf(labelFragment) === -1) continue;
      var val = state.forms[k];
      if (val !== '' && val != null) return val;
    }
    return fallback === undefined ? '' : fallback;
  }

  /* All saved answers for one screen instance, in the order they appear. */
  function formsFor(prefix) {
    return Object.keys(state.forms)
      .filter(function (k) { return k.indexOf(prefix) === 0; })
      .map(function (k) { return { key: k, label: k.split('|')[1].replace(/#\d+$/, ''), value: state.forms[k] }; })
      .filter(function (e) { return String(e.value).trim() !== ''; });
  }

  function clearForms(prefix) {
    Object.keys(state.forms).forEach(function (k) { if (k.indexOf(prefix) === 0) delete state.forms[k]; });
  }

  /* ----------------------------------------------------------------- toast */

  var toastTimer = null;
  function toast(msg) {
    var el = document.getElementById('toast');
    if (!el || !msg) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }

  /* ---------------------------------------------------------------- render */

  var root = null;

  function render(opts) {
    opts = opts || {};
    if (!root) root = document.getElementById('root');
    var v = derive();

    document.documentElement.lang = v.lang === 'en' ? 'en' : 'he';
    document.documentElement.dir = 'rtl'; // content is authored in Hebrew in both modes
    document.body.classList.toggle('preview-phone', state.preview === 'phone');

    var screenFn = screens[v.screen] || screens.home;
    var body = screenFn(v);

    var html = demobar(v) +
      '<div class="shell"><div class="app">' +
      (v.isPhone ? mobilebar(v) : topbar(v)) +
      body +
      (v.isPhone ? tabbar(v) : '') +
      '</div></div>';

    root.innerHTML = html;
    bindForms(v);

    if (opts.top && typeof window !== 'undefined') window.scrollTo(0, 0);
    document.title = (v.titles[v.screen] ? v.titles[v.screen] + ' · ' : '') + 'מכון פוירשטיין · מערכת הלמידה';
  }

  /* ---------------------------------------------------------------- events */

  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!el) return;
    if (el.tagName === 'FORM') return;
    var act = el.getAttribute('data-act');
    var fn = actions[act];
    if (!fn) return;
    e.preventDefault();
    fn(el.getAttribute('data-arg'));
  });

  // A small number of admin screens (assign mentor, assign chapter manager)
  // are more usable as a <select> than as a row of pill buttons — this is
  // the one place a change event drives an action rather than saved state.
  document.addEventListener('change', function (e) {
    var el = e.target.closest ? e.target.closest('[data-act-change]') : null;
    if (!el) return;
    var fn = actions[el.getAttribute('data-act-change')];
    if (!fn) return;
    fn(el.value, el);
  });

  document.addEventListener('submit', function (e) {
    var el = e.target.closest ? e.target.closest('[data-act="ask"]') : null;
    if (!el) return;
    e.preventDefault();
    var input = el.querySelector('input');
    if (input && input.value.trim()) {
      toast('השאלה נשלחה למרצה');
      input.value = '';
    }
  });

  /* Inputs write straight to state without re-rendering, so typing is never
     interrupted and nothing is lost to a refresh. */
  /* Writes a value into a nested structure by dotted path, without a
     re-render — so editing a title never steals focus. */
  function writePath(rootObj, path, el) {
    var parts = path.split('.');
    var node = rootObj;
    for (var i = 0; i < parts.length - 1; i++) node = node[parts[i]];
    var last = parts[parts.length - 1];
    node[last] = el.type === 'number' ? (Number(el.value) || 0) : el.value;
    save();
  }

  function captureField(e) {
    var el = e.target;
    if (!el || !el.getAttribute) return;

    var bound = el.getAttribute('data-bind');
    if (bound) { state[bound] = el.value; save(); return; }

    var sessPath = el.getAttribute('data-sess');
    if (sessPath) { writePath(editableSessions(), sessPath.replace(/^sessions\./, ''), el); return; }

    var assetPath = el.getAttribute('data-asset');
    if (assetPath) { writePath(editableAssets(), assetPath.replace(/^assets\./, ''), el); return; }

    var path = el.getAttribute('data-cur');
    if (path) {
      // Written without a re-render, so an edit never interrupts typing.
      var c = editableCurriculum();
      var parts = path.split('.');
      var node = c;
      for (var i = 0; i < parts.length - 1; i++) node = node[parts[i]];
      var last = parts[parts.length - 1];
      node[last] = el.type === 'number' ? (Number(el.value) || 0) : el.value;
      save();
      return;
    }

    var key = el.getAttribute('data-field');
    if (!key) return;
    state.forms[key] = el.type === 'checkbox' ? el.checked : el.value;
    save();
  }
  document.addEventListener('input', captureField);
  document.addEventListener('change', captureField);

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    if (state.preview !== 'auto') return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { render(); }, 150);
  });

  /* ------------------------------------------------------------------ boot

     auth.js gates the page and calls boot() once someone is signed in. When
     this file is opened on its own, with no gate present, it still starts —
     so the app stays usable as a standalone file. */

  window.FeuersteinLearn = {
    boot: function (user, api) {
      currentUser = user || null;
      authApi = api || null;
      // If a different account is now signed in than the data on this device
      // belongs to, start that user clean so no one sees another user's data.
      if (currentUser && currentUser.email && state.userEmail && state.userEmail !== currentUser.email) {
        try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
        state = load();
      }
      if (currentUser && currentUser.name) {
        // Someone who signed in with a real account has already identified
        // themselves; carry the name in and skip the demo registration form.
        state.name = currentUser.name;
        state.userEmail = currentUser.email || '';
        if (state.screen === 'register') { state.registered = true; state.screen = 'home'; }
        save();
      }
      render();
      // If this is a real Microsoft session, hydrate from the server; the local
      // cache above is shown first so the app is instant, then replaced by the
      // server copy when it arrives. Inert for the demo entrance.
      remotePull();
    }
  };

  if (!window.FP_GATED) render();
})();
