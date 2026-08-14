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

// Which branch a proposal is measured AGAINST — and the reason this is a function rather than the
// word "HEAD".
//
// A run leaves the clone checked out on the proposal branch. Taking HEAD as the base then means the
// next run proposes against the previous proposal instead of against main, and the consequence is
// exactly the one the whole pull-before-running design exists to prevent: a reviewer deletes a line
// in the pull request and merges, main now lacks it, but the host clone is still sitting on the
// branch that has it — so the next run reads the line from there and proposes it again. The reviewer
// sees a machine re-asking a question they already answered, which is how a pipeline gets muted.
//
// So: the base is the branch the proposal targets, never whatever HEAD happens to be. Asked of
// origin, because that is what a pull request is opened against.
function resolveBase({ git, branch = DEFAULT_BRANCH }) {
  const head = git(['rev-parse', '--abbrev-ref', 'HEAD'], { probe: true }).stdout.trim();
  if (head && head !== branch && head !== 'HEAD') return head;

  // HEAD is the proposal branch — a previous run left it there, or crashed there. Ask origin what it
  // considers default.
  const sym = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { probe: true });
  if (sym.status === 0) {
    const b = sym.stdout.trim().replace(/^origin\//, '');
    if (b && b !== branch) return b;
  }
  // A clone with no origin, or one that never fetched a default. Take the first ordinary branch that
  // is not the proposal; guessing "main" would be wrong on every repository that says master.
  const all = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], { probe: true })
    .stdout.split('\n').map(s => s.trim()).filter(s => s && s !== branch);
  return all[0] || 'main';
}

function pickBranch({ git, branch = DEFAULT_BRANCH, base = null }) {
  git(['fetch', '--quiet', 'origin'], { probe: true });
  base = base || resolveBase({ git, branch });

  const baseSha = git(['rev-parse', base]).stdout.trim();
  const exists = git(['rev-parse', '--verify', '--quiet', branch], { probe: true }).status === 0;
  const onTopOfBase = exists &&
    git(['merge-base', '--is-ancestor', baseSha, branch], { probe: true }).status === 0;

  if (onTopOfBase) {
    git(['checkout', branch]);
    return { branch, base, action: 'continue' };
  }

  git(['checkout', '-B', branch, base]);
  return { branch, base, action: exists ? 'rebuild' : 'create' };
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
function publish({ git, base = null, prCommand = null, run = null, cwd = null }) {
  const log = [];
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  base = base || resolveBase({ git, branch });
  git(['fetch', '--quiet', 'origin'], { probe: true });

  // Is a request still open for this branch? The tempting question — "does origin already have the
  // branch?" — gives the wrong answer the moment somebody merges: forges keep the head branch unless
  // told to delete it, so origin still has it, and answering yes means declining to open a request
  // for a proposal whose request is merged and closed. The proposal then sits on a pushed branch that
  // nobody is looking at, and nothing anywhere says so.
  //
  // Git can tell the difference without being asked about requests at all: if origin's copy of the
  // branch is already contained in the base, whatever request carried it has landed.
  //
  //   not on origin                      new proposal            open a request
  //   on origin, contained in the base   its request was merged  open a request
  //   on origin, ahead of the base       its request is open     add a commit to that one
  //
  // The third line covers the case where the base moved because somebody pushed to it directly: the
  // branch gets rebuilt and force-pushed, and the request already open for it simply updates.
  const remoteRef = 'refs/remotes/origin/' + branch;
  const onRemote = git(['rev-parse', '--verify', '--quiet', remoteRef], { probe: true }).status === 0;
  const baseRef = git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/' + base],
    { probe: true }).status === 0 ? 'refs/remotes/origin/' + base : base;
  const landed = onRemote &&
    git(['merge-base', '--is-ancestor', remoteRef, baseRef], { probe: true }).status === 0;
  // Committing onto the base itself is the auto-applied path. There is nothing to review, so there is
  // nothing to open.
  const requestStillOpen = branch === base || (onRemote && !landed);

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
  if (requestStillOpen) {
    log.push(`${branch} still has commits ${base} does not — added to the open request rather than ` +
             `opening a second`);
    return { state: 'updated-existing', branch, url, log };
  }
  if (landed) {
    log.push(`the previous proposal on ${branch} was merged into ${base} — opening a fresh request`);
  }

  const cmd = prCommand.replace(/\bBRANCH\b/g, branch);
  log.push(`running prCommand: ${cmd}`);
  const r = run(cmd, cwd);
  const out = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-3).join('\n');
  if (r.status === 0) {
    log.push(`  prCommand ok${out ? '\n  ' + out : ''}`);
    return { state: 'opened', branch, url, log };
  }
  // Loud, because this is the one path where nothing retries: the branch is on origin with commits
  // the base does not have, so the next run reads that as "a request is open for this" and correctly
  // declines to open one — for a request that was never opened.
  log.push(`  prCommand FAILED (exit ${r.status}) — the branch IS pushed, but no request was opened,\n` +
           `  and later runs will not try again because the branch now exists on origin.\n` +
           `  Open it by hand${url ? `: ${url}` : ''}\n  ${out}`);
  return { state: 'pr-command-failed', branch, url, log };
}

// Leave the clone where the next run needs to find it: on the base, not on the proposal.
//
// This is not tidiness. The trigger runs `git pull --ff-only` before every run, and a pull is against
// whatever is checked out — so a clone resting on the proposal branch pulls the proposal, never sees
// that main moved, and proposes against its own last output. Called after the push, and the failure
// is loud rather than fatal, because the proposal is already safely on origin by then.
function restoreBase({ git, base }) {
  const r = git(['checkout', base], { probe: true });
  return r.status === 0 ? null
    : `could not return the clone to ${base}: ${(r.stderr || r.stdout || '').trim().split('\n')[0]}`;
}

module.exports = { pickBranch, publish, resolveBase, restoreBase, DEFAULT_BRANCH };
