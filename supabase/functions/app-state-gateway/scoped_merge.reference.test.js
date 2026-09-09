'use strict';
const { mergeScopedWrite } = require('./scoped_merge');
let pass = 0, fail = 0;
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function check(name, cond) { if (cond) { pass++; } else { fail++; console.log('FAIL:', name); } }
const A = 'inst_A', B = 'inst_B';
function server() {
  return {
    institutes: [
      { id: A, name: 'A', staffCanEditPettyCash: true, budget: [{ cat: 'x', allocated: 100 }], employees: [{ name: 'alice', salary: 5000 }], pettyCashTransactions: [{ id: 'pc1', amount: 10 }], pettyCashFloat: 500 },
      { id: B, name: 'B', budget: [{ cat: 'x', allocated: 200 }], employees: [{ name: 'bob', salary: 9000 }], pettyCashTransactions: [] },
    ],
    messages: [{ id: 'm1', text: 'hi', senderId: 'national' }],
    generalReports: [{ instituteId: A, title: 'A rep', status: 'ממתין' }, { instituteId: B, title: 'B rep', status: 'ממתין' }],
    historyEvents: [{ key: 'hA', instituteId: A, title: 'A hist' }, { key: 'hB', instituteId: B, title: 'B hist' }],
    procurementHistoryEvents: [{ key: 'pA', instituteId: A }, { key: 'pB', instituteId: B }],
    taskJournals: { national: ['t'] }, threadReadCounts: { group: 5 },
    yearlyArchives: [{ year: 2025 }], nationalManagerName: 'מתן', nationalManagerPhone: '050', lastArchiveYear: 2025,
    presence: { c1: { label: 'national', lastSeen: 1 } },
  };
}

// ---------- MANAGER ----------
// 1) manager updates own budget/salary — own changes, B untouched.
{
  const S = server(); const C = JSON.parse(JSON.stringify(S));
  C.institutes = [{ id: A, name: 'A', budget: [{ cat: 'x', allocated: 777 }], employees: [{ name: 'alice', salary: 6000 }], pettyCashTransactions: [{ id: 'pc1', amount: 10 }] }];
  const R = mergeScopedWrite(S, C, A, 'manager');
  check('mgr own budget', R.institutes.find(i => i.id === A).budget[0].allocated === 777);
  check('mgr own salary', R.institutes.find(i => i.id === A).employees[0].salary === 6000);
  check('mgr B untouched', eq(R.institutes.find(i => i.id === B), S.institutes.find(i => i.id === B)));
}
// 2) manager attack on B — ignored.
{
  const S = server(); const C = JSON.parse(JSON.stringify(S));
  C.institutes = [S.institutes[0], { id: B, name: 'HACK', employees: [{ name: 'bob', salary: 1 }] }];
  const R = mergeScopedWrite(S, C, A, 'manager');
  check('mgr attack B salary preserved', R.institutes.find(i => i.id === B).employees[0].salary === 9000);
  check('mgr attack B name preserved', R.institutes.find(i => i.id === B).name === 'B');
}
// 3) manager edits own general report IN PLACE (status) — no duplicate, B report preserved.
{
  const S = server();
  const C = { institutes: S.institutes, generalReports: [{ instituteId: A, title: 'A rep', status: 'טופל' }] };
  const R = mergeScopedWrite(S, C, A, 'manager');
  const aReports = R.generalReports.filter(r => r.instituteId === A);
  check('mgr report edited in place (no dup)', aReports.length === 1 && aReports[0].status === 'טופל');
  check('mgr B report preserved', R.generalReports.some(r => r.instituteId === B && r.title === 'B rep'));
}
// 4) manager cannot delete/edit B's report even by sending it changed.
{
  const S = server();
  const C = { institutes: S.institutes, generalReports: [{ instituteId: B, title: 'B rep', status: 'HACKED' }] };
  const R = mergeScopedWrite(S, C, A, 'manager');
  check('mgr cannot edit B report', R.generalReports.find(r => r.instituteId === B).status === 'ממתין');
  check('mgr own reports cleared when none sent for A', !R.generalReports.some(r => r.instituteId === A)); // client sent none for A => own slice empty (intentional delete-own)
}
// 5) manager history own-slice add + others preserved.
{
  const S = server();
  const C = { institutes: S.institutes, historyEvents: [{ key: 'hA', instituteId: A, title: 'A hist EDIT' }, { key: 'hA2', instituteId: A, title: 'new' }] };
  const R = mergeScopedWrite(S, C, A, 'manager');
  check('mgr history A edited', R.historyEvents.find(h => h.key === 'hA').title === 'A hist EDIT');
  check('mgr history A2 added', !!R.historyEvents.find(h => h.key === 'hA2'));
  check('mgr history B preserved', !!R.historyEvents.find(h => h.key === 'hB' && h.title === 'B hist'));
}

