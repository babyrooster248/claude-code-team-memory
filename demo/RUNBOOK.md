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

## Act 1 — the correction, live (6')

The knowledge the demo carries is not in the code, so it cannot be discovered — it has to arrive from
a person. That is what this act is: the tech lead says one sentence he has said to every new joiner,
and it is captured without anyone asking for it.

**Turn 1**, in a fresh Claude Code session in the project directory:

```
Thêm lệnh export để xuất report ra file CSV, tôi cần gửi cho bên tài chính.
```

The agent writes it with `InvariantCulture`, a `,` delimiter and `.` decimals. **Say out loud that
this is the correct answer from reading the code** — it matters that the audience sees the agent do
something reasonable rather than something stupid.

**Turn 2** — the correction:

```
Sai rồi. Bên tài chính mở file bằng Excel locale vi-VN nên dấu phẩy làm vỡ cột hết, phải dùng
dấu chấm phẩy. Lần trước gửi sai đã phải làm lại toàn bộ báo cáo tháng. Sửa lại đi.
```

**Beat landed if:** the agent fixes the delimiter and writes a note. **Verified**, and it did more
than asked — it also changed the decimal separator, because vi-VN Excel reads `42.00` as text, and it
wrote two notes: one about this export, one a general lesson about not defaulting to invariant for a
file a person opens.

Read the note out. The line that matters is the one no model could have produced:

> *"a previous wrong send cost them a full redo of the monthly report. None of these failures are
> visible locally — the file looks fine in a terminal."*

**The point to land:** how many times has someone in this room explained that to a new joiner? It was
captured once, by nobody doing anything extra.

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

**Measured on this host: 81s and 68s** on 958 MB of RAM. That fits inside act 2, so by the time you
look, the run has finished. Two runs is also normal and worth pointing at — notes arriving while the
first was in flight trigger exactly one follow-up, not one run per note.

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

**Verified:** deletion-as-rejection and hand-edit tolerance are covered by 16 automated cases, and a
real run produced a genuine conflict to reconcile — a session disproved a stale entry, and the merge
kept both lines, marked them disputed, and said so in the commit subject rather than picking a winner.
That is a better act 4 than a wording change: the reviewer has an actual decision to make.

## Act 5 — the colleague's machine (6')

### 5a — a different task, a person who was never told (4')

They `git pull`, then a task that is **not** the one from act 1:

```
Thêm lệnh export-categories để xuất danh sách category ra CSV gửi bên tài chính.
```

**Beat landed if:** without being told anything, the agent uses `;`, vi-VN decimals with the culture
pinned rather than `CurrentCulture`, UTF-8 with BOM, and quoting keyed on `;`.

**Verified.** On a fresh checkout with no memory and no export code, it did all of that — and verified
the output with a hexdump rather than by eye, **because the entry says the file always looks fine in a
terminal**. It also used the other entry to avoid setting up test data with the `update` command it
knew to be silently broken.

That is the claim of the whole project in one screen: a correction someone made once, applied
correctly by a different person's agent, on a task nobody had done before.

Do **not** show the cost table. `docs/findings.md` §11 has it for anyone who asks, and an audience
does not pay attention to a table proving something they already believe.

### 5b — the loop closes

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
