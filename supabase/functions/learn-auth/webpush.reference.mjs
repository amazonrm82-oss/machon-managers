// Web Push (RFC 8291 payload encryption + RFC 8292 VAPID) using WebCrypto only,
// so the exact same code runs in Deno (Supabase Edge Functions) and in Node.
// Exported for offline round-trip testing; index.ts embeds an identical copy.
import { webcrypto as crypto } from 'node:crypto';
const subtle = crypto.subtle;
const enc = new TextEncoder();

export const b64u = (bytes) => Buffer.from(bytes).toString('base64').replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_');
export const unb64u = (s) => { s=String(s); const pad=s.length%4===0?'':'='.repeat(4-(s.length%4)); return new Uint8Array(Buffer.from(s.replace(/-/g,'+').replace(/_/g,'/')+pad,'base64')); };
const concat = (...arrs) => { let n=0; for(const a of arrs) n+=a.length; const o=new Uint8Array(n); let i=0; for(const a of arrs){o.set(a,i);i+=a.length;} return o; };

async function hmac(keyBytes, data){ const k=await subtle.importKey('raw',keyBytes,{name:'HMAC',hash:'SHA-256'},false,['sign']); return new Uint8Array(await subtle.sign('HMAC',k,data)); }
// HKDF: extract then expand to `len` bytes (len<=32 here).
async function hkdf(salt, ikm, info, len){ const prk=await hmac(salt, ikm); const out=await hmac(prk, concat(info, new Uint8Array([1]))); return out.slice(0,len); }

// ---- VAPID public/private (P-256). private = raw 32-byte scalar d; public = 65-byte uncompressed point ----
function jwkFromVapid(pubB64u, privB64u, usages){
  const pub = unb64u(pubB64u);           // 0x04 || X(32) || Y(32)
  const jwk = { kty:'EC', crv:'P-256', x:b64u(pub.slice(1,33)), y:b64u(pub.slice(33,65)), ext:true };
  if (privB64u) jwk.d = b64u(unb64u(privB64u));
  return jwk;
}

export async function buildVapidJwt(audience, subject, pubB64u, privB64u, ttlSec=12*3600){
  const header = { typ:'JWT', alg:'ES256' };
  const payload = { aud: audience, exp: Math.floor(Date.now()/1000)+ttlSec, sub: subject };
  const signingInput = b64u(enc.encode(JSON.stringify(header))) + '.' + b64u(enc.encode(JSON.stringify(payload)));
  const key = await subtle.importKey('jwk', jwkFromVapid(pubB64u, privB64u), { name:'ECDSA', namedCurve:'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await subtle.sign({ name:'ECDSA', hash:'SHA-256' }, key, enc.encode(signingInput)));
  return signingInput + '.' + b64u(sig);   // ES256 sig is raw R||S (64 bytes)
}

// ---- RFC 8291 payload encryption (aes128gcm) ----
// subscription: { endpoint, keys:{ p256dh, auth } }
export async function encryptPayload(subscription, payloadStr, asPub, asPriv){
  const uaPublic = unb64u(subscription.keys.p256dh);   // 65 bytes
  const authSecret = unb64u(subscription.keys.auth);   // 16 bytes
  // application-server ephemeral ECDH key (fresh per message unless injected for tests)
  let asPublicRaw, asPrivKey;
  if (asPub && asPriv){
    asPublicRaw = unb64u(asPub);
    asPrivKey = await subtle.importKey('jwk', jwkFromVapid(asPub, asPriv), { name:'ECDH', namedCurve:'P-256' }, false, ['deriveBits']);
  } else {
    const kp = await subtle.generateKey({ name:'ECDH', namedCurve:'P-256' }, true, ['deriveBits']);
    asPublicRaw = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
    asPrivKey = kp.privateKey;
  }
  const uaKey = await subtle.importKey('raw', uaPublic, { name:'ECDH', namedCurve:'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await subtle.deriveBits({ name:'ECDH', public: uaKey }, asPrivKey, 256));

  // RFC 8291 §3.4: combine auth + ecdh secrets
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublicRaw);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  // RFC 8188: single record = payload || 0x02 (last-record delimiter)
  const record = concat(enc.encode(payloadStr), new Uint8Array([2]));
  const aesKey = await subtle.importKey('raw', cek, { name:'AES-GCM' }, false, ['encrypt']);
  const ct = new Uint8Array(await subtle.encrypt({ name:'AES-GCM', iv: nonce }, aesKey, record));

  // RFC 8188 header: salt(16) || rs(4 BE) || idlen(1) || keyid(as_public,65)
  const rs = 4096;
  const header = concat(salt, new Uint8Array([(rs>>>24)&255,(rs>>>16)&255,(rs>>>8)&255,rs&255]), new Uint8Array([asPublicRaw.length]), asPublicRaw);
  return { body: concat(header, ct), asPublicRaw, salt };
}

// ---- independent receiver-side decrypt, for the round-trip test only ----
export async function decryptForTest(body, uaPrivB64u, uaPubB64u, authB64u){
  const salt = body.slice(0,16);
  const idlen = body[20];
  const asPublicRaw = body.slice(21, 21+idlen);
  const ct = body.slice(21+idlen);
  const authSecret = unb64u(authB64u);
  const uaPriv = await subtle.importKey('jwk', jwkFromVapid(uaPubB64u, uaPrivB64u), { name:'ECDH', namedCurve:'P-256' }, false, ['deriveBits']);
  const asKey = await subtle.importKey('raw', asPublicRaw, { name:'ECDH', namedCurve:'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await subtle.deriveBits({ name:'ECDH', public: asKey }, uaPriv, 256));
  const keyInfo = concat(enc.encode('WebPush: info\0'), unb64u(uaPubB64u), asPublicRaw);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aesKey = await subtle.importKey('raw', cek, { name:'AES-GCM' }, false, ['decrypt']);
  const pt = new Uint8Array(await subtle.decrypt({ name:'AES-GCM', iv: nonce }, aesKey, ct));
  return new TextDecoder().decode(pt.slice(0, pt.length-1)); // strip 0x02 delimiter
}

export async function genVapidKeys(){
  const kp = await subtle.generateKey({ name:'ECDSA', namedCurve:'P-256' }, true, ['sign','verify']);
  const jwk = await subtle.exportKey('jwk', kp.privateKey);
  const pub = concat(new Uint8Array([4]), unb64u(jwk.x), unb64u(jwk.y));
  return { publicKey: b64u(pub), privateKey: b64u(unb64u(jwk.d)) };
}
export async function genSubscriptionForTest(){
  const kp = await subtle.generateKey({ name:'ECDH', namedCurve:'P-256' }, true, ['deriveBits']);
  const jwk = await subtle.exportKey('jwk', kp.privateKey);
  const pub = concat(new Uint8Array([4]), unb64u(jwk.x), unb64u(jwk.y));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { p256dh: b64u(pub), authPriv: b64u(unb64u(jwk.d)), auth: b64u(auth) };
}
