'use strict';
const { mergeScopedWrite } = require('./scoped_merge');
let pass = 0, fail = 0;
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function check(name, cond) { if (cond) { pass++; } else { fail++; console.log('FAIL:', name); } }

const A = 'inst_A', B = 'inst_B';
function server() {
  return {
    institutes: [
      { id: A, name: 'A', budget: [{ cat: 'x', allocated: 100 }], employees: [{ name: 'alice', salary: 5000 }] },
      { id: B, name: 'B', budget: [{ cat: 'x', allocated: 200 }], employees: [{ name: 'bob', salary: 9000 }] },
    ],
    messages: [{ id: 'm1', text: 'hi', senderId: 'national' }],
    generalReports: [{ instituteId: B, title: 'B report', status: 'ממתין' }],
    historyEvents: [{ key: 'h1', what: 'old' }],
    procurementHistoryEvents: [{ key: 'p1' }],
    taskJournals: { national: ['t'] },
    threadReadCounts: { group: 5 },
    yearlyArchives: [{ year: 2025 }],
    nationalManagerName: 'מתן', nationalManagerPhone: '050',
    lastArchiveYear: 2025,
    presence: { c1: { label: 'national', lastSeen: 1 } },
  };
}

// 1) Legit: institute A manager updates its own budget+salary — own entry changes, B untouched.
{
  const S = server();
  const C = JSON.parse(JSON.stringify(S));
  C.institutes = [{ id: A, name: 'A', budget: [{ cat: 'x', allocated: 777 }], employees: [{ name: 'alice', salary: 6000 }] }];
  const R = mergeScopedWrite(S, C, A);
  check('own budget updated', R.institutes.find((i) => i.id === A).budget[0].allocated === 777);
  check('own salary updated', R.institutes.find((i) => i.id === A).employees[0].salary === 6000);
  check('other institute B untouched', eq(R.institutes.find((i) => i.id === B), S.institutes.find((i) => i.id === B)));
  check('still 2 institutes', R.institutes.length === 2);
}

// 2) ATTACK: A manager tries to change B's salary and drop B — must not work.
{
  const S = server();
  const C = JSON.parse(JSON.stringify(S));
  C.institutes = [
    { id: A, name: 'A', budget: [{ cat: 'x', allocated: 100 }], employees: [{ name: 'alice', salary: 5000 }] },
    { id: B, name: 'B-HACKED', budget: [{ cat: 'x', allocated: 0 }], employees: [{ name: 'bob', salary: 1 }] },
  ];
  const R = mergeScopedWrite(S, C, A);
  check('attack: B salary preserved', R.institutes.find((i) => i.id === B).employees[0].salary === 9000);
  check('attack: B name preserved', R.institutes.find((i) => i.id === B).name === 'B');
}

// 3) ATTACK: scoped client omits all other institutes (sends only its own) — others must survive.
{
  const S = server();
  const C = { institutes: [{ id: A, name: 'A', budget: [], employees: [] }] };
  const R = mergeScopedWrite(S, C, A);
  check('omit-others: B still present', !!R.institutes.find((i) => i.id === B));
  check('omit-others: B intact', R.institutes.find((i) => i.id === B).employees[0].salary === 9000);
  check('omit-others: still 2', R.institutes.length === 2);
}

// 4) ATTACK: scoped client tries to add a brand-new institute — must be ignored.
{
  const S = server();
  const C = { institutes: [{ id: A, name: 'A' }, { id: 'inst_NEW', name: 'sneaky' }] };
  const R = mergeScopedWrite(S, C, A);
  check('no new institute added', !R.institutes.find((i) => i.id === 'inst_NEW'));
  check('still 2 institutes', R.institutes.length === 2);
}

// 5) messages: append own new message; cannot delete or edit existing ones.
{
  const S = server();
  const C = { institutes: S.institutes, messages: [{ id: 'm2', text: 'from A mgr', senderId: 'instituteManager' }] };
  const R = mergeScopedWrite(S, C, A);
  check('msg appended', R.messages.length === 2 && R.messages.find((m) => m.id === 'm2'));
  check('existing msg preserved', R.messages.find((m) => m.id === 'm1').text === 'hi');
}
{ // attack: try to overwrite m1 and delete by omission
  const S = server();
  const C = { institutes: S.institutes, messages: [{ id: 'm1', text: 'TAMPERED', senderId: 'x' }] };
  const R = mergeScopedWrite(S, C, A);
  check('msg m1 not tampered', R.messages.find((m) => m.id === 'm1').text === 'hi');
}

// 6) generalReports: may add own-institute report; report for another institute is dropped; existing preserved.
{
  const S = server();
  const C = { institutes: S.institutes, generalReports: [
    { instituteId: A, title: 'A new', status: 'ממתין' },   // allowed
    { instituteId: B, title: 'forge for B', status: 'ממתין' }, // must be dropped
  ] };
  const R = mergeScopedWrite(S, C, A);
  check('own report added', !!R.generalReports.find((r) => r.title === 'A new' && r.instituteId === A));
  check('forged B report dropped', !R.generalReports.find((r) => r.title === 'forge for B'));
  check('existing B report preserved', !!R.generalReports.find((r) => r.title === 'B report'));
}

// 7) national-only fields cannot be changed by a scoped write.
{
  const S = server();
  const C = { institutes: S.institutes, nationalManagerName: 'HACK', nationalManagerPhone: '000', yearlyArchives: [], lastArchiveYear: 1999 };
  const R = mergeScopedWrite(S, C, A);
  check('nationalManagerName preserved', R.nationalManagerName === 'מתן');
  check('nationalManagerPhone preserved', R.nationalManagerPhone === '050');
  check('yearlyArchives preserved', eq(R.yearlyArchives, S.yearlyArchives));
  check('lastArchiveYear preserved', R.lastArchiveYear === 2025);
}

// 8) maps append-only keys: add own new key, cannot overwrite existing.
{
  const S = server();
  const C = { institutes: S.institutes, threadReadCounts: { group: 999, private_A: 3 }, taskJournals: { national: ['HACK'], A: ['mine'] } };
  const R = mergeScopedWrite(S, C, A);
  check('existing threadReadCounts key preserved', R.threadReadCounts.group === 5);
  check('new threadReadCounts key added', R.threadReadCounts.private_A === 3);
  check('existing taskJournals key preserved', eq(R.taskJournals.national, ['t']));
  check('new taskJournals key added', eq(R.taskJournals.A, ['mine']));
}

// 9) historyEvents append-only by key.
{
  const S = server();
  const C = { institutes: S.institutes, historyEvents: [{ key: 'h1', what: 'TAMPER' }, { key: 'h2', what: 'new' }] };
  const R = mergeScopedWrite(S, C, A);
  check('history h1 preserved', R.historyEvents.find((h) => h.key === 'h1').what === 'old');
  check('history h2 added', !!R.historyEvents.find((h) => h.key === 'h2'));
}

// 10) empty/missing server institutes handled gracefully.
{
  const R = mergeScopedWrite({}, { institutes: [{ id: A }] }, A);
  check('no crash on empty server', typeof R === 'object');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
