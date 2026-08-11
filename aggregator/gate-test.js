// Exercises the auto-apply guard directly. The point of the guard is that it does not depend on
// the model labelling its own change honestly, so it deserves a test that does not depend on the
// model misbehaving on cue.
//
// It doubles as the safety net for hand-edit tolerance: a reviewer's edits land on this same
// parser and classifier, so loosening the parser has to leave every line below green.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const src = fs.readFileSync(path.join(__dirname, 'aggregate.js'), 'utf8');
eval(src.slice(src.indexOf('// This file is edited by hand'), src.indexOf('const gate = classify')));
const MARKER = /^\(\s*(?:unconfirmed\s*,\s*)?(\d+)\s*(?:person|people)\s*\)/i;
const shortHash = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);

// Two sections, so that moving an entry between them is distinguishable from renaming one.
const base = `## Traps
- (unconfirmed, 1 person) seed.js FK error means schema.json is missing. Run migrate.js first. [k1]
- (2 people) No HasQueryFilter anywhere: filter IsActive by hand. [k2]

## Boundaries
- (2 people) Tenants.PrimaryLocale governs API content, not Locales.IsDefault. [k3]

<!-- knowledge-state
k1: aaaa1111
k2: bbbb2222, cccc3333
k3: bbbb2222, dddd4444
-->`;

const K1 = '- (unconfirmed, 1 person) seed.js FK error means schema.json is missing. Run migrate.js first. [k1]';
const promote = s => s.replace('(unconfirmed, 1 person)', '(2 people)');

const cases = [
  ['marker changed, text identical', promote(base), true],
  ['count rises 2 to 3', base.replace('(2 people) No HasQueryFilter', '(3 people) No HasQueryFilter'), true],

  ['reworded while changing the marker', base.replace(
    '(unconfirmed, 1 person) seed.js FK error means schema.json is missing. Run migrate.js first.',
    '(2 people) seed.js FK error means schema.json is missing — run migrate.js first.'), false],

  // A genuine move: k1 leaves Traps for Boundaries while both sections still exist.
  ['entry moved between existing sections', base
    .replace(K1 + '\n', '')
    .replace('## Boundaries\n', '## Boundaries\n' + K1 + '\n'), false],

  ['new entry added', base.replace('<!-- knowledge-state',
    '- (unconfirmed, 1 person) Something new entirely. [k9]\n\n<!-- knowledge-state'), false],
  ['entry removed', base.replace('- (2 people) No HasQueryFilter anywhere: filter IsActive by hand. [k2]\n', ''), false],
  ['dropped back to unconfirmed', base.replace('(2 people) No HasQueryFilter', '(unconfirmed, 1 person) No HasQueryFilter'), false],
  ['nothing changed', base, false],

  // --- what a reviewer actually does to the file ---

  // The old parser stopped at the first comment, so everything below it vanished and the change
  // read as a mass deletion. A lead leaving a note for a lead must not do that.
  ['comment mid-file, plus a marker change', promote(base).replace('## Boundaries',
    '<!-- TODO: revisit this section after the sprint -->\n## Boundaries'), true],

  ['multi-line comment mid-file, plus a marker change', promote(base).replace('## Boundaries',
    '<!--\n  ask Minh whether the line below still holds\n-->\n## Boundaries'), true],

  // Renaming a section, or translating the file, moves nothing. The second case renames into
  // Vietnamese on purpose: the tooling is English, but the artifact belongs to the team that
  // reads it, and the parser treats any `##` heading as a section precisely so a team can write
  // those headings in their own language without the machine noticing.
  ['section renamed, plus a marker change', promote(base).replace('## Traps', '## Pitfalls'), true],
  ['sections renamed into another language', promote(base)
    .replace('## Traps', '## Bẫy').replace('## Boundaries', '## Ranh giới'), true],

  // Dropping an id while rewording is a text change either way; it must never slip through.
  ['reworded and the id dropped', base.replace(K1,
    '- (unconfirmed, 1 person) seed.js FK error really means the schema file is missing.'), false],

  // A hand-written line with neither id nor marker is a new entry, and needs a person.
  ['hand-written line, no id and no marker', base.replace('<!-- knowledge-state',
    '- Staging DB is a restored prod snapshot, so do not trust its row counts.\n\n<!-- knowledge-state'), false],

  // Deleting the state block loses who confirmed what, but must not lose an entry.
  ['knowledge-state block deleted, plus a marker change',
    promote(base).replace(/<!-- knowledge-state[\s\S]*?-->/, ''), true],
];

let bad = 0;
for (const [label, after, wantAuto] of cases) {
  const r = classify(base, after);
  const ok = r.auto === wantAuto;
  if (!ok) bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(42)} -> ${r.auto ? 'AUTO ' : 'HUMAN'}  (${r.why})`);
}

// The parser must also report what it had to tolerate, so the validator can surface it.
const damaged = `## Traps
- (2 people) an entry with an id [k1]
- an entry with neither id nor marker
<!-- TODO unclosed comment
- (2 people) hidden by the unclosed comment [k2]`;
const { entries, warnings } = parseEntries(damaged);
const reported = warnings.length >= 3 && entries.size === 2;
if (!reported) bad++;
console.log(`  ${reported ? 'ok  ' : 'FAIL'} ${'parser reports what it tolerated'.padEnd(42)} -> ${entries.size} entries, ${warnings.length} warnings`);

console.log(bad ? `\n${bad} case(s) failed` : `\n${cases.length + 1}/${cases.length + 1} passed`);
process.exit(bad ? 1 : 0);
