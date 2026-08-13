// Reports damage in a hand-edited knowledge file. Read-only: it never rewrites anything.
//
//   node aggregator/check-artifact.js AGENTS.md [--cap 50]
//
// Meant to run in CI on the pull request, so that whatever a reviewer's edit broke is visible
// while they are still looking at it. The next aggregate run repairs most of this on its own —
// the point here is that nobody has to find out later, from a pipeline that has quietly gone
// half-blind.
//
// Exits 0 when the file is clean, 1 when something needs attention, 2 on bad usage.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const file = argv.find(a => !a.startsWith('--'));
const capIdx = argv.indexOf('--cap');
const cap = capIdx === -1 ? 50 : parseInt(argv[capIdx + 1], 10);

if (!file) { console.error('usage: node check-artifact.js <artifact.md> [--cap 50]'); process.exit(2); }
if (!fs.existsSync(file)) { console.error(`file not found: ${file}`); process.exit(2); }

const MARKER = /^\(\s*(?:unconfirmed\s*,\s*)?(\d+)\s*(?:person|people)\s*\)/i;
const shortHash = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);
// Carriage returns are stripped before anything looks at the text. A reviewer edits this file on
// Windows, and a checkout without the right .gitattributes hands it back with CRLF endings — which
// made every state line fail to parse and the checker report an artifact with no contributor counts
// at all. It was reporting damage that was not there, on a file that was fine.
const text = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');

// Same tolerance as the aggregator: skip comment blocks without ever stopping, and never drop a
// bullet silently. Kept as its own copy so this check can run in a CI job that has nothing but
// the repo — no shared module, no install step.
function parse(src) {
  const entries = new Map();
  const notes = [];
  let section = null, inComment = false, order = 0;
  for (const raw of src.split('\n')) {
    const line = raw.trim();
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
    const key = id || `anon:${shortHash(bare)}`;
    if (entries.has(key)) notes.push(['dup', `two entries share the id ${key}`]);
    entries.set(key, { id, section, bare, count: mk ? mk[1] : null, unsure: mk ? /unconfirmed/i.test(mk[0]) : null, order: order++ });
  }
  if (inComment) notes.push(['comment', 'a comment block is never closed, so everything after it is ignored']);
  return { entries, notes };
}

function stateBlock(src) {
  const m = src.match(/<!--\s*knowledge-state([\s\S]*?)-->/i);
  if (!m) return null;
  const map = new Map();
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^\s*(k\d+)\s*:\s*(.*)$/);
    if (mm) map.set(mm[1], mm[2].split(',').map(s => s.trim()).filter(Boolean));
  }
  return map;
}

const { entries, notes } = parse(text);
const state = stateBlock(text);
const problems = [];
const warnings = [];

for (const [k, n] of notes) (k === 'dup' ? problems : warnings).push(n);

if (!state) {
  warnings.push('no <!-- knowledge-state --> block; contributor counts will be rebuilt from the ' +
                'event log, and until they are, no line can confirm itself');
} else {
  for (const id of state.keys()) {
    if (!entries.has(id)) problems.push(`state lists ${id} but no entry with that id is left in the file (orphan)`);
  }
  for (const e of entries.values()) {
    if (!e.id) continue;
    const s = state.get(e.id);
    if (!s) { warnings.push(`entry ${e.id} has no state line — the next run will give it one`); continue; }
    const distinct = new Set(s).size;
    if (e.count !== null && Number(e.count) !== distinct) {
      warnings.push(`entry ${e.id} reads (${e.count} ${e.count === '1' ? 'person' : 'people'}) but state holds ` +
                    `${distinct} — the human's number is kept, and the mismatch is reported in the next PR`);
    }
  }
}

// A marker-shaped opening that does not parse is an error, not a warning.
//
// Found by measuring the read path: an agent hit a trap firsthand, judged the entry deserved more
// confidence, and rewrote `(unconfirmed, 1 person)` to `(confirmed, 2 people)` — a format that does
// not exist — while the state block below still recorded one contributor. Read as "no marker" and
// reported as a warning, it left CI green on a file that now claimed two people to every teammate's
// agent. Anything that opens like a marker and is not one has to fail: a hand-written line with no
// marker at all is an ordinary work-in-progress, but a marker that lies is worse than none.
// "person"/"people" anywhere inside the leading parenthetical, not only at its end: `(2 people,
// confirmed)` claims two contributors just as loudly as `(confirmed, 2 people)` does, and an earlier
// version of this pattern let the reversed order through because it required the closing bracket
// immediately after the noun.
const MARKER_SHAPED = /^\(\s*[^)]{0,60}\bpe(?:rson|ople)\b[^)]{0,30}\)/i;

for (const [key, e] of entries) {
  if (!e.id) warnings.push(`entry has no id yet, one will be assigned on the next run: "${e.bare.slice(0, 56)}…"`);
  if (e.count === null) {
    if (MARKER_SHAPED.test(e.bare)) {
      problems.push(`entry ${key} opens with something marker-shaped that does not parse: ` +
        `"${(e.bare.match(MARKER_SHAPED) || [''])[0]}". The only valid forms are ` +
        `"(unconfirmed, 1 person)" and "(N people)". A count nobody can parse is a count nobody ` +
        `verified — if an agent wrote this, it promoted an entry on its own recognisance`);
    } else {
      warnings.push(`entry ${key} has no confidence marker, read as (unconfirmed, 1 person)`);
    }
  }
  if (!e.section) warnings.push(`entry ${key} sits outside every section`);
}

if (entries.size > cap) {
  problems.push(`${entries.size} content lines, over the cap of ${cap} — the next merge is forced to delete something`);
}

console.log(`${file}: ${entries.size} entries, ${state ? state.size : 0} state lines, cap ${cap}`);
for (const p of problems) console.log(`  ERROR    ${p}`);
for (const w of warnings) console.log(`  warning  ${w}`);
if (!problems.length && !warnings.length) console.log('  nothing to fix');

// Warnings are things the next run repairs by itself, so they must not fail the build; a reviewer
// who had to fix every one of those would be doing the machine's work.
process.exit(problems.length ? 1 : 0);
