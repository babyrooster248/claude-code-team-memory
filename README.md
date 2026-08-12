# claude-code-team-memory

**Turn each teammate's local Claude Code memory into one reviewed file in the repo.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-informational.svg)](package.json)
[![Member setup](https://img.shields.io/badge/member%20setup-one%20file-brightgreen.svg)](#what-runs-where)

Claude Code's auto memory makes an agent sharper the longer you work on one machine. It is also
machine-local by design — the docs say so outright: *"Files are not shared across machines or cloud
environments."* So the knowledge that makes your agent good is knowledge your teammate's agent
does not have, and a new hire's agent starts from zero on a codebase five people already know.

This closes that loop. A note written on one laptop arrives as a pull request on the shared
artifact; a person approves it; everyone else gets it on their next `git pull`. Nothing to install
and no command to remember: a member copies one credential file, once, and never touches it again.

<!-- For the repository settings, so search has something to match on:

  Description
    Shared team memory for Claude Code. Distils each member's auto memory into a reviewed
    AGENTS.md in the repo — filtered, deduplicated, and gated by a pull request.

  Topics
    claude-code · claude · agents-md · agent-memory · shared-memory · team-knowledge
    ai-coding-assistant · claude-code-hooks · developer-tools · knowledge-management
-->

## What lands in your repo

`AGENTS.md`, imported by `CLAUDE.md`, and deliberately small. This is verbatim output from a real
end-to-end run — two Claude Code sessions on a sandbox project, no hand editing:

```markdown
<!-- Maintained by claude-code-team-memory. Edit freely: delete a line you disagree with and the
     machine records that as a rejection rather than proposing it again. -->

## Traps
- (unconfirmed, 1 person) `node seed.js` fails with `SQLITE_CONSTRAINT: FOREIGN KEY constraint
  failed (items.category_id -> categories.id)` even when the real cause is that `node migrate.js`
  hasn't run yet (no `.state/schema.json`). Run `node migrate.js && node seed.js`. README lists
  both commands but not that the order is mandatory. [k1]

<!-- knowledge-state
k1: f7e188d6
-->
```

Three things in that snippet are the whole design:

- **`(unconfirmed, 1 person)`** — how many *distinct* people hit it. One person is a hint; two or
  more becomes `(2 people)` and reads as a rule. The same person hitting it five times is still
  one person.
- **The error string is reproduced exactly.** That is what somebody will paste into a search box.
  Notes arriving in any language are translated into English; quoted technical strings never are.
- **`knowledge-state`** carries the contributor ids. Claude Code strips block HTML comments before
  loading a file into context, so the bookkeeping costs zero tokens at read time.

The session that produced that entry was one thing; the run after it is the point. A second
session on the same project read the file, ran `migrate` first, walked past the trap, and said so:
*"That's already recorded in memory, and nothing new came up this turn, so there's nothing to add."*

## Quick start

Three roles. Every step below is one-time.

**1. Knowledge host** — one box the team can reach. Needs node, plus Claude Code logged in.

```bash
git clone https://github.com/<you>/claude-code-team-memory
cd claude-code-team-memory

cp aggregator/config.sample.json aggregator/config.json   # projects + members; gitignored
node aggregator/make-credential.js minh@example.com       # one per member per project
node aggregator/ingest.js --config aggregator/config.json # resident; notes land here
```

One host serves several projects: each repo names itself with `AGENT_KNOWLEDGE_PROJECT`, and their
inboxes never mix. **Reachable over the internet rather than a LAN?** Then it needs TLS in front and
`--behind-tls-proxy` — basic auth puts the credential on the wire in reversible form on every note,
so the server refuses to bind a non-loopback address without it, and refuses entirely without
`--config` since that mode has no authentication at all.

**2. The project** — once, by whoever owns the repo. Vendor the hooks, commit two config bits.

```bash
cp -r claude-code-team-memory/hooks your-project/hooks
# then merge hooks/settings-snippet.json into your-project/.claude/settings.json
```

The snippet sets `autoMemoryDirectory`, points `AGENT_KNOWLEDGE_INGEST` at the host, and registers
both hooks. Then add this to the project's `CLAUDE.md` — it is what makes agents write notes at
all, and it is measured to matter (0/3 sessions without it, 2/2 with it):

```markdown
@AGENTS.md

## Recording memory

Write it into auto memory whenever you learn something a teammate would want and the code does
not say: a command failed and then worked; I corrected you; something behaved in a way whose
real cause was not what it looked like; you chose or rejected an approach for a reason; you
worked out which of two similar things governs; you found an existing note is now wrong. Do it
before finishing the turn, including when you finish by asking me something. Err on the side of
writing it — a shared filter drops what does not belong, and nothing recovers what was never
written. Add one line to MEMORY.md.
```

Recall is the job here, not precision: over-capture costs one filter pass on the aggregator, at 100%
measured precision, and under-capture is permanent. Hence no closed list of categories. An earlier
version named four and said *"only"* — and twelve of the eighteen real `keep` cases in
`eval/cases.jsonl` fit none of the four, including three shapes it never mentioned: a correction of a
stale belief, a hazard in shared infrastructure, and which module to copy from
([`docs/findings.md`](docs/findings.md) §9).

**3. Every member** — `git pull`, then one file, once:

```bash
cp hooks/agent-knowledge.env.sample .claude/agent-knowledge.env   # gitignored
# fill in the two values your tech lead sends you
```

That is the only manual step, and it is the one place this project keeps a secret on a member's
machine. Skipping it costs nothing permanent: the hooks spool notes locally and the log names the
file to create, so the knowledge waits rather than evaporating.

**Identity comes from the credential, not from the note.** The sender still reports its Claude
account, but the key the `(2 people)` marker counts is the email that authenticated. Otherwise one
member could assert a second identity and walk an entry through the auto-apply path — the one path
with no human on it.

Then, whenever you want to propose an update to the shared file:

```bash
node aggregator/aggregate.js \
  --store ./inbox/notes --events ./inbox/events.jsonl \
  --artifact ../your-project/AGENTS.md --cap 50 --votes 3 [--commit]
```

Without `--commit` nothing is touched: the proposal lands beside the artifact as
`AGENTS.md.proposed`. With it, you get a branch and a commit to open a PR from.

## How it works

```
session on a member's machine
  |   agent writes its own memory note, in-session, where the context is
  |   (the CLAUDE.md instruction above is what makes it do this)
  |
  +-- PostToolUse hook, matcher Write|Edit
  |     is the path inside the memory directory?  no -> exit, one string compare
  |     who wrote it?  the Claude account (always present); git email only as a
  |                    last resort; if neither, do not send at all
  |     POST the note to the aggregator
  |     unreachable -> spool locally, retried at every SessionStart
  |
  v
ingest endpoint
  |   refuses a note it cannot attribute, refuses MEMORY.md (a personal index),
  |   refuses anything the secret scan flags — deterministic, ahead of any model
  |   writes notes/ + events.jsonl
  |
  v
aggregator (a batch script, not a service)
  |   pass 1  intake filter, majority of 3 votes: drops machine-local notes
  |   pass 2  merge against the WHOLE current file: sharpen, merge, delete, promote
  |
  +-- a change to what the file SAYS -> one PR, ~3 entries max, a person decides
  +-- only the confidence marker moved (someone else hit the same thing; sentence
  |     and section provably untouched) -> applies itself, nothing to weigh
  v
AGENTS.md in the repo, imported by CLAUDE.md
  |
  v
teammate's ordinary `git pull`    <- the read path, nothing to install
```

Nothing in that path asks a member to run a command or install a tool. The constraint that
eliminated four earlier transports — mining the session transcript, shipping notes as OTel
attributes, and pushing over git, either to a dedicated store or to a ref namespace on the project's
own origin — was stated as "no credential on a member's machine", and it is worth being straight
about the fact that **a credential is now on a member's machine.** Both git routes were built and
worked, and both were dropped for needing one. [`docs/findings.md`](docs/findings.md) has what each
was measured to do.

The reason that is not a reversal is that the two credentials are not comparable, and the original
constraint was aimed at the wrong noun:

|  | a git credential | this token |
| --- | --- | --- |
| what it can do if leaked | push to the repository | append a note to an inbox that a filter and a human then gate |
| who controls it | the member, and whatever SSO issued it | the tech lead, in `config.json` |
| how it fails | expires or rotates on its own schedule, silently | revoked deliberately; notes spool and the log names the file to fix |
| setup | already there, or a support ticket | copy one file, once |

What actually made the git routes unusable was **a credential nobody on the team could see the
state of**, which turned a silent expiry into a pipeline that had quietly stopped weeks ago. A
purpose-issued token whose only power is writing to an inbox, and whose absence spools rather than
discards, is a different object. If the host is on the LAN, none of this is needed — run without
`--config` and there is no credential at all.

## What it refuses

This is not a memory store and not a sync tool. Storing notes is the easy half; the half that
decides whether the file is worth reading is what never gets in.

Two questions are asked about every line, and they are **independent**:

**Is it true?** Answered by how many people hit it. That is what the `(2 people)` marker records.

**Does it earn its place?** Answered only by the removal test: *take the line out — would a new
agent now do the wrong thing?* If no, the line goes, however true it is, and no matter how many
people confirmed it.

A line can score full marks on the first and zero on the second. *"The project is a .NET backend,
tests run with `npm test`"* is true, everybody would confirm it, and it buys nothing — any agent
reads that off `package.json` in seconds. Meanwhile every line in the file is paid for by every
teammate on every session.

Letting the first answer settle the second is the failure mode: the count becomes a shield,
true-but-useless lines become impossible to evict, and at the size cap the file starts throwing
out new knowledge to protect old noise. Hence a hard line cap, and a rule that re-tests every
existing line on every run — not just the incoming ones.

## Why no vector database

There is no embedding step, no index, no retrieval at query time. Two reasons, and the second one
is the real one.

**Scale.** Karpathy's LLM wiki pattern — raw sources, an LLM-compiled markdown layer, and a schema
file, published as a gist in April 2026 and summarised
[here](https://venturebeat.com/data/karpathy-shares-llm-knowledge-base-architecture-that-bypasses-rag-with-an) —
makes the case that at personal scale an LLM
reading a structured index beats vector similarity, because the model understands what you are
actually asking while cosine similarity only finds similar words. His own note on where it breaks
is around ~100 articles / ~400k words, the point at which the wiki stops fitting in one context
window and a two-tier scheme starts reinventing RAG with extra steps. This project sits four
orders of magnitude below that line: the artifact is capped at ~50 lines and is one file.

**No query to retrieve against.** Retrieval assumes somebody asks. The failure this project
targets is the opposite shape — an agent confidently does the wrong thing and never knows there
was something to look up. *"Run the migration before the seed script"* is only useful if it is
already in context when the agent reaches for `seed.js`; a retriever that would have surfaced it
had anyone thought to ask is worth nothing here. So the file is loaded unconditionally at session
start, and the engineering goes into keeping it small enough that unconditional loading stays
cheap. That is what the hard cap and the removal test are for. RAG optimises recall against a
corpus you keep; this optimises what is worth keeping at all.

Seen next to that pattern, this is the compile step applied to a team instead of a person: many
agents' raw notes in, one reviewed page out, with a human at the gate.

## "How do you know it isn't missing things?"

It is missing things, and the honest answer is that this cannot be measured the way the rest of the
system can. Measuring recall needs a denominator — how much knowledge a session contained — and that
number does not exist. Every figure here is *how much of what someone thought to enumerate was
captured*, never *how much was lost*. That limitation is structural, and it applies to every capture
system, this one and the prior art alike.

So the claim is deliberately narrow: **what gets written reaches the team through a measured filter
and a human gate.** Whether everything worth writing gets written is the weak link, and it is the
part to be sceptical about.

Three things make it less bad than it sounds, and one makes it worse.

**Redundancy across people and time.** Capture does not have to be reliable per session. The same
trap gets hit by several people, repeatedly, and one person's miss is another's note. At the ~88%
per-encounter rate measured here, two encounters reach 98.4% and three reach 99.8%. Machine-local
memory has none of this: there, every miss is relearned from scratch by the next person.

**But those misses are not independent.** The whole team runs the same instruction against the same
model, so failures correlate. One planted class was captured 2/4 — at a 50% rate, three encounters
still only reach 87.5%. Redundancy rescues random misses and does almost nothing for systematic
blind spots, and a systematic blind spot is by definition the one nobody enumerated.

**Redundancy also only covers what recurs.** A trap recurs. A decision taken once in a discussion,
settled and never revisited, has no second encounter to catch it. That loss is permanent.

**The failure is asymmetric, and the system is tuned for it.** Over-capture costs one filter pass at
100% measured precision; under-capture is forever. That is why the capture instruction carries no
closed list of categories and errs toward writing.

**What is genuinely absent: any signal that a session produced nothing.** Everything in the pipeline
observes notes that exist. A session that ran, learned something, and recorded nothing is invisible —
which is exactly the shape of the `CLAUDE.md` instruction quietly ceasing to work. The fix is the one
job OTel is kept around for: a metric counting sessions that yielded no knowledge at all. It is
designed, described under [Measured](#measured), and **not built**. It is the largest open gap in this
project, larger than anything under [Status](#status-and-what-is-not-verified-yet).

## Is authentication actually needed, or would a rate limit do?

Worth answering precisely, because the two protect against almost disjoint things and neither is
about the risk people assume.

**Nothing here can leak project knowledge, with or without auth.** The endpoint has no read path:
`GET /health` returns `{ok:true}`, `POST /note` writes, everything else is a 404. No route returns a
note, an event, or a listing. The POST response echoes only a filename built from what the sender
itself supplied, and the contributor count goes to the server log rather than the response. Notes are
written under `path.basename`, so a crafted path cannot traverse out of the inbox.

| Risk | Rate limit | Auth |
| --- | --- | --- |
| Reading the team's knowledge | not applicable | **not applicable — there is no read path** |
| Burning the model budget (every note costs three calls) | **yes, this is its job** | partly |
| Filling the inbox and the disk | yes | partly |
| Getting text into `AGENTS.md` | no | partly — the human PR gate is the real control |
| **Forging a contributor to reach auto-apply** | **no — two notes is enough** | **only auth stops this** |

The last row is the one that requires authentication. Promotion from `(unconfirmed, 1 person)` to
`(2 people)` needs **two** notes from two identities, not many, so no throttle touches it — and
`(2 people)` is the auto-apply path, the only change that merges without a person looking.

Content injection is a different matter, and the honest answer is that the human PR gate stops it,
not auth. But dropping auth means a reviewer reads real notes **mixed with notes from anyone who
knows the URL**, and a tired reviewer approving is how an injection lands. `AGENTS.md` is loaded into
every teammate's agent on every session, which makes it a more valuable target than ordinary docs.

**Rate limiting is in regardless**, because it protects against something authentication does not: a
hook stuck in a loop, or one leaked token, spending a month's budget before anyone checks. Default
120 notes/hour per credential with a burst of 30, configurable, generous on purpose — a member having
a heavy day must never be the reason a trap goes unrecorded.

There are two buckets, and the second one exists because adding authentication created the problem it
solves. Verifying a credential runs scrypt, deliberately, and wrong credentials are hashed too so
that a bad email cannot be told apart from a bad token by how fast the refusal comes back. Those two
choices together mean an unauthenticated flood buys one expensive hash per request: the measure added
to slow down guessing became a way to exhaust the CPU. So a looser per-address bucket sits **in front
of** authentication — the position is the whole point, since a 401 returned after the hash has
already paid for it.

**Current state, both modes:**

| | with `--config` | without `--config` |
| --- | --- | --- |
| authentication | required | none |
| rate limit on notes | per credential | per address |
| rate limit before auth | per address | not applicable |
| what it will bind | loopback, or anything with `--behind-tls-proxy` | **loopback only** |

One trap worth naming, because getting it wrong would have made the rate limit worse than useless:
**429 is a 4xx**, and every sender used to discard 4xx as "unacceptable forever". A rate limit that
discarded notes would be a cost control that destroys knowledge. Both senders and both flushers now
spool on 429 and on 401/403, and drop only on the codes that are a verdict about the note itself.

**If the host is on the LAN, skip all of it.** Run without `--config`: no credential anywhere, no
member setup, and the endpoint refuses to bind anything but loopback.

## Editing the file by hand

You are the reviewer. The machine's format is not yours to learn.

**Don't like a line? Delete it.** The next run diffs the file against its own last proposal, sees
your deletion, and records the fact as rejected — so it is never proposed again, in any wording.
To undo that, remove the line from `rejected.md`.

Seven reviewer behaviours are covered by tests, because each one used to break something:
rewording a line and dropping its `[k1]` id; deleting a line; deleting the whole
`knowledge-state` block; renaming or translating a section heading; hand-writing a new line with
no id and no marker; leaving a `<!-- TODO -->` comment mid-file; and hand-editing `(2 people)` to
`(5 people)`. Your edit is the truth in every one of them: the machine reconciles to it, never
against it. `node aggregator/check-artifact.js AGENTS.md` reports damage and is one node command,
so it runs in CI on the PR regardless of which forge you use.

## Measured

Numbers, not claims — each with the model and CLI version that produced it, because a score
without those is not checkable. All filter figures: `claude` 2.1.227, 2026-08-12, 29 labelled
cases, majority of 3 votes. Full method and the failed designs are in
[`docs/findings.md`](docs/findings.md).

| What | Result |
| --- | --- |
| Agents saving knowledge, no `CLAUDE.md` instruction | **0 / 3** sessions |
| Agents saving knowledge, with the instruction | **2 / 2** sessions |
| Short instruction vs a longer rewrite, 7 planted classes | **indistinguishable** — p = 0.234 unpinned, p = 1.000 on opus |
| Notes that are machine-local rather than project knowledge | **1 in 3** |
| Intake filter on **opus**, 29 cases, majority of 3 | **100%** accuracy / precision / recall, 0 unstable |
| Same prompt on **haiku** | 89.7% accuracy, 94.1% precision, 88.9% recall — 1 junk through |
| Same prompt on **sonnet** | 69.0% accuracy, 100% precision, **50.0% recall** — 9 dropped |
| Secret scan | **26 / 26** — 10 credentials refused, 16 lookalikes passed |
| Hand-edit and auto-apply guard | **16 / 16**, no model needed |
| Hook cost inside the memory directory / on any other write | **~160ms** / **~100ms** |
| Runtimes verified | Windows + Git Bash, Ubuntu 24.04, Alpine 3.20 |

**Run it on opus.** The three rows above are the same prompt on the same 29 cases, and the middle
model is the worst by a wide margin — sonnet drops half the real knowledge while keeping 100%
precision, which is the most dangerous shape a filter can have, because nothing appears anywhere
to show what was lost. The mechanism is visible in its own reasoning: the DROP rules are a
checklist, a small model follows it, a large model reads past it to the intent, and a model in
between constructs a justification for overriding it. Assuming "bigger model, better filter" is
not safe here, and neither is assuming the opposite — measure the one you intend to run with
`node eval/compare-models.js`.

Why OTel is not in the diagram: an earlier revision routed notes through it, and `tool_input`
turned out to be truncated at ~300 characters on the wire (measured: 8918 B in, 300 chars out;
raising `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH` changed nothing). OTel remains optional and off the
critical path with exactly one job: metrics that reveal a session which ran and produced no
knowledge at all, which is how the `CLAUDE.md` instruction quietly failing becomes visible.

## What runs where

Three places, and only the middle one is new infrastructure.

| | What is on it | What it needs |
| --- | --- | --- |
| **Member machine ×N** | the repo clone (hooks, `.claude/settings.json`, `AGENTS.md`), the auto-memory directory, the spool | Claude Code, and either a POSIX shell **or** node — both hooks are registered and whichever runtime exists does the work. No inbound port. One credential file, copied once — and none at all if the host is on the LAN |
| **Knowledge host ×1** | `ingest.js` on a port, `inbox/`, and `aggregate.js` | node; reachable from member machines; **Claude Code installed and logged in**, because `aggregate.js` runs two model passes via `claude -p` |
| **Git server** | the repo, and wherever PRs are reviewed | nothing new — no forge API is used |

The easy one to miss is the middle row: `aggregate.js` is a batch script that calls a model, not a
service. Whichever box runs it needs Claude Code present and authenticated, and it does not have
to be the box running the endpoint.

Both hooks are registered on purpose, with no runtime detection. Claude Code never runs on Node —
even the npm package only downloads a native binary — so node is not implied on any platform, and
a POSIX shell is not implied either, since native Windows without Git for Windows has none. A hook
whose runtime is missing fails without blocking the other; on a machine with both, the endpoint's
dedupe collapses the duplicate. `hooks/parity-test.js` asserts the two senders deliver
byte-identical notes.

## Prior art

Not the first attempt, and worth knowing before adopting any of it.
[claude-mem-sync](https://github.com/lopadova/claude-mem-sync) syncs observations over git, distils
them into CLAUDE.md rules, has an optional PR gate, counts "dev diversity", caps output and evicts
by score — and ships a nine-tab dashboard.
[claude-session-memory](https://github.com/teamspwk/claude-session-memory) captures through a
PostToolUse hook, promotes on thresholds, stacks evidence to bump importance, and attributes per
user. [claude-memory-compiler](https://github.com/coleam00/claude-memory-compiler) is the closest
of all: hooks capture sessions, an SDK agent extracts decisions and lessons, and a compiler
organises them into cross-referenced articles.
[claude-code-auto-memory](https://github.com/severity1/claude-code-auto-memory),
[claude-agentsmd](https://github.com/intellectronica/claude-agentsmd) and
[amtiYo/agents](https://github.com/amtiYo/agents) cover neighbouring ground — auto-capture, and
keeping AGENTS.md and CLAUDE.md in step across tools.

The space is crowded, and saying so plainly is more useful than letting you discover it later.
Three of those were found while checking whether this project's own name was taken.

The overlap runs both ways. claude-session-memory scans cards for credentials before creating
them; this project had no such check, relying on a probabilistic filter to catch a failure whose
cost is a rotated secret and a rewritten history. That scan is now here, deterministic and ahead
of the model, with `aggregator/secret-test.js` covering both what must be refused and what must
not be.

Two differences run the other way, and both are places where the prior art has a failure this
project measured:

- claude-mem-sync evicts by recency, type and access score, and a `#keep` tag gives an observation
  infinite score. That is the shield described above: a true-but-useless line, protected by its own
  evidence, that the size cap can never remove.
- claude-mem-sync's own documentation says filtering environment-specific data "relies on developer
  configuration" — keyword lists. Measured here, **one note in three** written by an instructed
  agent is machine-local rather than project knowledge, which is a lot to leave to a keyword list.

What is least duplicated is not the code but [`docs/findings.md`](docs/findings.md): the transports
that do not work, and the numbers proving it.

## Layout

| Path | What it is |
| --- | --- |
| `hooks/post-note.js` | PostToolUse hook — ships one note the moment it is written |
| `hooks/post-note.sh` | the same sender in POSIX shell, for machines without node |
| `hooks/flush-spool.js`, `hooks/flush-spool.sh` | SessionStart — resend notes that could not get out |
| `hooks/parity-test.js` | asserts the two senders deliver byte-identical notes |
| `hooks/spool-test.js` | asserts either flusher drains either sender's spool |
| `hooks/settings-snippet.json` | what to commit into the project's `.claude/settings.json` |
| `hooks/agent-knowledge.env.sample` | the member's one-time copy-and-fill credential file |
| `aggregator/config.sample.json` | server config — projects, members, credential hashes |
| `aggregator/make-credential.js` | issues one member credential; prints the config entry and the member's two lines |
| `aggregator/auth-test.js` | 19 cases over auth and rate limiting — forged identity, cross-project writes, 429 handling, cleartext refusal |
| `aggregator/ingest.js` | receives notes; refuses unattributable ones and anything carrying a credential |
| `aggregator/secret-test.js` | 26 cases over the secret scan — 10 refused, 16 that must not be |
| `aggregator/merge-prompt.md` | the merge pass: sharpen, merge, delete, promote |
| `aggregator/aggregate.js` | orchestrator — filter, merge, propose |
| `aggregator/gate-test.js` | 16 cases over the auto-apply guard and hand-edit tolerance, no model |
| `aggregator/check-artifact.js` | reports damage in a hand-edited file; runnable in CI on the PR |
| `aggregator/scan-repo.js` | runs the secret scan over this repo itself |
| `eval/cases.jsonl` | 29 labelled notes from real projects — the acceptance test |
| `eval/filter-prompt.md` | intake filter: does this note belong in a shared file |
| `eval/run-eval.js` | scores the filter; `--runs 3` for majority vote, `--model` to pick one |
| `eval/compare-models.js` | scores every model side by side, and lists the cases they disagree on |
| `docs/findings.md` | every measurement, including the designs that failed |

```bash
npm test                                     # all five suites, no network, no model

cd eval                                      # these need a model
node run-eval.js --model opus --runs 3       # the configuration to run in production
node run-eval.js --model haiku --runs 3
node compare-models.js                       # side by side, plus every disagreement
```

## Status, and what is not verified yet

The loop runs end to end on real Claude Code sessions: a note written by an agent that hit a trap
travelled to the endpoint, survived both refusal gates, merged into the artifact, and changed how
the next session behaved. Three gaps are open, and it is more useful to name them than to let you
find them:

- **Promotion to `(2 people)` has only ever been exercised by fixtures.** Faking a second identity
  is not possible by design — swapping `HOME` loses the Claude credential entirely — so the
  two-person path needs a genuine second account to be called verified.
- **No run on a large production repo yet.** Every number above comes from purpose-built sandboxes,
  except the 29 eval cases, which are real notes from a six-month codebase.
- **A machine with neither node nor a POSIX shell is silent, not detected.** A `SessionStart` hook
  of `type: "http"` as a beacon would fix it and is not built.
- **The filter's accuracy belongs to the model, not to this repo.** It scores 100% on opus and 50%
  recall on sonnet with the prompt untouched, so upgrading, downgrading or switching the model is a
  change to the filter and has to be re-measured. Pin the model you run.

- **The capture instruction is tuned for recall, and that side of it is unmeasured.** A longer
  rewrite was measured against the previous version and came out indistinguishable on seven planted
  classes (`docs/findings.md` §9). Two changes were made anyway, on evidence the A/B could not
  produce: the closed list of four categories was opened, because twelve of the eighteen real `keep`
  cases in `eval/cases.jsonl` fit none of the four; and it now fires on a turn that ends in a
  question, because a session settled a do-not-touch rule, wrote three paragraphs about it, asked
  which option to take, and recorded nothing. Neither change has an A/B behind it — planting a class
  nobody thought of is not possible, which is exactly why the enumeration was the risk.

Also known and documented: a line that was true, that the code has since made false, and that
nobody hits again, has no trigger to correct it. The only mitigation is keeping the file small and
specific.

One published figure was wrong and is worth saying plainly rather than quietly correcting. This
README previously claimed the filter scored 96.6% accuracy with zero junk through, and described
commit-message conventions as knowledge the filter fundamentally could not classify. Re-measured,
that figure reproduces on no model available today, and opus classifies those conventions correctly
using a rule the prompt already contained — so the "limitation" was the model's, and two rounds of
prompt rewriting had gone after the wrong layer. The figure had been recorded without the model or
version beside it, which is what let it survive. `docs/findings.md` §3 keeps the full account.

## What is deliberately absent

No cron, no scheduler, no hosted service, no vector database, no skill loaded into context, no
forge API, no framework, no second git remote, and no runtime dependencies. The machinery is two
prompts and five scripts.

## License

MIT © BabyRooster
