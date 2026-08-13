// Aggregator: turns per-person memory notes into a reviewed team artifact.
//
//   node aggregate.js --store <memory-dir> --events events.jsonl \
//                     --artifact ../AGENTS.md [--cap 50] [--model opus]
//                     [--votes 3] [--commit]
//
// Inputs come from the ingest endpoint: notes/ holds the content, events.jsonl holds
// who wrote each one and when. Attribution is keyed on the writer's Claude account, so
// "a second, verified person" means a genuinely different person.
//
// Two gates, and only one of them is a human. A change that alters what the file says
// goes to a person. A pure promotion — identical sentence, moved because someone else
// independently hit the same thing — applies itself, since there is nothing to weigh.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { pickBranch, publish, DEFAULT_BRANCH } = require('./branch');

// Declared up here rather than beside the parser because the deletion check runs earlier in the
// file and `const` is not hoisted — putting these next to their users cost one TDZ crash.
const MARKER = /^\(\s*(?:unconfirmed\s*,\s*)?(\d+)\s*(?:person|people)\s*\)/i;
const shortHash = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const has = n => argv.includes('--' + n);

const store = opt('store', null);
const eventsFile = opt('events', null);
const artifact = opt('artifact', null);
const cap = parseInt(opt('cap', '50'), 10);
// opus, not sonnet. Measured on the same 29 cases and the same prompt: opus 100% / haiku 89.7% /
// sonnet 69%, with sonnet dropping half the real knowledge while keeping perfect precision — the
// most dangerous shape a filter can have, because nothing appears anywhere to show what was lost.
// See docs/findings.md §3. This used to default to sonnet, which meant every run that forgot the flag
// risked discarding the note it was called to distil.
const model = opt('model', 'opus');
const votes = parseInt(opt('votes', '3'), 10);
// Optional, and deliberately a command rather than an integration. Opening a pull request needs a
// forge API and a token scoped far wider than the deploy key that pushes the branch, and this project
// works on any git host precisely because it never calls one. A team that wants the request opened
// automatically supplies the command that does it — `gh pr create --fill --base main` — with their own
// credential. BRANCH is substituted. Nothing here learns what a forge is.
const prCommand = opt('pr-command', null);

if (!store || !artifact) {
  console.error('usage: node aggregate.js --store <memory-dir> --artifact <file> [--events e.jsonl]');
  process.exit(2);
}

const here = __dirname;
const filterPrompt = fs.readFileSync(path.join(here, '..', 'eval', 'filter-prompt.md'), 'utf8');
const mergePrompt = fs.readFileSync(path.join(here, 'merge-prompt.md'), 'utf8');

