// Checks that aggregate runs by itself when a note arrives, and runs the right number of times.
//
//   node aggregator/trigger-test.js
//
// No model calls: the aggregate script is stubbed with one that appends a line and sleeps, so what
// is being tested is the scheduling — which is where the failures live. Each case below exists for
// something already observed in a real run rather than imagined:
//
//   · Both hooks fire for one note, so one note is two accepts. Without debounce that is two runs,
//     each spending model calls on the same work.
//   · A session writes several notes in a row. Same problem, larger.
//   · Two overlapping runs would race one git clone and one branch name.
//   · A stale clone re-proposes the lines a reviewer just deleted, so a failed pull must abort the
//     run rather than continue on what it already had.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trigger-'));
const PORT = 8851;
const QUIET = 2; // seconds — the real default is 120, and a test that waited that long is a test nobody runs

const TOKEN = 'tok-' + crypto.randomBytes(6).toString('hex');
const SALT = crypto.randomBytes(8).toString('hex');
const EMAIL = 'minh@example.com';
const HASH = crypto.scryptSync(TOKEN, SALT, 32).toString('hex');

// The stub. Records that it ran, with its arguments, and takes long enough that a second note can
// land while it is still going — which is the single-flight case.
const STUB = path.join(tmp, 'stub-aggregate.js');
fs.writeFileSync(STUB, `
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(path.join(tmp, 'runs.log'))},
  new Date().toISOString() + ' ' + process.argv.slice(2).join(' ') + '\\n');
setTimeout(() => process.exit(0), Number(process.env.STUB_MS || 1200));
`);

const runs = () => (fs.existsSync(path.join(tmp, 'runs.log'))
  ? fs.readFileSync(path.join(tmp, 'runs.log'), 'utf8').split('\n').filter(Boolean) : []);

// A local-only repo: no upstream, so there is nothing to be stale against and the run should
// proceed. This is also the shape the demo project has before it gets a remote.
function makeLocalRepo(name) {
  const repo = path.join(tmp, name);
  fs.mkdirSync(repo, { recursive: true });
  const g = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 'test');
  g('config', 'user.email', 't@example.com');
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  return repo;
}

// A clone whose upstream RESOLVES but cannot be fetched. Getting this right matters: the first
// version of this test just pointed a fresh repo at an unreachable URL, `@{u}` did not resolve, the
// code correctly read that as "local-only", and the case silently tested the wrong thing.
function makeUnreachableClone(name) {
  const remote = path.join(tmp, name + '-remote.git');
  const repo = path.join(tmp, name);
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { encoding: 'utf8' });
  spawnSync('git', ['clone', '-q', remote, repo], { encoding: 'utf8' });
  const g = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  g('config', 'user.name', 'test');
  g('config', 'user.email', 't@example.com');
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  g('push', '-q', '-u', 'origin', 'main');       // now main tracks origin/main and origin/main exists
  g('remote', 'set-url', 'origin', 'https://127.0.0.1:9/nope.git');  // and now it cannot be reached
  return repo;
}

const okRepo = makeLocalRepo('repo-ok');
const badRepo = makeUnreachableClone('repo-broken');

const cfgPath = path.join(tmp, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({
  bind: '127.0.0.1', port: PORT,
  rateLimit: { notesPerHour: 100000, burst: 5000, authAttemptsPerHour: 100000, authBurst: 5000 },
  projects: {
    'with-trigger': {
      out: path.join(tmp, 'inbox-a'),
      aggregate: { repo: okRepo, script: STUB, quietSeconds: QUIET, commit: false },
      members: { [EMAIL]: { salt: SALT, hash: HASH } },
    },
    'broken-clone': {
      out: path.join(tmp, 'inbox-b'),
      aggregate: { repo: badRepo, script: STUB, quietSeconds: QUIET, commit: false },
      members: { [EMAIL]: { salt: SALT, hash: HASH } },
    },
    // No aggregate block: must never run anything. This is the backwards-compatible shape every
    // existing test and the whole manual path depend on.
    'no-trigger': {
      out: path.join(tmp, 'inbox-c'),
      members: { [EMAIL]: { salt: SALT, hash: HASH } },
    },
  },
}, null, 2));

