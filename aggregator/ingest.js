// Ingest endpoint. Receives one memory note per POST, straight from the hook that
// fired when the note was written.
//
//   node ingest.js [--port 8791] [--out ./inbox]
//
// It writes exactly the two inputs aggregate.js already takes — a directory of notes
// and an events.jsonl — so the merge path that has already been measured stays
// untouched.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// spawnSync only for the git pull, which is fast and must complete before the run decides to
// proceed; spawn for the aggregate run itself, which must not block the endpoint.
const { spawn, spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const has = n => argv.includes('--' + n);

// Two modes. With --config the server is multi-project and authenticated, which is what a host
// reachable over the internet needs. Without it, the single-project unauthenticated form is kept
// for local development and for the test suites, and refuses to leave loopback.
const configPath = opt('config', null);
const config = configPath ? JSON.parse(fs.readFileSync(path.resolve(configPath), 'utf8')) : null;

const port = parseInt(opt('port', config ? String(config.port || 8791) : '8791'), 10);
const bind = opt('bind', config ? (config.bind || '127.0.0.1') : '127.0.0.1');

// Basic auth transmits the credential on every request in a form that is trivially reversible, so
// serving it over plain HTTP hands every note's credential to anything on the path. Refusing to
// start is the only version of this warning nobody can skip.
const LOOPBACK = /^(127\.|::1$|localhost$)/;
if (!LOOPBACK.test(bind) && !has('behind-tls-proxy')) {
  console.error(`[ingest] refusing to bind ${bind}: basic auth over plain HTTP puts member ` +
    `credentials in cleartext on the wire.\n` +
    `         Terminate TLS in front of this process and pass --behind-tls-proxy, ` +
    `or bind 127.0.0.1 and reach it through a tunnel.`);
  process.exit(2);
}
if (!config && !LOOPBACK.test(bind)) {
  console.error('[ingest] refusing to bind ' + bind + ' without --config: the single-project mode has no authentication.');
  process.exit(2);
}

// Resolved per project in config mode; the legacy flags stand in for a single unnamed project.
function projectPaths(p) {
  const base = path.resolve(config ? p.out : opt('out', './inbox'));
  const notes = path.join(base, 'notes');
  fs.mkdirSync(notes, { recursive: true });
  return { out: base, notesDir: notes, eventsFile: path.join(base, 'events.jsonl') };
}

const LEGACY = config ? null : projectPaths(null);

// A deterministic scan, running before anything else looks at the note.
//
// The intake filter is a model at 94% precision, which is fine for its usual mistake — a
// mildly useless line reaching the file. It is not fine for this one. A credential that slips
// through lands in a git-committed artifact, and the cost is a rotated secret plus a rewritten
// history, not a wasted line of context. Two failures with costs that far apart should not
// share one probabilistic gate, so the cheap certain check goes first.
//
// Refuse rather than redact: silently rewriting someone's note changes knowledge without
// telling anyone, and the member's log should say why their note did not arrive.
const SECRET_PATTERNS = [
  [/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, 'private key block'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/, 'GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/, 'GitHub fine-grained token'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, 'Slack token'],
  [/\bsk-[A-Za-z0-9]{20,}\b/, 'API secret key'],
  [/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, 'JWT'],
  // A connection string carrying its own password, e.g. postgres://user:pw@host/db
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@[^\s/]+/i, 'URL with embedded credentials'],
  // An assignment whose name says secret and whose value looks like an actual secret rather than
  // a placeholder — or a function call. The value is required to stay inside a credential's
  // character set, which is what stops `const secret = findSecret(n.content)` from matching: the
  // parentheses disqualify it. That line is in this very file, and it was a live false positive.
  [/\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']?(?!["']?(?:\s|$|<|\{|\$|xxx|\.\.\.|your|example|placeholder|redacted|changeme))[A-Za-z0-9@!#$%^&*+=?_.\-]{6,}(?![A-Za-z0-9@!#$%^&*+=?_.\-(])/i, 'credential assignment'],
];

// A password mentioned in prose, in any language, matches none of the patterns above. The case
// that exposed this was a real note reading "the local admin account is Admin@740211, on UAT it
// is Admin@86042917" — no assignment, no known key format, and the surrounding words were
// Vietnamese, so a keyword list would not have helped either.
//
// So this looks at shape instead: a token carrying letters, digits, and a symbol that paths and
// version strings do not use. `.` `-` `_` `/` are deliberately excluded from that symbol class,
// because `v2.1.226`, `k8s-prod-2` and `.state/schema.json` must not trip it. Emails are
// excluded outright: they contain `@` and often digits, and they are not secrets.
// The check works on whole whitespace-delimited tokens that fall entirely inside a password's
// character set. That restriction is the whole trick, and it came from pointing this scanner at
// its own repository: an earlier version matched "any run of non-space characters" and produced
// forty false positives on ordinary source — `tally[m[1].toUpperCase()]++`, template literals,
// regex bodies. Notes quote code all the time, so that version would have refused real notes.
//
// Brackets, parentheses, braces, quotes and backticks are absent from the set, so a code snippet
// disqualifies itself. `.` `-` `_` are allowed inside but do not count as the qualifying symbol,
// which is what keeps `v2.1.226` and `k8s-prod-2` out.
const PW_CHARS = /^[A-Za-z0-9@!#$%^&*+=?_.-]+$/;
const PW_SYMBOL = /[@!#$%^&*+=?]/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;
const MIN_LEN = 10;   // `count+=1` is a code fragment, not a credential

function findPasswordish(text) {
  for (const raw of text.split(/\s+/)) {
    // Markdown emphasis and quoting live at the edges of tokens in prose notes; `Latin-1.**` is
    // not a password.
    const token = raw.replace(/^[("'`\[{*_~]+/, '').replace(/[.,;:!?)\]}"'`*_~]+$/, '');
    if (token.length < MIN_LEN || token.length > 64) continue;
    if (!PW_CHARS.test(token)) continue;
    if (!/[A-Za-z]/.test(token) || !/\d/.test(token)) continue;
    const sym = token.search(PW_SYMBOL);
    if (sym <= 0) continue;                                      // absent, or leading like @scope
    if (EMAIL.test(token)) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(token)) continue;            // a URL; handled by its own rule
    // `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH=262144`, `charset=utf-8`, `attempted=0` — a note about
    // configuration is exactly the kind of knowledge this file carries, so a plain name=value
    // whose value holds no password symbol of its own is not a credential. A value that does hold
    // one, like `password=Admin@740211`, fails this test and stays caught; and a plain value under
    // a name that says secret is caught by the assignment rule above instead.
    if (/^[A-Za-z][A-Za-z0-9_.\-]*=[A-Za-z0-9_.\-/]+$/.test(token)) continue;
    return `password-shaped token "${token.slice(0, 4)}…"`;
  }
  return null;
}

function findSecret(text) {
  for (const [re, what] of SECRET_PATTERNS) if (re.test(text)) return what;
  return findPasswordish(text);
}

const slug = e => String(e).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
// Senders may report the same directory in different shapes — `C:\Users\x` from a Windows
// payload, `C:/Users/x` after slash conversion, `/c/Users/x` from a POSIX shell on Windows.
// Fold all of them before comparing, or the prefix check rejects perfectly good notes.
const norm = p => String(p)
  .replace(/\\/g, '/')
  .replace(/^\/([A-Za-z])\//, '$1:/')
  .replace(/\/+$/, '')
  .toLowerCase();

// Attribution is the whole basis of the promotion rule, so a note that cannot be
// attributed is refused rather than stored. Letting one through would quietly turn
// "a second, verified person confirmed this" into "this was seen twice", and one
// person hits the same trap twice all the time.
function validate(n) {
  if (!n || typeof n !== 'object') return 'body is not an object';
  if (!n.file_path) return 'missing file_path';
  // Members keep their notes wherever autoMemoryDirectory points, so there is no path
  // shape to check against here. The sender states the root it matched, and the only
  // thing worth verifying is that the note actually sits under it — which catches a
  // misconfigured hook shipping ordinary source files.
  if (!n.memory_root) return 'missing memory_root — sender did not say which memory directory this came from';
  if (!norm(n.file_path).startsWith(norm(n.memory_root) + '/')) return 'file_path is not under the stated memory_root';
  if (!n.identity_key) return 'missing identity_key — a note that cannot be attributed is refused';
  if (typeof n.content !== 'string' || !n.content.trim()) return 'missing content';
  // MEMORY.md is one person's private index of their own notes, not knowledge. It
  // arrives on every session because Claude keeps it current, and letting it in would
  // hand the merge pass a candidate made of link lines. Refuse it here rather than
  // filter downstream: aggregate.js matches on basename, and the stored name carries
  // an author prefix, so a downstream filter would silently stop matching.
  if (/^MEMORY\.md$/i.test(path.basename(String(n.file_path).replace(/\\/g, '/')))) return 'MEMORY.md is a personal index, not a note';
  const secret = findSecret(n.content);
  if (secret) return `refused: looks like it contains a ${secret} — nothing that reaches the shared file may carry a credential`;
  return null;
}

function readEvents(eventsFile) {
  if (!fs.existsSync(eventsFile)) return [];
  return fs.readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function accept(n, paths) {
  const { notesDir, eventsFile } = paths;
  // Re-create the directory rather than assuming it survived since startup. Anything that
  // tidies the inbox — a cleanup script, an operator, a test — would otherwise make every
  // subsequent note fail, and the sender only sees a 5xx it will spool and retry forever.
  fs.mkdirSync(notesDir, { recursive: true });
  const base = path.basename(String(n.file_path).replace(/\\/g, '/'));
  const who = slug(n.identity_label || n.identity_key);
  const local = `${who}__${base}`;
  fs.writeFileSync(path.join(notesDir, local), n.content);

  const events = readEvents(eventsFile);

  // One person arriving under two different keys is the one way the contributor count
  // can silently inflate, and a shared label with a different key is the detectable
  // signature of it. Worth a loud line: nothing downstream can spot this.
  const clash = events.find(e => e.label && n.identity_label && e.label === n.identity_label && e.user !== n.identity_key);
  if (clash) {
    console.error(`[ingest] WARNING identity mixing: ${n.identity_label} has appeared as both ` +
                  `${clash.user} (${clash.source || 'unknown source'}) and ${n.identity_key} (${n.identity_source}). ` +
                  `They will count as two people and can promote an entry on their own.`);
  }

  // Authentication removes the old mixing hazard — one credential is one key — and leaves a new
  // one in its place: one person holding two issued credentials still counts as two people. The
  // signature is the same Claude account arriving under two authenticated emails, and the account
  // is something the sender reports rather than proves, so this is a flag for a human, not a block.
  //
  // Limitation, measured by writing the test that assumed otherwise: only the latest event per
  // (contributor, note) is kept, so the signature is visible only while both credentials' most
  // recent notes still carry the shared account. It catches the careless case, not a patient one.
  if (n.identity_claimed) {
    const twin = events.find(e => e.claimed && e.claimed === n.identity_claimed && e.user !== n.identity_key);
    if (twin) {
      console.error(`[ingest] WARNING one Claude account, two credentials: ${n.identity_claimed} has ` +
                    `authenticated as both ${twin.user} and ${n.identity_key}. If that is one person, ` +
                    `they can promote an entry alone — revoke one credential in config.json.`);
    }
  }

  // One row per (person, note). A later snapshot of the same note replaces the older
  // row instead of inflating the count — the same person writing twice is one person.
  const kept = events.filter(e => !(e.user === n.identity_key && path.basename(String(e.file).replace(/\\/g, '/')) === local));
  kept.push({
    user: n.identity_key,
    label: n.identity_label || null,
    source: n.identity_source || null,
    claimed: n.identity_claimed || null,
    session: n.session_id || 'unknown',
    ts: n.ts || new Date().toISOString(),
    file: `/${who}/${local}`,
    content: '',
  });
  fs.writeFileSync(eventsFile, kept.map(e => JSON.stringify(e)).join('\n') + '\n');
  return { local, bytes: Buffer.byteLength(n.content, 'utf8'), people: new Set(kept.map(e => e.user)).size };
}

// The note itself is the request body and everything else travels in headers. That is
// not a stylistic choice: the sending side has to work in plain shell on machines with no
// node, and assembling JSON around a multi-kilobyte note full of quotes, newlines and
// Windows backslashes is exactly where a shell script breaks. With the note as the body
// there is nothing to escape. Both senders use this one format.
function fromHeaders(req, body) {
  const h = n => { const v = req.headers[n]; return v === undefined ? null : String(v); };
  // Paths and labels arrive base64-encoded. HTTP header values are Latin-1: node throws
  // outright on a non-ASCII header value, and curl sends bytes the other side cannot
  // reconstruct. A memory note named `ghi-chú-bẫy.md` is enough to hit it, and the failure
  // looked like the hooks misbehaving rather than a wire-format limit.
  const b64 = n => { const v = h(n); if (!v) return null; try { return Buffer.from(v, 'base64').toString('utf8'); } catch { return null; } };
  return {
    file_path: b64('x-note-path-b64'),
    memory_root: b64('x-memory-root-b64'),
    identity_key: h('x-identity-key'),
    identity_label: b64('x-identity-label-b64'),
    identity_source: h('x-identity-source'),
    session_id: h('x-session-id'),
    ts: h('x-note-ts') || new Date().toISOString(),
    tool: h('x-note-tool'),
    content: body,
  };
}

// A token bucket per sender. Needed whether or not authentication is on, and for a reason that has
// nothing to do with attackers: every note that arrives costs three model calls downstream, so a
// hook stuck in a loop or one leaked token can spend a month's budget before anyone looks. Keyed by
// credential where there is one and by address otherwise.
//
// Deliberately generous. This is a backstop against runaway cost, not a throttle on people: a
// member having a heavy day should never be the reason a trap goes unrecorded.
const RATE = Object.assign({ notesPerHour: 120, burst: 30, authAttemptsPerHour: 600, authBurst: 60 },
  (config && config.rateLimit) || {});
const buckets = new Map();
function overLimit(key, perHour, burst) {
  const now = Date.now();
  const refillPerMs = perHour / 3600000;
  const b = buckets.get(key) || { tokens: burst, last: now };
  b.tokens = Math.min(burst, b.tokens + (now - b.last) * refillPerMs);
  b.last = now;
  if (b.tokens < 1) { buckets.set(key, b); return true; }
  b.tokens -= 1;
  buckets.set(key, b);
  return false;
}

// A second, looser bucket in front of authentication, keyed by address.
//
// Not for guessing: the tokens are 24 random bytes. This exists because verifying a credential runs
// scrypt, deliberately, and an unauthenticated flood therefore buys one expensive hash per request —
// the check added to make wrong credentials slow became a way to exhaust the CPU. Rejecting before
// the hash is the fix, and it has to sit before authenticate() rather than after, because a 401
// returned after the work is done has already paid for it.
const overAuthLimit = addr => overLimit('auth:' + addr, RATE.authAttemptsPerHour, RATE.authBurst);

// Returns the authenticated member and their project, or a reason to refuse. Every failure gets
// the same 401 body: distinguishing "no such project" from "no such member" from "wrong token"
// tells an outsider which of the three they guessed right.
function authenticate(req) {
  if (!config) return { paths: LEGACY, email: null };

  const projectId = String(req.headers['x-project'] || '').trim();
  const header = String(req.headers.authorization || '');
  const m = /^Basic\s+(.+)$/i.exec(header);
  if (!m) return { fail: 'missing Basic authorization', challenge: true };

  let decoded = '';
  try { decoded = Buffer.from(m[1], 'base64').toString('utf8'); } catch { return { fail: 'unreadable credential' }; }
  const cut = decoded.indexOf(':');
  if (cut < 1) return { fail: 'malformed credential' };
  const email = decoded.slice(0, cut).toLowerCase();
  const token = decoded.slice(cut + 1);

  const verify = (m) => {
    const got = crypto.scryptSync(token, String(m.salt), 32);
    const want = Buffer.from(String(m.hash), 'hex');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  };

  const project = config.projects && config.projects[projectId];
  const member = project && project.members && project.members[email];

  if (project && member && verify(member)) {
    return { paths: projectPaths(project), email, projectId, project };
  }

  // The credential is good but not for this project. Saying so is safe — the caller has already
  // proved they hold a real credential, so it tells an outsider nothing — and it is the difference
  // between a spool that drains and one that grows for ever. A 401 cannot distinguish "a token that
  // will be fixed" from "a project id in a committed settings.json that never will be", so senders
  // retry both; 403 says "authenticated, and this will never work", and they drop it and log loudly.
  const elsewhere = Object.entries(config.projects || {})
    .some(([id, p]) => id !== projectId && p.members && p.members[email] && verify(p.members[email]));
  if (elsewhere) {
    return { fail: `credential is valid but not for project "${projectId}"`, forbidden: true };
  }

  // Nothing matched. Hash once more so a wrong email does not answer faster than a wrong token.
  crypto.scryptSync(token || 'x', 'timing', 32);
  return { fail: 'not authorised for this project' };
}

// ---------------------------------------------------------------- running aggregate by itself
//
// The decision this project started from was that distilling happens **when knowledge arrives**, not
// on a schedule — a weekly cron is the thing that makes a pipeline stop feeling automatic. So the
// trigger lives here, in the process that is already resident: no cron, no scheduler, no new
// component. A project with no `aggregate` block in the config never runs anything, which keeps the
// manual path and every existing test untouched.
//
// Three mechanisms, each for something already observed rather than imagined:
//
//   debounce      Both hooks fire for one note, so one note is TWO accepts (visible in every
//                 end-to-end run), and a session often writes several notes in a row. Without a
//                 quiet window that is three or four model-spending runs for one session's work.
//   single-flight Two overlapping runs would race the same git clone and the same branch name.
//   pull first    Merging onto a stale AGENTS.md re-proposes exactly the lines a reviewer just
//                 deleted. Skipping the run is strictly better than running on old state, so a
//                 failed pull aborts loudly instead of continuing.
const AGG_DEFAULTS = { quietSeconds: 120, votes: 3, model: 'opus', cap: 50, artifact: 'AGENTS.md' };
const aggState = new Map(); // projectId -> { timer, running, dirty }

function aggLog(id, msg) { console.error(`[trigger:${id}] ${msg}`); }

function runAggregate(projectId, project, paths) {
  const cfg = Object.assign({}, AGG_DEFAULTS, project.aggregate);
  const st = aggState.get(projectId);
  st.running = true;
  st.timer = null;

  // Two different things look like "pull failed" and only one of them should stop the run.
  //
  // A clone with no upstream has nothing to be stale against, so pulling is not merely optional
  // there — it is meaningless, and `git pull` exits non-zero saying so. Treating that as a reason to
  // abort meant the trigger never fired at all on a local-only artifact repo, which is how the first
  // version of this failed its own test.
  const upstream = spawnSync('git',
    ['-C', cfg.repo, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    { encoding: 'utf8' });

  if (upstream.status === 0) {
    // --ff-only on purpose: a merge commit made unattended in a clone nobody watches is a worse
    // outcome than a skipped run, and a non-fast-forward here means someone pushed to the artifact,
    // which is exactly when this must not proceed on what it already had.
    const pull = spawnSync('git', ['-C', cfg.repo, 'pull', '--ff-only'], { encoding: 'utf8' });
    if (pull.status !== 0) {
      aggLog(projectId, `SKIPPED: git pull --ff-only failed in ${cfg.repo} — ` +
        `${(pull.stderr || pull.stdout || '').trim().split('\n')[0]}. ` +
        `Refusing to merge onto a stale artifact; fix the clone and the next note will retrigger.`);
      st.running = false;
      return;
    }
  } else {
    aggLog(projectId, `no upstream in ${cfg.repo} — local-only clone, nothing to pull`);
  }

  const script = cfg.script || path.join(__dirname, 'aggregate.js');
  const args = [
    script,
    '--store', path.join(paths.out, 'notes'),
    '--events', paths.eventsFile,
    '--artifact', path.join(cfg.repo, cfg.artifact),
    '--cap', String(cfg.cap),
    '--votes', String(cfg.votes),
    '--model', cfg.model,
  ];
  if (cfg.commit) args.push('--commit');
  // Without this the commit lives only in the host's clone and no teammate ever sees it — including
  // an auto-applied confidence change, which would "apply itself" into a directory nobody reads.
  if (cfg.push) args.push('--push');
  // Opening the request too, when the team has supplied a command that can. Pushing a branch needs a
  // key scoped to one repo; opening a request needs a forge API, so it stays a command the team owns
  // rather than an integration this project ships. Absent, the run prints the compare URL and a human
  // clicks it.
  if (cfg.prCommand) args.push('--pr-command', cfg.prCommand);

  aggLog(projectId, `running: node ${args.slice(1).join(' ')}`);
  const started = Date.now();

  // spawn, never spawnSync. This process is the HTTP endpoint, and a synchronous run would stop it
  // answering for however long the model passes take — the hooks of everyone still working would
  // time out and spool while the aggregator thought about their colleague's note.
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const relay = (buf) => String(buf).split('\n').filter(Boolean)
    .forEach(l => aggLog(projectId, '  ' + l));
  child.stdout.on('data', relay);
  child.stderr.on('data', relay);

  child.on('close', (code) => {
    aggLog(projectId, `finished in ${Math.round((Date.now() - started) / 1000)}s, exit ${code}`);
    st.running = false;
    if (st.dirty) {
      st.dirty = false;
      aggLog(projectId, `notes arrived while running — one more pass in ${cfg.quietSeconds}s`);
      st.timer = setTimeout(() => runAggregate(projectId, project, paths), cfg.quietSeconds * 1000);
      st.timer.unref?.();
    }
  });
}

function scheduleAggregate(projectId, project, paths) {
  if (!project || !project.aggregate || !project.aggregate.repo) return;
  const cfg = Object.assign({}, AGG_DEFAULTS, project.aggregate);

  if (!aggState.has(projectId)) aggState.set(projectId, { timer: null, running: false, dirty: false });
  const st = aggState.get(projectId);

  if (st.running) {
    // Do not queue a second run: mark it and let the one in flight decide, or two runs end up on the
    // same branch name at the same time.
    if (!st.dirty) aggLog(projectId, 'note arrived while a run is in flight — will re-run once after');
    st.dirty = true;
    return;
  }

  if (st.timer) clearTimeout(st.timer);
  st.timer = setTimeout(() => runAggregate(projectId, project, paths), cfg.quietSeconds * 1000);
  st.timer.unref?.();
  aggLog(projectId, `note accepted — aggregate in ${cfg.quietSeconds}s unless another arrives first`);
}

const server = http.createServer((req, res) => {
  const send = (code, obj, headers) => {
    res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, headers || {}));
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'GET' && req.url.startsWith('/health')) return send(200, { ok: true });
  if (req.method !== 'POST' || !req.url.startsWith('/note')) return send(404, { error: 'not found' });

  const addr = String(req.socket.remoteAddress);
  if (config && overAuthLimit(addr)) {
    console.error(`[ingest] 429 too many auth attempts from ${addr}`);
    return send(429, { error: 'rate limited, retry later' }, { 'Retry-After': '600' });
  }

  const auth = authenticate(req);
  if (auth.fail) {
    const code = auth.forbidden ? 403 : 401;
    console.error(`[ingest] ${code} (${auth.fail}) from ${addr}`);
    return send(code, { error: auth.forbidden ? auth.fail : 'not authorised' },
      auth.challenge ? { 'WWW-Authenticate': 'Basic realm="agent-knowledge"' } : {});
  }

  // 429 rather than a silent drop, and the senders spool on it: a rate limit is meant to delay
  // knowledge, never to destroy it.
  const rateKey = auth.email ? `${auth.projectId}:${auth.email}` : addr;
  if (overLimit(rateKey, RATE.notesPerHour, RATE.burst)) {
    console.error(`[ingest] 429 rate limited ${rateKey} — ${RATE.notesPerHour}/hour, burst ${RATE.burst}`);
    return send(429, { error: 'rate limited, retry later' }, { 'Retry-After': '600' });
  }

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const note = fromHeaders(req, raw);

    // Identity comes from the credential, never from the note. The sender still reports its Claude
    // account, and that stays as a label, but the key the promotion rule counts is the email that
    // authenticated. A self-asserted key would let one member forge a second contributor and walk
    // an entry through the auto-apply path — the one path with no human on it.
    if (auth.email) {
      note.identity_claimed = note.identity_key;
      note.identity_key = auth.email;
      note.identity_label = auth.email;
      note.identity_source = 'basic-auth';
    }

    const bad = validate(note);
    if (bad) {
      console.error(`[ingest] REFUSED (${bad}) — wire body was ${raw.length} bytes`);
      return send(422, { error: bad });
    }

    const r = accept(note, auth.paths);
    console.error(`[ingest] accepted ${r.local}${auth.projectId ? ' [' + auth.projectId + ']' : ''} — ` +
                  `${r.bytes} bytes of note, wire body ${raw.length} bytes, ` +
                  `${r.people} contributor(s) so far`);
    send(200, { ok: true, stored: r.local, bytes: r.bytes });

    // After the response, not before: the hook is waiting, and a note that was stored must be
    // acknowledged whether or not anything downstream is configured to act on it.
    if (auth.projectId) scheduleAggregate(auth.projectId, auth.project, auth.paths);
  });
});

// Report the port the OS actually gave us, not the one asked for. They differ whenever the request
// was 0 — which is how a test avoids fighting a listener a previous run left behind, and how the
// EADDRINUSE that produced nine unexplained failures stops being possible.
server.on('listening', () => {
  const a = server.address();
  console.error(`[ingest] listening on ${bind}:${a.port} — ` +
    (config ? `${Object.keys(config.projects || {}).length} project(s), Basic auth required`
            : `single project, NO AUTH, ${LEGACY.out}`));
});

// And say so out loud when it cannot listen at all. Without this the process died with a stack trace
// on stderr that a test waiting for the word "listening" spun past, then reported every case as a
// product failure — the loudest possible signal about the wrong thing.
server.on('error', (e) => {
  console.error(`[ingest] FATAL: cannot listen on ${bind}:${port} — ${e.code || e.message}` +
    (e.code === 'EADDRINUSE' ? ' (something else is already on that port)' : ''));
  process.exit(1);
});

server.listen(port, bind);
