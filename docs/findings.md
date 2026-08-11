# Measurements

Everything here was measured against `claude` 2.1.226 on Windows, using real
project memory from a six-month codebase plus purpose-built sandboxes. Designs that
failed are kept because "what was tried and abandoned" is exactly the kind of
knowledge this project exists to preserve.

## 1. Agents do not save knowledge unless told to

A/B over 5 sessions. Same sandbox, same hidden trap (a seed script that prints a
bogus foreign-key error when a migration step was skipped), same prompt. The only
difference was five lines in `CLAUDE.md` telling the agent when to record a memory.

| Arm | Sessions that wrote a memory |
| --- | --- |
| no instruction | **0 / 3** |
| 5-line instruction | **2 / 2** |

The baseline arm hit the trap all three times, solved it, and left with nothing.
The instruction works, so no enforcement hook is needed — `CLAUDE.md` is context
rather than enforced configuration, but instructing the *agent* is categorically
more reliable than relying on a person to remember.

Two side observations. On a later run the instructed agent read its existing notes
and explicitly declined to write anything new, saying both notes already covered
what the run exercised: the sprawl control is partly intrinsic. But that same run
also *acted on* a contaminated note, so junk does not merely take up space — it
steers behaviour.

## 2. One note in three is machine-local contamination

Of three notes the instructed arm produced, two were genuine project knowledge (a
trap in the code; a working-directory requirement of the scripts) and one was about
the agent's own harness — which tool got blocked and what to use instead. That
would be noise or actively wrong for a teammate with different settings.

Filtering environment from codebase is therefore a requirement of the aggregator,
not an optimisation.

## 3. The intake filter: 96.6% accuracy, no junk through

Current figures, 29 labelled cases drawn from a real project's memory directory and from the
sandbox, majority of three votes, small model:

| | |
| --- | --- |
| accuracy | **96.6%** |
| precision | **100%** — nothing that reaches the file is junk |
| recall | **94.4%** |
| junk let through | **0** |
| knowledge lost | **1** — `pref-01`, the documented limitation below |

The single miss is a commit-message convention, and it is left in the set labelled `keep` on
purpose so that the limitation shows up in the numbers rather than being relabelled away. A
second case of the same class, `pref-02`, splits its votes rather than failing outright, which
says the model finds this class genuinely borderline rather than reliably wrong.

The history below is kept because two rounds of it went backwards, and the record of how is
worth more than the final figure.

### How it got here

The first version scored this, over 28 cases, before the set grew:

| | 1 vote | 3 votes |
| --- | --- | --- |
| accuracy | 89.3% | **92.9%** |
| precision | 93.8% | **94.1%** |
| recall | 88.2% | **94.1%** |

Majority voting buys about 3.6 points, mostly in recall, and costs almost nothing — a small
model runs the same tiny prompt three times, so it is the cheapest accuracy available here.

Iterating stopped when the *identity* of the failing cases started changing between
runs while the aggregate stayed flat. That is the signal that further tuning is
fitting noise in 28 cases.

Re-run after the transport was rebuilt around the hook: **92.9 / 94.1 / 94.1 again,
failing on the same two cases.** The set of cases whose votes split across runs did
move (`proj-04`, `proj-05`, `proj-19` rather than `proj-04`, `force-03`), which is
the same boundary noise as before and not a change in behaviour. Replacing the whole
delivery path left the judgement untouched, which is what should happen — and is worth
re-checking on every change, because a filter quietly getting worse looks like nothing
at all.

## 4. OTel cannot carry note content

`tool_input` is truncated on the wire, not merely in the console exporter.

| Write declared | Arrived at a real OTLP endpoint |
| --- | --- |
| 8 918 bytes | 300 characters |
| 2 360 bytes, with `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH=262144` | 303 characters |

