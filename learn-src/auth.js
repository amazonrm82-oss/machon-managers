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
      '<img src="logo.svg" alt="מכון פוירשטיין"' +
      ' onerror="this.onerror=null;this.src=\'logo.png\';this.addEventListener(\'error\',function(){' +
      'this.style.display=\'none\';this.parentNode.querySelector(\'.fp-logo-fallback\').hidden=false;},{once:true})">' +
      '<div class="fp-logo-fallback" hidden>' +
      '<svg viewBox="0 0 100 100" aria-hidden="true"><g fill="none" stroke-width="14">' +
      '<path d="M50 7a43 43 0 0 0-43 43" stroke="#E5B31C"/>' +
      '<path d="M50 7a43 43 0 0 1 43 43" stroke="#2B4C9B"/>' +
      '<path d="M7 50a43 43 0 0 0 43 43" stroke="#4E8B2C"/>' +
      '<path d="M93 50a43 43 0 0 1-43 43" stroke="#E03127"/>' +
      '</g></svg></div>' +
      '<div class="fp-wordmark">מכון פוירשטיין</div></div>';
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
      '<div class="fp-gate-inner">' + logoMarkup(84) +
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
    if (!cfg.pushEnabled || !cfg.vapidPublic || !pushSupported() || Notification.permission === 'denied') return;
    var already = await existingSubscription();
    if (already) {
      // Already subscribed on this device: re-save to the server (heals a missing
      // row), then offer a working "send a test push" button.
      ensureSubscribed(token);
      btn.textContent = '🔔 שלח התראת בדיקה';
      btn.hidden = false;
      btn.addEventListener('click', function () { sendTestPush(token, btn); });
      return;
    }
    btn.textContent = '🔔 הפעל התראות לנייד';
    btn.hidden = false;
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
