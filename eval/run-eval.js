// Scores the intake filter against labelled cases.
//   node run-eval.js [--model sonnet] [--runs 1]
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf('--' + name);
  return i === -1 ? def : args[i + 1];
};
const model = flag('model', 'sonnet');
const runs = parseInt(flag('runs', '1'), 10);

const here = __dirname;
const prompt = fs.readFileSync(path.join(here, 'filter-prompt.md'), 'utf8');
const cases = fs.readFileSync(path.join(here, 'cases.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map(JSON.parse);

function classify(text) {
  const r = spawnSync('claude', ['-p', '--model', model], {
    input: prompt + text + '\n',
    encoding: 'utf8',
    shell: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  const out = (r.stdout || '').trim();
  const m = out.match(/VERDICT:\s*(KEEP|DROP)\s*[—\-–]?\s*(.*)/i);
  if (!m) return { verdict: 'PARSE_FAIL', reason: out.slice(0, 120) };
  return { verdict: m[1].toUpperCase(), reason: (m[2] || '').trim() };
}

const results = [];
for (const c of cases) {
  const votes = [];
  for (let i = 0; i < runs; i++) votes.push(classify(c.text));
  // majority vote across runs
  const keeps = votes.filter(v => v.verdict === 'KEEP').length;
  const drops = votes.filter(v => v.verdict === 'DROP').length;
  const verdict = keeps > drops ? 'KEEP' : drops > keeps ? 'DROP' : votes[0].verdict;
  const ok = verdict === c.expect.toUpperCase();
  const stable = keeps === 0 || drops === 0;
  results.push({ ...c, verdict, ok, stable, reason: votes[0].reason });
  process.stdout.write(
    `${ok ? 'ok  ' : 'MISS'} ${c.id.padEnd(10)} exp=${c.expect.padEnd(4)} got=${verdict.padEnd(4)}` +
    `${runs > 1 && !stable ? ' [unstable]' : ''}  ${results[results.length - 1].reason}\n`
  );
}

// Scores from the perspective of "does junk reach the shared file?"
const tp = results.filter(r => r.expect === 'keep' && r.verdict === 'KEEP').length;
const fp = results.filter(r => r.expect === 'drop' && r.verdict === 'KEEP').length;
const fn = results.filter(r => r.expect === 'keep' && r.verdict === 'DROP').length;
const tn = results.filter(r => r.expect === 'drop' && r.verdict === 'DROP').length;

const pct = n => (100 * n).toFixed(1) + '%';
console.log('\n--- ' + model + ', ' + runs + ' run(s) per case, n=' + results.length + ' ---');
console.log('accuracy   ' + pct((tp + tn) / results.length));
console.log('precision  ' + pct(tp / (tp + fp)) + '   (of what reaches the file, how much belongs)');
console.log('recall     ' + pct(tp / (tp + fn)) + '   (of real knowledge, how much survives)');
console.log('junk let through (FP): ' + fp + '   knowledge lost (FN): ' + fn);
if (runs > 1) console.log('unstable cases: ' + results.filter(r => !r.stable).map(r => r.id).join(', '));

const misses = results.filter(r => !r.ok);
if (misses.length) {
  console.log('\nmisses:');
  for (const m of misses) console.log(`  ${m.id} [${m.src}] exp=${m.expect} got=${m.verdict}\n    note: ${m.note}\n    model: ${m.reason}`);
}
fs.writeFileSync(path.join(here, 'last-run.json'), JSON.stringify(results, null, 2));
