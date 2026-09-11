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
    userAssets: []
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
    // When signed in with a real Microsoft account, mirror it to the server too.
    remotePush();
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
    if (!res.ok || json.ok === false) throw new Error((json && json.error) || ('http-' + res.status));
    return json;
  }

  // Pull the learner's saved state from the server and merge it over what is in
  // memory, then re-render. Server wins for any key it carries.
  async function remotePull() {
    if (!remoteActive()) return;
    try {
      var r = await remoteCall('load', {});
      var data = (r && r.state && typeof r.state === 'object') ? r.state : null;
      if (data) {
        for (var key in data) if (key in defaults) state[key] = data[key];
        normalizeState(state);
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
        render();
      }
    } catch (e) {
      // Offline, or Entra/gateway not configured yet: keep the local cache.
    }
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

  function go(screen) {
    accountOpen = false;
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

  function sessions() { return Array.isArray(state.sessions) ? state.sessions : DEFAULT_SESSIONS; }
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

    var day = state.day;
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

    function mk(list, no) {
      return list.map(function (raw, i) {
        var content = asChapter(raw);
        var title = content.title;
        var st = 'locked';
        if (done || no < stageIdx) {
          st = (!done && no === stageIdx - 1 && i === list.length - 1) ? 'submitted' : 'done';
        } else if (no === stageIdx) {
          st = i === 0 ? (state.testSubmitted ? 'submitted' : 'current') : 'locked';
        }
        var notes = st === 'done' ? (i % 2 === 0 ? 2 : 0) : 0;
        return {
          id: no + '.' + (i + 1), title: title, no: no, status: st,
          content: content, ref: refOf(no - 1, i),
          done: st === 'done', submitted: st === 'submitted',
          current: st === 'current', locked: st === 'locked',
          hasNotes: notes > 0, notes: notes,
          icon: st === 'done' ? 'fill:check-circle' : st === 'submitted' ? 'hourglass-medium' : st === 'current' ? 'play-circle' : 'circle-dashed',
          iconColor: (st === 'done' || st === 'current') ? 'var(--color-accent-700)' : 'var(--color-neutral-700)',
          textColor: st === 'locked' ? 'var(--color-neutral-700)' : 'var(--color-neutral-900)',
          statusText: st === 'done' ? 'נבדק · ' + (notes ? notes + ' הערות' : 'ללא הערות')
            : st === 'submitted' ? 'ממתין למשוב ' + managerName
              : st === 'current' ? 'הפרק הבא' : 'נעול'
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

    // What the manager opens: the learner's own most recent hand-in that has
    // no feedback yet, falling back to the seeded one that is waiting.
    var pendingId = Object.keys(state.submissions)
      .filter(function (k) { return k.indexOf('chapter:') === 0; })
      .map(function (k) { return k.slice(8); })
      .filter(function (id) { return !state.feedback[id]; })
      .pop();
    var toMark = chapters.filter(function (c) { return c.id === pendingId; })[0] || current;
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

    var team = [
      { name: name + ' · ' + deptName, stage: stageLabel, delay: 0, waiting: testsSubmitted, hours: practiceHours, ce: ceHours, cert: done ? 'עד 12/2028' : '—', watch: done ? '—' : '92%', mine: true },
      { name: 'דנה שרון · פגועי ראש', stage: '3 · אגף', delay: 0, waiting: 1, hours: 44, ce: 6, cert: '—', watch: '88%' },
      { name: 'עומר בר · פוסט-טראומה', stage: '1 · פוירשטיין', delay: 9, waiting: 0, hours: 6, ce: 0, cert: '—', watch: '41%' },
      { name: 'מיכל אזולאי · פגועי ראש', stage: '2 · שיקום', delay: 0, waiting: 0, hours: 31, ce: 3.5, cert: '—', watch: '95%' },
      { name: 'יוסי טל · פוסט-טראומה', stage: 'בונוס', delay: 0, waiting: 0, hours: 60, ce: 12, cert: 'עד 03/2028', watch: '—' }
    ].map(function (r) {
      r.delayText = r.delay ? 'בפיגור ' + r.delay + ' ימים' : 'בקצב';
      r.delayColor = r.delay ? 'var(--color-warn-fg)' : 'var(--color-accent-700)';
      return r;
    });
    var waitingTotal = team.reduce(function (a, r) { return a + r.waiting; }, 0);

    var titles = {
      register: 'הרשמה', home: T.home, lesson: 'פרק ' + current.id, test: 'מבחן הפרק',
      review: 'משוב מנהל', final: 'מבחן מסכם', file: T.file, practiceNew: 'רשומת פרקטיקה',
      notifications: T.notif, search: 'חיפוש', schedule: T.schedule, session: 'דף שיעור',
      sessionAfter: 'דף שיעור', library: T.library, upload: 'העלאה למאגר', asset: 'נכס ידע',
      admin: T.admin, curriculum: 'תוכנית הלימודים', chapterEdit: 'תוכן הפרק', sessionsEdit: 'ניהול השיעורים', libraryEdit: 'ניהול המאגר', managerTest: 'בדיקת מבחן', observation: 'תצפית שדה',
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
      toMark: toMark,
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
    admin: ['admin', 'managerTest', 'observation', 'stageMeeting', 'fileReview', 'coordinator', 'curriculum', 'chapterEdit', 'sessionsEdit', 'libraryEdit']
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
      '<div class="stack" style="font-size:14px;color:var(--color-neutral-800)">' +
      outline.map(function (line, i) {
        var no = (i < 9 ? '0' : '') + (i + 1);
        return '<div style="display:flex;gap:10px"><span style="color:var(--color-accent-700);font-family:var(--font-heading)">' + no + '</span><span>' + esc(line) + '</span></div>';
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
    // Once this learner has actually submitted this chapter, show what they
    // wrote and what their manager wrote back — not the worked example.
    var own = v.ownSubmissions['chapter:' + v.reviewChapter.id];
    var ownFb = v.ownFeedback[v.reviewChapter.id];

    function qa(no, q, a, fb) {
      return '<div class="qa"><div class="q">' +
        '<div class="qline"><span class="qno">' + no + '</span><span class="qtext">' + esc(q) + '</span></div>' +
        '<div class="answer">' + esc(a) + '</div></div>' +
        (fb
          ? '<div class="fb"><div class="grid feedback">' +
          '<div class="stack s6"><span class="label">מה עבד</span><span class="val">' + esc(fb[0]) + '</span></div>' +
          '<div class="stack s6"><span class="label">מה לחדד</span><span class="val">' + esc(fb[1]) + '</span></div>' +
          '<div class="stack s6"><span class="label">שאלה להמשך</span><span class="val">' + esc(fb[2]) + '</span></div>' +
          '</div></div>'
          : '<div class="none">' + icon('check') + '<span>ללא הערה</span></div>') +
        '</div>';
    }

    if (own) {
      var fbNotes = ownFb ? ownFb.notes : [];
      return '<div class="page read">' +
        back('file', 'חזרה לתיק שלי') +
        '<div class="stack s8">' +
        '<div class="row tight">' +
        '<span class="kicker accent">מבחן פרק · ' + esc(own.chapter + ' ' + own.title) + '</span>' +
        (ownFb
          ? '<span class="tag">נבדק · ' + fbNotes.length + ' הערות</span>'
          : '<span class="tag neutral">ממתין למשוב ' + esc(v.managerName) + '</span>') + '</div>' +
        '<h1 class="h1">' + (ownFb ? 'התשובות שלך והמשוב של ' + esc(v.managerName) : 'התשובות שלך') + '</h1>' +
        '<div class="small muted">הוגש ביום ' + own.day + (ownFb ? ' · משוב ניתן ביום ' + ownFb.day : ' · יעד משוב: עד 3 ימי עבודה') + '</div></div>' +
        '<div class="stack s14">' +
        own.answers.map(function (a, i) {
          var note = fbNotes[i];
          return '<div class="qa"><div class="q">' +
            '<div class="qline"><span class="qno">' + (i + 1) + '</span>' +
            '<span class="qtext">' + esc(a.label) + '</span></div>' +
            '<div class="answer">' + esc(a.value) + '</div></div>' +
            (note
              ? '<div class="fb"><div class="stack s6"><span class="label">משוב ' + esc(v.managerName) + '</span>' +
                '<span class="val">' + esc(note.value) + '</span></div></div>'
              : '<div class="none">' + icon('hourglass-medium') + '<span>ממתין למשוב</span></div>') +
            '</div>';
        }).join('') +
        '</div></div>';
    }

    return '<div class="page read">' +
      back('file', 'חזרה לתיק שלי') +
      '<div class="stack s8">' +
      '<div class="row tight">' +
      '<span class="kicker accent">מבחן פרק · ' + esc(v.reviewChapter.id + ' ' + v.reviewChapter.title) + '</span>' +
      '<span class="tag">נבדק · 2 הערות</span></div>' +
      '<h1 class="h1">התשובות שלך והמשוב של ' + esc(v.managerName) + '</h1>' +
      '<div class="small muted">הוגש ביום 12 · משוב ניתן ביום 14 (יעד: עד 3 ימי עבודה)</div></div>' +
      '<div class="mgrnote"><div class="avatar-sm avatar-md">רש</div>' +
      '<div class="stack s6"><div class="who">הערה כללית · ' + esc(v.managerName) + '</div>' +
      '<div class="txt">קריאה מדויקת של הרעיון המרכזי — ניכר שהבנת שהתיווך מתחיל בקשר ולא במטלה. על שאלה 3 בוא/י נדבר: קבעתי 20 דקות ביום ג׳.</div></div></div>' +
      '<div class="stack s14">' +
      qa(1, 'מהו ההבדל בין ״כוונה והדדיות״ לבין הוראה ישירה? תן/י דוגמה מהשבוע האחרון.',
        'בהוראה ישירה אני מציג את המשימה ומצפה לביצוע. בכוונה והדדיות אני קודם בודק שהמטופל איתי — שהוא רואה מה שאני רואה. השבוע עצרתי לפני דף המכשיר ושאלתי מה הוא חושב שנעשה היום, ורק אחרי שהוא ניסח את זה במילים שלו התחלנו.',
        ['העצירה לפני הדף — זה בדיוק הרגע.',
          'מה עשית עם הניסוח שלו? ההדדיות היא לחזור למילים שלו, לא לשלך.',
          'איך תדע/י שהוא ״איתך״ בלי לשאול?']) +
      qa(2, 'איך ״תיווך משמעות״ נראה כשהמטופל אינו מבין למה התרגול חשוב?',
        'אני מחבר את התרגול למשהו שהוא רוצה — למשל לחזור לנהוג. אז מיון נקודות הופך ל״לזהות תמרורים מהר״.', null) +
      qa(3, 'תאר/י מצב שבו התיווך שלך לא עבד. מה היית עושה אחרת?',
        'ניסיתי לתווך תחושת יכולת אבל הוא נסגר. אני חושב שהייתי צריך לוותר על המשימה באותו יום.',
        ['זיהית את ההיסגרות בזמן.',
          'לא לוותר — להקטין. תחושת יכולת צריכה הצלחה קטנה ואמיתית באותו מפגש.',
          'מה המשימה הקטנה ביותר שהוא היה מצליח בה? נדבר ביום ג׳.']) +
      '</div>' +
      '<div class="row">' +
      '<button type="button" class="btn btn-outline" data-act="toast" data-arg="התגובה נשלחה למנהל">' + icon('chat-teardrop-text') + '<span>תגובה למשוב</span></button>' +
      '<button type="button" class="btn btn-quiet" data-act="toast" data-arg="השיחה כבר ביומן">' + icon('calendar-check') + '<span>שיחה נקבעה · יום ג׳ 10:00</span></button>' +
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
      '</div>' +
      '<div class="small muted" style="line-height:1.55">תצפיות שדה (' + v.observations + ') ושיחות סיכום (' + v.meetings + ' מתוך 3) נרשמות בתיק אך אינן תנאי — לפי שיקול המנהל.</div>' +
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
        dept: ss.dept || 'all', registered: !!ss.registered, recorded: !!ss.recorded,
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
              : '<button type="button" class="btn btn-outline btn-sm" data-act="toast" data-arg="נרשמת · תזכורת תישלח יום לפני">הרשמה</button>';
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
    return '<div class="page" style="gap:22px">' +
      '<div class="row between" style="align-items:flex-end;gap:16px">' +
      '<div class="stack s6"><h1 class="h1">הצוות של ' + esc(v.managerName) + '</h1>' +
      '<div class="small muted">תצוגת מנהל ישיר · 5 עובדים · ירושלים · רק הצוות שלך</div></div>' +
      '<button type="button" class="btn btn-quiet btn-sm" data-act="go" data-arg="coordinator">' + icon('buildings') + '<span>מסך רכז ההדרכה · כל הסניפים</span></button>' +
      '</div>' +
      '<div class="grid stats">' +
      '<button type="button" class="card ring-accent stat accent" data-act="go" data-arg="managerTest">' +
      '<span class="label">מבחנים ממתינים למשוב שלי</span><span class="value">' + v.waitingTotal + '</span>' +
      '<span class="note">יעד: 3 ימי עבודה · לבדיקה ' + icon('arrow-left', 'flip') + '</span></button>' +
      '<div class="card stat"><span class="label">זמן משוב ממוצע שלי</span><span class="value">2.4 ימים</span><span class="note">אחרי 5 ימים — התראה לרכז</span></div>' +
      '<div class="card stat"><span class="label">רשומות פרקטיקה לאישור</span><span class="value">3</span><span class="note">אישור בלחיצה</span></div>' +
      '<div class="card warnbg stat warn"><span class="label">בפיגור</span><span class="value">1</span><span class="note">עומר בר · 9 ימים</span></div>' +
      '<div class="card stat"><span class="label">תעודות שפוגות ב-60 יום</span><span class="value">2</span><span class="note">חסרות שעות המשך</span></div>' +
      '</div>' +
      '<div class="card clip">' +
      '<div class="card-head"><span class="h4">דוח הצוות</span>' +
      '<span class="tiny muted">מתעדכן ראשון בבוקר · לחיצה על שורה פותחת את התיק' +
      (v.isPhone ? ' · גלילה לצדדים לשאר העמודות' : '') + '</span></div>' +
      '<div class="tablewrap"><div class="inner">' +
      '<div class="trow head"><span>עובד/ת</span><span>שלב</span><span>קצב</span><span>ממתין לי</span>' +
      '<span>פרקטיקה</span><span>שעות המשך</span><span>תעודה</span><span>צפייה</span></div>' +
      v.team.map(function (r) {
        return '<div class="' + cls('trow', r.delay && 'late', r.mine && !r.delay && 'mine') + '">' +
          '<span class="name">' + esc(r.name) + '</span>' +
          '<span class="muted">' + esc(r.stage) + '</span>' +
          '<span style="color:' + r.delayColor + '">' + esc(r.delayText) + '</span>' +
          '<span>' + r.waiting + '</span>' +
          '<span>' + r.hours + ' מתוך 60</span>' +
          '<span>' + r.ce + ' מתוך 10</span>' +
          '<span class="muted">' + esc(r.cert) + '</span>' +
          '<span class="muted">' + esc(r.watch) + '</span></div>';
      }).join('') +
      '</div></div></div>' +
      '<div class="grid actions">' +
      [['file', 'folder-user', 'התיק של ' + v.name, 'מבחנים, פרקטיקה, שעות, תעודה'],
      ['observation', 'binoculars', 'תצפית שדה', '4 צירים · 4 רמות · בטלפון'],
      ['stageMeeting', 'calendar-check', 'שיחת סיכום שלב', '20 דקות · תיעוד קצר'],
      ['fileReview', 'certificate', 'סקירת תיק לתעודה', 'תנאים אוטומטיים + הערת סיכום']].map(function (a) {
        return '<button type="button" class="card" style="padding:18px;display:flex;gap:12px;align-items:flex-start" data-act="go" data-arg="' + a[0] + '">' +
          icon(a[1], 'ok') + '<span class="stack s6">' +
          '<span class="h5" style="font-family:var(--font-heading);font-size:15px">' + esc(a[2]) + '</span>' +
          '<span class="tiny muted">' + esc(a[3]) + '</span></span></button>';
      }).join('') +
      '</div></div>';
  };

  /* 18 — בדיקת מבחן (מנהל) */
  screens.managerTest = function (v) {
    function block(no, q, a, prefill) {
      return '<div class="qa"><div class="q">' +
        '<div class="qline"><span class="qno">' + no + '</span><span class="qtext">' + esc(q) + '</span></div>' +
        '<div class="answer">' + esc(a) + '</div></div>' +
        '<div class="fb"><div class="grid feedback">' +
        '<label class="stack s6"><span class="label">מה עבד</span>' + textarea(2, '…', prefill || '') + '</label>' +
        '<label class="stack s6"><span class="label">מה לחדד</span>' + textarea(2, '…') + '</label>' +
        '<label class="stack s6"><span class="label">שאלה להמשך</span>' + textarea(2, '…') + '</label>' +
        '</div></div></div>';
    }

    return '<div class="page" style="gap:20px">' +
      back('admin', 'חזרה לצוות') +
      '<div class="stack s8"><div class="kicker accent">מבחנים לבדיקה · תצוגת מנהל</div>' +
      '<h1 class="h1">' + esc(v.name + ' · ' + v.toMark.id + ' ' + v.toMark.title) + '</h1>' +
      '<div class="small muted">הוגש היום · יעד משוב: 3 ימי עבודה · אין ציון — תבנית משוב אחידה לכל שאלה</div></div>' +
      '<div class="cols">' +
      '<div class="card" style="flex:1 1 240px;padding:8px;display:flex;flex-direction:column">' +
      '<div class="rowitem" style="background:var(--color-accent-100)">' +
      '<span class="avatar-sm tint">' + esc(v.initials) + '</span>' +
      '<span class="body"><span class="t" style="color:var(--color-accent-800)">' + esc(v.name + ' · ' + v.toMark.id) + '</span>' +
      '<span class="s" style="color:var(--color-accent-700)">הוגש היום</span></span></div>' +
      '<div class="rowitem"><span class="avatar-sm">דש</span>' +
      '<span class="body"><span class="t">דנה שרון · 3.2 אבחון וקביעת מטרות</span><span class="s">הוגש אתמול</span></span></div>' +
      '<div class="rowitem"><span class="avatar-sm">יט</span>' +
      '<span class="body"><span class="t">יוסי טל · בונוס ב.2</span><span class="s">הוגש לפני 4 ימים</span>' +
      '<span class="s" style="color:var(--color-warn-fg)">מחר עובר את יעד ה-3 ימים</span></span></div>' +
      '</div>' +
      '<div style="flex:2 1 400px;display:flex;flex-direction:column;gap:14px">' +
      block(1, 'תאר/י רגע מהשבוע האחרון שבו הפרק הזה שינה משהו במה שעשית.',
        'עצרתי לפני דף המכשיר ושאלתי את המטופל מה הוא חושב שנעשה היום. חיכיתי שהוא ינסח, ורק אז התחלנו. זה לקח שתי דקות יותר והמפגש היה שונה לגמרי.',
        'העצירה לפני הדף — זה בדיוק הרגע.') +
      block(2, 'בחר/י מושג אחד מהפרק והסבר/י אותו למטופל או להורה — במילים שלהם.',
        '״זיכרון עבודה זה כמו שולחן עבודה קטן. אם שמים עליו יותר מדי דברים — משהו נופל. אנחנו לומדים לשים פחות דברים בכל פעם, ולסדר אותם.״') +
      '<div class="small muted">שאלות 3–4 למטה · ״בנק משובים טובים״ במאגר לדוגמאות</div>' +
      '<div class="card pad-sm stack s8">' +
      '<span class="tiny muted">הערה כללית לעובד/ת · שורה-שתיים בראש המבחן</span>' +
      textarea(2, '…', '', 'הערה כללית לעובד/ת') + '</div>' +
      '<div class="row">' +
      '<button type="button" class="btn btn-primary btn-lg" data-act="sendFeedback">' + icon('check') + '<span>שליחת משוב</span></button>' +
      '<button type="button" class="btn btn-quiet btn-lg" data-act="go" data-arg="stageMeeting">' + icon('calendar-plus') + '<span>לקבוע שיחה</span></button>' +
      '</div></div></div></div>';
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
  screens.coordinator = function () {
    var branches = [
      ['ירושלים', 9, '2.4', 61, false], ['תל אביב', 7, '2.8', 44, false],
      ['חיפה', 4, '4.1', 27, true], ['באר שבע', 3, '2.2', 18, false]
    ];
    return '<div class="page" style="gap:22px">' +
      back('admin', 'חזרה לתצוגת מנהל') +
      '<div class="stack s6"><h1 class="h1">רכז ההדרכה · כל הסניפים</h1>' +
      '<div class="small muted">שבוע 37 · ירושלים, תל אביב, חיפה, באר שבע · עדכון ראשון בבוקר</div></div>' +
      '<div class="grid stats">' +
      '<div class="card stat"><span class="label">בהכשרה כרגע</span><span class="value">23</span><span class="note">14 פגועי ראש · 9 פוסט-טראומה</span></div>' +
      '<div class="card warnbg stat warn"><span class="label">משוב מעל 5 ימים</span><span class="value">3</span><span class="note">התראה נשלחה למנהלים · אחרי 10 — הרכז מגיב</span></div>' +
      '<div class="card stat"><span class="label">זמן משוב ממוצע · כל המנהלים</span><span class="value">2.9 ימים</span><span class="note">יעד: 3 · חיפה 4.1</span></div>' +
      '<div class="card stat"><span class="label">תעודות פוגות ב-60 יום</span><span class="value">11</span><span class="note">4 חסרות שעות המשך</span></div>' +
      '<div class="card stat"><span class="label">תור ניקוי במאגר</span><span class="value">9</span><span class="note">תיוג חסר 5 · כפילויות 2 · תוקף 2</span></div>' +
      '</div>' +
      '<div class="cols">' +
      '<div style="flex:2 1 400px;display:flex;flex-direction:column;gap:16px">' +
      '<div class="card clip">' +
      '<div class="card-head"><span class="h4">משובים שחצו את היעד</span></div>' +
      '<div class="escrow"><span>חיפה · אלון פרץ ← נטע גל · 2.3 זיכרון</span>' +
      '<span class="small" style="color:var(--color-warn-fg)">7 ימים</span>' +
      '<button type="button" class="btn btn-outline btn-sm" style="font-size:12px;padding:9px 14px;min-height:40px" data-act="toast" data-arg="תזכורת נשלחה">תזכורת</button></div>' +
      '<div class="escrow"><span>תל אביב · נעמה ברק ← שי לוין · 3.1 טראומה</span>' +
      '<span class="small" style="color:var(--color-warn-fg)">6 ימים</span>' +
      '<button type="button" class="btn btn-outline btn-sm" style="font-size:12px;padding:9px 14px;min-height:40px" data-act="toast" data-arg="תזכורת נשלחה">תזכורת</button></div>' +
      '<div class="escrow"><span>באר שבע · יובל אדרי ← ליאת כץ · 1.4 מכשירים</span>' +
      '<span class="small" style="color:var(--color-danger-fg)">11 ימים · הרכז מגיב</span>' +
      '<button type="button" class="btn btn-primary btn-sm" style="font-size:12px;padding:9px 14px;min-height:40px" data-act="go" data-arg="managerTest">לבדיקה</button></div>' +
      '</div>' +
      '<div class="card clip">' +
      '<div class="card-head"><span class="h4">לפי סניף</span></div>' +
      '<div class="brow head"><span>סניף</span><span>בהכשרה</span><span>זמן משוב</span><span>מוסמכים</span></div>' +
      branches.map(function (b) {
        return '<div class="brow"><span>' + esc(b[0]) + '</span><span>' + b[1] + '</span>' +
          '<span style="color:' + (b[4] ? 'var(--color-warn-fg)' : 'var(--color-accent-700)') + '">' + b[2] + '</span>' +
          '<span>' + b[3] + '</span></div>';
      }).join('') +
      '</div></div>' +
      '<div style="flex:1 1 260px;display:flex;flex-direction:column;gap:16px">' +
      '<div class="card pad-sm stack s12">' +
      '<span class="h4">תור הניקוי השבועי</span>' +
      [['tag', '5 נכסים ללא קהל יעד', 'תקן'], ['copy', '2 כפילויות חשודות', 'אחד'],
      ['clock-countdown', '2 נכסים שעבר תוקפם', 'ארכב'], ['chats-circle', '3 תשובות מהשדה לפרסום כנכס', 'תייג']].map(function (q) {
        return '<div class="queue">' + icon(q[0]) + '<span>' + esc(q[1]) + '</span>' +
          '<button type="button" class="act" data-act="toast" data-arg="' + esc(q[2]) + ' — בוצע">' + esc(q[2]) + '</button></div>';
      }).join('') +
      '</div>' +
      '<div class="card pad-sm stack">' +
      '<span class="h4">פעולות</span>' +
      '<button type="button" class="btn btn-primary btn-block" style="justify-content:flex-start" data-act="go" data-arg="curriculum">' + icon('graduation-cap') + '<span>בניית תוכנית הלימודים</span></button>' +
      '<button type="button" class="btn btn-primary btn-block" style="justify-content:flex-start" data-act="go" data-arg="sessionsEdit">' + icon('calendar-plus') + '<span>ניהול השיעורים</span></button>' +
      '<button type="button" class="btn btn-primary btn-block" style="justify-content:flex-start" data-act="go" data-arg="libraryEdit">' + icon('books') + '<span>ניהול מאגר הידע</span></button>' +
      '<button type="button" class="btn btn-quiet btn-block" style="justify-content:flex-start" data-act="toast" data-arg="הזמנת אורח נשלחה · הרשאה ל-30 יום">' + icon('user-plus') + '<span>הזמנת מרצה חיצוני · אורח 30 יום</span></button>' +

      '<button type="button" class="btn btn-quiet btn-block" style="justify-content:flex-start" data-act="print">' + icon('file-arrow-down') + '<span>דוח רבעוני להנהלה</span></button>' +
      '</div></div></div></div>';
  };

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
        '<button type="button" class="pill" data-act="sessFlag" data-arg="' + i + ':registered" aria-pressed="' + !!ss.registered + '">נרשמתי</button>' +
        '</div></div>';
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
      state.submissions['chapter:' + v.current.id] = {
        chapter: v.current.id, title: v.current.title, day: v.day,
        answers: formsFor(prefix)
      };
      set({ testSubmitted: true, screen: 'home' }, { top: true });
      toast('המבחן נשלח ל' + MANAGER + ' · התשובות נשמרו בתיק');
    },

    submitFinal: function () {
      var v = derive();
      state.submissions.final = { day: v.day, answers: formsFor('final/|') };
      save();
      render();
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
      var v = derive();
      var written = formsFor('managerTest/' + v.name + '/' + v.toMark.id + '|');
      if (!written.length) { toast('אין עדיין מה לשלוח — כתוב/כתבי משוב לפחות לשאלה אחת'); return; }
      state.feedback[v.toMark.id] = { day: v.day, by: MANAGER, notes: written };
      clearForms('managerTest/' + v.name + '/' + v.toMark.id + '|');
      set({ screen: 'admin' }, { top: true });
      toast('המשוב נשלח · ' + v.first + ' יקבל/תקבל התראה');
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
      case 'managerTest': return v.name + '/' + v.toMark.id;
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
