// SessionStart hook. Resends notes that could not reach the aggregator earlier — the member
// was offline, off the VPN, or the endpoint was down.
//
// Nothing here depends on the member doing anything: a note that failed to send is retried at
// the start of every session until it lands, and only then deleted.
//
// Spool entries are a `.head` + `.body` pair, the same shape flush-spool.sh reads and both
// senders write. A spool only one runtime understands is a spool that never empties on the
// machines that need it most.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

const SPOOL = path.join(os.homedir(), '.agent-knowledge-spool');
const LOG = path.join(os.tmpdir(), 'agent-knowledge-hook.log');
const TIMEOUT_MS = 3000;
const MAX_PER_RUN = 25;

const log = m => { try { fs.appendFileSync(LOG, `${new Date().toISOString()} [flush] ${m}\n`); } catch {} };

const ingest = process.env.AGENT_KNOWLEDGE_INGEST;
if (!ingest || !fs.existsSync(SPOOL)) process.exit(0);

const ids = fs.readdirSync(SPOOL).filter(f => f.endsWith('.head')).sort().slice(0, MAX_PER_RUN)
  .map(f => f.replace(/\.head$/, ''));
if (!ids.length) process.exit(0);

const url = ingest.replace(/\/$/, '') + '/note';

function send(id) {
  return new Promise(resolve => {
    const headFile = path.join(SPOOL, `${id}.head`);
    const bodyFile = path.join(SPOOL, `${id}.body`);
    const drop = () => { fs.rmSync(headFile, { force: true }); fs.rmSync(bodyFile, { force: true }); };

    if (!fs.existsSync(bodyFile)) { drop(); return resolve(`${id}: no body, discarded`); }

    let headers, body;
    try {
      headers = { 'Content-Type': 'text/markdown; charset=utf-8' };
      for (const line of fs.readFileSync(headFile, 'utf8').split('\n')) {
        const i = line.indexOf(': ');
        if (i > 0) headers[line.slice(0, i)] = line.slice(i + 2).trim();
      }
      body = fs.readFileSync(bodyFile);
    } catch { drop(); return resolve(`${id}: unreadable, discarded`); }
    headers['Content-Length'] = body.length;

    let u;
    try { u = new URL(url); } catch { return resolve(`${id}: bad ingest url`); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: 'POST', headers, timeout: TIMEOUT_MS }, res => {
      res.resume();
      const code = res.statusCode;
      // 2xx means delivered; 4xx means the endpoint judged it unacceptable and will judge it
      // the same way forever, so keeping it would retry that rejection every session.
      if ((code >= 200 && code < 300) || (code >= 400 && code < 500)) {
        drop();
        resolve(`${id}: ${code >= 300 ? 'refused ' + code + ', discarded' : 'delivered'}`);
      } else resolve(`${id}: kept (ingest returned ${code})`);
    });
    req.on('timeout', () => { req.destroy(); resolve(`${id}: kept (timeout)`); });
    req.on('error', e => resolve(`${id}: kept (${String(e.message).slice(0, 60)})`));
    req.end(body);
  });
}

(async () => {
  const results = [];
  for (const id of ids) results.push(await send(id));
  const left = fs.existsSync(SPOOL) ? fs.readdirSync(SPOOL).filter(f => f.endsWith('.head')).length : 0;
  log(`${ids.length} attempted, ${left} still queued`);
  for (const r of results) log('  ' + r);
  process.exit(0);
})();