Raising the content-length variable changes nothing: `tool_input` has its own cap
(documented as "individual values over 512 characters are truncated, payload
bounded to ~4K"). The one path that would carry content, `OTEL_LOG_RAW_API_BODIES`,
ships the entire conversation history on every request — O(n²) volume and maximal
exposure. Not recommended.

What OTel *does* carry intact: `file_path` (it precedes content in the JSON),
`user.email`, `session.id`, `event.timestamp`. That is an index, and it is enough
for attribution, for triggering, and for the one signal git cannot produce — a
session that generated no knowledge at all.

Collector-side filtering was verified on real output: 94 log records in, 4 memory
writes kept, 90 dropped at ingest. Broad capture at the source, narrow retention.

## 5. The transport: a PostToolUse hook, measured

The requirement that decided this was not throughput or privacy. It was that no step
may depend on a member having set something up. Notes therefore leave the machine
over an ordinary HTTP POST to an internal endpoint, fired by a `PostToolUse` hook
matching `Write|Edit` whose configuration is committed in the project.

**The gating question was truncation**, because that is what killed the OTel route.
The docs cap hook *output* at 10 000 characters and say nothing about input, so it
had to be measured: an agent was made to write a 200-line memory note, and the hook
payload was compared against the file on disk.

| | |
| --- | --- |
| Note on disk | 19 686 bytes |
| POST body on the wire | 20 180 bytes |
| Content received by the endpoint | **19 686 bytes, byte-identical** |

No truncation, and the last line of 200 arrived intact. Hook payloads are not
subject to the ~300-character `tool_input` cap that telemetry imposes.

One real difference showed up between the payload and the file: Claude Code enriches
a memory file's frontmatter *after* the write, adding `node_type`, `originSessionId`
and `modified`. The hook sees the note as the model wrote it, without those. That
costs nothing here — timestamp, session and author all come from the transport — but
it is worth knowing that the payload is not always what is on disk.

Cost, measured over five runs: about 160 ms for a note inside the memory directory,
and roughly 100 ms of node startup on every other `Write` or `Edit`, where the hook
exits after a single string comparison.

Failure behaviour, all verified:

| Situation | What happens |
| --- | --- |
| Endpoint unreachable | note spooled locally, delivered at the next `SessionStart`, spool emptied |
| `user.email` not configured | not sent, and the log says it is that member's config |
| cwd unusable by git | not sent, and the log says this disables *every* note on the machine |
| Payload not parseable | not sent, and it is logged |
| `MEMORY.md` written | refused by the endpoint — a personal index, not knowledge |

Those last three each began as a silent exit. Every one of them would have switched
the pipeline off while leaving all logs clean, and the middle one was mislabelled as
a machine-wide git failure when it was only an unset config key — a message that
would have sent whoever read it hunting the wrong problem.

A fifth was worse, and it was self-inflicted. The hook originally decided what counted
as a note by matching a literal `memory` path segment, while the configuration this
project recommends puts notes in `~/agent-knowledge/<repo>` — a path with no such
segment. Under the recommended settings the hook would have matched nothing and shipped
nothing, on the hot path, with no log line anywhere. The earlier tests passed only
because they left auto memory in its default location.

The first fix moved the problem rather than solving it: reading the root from a
dedicated variable meant a team could set `autoMemoryDirectory` and forget the
variable, arriving back at a dead, silent pipeline. The root is now read from
`autoMemoryDirectory` itself — the same key Claude Code uses — so there is one place to
get right instead of two. Verified with a store at `~/agent-knowledge/catalog-svc`
declared only in the project's settings: the note shipped, and an ordinary source edit
in the same run still exited silently without touching disk.

The same failure had a second route in, found later: the hook resolved
`.claude/settings.json` from the directory the session was opened in. A member who opens
Claude inside `src/` finds no project settings there, so `autoMemoryDirectory` is not
found and every note exits silently again. `CLAUDE_PROJECT_DIR` is supplied by Claude
Code and fixes the common case, but leaning on it makes the pipeline depend on an
environment variable being present. The hook now walks up the directory tree looking for
project settings, the way CLAUDE.md files are discovered, so nothing depends on that
variable and the rule "always open Claude from the repo root" does not need to exist.
Verified from the repo root, from `src/`, and from `src/deep/nested/`, with the variable
unset: all three ship the note.

The endpoint no longer checks paths against a shape of its own either, since it cannot
know where each member keeps notes. The sender states the root it matched and the
endpoint verifies the note sits under it, which catches a misconfigured hook shipping
source files: both a mismatched root and a missing one are refused.

### Neither Node nor a POSIX shell is universal, so both hooks are registered

The obvious remaining weakness was that the hook is a Node script, which means every member
machine needs Node. The docs settle where that stands, and not in the direction expected:

> "The npm package installs the same native binary as the standalone installer… **The
> installed `claude` binary does not itself invoke Node.**"

So Claude Code never runs on Node at runtime, on any platform, by any install method — the
local `claude` here is a 292 MB self-contained binary with `installMethod: "native"`. Node is
implied nowhere.

A shell is not guaranteed either, though it is close:

> "[Git for Windows] is recommended on native Windows so Claude Code can use the Bash tool.
> **If Git for Windows is not installed, Claude Code uses PowerShell** as the shell tool
> instead."

Command hooks do run through bash where one exists — measured, `/usr/bin/bash` 5.3.9, on
Windows — but a bare Windows machine has none.

| | POSIX shell | Node |
| --- | --- | --- |
| macOS, Linux, WSL | yes | not implied |
| Windows + Git for Windows | yes | not implied |
| bare Windows | **no** | not implied |

So both hooks are registered in the same array and no detection logic exists. Two
measurements make that safe rather than sloppy: a hook whose runtime is missing **fails
silently, printing nothing into the session, and does not stop the other hook in the array**;
and on a machine that can run both, the endpoint's dedupe collapses the duplicate into one
stored note and one events row.

That leaves one new silent branch, and it is worth naming: a machine with **neither** runtime
ships nothing and says nothing. The fix needs no local runtime at all — a `SessionStart` hook
of `type: "http"` can beacon to the endpoint, which then knows a machine that opens sessions
but has never delivered a note. Not built yet.

### Two implementations mean the wire format had to get simpler

Assembling JSON around a multi-kilobyte note full of quotes, newlines and Windows
backslashes is where a shell script breaks. So the note became the request body and
everything else moved into headers, for **both** implementations — nothing left to escape.
Reading the note from disk rather than from the payload fell out of the same change: it makes
Write and Edit identical, keeps the two implementations interchangeable, and picks up the
frontmatter Claude Code adds after the write.

`hooks/parity-test.js` runs both over the same awkward inputs and asserts byte-identical
delivery through the real endpoint. Writing it found three real bugs, two of them in the
design rather than in the test:

- **Header values are Latin-1.** A note named `ghi-chú-bẫy.md` made Node throw outright, and
  made curl send bytes the endpoint could not reconstruct. Paths and labels now travel
  base64.
- **curl cannot open a file whose name has diacritics on Windows**, while the shell can: curl
  receives the path as UTF-8 and asks the OS for it in the active codepage, failing with no
  output. Piping the note through `cat` keeps the filename out of curl's hands.
- **Path shapes**, for the third time in this project: `$HOME` under Git Bash gives
  `/c/Users/x` while the payload gives `C:/Users/x`, and the string compare silently rejected
  every note. Both sides now fold `/c/` into `c:/` before comparing.

Two further failures were mine in the test harness, and both looked exactly like hook bugs:
`spawnSync` holds the event loop, so an in-process endpoint cannot answer and every case
times out; and emptying the inbox by deleting its directory breaks the running server rather
than the sender. The endpoint now recreates its directory before each write, because a
cleanup script would cause the same thing in production.

### The shell version was checked on two of the three toolchain families

macOS is the reason to care: it ships **bash 3.2**, from 2007, and BSD versions of the
utilities rather than GNU ones. Reading the script for bash-4 features found none — no
`[[ ]]`, no arrays, no `declare`, no `${var,,}`, no `local` — and the BSD-versus-GNU
differences that matter were already handled: `base64` line wrapping is stripped with
`tr -d '\n'`, and `date -u +%Y-…`, `seq`, `grep -oE` and BRE backreferences all exist on BSD.

One real GNU dependency did turn up: two greps used `\(…\|…\)`, where `\|` is a GNU
extension that BSD grep does not implement. They would have worked on Linux and Windows and
failed on macOS. Both are now `grep -oE` with portable ERE alternation.

That audit was nearly derailed by counting instead of reading. `grep -c '\\|'` reported 175
matches, `'[['` reported 9, `'local'` reported 1 — every one an artifact of the search
pattern rather than a finding: in BRE `\|` means "either of two empty patterns" and matches
almost every line, and the `[[` hits were all `[[:space:]]`. Re-run with `grep -F`, the true
counts were 2, 0 and 0.

Then the script was run under **busybox** — no bash, `sh` only, and a `sed` that announces
itself as "not GNU sed" — inside a WSL Linux distribution. It parsed everything correctly:
the path `/tmp/notes/ghi-chú-bẫy.md` with diacritics intact, the memory root, the identity
read out of `.claude.json`, the session id; and with no curl present it spooled and exited 0,
exactly as designed. busybox is not BSD, but it is not GNU either, so it exercises the same
class of assumption.

Then containers made a real end-to-end run possible, delivering to the endpoint on the host
rather than only exercising the parsing:

| Environment | Shell | sed | curl | Result |
| --- | --- | --- | --- | --- |
| Windows, Git Bash | bash 5.3 | GNU | 8.19 | full parity with Node, 6/6 cases |
| Ubuntu 24.04 | bash 5.2 | GNU 4.9 | 8.5.0 | note delivered, 82 bytes |
| Alpine 3.20 | **`sh` only, no bash** | busybox | 8.14.1 | note delivered, 82 bytes |
| macOS | bash 3.2 | BSD | present | **not verified** — no machine available |

The two containers arrived as two distinct contributors, so attribution survives the trip.

Alpine settled something the design had wrong: it has no bash at all, and the script ran
unchanged. The hook was registered as `bash hooks/post-note.sh`, which is narrower than
necessary — every system with a POSIX shell has `sh`, not every one has `bash`. It is now
`sh hooks/post-note.sh`, re-verified on Windows and in both containers. macOS remains
unverified, but it is now the only untested member of a family the script has cleared three
times, and macOS `sh` is bash 3.2 in POSIX mode — the mode Alpine's busybox `sh` already
stands in for.

### The shell sender shipped without a shell flusher

Adding a second implementation created a hole big enough to lose notes permanently, and it
survived several rounds of "done" before anyone looked: `post-note.sh` spools when the
endpoint is unreachable, but the only flusher registered was the Node one. On a machine with
a shell and no Node — precisely the machine the shell sender exists to serve — notes were
spooled and then never sent again. Nothing logged an error. The note simply stopped existing
as far as the team was concerned.

The two senders also spooled *different formats*: Node wrote JSON, the shell wrote a
`.head` + `.body` pair. So even a machine with both runtimes could not drain a spool written
by the other one. Both now write the pair format, which the shell can read without a JSON
parser, and both flushers are registered.

`hooks/spool-test.js` covers all four sender-drainer combinations plus the case where the
endpoint refuses a note, which must leave the spool rather than be retried at the start of
every session forever. 5/5.

The pattern is worth naming, because it repeated three times in this project: **a second
implementation is not done when it works, it is done when every path the first one has is
mirrored.** Sending was mirrored and tested for parity; spooling was not, and the gap was
invisible precisely because the design's failure mode is silence.

### Personal taste versus team convention: settled by scope, not by a filter

This sat open for a long time as "the `type` label cannot separate one person's preference
from a real project convention, so a human will have to". Trying to implement that revealed
the premise was wrong twice over.

First, the reviewer never got the chance. A note saying "don't put a Co-Authored-By trailer in
commit messages" was dropped by the **intake filter**, not deferred to review — so the boundary
was already being decided, silently, by a model at 94% precision.

Second, the filter is not drawing the personal-versus-shared line at all. It keeps "source code
must be 100% English", and it keeps "pushing to master auto-deploys to UAT" — both plainly team
conventions. What it drops is conventions about **process** rather than about the repository.

That turns out to be the right line, for a reason that has nothing to do with who prefers what.
This file carries knowledge *discovered while working*: traps, dead ends, which of two similar
things governs. A commit-message convention is *decided at the start*, and its home is the
hand-written `CLAUDE.md` a lead writes once at init. Two different origins, two different
channels. The pipeline staying out of the second one is exactly what stops one member's habits
from arriving as team law — which was the original worry.

So there is no boundary to adjudicate here. The case is out of scope, and being out of scope is
the answer.

**A note on the relabelling, because it is the kind of move that fools people.** The eval case
for the Co-Authored-By note was labelled `keep`, and the filter kept marking it `DROP`. Changing
the label to match the model is how a benchmark stops measuring anything. What justifies it here
is that the *scope* question was settled first and independently — process agreements belong to
a different channel — and the label now encodes that decision. Under the old labels the filter
was wrong about this case; under the corrected scope it was right, and my label was the error.
Both numbers are reported rather than only the better one.

[claude-session-memory](https://github.com/teamspwk/claude-session-memory) scans cards for API
keys, tokens and DB URLs before creating them. This project had no equivalent, and the gap was
an asymmetry rather than an oversight: the intake filter is a model at 94% precision, and its
usual mistake — a mildly useless line reaching the file — costs a little context. The mistake
that matters here costs a rotated credential and a rewritten git history, because the artifact
is committed. Two failures whose costs differ that much should not share one probabilistic
gate.

So a pattern scan now runs at the endpoint before anything else looks at the note: private key
blocks, AWS key ids, GitHub classic and fine-grained tokens, Slack tokens, `sk-` style keys,
JWTs, connection strings with an embedded password, and assignments whose name says secret and
whose value is not a placeholder. It refuses rather than redacts — silently rewriting a note
changes knowledge without telling anyone — and it answers 422, which is a 4xx, so the sender
drops the note instead of retrying the same rejection at the start of every session.

`aggregator/secret-test.js` covers 10 secrets that must be refused and 7 notes that must pass,
and the second group carries the weight: a scan that refuses ordinary notes teaches people the
pipeline is broken, and notes *about* credentials are often the security traps most worth
keeping — "redeploy does NOT lose the PayOS credentials, measured 2026-08-10" has to survive.
17/17.

### A test that flattered itself, and the leak path behind it

The secret scan had a case labelled `real eval case`, and it was not. The real note from the
project's memory reads, in Vietnamese prose:

> the local admin account is &lt;a password&gt;, on UAT it is &lt;another password&gt;

(Vietnamese in the original, and the two passwords are written out there in full. They are not
reproduced here: this file is published, and a credential-shaped string does not belong in it
even when the credential is fake — `aggregator/scan-repo.js` flags the file if one appears.)

The fixture in the test had a `password=...` assignment appended to it. That suffix is what made it
match `credential assignment` — a doctored string wearing the label of real data, and it hid a
genuine leak path: a password mentioned in prose, in any language, matched none of the patterns.
No assignment, no recognisable key format, and the surrounding words are not English, so a
keyword list would not have helped either.

It surfaced only because a *separate* change exposed it. Tightening the intake filter's
machine-dependence test had overridden the credential bullet, so the filter began keeping that
note — correctly reasoning that shared credentials are not machine-specific. Checking whether
the scanner would still hold the line revealed that it never had.

The fix looks at shape rather than keywords: a token with letters, digits, and a symbol that
paths and version strings do not use. `@ ! # $ % ^ & * + = ?` qualify; `.` `-` `_` `/` do not, so
`v2.1.226`, `k8s-prod-2` and `.state/schema.json` are untouched. Emails are excluded outright.
The symbol must sit *inside* the token rather than lead it — `@types/node2` is an npm scope, and
it was the one false positive the first version produced.

The false-positive half of the suite grew more than the true-positive half, and deliberately:
every added case is a string that really appears in these notes. 26/26. End to end, the verbatim
note is now refused with 422 while a note mentioning `v2.1.226` is accepted.

Two lessons worth more than the pattern. **A fixture labelled "real" has to be verbatim** —
anything else measures the fixture. And **layers only defend if they overlap**: the filter and
the scanner were described here as defence in depth for credentials, and on this exact input
neither one held.

### The filter cannot separate process conventions from invocation detail

Two attempts at a principle for this, both measured, both worse than having none.

**Attempt one: "discovered while working" versus "decided at the start."** The idea was that a
commit-message convention is decided up front and belongs in a hand-written `CLAUDE.md`, while
this file carries what work reveals. Measured, it cost three real entries: a declined vendor
upgrade, a do-not-touch rule about a seed admin account, and a source-language convention. The
model quoted the new framing back while dropping them — *"decided upfront, belongs in
CLAUDE.md"*. The flaw is structural: two of the four kinds of knowledge this file exists for — a
decision and its reason, and an approach tried and abandoned — are *decided*. Any test turning
on decided-versus-discovered cuts out the middle of the target.

| | before | after attempt one |
| --- | --- | --- |
| accuracy | 92.9% | 89.7% |
| recall | 94.1% | **81.3%** |
| knowledge lost | 1 | **3** |

**Attempt two: "anything about how to invoke things."** Narrower, named its own cases, and still
took three entries — different ones. It dropped `dotnet ef` versus a container restart (a trap:
the two use different connection strings), pushing to master (which auto-deploys to UAT), and a
script that requires a particular working directory. Each is a property of the project that
happens to surface as a command, and the prompt named two of them explicitly as keeps while the
model dropped them anyway: the opening clause outweighed the counter-example.

So the rule is back to what scored 94/94, and it tests exactly one thing: **would a teammate on
a different machine see something different?** The commit-message convention is machine
independent, so it stays a keep — and the filter reliably drops it. That is now a **documented
limitation rather than a hidden one**: `pref-01` and `pref-02` are labelled `keep` and left in
the set precisely so the failure shows up in the numbers.

Relabelling them `drop` would have raised the score and taught the benchmark to agree with the
implementation, which is how a benchmark stops measuring. The cost of the limitation is small
for a real reason, not a convenient one: a convention decided at project start can be written
by hand into `CLAUDE.md` once, and it does not need this pipeline to discover it. Losing one
case beats losing three.

### One language for the tooling, one language for the artifact

Two decisions that point in opposite directions on purpose.

**The tooling is English, all of it** — prompts, code, comments, log lines, test labels, docs.
A project meant to be read by strangers cannot be half in a language most of them do not speak,
and the section headings and confidence marker had been Vietnamese since the first sketch.
Renaming them turned out to be nearly free, because the parser treats any `##` heading as a
section: only the marker is bound to a regex, so a team that wants its own headings can have
them. One test case renames sections into Vietnamese specifically to hold that property in
place.

Two kinds of Vietnamese are deliberately kept. The eval cases are real notes from a real
Vietnamese-speaking team, and translating the *input* would make the benchmark less like the
thing it measures. And a fixture named `ghi-chú-bẫy.md` stays exactly as it is: that filename is
what proved HTTP headers are Latin-1 and that curl cannot open a diacritic filename on Windows.
Anonymising it would throw the evidence away.

**The artifact is English too, and incoming notes are translated into it.** This reverses an
earlier rule — "keep each entry in the language it was written in, do not translate" — and the
objection behind that rule turned out to be false. Translating does not destroy the original:
the note is kept verbatim in the inbox and in the member's own memory directory. The artifact is
the distilled product, not the archive, so making it monolingual costs nothing and everyone who
ever joins can read it.

One guardrail matters more than the rule itself: **quoted technical strings are never
translated.** `SQLITE_CONSTRAINT: FOREIGN KEY constraint failed` is what somebody will paste
into a search box, and a translated error message is worse than no entry at all — so the
explanation around such a string is translated and the string is reproduced exactly. The merge
pass is also told not to go looking for existing lines to translate: rewriting a team's file on
the machine's own initiative is not a change it gets to make.

### Declined from prior art, with reasons

**Two-tier injection.** claude-session-memory injects a 200-token "related card TL;DR" when a
file is edited, plus a 2000-token selection at session start scored on git diff, git log and
interest. The selection machinery exists because there are many cards and no cap. This design
has a hard cap instead, so everything fits and nothing needs selecting — and selection is the
*alternative* to a cap, not an addition to it. Adopting it would remove the pressure that
keeps the file short, which is the only mechanism that forces deletion.

There is a native version of the same idea worth knowing about: `.claude/rules/` files with
`paths:` frontmatter load only when Claude touches matching files, which is micro-injection
done by the harness. It would also reintroduce the blindness to contradictions across files
that made per-module sharding a bad trade earlier. Available, understood, not adopted.

**Card types `runbook` and `onboarding`.** The removal test disposes of both: a runbook is
usually derivable from the repo or belongs in a skill, and onboarding prose is what reading
the code is for.

**A prune skill that detects duplicate cards.** Duplicates are merged automatically in the
merge pass here, at write time, which beats a command someone has to remember to run.

**Retention on raw events (`maxDaysToKeep: 30`).** Worth taking eventually, and not yet taken.
A note the filter rejects stays in the inbox and is re-filtered on every run, which costs
model calls forever rather than once.

### Identity comes from the Claude account, not from git

The first version attributed notes with `git config user.email`, which is unset often
enough to matter on a fresh machine and is sometimes a shared CI address. The Claude
account is strictly better: the agent could not have written the note without being
logged in, so it is always there. Measured — `~/.claude.json` carries
`oauthAccount.accountUuid`, `oauthAccount.emailAddress` and `userID`, and the UUID is
what the counting key is built from so that a member who changes their address keeps one
identity.

The hazard here is not a missing source but **two** sources. If one person is sometimes
keyed by their Claude account and sometimes by their git address, they count as two
people and can promote their own entry to project law — the precise failure the
promotion rule exists to prevent. That is why there is one primary that is effectively
always available, with git kept only for an unreadable account file, and why the
endpoint warns when a single label arrives under two different keys. Verified: the
Claude account is used when present, git email when the account file is absent, and the
warning fires with both keys and both sources named.

End to end, two members on separate repos with separate identities each hit the same
hidden trap in their own session and wrote their own note about it, unprompted. The
aggregator merged the two into a single entry carrying `(2 people)` and both
contributor hashes.

## 6. Git works as a transport, and was still rejected

Both git routes were built and both worked. They are recorded here because the
reason they lost is not a defect in git.

**A dedicated store repository.** `SessionEnd` cannot do the work itself — capped at
1.5 s, killed at teardown — but it can spawn a fully detached child, which the docs
endorse for exactly this. Measured: the hook returned in **6 ms** and the detached
worker completed a push **4 seconds after the session had exited**.

That surfaced a failure mode worth keeping in mind anywhere: the natural one-liner
`git add -A && git commit -m … && git push` never retries a push that failed while
offline, because on a later clean-tree run `commit` exits non-zero and the chain
stops. Reproduced, then fixed by pushing on the strength of being *ahead* rather
than of having just committed.

**A ref namespace on the project's own origin.** Pushing notes to
`refs/agent-knowledge/<member>` avoids a second repository entirely. Verified: two
members' unrelated histories coexisted on one origin, `ls-remote --heads` showed only
`main` so members never see the refs, and the aggregator read every member's notes
from a single clone without checking anything out. Attribution came free from the
commit author.

Both were rejected for the same reason: a push depends on a credential being present
and unexpired on that laptop. Usually it is, since members push code daily — but
"usually" is the thing this project exists to remove.

## 7. Two axes, two places, and only one human gate

Sections answer *what kind of thing is this* — a trap, a decision, a boundary.
Confidence answers *how far should this be trusted*, and it is a marker at the head of
the entry: `(unconfirmed, 1 person)` for a single report, phrased as a hint, and
`(N people)` once independent people have hit the same thing, phrased as a rule.

Those two started out tangled: confidence was a *section*, `## Unconfirmed`, sitting
alongside the type sections. Which meant an unconfirmed decision had nowhere natural to
live, confirming an entry *moved* it between sections, and — the tell — the two names
were not opposites, so describing the mechanism out loud kept coming out wrong. Splitting
them fixed the vocabulary and tightened the machinery at the same time: an entry now
keeps its section for life, so the section changing is by itself proof that something
other than confidence changed.

Confirming an entry carries no decision. The sentence does not change, the section does
not change, the fact was approved when it first went in, and all that is new is that
someone else independently hit it. Sending that to review is how a queue fills with
changes nobody needs to read, which is how a gate stops being read at all. So a
confidence-only change applies itself; everything else — a new entry, an edit, a
deletion, a move between sections, a drop back to unsure — waits for a person.

**The guard is mechanical, not a promise from the model.** `aggregate.js` parses both
files by entry id and requires that section and text be identical once the marker is
stripped, with no entry appearing or disappearing. It earned its place on the first run:
the model reported `promoted k1 … reworded slightly for clarity` — it had changed
`. Run` to ` — run` while calling the change a promotion. The classifier caught the
edited text and routed it to a person. Trusting the label would have committed an
unreviewed rewrite.

The merge prompt now states that a confirming candidate must be reproduced exactly, and
says why: the auto path is only safe while everything but the marker is provably
untouched. Re-run after that change — `AUTO-APPLY (confidence only: k1)`.

`gate-test.js` covers the classifier directly, because a guard that only fails when the
model happens to misbehave is a guard nobody has tested. Eight cases pass: marker
changed alone and a count rising both auto-apply; a reworded sentence, a move between
sections, an added entry, a removed entry, a drop back to unsure, and a no-op all
require a person.

Dropping back to unsure is deliberately not automatic. It means something contradicts a
rule the team is following, which is exactly when a person should look.

## 8. Aggregator behaviour, verified

Each of these was a claim before it was a test.

- Drops the harness note, keeps the code trap.
- Merges a heavily reworded duplicate into the existing entry instead of adding a
  second one.
- Promotes `(unconfirmed, 1 person)` to `(2 people)` only on a second *verified distinct*
  contributor. Unattributed candidates cannot promote anything — otherwise the
  rule silently degrades to "seen twice".
- Refuses a fact on the rejected list even when rewritten with fresh reasoning and
  after the intake filter had passed it.
- At the size cap, evicts the weakest line by the removal test. It deleted a
  stack-description line that any agent could derive from the repo, and kept two
  behaviour-changing traps.

That last one took two attempts, and the first failure was a mistake in the rules rather
than in the code. Asked to fit a new entry into a full file, the model refused to delete
anything and explained itself: *not worth evicting a 2-3 person Traps/Boundaries line to fit
a single-report item.* Reasonable-sounding, and wrong — it had used the contributor count
to answer a question the count says nothing about. The line it was protecting was a
description of the stack, true and confirmed and worth nothing.

Left alone, that turns the count into a shield: a true-but-useless line accumulates
confirmations, becomes impossible to evict, and at the cap the file starts discarding new
knowledge to keep old noise, because the noise has had longer to collect confirmations.
The rules now separate the two questions explicitly and give the model both example
lines, and every existing line is re-tested on every run rather than only the incoming
candidates.

## Designs that failed

**Mining the transcript for moments something went wrong.** Parse the session transcript at `SessionEnd`,
find error→fix pairs, distil those. Dead for several independent reasons: a
plugin-shipped `SessionEnd` hook is capped at 1.5s and cannot raise its own budget;
`claude -p` spawned from it is killed at teardown; `SessionEnd` also fires in `-p`
mode, so the distiller would recurse; the transcript is an undocumented internal
format (25 distinct key shapes, `session_id` and `sessionId` on the same records,
`is_error` inconsistently present); it does not fire on `/clear` and is cancelled by
Ctrl-C; and it lags the conversation, so the last turn may be missing.

The fatal objection was not technical. Running the filter over 149 real error events
showed those errors are dominated by an agent guessing and correcting itself inside one
turn, and the durable-looking remainder was machine-local: a missing CLI, a PATH problem,
a line-ending warning. Veteran knowledge is causal and social; tool errors are syntactic.

**Both git transports.** Built, measured, and working — see finding 6. Rejected for
depending on a credential that happens to be present on the laptop.

**OTel as the transport.** Killed by finding 4: `tool_input` is capped at ~300
characters on the wire. `OTEL_LOG_RAW_API_BODIES` would have carried the content —
response bodies do include tool_use blocks with full input, capped at 60 KB, and the
earlier objection that this meant O(n²) volume confused request bodies with response
bodies. It was not needed once the hook route measured clean, and it ships every
assistant response rather than only the notes.

**Sharding the artifact per module.** Rejected before implementation: it created
ambiguity about where a fact belongs, blindness to contradictions across files, and
a pull toward the root that would have reproduced the single large file anyway.
