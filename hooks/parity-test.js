// Runs post-note.sh and post-note.js over the same awkward inputs and asserts they deliver
// byte-identical notes through the real endpoint.
//
//   node hooks/parity-test.js
//
// The shell implementation exists so a machine without node still participates, and it pays
// for that by extracting fields with grep and sed instead of a JSON parser. This is the
// mitigation: paths with spaces, diacritics and backslashes, content full of shell
// metacharacters, and a note far larger than any real one. Three of the silent failures
// found in this pipeline were path-shape bugs, so the cases lean that way deliberately.
//
// The endpoint runs as a separate process on purpose: an in-process server cannot answer
// while spawnSync holds the event loop, which silently turns every case into a curl
// timeout — the first version of this test failed exactly that way and blamed the hooks.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync, spawn } = require('child_process');

const PORT = 8799;
const notesRoot = path.join(os.tmpdir(), 'parity-notes');
const proj = path.join(os.tmpdir(), 'parity proj');       // a space in the project path too
const outDir = path.join(os.tmpdir(), 'parity-inbox');
const ingestJs = path.join(__dirname, '..', 'aggregator', 'ingest.js');

const CASES = [
  ['plain ascii', 'fk-trap.md', 'seed.js FK error means schema.json is missing.\n'],
  ['diacritics', 'bay-tieng-viet.md', 'Do not call `RefundService` directly, it skips the audit log. Go through `PaymentService.refund()`.\n'],
  ['backslash and quotes', 'quotes.md', 'Path: D:\\Catalog\\thu muc\\file.ts and he said "run migrate first" — ok?\n'],
  ['shell metacharacters', 'shellmeta.md', 'Cost $100 `whoami` $(rm -rf /) ${HOME} && echo pwned | tee x\n'],
  ['filename with diacritics', 'ghi-chú-bẫy.md', 'Filename carries diacritics, body is short.\n'],
  ['~17KB note', 'big.md', '---\nname: big\n---\n' + Array.from({ length: 260 }, (_, i) =>
    `- line ${String(i + 1).padStart(3, '0')}: the seed script prints a misleading foreign key error`).join('\n') + '\n'],
];

const health = () => new Promise(r => {
  const req = http.get(`http://127.0.0.1:${PORT}/health`, res => { res.resume(); r(true); });
  req.on('error', () => r(false));
  req.setTimeout(400, () => { req.destroy(); r(false); });
});

function fire(runner, file) {
  const payload = JSON.stringify({
    hook_event_name: 'PostToolUse', tool_name: 'Write', session_id: 'parity',
    cwd: proj, tool_input: { file_path: file, content: 'ignored — both read from disk' },
  });
  const [cmd, args] = runner === 'sh'
    ? ['sh', [path.join(__dirname, 'post-note.sh')]]
    : [process.execPath, [path.join(__dirname, 'post-note.js')]];
  return spawnSync(cmd, args, {
    input: payload,
    // A credential, because both senders now spool instead of sending without one. Supplied
    // through the environment rather than a file so this test stays about wire-format parity;
    // auth-test.js is where the credential path itself is exercised.
    env: {
      ...process.env,
      AGENT_KNOWLEDGE_INGEST: `http://127.0.0.1:${PORT}`,
      AGENT_KNOWLEDGE_USER: 'parity@example.com',
      AGENT_KNOWLEDGE_TOKEN: 'parity-token',
      AGENT_KNOWLEDGE_PROJECT: 'parity-project',
    },
  }).status;
}

const stored = () => {
  const d = path.join(outDir, 'notes');
  if (!fs.existsSync(d)) return null;
  const f = fs.readdirSync(d)[0];
  return f ? fs.readFileSync(path.join(d, f)) : null;
};
// Empty the notes directory without removing it: the endpoint holds a path to it, and
// deleting the directory under a running server made every case fail with a 5xx while the
// hooks were behaving perfectly.
const clearInbox = () => {
  const d = path.join(outDir, 'notes');
  if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) fs.rmSync(path.join(d, f), { force: true });
  fs.rmSync(path.join(outDir, 'events.jsonl'), { force: true });
};

(async () => {
  fs.mkdirSync(notesRoot, { recursive: true });
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'settings.json'),
    JSON.stringify({ autoMemoryDirectory: notesRoot.replace(/\\/g, '/') }, null, 2));
  clearInbox();

  const srv = spawn(process.execPath, [ingestJs, '--port', String(PORT), '--out', outDir],
    { stdio: 'ignore', detached: false });

  for (let i = 0; i < 40 && !(await health()); i++) await new Promise(r => setTimeout(r, 100));
  if (!(await health())) { console.error('ingest failed to start'); srv.kill(); process.exit(2); }

  let fails = 0;
  for (const [label, name, content] of CASES) {
    const file = path.join(notesRoot, name);
    fs.writeFileSync(file, content, 'utf8');
    const onDisk = fs.readFileSync(file);
    const wire = file.replace(/\\/g, '/');

    clearInbox();
    const shStatus = fire('sh', wire);
    const bodySh = stored();

    clearInbox();
    const ndStatus = fire('node', wire);
    const bodyNd = stored();

    const problems = [];
    if (!bodySh) problems.push('shell did not arrive');
    if (!bodyNd) problems.push('node did not arrive');
    if (bodySh && !bodySh.equals(onDisk)) problems.push(`shell differs from disk (${bodySh.length}/${onDisk.length}B)`);
    if (bodyNd && !bodyNd.equals(onDisk)) problems.push(`node differs from disk (${bodyNd.length}/${onDisk.length}B)`);
    if (bodySh && bodyNd && !bodySh.equals(bodyNd)) problems.push('the two senders disagree');

    if (problems.length) fails++;
    console.log(`  ${problems.length ? 'FAIL' : 'ok  '} ${label.padEnd(20)} ${String(onDisk.length).padStart(6)}B` +
      (problems.length ? `\n         ${problems.join('; ')} (exit sh=${shStatus} node=${ndStatus})` : ''));
  }

  srv.kill();
  console.log(fails ? `\n${fails}/${CASES.length} case(s) failed` : `\n${CASES.length}/${CASES.length} match — both senders deliver byte-identical notes`);
  process.exit(fails ? 1 : 0);
})();