const memRoot = path.join(tmp, 'memory');
fs.mkdirSync(memRoot, { recursive: true });
const notePath = path.join(memRoot, 'a-trap.md');
fs.writeFileSync(notePath, 'seed.js prints a misleading FK error when the schema file is absent.\n');

const b64 = s => Buffer.from(String(s), 'utf8').toString('base64');
const basic = 'Basic ' + Buffer.from(`${EMAIL}:${TOKEN}`, 'utf8').toString('base64');

function postNote(project, name) {
  return new Promise((resolve) => {
    const body = fs.readFileSync(notePath);
    const req = http.request({
      host: '127.0.0.1', port: PORT, method: 'POST', path: '/note',
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Length': body.length,
        Authorization: basic,
        'X-Project': project,
        'X-Note-Path-B64': b64(path.join(memRoot, name || 'a-trap.md')),
        'X-Memory-Root-B64': b64(memRoot),
        'X-Identity-Key': 'claimed-uuid',
        'X-Identity-Label-B64': b64(EMAIL),
        'X-Identity-Source': 'claude-account',
        'X-Note-Ts': new Date().toISOString(),
      },
    }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', () => resolve(0));
    req.end(body);
  });
}

const server = spawn(process.execPath, [path.join(__dirname, 'ingest.js'), '--config', cfgPath],
  { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, STUB_MS: '1200' } });
let log = '';
server.stderr.on('data', d => { log += d.toString(); });

const sleep = ms => new Promise(r => setTimeout(r, ms));

let fails = 0;
let ran = 0;
const check = (name, got, want) => {
  const ok = got === want;
  ran++;
  if (!ok) fails++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(58)} → ${got} (want ${want})`);
};

(async () => {
  for (let i = 0; i < 80 && !/listening/.test(log); i++) await sleep(100);

  // --- one note, two hooks: the shape every real session produces ---------------------------
  await postNote('with-trigger');
  await postNote('with-trigger');           // the second hook, same note
  check('two accepts scheduled, nothing run yet', runs().length, 0);
  await sleep(QUIET * 1000 + 1500);
  check('one note via two hooks → exactly ONE run', runs().length, 1);
  check('and it was told where the inbox is', /--store/.test(runs()[0] || ''), true);
  check('and which artifact to merge into', /AGENTS\.md/.test(runs()[0] || ''), true);

  // --- a session writing several notes -------------------------------------------------------
  fs.writeFileSync(path.join(tmp, 'runs.log'), '');
  for (const n of ['n1.md', 'n2.md', 'n3.md']) await postNote('with-trigger', n);
  await sleep(QUIET * 1000 + 1500);
  check('three notes in one session → exactly ONE run', runs().length, 1);

  // --- a note landing mid-run ----------------------------------------------------------------
  fs.writeFileSync(path.join(tmp, 'runs.log'), '');
  await postNote('with-trigger', 'x1.md');
  await sleep(QUIET * 1000 + 300);          // run is now in flight, stub sleeps 1200ms
  check('run in flight', runs().length, 1);
  await postNote('with-trigger', 'x2.md');
  await postNote('with-trigger', 'x3.md');  // two more while it runs
  check('still just the one run', runs().length, 1);
  await sleep(1500 + QUIET * 1000 + 1500);
  check('two notes during a run → ONE follow-up, not two', runs().length, 2);

  // --- a clone that cannot pull ---------------------------------------------------------------
  fs.writeFileSync(path.join(tmp, 'runs.log'), '');
  const logMark = log.length;
  await postNote('broken-clone');
  await sleep(QUIET * 1000 + 2500);
  check('pull failure → run SKIPPED, not run on stale state', runs().length, 0);
  const added = log.slice(logMark);
  check('and it says why, loudly', /SKIPPED: git pull/.test(added), true);
  check('and names refusing stale state', /stale artifact/.test(added), true);

  // --- a project with no aggregate block ------------------------------------------------------
  fs.writeFileSync(path.join(tmp, 'runs.log'), '');
  await postNote('no-trigger');
  await sleep(QUIET * 1000 + 1500);
  check('no aggregate block → never runs', runs().length, 0);

  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fails ? `\n${fails}/${ran} case(s) failed` : `\n${ran}/${ran} passed`);
  process.exit(fails ? 1 : 0);
})();
