/* ==========================================================================
   Sign-in gate for the learning system.

   Authentication is the institute's own Microsoft 365 (Microsoft Entra ID)
   account — the same identity people already use for Teams, Outlook and
   SharePoint. No second password to manage.

   Configuration lives in ms-config.js next to this page, so IT can set the
   app registration values without rebuilding anything. Until those values
   are filled in, the gate says so plainly and offers a clearly-labelled
   demo entry so the system can still be shown.
   ========================================================================== */

(function () {
  'use strict';

  var CFG = window.MS_AUTH_CONFIG || {};
  var SESSION_KEY = 'feuerstein-learn-session';
  var configured = !!(CFG.clientId && CFG.tenantId);

  /* ------------------------------------------------------------------ logo */

  function logoMarkup(size) {
    return '' +
      '<div class="fp-logo" style="--logo-size:' + size + 'px">' +
      '<img src="logo.svg" alt="מכון פוירשטיין"' +
      ' onerror="this.onerror=null;this.src=\'logo.png\';this.addEventListener(\'error\',function(){' +
      'this.style.display=\'none\';this.parentNode.querySelector(\'.fp-logo-fallback\').hidden=false;},{once:true})">' +
      '<div class="fp-logo-fallback" hidden>' +
      '<svg viewBox="0 0 100 100" aria-hidden="true"><g fill="none" stroke-width="14">' +
      '<path d="M50 7a43 43 0 0 0-43 43" stroke="#E5B31C"/>' +
      '<path d="M50 7a43 43 0 0 1 43 43" stroke="#2B4C9B"/>' +
      '<path d="M7 50a43 43 0 0 0 43 43" stroke="#4E8B2C"/>' +
      '<path d="M93 50a43 43 0 0 1-43 43" stroke="#E03127"/>' +
      '</g></svg>' +
      '<span>מכון פוירשטיין</span>' +
      '</div></div>';
  }

  /* --------------------------------------------------------------- session */

  function readSession() {
    try {
      var raw = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function writeSession(user) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(user)); } catch (e) { /* ignore */ }
  }

  function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ MSAL */

  var msalApp = null;

  function msalConfig() {
    return {
      auth: {
        clientId: CFG.clientId,
        authority: 'https://login.microsoftonline.com/' + CFG.tenantId,
        redirectUri: CFG.redirectUri || (location.origin + location.pathname),
        navigateToLoginRequestUrl: true
      },
      cache: { cacheLocation: 'localStorage', storeAuthStateInCookie: false }
    };
  }

  function accountToUser(acct) {
    return {
      name: acct.name || (acct.username || '').split('@')[0],
      email: acct.username || '',
      id: acct.homeAccountId || '',
      via: 'microsoft'
    };
  }

  async function initMsal() {
    if (!configured || !window.msal) return null;
    if (!msalApp) {
      msalApp = new window.msal.PublicClientApplication(msalConfig());
      await msalApp.initialize();
    }
    return msalApp;
  }

  /* -------------------------------------------------------------- gate UI */

  function gate(opts) {
    opts = opts || {};
    var root = document.getElementById('root');

    var body;
    if (opts.busy) {
      body = '<div class="fp-gate-busy"><span class="fp-spinner" aria-hidden="true"></span>' +
        '<span>' + (opts.busy === true ? 'מתחבר…' : opts.busy) + '</span></div>';
    } else if (configured) {
      body =
        '<button type="button" class="fp-ms-btn" id="fp-ms-signin">' +
        '<span class="fp-ms-logo" aria-hidden="true">' +
        '<i style="background:#f25022"></i><i style="background:#7fba00"></i>' +
        '<i style="background:#00a4ef"></i><i style="background:#ffb900"></i></span>' +
        '<span>התחברות עם חשבון המכון</span></button>' +
        '<p class="fp-gate-note">אותו חשבון Microsoft 365 שבו את/ה משתמש/ת ב-Teams ובמייל. ' +
        'הכניסה מתבצעת מול השרתים של Microsoft — המערכת לא רואה את הסיסמה.</p>';
    } else {
      body =
        '<div class="fp-gate-warn">' +
        '<strong>ההתחברות ל-Microsoft עדיין לא הוגדרה.</strong>' +
        'צריך רישום אפליקציה ב-Microsoft Entra ID של המכון, ואז למלא את המזהים בקובץ ' +
        '<code>ms-config.js</code>. ההוראות המלאות נמצאות ב-<code>learn-src/README.md</code>.' +
        '</div>' +
        '<button type="button" class="fp-demo-btn" id="fp-demo-enter">כניסה לדמו · ללא התחברות</button>' +
        '<p class="fp-gate-note">מצב הדגמה: הנתונים מקומיים בדפדפן הזה בלבד.</p>';
    }

    root.innerHTML =
      '<div class="fp-gate">' +
      '<div class="fp-gate-bg" aria-hidden="true"></div>' +
      '<div class="fp-gate-inner">' +
      logoMarkup(84) +
      '<div class="fp-gate-head">' +
      '<h1>מערכת הלמידה</h1>' +
      '<p>מסלול ההכשרה, התיק האישי, שיעורי ההעשרה ומאגר הידע של מכון פוירשטיין.</p>' +
      '</div>' +
      '<div class="fp-gate-card">' + body +
      (opts.error ? '<p class="fp-gate-error">' + opts.error + '</p>' : '') +
      '</div>' +
      '<a class="fp-gate-back" href="./">חזרה לבחירת מערכת</a>' +
      '</div></div>';

    var signin = document.getElementById('fp-ms-signin');
    if (signin) signin.addEventListener('click', signIn);
    var demo = document.getElementById('fp-demo-enter');
    if (demo) demo.addEventListener('click', function () {
      var user = { name: '', email: '', id: 'demo', via: 'demo' };
      writeSession(user);
      enter(user);
    });
  }

  /* --------------------------------------------------------------- actions */

  async function signIn() {
    gate({ busy: true });
    try {
      var app = await initMsal();
      if (!app) throw new Error('ספריית ההתחברות לא נטענה');
      await app.loginRedirect({ scopes: ['User.Read'], prompt: 'select_account' });
    } catch (e) {
      gate({ error: 'ההתחברות נכשלה: ' + (e && e.message ? e.message : 'שגיאה לא ידועה') });
    }
  }

  async function signOut() {
    var session = readSession();
    clearSession();
    if (session && session.via === 'microsoft' && configured) {
      try {
        var app = await initMsal();
        var acct = app.getAllAccounts()[0];
        await app.logoutRedirect({ account: acct, postLogoutRedirectUri: location.origin + location.pathname });
        return;
      } catch (e) { /* fall through to a local sign-out */ }
    }
    location.reload();
  }

  function enter(user) {
    if (window.FeuersteinLearn && window.FeuersteinLearn.boot) {
      window.FeuersteinLearn.boot(user, { signOut: signOut });
    }
  }

  /* ----------------------------------------------------------------- boot */

  async function start() {
    // A redirect coming back from Microsoft has to be handled before anything else.
    if (configured && window.msal) {
      gate({ busy: true });
      try {
        var app = await initMsal();
        var result = await app.handleRedirectPromise();
        if (result && result.account) {
          app.setActiveAccount(result.account);
          var user = accountToUser(result.account);
          writeSession(user);
          return enter(user);
        }
        var existing = app.getAllAccounts();
        if (existing.length) {
          app.setActiveAccount(existing[0]);
          var known = accountToUser(existing[0]);
          writeSession(known);
          return enter(known);
        }
      } catch (e) {
        return gate({ error: 'ההתחברות נכשלה: ' + (e && e.message ? e.message : 'שגיאה לא ידועה') });
      }
      return gate();
    }

    // Not configured: a previous demo session still counts as signed in.
    var saved = readSession();
    if (saved) return enter(saved);
    gate();
  }

  window.FeuersteinAuth = { signOut: signOut, gate: gate, configured: configured };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