function claude(input) {
  const r = spawnSync('claude', ['-p', '--model', model], {
    input, encoding: 'utf8', shell: true, maxBuffer: 20 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error('claude failed: ' + (r.stderr || '').slice(0, 400));
  return (r.stdout || '').trim();
}

// ---- 1. gather candidates: content from the store, attribution from events ----

const attribution = new Map(); // basename -> { users:Set, first, last, writes }
let badLines = 0;
if (eventsFile && fs.existsSync(eventsFile)) {
  for (const line of fs.readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean)) {
    let e;
    try { e = JSON.parse(line); } catch { badLines++; continue; }
    const key = path.basename(String(e.file || '').replace(/\\/g, '/'));
    if (!key) continue;
    if (!attribution.has(key)) attribution.set(key, { users: new Set(), first: e.ts, last: e.ts, writes: 0 });
    const a = attribution.get(key);
    if (e.user) a.users.add(e.user);
    if (e.ts && e.ts < a.first) a.first = e.ts;
    if (e.ts && e.ts > a.last) a.last = e.ts;
    a.writes++;
  }
}

const candidates = fs.readdirSync(store)
  // MEMORY.md is a personal index of one member's own notes, never knowledge. Stored
  // names carry an author prefix (`someone-example-com__MEMORY.md`), so an equality
  // check against the bare name silently stops matching — match the suffix instead.
  .filter(f => f.endsWith('.md') && !/(^|__)MEMORY\.md$/i.test(f))
  .map(f => {
    const a = attribution.get(f) || { users: new Set(), first: null, last: null, writes: 0 };
    return {
      name: f,
      content: fs.readFileSync(path.join(store, f), 'utf8'),
      people: a.users.size || 1,
      first: a.first, last: a.last, writes: a.writes,
    };
  });

console.log(`[aggregate] ${candidates.length} candidate notes in store, ` +
            `${attribution.size} indexed by telemetry`);
if (badLines) {
  console.error(`[aggregate] FATAL: ${badLines} unparseable event line(s). Attribution would be ` +
                `wrong, and a wrong contributor count silently degrades the promotion gate to ` +
                `"seen twice". Fix the event stream before proposing anything.`);
  process.exit(1);
}
const unattributed = candidates.filter(c => !attribution.has(c.name));
if (unattributed.length) {
  console.log(`[aggregate] ${unattributed.length} note(s) have no telemetry record — treated as ` +
              `unattributed; they cannot promote an entry.`);
}
console.log('');

// ---- 2. intake filter, majority of N votes ----

function verdict(text) {
  const tally = { KEEP: 0, DROP: 0 };
  let reason = '';
  for (let i = 0; i < votes; i++) {
    const out = claude(filterPrompt + text + '\n');
    const m = out.match(/VERDICT:\s*(KEEP|DROP)\s*[—\-–]?\s*(.*)/i);
    if (!m) continue;
    tally[m[1].toUpperCase()]++;
    if (!reason) reason = (m[2] || '').trim();
  }
  return { keep: tally.KEEP > tally.DROP, split: tally.KEEP > 0 && tally.DROP > 0, reason };
}

const kept = [];
for (const c of candidates) {
  const v = verdict(c.content);
  console.log(`  ${v.keep ? 'KEEP' : 'DROP'} ${c.name}${v.split ? ' [split vote]' : ''}\n       ${v.reason}`);
  if (v.keep) kept.push(c);
}
console.log(`\n[aggregate] ${kept.length}/${candidates.length} survived intake\n`);
if (!kept.length) { console.log('nothing to propose.'); process.exit(0); }

// ---- 3. merge into the artifact ----

const current = fs.existsSync(artifact) ? fs.readFileSync(artifact, 'utf8') : '';
const rejectedFile = path.join(path.dirname(artifact), 'rejected.md');

// Contributor ids are opaque short hashes: enough to union sets and count
// distinct people, without putting anyone's address in a committed file.
const cid = email => crypto.createHash('sha256').update(String(email)).digest('hex').slice(0, 8);

// ---- deleting a line is how a reviewer says no ----
//
// The natural way to reject a proposed fact is to delete the line and merge. Before this
// existed, the note stayed in the inbox and the fact was not on the rejected list, so the next
// run proposed it again — and again. A pipeline that re-asks a question the lead already
// answered gets muted within a week, which costs far more than the fact was worth.
//
// The comparison has to be against what the machine last put in the file, not against its last
// *proposal*. A proposal sitting in an unmerged PR is simply pending, and treating it as
// deleted would file rejections for everything in flight. Git already holds the right answer:
// the most recent commit the aggregator made to this file. If the reviewer deleted the line
// inside the PR, that commit still carries it and the merged result does not — which is exactly
// the signal wanted, and it needs no forge API to read.
function lastMachineVersion() {
  const repo = path.dirname(path.resolve(artifact));
  const g = a => {
    const r = spawnSync('git', a, { cwd: repo, encoding: 'utf8', shell: true });
    return r.status === 0 ? (r.stdout || '').trim() : null;
  };
  const rel = g(['ls-files', '--full-name', '--', `"${path.basename(artifact)}"`]);
  if (!rel) return null;
  const sha = g(['log', '-n', '1', '--format=%H', '--grep=^chore(agent-knowledge):', '--', `"${rel}"`]);
  if (!sha) return null;
  return g(['show', `${sha}:${rel}`]);
}

function recordHumanDeletions() {
  let previous;
  try { previous = lastMachineVersion(); } catch { previous = null; }
  if (!previous) return [];

  // Keyed on id, not on text. A reviewer who rewords a line and keeps its id has edited a fact,
  // not rejected one; only a vanished id means the line is gone.
  const before = parseEntries(previous).entries;
  const after = parseEntries(current).entries;
  const removed = [...before.entries()].filter(([k]) => !after.has(k)).map(([, v]) => v.bare);
  if (!removed.length) return [];

  const today = new Date().toISOString().slice(0, 10);
  const header = fs.existsSync(rejectedFile) ? '' :
    'Facts a reviewer has already declined. Do not propose these again in any wording.\n' +
    'To let one back in, delete its line from this file.\n';
  const lines = removed.map(t => `\n- ${t}\n  (removed by review ${today})\n`).join('');
  fs.appendFileSync(rejectedFile, header + lines);
  return removed;
}

const justRejected = recordHumanDeletions();
if (justRejected.length) {
  console.log(`[aggregate] ${justRejected.length} line(s) were removed by a human since the last ` +
              `agent-knowledge commit — recorded in rejected.md, they will not come back:`);
  for (const t of justRejected) console.log(`  · ${t.slice(0, 90)}${t.length > 90 ? '…' : ''}`);
  console.log('');
}

const rejected = fs.existsSync(rejectedFile) ? fs.readFileSync(rejectedFile, 'utf8') : '(none)';

const block = kept.map(c => {
  const a = attribution.get(c.name);
  const ids = a && a.users.size ? [...a.users].map(cid) : null;
  return `### candidate: ${c.name}\n` +
    `contributor ids: ${ids ? ids.join(', ') : 'UNATTRIBUTED — must not raise any contributor count'}` +
    `${c.first ? ` | first seen ${c.first} | last ${c.last}` : ''}\n\n` +
    c.content.trim() + '\n';
}).join('\n');

// The inputs are fenced with markers rather than `##` headings, because the first real run
// proved the model mirrors the input's structure into the output: an artifact came back carrying
// a `## Previously rejected` section containing `(none)`. That is not only noise in a file every
// teammate reads, it also miscounts against the size cap.
const input =
  mergePrompt +
  `\n\n<<<LINE LIMIT>>>\n${cap} content lines.\n<<<END LINE LIMIT>>>\n` +
  `\n<<<CURRENT FILE: ${artifact}>>>\n${current || '(empty — this is the first entry)'}\n<<<END CURRENT FILE>>>\n` +
  `\n<<<PREVIOUSLY REJECTED>>>\n${rejected}\n<<<END PREVIOUSLY REJECTED>>>\n` +
  `\n<<<CANDIDATES>>>\n${block}\n<<<END CANDIDATES>>>\n`;

const out = claude(input);
const file = (out.match(/<<<FILE>>>\n([\s\S]*?)\n<<<END FILE>>>/) || [])[1];
const changes = (out.match(/<<<CHANGES>>>\n([\s\S]*?)\n<<<END CHANGES>>>/) || [])[1];

if (file === undefined) {
  console.error('could not parse merge output:\n' + out.slice(0, 1500));
  process.exit(1);
}

// Content lines exclude headings, blanks, and the knowledge-state comment block —
// Claude Code strips block-level HTML comments before loading, so they cost nothing.
const contentLines = (() => {
  let inComment = false, n = 0;
  for (const raw of file.split('\n')) {
    const l = raw.trim();
    if (l.startsWith('<!--')) { inComment = !l.includes('-->'); continue; }
    if (inComment) { if (l.includes('-->')) inComment = false; continue; }
    if (l && !l.startsWith('#')) n++;
  }
  return n;
})();
console.log('--- changes ---\n' + (changes || '(none reported)'));
console.log(`\n--- new file: ${contentLines} content lines (cap ${cap})` +
            `${contentLines > cap ? '  ** OVER CAP **' : ''} ---`);
console.log(file);

// A pure promotion — same sentence, moved from `## Unconfirmed` into a main section
// because a second verified person hit it — carries no decision for a reviewer to make.
// The fact itself was approved when it first went in. Sending a PR for the section
// label and a count is how a review queue fills with changes nobody needs to read,
// which is how the gate stops being read at all.
//
// So promotions apply themselves. The guard is mechanical, not a promise from the
// model: the entry text must be identical once the `(N people)` marker is stripped, and
// no entry may appear or disappear. Anything else — new text, an edit, a deletion, a
// demotion, a flagged contradiction — goes to a person.
// This file is edited by hand, so the parser's job is to survive whatever a reviewer does to
// it — never to crash, never to drop a line quietly, and never to demand that anyone learn a
// format. An earlier version stopped parsing at the first `<!--`, which meant a lead adding
// `<!-- TODO: revisit -->` in the middle silently erased everything below it from the machine's
// view. Being wrong in that direction is the worst case: the whole design's failure mode is
// silence, so the parser has to be the loud part.
function parseEntries(text) {
  const entries = new Map();
  const warnings = [];
  let section = null;
  let inComment = false;
  let order = 0;

  for (const raw of text.split('\n')) {
    const line = raw.trim();

    // Skip comment blocks, single or multi line, and keep going afterwards. The
    // knowledge-state block is one of these; so is anything a human left for a human.
    if (inComment) { if (line.includes('-->')) inComment = false; continue; }
    if (line.startsWith('<!--')) { if (!line.includes('-->')) inComment = true; continue; }

    if (line.startsWith('#')) { section = line.replace(/^#+\s*/, ''); continue; }

    const bullet = line.match(/^-\s+(.*)$/);
    if (!bullet) continue;

    let body = bullet[1].trim();
    const idM = body.match(/\s*\[(k\d+)\]\s*$/);
    const id = idM ? idM[1] : null;
    if (idM) body = body.slice(0, idM.index).trim();

    const mk = body.match(MARKER);
    const bare = body.replace(MARKER, '').replace(/\s+/g, ' ').trim();
    if (!bare) { warnings.push(`empty entry in section "${section}"`); continue; }

    // A hand-written line has no id yet, and it still has to be tracked so that nothing
    // downstream can tidy it away. Keying it by its own text keeps two parses of the same
    // file in agreement until the next run gives it a real id.
    const key = id || `anon:${shortHash(bare)}`;
    if (!id) warnings.push(`entry has no id, keyed by text for now: "${bare.slice(0, 48)}…"`);
    // No marker means nobody knows how many people confirmed it, so it counts as one and
    // stays unsure. Guessing upward here would let a hand-written line promote itself.
    if (!mk) warnings.push(`entry ${key} has no confidence marker, treated as (unconfirmed, 1 person)`);
    if (entries.has(key)) warnings.push(`duplicate entry key ${key}`);

    entries.set(key, {
      section,
      unsure: mk ? /unconfirmed/i.test(mk[0]) : true,
      count: mk ? mk[1] : '1',
      bare,
      hadId: !!id,
      hadMarker: !!mk,
      order: order++,
    });
  }

  if (inComment) warnings.push('a comment block was never closed');
  return { entries, warnings };
}

// A reviewer who renames `## Traps` to `## Traps`, or translates the file, has not moved any
// entry — but comparing section names as strings says they moved all of them, which killed the
// auto-apply path permanently. A rename is recognisable: the old name is gone from the file
// entirely, and every surviving entry that was under it now sits under one single new name.
function renameMap(a, b) {
  const afterSections = new Set([...b.values()].map(e => e.section));
  const dest = new Map();
  for (const [key, x] of a) {
    const y = b.get(key);
    if (!y) continue;
    if (!dest.has(x.section)) dest.set(x.section, new Set());
    dest.get(x.section).add(y.section);
  }
  const map = new Map();
  for (const [from, tos] of dest) {
    if (afterSections.has(from)) continue;   // the name still exists, so this is a real move
    if (tos.size === 1) map.set(from, [...tos][0]);
  }
  return map;
}

function classify(before, after) {
  const { entries: a } = parseEntries(before);
  const { entries: b } = parseEntries(after);
  if (a.size === 0) return { auto: false, why: 'first content in the file' };
  const renamed = renameMap(a, b);
  const keys = new Set([...a.keys(), ...b.keys()]);
  const changed = [];
  for (const key of keys) {
    const x = a.get(key), y = b.get(key);
    if (!x || !y) return { auto: false, why: `entry ${key} was ${x ? 'removed' : 'added'}` };
    if (x.bare !== y.bare) return { auto: false, why: `text of ${key} changed` };
    const expected = renamed.get(x.section) ?? x.section;
    if (y.section !== expected) return { auto: false, why: `${key} moved from "${x.section}" to "${y.section}"` };
    if (x.unsure !== y.unsure || x.count !== y.count) changed.push(key);
  }
  // No entry moved, but the file text might still differ — a heading tidied, a stray section
// removed, whitespace normalised. Saying "nothing changed" while committing a diff is the kind of
  // report that teaches people to stop reading the tool's output.
  if (!changed.length) {
    return before.trim() === after.trim()
      ? { auto: false, why: 'nothing changed' }
      : { auto: false, why: 'only text outside the entries changed' };
  }
  // Going back to unsure means something contradicts a rule the team is following.
  // That is precisely when a person should be looking.
  const demoted = changed.filter(k => b.get(k).unsure && !a.get(k).unsure);
  if (demoted.length) return { auto: false, why: `${demoted.join(', ')} back to unconfirmed — a contradiction needs a person` };
  return { auto: true, why: `confidence only: ${changed.join(', ')}` };
}

const gate = classify(current, file);
console.log(`\n--- gate: ${gate.auto ? 'AUTO-APPLY' : 'NEEDS A PERSON'} (${gate.why}) ---`);

const proposal = artifact + '.proposed';
fs.writeFileSync(proposal, file.endsWith('\n') ? file : file + '\n');
console.log(`\nwritten to ${proposal}`);

// A run that finds nothing to change is the normal outcome once a file is in good shape, and it
// must not look like a fault. The first real end-to-end run ended here — a second session by the
// same person re-reported a trap already recorded, which correctly changes nothing — and the commit
// path reported git's "nothing added to commit" as a failure.
if (has('commit') && file.trim() === current.trim()) {
  console.log('\nnothing to commit — the merge left the file as it stands');
} else if (has('commit')) {
  const repo = path.dirname(path.resolve(artifact));

  // `shell: false`, and the message goes in through a file. The first real end-to-end run left the
  // repository on a fresh branch with the change uncommitted in the working tree, because the
  // message contained backticks and parentheses from the changelog and the shell mangled the
  // command. Worse, this helper ignored the exit status, so all of that happened without a word.
  let failed = null;
  // `probe: true` for commands whose non-zero exit is an answer rather than a problem — asking
  // whether a branch exists exits 1 when it does not, and counting that as a failure turned the
  // normal first run into a reported error.
  const git = (args, { input, probe } = {}) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', input });
    if (r.status !== 0 && !probe && !failed) {
      failed = `git ${args.join(' ')} exited ${r.status}: ${(r.stderr || r.stdout || '').trim().slice(0, 200)}`;
    }
    return r;
  };

  const subject = 'chore(agent-knowledge): ' + (changes || 'update').split('\n')[0].trim();
  const body = (changes || '').trim();
  const msgFile = path.join(repo, '.git', 'AGENT_KNOWLEDGE_MSG');

  // Branch first, then write. Creating the file after the branch switch removes the stash dance
  // the previous version needed, and with it a step that could fail halfway.
  //
  // One branch, one open pull request, for the life of the repository — see branch.js for why, and
  // for the two wrong pull requests that taught it. An auto-applied confidence change stays on the
  // current branch: it carries no decision, so there is nothing to open a request about.
  const branch = DEFAULT_BRANCH;
  if (!gate.auto) {
    const r = pickBranch({ git, branch });
    if (r.action === 'continue') console.log(`continuing the open proposal on ${branch}`);
    if (r.action === 'rebuild') console.log(`rebuilt ${branch} — it had fallen behind the base`);
  }

  fs.copyFileSync(proposal, artifact);
  fs.writeFileSync(msgFile, subject + (body && body !== subject.slice(24) ? '\n\n' + body : '') + '\n');
  git(['add', '--', path.basename(artifact)]);
  git(['commit', '-F', msgFile]);
  fs.rmSync(msgFile, { force: true });

  if (failed) {
    console.error(`\nCOMMIT FAILED — the artifact is written but not committed.\n  ${failed}\n` +
                  `  Working tree: ${repo}\n` +
                  `  Nothing is lost; commit it yourself, or fix the cause and re-run.`);
    process.exit(1);
  }
  const sha = git(['rev-parse', '--short', 'HEAD']).stdout.trim();
  console.log(gate.auto
    ? `committed ${sha} on the current branch — a confidence change carries no decision, so no review`
    : `committed ${sha} on ${branch} — open a PR for review`);

  // Pushing used to be the operator's job, which was fine while a person ran this by hand: they were
  // already at a terminal and would open the pull request themselves. Once the endpoint started
  // launching it there is nobody there, and a commit that only exists in the host's own clone reaches
  // no teammate at all — the auto-apply path in particular would "apply itself" into a directory
  // nobody ever reads. Opt-in, because the manual path should not suddenly start pushing.
  if (has('push')) {
    const out = publish({
      git, prCommand, cwd: repo,
      run: (cmd, cwd) => spawnSync(cmd, { cwd, shell: true, encoding: 'utf8' }),
    });
    out.log.forEach(l => console.log(l));
    if (out.state === 'push-failed') {
      // Loud, and not fatal: the commit is real and local, so the work is not lost — but silence here
      // would mean a pull request that never appears and no clue why.
      console.error(`\nPUSH FAILED — ${sha} is committed on ${out.branch} in ${repo} but did not reach origin.\n` +
        `  ${out.error}\n` +
        `  Nothing is lost. Fix the remote or the credential and push ${out.branch} by hand.`);
    }
  }
}
