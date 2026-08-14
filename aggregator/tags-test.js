// Does the tag-reassignment detector fire on the real case, and stay quiet on the legitimate ones?
//
//   node aggregator/tags-test.js
//
// The fixtures at the bottom are lifted verbatim from the run that exposed this: `[k6]` named the
// id-uniqueness fact on main, and came back from the merge naming a different fact entirely.
const { findReassigned, tagMap, similarity } = require('./tags');

let fails = 0, ran = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ran++; if (!ok) fails++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(56)} → ${JSON.stringify(got)} (want ${JSON.stringify(want)})`);
};

const HEAD = `<!-- Maintained by claude-code-team-memory. -->\n\n## Traps\n`;
const state = tags => `\n<!-- knowledge-state\n${tags.map(t => t + ': aaaa1111').join('\n')}\n-->\n`;

// --- the observed failure ---------------------------------------------------------------------
{
  const before = HEAD +
    `- (3 people) Nothing checks item-id uniqueness — no schema, no id index in \`lib.js\`. [k6]\n` +
    state(['k6']);
  const after = HEAD +
    `- (unconfirmed, 1 person) \`data/catalog.json\` is a shared external key space, not a repo fixture — the warehouse references item ids. [k6]\n` +
    `- (3 people) Nothing checks that item \`id\`s in \`data/catalog.json\` are unique — no schema, no id index in \`lib.js\`. [k7]\n` +
    state(['k6', 'k7']);
  const moved = findReassigned(before, after);
  check('the real case is caught', moved.map(m => `${m.from}->${m.to}`), ['k6->k7']);
}

// --- sharpening in place, which the merge is supposed to do -----------------------------------
{
  const before = HEAD + `- (2 people) Nothing filters active anywhere; report lists all six items. [k1]\n` + state(['k1']);
  const after = HEAD +
    `- (3 people) Nothing filters \`active: false\` anywhere. \`report\` lists all six items when four are live, and an inactive category does not hide its items either. [k1]\n` +
    state(['k1']);
  check('a sharpened entry is not a reassignment', findReassigned(before, after), []);
}

// --- a promotion, the auto-apply path ---------------------------------------------------------
{
  const line = 'Prices are stored as integer VND, never decimals.';
  const before = HEAD + `- (unconfirmed, 1 person) ${line} [k2]\n` + state(['k2']);
  const after = HEAD + `- (2 people) ${line} [k2]\n` + state(['k2']);
  check('a marker change alone is not a reassignment', findReassigned(before, after), []);
  check('and the marker is stripped before comparing', tagMap(after).get('k2'), line);
}

// --- an ordinary addition ---------------------------------------------------------------------
{
  const before = HEAD + `- (2 people) Prices are integer VND. [k2]\n` + state(['k2']);
  const after = HEAD +
    `- (2 people) Prices are integer VND. [k2]\n` +
    `- (unconfirmed, 1 person) CSV for finance must be semicolon-delimited. [k5]\n` +
    state(['k2', 'k5']);
  check('adding an entry moves nothing', findReassigned(before, after), []);
}

// --- a reviewer deleted an entry --------------------------------------------------------------
{
  const before = HEAD + `- (1 person) Prices are integer VND. [k2]\n- (1 person) CSV uses semicolons. [k5]\n` + state(['k2', 'k5']);
  const after = HEAD + `- (1 person) Prices are integer VND. [k2]\n` + state(['k2']);
  check('a deletion is not reported as a move', findReassigned(before, after), []);
}

// --- two entries that merely resemble each other ----------------------------------------------
//
// Both mention the same file and the same field. Only a real swap should fire, or the check becomes
// noise and gets ignored — which is worse than not having it.
{
  const before = HEAD +
    `- (1 person) \`update.js\` rewrites the whole of \`data/catalog.json\` on every call. [k4]\n` +
    `- (1 person) \`cleanup.js\` rewrites the whole of \`data/catalog.json\` and drops rows. [k8]\n` +
    state(['k4', 'k8']);
  const after = HEAD +
    `- (2 people) \`update.js\` rewrites the whole of \`data/catalog.json\` on every call, so concurrent edits lose one. [k4]\n` +
    `- (1 person) \`cleanup.js\` rewrites the whole of \`data/catalog.json\` and drops rows. [k8]\n` +
    state(['k4', 'k8']);
  check('similar-but-distinct entries do not trip it', findReassigned(before, after), []);
}

// --- an outright swap of two established entries ----------------------------------------------
{
  const A = 'Commit messages follow conventional commits and CI rejects anything else.';
  const B = 'Prices are stored as integer VND, never decimals, and formatting divides at the edge.';
  const before = HEAD + `- (3 people) ${A} [k3]\n- (2 people) ${B} [k2]\n` + state(['k3', 'k2']);
  const after = HEAD + `- (3 people) ${B} [k3]\n- (2 people) ${A} [k2]\n` + state(['k3', 'k2']);
  const moved = findReassigned(before, after).map(m => `${m.from}->${m.to}`).sort();
  check('a straight swap is caught in both directions', moved, ['k2->k3', 'k3->k2']);
}

// --- the first file, nothing to compare against -----------------------------------------------
{
  check('an empty base reports nothing', findReassigned('', HEAD + `- (1 person) x. [k1]\n`), []);
}

// --- similarity behaves ------------------------------------------------------------------------
{
  check('identical text scores 1', similarity('a b c', 'c b a'), 1);
  check('nothing in common scores 0', similarity('alpha beta', 'gamma delta'), 0);
}

console.log(fails ? `\n${fails}/${ran} case(s) failed` : `\n${ran}/${ran} passed`);
process.exit(fails ? 1 : 0);
