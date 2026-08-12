# Runbook

What to type, what should come back, and what to say when it does not. Written before the full
rehearsal, so every beat carries its verification state — **verified** means it was run and observed,
**unverified** means it is reasoning that has not yet met a real session.

The prompts are in Vietnamese on purpose. It is what the team actually types, and it demonstrates a
design decision for free: notes arrive in whatever language the member thinks in, and the artifact
comes out monolingual English, because the file is read by everyone who will ever join.

## Before the room fills

| | |
| --- | --- |
| Spend limit | **Check it first.** Two separate work sessions on this project ended with the monthly limit hit mid-task. Every live act costs a session, and the aggregate runs on the host bill the same account |
| Host | `systemctl --user status agent-knowledge-ingest` → active. From your laptop: `curl -s https://<host>/health` → `{"ok":true}` |
| Journal | `journalctl --user -u agent-knowledge-ingest -f` open in a second terminal, large font, left running all session |
| Colleague | Their clone exists, `.claude/agent-knowledge.env` filled in, and **they have opened Claude Code in that directory once and accepted the trust dialog**. Skip this and act 5 dies: an untrusted workspace ignores `permissions.allow`, every Bash call is denied, and the agent cannot run `dotnet` at all |
| .NET | `dotnet --version` on both machines. The host needs none |
| Fresh state | `node demo/setup-project.js --dest <path> --stack dotnet --seeded --ingest https://<host> --project catalog-svc` |

## Act 1 — the trap, live (5')

Prompt, typed into a fresh Claude Code session in the project directory:

```
Nạp dữ liệu mẫu cho catalog rồi cho tôi xem report.
```

Nothing about memory, notes, migrations, or ordering. The task is an outcome — data loaded, report
visible — and `seed` is the obvious first move, which is what walks into T1.

**Beat landed if:** the agent runs `dotnet run -- seed` first, gets *"Seed failed: could not read the
catalog store. Check ConnectionStrings:Catalog in appsettings.json"*, works out that no migration has
been applied, recovers, and writes a note naming both the misleading message and the real cause.

**Verification state: UNVERIFIED, and the first attempt failed for two reasons now fixed.** The agent
ran `migrate` first and explained the trap before hitting it, because (a) the sample source carried
comments explaining every trap, and (b) the pre-seeded artifact contained an entry saying migrations
are applied in code. Both are gone — the source now has zero comments and the artifact says nothing
about ordering — but the corrected setup has not yet met a live session.

**If the agent runs `migrate` first anyway:** say so plainly. It is the honest half of the same point:
a capable agent sometimes reads the README carefully and gets it right, and the note only exists
because sometimes it does not. Then move to act 2 — nothing downstream depends on the trap firing,
only on a note existing.

## Act 2 — transport (2')

Nothing to type. Read the journal that has been open since the start:

```
[ingest] accepted <email-slug>__<note>.md [catalog-svc] — N bytes ... 1 contributor(s) so far
[ingest] REFUSED (MEMORY.md is a personal index, not a note)
[trigger:catalog-svc] note accepted — aggregate in 90s unless another arrives first
```

Three things to point at: the contributor is the **authenticated email**, not anything the note
claimed; `MEMORY.md` was refused because it is one person's private index; and the same note arrived
twice because both hooks fired, which is why the trigger waits instead of running immediately.

Optional, if someone asks whether the credential travels in the note: open a spooled `.head` file and
grep it for `authorization`. It is not there — the credential is added at send time and never written
to disk.

**Verified.** All three lines observed in real end-to-end runs.

## Act 3 — the aggregator, nobody typing (6')

Still nothing to type. The 90-second window elapsed during act 2, so the run has already started. The
journal carries its whole output, prefixed `[trigger:catalog-svc]`.

**Beat landed if:** exactly **one** run appears for the note, the per-note `KEEP`/`DROP` lines carry
reasons, the gate says `NEEDS A PERSON`, and a branch `agent-knowledge/<date>` was committed.

**Unverified on this host:** the wall-clock of a real run on 1 GB of RAM. Measure it at rehearsal. If
it takes longer than act 2, open act 3 by reading a run that is still going — that is honest and still
shows the mechanism. Do not promise "and it's finished" before knowing.

**If the trigger did not fire:** run `aggregate.js` by hand and **say that the trigger did not fire**.
Typing it silently, as though it were automatic, is the one thing that would make the rest of the
demo unbelievable.

## Act 4 — the human gate (4')

Open the pull request. Two edits, both as a reviewer would make them:

1. **Reword** the new entry for clarity — any wording change will do.
2. **Delete** the conventional-commits line (`[k3]`). The argument is real: commit conventions belong
   in `CONTRIBUTING.md`, not in the file every agent loads on every session.

