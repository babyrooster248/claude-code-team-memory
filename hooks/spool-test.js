// Checks the spool survives every combination of runtimes: a note spooled by either sender
// must be drainable by either flusher.
//
//   node hooks/spool-test.js
//
// This test exists because the shell sender shipped without a shell flusher, and the two
// senders spooled different formats. On a machine with a shell and no Node — the machine the
// shell sender exists for — notes were spooled and never sent again. Nothing logged an error;
// the note simply stopped existing as far as the team was concerned.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync, spawn } = require('child_process');

const PORT = 8802;
const notesRoot = path.join(os.tmpdir(), 'spool-notes');
const proj = path.join(os.tmpdir(), 'spool-proj');
const outDir = path.join(os.tmpdir(), 'spool-inbox');
const SPOOL = path.join(os.homedir(), '.agent-knowledge-spool');
const ingestJs = path.join(__dirname, '..', 'aggregator', 'ingest.js');

const health = () => new Promise(r => {
  const req = http.get(`http://127.0.0.1:${PORT}/health`, res => { res.resume(); r(true); });
  req.on('error', () => r(false));
  req.setTimeout(400, () => { req.destroy(); r(false); });
});

const runner = k => k === 'sh' ? ['sh', ['post-note.sh']] : [process.execPath, ['post-note.js']];
const flusher = k => k === 'sh' ? ['sh', ['flush-spool.sh']] : [process.execPath, ['flush-spool.js']];

function send(kind, file, ingestUrl) {
  const [cmd, args] = runner(kind);
  return spawnSync(cmd, args.map(a => path.join(__dirname, a)), {
    input: JSON.stringify({
      hook_event_name: 'PostToolUse', tool_name: 'Write', session_id: 'spool',
      cwd: proj, tool_input: { file_path: file, content: 'read from disk' },
    }),
    env: { ...process.env, AGENT_KNOWLEDGE_INGEST: ingestUrl, AGENT_KNOWLEDGE_USER: "spool@example.com", AGENT_KNOWLEDGE_TOKEN: "spool-token" },
  }).status;
}
function flush(kind, ingestUrl) {
  const [cmd, args] = flusher(kind);
  return spawnSync(cmd, args.map(a => path.join(__dirname, a)), {
    env: { ...process.env, AGENT_KNOWLEDGE_INGEST: ingestUrl, AGENT_KNOWLEDGE_USER: "spool@example.com", AGENT_KNOWLEDGE_TOKEN: "spool-token" },
  }).status;
}

const spoolCount = () => fs.existsSync(SPOOL) ? fs.readdirSync(SPOOL).filter(f => f.endsWith('.head')).length : 0;
const delivered = () => {
  const d = path.join(outDir, 'notes');
  return fs.existsSync(d) ? fs.readdirSync(d).length : 0;
};
const reset = () => {
  fs.rmSync(SPOOL, { recursive: true, force: true });
  const d = path.join(outDir, 'notes');
  if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) fs.rmSync(path.join(d, f), { force: true });
  fs.rmSync(path.join(outDir, 'events.jsonl'), { force: true });
};

(async () => {
  fs.mkdirSync(notesRoot, { recursive: true });
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'settings.json'),
    JSON.stringify({ autoMemoryDirectory: notesRoot.replace(/\\/g, '/') }, null, 2));
  const note = path.join(notesRoot, 'spooled-trap.md');
  fs.writeFileSync(note, '---\nname: spooled\n---\nDo not call RefundService directly, it skips the audit log.\n', 'utf8');
  const wire = note.replace(/\\/g, '/');

  const srv = spawn(process.execPath, [ingestJs, '--port', String(PORT), '--out', outDir], { stdio: 'ignore' });
  for (let i = 0; i < 40 && !(await health()); i++) await new Promise(r => setTimeout(r, 100));
  if (!(await health())) { console.error('ingest failed to start'); srv.kill(); process.exit(2); }

  const dead = 'http://127.0.0.1:9';           // nothing listens here
  const live = `http://127.0.0.1:${PORT}`;
  let fails = 0;

  for (const sender of ['sh', 'node']) {
    for (const drainer of ['sh', 'node']) {
      reset();
      send(sender, wire, dead);
      const spooled = spoolCount();
      flush(drainer, live);
      const leftover = spoolCount();
      const got = delivered();

      const problems = [];
      if (spooled !== 1) problems.push(`${sender} did not spool (${spooled} entry)`);
      if (got !== 1) problems.push(`${drainer} could not deliver (${got} notes arrived)`);
      if (leftover !== 0) problems.push(`spool still holds ${leftover} after the flush`);
      if (problems.length) fails++;
      console.log(`  ${problems.length ? 'FAIL' : 'ok  '} ${sender} spool -> ${drainer} flush` +
        (problems.length ? `\n         ${problems.join('; ')}` : ''));
    }
  }

  // A note the endpoint refuses must leave the spool rather than be retried forever.
  reset();
  fs.writeFileSync(path.join(notesRoot, 'MEMORY.md'), '- [x](x.md) index line\n', 'utf8');
  send('sh', path.join(notesRoot, 'MEMORY.md').replace(/\\/g, '/'), dead);
  const idxSpooled = spoolCount();
  flush('node', live);
  const idxLeft = spoolCount();
  const ok = idxSpooled === 0 || idxLeft === 0;
  if (!ok) fails++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} a note the endpoint refuses does not stay in the spool` +
    (ok ? '' : `\n         spool still holds ${idxLeft}`));

  srv.kill();
  reset();
  console.log(fails ? `\n${fails} case(s) failed` : `\n5/5 passed — either flusher drains either senders spool`);
  process.exit(fails ? 1 : 0);
})();
