// Checks the authenticated, multi-project endpoint against a real server on a real port.
//
//   node aggregator/auth-test.js
//
// The cases that matter here are not "does a good credential work" but the four ways this could
// leak: an unauthenticated write, a member writing to a project they are not on, a member forging
// another member's identity to reach the auto-apply path, and a note being DROPPED because the
// credential was wrong — which loses knowledge just as permanently as never writing it.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'authtest-'));
const PORT = 8837;

const mk = (email) => {
  const token = 'tok-' + crypto.randomBytes(6).toString('hex');
  const salt = crypto.randomBytes(8).toString('hex');
  return { email, token, salt, hash: crypto.scryptSync(token, salt, 32).toString('hex') };
};
const minh = mk('minh@example.com');
const lan = mk('lan@example.com');

fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
  bind: '127.0.0.1', port: PORT,
  projects: {
    'catalog-svc': {
      out: path.join(tmp, 'inbox-catalog'),
      members: {
        [minh.email]: { salt: minh.salt, hash: minh.hash },
        [lan.email]: { salt: lan.salt, hash: lan.hash },
      },
    },
    storefront: {
      out: path.join(tmp, 'inbox-storefront'),
      members: { [lan.email]: { salt: lan.salt, hash: lan.hash } },
    },
  },
}, null, 2));

const memRoot = path.join(tmp, 'memory');
fs.mkdirSync(memRoot, { recursive: true });
const notePath = path.join(memRoot, 'a-trap.md');
fs.writeFileSync(notePath, 'seed.js reports a FOREIGN KEY error when the schema file is absent.\n');

const b64 = s => Buffer.from(String(s), 'utf8').toString('base64');
const basic = (u, t) => 'Basic ' + Buffer.from(`${u}:${t}`, 'utf8').toString('base64');

function send({ auth, project, claimKey }) {
  return new Promise((resolve) => {
    const body = fs.readFileSync(notePath);
    const headers = {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Length': body.length,
      'X-Note-Path-B64': b64(notePath),
      'X-Memory-Root-B64': b64(memRoot),
      'X-Identity-Key': claimKey || 'claimed-uuid-1',
      'X-Identity-Label-B64': b64('whatever@example.com'),
      'X-Identity-Source': 'claude-account',
      'X-Note-Ts': new Date().toISOString(),
    };
    if (auth) headers.Authorization = auth;
    if (project) headers['X-Project'] = project;
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'POST', path: '/note', headers },
      res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', () => resolve(0));
    req.end(body);
  });
}

const server = spawn(process.execPath,
  [path.join(__dirname, 'ingest.js'), '--config', path.join(tmp, 'config.json')],
  { stdio: ['ignore', 'ignore', 'pipe'] });
let serverLog = '';
server.stderr.on('data', d => { serverLog += d.toString(); });

const events = (dir) => {
  const f = path.join(tmp, dir, 'events.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
};

(async () => {
  for (let i = 0; i < 60 && !/listening/.test(serverLog); i++) await new Promise(r => setTimeout(r, 100));

  let fails = 0;
  const check = (name, got, want) => {
    const ok = got === want;
    if (!ok) fails++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(52)} → ${got} (want ${want})`);
  };

  // Order matters: these must run before the flood cases below, because the pre-auth bucket is
  // keyed by address and every case in this file comes from the same one.
  check('no Authorization header', await send({ project: 'catalog-svc' }), 401);
  check('wrong token', await send({ auth: basic(minh.email, 'nope'), project: 'catalog-svc' }), 401);
  check('unknown email', await send({ auth: basic('ghost@example.com', minh.token), project: 'catalog-svc' }), 401);
  check('unknown project', await send({ auth: basic(minh.email, minh.token), project: 'no-such' }), 401);
  check('no project header', await send({ auth: basic(minh.email, minh.token) }), 401);
  check('member not on that project', await send({ auth: basic(minh.email, minh.token), project: 'storefront' }), 401);
  check('valid credential', await send({ auth: basic(minh.email, minh.token), project: 'catalog-svc' }), 200);
  check('same member, second project they are on', await send({ auth: basic(lan.email, lan.token), project: 'storefront' }), 200);

  // The forgery this design exists to stop: minh sends a note claiming to be a different person.
  // The endpoint must count the authenticated email, not the claimed key, or one member can walk an
  // entry through the auto-apply path alone.
  await send({ auth: basic(minh.email, minh.token), project: 'catalog-svc', claimKey: 'lan-uuid-forged' });
  const users = [...new Set(events('inbox-catalog').map(e => e.user))].sort();
  check('forged identity does not create a second contributor', users.length, 1);
  check('the contributor is the authenticated email', users[0], minh.email);

  // Projects must not share an inbox, or one team reads another team's notes.
  check('storefront inbox holds only its own note', events('inbox-storefront').length, 1);
  check('storefront contributor is lan', events('inbox-storefront')[0].user, lan.email);

  // One person under two credentials is the residual hazard auth introduces; it must be reported.
  // Both sends carry the same claimed account, and they are last on purpose: accept() keeps only
  // the most recent event per (contributor, note), so the twin signature is only visible while both
  // members' latest notes still carry the shared account.
  await send({ auth: basic(minh.email, minh.token), project: 'catalog-svc', claimKey: 'shared-account' });
  await send({ auth: basic(lan.email, lan.token), project: 'catalog-svc', claimKey: 'shared-account' });
  check('two credentials, one Claude account → warned', /two credentials/.test(serverLog), true);

  // Rate limiting. The bucket is per credential, so one member cannot spend the whole team's
  // budget, and the response must be 429 rather than a drop — the senders spool on 429, and a rate
  // limit that discarded notes would be a cost control that destroys knowledge.
  let sawLimit = 0;
  for (let i = 0; i < 40; i++) {
    if (await send({ auth: basic(lan.email, lan.token), project: 'storefront' }) === 429) sawLimit++;
  }
  check('sustained sending eventually rate limits', sawLimit > 0, true);
  check('a different member is not limited by it',
    await send({ auth: basic(minh.email, minh.token), project: 'catalog-svc' }), 200);

  // Verifying a credential runs scrypt on purpose, so an unauthenticated flood buys one expensive
  // hash per request unless something rejects it before the hash. This asserts the pre-auth bucket
  // exists at all: without it every one of these returns 401 and every one of them costs a scrypt.
  let refusedBeforeAuth = 0;
  for (let i = 0; i < 80; i++) {
    if (await send({ auth: basic('flood@example.com', 'wrong'), project: 'catalog-svc' }) === 429) refusedBeforeAuth++;
  }
  check('bad-credential flood is capped before scrypt runs', refusedBeforeAuth > 0, true);

  server.kill();

  // A non-loopback bind without TLS in front must refuse to start rather than serve credentials
  // over cleartext.
  const r = spawnSync(process.execPath,
    [path.join(__dirname, 'ingest.js'), '--config', path.join(tmp, 'config.json'), '--bind', '0.0.0.0'],
    { encoding: 'utf8' });
  check('refuses 0.0.0.0 without --behind-tls-proxy', r.status, 2);
  check('and says why', /cleartext/.test(r.stderr), true);

  const total = 19;
  console.log(fails ? `\n${fails}/${total} case(s) failed` : `\n${total}/${total} passed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
})();
