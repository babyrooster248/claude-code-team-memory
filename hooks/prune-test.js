// Checks that the spool cannot grow without bound, and that nothing is discarded quietly.
//
//   node hooks/prune-test.js
//
// The spool exists so a note survives an endpoint being down. That makes every discard a permanent
// loss of exactly the thing this project is for, so the rules are narrow: drop only what is far past
// any plausible recovery, log every drop with the reason, and never let the pruning run leave a
// half-pair behind. Both flushers are checked, because a machine with only one runtime gets only one.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SPOOL = path.join(os.homedir(), '.agent-knowledge-spool');
const LOG = path.join(os.tmpdir(), 'agent-knowledge-hook.log');

// Refuse to run against a spool holding real undelivered notes. This test deletes things.
if (fs.existsSync(SPOOL) && fs.readdirSync(SPOOL).some(f => f.endsWith('.head'))) {
  console.error('spool is not empty — refusing to run a destructive test over real queued notes');
  process.exit(2);
}

const MAX_ENTRIES = 500;
const MAX_AGE_DAYS = 30;
const DAY = 86400000;

const write = (id, ageDays) => {
  fs.writeFileSync(path.join(SPOOL, `${id}.head`), 'X-Note-Path-B64: eA==\n');
  fs.writeFileSync(path.join(SPOOL, `${id}.body`), 'note body\n');
  if (ageDays) {
    const t = new Date(Date.now() - ageDays * DAY);
    for (const ext of ['head', 'body']) fs.utimesSync(path.join(SPOOL, `${id}.${ext}`), t, t);
  }
};

const heads = () => (fs.existsSync(SPOOL) ? fs.readdirSync(SPOOL).filter(f => f.endsWith('.head')) : []);
const bodies = () => (fs.existsSync(SPOOL) ? fs.readdirSync(SPOOL).filter(f => f.endsWith('.body')) : []);

// Pointed at a port nothing is listening on, so every send fails and only the pruning is observed.
const runFlusher = (which) => {
  const env = { ...process.env, AGENT_KNOWLEDGE_INGEST: 'http://127.0.0.1:9', AGENT_KNOWLEDGE_USER: 'x@example.com', AGENT_KNOWLEDGE_TOKEN: 't' };
  return which === 'sh'
    ? spawnSync('sh', [path.join(__dirname, 'flush-spool.sh')], { env, encoding: 'utf8' })
    : spawnSync(process.execPath, [path.join(__dirname, 'flush-spool.js')], { env, encoding: 'utf8' });
};

let fails = 0;
let ran = 0;   // counted, not hard-coded: a stale total silently under-reports the suite
const check = (name, got, want) => {
  const ok = got === want;
  ran++;
  if (!ok) fails++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(56)} → ${got} (want ${want})`);
};

for (const which of ['node', 'sh']) {
  console.log(`  --- ${which} flusher ---`);
  fs.rmSync(SPOOL, { recursive: true, force: true });
  fs.mkdirSync(SPOOL, { recursive: true });

  // Fresh entries must survive: the endpoint being unreachable is the case the spool is FOR.
  write('fresh-1', 0);
  write('fresh-2', 2);
  write('old-1', MAX_AGE_DAYS + 5);
  write('old-2', MAX_AGE_DAYS + 400);

  const before = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').length : 0;
  runFlusher(which);
  const added = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').slice(before) : '';

  const left = heads().sort();
  check(`${which}: fresh entries kept`, left.filter(f => f.startsWith('fresh')).length, 2);
  check(`${which}: entries past ${MAX_AGE_DAYS} days dropped`, left.filter(f => f.startsWith('old')).length, 0);
  check(`${which}: no orphaned .body left behind`, bodies().length, left.length);
  check(`${which}: every discard is logged with a reason`, (added.match(/DISCARDED/g) || []).length, 2);
  check(`${which}: the log says how long it had been waiting`, /day/i.test(added), true);
}

// The count cap, node only: writing 600 files twice would make this test slower than the suite it
// belongs to, and the two implementations share the limit rather than each deciding one.
console.log('  --- count cap (node) ---');
fs.rmSync(SPOOL, { recursive: true, force: true });
fs.mkdirSync(SPOOL, { recursive: true });
for (let i = 0; i < MAX_ENTRIES + 20; i++) write(`bulk-${String(i).padStart(4, '0')}`, 0);
check('over-cap spool is trimmed to the cap', heads().length, MAX_ENTRIES + 20);
runFlusher('node');
check(`trimmed down to ${MAX_ENTRIES}`, heads().length, MAX_ENTRIES);
check('and the oldest went first', heads().includes('bulk-0000.head'), false);
check('while the newest stayed', heads().includes(`bulk-0${MAX_ENTRIES + 19}.head`.replace('bulk-0', 'bulk-0')), true);

fs.rmSync(SPOOL, { recursive: true, force: true });
console.log(fails ? `\n${fails}/${ran} case(s) failed` : `\n${ran}/${ran} passed`);
process.exit(fails ? 1 : 0);
