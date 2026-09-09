/* Bundles learn-src/ into learn.html — one file with the CSS, the icons, the
 * MSAL library and the app inside it.
 *
 * ms-config.js is deliberately NOT inlined: it stays a separate file next to
 * learn.html so the Microsoft sign-in settings can change without a rebuild.
 *
 * Run: node build-learn.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const SRC = 'learn-src';
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

const css = read('styles.css');
const icons = read('icons.js');
const app = read('app.js');
const auth = read('auth.js');
const msal = read('vendor/msal-browser.min.js');

const html = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>מכון פוירשטיין — מערכת הלמידה</title>
<meta name="description" content="מסלול הכשרה, תיק עובד, שיעורי העשרה ומאגר ידע — מערכת הלמידה של מכון פוירשטיין.">
<meta name="theme-color" content="#f3f5fe">
<meta name="color-scheme" content="light">
<link rel="manifest" href="manifest.json">
<link rel="icon" href="icon-32.png">
<link rel="apple-touch-icon" href="icon-180.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="למידה">
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<div id="toast" class="toast" role="status" aria-live="polite"></div>
<noscript>
  <div style="padding:32px;font-family:system-ui;max-width:60ch;margin:0 auto">
    <h1>מערכת הלמידה של מכון פוירשטיין</h1>
    <p>המערכת דורשת JavaScript. הפעל/י JavaScript בדפדפן וטען/י מחדש.</p>
  </div>
</noscript>
<script>window.FP_GATED = true;</script>
<script src="ms-config.js"></script>
<script>${msal}</script>
<script>${icons}</script>
<script>${app}</script>
<script>${auth}</script>
</body>
</html>
`;

fs.writeFileSync('learn.html', html);
console.log(`learn.html — ${(fs.statSync('learn.html').size / 1024).toFixed(0)} KB`);
