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

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const port = parseInt(opt('port', '8791'), 10);
const out = path.resolve(opt('out', './inbox'));

const notesDir = path.join(out, 'notes');
fs.mkdirSync(notesDir, { recursive: true });
const eventsFile = path.join(out, 'events.jsonl');

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

function readEvents() {
  if (!fs.existsSync(eventsFile)) return [];
  return fs.readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function accept(n) {
  // Re-create the directory rather than assuming it survived since startup. Anything that
  // tidies the inbox — a cleanup script, an operator, a test — would otherwise make every
  // subsequent note fail, and the sender only sees a 5xx it will spool and retry forever.
  fs.mkdirSync(notesDir, { recursive: true });
  const base = path.basename(String(n.file_path).replace(/\\/g, '/'));
  const who = slug(n.identity_label || n.identity_key);
  const local = `${who}__${base}`;
  fs.writeFileSync(path.join(notesDir, local), n.content);

  const events = readEvents();

  // One person arriving under two different keys is the one way the contributor count
  // can silently inflate, and a shared label with a different key is the detectable
  // signature of it. Worth a loud line: nothing downstream can spot this.
  const clash = events.find(e => e.label && n.identity_label && e.label === n.identity_label && e.user !== n.identity_key);
  if (clash) {
    console.error(`[ingest] WARNING identity mixing: ${n.identity_label} has appeared as both ` +
                  `${clash.user} (${clash.source || 'unknown source'}) and ${n.identity_key} (${n.identity_source}). ` +
                  `They will count as two people and can promote an entry on their own.`);
  }

  // One row per (person, note). A later snapshot of the same note replaces the older
  // row instead of inflating the count — the same person writing twice is one person.
  const kept = events.filter(e => !(e.user === n.identity_key && path.basename(String(e.file).replace(/\\/g, '/')) === local));
  kept.push({
    user: n.identity_key,
    label: n.identity_label || null,
    source: n.identity_source || null,
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

http.createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'GET' && req.url.startsWith('/health')) return send(200, { ok: true });
  if (req.method !== 'POST' || !req.url.startsWith('/note')) return send(404, { error: 'not found' });

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const note = fromHeaders(req, raw);

    const bad = validate(note);
    if (bad) {
      console.error(`[ingest] REFUSED (${bad}) — wire body was ${raw.length} bytes`);
      return send(422, { error: bad });
    }

    const r = accept(note);
    console.error(`[ingest] accepted ${r.local} — ${r.bytes} bytes of note, ` +
                  `wire body ${raw.length} bytes, ${r.people} contributor(s) so far`);
    send(200, { ok: true, stored: r.local, bytes: r.bytes });
  });
}).listen(port, () => console.error(`[ingest] listening on ${port}, writing ${out}`));
