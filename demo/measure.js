// Does shared knowledge actually make an agent cheaper, or only faster?
//
//   node demo/measure.js --runs 3 --model opus
//
// Two clones of the same project and the same task. One has an empty AGENTS.md; the other carries
// the entry a real end-to-end run produced. Everything else is identical.
//
// This is the claim worth being sceptical about, because it is not obviously true. The warm arm
// reads an extra file into context on every session, so it starts each run already behind on input
// tokens. It only comes out ahead if the wasted exploration it prevents costs more than the file it
// adds. Nobody has measured that, so it gets measured before anything is built on top of it.
//
// Two rules that keep the number honest:
//   · Each run gets a FRESH memory directory. Otherwise run 2 reads the note run 1 wrote, the cold
//     arm quietly warms up, and the comparison measures nothing.
//   · "Tripped the trap" is read from an invocation log the project's own scripts append to, not
//     from the model's prose. An agent that says it ran the migration first and did not would
//     otherwise be scored on its description instead of its behaviour.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { build } = require('./setup-project');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const RUNS = parseInt(opt('runs', '3'), 10);
const MODEL = opt('model', 'opus');
const KEEP = argv.includes('--keep');

// Ordinary work. It does not mention memory, notes, or knowledge: an instruction that only works
// when the prompt reminds the agent is not the thing being measured.
const TASK = 'Get the seed data loaded so the catalog has items in it. Report what you had to do.';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-'));
const cli = (spawnSync('claude', ['--version'], { encoding: 'utf8', shell: true }).stdout || '').trim();

console.log(`model ${MODEL} · ${cli || 'unknown cli'} · ${RUNS} run(s) per arm`);
console.log(`task: ${TASK}\n`);

// Claude Code's --output-format json returns one result object. The field names are read defensively
// because they are not part of any contract this repo controls: a rename upstream should show up as
// a blank column, not as a fabricated zero.
function readUsage(raw) {
  let j;
  try { j = JSON.parse(raw); } catch { return null; }
  const u = j.usage || j.result?.usage || {};
  const num = (...names) => {
    for (const n of names) {
      const v = n.split('.').reduce((o, k) => (o == null ? o : o[k]), j);
      if (typeof v === 'number') return v;
    }
    return null;
  };
  const inTok = typeof u.input_tokens === 'number' ? u.input_tokens : num('input_tokens');
  const outTok = typeof u.output_tokens === 'number' ? u.output_tokens : num('output_tokens');
  const cacheRead = typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0;
  const cacheWrite = typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0;
  return {
    turns: num('num_turns', 'turns'),
    inTok, outTok, cacheRead, cacheWrite,
    ms: num('duration_ms', 'duration'),
    cost: num('total_cost_usd', 'cost_usd', 'cost'),
    raw: j,
  };
}

function runOne(arm, i) {
  const dest = path.join(base, `${arm}-${i}`);
  const memoryDir = path.join(base, `${arm}-${i}-memory`);
  fs.mkdirSync(memoryDir, { recursive: true });

  // No hooks: this measures the READ side. Shipping notes is measured elsewhere, and a hook firing
  // at a dead endpoint would only add spool noise to every run.
  build({ dest, memoryDir, warm: arm === 'warm', hooks: false, git: false });

  const started = Date.now();
  const r = spawnSync('claude', [
    '-p',
    '--model', MODEL,
    '--output-format', 'json',
    '--settings', path.join(dest, '.claude', 'settings.json'),
    '--permission-mode', 'bypassPermissions',
  ], {
    cwd: dest, input: TASK, encoding: 'utf8', shell: true,
    maxBuffer: 40 * 1024 * 1024, timeout: 600000,
  });

  const wall = Date.now() - started;
  const usage = readUsage(r.stdout || '');

  // The behavioural question, answered by what actually ran.
  const logFile = path.join(dest, '.state', 'invocations.log');
  const order = fs.existsSync(logFile)
    ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean)
        .map(l => l.split(' ').pop().replace(/\.js$/, ''))
    : [];
  const firstMigrate = order.indexOf('migrate');
  const firstSeed = order.indexOf('seed');
  const tripped = firstSeed !== -1 && (firstMigrate === -1 || firstSeed < firstMigrate);

  fs.writeFileSync(path.join(base, `${arm}-${i}.stdout.json`), r.stdout || '');

  return { arm, i, wall, usage, order, tripped, ok: r.status === 0 && !!usage };
}

