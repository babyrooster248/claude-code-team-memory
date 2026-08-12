// Compares every scored run sitting in this directory.
//
//   node run-eval.js --model haiku --runs 3
//   node run-eval.js --model sonnet --runs 3
//   node compare-models.js
//
// Why this exists as its own script rather than a note in the README: the model turned out to
// be the dominant variable in this filter's accuracy, and not in the direction anyone assumes.
// Recall measured 94.4% on a small model and 50.0% on a larger one, because the DROP rules are
// a checklist that a smaller model follows and a larger one reasons its way around. A harness
// that takes the model as an incidental flag invites exactly the mistake that hid it: one
// number, in one README, with no model beside it.
//
// The disagreement table is the useful half. Cases every model gets right say nothing; a case
// two models split on is either an ambiguous label or a real difference in how the rules land.
const fs = require('fs');
const path = require('path');

const here = __dirname;
const files = fs.readdirSync(here).filter(f => /^last-run-.+\.json$/.test(f)).sort();
if (!files.length) {
  console.error('No scored runs found. Run: node run-eval.js --model <name> --runs 3');
  process.exit(1);
}

// Older runs wrote a bare array; newer ones wrap it with the model and CLI version.
const runs = files.map((f) => {
  const raw = JSON.parse(fs.readFileSync(path.join(here, f), 'utf8'));
  const results = Array.isArray(raw) ? raw : raw.results;
  const model = Array.isArray(raw) ? f.replace(/^last-run-|\.json$/g, '') : raw.model;
  return { model, cli: raw.cli || 'unrecorded', date: raw.date || 'unrecorded', results };
});

const pct = n => (100 * n).toFixed(1) + '%';
const score = (results) => {
  const tp = results.filter(r => r.expect === 'keep' && r.verdict === 'KEEP').length;
  const fp = results.filter(r => r.expect === 'drop' && r.verdict === 'KEEP').length;
  const fn = results.filter(r => r.expect === 'keep' && r.verdict === 'DROP').length;
  const tn = results.filter(r => r.expect === 'drop' && r.verdict === 'DROP').length;
  return {
    n: results.length,
    accuracy: (tp + tn) / results.length,
    precision: tp + fp ? tp / (tp + fp) : 1,
    recall: tp + fn ? tp / (tp + fn) : 1,
    fp, fn,
    unstable: results.filter(r => r.stable === false).length,
  };
};

const w = Math.max(8, ...runs.map(r => r.model.length));
console.log('model'.padEnd(w) + '  acc     prec    recall  junk-in  lost  unstable  cli');
console.log('-'.repeat(w) + '  ------  ------  ------  -------  ----  --------  ---');
for (const r of runs) {
  const s = score(r.results);
  console.log(
    r.model.padEnd(w) +
    '  ' + pct(s.accuracy).padEnd(6) +
    '  ' + pct(s.precision).padEnd(6) +
    '  ' + pct(s.recall).padEnd(6) +
    '  ' + String(s.fp).padEnd(7) +
    '  ' + String(s.fn).padEnd(4) +
    '  ' + String(s.unstable).padEnd(8) +
    '  ' + r.cli
  );
}

// Precision is the number that must not move: junk reaching the shared file is the failure
// with a real cost. Recall losses are invisible, which is why they need reporting loudest.
console.log('\n  junk-in = junk that reached the file (precision loss)');
console.log('  lost    = real knowledge dropped (recall loss) — the invisible failure');

if (runs.length < 2) {
  console.log('\nOnly one run present; nothing to compare.');
  process.exit(0);
}

const ids = runs[0].results.map(r => r.id);
const rows = [];
for (const id of ids) {
  const per = runs.map(r => (r.results.find(x => x.id === id) || {}).verdict || '?');
  if (new Set(per).size > 1) {
    const c = runs[0].results.find(x => x.id === id);
    rows.push({ id, expect: c.expect.toUpperCase(), per });
  }
}

console.log(`\ndisagreements: ${rows.length} of ${ids.length} cases`);
if (rows.length) {
  console.log('\ncase'.padEnd(13) + 'expect  ' + runs.map(r => r.model.padEnd(9)).join(''));
  for (const r of rows) {
    const mark = r.per.map((v, i) => (v === r.expect ? v : v + ' !').padEnd(9)).join('');
    console.log('  ' + r.id.padEnd(11) + r.expect.padEnd(8) + mark);
  }
  console.log('\n  ! = disagrees with the label');
}