Merge. `check-artifact.js` runs in CI on the PR.

Then say what happens next, and do not demonstrate it yet: the deleted line lands in `rejected.md`,
and the proof that it is never re-proposed arrives in act 5, on the next run — which a **new note**
triggers, not a merge.

**Verified:** deletion-as-rejection and hand-edit tolerance are covered by 16 automated cases. The
reviewer's own copy of this beat has not been rehearsed.

## Act 5 — the colleague's machine (6')

### 5a — the same task, a different person

They `git pull`, then the **same prompt as act 1**:

```
Nạp dữ liệu mẫu cho catalog rồi cho tôi xem report.
```

Two transcripts side by side: act 1 feeling its way through the trap, this one going straight.

**Measured, on the node version of this project:** cold tripped **3/3**, warm went straight **2/3**.
So there is roughly a one-in-three chance this agent trips anyway. If it does: *"reading is not acting
— without the file it went wrong three times out of three, with it two out of three, and this is the
third"*, then point at how much faster it recovered. Measured, not improvised.

Do **not** show the cost table. It is in `docs/findings.md` §11 for anyone who asks, and an audience
does not pay attention to a table proving something they already believe.

### 5b — the trap that lies

```
Đổi tên item 1 thành "Áo thun trơn" và xác nhận là nó đã đổi thật.
```

The second clause is deliberate and worth defending if challenged: asking for confirmation of a data
change is what any lead would write, and without it the agent has no reason to look. T2 prints
`updated item 1 to "Áo thun trơn"` and changes nothing, so the beat depends on the agent verifying
rather than trusting the output.

**Beat landed if:** the agent runs `report`, sees the old label, and works out that `AsNoTracking()` on
a write path means `SaveChanges()` had nothing to save.

**If the agent reports success without verifying:** that is the same failure the code has, one level
up, and saying so is stronger than hiding it — the entire argument for a human gate is that neither
the code nor the agent verifies itself.

**Verification state: UNVERIFIED live.** T2 itself is verified deterministically — `update` reports
success and the label does not change — but no session has yet been given this prompt.

### 5c — the loop closes

Their note reaches the host and the trigger runs again. That run does three things at once:

- does **not** re-propose the line deleted in act 4, because it is in `rejected.md`
- now has **two authenticated emails**, so the entry moves to `(2 people)`
- and because only the marker changed, the gate says **AUTO-APPLY** — no pull request

**Unverified end to end**, and it is the biggest remaining gap in the whole demo: promotion to
`(2 people)` has only ever been exercised by fixtures, because a second identity needs a second
credential in real use. This act is the first time it will be attempted with two real ones.

## Act 6 — what it refuses, and what nobody knows (3')

- `npm test` → eight suites green
- `node aggregator/scan-repo.js` → no secrets outside fixtures
- The three-model table: opus 100% / haiku 89.7% / sonnet 69% on the same 29 cases and the same
  prompt. The middle model is the worst, which is why the model is pinned in config rather than passed
  by hand.
- Then the gaps, in this order because the last one is the honest answer to the question everyone is
  about to ask: no negative-signal metric, so a session that produced nothing is invisible; never run
  on a production repo; and capture recall **cannot be measured** — it needs a denominator, how much
  knowledge a session contained, and that number does not exist.

## Questions that will come, with the short answer

| | |
| --- | --- |
| *"Why not RAG?"* | There is no query to retrieve against. The failure is an agent confidently doing the wrong thing and never knowing there was something to look up. README has the long version |
| *"How do you know it isn't missing things?"* | It is. Recall at capture has no denominator and cannot be measured. The comparison is not against perfect capture, it is against **0/3 sessions recording anything** and knowledge dying on one laptop |
| *"Our knowledge is on your personal cloud?"* | For the demo, yes. Moving it is changing one URL and reissuing credentials: no state is pinned to the host, `inbox/` is a queue rather than a record, and the distilled knowledge lives in the company's own git repo |
| *"Basic auth over the internet?"* | Real Let's Encrypt certificate, endpoint bound to loopback behind the proxy, per-member tokens stored as scrypt hashes, and identity taken from the credential rather than from the note. The last one is what stops a member forging a second contributor to reach the auto-apply path |
| *"What if an agent edits AGENTS.md itself?"* | One did, during measurement — it promoted an entry to `(confirmed, 2 people)` on its own recognisance. The header now tells agents not to, and `check-artifact.js` fails the build on a marker that does not parse. Worth telling rather than hiding: it is the clearest example of why the counts come from credentials |