const rows = [];
for (const arm of ['cold', 'warm']) {
  for (let i = 1; i <= RUNS; i++) {
    const res = runOne(arm, i);
    rows.push(res);
    const u = res.usage || {};
    console.log(
      `  ${res.ok ? 'ok  ' : 'FAIL'} ${arm.padEnd(5)} #${i}  ` +
      `trap=${res.tripped ? 'TRIPPED' : 'avoided'}  ` +
      `turns=${u.turns ?? '?'}  ` +
      `in=${u.inTok ?? '?'} out=${u.outTok ?? '?'}  ` +
      `${u.cost != null ? '$' + u.cost.toFixed(4) : '$?'}  ` +
      `${Math.round(res.wall / 1000)}s  [${res.order.join(' → ') || 'nothing ran'}]`
    );
  }
}

const valid = rows.filter(r => r.ok);
if (valid.length < rows.length) {
  console.log(`\n${rows.length - valid.length} run(s) produced no usable result and are excluded.`);
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const fmt = (v, d = 0) => (v == null ? '—' : v.toFixed(d));

function arm(name) {
  const r = valid.filter(x => x.arm === name);
  if (!r.length) return null;
  const g = (f) => r.map(x => f(x)).filter(v => typeof v === 'number');
  return {
    n: r.length,
    tripped: r.filter(x => x.tripped).length,
    turns: mean(g(x => x.usage.turns)),
    inTok: mean(g(x => x.usage.inTok)),
    outTok: mean(g(x => x.usage.outTok)),
    cacheRead: mean(g(x => x.usage.cacheRead)),
    cost: mean(g(x => x.usage.cost)),
    wall: mean(g(x => x.wall)),
  };
}

const cold = arm('cold');
const warm = arm('warm');

console.log('\n                       cold            warm           delta');
console.log('-'.repeat(62));
if (cold && warm) {
  const line = (label, c, w, digits = 0, unit = '') => {
    const d = (c != null && w != null) ? w - c : null;
    const pct = (c != null && w != null && c !== 0) ? ` (${((w - c) / c * 100).toFixed(1)}%)` : '';
    console.log(
      label.padEnd(22) +
      (fmt(c, digits) + unit).padEnd(16) +
      (fmt(w, digits) + unit).padEnd(15) +
      (d == null ? '—' : (d > 0 ? '+' : '') + fmt(d, digits) + unit + pct)
    );
  };
  console.log('tripped the trap'.padEnd(22) + `${cold.tripped}/${cold.n}`.padEnd(16) + `${warm.tripped}/${warm.n}`);
  line('turns', cold.turns, warm.turns, 1);
  line('input tokens', cold.inTok, warm.inTok);
  line('output tokens', cold.outTok, warm.outTok);
  line('cache read tokens', cold.cacheRead, warm.cacheRead);
  line('cost USD', cold.cost, warm.cost, 4);
  line('wall seconds', cold.wall / 1000, warm.wall / 1000, 1);

  console.log('');
  const cheaper = cold.cost != null && warm.cost != null && warm.cost < cold.cost;
  const faster = warm.wall < cold.wall;
  const safer = warm.tripped < cold.tripped;
  console.log(`  cheaper than cold?  ${cheaper ? 'YES' : 'NO'}`);
  console.log(`  faster than cold?   ${faster ? 'YES' : 'NO'}`);
  console.log(`  avoids the trap?    ${safer ? 'YES' : 'NO'}`);
  if (!cheaper) {
    console.log('\n  The demo\'s third promise cannot say "cheaper". Say "goes straight to it" and');
    console.log('  drop the token claim — findings §3 is a long argument against publishing a number');
    console.log('  the measurement does not support.');
  }
} else {
  console.log('not enough usable runs to compare.');
}

console.log(`\nraw results: ${base}`);
if (!KEEP) console.log('(pass --keep to leave the run trees in place)');
