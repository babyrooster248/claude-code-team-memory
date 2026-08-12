// Runs the endpoint's own secret scanner over every file in this repository.
//
//   node aggregator/scan-repo.js [dir]
//
// Written to be run before a commit, and kept because dogfooding is the cheapest honest test a
// scanner gets: if it cannot be pointed at its own project without producing nonsense, it will
// produce nonsense on real notes too.
//
// `aggregator/secret-test.js` is expected to light up — it is full of deliberate fake secrets —
// so it is reported separately rather than counted as a finding. Nothing else should appear.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = process.argv[2] || path.join(__dirname, '..');
const src = fs.readFileSync(path.join(__dirname, 'ingest.js'), 'utf8');
eval(src.slice(src.indexOf('const SECRET_PATTERNS'), src.indexOf('const slug =')));

const SKIP_DIRS = new Set(['.git', 'node_modules', 'inbox']);
// `secret-test.js` is full of deliberate fake secrets, and `ingest.js` documents each pattern
// with an example of what it catches — a scanner's own definitions necessarily contain the shapes
// it hunts. Reported separately rather than counted, so a real finding is never lost in them.
const FIXTURES = new Set(['secret-test.js', 'ingest.js', 'cases.jsonl']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

// The question this tool answers is "could a secret reach a commit", so the scope is what git
// would publish: tracked files plus untracked ones that are not ignored. Walking the whole tree
// instead reports files that cannot be committed at all — eval run records, local scratch — and a
// scanner that cries wolf about those teaches people to skim past the one line that mattered.
// Falls back to the walk when this is not a git repository, so the script still runs standalone.
function candidates() {
  const r = spawnSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard'],
    { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return walk(root);
  return r.stdout.split('\n').filter(Boolean).map(f => path.join(root, f));
}

const findings = [];
const inFixtures = [];

for (const file of candidates()) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  const rel = path.relative(root, file).replace(/\\/g, '/');
  text.split('\n').forEach((line, i) => {
    const hit = findSecret(line);
    if (!hit) return;
    const record = { rel, line: i + 1, hit, text: line.trim().slice(0, 90) };
    (FIXTURES.has(path.basename(file)) ? inFixtures : findings).push(record);
  });
}

if (inFixtures.length) {
  console.log(`${inFixtures.length} hit(s) inside test fixtures, which is what those files are for:`);
  const byFile = new Map();
  for (const f of inFixtures) byFile.set(f.rel, (byFile.get(f.rel) || 0) + 1);
  for (const [rel, n] of byFile) console.log(`  ${rel}  ${n}`);
  console.log('');
}

if (!findings.length) {
  console.log('No secrets found outside test fixtures.');
  process.exit(0);
}

console.log(`${findings.length} finding(s) to look at by hand:`);
for (const f of findings) {
  console.log(`  ${f.hit}`);
  console.log(`    ${f.rel}:${f.line}  ${f.text}`);
}
process.exit(1);
