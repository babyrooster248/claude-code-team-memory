// Checks that check-artifact.js fails the build on the damage that matters and passes on the rest.
//
//   node aggregator/artifact-check-test.js
//
// It runs in CI on the pull request, so a regression here does not break anything visibly — it just
// stops failing, and a corrupted artifact walks through a green check. The marker cases are the
// reason this file exists: they came from watching a real agent rewrite a confidence marker on its
// own recognisance, which the checker read as "no marker" and reported as a warning.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-check-'));
const CHECK = path.join(__dirname, 'check-artifact.js');

const HEAD = '<!-- Maintained by claude-code-team-memory. -->\n\n## Traps\n';
const STATE = id => `\n<!-- knowledge-state\n${id}: f7e188d6\n-->\n`;
const entry = (marker, id) => `- ${marker} \`node seed.js\` prints a misleading FK error. [${id}]\n`;

const run = (body) => {
  const f = path.join(tmp, 'a-' + Math.random().toString(36).slice(2) + '.md');
  fs.writeFileSync(f, body);
  const r = spawnSync(process.execPath, [CHECK, f], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};

let fails = 0;
let ran = 0;
const check = (name, got, want) => {
  const ok = got === want;
  ran++;
  if (!ok) fails++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(58)} → ${got} (want ${want})`);
};

// Healthy files must not fail, or the check gets switched off by whoever it annoys first.
check('valid (unconfirmed, 1 person)',
  run(HEAD + entry('(unconfirmed, 1 person)', 'k1') + STATE('k1')).code, 0);
check('valid (3 people)',
  run(HEAD + entry('(3 people)', 'k1') + STATE('k1')).code, 0);

// A human jotting a line with no marker is ordinary work in progress: warn, do not fail.
const noMarker = run(HEAD + '- seed.js prints a misleading FK error. [k1]\n' + STATE('k1'));
check('no marker at all is a warning, not an error', noMarker.code, 0);
check('and it says so', /no confidence marker/.test(noMarker.out), true);

// The case that started this: marker-shaped, unparseable, and it silently claimed two people.
const invented = run(HEAD + entry('(confirmed, 2 people)', 'k1') + STATE('k1'));
check('invented marker format is an ERROR', invented.code, 1);
check('and the message names what it found', /\(confirmed, 2 people\)/.test(invented.out), true);
check('and says a count nobody can parse is unverified', /nobody verified/.test(invented.out), true);

for (const bad of ['(verified, 4 people)', '(2 people, confirmed)', '(likely 2 people)']) {
  check(`marker-shaped "${bad}" is an ERROR`,
    run(HEAD + entry(bad, 'k1') + STATE('k1')).code, 1);
}

// An orphaned state line is real damage: the count exists with nothing to attach it to.
check('state line with no entry is an ERROR',
  run(HEAD + entry('(2 people)', 'k1') + `\n<!-- knowledge-state\nk1: aaaa1111\nk9: bbbb2222\n-->\n`).code, 1);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails}/${ran} case(s) failed` : `\n${ran}/${ran} passed`);
process.exit(fails ? 1 : 0);
