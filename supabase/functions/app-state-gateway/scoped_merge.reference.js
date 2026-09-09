'use strict';
// Pure merge logic for a scoped (institute_<id> / staff_<id>) write to app_state.
// This exact logic is mirrored verbatim into app-state-gateway/index.ts.
//
// Rule: start from the AUTHORITATIVE server blob S; apply only what a scoped role is
// permitted to change. A scoped role can fully replace ONLY its own institute entry,
// and may APPEND to shared feeds — it can never modify/delete another institute, edit
// or remove others' messages/reports/history, or change national settings.

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

// Append-only array union keyed by a field (e.g. 'id' or 'key'): keep every server
// item as-is, then append client items whose key is not already present on the server.
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

// Append-only array union by deep-equality (for items without a stable id, e.g.
// generalReports). keepItem can reject items that don't belong to the scope.
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

// Append-only object-map merge: keep every server key/value, add only client keys the
// server doesn't already have (never overwrite or delete an existing key).
function appendKeys(serverMap, clientMap) {
  const out = isObj(serverMap) ? { ...serverMap } : {};
  if (!isObj(clientMap)) return out;
  for (const k of Object.keys(clientMap)) {
    if (!(k in out)) out[k] = clientMap[k];
  }
  return out;
}

// Merge presence (ephemeral "online now"): overlay client entries, drop nothing here
// (stale pruning already happens client-side). Not sensitive.
function mergePresence(serverP, clientP) {
  const out = isObj(serverP) ? { ...serverP } : {};
  if (isObj(clientP)) for (const k of Object.keys(clientP)) out[k] = clientP[k];
  return out;
}

// Build the blob to persist when a scoped role writes. S = current server blob,
// C = client-submitted blob, instituteId = the scope from the token.
function mergeScopedWrite(S, C, instituteId) {
  const server = isObj(S) ? S : {};
  const client = isObj(C) ? C : {};
  // Start from an authoritative copy of the server blob so anything not explicitly
  // permitted below is preserved exactly as the server has it.
  const R = JSON.parse(JSON.stringify(server));

  // institutes: replace ONLY the scope's own entry; every other institute stays as the
  // server has it. Never add or remove institutes.
  if (Array.isArray(server.institutes)) {
    const own = Array.isArray(client.institutes)
      ? client.institutes.find((i) => i && i.id === instituteId)
      : null;
    if (own && own.id === instituteId) {
      R.institutes = server.institutes.map((i) => (i && i.id === instituteId ? own : i));
    } else {
      R.institutes = server.institutes;
    }
  }

  // Shared feeds — append-only.
  R.messages = appendByKey(server.messages, client.messages, 'id');
  R.generalReports = appendByEquality(server.generalReports, client.generalReports,
    (r) => r && r.instituteId === instituteId); // may only file reports for own institute
  R.historyEvents = appendByKey(server.historyEvents, client.historyEvents, 'key');
  R.procurementHistoryEvents = appendByKey(server.procurementHistoryEvents, client.procurementHistoryEvents, 'key');

  // Shared maps — append-only keys.
  R.taskJournals = appendKeys(server.taskJournals, client.taskJournals);
  R.threadReadCounts = appendKeys(server.threadReadCounts, client.threadReadCounts);

  // Presence — ephemeral, overlay.
  R.presence = mergePresence(server.presence, client.presence);

  // Everything else (nationalManagerName/Phone, yearlyArchives, lastYearCloseSnapshot,
  // lastArchiveYear, and any field not handled above) is left exactly as the server
  // had it — a scoped role can never change national settings or archives.
  return R;
}

module.exports = { mergeScopedWrite, appendByKey, appendByEquality, appendKeys };
