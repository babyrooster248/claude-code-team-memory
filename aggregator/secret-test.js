// Checks the deterministic secret scan at the endpoint.
//
//   node aggregator/secret-test.js
//
// Why this is not left to the intake filter: the filter is a model at 94% precision, and its
// usual mistake — a mildly useless line reaching the file — costs a little context. This
// mistake costs a rotated credential and a rewritten git history, because the artifact is
// committed. The cheap certain check runs first, and it has to be tested against real-looking
// secrets rather than assumed correct.
//
// The false-positive cases matter just as much: a scan that refuses ordinary notes teaches
// people the pipeline is broken, and the notes that mention passwords are often exactly the
// security traps worth keeping.

const { spawnSync } = require('child_process');
const path = require('path');

// Load the patterns straight out of ingest.js so the test cannot drift from the shipped rule.
const src = require('fs').readFileSync(path.join(__dirname, 'ingest.js'), 'utf8');
const start = src.indexOf('const SECRET_PATTERNS');
const end = src.indexOf('const slug =');
eval(src.slice(start, end));

// Every credential-shaped fixture below is split across a concatenation. The values are
// invented, but no scanner can tell invented from real: GitHub push protection rejected this
// file over the Slack line, whose format carries no checksum to fail. Splitting keeps the
// literal out of the file bytes while findSecret() still receives the identical assembled
// string — so the test is unchanged and a fork is not blocked from pushing.
const MUST_REFUSE = [
  ['AWS key', 'Deploy uses AKIA' + 'IOSFODNN7EXAMPLE for the uploader.'],
  ['GitHub token', 'CI token is ghp' + '_1234567890abcdefghijklmnopqrstuvwxyz for the release job.'],
  ['fine-grained PAT', 'Use github' + '_pat_11ABCDEFG0aBcDeFgHiJkLmNoPqRsTuVwXyZ01234567 in the runner.'],
  ['Slack token', 'Webhook bot uses xoxb' + '-2401234567-abcdefghijklmnop for alerts.'],
  ['private key', 'Signing key:\n-----BEGIN RSA PRIVATE' + ' KEY-----\nMIIEowIB\n'],
  ['JWT', 'Sample token: eyJ' + 'hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27u'],
  ['DB url with password', 'UAT connection: postgres://appuser:' + 'Str0ngPass@db.internal:5432/catalog'],
  ['password assignment', 'Admin login for UAT: password = Admin@86042917'],
  ['api key assignment', 'Set api_key: 7f3a9c21b4e10d889a2c5f60 in the local env.'],
  // Verbatim from eval/cases.jsonl, and it caught this test lying. The version that used to
  // live here had `password=Admin@740211` appended, which is what made it pass — a doctored
  // fixture dressed as real data. The actual note is Vietnamese prose with no assignment and
  // no recognisable key format, so nothing here matched it and nothing would have. That is
  // where the password-shape check came from.
  ['real eval case, verbatim', 'Tai khoan admin local la Admin@740211, tren UAT la Admin@86042917.'],
  ['password in English prose', 'The staging login is Str0ng!Pass for the shared account.'],
];

// Notes that talk about credentials without containing one. Refusing these would be worse
// than useless: several are the security traps most worth keeping.
const MUST_PASS = [
  ['trap about credentials', 'Redeploy does NOT lose the PayOS credentials — measured 2026-08-10, the old warning is stale.'],
  ['placeholder', 'Set password = <your-password> in .env.local before running seed.'],
  ['env var name only', 'The worker needs API_KEY and CLIENT_SECRET exported; both come from the vault, never from .env.'],
  ['policy line', 'Never put a password or token in a committed file — CI rejects the push.'],
  ['the FK trap', 'seed.js prints a FOREIGN KEY error when .state/schema.json is missing. Run migrate.js first.'],
  ['module boundary', 'Tenants.PrimaryLocale governs API content, not Locales.IsDefault.'],
  ['short assignment', 'Set debug = 1 to see the resolver trace.'],
  // The password-shape check earns its keep only if it leaves these alone. Every one of them is
  // a string that actually appears in notes from a real project.
  ['npm scope with a digit', 'Add @types/node2 to devDependencies before building.'],
  ['scoped plugin name', 'Install @anthropic-ai/claude-code2 globally to reproduce.'],
  ['version string', 'Claude Code v2.1.226 changed the hook payload shape.'],
  ['email with digits', 'Ask member24081998@example.com which site owns that row.'],
  ['kubernetes name', 'Deploy to k8s-prod-2 only after the migration has run.'],
  ['relative state path', '.state/schema.json is missing whenever seed.js reports FK failure.'],
  ['internal URL, no creds', 'API UAT is https://stage-portal-api.internal.example/v1'],
  ['hex state ids', 'Entry k1 state reads aaaa1111, bbbb2222 after the merge.'],
];

let fails = 0;
console.log('  --- must be REFUSED ---');
for (const [label, text] of MUST_REFUSE) {
  const hit = findSecret(text);
  if (!hit) { fails++; console.log(`  FAIL ${label.padEnd(22)} → SLIPPED THROUGH`); }
  else console.log(`  ok   ${label.padEnd(22)} → ${hit}`);
}
console.log('  --- must PASS ---');
for (const [label, text] of MUST_PASS) {
  const hit = findSecret(text);
  if (hit) { fails++; console.log(`  FAIL ${label.padEnd(22)} → false positive (${hit})`); }
  else console.log(`  ok   ${label.padEnd(22)} → pass`);
}

const total = MUST_REFUSE.length + MUST_PASS.length;
console.log(fails ? `\n${fails}/${total} case(s) failed` : `\n${total}/${total} passed`);
process.exit(fails ? 1 : 0);
