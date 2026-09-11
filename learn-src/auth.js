/* ==========================================================================
   Sign-in gate for the learning system.

   Two ways in, chosen by ms-config.js:
     • If a Microsoft Entra ID app is configured (clientId + tenantId), sign-in
       is the institute's Microsoft 365 account. (Kept for later.)
     • Otherwise, sign-in is an email + password account created here. Anyone
       may register, but a new account is *pending* until the system
       administrator approves it. Passwords are checked only on the server
       (learn-auth Edge Function) — never in the browser.

   The administrator is the address configured as LEARN_ADMIN_EMAIL on the
   server; that account is approved automatically and is the only one that may
   approve or reject the others. On sign-in the administrator sees every pending
   registration waiting for a decision.
   ========================================================================== */

(function () {
  'use strict';

  var CFG = window.MS_AUTH_CONFIG || {};
  var SESSION_KEY = 'feuerstein-learn-session';
  var msConfigured = !!(CFG.clientId && CFG.tenantId);

  var LEARN_AUTH_URL = 'https://tnfjcmmblrkhypprjacq.supabase.co/functions/v1/learn-auth';
  // Public anon key — only authorizes calling the function; identity comes from
  // the email+password the function verifies, and the token it signs.
  var LEARN_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRuZmpjbW1ibHJraHlwcHJqYWNxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc2NTE5ODMsImV4cCI6MjEwMzIyNzk4M30.SWp32bN-Pm-X4qDX8QbGQED5DYJBZQBg28C4vJ17gns';

  /* ------------------------------------------------------------------ logo */

  function logoMarkup(size) {
    return '' +
      '<div class="fp-logo" style="--logo-size:' + size + 'px">' +
      '<img src="data:image/png;base64,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" alt="מכון פוירשטיין"' +
      ' onerror="this.onerror=null;this.src=\'logo.svg\';this.addEventListener(\'error\',function(){' +
      'this.style.display=\'none\';this.parentNode.querySelector(\'.fp-logo-fallback\').hidden=false;},{once:true})">' +
      '<div class="fp-logo-fallback" hidden>' +
      '<svg viewBox="0 0 100 100" aria-hidden="true"><g fill="none" stroke-width="14">' +
      '<path d="M50 7a43 43 0 0 0-43 43" stroke="#E5B31C"/>' +
      '<path d="M50 7a43 43 0 0 1 43 43" stroke="#2B4C9B"/>' +
      '<path d="M7 50a43 43 0 0 0 43 43" stroke="#4E8B2C"/>' +
      '<path d="M93 50a43 43 0 0 1-43 43" stroke="#E03127"/>' +
      '</g></svg></div>' +
      // The official logo already carries the "מכון פוירשטיין" wordmark, so no
      // separate text line here (a plain fallback wordmark shows only if the
      // drawn ring is used).
      '<div class="fp-wordmark" data-fallback-only>מכון פוירשטיין</div></div>';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* --------------------------------------------------------------- session */

  function readSession() {
    try {
      var raw = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function writeSession(session) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) { /* ignore */ }
  }
  function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------- learn-auth calls */

  async function la(action, extra) {
    var res = await fetch(LEARN_AUTH_URL, {
      method: 'POST',
      headers: { apikey: LEARN_ANON, Authorization: 'Bearer ' + LEARN_ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action: action }, extra || {}))
    });
    var json = await res.json().catch(function () { return {}; });
    return json && typeof json === 'object' ? json : {};
  }

  var REG_ERRORS = {
    name_required: 'יש להזין שם מלא.',
    email_invalid: 'כתובת אימייל לא תקינה.',
    email_domain: 'הרשמה מותרת רק עם אימייל של הארגון (@icelp.org.il).',
    id_invalid: 'מספר תעודת זהות אינו תקין.',
    password_short: 'הסיסמה חייבת להיות באורך 8 תווים לפחות.',
    email_taken: 'כתובת האימייל כבר רשומה במערכת.',
    not_configured: 'מערכת ההרשמה עדיין לא הופעלה בשרת.',
    server_error: 'שגיאת שרת — נסה/י שוב.'
  };
  var LOGIN_ERRORS = {
    bad_credentials: 'אימייל או סיסמה שגויים.',
    pending: 'ההרשמה שלך ממתינה לאישור מנהל המערכת.',
    rejected: 'ההרשמה שלך לא אושרה. פנה/י למנהל המערכת.',
    not_configured: 'מערכת ההתחברות עדיין לא הופעלה בשרת.',
    server_error: 'שגיאת שרת — נסה/י שוב.'
  };

  /* -------------------------------------------------- client-side validators */

  var ALLOWED_DOMAIN = '@icelp.org.il';
  function validIsraeliId(raw) {
    var s = String(raw || '').trim();
    if (!/^\d{5,9}$/.test(s)) return false;
    while (s.length < 9) s = '0' + s;
    var sum = 0;
    for (var i = 0; i < 9; i++) {
      var n = Number(s[i]) * ((i % 2) + 1);
      if (n > 9) n -= 9;
      sum += n;
    }
    return sum % 10 === 0;
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
    return { name: acct.name || (acct.username || '').split('@')[0], email: acct.username || '', id: acct.homeAccountId || '', via: 'microsoft' };
  }
  async function initMsal() {
    if (!msConfigured || !window.msal) return null;
    if (!msalApp) { msalApp = new window.msal.PublicClientApplication(msalConfig()); await msalApp.initialize(); }
    return msalApp;
  }
  async function acquireIdToken() {
    try {
      var app = await initMsal(); if (!app) return null;
      var acct = app.getActiveAccount() || app.getAllAccounts()[0]; if (!acct) return null;
      var res = await app.acquireTokenSilent({ scopes: ['User.Read'], account: acct });
      return (res && res.idToken) || null;
    } catch (e) { return null; }
  }

  /* -------------------------------------------------------------- gate UI */

  var root = function () { return document.getElementById('root'); };
  function shell(inner) {
    root().innerHTML =
      '<div class="fp-gate"><div class="fp-gate-bg" aria-hidden="true"></div>' +
      '<div class="fp-gate-inner">' + logoMarkup(132) +
      '<div class="fp-gate-head"><h1>מערכת הלמידה</h1>' +
      '<p>מסלול ההכשרה, התיק האישי, שיעורי ההעשרה ומאגר הידע של מכון פוירשטיין.</p></div>' +
      '<div class="fp-gate-card">' + inner + '</div>' +
      '<a class="fp-gate-back" href="./">חזרה לבחירת מערכת</a>' +
      '</div></div>';
  }

  function busy(msg) { shell('<div class="fp-gate-busy"><span class="fp-spinner" aria-hidden="true"></span><span>' + esc(msg || 'רגע…') + '</span></div>'); }

  function gateMicrosoft(opts) {
    shell(
      '<button type="button" class="fp-ms-btn" id="fp-ms-signin"><span class="fp-ms-logo" aria-hidden="true">' +
      '<i style="background:#f25022"></i><i style="background:#7fba00"></i><i style="background:#00a4ef"></i><i style="background:#ffb900"></i></span>' +
      '<span>התחברות עם חשבון המכון</span></button>' +
      '<p class="fp-gate-note">אותו חשבון Microsoft 365 של Teams והמייל. הכניסה מול Microsoft — המערכת לא רואה את הסיסמה.</p>' +
      (opts && opts.error ? '<p class="fp-gate-error">' + esc(opts.error) + '</p>' : ''));
    var b = document.getElementById('fp-ms-signin');
    if (b) b.addEventListener('click', signInMicrosoft);
  }

  function tabbar(active) {
    return '<div class="fp-auth-tabs">' +
      '<button type="button" class="fp-auth-tab' + (active === 'login' ? ' on' : '') + '" data-tab="login">התחברות</button>' +
      '<button type="button" class="fp-auth-tab' + (active === 'register' ? ' on' : '') + '" data-tab="register">הרשמה</button>' +
      '</div>';
  }
  function wireTabs() {
    Array.prototype.forEach.call(document.querySelectorAll('.fp-auth-tab'), function (t) {
      t.addEventListener('click', function () { t.getAttribute('data-tab') === 'register' ? gateRegister() : gateLogin(); });
    });
  }

  function field(id, label, type, extra) {
    return '<label class="field"><span class="label">' + esc(label) + '</span>' +
      '<input class="input" id="' + id + '" type="' + type + '" ' + (extra || '') + ' autocomplete="off"></label>';
  }

  // Show a message under a form without re-rendering it, so nothing the user
  // typed is lost on a validation error.
  function setMsg(id, ok, text) {
    var el = document.getElementById(id);
    if (!el) return;
    el.hidden = false;
    el.className = 'fp-gate-' + (ok ? 'note' : 'error');
    el.textContent = text;
  }

  function gateLogin(msg) {
    shell(tabbar('login') +
      '<form id="fp-login" class="fp-auth-form">' +
      field('fp-l-email', 'אימייל', 'email', 'inputmode="email"') +
      field('fp-l-pass', 'סיסמה', 'password') +
      '<button type="submit" class="btn btn-primary btn-block" id="fp-l-submit">התחברות</button>' +
      '<p id="fp-l-msg" hidden></p>' +
      '</form>');
    wireTabs();
    document.getElementById('fp-login').addEventListener('submit', onLogin);
    if (msg) setMsg('fp-l-msg', !!msg.ok, msg.text);
  }

  function gateRegister(msg) {
    shell(tabbar('register') +
      '<form id="fp-register" class="fp-auth-form">' +
      field('fp-r-name', 'שם מלא', 'text') +
      field('fp-r-role', 'תפקיד', 'text') +
      field('fp-r-email', 'אימייל (@icelp.org.il)', 'email', 'inputmode="email"') +
      field('fp-r-id', 'תעודת זהות', 'text', 'inputmode="numeric"') +
      field('fp-r-pass', 'סיסמה', 'password') +
      field('fp-r-pass2', 'אימות סיסמה', 'password') +
      '<button type="submit" class="btn btn-primary btn-block" id="fp-r-submit">הרשמה</button>' +
      '<p id="fp-r-msg" hidden></p>' +
      '</form>');
    wireTabs();
    document.getElementById('fp-register').addEventListener('submit', onRegister);
    if (msg) setMsg('fp-r-msg', !!msg.ok, msg.text);
  }

  /* --------------------------------------------------------------- actions */

  async function onLogin(e) {
    e.preventDefault();
    var email = document.getElementById('fp-l-email').value.trim();
    var password = document.getElementById('fp-l-pass').value;
    var btn = document.getElementById('fp-l-submit');
    if (!email || !password) return setMsg('fp-l-msg', false, 'יש למלא אימייל וסיסמה.');
    btn.disabled = true; setMsg('fp-l-msg', true, 'מתחבר…');
    var r = await la('login', { email: email, password: password });
    if (r.ok && r.token) {
      writeSession({ via: 'password', token: r.token, user: r.user });
      return enter(r.user, r.token);
    }
    btn.disabled = false;
    setMsg('fp-l-msg', false, LOGIN_ERRORS[r.error] || 'ההתחברות נכשלה.');
  }

  async function onRegister(e) {
    e.preventDefault();
    var name = document.getElementById('fp-r-name').value.trim();
    var role = document.getElementById('fp-r-role').value.trim();
    var email = document.getElementById('fp-r-email').value.trim();
    var id = document.getElementById('fp-r-id').value.trim();
    var pass = document.getElementById('fp-r-pass').value;
    var pass2 = document.getElementById('fp-r-pass2').value;
    var btn = document.getElementById('fp-r-submit');
    if (!name) return setMsg('fp-r-msg', false, REG_ERRORS.name_required);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return setMsg('fp-r-msg', false, REG_ERRORS.email_invalid);
    if (!/^[^@\s]+@icelp\.org\.il$/i.test(email)) return setMsg('fp-r-msg', false, REG_ERRORS.email_domain);
    if (!validIsraeliId(id)) return setMsg('fp-r-msg', false, REG_ERRORS.id_invalid);
    if (pass.length < 8) return setMsg('fp-r-msg', false, REG_ERRORS.password_short);
    if (pass !== pass2) return setMsg('fp-r-msg', false, 'הסיסמאות אינן תואמות.');
    btn.disabled = true; setMsg('fp-r-msg', true, 'נרשם…');
    var r = await la('register', { fullName: name, role: role, email: email, nationalId: id, password: pass });
    if (r.ok) {
      if (r.status === 'approved') return gateLogin({ ok: true, text: 'ההרשמה הושלמה — אפשר להתחבר.' });
      // Pending: keep the message, disable further submits of the same form.
      return setMsg('fp-r-msg', true, 'תודה! ההרשמה נשלחה וממתינה לאישור מנהל המערכת. תקבל/י גישה לאחר האישור.');
    }
    btn.disabled = false;
    setMsg('fp-r-msg', false, REG_ERRORS[r.error] || 'ההרשמה נכשלה.');
  }

  async function signInMicrosoft() {
    busy('מתחבר…');
    try {
      var app = await initMsal();
      if (!app) throw new Error('ספריית ההתחברות לא נטענה');
      await app.loginRedirect({ scopes: ['User.Read'], prompt: 'select_account' });
    } catch (e) { gateMicrosoft({ error: 'ההתחברות נכשלה: ' + (e && e.message ? e.message : 'שגיאה') }); }
  }

  async function signOut() {
    var session = readSession();
    clearSession();
    removeAdminBar();
    if (session && session.via === 'microsoft' && msConfigured) {
      try { var app = await initMsal(); await app.logoutRedirect({ account: app.getAllAccounts()[0], postLogoutRedirectUri: location.origin + location.pathname }); return; } catch (e) { /* fall through */ }
    }
    location.reload();
  }

  function enter(user, token) {
    if (!(window.FeuersteinLearn && window.FeuersteinLearn.boot)) return;
    var api = { signOut: signOut };
    if (user && user.via === 'microsoft') api.getToken = acquireIdToken;
    window.FeuersteinLearn.boot(user, api);
    if (user && user.isAdmin) mountAdminBar(token);
  }

  /* ------------------------------------------------ admin: pending approvals

     The in-app "notification": once the administrator is signed in, a floating
     button shows how many registrations are waiting, and opens a panel to
     approve or reject each. On sign-in, if anything is waiting, it opens by
     itself. */

  var adminBar = null, adminToken = null, adminDocClick = null;

  function removeAdminBar() {
    if (adminDocClick) { document.removeEventListener('click', adminDocClick, true); adminDocClick = null; }
    if (adminBar) { adminBar.remove(); adminBar = null; }
    adminToken = null;
  }

  function setPanelOpen(open) {
    if (!adminBar) return;
    var p = adminBar.querySelector('.fp-admin-panel');
    var t = adminBar.querySelector('.fp-admin-toggle');
    p.hidden = !open;
    if (t) t.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) refreshPending(true);
  }

  async function mountAdminBar(token) {
    adminToken = token;
    removeAdminBarDom();
    adminBar = document.createElement('div');
    adminBar.className = 'fp-admin-bar';
    adminBar.innerHTML =
      '<div class="fp-admin-panel" hidden></div>' +
      '<button type="button" class="fp-admin-push" hidden></button>' +
      '<button type="button" class="fp-admin-toggle" aria-expanded="false">אישור הרשמות <span class="fp-admin-badge" hidden>0</span></button>';
    document.body.appendChild(adminBar);
    adminBar.querySelector('.fp-admin-toggle').addEventListener('click', function () {
      setPanelOpen(adminBar.querySelector('.fp-admin-panel').hidden);   // toggle
    });
    // A tap anywhere outside the bar closes the panel, so it never blocks the app.
    adminDocClick = function (e) {
      if (adminBar && !adminBar.contains(e.target) && !adminBar.querySelector('.fp-admin-panel').hidden) setPanelOpen(false);
    };
    document.addEventListener('click', adminDocClick, true);
    setupPushButton(token);
    // Only surface the count in the badge — never auto-open the panel over the app.
    await refreshPending(false);
  }

  /* -------------------------------------------- admin: phone push (Web Push)

     A single button in the admin bar lets the administrator turn on phone
     notifications. Subscribing needs a user gesture (the click) and HTTPS; the
     VAPID public key comes from the server's `config` action. Each new pending
     registration then triggers a Web Push from learn-auth to every device the
     admin subscribed. If push isn't configured on the server, the button stays
     hidden and the in-app badge alone carries the notification. */

  var pushCfg = null;
  function pushSupported() {
    return ('serviceWorker' in navigator) && ('PushManager' in window) && ('Notification' in window) && location.protocol === 'https:';
  }
  function urlB64ToU8(b64) {
    var pad = '='.repeat((4 - (b64.length % 4)) % 4);
    var raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  async function getPushConfig() {
    if (pushCfg) return pushCfg;
    var r = await la('config');
    pushCfg = (r && r.ok) ? r : { pushEnabled: false, vapidPublic: '' };
    return pushCfg;
  }
  async function existingSubscription() {
    try {
      var reg = await navigator.serviceWorker.getRegistration();
      if (reg) return await reg.pushManager.getSubscription();
    } catch (e) { /* ignore */ }
    return null;
  }
  // Make sure this device is subscribed AND the server has the subscription
  // stored. Idempotent: safe to call on every load; heals a server row that was
  // never saved or was pruned. Returns true when the server confirms the save.
  async function ensureSubscribed(token) {
    var cfg = await getPushConfig();
    if (!cfg.pushEnabled || !cfg.vapidPublic || !pushSupported() || Notification.permission !== 'granted') return false;
    try {
      var reg = await navigator.serviceWorker.getRegistration('sw.js') || await navigator.serviceWorker.register('sw.js');
      await navigator.serviceWorker.ready;
      var sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToU8(cfg.vapidPublic) });
      var r = await la('registerPush', { token: token, subscription: sub.toJSON() });
      return !!(r && r.ok);
    } catch (e) { return false; }
  }
  async function setupPushButton(token) {
    if (!adminBar) return;
    var btn = adminBar.querySelector('.fp-admin-push');
    if (!btn) return;
    var cfg = await getPushConfig();
    // Only truly hide the button when the server has no push configured at all.
    if (!cfg.pushEnabled || !cfg.vapidPublic) { btn.hidden = true; return; }
    btn.hidden = false;
    // Otherwise always show it, with a clear reason when it can't be turned on —
    // so the admin never faces a silently missing button.
    if (!pushSupported()) {
      var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent || '');
      btn.textContent = isIOS ? '🔔 הוסף למסך הבית לקבלת התראות' : '🔔 התראות אינן נתמכות בדפדפן זה';
      btn.disabled = true;
      return;
    }
    if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
      btn.textContent = '🔔 ההתראות חסומות — אפשר/י בהגדרות הדפדפן';
      btn.disabled = true;
      return;
    }
    var already = await existingSubscription();
    if (already) {
      // Already subscribed on this device: re-save to the server (heals a missing
      // row), then offer a working "send a test push" button.
      ensureSubscribed(token);
      btn.textContent = '🔔 שלח התראת בדיקה';
      btn.addEventListener('click', function () { sendTestPush(token, btn); });
      return;
    }
    btn.textContent = '🔔 הפעל התראות לנייד';
    btn.addEventListener('click', function () { enablePush(token, btn); });
  }
  async function sendTestPush(token, btn) {
    var label = btn.textContent;
    btn.disabled = true; btn.textContent = 'שולח…';
    try {
      var r = await la('testPush', { token: token });
      // If the server has no subscription, re-register this device and retry once.
      if (r && r.ok && r.subs === 0) {
        btn.textContent = 'רושם מחדש…';
        if (await ensureSubscribed(token)) r = await la('testPush', { token: token });
      }
      if (r && r.ok && (r.subs > 0) && Array.isArray(r.results) && r.results.some(function (x) { return x.ok; })) {
        btn.textContent = '✅ נשלח — בדוק/י את הנייד';
      } else if (r && r.ok && r.subs === 0) {
        btn.textContent = 'לא נמצא מנוי — הפעל/י שוב';
      } else {
        var first = (r && r.results && r.results[0]) || {};
        var st = first.status || (r && r.error) || '?';
        btn.textContent = 'השליחה נכשלה (' + st + ')';
        // Surface the push service's message so the exact reason is visible.
        if (first.body) { try { window.alert('פרטי שגיאת Push (' + st + '):\n' + first.body); } catch (e) { /* ignore */ } }
      }
    } catch (e) {
      btn.textContent = 'שגיאה בשליחה';
    }
    setTimeout(function () { btn.textContent = label; btn.disabled = false; }, 4000);
  }
  async function enablePush(token, btn) {
    btn.disabled = true;
    try {
      var cfg = await getPushConfig();
      if (!cfg.pushEnabled || !cfg.vapidPublic) { btn.textContent = 'התראות לנייד לא זמינות'; return; }
      var perm = await Notification.requestPermission();
      if (perm !== 'granted') { btn.textContent = 'ההרשאה נדחתה'; btn.disabled = false; return; }
      var reg = await navigator.serviceWorker.register('sw.js');
      await navigator.serviceWorker.ready;
      var sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToU8(cfg.vapidPublic) });
      var r = await la('registerPush', { token: token, subscription: sub.toJSON() });
      if (r && r.ok) { btn.textContent = '🔔 התראות לנייד פעילות'; }
      else { btn.textContent = 'הרישום נכשל — נסה/י שוב'; btn.disabled = false; }
    } catch (e) {
      btn.textContent = 'הפעלת התראות נכשלה'; btn.disabled = false;
    }
  }
  function removeAdminBarDom() { var e = document.querySelector('.fp-admin-bar'); if (e && e !== adminBar) e.remove(); }

  async function refreshPending(renderList) {
    if (!adminBar || !adminToken) return 0;
    var r = await la('pending', { token: adminToken });
    var list = (r && r.ok && Array.isArray(r.pending)) ? r.pending : [];
    var badge = adminBar.querySelector('.fp-admin-badge');
    badge.textContent = String(list.length);
    badge.hidden = list.length === 0;
    if (renderList) {
      var panel = adminBar.querySelector('.fp-admin-panel');
      var head = '<div class="fp-admin-head"><h3>הרשמות הממתינות לאישור</h3>' +
        '<button type="button" class="fp-admin-close" aria-label="סגירה">✕</button></div>';
      if (!list.length) {
        panel.innerHTML = head + '<p class="fp-admin-empty">אין הרשמות הממתינות לאישור.</p>';
      } else {
        panel.innerHTML = head + list.map(function (a) {
          return '<div class="fp-admin-row" data-id="' + esc(a.id) + '">' +
            '<div class="fp-admin-who"><strong>' + esc(a.full_name) + '</strong>' +
            '<span>' + esc(a.role || '—') + ' · ' + esc(a.email) + ' · ת"ז ' + esc(a.national_id) + '</span></div>' +
            '<div class="fp-admin-acts">' +
            '<button type="button" class="btn btn-sm btn-primary" data-act="approve">אישור</button>' +
            '<button type="button" class="btn btn-sm btn-outline" data-act="reject">דחייה</button>' +
            '</div></div>';
        }).join('');
        Array.prototype.forEach.call(panel.querySelectorAll('.fp-admin-row button'), function (btn) {
          btn.addEventListener('click', function () {
            var row = btn.closest('.fp-admin-row');
            decide(btn.getAttribute('data-act'), row.getAttribute('data-id'), row);
          });
        });
      }
      var closeBtn = panel.querySelector('.fp-admin-close');
      if (closeBtn) closeBtn.addEventListener('click', function () { setPanelOpen(false); });
    }
    return list.length;
  }

  async function decide(act, id, row) {
    if (act === 'reject' && !window.confirm('לדחות את ההרשמה?')) return;
    row.style.opacity = '0.5';
    var r = await la(act, { token: adminToken, id: id });
    if (r && r.ok) { row.remove(); refreshPending(false); } else { row.style.opacity = '1'; window.alert('הפעולה נכשלה — נסה/י שוב.'); }
  }

  /* ----------------------------------------------------------------- boot */

  async function start() {
    if (msConfigured && window.msal) {
      busy('מתחבר…');
      try {
        var app = await initMsal();
        var result = await app.handleRedirectPromise();
        if (result && result.account) { app.setActiveAccount(result.account); var u = accountToUser(result.account); writeSession({ via: 'microsoft', user: u }); return enter(u); }
        var existing = app.getAllAccounts();
        if (existing.length) { app.setActiveAccount(existing[0]); var k = accountToUser(existing[0]); writeSession({ via: 'microsoft', user: k }); return enter(k); }
      } catch (e) { return gateMicrosoft({ error: 'ההתחברות נכשלה: ' + (e && e.message ? e.message : 'שגיאה') }); }
      return gateMicrosoft();
    }

    // Email + password path. A stored session is re-validated against the server.
    var saved = readSession();
    if (saved && saved.token) {
      var r = await la('me', { token: saved.token });
      if (r && r.ok && r.user) { writeSession({ via: 'password', token: saved.token, user: r.user }); return enter(r.user, saved.token); }
      clearSession();
    }
    gateLogin();
  }

  window.FeuersteinAuth = { signOut: signOut };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
