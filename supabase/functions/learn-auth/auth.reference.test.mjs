// Offline tests for learn-auth's security logic. Mirrors index.ts (password
// hashing, session tokens, Israeli-id checksum, email-domain rule, admin/approval
// decisions), run under Node's WebCrypto. Run: node auth.reference.test.mjs
import { webcrypto as crypto } from 'node:crypto';
const { subtle } = crypto; const enc = new TextEncoder(); const dec = new TextDecoder();
const b64u = (bytes) => Buffer.from(bytes).toString('base64').replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_');
const unb64u = (s) => { const pad=s.length%4===0?'':'='.repeat(4-(s.length%4)); return new Uint8Array(Buffer.from(s.replace(/-/g,'+').replace(/_/g,'/')+pad,'base64')); };
const ITER=210000;
async function hashPassword(pw){ const salt=crypto.getRandomValues(new Uint8Array(16)); const k=await subtle.importKey('raw',enc.encode(pw),'PBKDF2',false,['deriveBits']); const b=await subtle.deriveBits({name:'PBKDF2',salt,iterations:ITER,hash:'SHA-256'},k,256); return `pbkdf2$${ITER}$${b64u(salt)}$${b64u(new Uint8Array(b))}`; }
async function verifyPassword(pw,stored){ const p=String(stored||'').split('$'); if(p.length!==4||p[0]!=='pbkdf2')return false; const iter=parseInt(p[1],10); const salt=unb64u(p[2]); const exp=unb64u(p[3]); const k=await subtle.importKey('raw',enc.encode(pw),'PBKDF2',false,['deriveBits']); const b=new Uint8Array(await subtle.deriveBits({name:'PBKDF2',salt,iterations:iter,hash:'SHA-256'},k,exp.length*8)); if(b.length!==exp.length)return false; let d=0; for(let i=0;i<b.length;i++)d|=b[i]^exp[i]; return d===0; }
const SECRET='test-secret';
async function hk(u){ return subtle.importKey('raw',enc.encode(SECRET),{name:'HMAC',hash:'SHA-256'},false,u); }
async function issue(acct,ttl=3600){ const pl={sub:acct.id,email:acct.email,admin:!!acct.is_admin,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+ttl}; const p=b64u(enc.encode(JSON.stringify(pl))); const sig=await subtle.sign('HMAC',await hk(['sign']),enc.encode(p)); return `${p}.${b64u(new Uint8Array(sig))}`; }
async function verify(token,secret=SECRET){ if(!token)return null; const parts=token.split('.'); if(parts.length!==2)return null; try{ const key=await subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']); const ok=await subtle.verify('HMAC',key,unb64u(parts[1]).buffer,enc.encode(parts[0])); if(!ok)return null; const pl=JSON.parse(dec.decode(unb64u(parts[0]))); if(typeof pl.exp!=='number'||pl.exp<=Math.floor(Date.now()/1000))return null; return pl;}catch{return null;} }
function validId(raw){ const s=String(raw||'').trim(); if(!/^\d{5,9}$/.test(s))return false; const id=s.padStart(9,'0'); let sum=0; for(let i=0;i<9;i++){let n=Number(id[i])*((i%2)+1); if(n>9)n-=9; sum+=n;} return sum%10===0; }
const ADMIN='matanz@ice.org.il', DOMAIN='@icelp.org.il';
function emailAllowed(e){ e=e.trim().toLowerCase(); return e.endsWith(DOMAIN)||e===ADMIN; }

let pass=0,fail=0; const chk=(n,c)=>{c?pass++:(fail++,console.log('FAIL:',n));};

// --- password hashing ---
const h = await hashPassword('Sup3rSecret!');
chk('hash has pbkdf2 format', /^pbkdf2\$210000\$/.test(h));
chk('hash is not the plaintext', !h.includes('Sup3rSecret!'));
chk('correct password verifies', await verifyPassword('Sup3rSecret!', h) === true);
chk('wrong password rejected', await verifyPassword('wrong', h) === false);
chk('two hashes of same pw differ (random salt)', (await hashPassword('x')) !== (await hashPassword('x')));

// --- tokens ---
const tok = await issue({ id:'u1', email:'a@icelp.org.il', is_admin:false });
chk('valid token verifies, sub carried', (await verify(tok))?.sub === 'u1');
chk('tampered payload rejected', (await verify('AAAA.'+tok.split('.')[1])) === null);
chk('wrong secret rejected', (await verify(tok, 'other-secret')) === null);
chk('expired token rejected', (await verify(await issue({id:'u1',email:'a'}, -10))) === null);
const adminTok = await verify(await issue({ id:'a1', email:ADMIN, is_admin:true }));
chk('admin flag carried in token', adminTok?.admin === true);

// --- israeli id checksum ---
function makeValidId(prefix8){ for(let d=0; d<10; d++){ const cand=prefix8+d; if(validId(cand)) return cand; } return null; }
const goodId = makeValidId('1234567');  // 8-digit prefix -> 9-digit valid
chk('a computed valid id passes', goodId && validId(goodId));
chk('flipping its check digit fails', goodId && !validId(goodId.slice(0,8) + ((Number(goodId[8])+1)%10)));
chk('non-numeric id fails', !validId('12a4567'));
chk('empty id fails', !validId(''));
chk('known valid id 000000018 passes', validId('000000018'));

// --- email domain rule ---
chk('icelp domain allowed', emailAllowed('worker@icelp.org.il'));
chk('admin email allowed (domain-exempt)', emailAllowed('Matanz@ice.org.il'));
chk('other domain rejected', !emailAllowed('someone@gmail.com'));
chk('lookalike ice.org.il (non-admin) rejected', !emailAllowed('bob@ice.org.il'));

// --- admin/approval decision (mirror of register) ---
function registerDecision(email){ email=email.trim().toLowerCase(); const isAdmin = email===ADMIN; return { isAdmin, status: isAdmin?'approved':'pending' }; }
chk('admin email -> approved+admin', JSON.stringify(registerDecision('Matanz@ice.org.il'))==='{"isAdmin":true,"status":"approved"}');
chk('regular email -> pending, not admin', JSON.stringify(registerDecision('worker@icelp.org.il'))==='{"isAdmin":false,"status":"pending"}');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
