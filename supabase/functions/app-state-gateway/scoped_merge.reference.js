'use strict';
// Pure merge logic for a scoped write to app_state. Mirrored verbatim into
// app-state-gateway/index.ts. Start from the AUTHORITATIVE server blob S and apply
// only what the given scoped role may change.
//
// role: 'manager' (institute_<id>) or 'staff' (staff_<id>).
//  - manager: full control of its own institute entry; add/edit/delete its own
//    institute's general reports and history entries in place; append chat messages.
//  - staff: only its own institute's pettyCashTransactions (and only if the institute
//    still allows it via staffCanEditPettyCash), and may append (not edit/delete) its
//    own general reports. Nothing else.
// Neither role can ever touch another institute, edit/delete others' feed items, or
// change national settings.

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

// Append-only array union keyed by a field: keep every server item, append client
// items whose key isn't already present (optionally filtered by keepItem).
function appendByKey(serverArr, clientArr, keyField, keepItem) {
  const out = Array.isArray(serverArr) ? serverArr.slice() : [];
  if (!Array.isArray(clientArr)) return out;
  const seen = new Set(out.map((it) => it && it[keyField]));
  for (const it of clientArr) {
    if (!it || typeof it !== 'object') continue;
    const k = it[keyField];
    if (k === undefined || k === null || seen.has(k)) continue;
    if (keepItem && !keepItem(it)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

// Append-only by deep-equality (items with no stable id); keepItem can reject items.
function appendByEquality(serverArr, clientArr, keepItem) {
  const out = Array.isArray(serverArr) ? serverArr.slice() : [];
  if (!Array.isArray(clientArr)) return out;
  const sigs = new Set(out.map((it) => JSON.stringify(it)));
  for (const it of clientArr) {
    if (!it || typeof it !== 'object') continue;
    const sig = JSON.stringify(it);
    if (sigs.has(sig)) continue;
    if (keepItem && !keepItem(it)) continue;
    sigs.add(sig);
    out.push(it);
  }
  return out;
}

// In-place "own slice": for a collection whose items carry instituteId, keep every
// server item belonging to ANOTHER institute untouched, and replace the scope's own
// slice with exactly what the client submitted for its own institute. This lets the
// owner add / edit / delete its own items without duplication, and can never affect
// another institute's items.
function replaceOwnSlice(serverArr, clientArr, scope) {
  const kept = (Array.isArray(serverArr) ? serverArr : []).filter((it) => !it || it.instituteId !== scope);
  const mine = (Array.isArray(clientArr) ? clientArr : []).filter((it) => it && it.instituteId === scope);
  return kept.concat(mine);
}

// Append-only object-map merge: keep every server key/value, add only client keys the
// server doesn't already have.
function appendKeys(serverMap, clientMap) {
  const out = isObj(serverMap) ? { ...serverMap } : {};
  if (!isObj(clientMap)) return out;
  for (const k of Object.keys(clientMap)) if (!(k in out)) out[k] = clientMap[k];
  return out;
}

function mergePresence(serverP, clientP) {
  const out = isObj(serverP) ? { ...serverP } : {};
  if (isObj(clientP)) for (const k of Object.keys(clientP)) out[k] = clientP[k];
  return out;
}

// Compute the scope's own institute entry after a write, applying the role's field
// permissions. Returns the entry to store for that institute.
function mergeOwnInstitute(sOwn, cOwn, role) {
  if (!sOwn) return sOwn; // scope's institute must already exist; never created here
  if (!cOwn || cOwn.id !== sOwn.id) return sOwn;
  if (role === 'manager') return cOwn; // full control of own entry
  // staff: only pettyCashTransactions, and only if the institute still allows it.
  if (sOwn.staffCanEditPettyCash === false) return sOwn;
  const next = { ...sOwn };
  if (Array.isArray(cOwn.pettyCashTransactions)) next.pettyCashTransactions = cOwn.pettyCashTransactions;
  return next;
}

function mergeScopedWrite(S, C, instituteId, role) {
  const server = isObj(S) ? S : {};
  const client = isObj(C) ? C : {};
  const R = JSON.parse(JSON.stringify(server));
  const isManager = role === 'manager';

  // institutes: change ONLY the scope's own entry, per role permissions.
  if (Array.isArray(server.institutes)) {
    const sOwn = server.institutes.find((i) => i && i.id === instituteId) || null;
    const cOwn = Array.isArray(client.institutes) ? client.institutes.find((i) => i && i.id === instituteId) : null;
    const newOwn = mergeOwnInstitute(sOwn, cOwn, role);
    R.institutes = server.institutes.map((i) => (i && i.id === instituteId ? newOwn : i));
  }

  // messages: append-only by id for both roles (chat history is immutable; staff can't
  // send anyway, so this is a no-op for them).
  R.messages = appendByKey(server.messages, client.messages, 'id');

  // generalReports / history feeds (carry instituteId):
  //  - manager: manage own slice in place (add/edit/delete own; others preserved).
  //  - staff: may only APPEND own-institute reports; history feeds preserved untouched.
  if (isManager) {
    R.generalReports = replaceOwnSlice(server.generalReports, client.generalReports, instituteId);
    R.historyEvents = replaceOwnSlice(server.historyEvents, client.historyEvents, instituteId);
    R.procurementHistoryEvents = replaceOwnSlice(server.procurementHistoryEvents, client.procurementHistoryEvents, instituteId);
  } else {
    R.generalReports = appendByEquality(server.generalReports, client.generalReports, (r) => r && r.instituteId === instituteId);
    R.historyEvents = Array.isArray(server.historyEvents) ? server.historyEvents : [];
    R.procurementHistoryEvents = Array.isArray(server.procurementHistoryEvents) ? server.procurementHistoryEvents : [];
  }

  // Shared maps — append-only keys (never overwrite/delete an existing key).
  R.taskJournals = appendKeys(server.taskJournals, client.taskJournals);
  R.threadReadCounts = appendKeys(server.threadReadCounts, client.threadReadCounts);

  // Presence — ephemeral overlay.
  R.presence = mergePresence(server.presence, client.presence);

  // Everything else (nationalManagerName/Phone, yearlyArchives, lastYearCloseSnapshot,
  // lastArchiveYear, any unknown field) stays exactly as the server had it.
  return R;
}

module.exports = { mergeScopedWrite, appendByKey, appendByEquality, appendKeys, replaceOwnSlice, mergeOwnInstitute };
