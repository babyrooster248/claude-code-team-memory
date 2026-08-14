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
| Second member on ONE machine | Only if you cannot get a real second machine, and then: give that clone a different `autoMemoryDirectory`. Both clones inherit the same committed value, which is correct across machines and collides on one — the second agent otherwise writes into, and reads, the first member's memory. Check `~/.agent-knowledge-spool` is empty first: it is shared per machine, so a queued note is flushed with whichever credential runs next. Expect the "one Claude account, two credentials" warning unless you also switch Claude accounts |
| Colleague | A **fresh clone**, `.claude/agent-knowledge.env` filled in with *their* credential, a git identity of their own, and **Claude Code opened in that directory once with the trust dialog accepted**. Skip the trust dialog and act 5 dies quietly: hooks declared in a project's settings do not run in an untrusted workspace, so the agent works, writes nothing to the host, and nothing anywhere says why |
| A different Claude account | **Not the one running on the host.** Identity comes from the credential, but the endpoint also watches the Claude account behind it, and one account presenting two credentials is one person who could promote an entry alone. It warns and does not refuse — so a `(2 people)` reached that way is a number the file cannot stand behind. Rehearsal tripped this: laptop and VM were signed into the same account |
| Inbox drained | **Empty it, or act 3 overruns.** Every run re-filters every note in the inbox, three votes each, so the run time grows with the queue: 106s for 2 notes, 155s for 5, **281s for 6** — measured on this host. Act 3 assumes the run finished during act 2's two minutes, which holds for one fresh note and nothing else |
| Node | `node --version` on both machines. The sample project is plain node with no dependencies, so there is nothing to install and nothing to fail in the room |
| Fresh state | `node demo/setup-project.js --dest <path> --stack node --seeded --ingest https://<host> --project catalog-svc`. **With** `--seeded`, so `AGENTS.md` starts with four reviewed entries: an empty file would make act 4 (a reviewer deleting a line) and act 5 (promoting one to `(2 people)`) have nothing to act on. What the room watches is the *diff* against those four, which is also what a real team's second week looks like. See findings §17 for everything a reset has to include, the repo's own git history included |

## Act 1 — the correction, live (6')

The knowledge the demo carries is not in the code, so it cannot be discovered — it has to arrive from
a person. That is what this act is: the tech lead says one sentence he has said to every new joiner,
and it is captured without anyone asking for it.

**Turn 1**, in a fresh Claude Code session in the project directory:

```
Thêm lệnh export để xuất report ra file CSV, tôi cần gửi cho bên tài chính.
```

The agent writes a `,` delimiter and `.` decimals — the invariant defaults. **Say out loud that
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
reasons, the gate says `NEEDS A PERSON`, and the branch `agent-knowledge` was committed, pushed, and — if `prCommand` is configured on the host — the pull request is already open with nobody having clicked anything.

The branch name is fixed, not dated, so there is **at most one open request** for the artifact: a later run adds a commit to the request already under review rather than opening a competing one. That rule cost two wrong pull requests to learn; findings §18 has both.

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

### 5b — the loop closes, and why it needs a second prompt

The task above will **not**, on its own, produce a note. Rehearsed and confirmed: the agent read the
entry, applied it perfectly, and wrote nothing — because it learned nothing. Applying a documented
convention is not a discovery, and discovery is what the capture rule waits for.

That is not a defect to work around on stage. It is the same fact as 5a seen from the other side, and
worth saying out loud: **5a succeeds precisely when the artifact stops the agent discovering anything,
and 5b needs a discovery.** One task cannot deliver both.

So 5b is a second prompt: correct something the agent just did that was reasonable and wrong for this
project. In rehearsal, the categories export defaulted to live-only — matching `export.js`, and
matching k1's advice — and the correction was that finance needs the inactive rows to reconcile last
month's invoices:

```
Không đúng. Bản gửi tài chính phải có cả category đã ngừng bán. Họ đối soát các dòng của tháng
trước, mà những dòng đó trỏ vào category cũ — thiếu là họ không khớp được rồi lại hỏi ngược lại
mình. Chỉ bản cho storefront mới lọc active thôi. Sửa mặc định lại đi.
```

**Verified.** A note appeared, was accepted under the second credential, survived intake, and reached
the open pull request as a new entry whose state line carries a **different contributor id** from
every other line. That id is the thing to point at: it is derived from the authenticated credential,
so it is the proof that this came from a second person on a second machine rather than from a header
anyone could have typed.

**On promotion to `(2 people)`, say the true thing rather than the hoped-for one.** It did not
happen in rehearsal and it is rare by construction: promotion needs two people to hit the *same*
thing independently, and the artifact exists to stop the second one hitting it. Counts therefore grow
mostly from confirmations people volunteer, not from repeated accidents — so `(3 people)` does not
mean three people were bitten. If you want to attempt it live, use a symptom rather than a task, so
the agent has to look rather than read:

```
Tài chính bảo số trong report gửi lên không khớp với storefront. Tìm nguyên nhân đi.
```

This is the shape that produced the one real promotion so far (2→3 on k1). It is still a coin flip,
so do not promise it before it lands.

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