// ---------- STAFF ----------
// 6) staff updates only pettyCashTransactions; budget/salary attempts ignored.
{
  const S = server();
  const C = { institutes: [{ id: A, name: 'A-HACK', budget: [{ cat: 'x', allocated: 0 }], employees: [{ name: 'alice', salary: 1 }], pettyCashTransactions: [{ id: 'pc1', amount: 10 }, { id: 'pc2', amount: 50 }], pettyCashFloat: 99999, staffCanEditPettyCash: false }] };
  const R = mergeScopedWrite(S, C, A, 'staff');
  const a = R.institutes.find(i => i.id === A);
  check('staff pettyCash added', a.pettyCashTransactions.length === 2);
  check('staff cannot change budget', a.budget[0].allocated === 100);
  check('staff cannot change salary', a.employees[0].salary === 5000);
  check('staff cannot change name', a.name === 'A');
  check('staff cannot change pettyCashFloat', a.pettyCashFloat === 500);
  check('staff cannot flip staffCanEditPettyCash', a.staffCanEditPettyCash === true);
}
// 7) staff blocked entirely when institute set to view-only.
{
  const S = server(); S.institutes[0].staffCanEditPettyCash = false;
  const C = { institutes: [{ id: A, pettyCashTransactions: [{ id: 'pc1' }, { id: 'pcX' }] }] };
  const R = mergeScopedWrite(S, C, A, 'staff');
  check('staff view-only: pettyCash unchanged', R.institutes.find(i => i.id === A).pettyCashTransactions.length === 1);
}
// 8) staff can append own report but NOT edit/delete existing, and NOT touch B.
{
  const S = server();
  const C = { institutes: S.institutes, generalReports: [{ instituteId: A, title: 'A rep', status: 'HACK' }, { instituteId: A, title: 'staff new', status: 'ממתין' }, { instituteId: B, title: 'forge', status: 'x' }] };
  const R = mergeScopedWrite(S, C, A, 'staff');
  check('staff existing A report unchanged', R.generalReports.some(r => r.instituteId === A && r.title === 'A rep' && r.status === 'ממתין'));
  check('staff new A report appended', R.generalReports.some(r => r.title === 'staff new'));
  check('staff forge for B dropped', !R.generalReports.some(r => r.title === 'forge'));
  check('staff B report preserved', R.generalReports.some(r => r.instituteId === B && r.title === 'B rep'));
}
// 9) staff cannot modify history feeds at all.
{
  const S = server();
  const C = { institutes: S.institutes, historyEvents: [{ key: 'hA', instituteId: A, title: 'TAMPER' }, { key: 'hNew', instituteId: A }] };
  const R = mergeScopedWrite(S, C, A, 'staff');
  check('staff history unchanged', eq(R.historyEvents, S.historyEvents));
}

// ---------- shared / national (both roles) ----------
// 10) messages append-only; national fields preserved; maps append-only.
{
  const S = server();
  const C = { institutes: S.institutes, messages: [{ id: 'm1', text: 'TAMPER' }, { id: 'm2', text: 'new' }], nationalManagerName: 'HACK', yearlyArchives: [], threadReadCounts: { group: 999, mine: 3 } };
  const R = mergeScopedWrite(S, C, A, 'manager');
  check('m1 preserved', R.messages.find(m => m.id === 'm1').text === 'hi');
  check('m2 appended', !!R.messages.find(m => m.id === 'm2'));
  check('national name preserved', R.nationalManagerName === 'מתן');
  check('yearlyArchives preserved', eq(R.yearlyArchives, S.yearlyArchives));
  check('threadReadCounts existing preserved', R.threadReadCounts.group === 5);
  check('threadReadCounts new key added', R.threadReadCounts.mine === 3);
}
// 11) no institutes added; empty server safe.
{
  const S = server();
  const C = { institutes: [S.institutes[0], { id: 'inst_NEW', name: 'x' }] };
  const R = mergeScopedWrite(S, C, A, 'manager');
  check('no new institute', !R.institutes.find(i => i.id === 'inst_NEW') && R.institutes.length === 2);
}
{ check('empty server no crash', typeof mergeScopedWrite({}, { institutes: [{ id: A }] }, A, 'manager') === 'object'); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
