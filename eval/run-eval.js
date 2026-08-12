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

// The CLI version belongs next to the score. A number without the model and version that
// produced it is not a measurement: this filter scored 94.4% recall on a small model and
// 50.0% on a larger one, and the README carried the first figure long after it stopped
// describing the documented command.
const cli = (spawnSync('claude', ['--version'], { encoding: 'utf8', shell: true }).stdout || '').trim();

const pct = n => (100 * n).toFixed(1) + '%';
console.log('\n--- ' + model + ' via ' + (cli || 'unknown cli') + ', ' + runs + ' run(s) per case, n=' + results.length + ' ---');
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
// Keyed by model: comparing two models is the normal case, and a single last-run.json means
// the second run silently destroys the first one's record — which is how a stale number
// survives in the README long after it stopped being true.
fs.writeFileSync(
  path.join(here, `last-run-${model}.json`),
  JSON.stringify({ model, runs, cli, date: new Date().toISOString().slice(0, 10), results }, null, 2)
);
