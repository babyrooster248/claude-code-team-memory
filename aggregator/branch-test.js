// Checks which branch a proposal lands on, against real git repositories.
//
//   node aggregator/branch-test.js
//
// This exists because the decision it covers produced two wrong pull requests before anyone looked
// at it. Once a diff that added back an entire previous version of the project and deleted the
// current one — a branch left over from before the artifact repo's history was rewritten. Once a
// second request competing with the first over the same file, because the branch name carried the
// date and a new day made a new branch.
//
// Both were silent: the pipeline reported success, the push succeeded, and the damage was visible
// only to somebody who opened the request and read the diff.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pickBranch, publish, DEFAULT_BRANCH } = require('./branch');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-test-'));

let fails = 0;
let ran = 0;
const check = (name, got, want) => {
  const ok = got === want;
  ran++;
  if (!ok) fails++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(58)} → ${got} (want ${want})`);
};

// A clone with a real remote, so `fetch` and `merge-base` behave as they do in production.
function repo(name) {
  const remote = path.join(tmp, name + '-remote.git');
  const work = path.join(tmp, name);
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { encoding: 'utf8' });
  spawnSync('git', ['clone', '-q', remote, work], { encoding: 'utf8' });
  const g = (args, opts = {}) => spawnSync('git', ['-C', work, ...args],
    { encoding: 'utf8', ...opts });
  g(['config', 'user.name', 'test']);
  g(['config', 'user.email', 't@example.com']);
  fs.writeFileSync(path.join(work, 'AGENTS.md'), '# base\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'base']);
  g(['push', '-q', '-u', 'origin', 'main']);
  return { work, g };
}

const commit = (g, text, msg) => {
  fs.writeFileSync(path.join(g.work, 'AGENTS.md'), text);
  g.g(['add', '-A']);
  g.g(['commit', '-q', '-m', msg]);
};

// --- 1. nothing exists yet -------------------------------------------------------------------
{
  const r = repo('fresh');
  const out = pickBranch({ git: r.g });
  check('no branch yet → create', out.action, 'create');
  check('and it is the fixed name, not a dated one', out.branch, DEFAULT_BRANCH);
  check('name carries no date', /\d{4}-\d{2}-\d{2}/.test(out.branch), false);
}

// --- 2. an open proposal, base unchanged -----------------------------------------------------
//
// The case the user asked for: a request already open and unmerged, so the next run adds to it
// rather than opening a second one.
{
  const r = repo('open');
  pickBranch({ git: r.g });
  commit({ work: r.work, g: r.g }, '# base\n- proposed line\n', 'chore(agent-knowledge): first');
  r.g(['push', '-q', '-u', 'origin', DEFAULT_BRANCH]);
  r.g(['checkout', '-q', 'main']);

  const out = pickBranch({ git: r.g });
  check('open proposal on an unchanged base → continue', out.action, 'continue');
  const log = r.g(['log', '--oneline', 'main..' + DEFAULT_BRANCH]).stdout.trim().split('\n').filter(Boolean);
  check('the earlier proposal is still on it', log.length, 1);
  check('and it kept the proposed line', /proposed line/.test(fs.readFileSync(path.join(r.work, 'AGENTS.md'), 'utf8')), true);
}

// --- 3. main moved on ------------------------------------------------------------------------
//
// A reviewer merged something, or somebody committed to main directly. The branch is now based on
// a commit that is no longer the tip, and continuing it would propose a diff against the past.
{
  const r = repo('moved');
  pickBranch({ git: r.g });
  commit({ work: r.work, g: r.g }, '# base\n- old proposal\n', 'chore(agent-knowledge): old');
  r.g(['checkout', '-q', 'main']);
  commit({ work: r.work, g: r.g }, '# base\n- merged by a human\n', 'human edit on main');

  const out = pickBranch({ git: r.g });
  check('base moved past the branch → rebuild', out.action, 'rebuild');
  const ahead = r.g(['log', '--oneline', 'main..' + DEFAULT_BRANCH]).stdout.trim();
  check('branch now starts level with main', ahead, '');
  check("and carries main's content, not the stale proposal",
    /merged by a human/.test(fs.readFileSync(path.join(r.work, 'AGENTS.md'), 'utf8')), true);
}

// --- 4. history rewritten --------------------------------------------------------------------
//
// The one that produced the catastrophic diff. The branch's base no longer exists in main at all.
{
  const r = repo('rewritten');
  pickBranch({ git: r.g });
  commit({ work: r.work, g: r.g }, '# base\n- proposal on old history\n', 'chore(agent-knowledge): x');
  r.g(['checkout', '-q', 'main']);
  // Squash main to a single unrelated root, the way a repo gets reset before a demo.
  r.g(['checkout', '-q', '--orphan', 'fresh-start']);
  fs.writeFileSync(path.join(r.work, 'AGENTS.md'), '# rebuilt\n');
  r.g(['add', '-A']);
  r.g(['commit', '-q', '-m', 'rebuilt history']);
  r.g(['branch', '-q', '-M', 'main']);

  const out = pickBranch({ git: r.g });
  check('branch based on vanished history → rebuild', out.action, 'rebuild');
  const content = fs.readFileSync(path.join(r.work, 'AGENTS.md'), 'utf8');
  check('no trace of the old proposal', /proposal on old history/.test(content), false);
  check('and the diff against main is empty to start',
    r.g(['log', '--oneline', 'main..' + DEFAULT_BRANCH]).stdout.trim(), '');
}

// --- 5. the request is opened once, and only once ---------------------------------------------
//
// The other half of "at most one open request". With a fixed branch name, the second run pushes to a
// branch origin already has — and a forge command told to open a request for it would fail. Skipping
// it is the correct outcome, not an error to be tolerated.
{
  const r = repo('publish');
  const calls = [];
  const run = (cmd) => { calls.push(cmd); return { status: 0, stdout: 'created\n', stderr: '' }; };

  pickBranch({ git: r.g });
  commit({ work: r.work, g: r.g }, '# base\n- first\n', 'chore(agent-knowledge): first');
  const first = publish({ git: r.g, prCommand: 'fake-gh pr create --head BRANCH', run });
  check('first push of a new branch → open a request', first.state, 'opened');
  check('and BRANCH was substituted', calls[0], 'fake-gh pr create --head agent-knowledge');

  commit({ work: r.work, g: r.g }, '# base\n- first\n- second\n', 'chore(agent-knowledge): second');
  const second = publish({ git: r.g, prCommand: 'fake-gh pr create --head BRANCH', run });
  check('second push to the same branch → do NOT open another', second.state, 'updated-existing');
  check('the forge command ran exactly once, total', calls.length, 1);
  check('and the reason is in the log, not silent',
    second.log.some(l => /already on origin/.test(l)), true);
}

// --- 6. a rebuilt branch is still the same open request ---------------------------------------
{
  const r = repo('publish-rebuild');
  const calls = [];
  const run = (cmd) => { calls.push(cmd); return { status: 0, stdout: '', stderr: '' }; };

  pickBranch({ git: r.g });
  commit({ work: r.work, g: r.g }, '# base\n- old\n', 'chore(agent-knowledge): old');
  publish({ git: r.g, prCommand: 'fake-gh', run });
  r.g(['checkout', '-q', 'main']);
  commit({ work: r.work, g: r.g }, '# base\n- human\n', 'human edit');

  const out = pickBranch({ git: r.g });
  check('base moved → rebuild', out.action, 'rebuild');
  commit({ work: r.work, g: r.g }, '# base\n- human\n- fresh\n', 'chore(agent-knowledge): fresh');
  const pub = publish({ git: r.g, prCommand: 'fake-gh', run });
  check('force-push of a rebuilt branch still succeeds', pub.state, 'updated-existing');
  check('and STILL does not open a second request', calls.length, 1);
}

// --- 7. the forge command fails ----------------------------------------------------------------
//
// The one path nothing retries: the branch reached origin, so every later run correctly declines to
// open a request — for one that was never opened. The log has to say so.
{
  const r = repo('publish-fail');
  const run = () => ({ status: 1, stdout: '', stderr: 'gh: not authenticated\n' });
  pickBranch({ git: r.g });
  commit({ work: r.work, g: r.g }, '# base\n- x\n', 'chore(agent-knowledge): x');
  const out = publish({ git: r.g, prCommand: 'fake-gh', run });
  check('forge command failed → reported, not swallowed', out.state, 'pr-command-failed');
  check('log says the branch is pushed anyway',
    out.log.some(l => /branch IS pushed/.test(l)), true);
  check('log warns nothing will retry',
    out.log.some(l => /will not try again/.test(l)), true);
}

// --- 8. no remote at all -----------------------------------------------------------------------
//
// The host clone was local-only for a while, and a push failure there must not look like success.
{
  const work = path.join(tmp, 'no-remote');
  spawnSync('git', ['init', '-q', '-b', 'main', work], { encoding: 'utf8' });
  const g = (args, opts = {}) => spawnSync('git', ['-C', work, ...args], { encoding: 'utf8', ...opts });
  g(['config', 'user.name', 'test']); g(['config', 'user.email', 't@example.com']);
  fs.writeFileSync(path.join(work, 'AGENTS.md'), '# base\n');
  g(['add', '-A']); g(['commit', '-q', '-m', 'base']);
  let ran = false;
  const out = publish({ git: g, prCommand: 'fake-gh', run: () => { ran = true; return { status: 0 }; } });
  check('no origin → push-failed, reported', out.state, 'push-failed');
  check('and the forge command never ran', ran, false);
  check('the error text is carried, not dropped', out.error.length > 0, true);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails}/${ran} case(s) failed` : `\n${ran}/${ran} passed`);
process.exit(fails ? 1 : 0);
