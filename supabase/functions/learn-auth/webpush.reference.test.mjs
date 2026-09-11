import { webcrypto as crypto } from 'node:crypto';
import { buildVapidJwt, encryptPayload, decryptForTest, genVapidKeys, genSubscriptionForTest, b64u, unb64u } from './webpush.reference.mjs';
const subtle = crypto.subtle; const enc=new TextEncoder(); const dec=new TextDecoder();
let pass=0, fail=0; const chk=(n,c)=>{c?pass++:(fail++,console.log('FAIL:',n));};

// ---- VAPID JWT round-trip: build, then verify signature + claims with the public key ----
const vapid = await genVapidKeys();
const jwt = await buildVapidJwt('https://fcm.googleapis.com', 'mailto:admin@icelp.org.il', vapid.publicKey, vapid.privateKey);
const [h,p,s] = jwt.split('.');
const pub = unb64u(vapid.publicKey);
const verKey = await subtle.importKey('jwk', { kty:'EC', crv:'P-256', x:b64u(pub.slice(1,33)), y:b64u(pub.slice(33,65)) }, { name:'ECDSA', namedCurve:'P-256' }, false, ['verify']);
const sigOk = await subtle.verify({name:'ECDSA',hash:'SHA-256'}, verKey, unb64u(s), enc.encode(h+'.'+p));
chk('VAPID JWT signature verifies with public key', sigOk === true);
const claims = JSON.parse(dec.decode(unb64u(p)));
chk('JWT aud is push origin', claims.aud === 'https://fcm.googleapis.com');
chk('JWT sub is mailto', claims.sub === 'mailto:admin@icelp.org.il');
chk('JWT exp within 24h (RFC 8292)', claims.exp > Math.floor(Date.now()/1000) && claims.exp <= Math.floor(Date.now()/1000)+24*3600);
const hdr = JSON.parse(dec.decode(unb64u(h)));
chk('JWT header alg ES256', hdr.alg==='ES256' && hdr.typ==='JWT');
const tampered = h+'.'+b64u(enc.encode(JSON.stringify({...claims, sub:'mailto:evil@x'})))+'.'+s;
const [th,tp,ts]=tampered.split('.');
chk('tampered JWT fails verification', (await subtle.verify({name:'ECDSA',hash:'SHA-256'}, verKey, unb64u(ts), enc.encode(th+'.'+tp)))===false);

// ---- payload encryption round-trip: encrypt (sender) -> decrypt (receiver) recovers plaintext ----
const sub = await genSubscriptionForTest();
const subscription = { endpoint:'https://push.example/x', keys:{ p256dh: sub.p256dh, auth: sub.auth } };
const message = JSON.stringify({ title:'הרשמה חדשה', body:'עובד בדיקה ממתין לאישור', url:'/machon-managers/learn.html' });
const { body } = await encryptPayload(subscription, message);
chk('ciphertext body has RFC8188 header (idlen=65)', body[20]===65);
chk('body longer than header (has ciphertext+tag)', body.length > 21+65+16);
const recovered = await decryptForTest(body, sub.authPriv, sub.p256dh, sub.auth);
chk('receiver decrypts to original message', recovered === message);

// ---- tamper: flipping a ciphertext byte breaks GCM auth (decrypt throws) ----
const bad = Uint8Array.from(body); bad[bad.length-1]^=1;
let threw=false; try { await decryptForTest(bad, sub.authPriv, sub.p256dh, sub.auth); } catch { threw=true; }
chk('tampered ciphertext fails GCM auth', threw);

// ---- two encryptions of same payload differ (fresh ephemeral key + salt) ----
const a = await encryptPayload(subscription, message);
const b = await encryptPayload(subscription, message);
chk('two encryptions differ (fresh ephemeral+salt)', b64u(a.body)!==b64u(b.body));

// ---- a UTF-8 (Hebrew) payload survives round-trip exactly ----
const heb = 'שלום עולם — בדיקת יוניקוד 🎉';
const r2 = await decryptForTest((await encryptPayload(subscription, heb)).body, sub.authPriv, sub.p256dh, sub.auth);
chk('hebrew/emoji payload round-trips', r2===heb);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
