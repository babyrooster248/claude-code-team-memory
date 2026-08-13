// Which branch a proposal goes on, and whether an open one is continued or rebuilt.
//
// Extracted from aggregate.js so it can be tested without a model. It is nine lines of decision that
// twice produced a wrong pull request: once a diff that added back an entire previous version of the
// project, once a second request competing with the first over the same file. Both were only noticed
// because somebody asked why the pull request looked strange.
//
// The rule: one branch name for the life of the repository, so there is at most one open request for
// the artifact. Whether to keep what is on it turns on a single question — is it still based on the
// commit we are proposing against?
//
//   still on top of the base   continue it, and the open request grows
//   the base has moved past it  rebuild from the base
//
// Rebuilding costs no content, because every run writes the WHOLE artifact. What it does not carry is
// an edit a reviewer pushed to the branch without merging: the merge pass reads the base, so such an
// edit was already invisible to it. Reviewer edits belong in the merge.

const DEFAULT_BRANCH = 'agent-knowledge';

function pickBranch({ git, branch = DEFAULT_BRANCH, base = 'HEAD' }) {
  git(['fetch', '--quiet', 'origin'], { probe: true });

  const baseSha = git(['rev-parse', base]).stdout.trim();
  const exists = git(['rev-parse', '--verify', '--quiet', branch], { probe: true }).status === 0;
  const onTopOfBase = exists &&
    git(['merge-base', '--is-ancestor', baseSha, branch], { probe: true }).status === 0;

  if (onTopOfBase) {
    git(['checkout', branch]);
    return { branch, action: 'continue' };
  }

  git(['checkout', '-B', branch]);
  return { branch, action: exists ? 'rebuild' : 'create' };
}

// Getting the commit off the host and, if the team asked for it, opening the request.
//
// Same rule as pickBranch, second half of it: at most one open request for the artifact. Whether to
// open one turns on whether origin ALREADY had this branch before this push — asked before pushing,
// because afterwards the answer is always yes. Origin had it, so the request for it either exists or
// a person saw it and chose not to open one; this run's job was to add a commit to it.
//
// Git answers that without knowing what a forge is. Asking the forge "is a request open?" would need
// the API this project deliberately never calls, and the reason it runs on any git host.
//
// Returns lines to print and a `state` a caller — or a test — can assert on, rather than printing:
// the decision is the thing worth checking, and it used to be buried in console.log.
function publish({ git, prCommand = null, run = null, cwd = null }) {
  const log = [];
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  const remoteHad = git(['ls-remote', '--exit-code', 'origin', 'refs/heads/' + branch],
    { probe: true }).status === 0;

  // --force-with-lease because the branch is reset to the base whenever the base moved, so its remote
  // copy legitimately diverges. Lease rather than plain force: if somebody else pushed to that branch
  // meanwhile, this fails loudly instead of overwriting them.
  const p = git(['push', '--force-with-lease', '--set-upstream', 'origin', branch], { probe: true });
  if (p.status !== 0) {
    return { state: 'push-failed', branch, log,
      error: (p.stderr || p.stdout || '').trim().split('\n').slice(-2).join(' ') };
  }
  log.push(`pushed ${branch} to origin`);

  // Forges print "create a pull request by visiting …" on the push itself, so the link comes free —
  // no API call, no forge-specific token, and on a git host with no web interface there is simply no
  // line to find. Reading it out of the push output rather than building it keeps this ignorant of
  // which forge is on the far end.
  const urls = ((p.stderr || '') + (p.stdout || '')).match(/https?:\/\/\S+/g);
  const url = urls ? urls[urls.length - 1] : null;
  if (url) log.push(`open a pull request:\n  ${url}`);

  if (!prCommand) return { state: 'pushed', branch, url, log };
  if (remoteHad) {
    log.push(`${branch} was already on origin — updated the open request rather than opening a second`);
    return { state: 'updated-existing', branch, url, log };
  }

  const cmd = prCommand.replace(/\bBRANCH\b/g, branch);
  log.push(`running prCommand: ${cmd}`);
  const r = run(cmd, cwd);
  const out = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-3).join('\n');
  if (r.status === 0) {
    log.push(`  prCommand ok${out ? '\n  ' + out : ''}`);
    return { state: 'opened', branch, url, log };
  }
  // Loud, because this is the one path where nothing retries: origin has the branch now, so the next
  // run will see remoteHad and correctly decline to open a request — for one that was never opened.
  log.push(`  prCommand FAILED (exit ${r.status}) — the branch IS pushed, but no request was opened,\n` +
           `  and later runs will not try again because the branch now exists on origin.\n` +
           `  Open it by hand${url ? `: ${url}` : ''}\n  ${out}`);
  return { state: 'pr-command-failed', branch, url, log };
}

module.exports = { pickBranch, publish, DEFAULT_BRANCH };
