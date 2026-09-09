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
    registered: false,
    libTab: 'assets',
    libTopic: 'שיקום קוגניטיבי',
    libSort: 'used',
    scheduleFilter: 'all',
    testSubmitted: false,
    practiceAdded: false,
    uploadPrivate: false,
    quizDone: false,
    readNotifs: false,
    rubric: [2, 1, 2, 3],
    relevance: 2
  };

  var state = load();
  var currentUser = null;   // set by auth.js once someone is signed in
  var authApi = null;       // { signOut }
  var accountOpen = false;  // account menu in the header

  function load() {
    var s = {};
    for (var k in defaults) s[k] = defaults[k];
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        for (var key in saved) if (key in defaults) s[key] = saved[key];
      }
      if (!Array.isArray(s.rubric) || s.rubric.length !== 4) s.rubric = defaults.rubric.slice();
    } catch (e) { /* private mode, cleared storage — start fresh */ }
    return s;
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
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

  var S1 = ['חזון המכון וסיפור פוירשטיין', 'למידה מתווכת ושינוי מבני', 'שנים-עשר קריטריוני התיווך', 'מכשירי ההעשרה האינסטרומנטלית', 'מבוא ל-LPAD ולהערכה דינמית', 'אתיקה, גבולות ופרטיות מטופלים'];
  var S2 = ['יסודות נוירו-קוגניטיביים ופלסטיות', 'קשב וזיכרון עבודה', 'זיכרון ואסטרטגיות חיצוניות', 'תפקודים ניהוליים, מודעות וויסות', 'תקשורת חברתית ותפקוד חזותי-מרחבי', 'קביעת מטרות, תכנון טיפול ומעקב'];
  var S3h = ['סוגי פגיעה, מסלולי שיקום ופרוגנוזה', 'אבחון קוגניטיבי וקביעת מטרות', 'עייפות קוגניטיבית, מודעות ותסכול', 'עבודה עם המשפחה והמסגרת'];
  var S3p = ['טראומה ותגובות פוסט-טראומטיות', 'עקרונות טיפול מיודע-טראומה', 'שיקום קוגניטיבי בהקשר טראומטי', 'גבולות התפקיד, הפניה ושמירה על העובד'];

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

  /* ------------------------------------------------------------ view model */

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

    var stageIdx = day >= 90 ? 4 : day >= 60 ? 3 : day >= 30 ? 2 : 1;
    var done = stageIdx === 4;

    function mk(list, no) {
      return list.map(function (title, i) {
        var st = 'locked';
        if (done || no < stageIdx) {
          st = (!done && no === stageIdx - 1 && i === list.length - 1) ? 'submitted' : 'done';
        } else if (no === stageIdx) {
          st = i === 0 ? (state.testSubmitted ? 'submitted' : 'current') : 'locked';
        }
        var notes = st === 'done' ? (i % 2 === 0 ? 2 : 0) : 0;
        return {
          id: no + '.' + (i + 1), title: title, no: no, status: st,
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

    var c1 = mk(S1, 1), c2 = mk(S2, 2), c3 = mk(isHead ? S3h : S3p, 3);
    var chapters = c1.concat(c2, c3);
    var bonusList = (isHead ? S3p : S3h).map(function (title, i) {
      return { id: 'ב.' + (i + 1), title: title };
    });

    function stState(no) { return done || no < stageIdx ? 'done' : no === stageIdx ? 'active' : 'locked'; }
    function badge(st) {
      return st === 'done' ? { text: 'הושלם', cls: 'solid' }
        : st === 'active' ? { text: 'פעיל', cls: '' }
          : { text: 'נעול', cls: 'neutral' };
    }

    var stages = [
      { no: 1, title: 'שיטת פוירשטיין', days: 'ימים 1–30', items: c1 },
      { no: 2, title: 'שיקום קוגניטיבי', days: 'ימים 31–60', items: c2 },
      { no: 3, title: 'הכשרת אגף · ' + deptName, days: 'ימים 61–90', items: c3 }
    ].map(function (st) {
      var s = stState(st.no), b = badge(s);
      st.state = s; st.badgeText = b.text; st.badgeCls = b.cls;
      st.hours = '20 שעות תוכן · 20 שעות פרקטיקה';
      return st;
    });

    var testsDone = chapters.filter(function (c) { return c.done; }).length;
    var testsSubmitted = chapters.filter(function (c) { return c.submitted; }).length;

    var practiceBase = Math.min(60, (stageIdx - 1) * 20);
    var practiceHours = practiceBase + (state.practiceAdded ? 1.5 : 0);
    var practicePct = Math.min(100, Math.round(practiceHours / 60 * 100));
    var observations = [0, 1, 3, 4][stageIdx - 1];
    var meetings = Math.min(3, stageIdx - 1);
    var ceHours = [0, 1.5, 3.5, 5][stageIdx - 1] + (state.quizDone ? 2 : 0);
    var progressPct = done ? 100 : Math.round((testsDone + testsSubmitted) / 16 * 100);

    var current = chapters.filter(function (c) { return c.current; })[0]
      || chapters.filter(function (c) { return c.submitted; })[0]
      || chapters[0];
    var reviewChapter = chapters.filter(function (c) { return c.done && c.hasNotes; })[0] || c1[0];
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

    if (state.practiceAdded) {
      practiceAll.unshift({
        date: 'היום', dur: '1.5 ש׳', stageText: 'שלב ' + Math.min(3, stageIdx),
        sup: managerName, tool: 'תרגול קשב', note: 'הרשומה שלי',
        appIcon: 'hourglass-medium', appText: 'ממתין לאישור', appColor: 'var(--color-neutral-700)'
      });
    }
    var practice = practiceAll.slice(0, 5);

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
      admin: T.admin, managerTest: 'בדיקת מבחן', observation: 'תצפית שדה',
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
      cond1: done || testsDone === 16, cond2: done, cond3: practiceHours >= 60,
      cond1Text: (done ? 16 : testsDone) + ' מתוך 16 מבחני פרק עם משוב',
      cond3Text: practiceHours + ' מתוך 60 שעות פרקטיקה מאושרות',
      heroKicker: done ? 'הכשרה הושלמה · יום ' + day
        : 'שלב ' + stageIdx + ' מתוך 3 · ' + ['שיטת פוירשטיין', 'שיקום קוגניטיבי', 'הכשרת אגף ' + deptName][stageIdx - 1] + ' · יום ' + day,
      heroTitle: done ? first + ', ההכשרה הושלמה — התעודה שלך מוכנה'
        : day === 1 ? 'שלום, ' + first + ' — מתחילים בשיטת פוירשטיין'
          : 'שלום, ' + first + ' — ממשיכים ב' + current.title,
      heroBody: done
        ? 'תעודת מדריך/ה מוסמך/ת בתוקף עד 5.12.2028. הכשרת אגף ' + otherDeptName + ' נפתחה לך כבונוס — 16 שעות שנזקפות כשעות המשך.'
        : 'פרק ' + current.id + ' · כ-55 דקות. בסופו מבחן קצר ללא ציון — ' + managerName + ' קורא/ת ומגיב/ה, והתשובות עם ההערות נשמרות בתיק שלך.'
    };
  }

  /* ----------------------------------------------------------- area mapping */

  var AREAS = {
    home: ['home', 'lesson', 'test', 'review', 'final', 'register', 'notifications', 'search'],
    file: ['file', 'practiceNew'],
    schedule: ['schedule', 'session', 'sessionAfter'],
    library: ['library', 'upload', 'asset'],
    admin: ['admin', 'managerTest', 'observation', 'stageMeeting', 'fileReview', 'coordinator']
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
      '<a role="menuitem" href="./">' + icon('house') + '<span>בחירת מערכת</span></a>' +
      '<button type="button" role="menuitem" data-act="signOut">' + icon('x') + '<span>יציאה</span></button>' +
      '</div>';
  }

  function demobar(v) {
    var p = state.preview;
    return '' +
      '<div class="demobar">' +
      '<div class="seg" role="group" aria-label="תצוגה">' +
      '<button type="button" data-act="preview" data-arg="auto" aria-pressed="' + (p === 'auto') + '">' + icon('desktop') + '<span>' + esc(v.T.auto) + '</span></button>' +
      '<button type="button" data-act="preview" data-arg="phone" aria-pressed="' + (p === 'phone') + '">' + icon('device-mobile') + '<span>' + esc(v.T.phone) + '</span></button>' +
      '</div>' +
      '<button type="button" class="timebtn" data-act="advanceDay">' + icon('fast-forward') +
      '<span>' + esc(v.T.time) + ' · ' + esc(v.T.day) + ' ' + v.day + '</span></button>' +
      '<div class="seg" role="group" aria-label="שפה">' +
      '<button type="button" data-act="lang" data-arg="he" aria-pressed="' + (v.lang === 'he') + '">עב</button>' +
      '<button type="button" data-act="lang" data-arg="en" aria-pressed="' + (v.lang === 'en') + '">EN</button>' +
      '</div>' +
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

  function textarea(rows, placeholder, value) {
    return '<textarea class="textarea" rows="' + rows + '"' +
      (placeholder ? ' placeholder="' + esc(placeholder) + '"' : '') + '>' + esc(value || '') + '</textarea>';
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
      '<div class="hero-title">' + esc(v.heroTitle) + '</div>' +
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
      '<div class="row between nowrap"><span>מבחני פרק עם משוב</span><span class="muted">' + v.testsDone + ' מתוך 16</span></div>' +
      '<div class="row between nowrap"><span>שעות פרקטיקה מאושרות</span><span class="muted">' + v.practiceHours + ' מתוך 60</span></div>' +
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
      '<div class="foot">16 שעות תוכן · נזקפות כשעות המשך · ללא פרקטיקום חובה</div></div></div>' +
      '</div></div>';

    h += '<div class="cols">' +
      '<div class="flex-half">' +
      '<div class="row between" style="align-items:baseline"><div class="h3">המבחנים שלי</div>' +
      '<button type="button" class="btn-link" data-act="go" data-arg="file">הכל בתיק</button></div>';

    if (v.hasTests) {
      h += '<div class="card"><div class="rows">' +
        (v.hasReview
          ? '<button type="button" class="rowitem" data-act="go" data-arg="review">' +
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
    return '<div class="page narrow">' +
      back('home', 'חזרה למסלול שלי') +
      '<div class="stack s8">' +
      '<div class="kicker accent">' + esc(v.currentStage) + ' · פרק ' + esc(v.current.id) + '</div>' +
      '<h1 class="h1">' + esc(v.current.title) + '</h1>' +
      '<div class="small muted">כ-55 דקות · וידאו עם כתוביות · בסופו מבחן פרק ללא ציון</div></div>' +
      '<div class="video"><button type="button" class="play" data-act="toast" data-arg="הווידאו יתנגן במערכת החיה">' + icon('fill:play') + '</button>' +
      '<div class="controls"><span class="track"><i style="width:22%"></i></span>' +
      '<span>12:10 מתוך 55:00</span>' + icon('closed-captioning') + icon('download-simple') + '</div></div>' +
      '<div class="card pad stack s14">' +
      '<div class="h4">מה בפרק</div>' +
      '<div class="stack" style="font-size:14px;color:var(--color-neutral-800)">' +
      [['01', 'המושגים המרכזיים ומאיפה הם באים'],
      ['02', 'שני קטעי וידאו מהשדה לניתוח'],
      ['03', 'איך זה נראה במפגש אמיתי — ומה עוצרים'],
      ['04', 'דף עבודה לרשומת הפרקטיקה הבאה']].map(function (r) {
        return '<div style="display:flex;gap:10px"><span style="color:var(--color-accent-700);font-family:var(--font-heading)">' + r[0] + '</span><span>' + esc(r[1]) + '</span></div>';
      }).join('') +
      '</div>' +
      '<div class="row" style="border-top:1px solid var(--color-neutral-300);padding-top:14px;gap:16px">' +
      '<button type="button" class="btn-link" data-act="toast" data-arg="הקובץ יורד במערכת החיה">' + icon('file-pdf') + 'מצגת הפרק</button>' +
      '<button type="button" class="btn-link" data-act="toast" data-arg="הקובץ יורד במערכת החיה">' + icon('file-doc') + 'דף עבודה</button>' +
      '<button type="button" class="btn-link" data-act="go" data-arg="library">' + icon('books') + 'הנושא במאגר הידע</button>' +
      '</div></div>' +
      '<div class="card tintbg pad row" style="gap:20px">' +
      '<div class="iconwrap" style="width:46px;height:46px;background:var(--color-accent-700);color:var(--color-neutral-100);font-size:24px">' + icon('chat-circle-text') + '</div>' +
      '<div class="stack s6" style="flex:1;min-width:220px">' +
      '<div class="h4" style="color:var(--color-accent-800)">מבחן הפרק — 4 שאלות פתוחות מהמחסן</div>' +
      '<div style="font-size:14px;line-height:1.6;color:var(--color-accent-700)">אין ציון. כל עובד מקבל שאלות שונות. ' + esc(v.managerName) + ' קורא/ת ומגיב/ה לכל שאלה — והפרק הבא נפתח מיד עם השליחה.</div></div>' +
      '<button type="button" class="btn btn-primary btn-lg" data-act="go" data-arg="test">למבחן הפרק</button>' +
      '</div></div>';
  };

  /* 4 — מבחן פרק */
  screens.test = function (v) {
    var qs = [
      [4, 'תאר/י רגע מהשבוע האחרון שבו הפרק הזה שינה משהו במה שעשית — או במה שהיית עושה.'],
      [4, 'בחר/י מושג אחד מהפרק והסבר/י אותו למטופל או להורה — במילים שלהם.'],
      [4, 'מטופל לא מתקדם אחרי שלושה מפגשים. מה תבדוק/י קודם, ומה תשנה/י?'],
      [3, 'איזו שאלה נשארה לך פתוחה? ' + v.managerName + ' יענה/תענה עליה במשוב.']
    ];
    return '<div class="page read">' +
      back('lesson', 'חזרה לפרק') +
      '<div class="stack s8">' +
      '<div class="row tight">' +
      '<span class="kicker accent">מבחן פרק · ' + esc(v.current.id + ' ' + v.current.title) + '</span>' +
      '<span class="tag outline">גרסה אישית · 4 מתוך 18 שאלות במחסן</span></div>' +
      '<h1 class="h1">ארבע שאלות, בלי ציון</h1>' +
      '<p class="lead">כתוב/כתבי מהניסיון והמחשבה שלך — אין תשובה אחת נכונה. אין מגבלת זמן. ' + esc(v.managerName) + ' יקרא/תקרא ויגיב/תגיב לכל שאלה, והכל נשמר בתיק שלך.</p></div>' +
      '<div class="notice quiet">' + icon('shield-check', 'ok') +
      '<span>הצהרת פרטיות: בתשובות אין שמות או פרטים מזהים של מטופלים.</span></div>' +
      '<div class="stack s14">' +
      qs.map(function (q, i) {
        return '<div class="card pad stack s12">' +
          '<div class="qline"><span class="qno">' + (i + 1) + '</span><span class="qtext">' + esc(q[1]) + '</span></div>' +
          textarea(q[0], 'התשובה שלך…') + '</div>';
      }).join('') +
      '</div>' +
      '<div class="row" style="gap:14px">' +
      '<button type="button" class="btn btn-primary btn-lg" data-act="submitTest">' + icon('paper-plane-tilt') + '<span>שליחה ל' + esc(v.managerName) + '</span></button>' +
      '<button type="button" class="btn btn-quiet btn-lg" data-act="toast" data-arg="הטיוטה נשמרה">שמירת טיוטה</button>' +
      '</div></div>';
  };

  /* 5 — משוב מנהל (תצוגת עובד) */
  screens.review = function (v) {
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
    return '<div class="page read">' +
      back('file', 'חזרה לתיק שלי') +
      '<div class="stack s8">' +
      '<div class="row tight"><span class="kicker accent">מבחן מסכם · שלושת השלבים</span>' +
      '<span class="tag outline">גרסה אישית · 12 מתוך 60 שאלות במחסן</span></div>' +
      '<h1 class="h1">12 שאלות פתוחות, בלי ציון</h1>' +
      '<p class="lead">ארבע שאלות מכל שלב. ' + esc(v.managerName) + ' קורא/ת ומגיב/ה כמו במבחני הפרקים. ההגשה היא אחד משלושת התנאים לתעודה — יחד עם 16 מבחני פרק עם משוב ו-60 שעות פרקטיקה מאושרות.</p></div>' +
      (v.done
        ? '<div class="notice">' + icon('fill:check-circle') +
        '<span>הוגש ביום 88 · המשוב של ' + esc(v.managerName) + ' ניתן ביום 90 · 12 שאלות, 5 הערות</span></div>'
        : '') +
      '<div class="stack s12">' +
      '<div class="kicker">שלב 1 · שיטת פוירשטיין</div>' +
      '<div class="card pad stack s12"><div class="qline"><span class="qno">1</span>' +
      '<span class="qtext">בחר/י שלושה קריטריוני תיווך והראה/י איך הם הופיעו — או נעדרו — במפגש אמיתי אחד.</span></div>' +
      textarea(4, 'התשובה שלך…') + '</div>' +
      '<div class="card pad stack s12"><div class="qline"><span class="qno">2</span>' +
      '<span class="qtext">מה ההבדל בין הערכה דינמית להערכה סטטית, ולמה זה משנה למטופל שלך?</span></div>' +
      textarea(4, 'התשובה שלך…') + '</div>' +
      '<div class="small muted" style="padding:4px 0">שאלות 3–4 · שלב 1 · ואז 4 שאלות בשיקום קוגניטיבי ו-4 בהכשרת האגף</div>' +
      '</div>' +
      '<div class="row" style="gap:14px">' +
      (v.notDone
        ? '<button type="button" class="btn btn-primary btn-lg" data-act="submitFinal">' + icon('paper-plane-tilt') + '<span>הגשה ל' + esc(v.managerName) + '</span></button>'
        : '') +
      '<button type="button" class="btn btn-quiet btn-lg" data-act="toast" data-arg="הטיוטה נשמרה">שמירת טיוטה</button>' +
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
          return '<button type="button" class="rowitem" data-act="go" data-arg="review">' +
            icon(t.icon, '').replace('class="i ', 'style="color:' + t.iconColor + '" class="i ') +
            '<span class="body"><span class="t">' + esc(t.id + ' ' + t.title) + '</span>' +
            '<span class="s">' + esc(t.statusText) + '</span></span>' + icon('arrow-left', 'flip ok') + '</button>';
        }).join('') + '</div>'
        : '<div style="padding:20px;font-size:14px;line-height:1.6;color:var(--color-neutral-700)">עדיין לא הוגשו מבחנים. המבחן הראשון — בסוף פרק 1.1.</div>') +
      '</div>' +

      '<div class="stack s20">' +
      '<div class="card clip">' +
      '<div class="card-head"><span class="h4">יומן פרקטיקה</span><span class="small muted">' + v.practiceHours + ' מתוך 60 שעות · 20 לכל שלב</span></div>' +
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
      '<div class="card-head"><span class="h4">פנקס שעות המשך</span><span class="small muted">' + v.ceHours + ' מתוך 10 בשנה</span></div>' +
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
      '<div class="row nowrap" style="background:var(--color-neutral-100);border-radius:999px;box-shadow:var(--ring-accent);padding:6px 20px;min-height:48px;gap:12px">' +
      icon('magnifying-glass', 'ok') +
      '<input class="input" style="border:0;background:transparent;padding:6px 0;font-size:16px;min-height:36px" value="קשב" aria-label="חיפוש">' +
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
    var sessions = [
      {
        month: 'ספטמבר', day: '14', dow: 'יום א׳', live: true, act: 'session', dept: 'head', registered: true, recorded: false,
        when: '16:00–17:30 · Zoom', title: 'קשב לאחר פגיעת ראש — מהקליניקה לשגרה',
        who: 'ד״ר יעל אברמסון · מרצה חיצונית · 1.5 שעות המשך', cta: 'הצטרפות', ctaStyle: 'solid'
      },
      {
        month: 'ספטמבר', day: '7', dow: 'יום א׳', act: 'sessionAfter', dept: 'all', registered: true, recorded: true,
        when: 'הסתיים · הקלטה זמינה · 2 שעות המשך', title: 'מקרה מהשדה: שיקום קוגניטיבי אחרי אירוע מוחי בגיל צעיר',
        who: 'אבי כהן · שיתוף ידע פנימי · ירושלים', cta: 'צפייה + שאלון', ctaStyle: 'chip'
      },
      {
        month: 'ספטמבר', day: '28', dow: 'יום א׳', dept: 'ptsd', registered: false, recorded: false,
        when: '16:00–17:00 · Zoom · 1 שעת המשך', title: 'טיפול מיודע-טראומה: מה משתנה בחדר',
        who: 'צוות אגף פוסט-טראומה · מומלץ לשני האגפים', cta: 'הרשמה', ctaStyle: 'outline'
      },
      {
        month: 'אוקטובר', day: '12', dow: 'יום ב׳', dept: 'all', registered: false, recorded: false,
        when: '09:30–13:00 · תל אביב · 3.5 שעות המשך', title: 'סדנת מכשירי העשרה אינסטרומנטלית — עבודה בזוגות',
        who: 'צוות ההדרכה · סדנה פרונטלית', cta: 'הרשמה', ctaStyle: 'outline'
      },
      {
        month: 'אוקטובר', day: '26', dow: 'יום ב׳', dept: 'all', registered: false, recorded: false,
        when: '16:00–17:00 · Zoom · הרצאת רענון שנתית · חובה למוסמכים', title: 'רענון שנתי: עדכוני נהלים, פרטיות וחידושים מקצועיים',
        who: 'רכז הדרכה · עם שאלון קצר בסיום · תנאי חידוש התעודה', cta: 'הרשמה', ctaStyle: 'outline'
      }
    ];

    var f = state.scheduleFilter;
    var shown = sessions.filter(function (s) {
      if (f === 'all') return true;
      if (f === 'dept') return s.dept === v.dept || s.dept === 'all';
      if (f === 'registered') return s.registered;
      if (f === 'recorded') return s.recorded;
      return true;
    });

    var filters = [['all', 'הכל'], ['dept', v.deptName], ['registered', 'נרשמתי'], ['recorded', 'הוקלטו']];

    var h = '<div class="page" style="gap:22px">' +
      '<div class="row between" style="align-items:flex-end;gap:16px">' +
      '<div class="stack s6"><h1 class="h1">שיעורי העשרה · תשפ״ז</h1>' +
      '<div class="small muted">כל שיעור נזקף כשעות המשך אחרי נוכחות + שאלון 3 שאלות · שעות ההמשך שלך: ' + v.ceHours + ' מתוך 10</div></div>' +
      '<div class="chips">' + filters.map(function (x) {
        return '<button type="button" class="chip" data-act="scheduleFilter" data-arg="' + x[0] + '" aria-pressed="' + (f === x[0]) + '">' + esc(x[1]) + '</button>';
      }).join('') + '</div></div>';

    ['ספטמבר', 'אוקטובר'].forEach(function (month) {
      var list = shown.filter(function (s) { return s.month === month; });
      if (!list.length) return;
      h += '<div class="stack"><div class="kicker">' + esc(month) + '</div>' +
        list.map(function (s) {
          var inner = '<span class="datechip' + (s.live ? '' : ' quiet') + '"><span class="d">' + s.day + '</span><span class="m">' + esc(s.dow) + '</span></span>' +
            '<span class="body">' +
            (s.live
              ? '<span class="row tight"><span class="livedot"></span><span class="tiny" style="color:var(--color-live)">משודר עכשיו</span><span class="when">' + esc(s.when) + '</span></span>'
              : '<span class="when">' + esc(s.when) + '</span>') +
            '<span class="name">' + esc(s.title) + '</span><span class="sub">' + esc(s.who) + '</span></span>';
          var cta = s.ctaStyle === 'solid'
            ? '<span class="tag solid" style="padding:10px 18px;border-radius:var(--radius-md)">' + esc(s.cta) + '</span>'
            : s.ctaStyle === 'chip'
              ? '<span class="chip on">' + esc(s.cta) + '</span>'
              : '<button type="button" class="btn btn-outline btn-sm" data-act="toast" data-arg="נרשמת · תזכורת תישלח יום לפני">' + esc(s.cta) + '</button>';
          return s.act
            ? '<button type="button" class="card sessionitem' + (s.live ? ' ring-accent' : '') + '" data-act="go" data-arg="' + s.act + '">' + inner + cta + '</button>'
            : '<div class="card sessionitem">' + inner + cta + '</div>';
        }).join('') + '</div>';
    });

    if (!shown.length) h += '<div class="card pad muted">אין שיעורים בסינון הזה.</div>';
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
      '<div class="video"><button type="button" class="play" data-act="toast" data-arg="ההקלטה תתנגן במערכת החיה">' + icon('fill:play') + '</button>' +
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
        '<div style="font-size:14px;line-height:1.6;color:var(--color-accent-800)">השאלון הוגש. השעות נוספו לפנקס בתיק שלך — ' + v.ceHours + ' מתוך 10 לשנה.</div>' +
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
      '<div class="small muted">162 נכסים · 12 מומחים · 6 נושאים · העלאה חופשית לכל עובד</div></div>' +
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
      var list = ASSETS.slice().sort(function (a, b) {
        return state.libSort === 'used' ? b.uses - a.uses : a.fresh - b.fresh;
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
          return a.open
            ? '<button type="button" class="card assetcard" data-act="go" data-arg="asset">' + body + '</button>'
            : '<div class="card assetcard">' + body + '</div>';
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
      '<h1 class="h1">' + esc(v.name + ' · ' + v.current.id + ' ' + v.current.title) + '</h1>' +
      '<div class="small muted">הוגש היום · יעד משוב: 3 ימי עבודה · אין ציון — תבנית משוב אחידה לכל שאלה</div></div>' +
      '<div class="cols">' +
      '<div class="card" style="flex:1 1 240px;padding:8px;display:flex;flex-direction:column">' +
      '<div class="rowitem" style="background:var(--color-accent-100)">' +
      '<span class="avatar-sm tint">' + esc(v.initials) + '</span>' +
      '<span class="body"><span class="t" style="color:var(--color-accent-800)">' + esc(v.name + ' · ' + v.current.id) + '</span>' +
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
      '<span class="tiny muted">הערה כללית לעובד/ת · שורה-שתיים בראש המבחן</span>' + textarea(2, '…') + '</div>' +
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
      textarea(3, 'שורה-שתיים על המסלול: מה בלט, מה להמשיך לפתח') +
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
      '<button type="button" class="btn btn-outline btn-sm" style="font-size:12px;padding:7px 12px;min-height:34px" data-act="toast" data-arg="תזכורת נשלחה">תזכורת</button></div>' +
      '<div class="escrow"><span>תל אביב · נעמה ברק ← שי לוין · 3.1 טראומה</span>' +
      '<span class="small" style="color:var(--color-warn-fg)">6 ימים</span>' +
      '<button type="button" class="btn btn-outline btn-sm" style="font-size:12px;padding:7px 12px;min-height:34px" data-act="toast" data-arg="תזכורת נשלחה">תזכורת</button></div>' +
      '<div class="escrow"><span>באר שבע · יובל אדרי ← ליאת כץ · 1.4 מכשירים</span>' +
      '<span class="small" style="color:var(--color-danger-fg)">11 ימים · הרכז מגיב</span>' +
      '<button type="button" class="btn btn-primary btn-sm" style="font-size:12px;padding:7px 12px;min-height:34px" data-act="go" data-arg="managerTest">לבדיקה</button></div>' +
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
      '<button type="button" class="btn btn-outline btn-block" style="justify-content:flex-start" data-act="toast" data-arg="נפתחה תבנית שיעור חדשה">' + icon('calendar-plus') + '<span>שיבוץ שיעור מתבנית</span></button>' +
      '<button type="button" class="btn btn-quiet btn-block" style="justify-content:flex-start" data-act="toast" data-arg="הזמנת אורח נשלחה · הרשאה ל-30 יום">' + icon('user-plus') + '<span>הזמנת מרצה חיצוני · אורח 30 יום</span></button>' +
      '<button type="button" class="btn btn-quiet btn-block" style="justify-content:flex-start" data-act="toast" data-arg="מחסן השאלות · 78 שאלות פעילות">' + icon('database') + '<span>מחסן השאלות · 78 שאלות</span></button>' +
      '<button type="button" class="btn btn-quiet btn-block" style="justify-content:flex-start" data-act="print">' + icon('file-arrow-down') + '<span>דוח רבעוני להנהלה</span></button>' +
      '</div></div></div></div>';
  };

  /* --------------------------------------------------------------- actions */

  var actions = {
    go: function (arg) { go(arg); },

    preview: function (arg) { set({ preview: arg }); },

    lang: function (arg) { set({ lang: arg }); },

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
      set({ testSubmitted: true, screen: 'home' }, { top: true });
    },

    submitFinal: function () {
      toast('המבחן המסכם הוגש ל' + MANAGER);
    },

    addPractice: function () {
      set({ practiceAdded: true, screen: 'file' }, { top: true });
      toast('הרשומה נשלחה לאישור ' + MANAGER);
    },

    submitQuiz: function () {
      set({ quizDone: true });
      toast('2 שעות המשך נזקפו לפנקס');
    },

    relevance: function (arg) { set({ relevance: Number(arg) }); },

    uploadPrivate: function (arg) { set({ uploadPrivate: arg === '1' }); },

    publishAsset: function () {
      set({ screen: 'library', libTab: 'assets' }, { top: true });
      toast('הנכס פורסם למאגר · רכז ההדרכה יתייג בדיעבד');
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
      set({ screen: 'admin' }, { top: true });
      toast('התצפית נשמרה בתיק העובד');
    },

    saveMeeting: function () {
      set({ screen: 'admin' }, { top: true });
      toast('סיכום השיחה נשלח לעובד/ת');
    },

    sendFeedback: function () {
      set({ screen: 'admin' }, { top: true });
      toast('המשוב נשלח · העובד/ת יקבל/תקבל התראה');
    },

    saveNote: function () {
      set({ screen: 'admin' }, { top: true });
      toast('הערת הסיכום נשמרה בתיק');
    },

    print: function () { window.print(); },

    account: function () { accountOpen = !accountOpen; render(); },

    signOut: function () {
      accountOpen = false;
      if (authApi && authApi.signOut) authApi.signOut();
      else location.reload();
    },

    toast: function (arg) { toast(arg); }
  };

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

  /* Bound inputs update state without re-rendering (so focus is never lost). */
  document.addEventListener('input', function (e) {
    var el = e.target;
    if (!el.getAttribute) return;
    var key = el.getAttribute('data-bind');
    if (!key) return;
    state[key] = el.value;
    save();
  });

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
      if (currentUser && currentUser.name && !(state.name || '').trim()) {
        // Someone who signed in with a real account has already identified
        // themselves; carry the name in and skip the demo registration form.
        state.name = currentUser.name;
        if (state.screen === 'register') { state.registered = true; state.screen = 'home'; }
        save();
      }
      render();
    }
  };

  if (!window.FP_GATED) render();
})();
