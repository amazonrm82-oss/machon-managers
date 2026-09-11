// Offline security tests for learning-gateway's Microsoft-token verification and
// per-user isolation. The verify function below MIRRORS verifyMicrosoftToken in
// index.ts (same checks, adapted to run under Node's WebCrypto); the isolation
// table mirrors the route authorization. Run: node verify.reference.test.mjs
import { webcrypto as crypto } from 'node:crypto';
const { subtle } = crypto;
const enc = new TextEncoder(), dec = new TextDecoder();
const b64urlStr = (buf) => Buffer.from(buf).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
function b64url(input){ const pad=input.length%4===0?'':'='.repeat(4-(input.length%4)); const bin=Buffer.from(input.replace(/-/g,'+').replace(/_/g,'/')+pad,'base64'); return new Uint8Array(bin); }

// ---- mirror of verifyMicrosoftToken (index.ts) ----
async function verify(token, { TENANT, CLIENT_ID, keys }) {
  if (!TENANT || !CLIENT_ID || !token) return null;
  const parts = token.split('.'); if (parts.length !== 3) return null;
  const [headB64, payloadB64, sigB64] = parts;
  let head, payload;
  try { head = JSON.parse(dec.decode(b64url(headB64))); payload = JSON.parse(dec.decode(b64url(payloadB64))); } catch { return null; }
  if (head.alg !== 'RS256') return null;
  const jwk = keys.find(k => k.kid === head.kid); if (!jwk) return null;
  const key = await subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name:'RSASSA-PKCS1-v1_5', hash:'SHA-256' }, false, ['verify']);
  const ok = await subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(sigB64).buffer, enc.encode(`${headB64}.${payloadB64}`));
  if (!ok) return null;
  const now = Math.floor(Date.now()/1000);
  if (payload.aud !== CLIENT_ID) return null;
  if (payload.tid !== TENANT) return null;
  if (typeof payload.exp !== 'number' || payload.exp < now - 60) return null;
  if (typeof payload.nbf === 'number' && payload.nbf > now + 60) return null;
  if (!String(payload.iss||'').includes(TENANT)) return null;
  if (!payload.oid) return null;
  return { oid: String(payload.oid), email: String(payload.preferred_username ?? payload.email ?? ''), name: String(payload.name ?? '') };
}

// ---- mirror of route authorization (mayRead + per-action rules) ----
function mayRead(actor, target, roles) {
  if (actor === target) return true;
  const a = roles[actor] ?? { role:'learner' };
  if (a.role === 'coordinator') return true;
  if (a.role === 'manager') { const t = roles[target] ?? { role:'learner' }; return t.manager_id === actor; }
  return false;
}
function mayFeedback(actor, target, roles) {
  const a = roles[actor] ?? { role:'learner' }; const t = roles[target] ?? { role:'learner' };
  return a.role === 'coordinator' || (a.role === 'manager' && t.manager_id === actor);
}

const TENANT='tenant-123', CLIENT_ID='client-abc';
let pass=0, fail=0; const chk=(n,c)=>{ c?pass++:(fail++,console.log('FAIL:',n)); };

const kp = await subtle.generateKey({ name:'RSASSA-PKCS1-v1_5', modulusLength:2048, publicExponent:new Uint8Array([1,0,1]), hash:'SHA-256' }, true, ['sign','verify']);
const jwk = await subtle.exportKey('jwk', kp.publicKey); jwk.kid='key1';
const keys=[{ kty:jwk.kty, n:jwk.n, e:jwk.e, kid:'key1' }];
const cfg={ TENANT, CLIENT_ID, keys };
const now=Math.floor(Date.now()/1000);
async function mint(payload, { kid='key1', alg='RS256', sign=true }={}) {
  const h=b64urlStr(enc.encode(JSON.stringify({ alg, kid, typ:'JWT' })));
  const p=b64urlStr(enc.encode(JSON.stringify(payload)));
  let s='';
  if (sign) { const sig=await subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, enc.encode(`${h}.${p}`)); s=b64urlStr(sig); }
  else s=b64urlStr(enc.encode('notarealsignature'));
  return `${h}.${p}.${s}`;
}
const base={ aud:CLIENT_ID, tid:TENANT, iss:`https://login.microsoftonline.com/${TENANT}/v2.0`, exp:now+3600, nbf:now-60, oid:'user-A', name:'Alice', preferred_username:'alice@inst' };

// token verification
chk('valid token accepted with oid', (await verify(await mint(base), cfg))?.oid === 'user-A');
chk('wrong audience rejected', (await verify(await mint({ ...base, aud:'someone-else' }), cfg)) === null);
chk('wrong tenant rejected', (await verify(await mint({ ...base, tid:'other-tenant' }), cfg)) === null);
chk('wrong issuer rejected', (await verify(await mint({ ...base, iss:'https://evil/' }), cfg)) === null);
chk('expired token rejected', (await verify(await mint({ ...base, exp:now-3600 }), cfg)) === null);
chk('not-yet-valid (nbf future) rejected', (await verify(await mint({ ...base, nbf:now+3600 }), cfg)) === null);
chk('missing oid rejected', (await verify(await mint({ ...base, oid:undefined }), cfg)) === null);
chk('bad signature rejected', (await verify(await mint(base, { sign:false }), cfg)) === null);
chk('alg=none rejected (alg confusion)', (await verify(await mint(base, { alg:'none' }), cfg)) === null);
chk('alg=HS256 rejected (alg confusion)', (await verify(await mint(base, { alg:'HS256' }), cfg)) === null);
chk('unknown kid rejected', (await verify(await mint(base, { kid:'other' }), cfg)) === null);
chk('empty token rejected', (await verify('', cfg)) === null);
chk('not configured (no tenant) rejected', (await verify(await mint(base), { TENANT:'', CLIENT_ID, keys })) === null);

// per-user isolation table
const roles = { manA:{ role:'manager' }, coord:{ role:'coordinator' }, learnerX:{ role:'learner', manager_id:'manA' }, learnerY:{ role:'learner', manager_id:'manB' } };
chk('learner reads own file', mayRead('learnerX','learnerX',roles) === true);
chk('learner CANNOT read another learner', mayRead('learnerX','learnerY',roles) === false);
chk('manager reads own team member', mayRead('manA','learnerX',roles) === true);
chk('manager CANNOT read non-team learner', mayRead('manA','learnerY',roles) === false);
chk('coordinator reads anyone', mayRead('coord','learnerY',roles) === true);
chk('feedback: manager to own team ok', mayFeedback('manA','learnerX',roles) === true);
chk('feedback: manager to non-team denied', mayFeedback('manA','learnerY',roles) === false);
chk('feedback: learner denied', mayFeedback('learnerX','learnerY',roles) === false);
chk('feedback: coordinator ok', mayFeedback('coord','learnerX',roles) === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
