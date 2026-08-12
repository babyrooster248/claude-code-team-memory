# What knowledge the demo carries, and why a model cannot infer it

For whoever is presenting. Everything here was run before it was written down, including the two
things that did not work.

## The rule this file exists to respect

`merge-prompt.md` applies one test to every line of the artifact:

> Remove the line. Would a new agent now do the wrong thing?

A line an agent can derive by reading the code fails that test. The first version of this demo ignored
it and planted three technical traps in the sample project. Measured over three sessions, **a capable
agent found them unaided**: it read `OnModelCreating`, saw no `HasQueryFilter`, and worked out that
four of six rows were live — the same conclusion an agent holding the artifact reached. In six source
files nothing is hidden.

So the demo does not pretend the artifact helps with anything the codebase states. It carries the
knowledge that is genuinely unavailable to a model: **who consumes the output, and what happened the
last time somebody got it wrong.**

## The knowledge

**The finance team opens the exported CSV in Excel under a vi-VN locale.**

| | |
| --- | --- |
| What an agent writes unprompted | `InvariantCulture`, `,` delimiter, `.` decimals. Reading the code, this is the correct answer |
| What the project needs | `;` delimiter, `,` decimals from a pinned `vi-VN` culture, UTF-8 **with** BOM, quoting keyed on `;` |
| Why no model can know | It depends on which application opens the file, in which locale, and on the fact that a previous wrong send cost a full redo of the monthly report |
| How it fails | Silently, and only on the recipient's machine. `42.00` arrives in vi-VN Excel as text, and `SUM()` returns 0. The file looks perfect in a terminal |

Nothing about that is in the repository. It is in the tech lead's head, and it gets re-explained to
every new joiner — which is the entire argument for the tool, stated in one example the room will
recognise.

## How it gets captured: a correction, not a discovery

Project knowledge does not arrive by an agent tripping over it. It arrives when a person says *"no,
not like that, and here is why"*. That is one of the triggers the `CLAUDE.md` instruction names, and
it is the one the demo exercises.

Turn 1 — the agent does the reasonable thing:

```
Thêm lệnh export để xuất report ra file CSV, tôi cần gửi cho bên tài chính.
```

Turn 2 — the correction, which is the whole demo in one sentence:

```
Sai rồi. Bên tài chính mở file bằng Excel locale vi-VN nên dấu phẩy làm vỡ cột hết, phải dùng
dấu chấm phẩy. Lần trước gửi sai đã phải làm lại toàn bộ báo cáo tháng. Sửa lại đi.
```

**Verified.** The agent fixed the delimiter, went further and fixed the decimal separator too, and
wrote two notes without being asked — one about this export, one a general lesson about not defaulting
to invariant for files a person opens.

## What the sample project still provides

The .NET console app is no longer where the knowledge lives, but it still has to be a real project
with real failures, or there is nothing to work on. Three remain, and their role has changed:

| | Behaviour | Role now |
| --- | --- | --- |
| `seed` before `migrate` | Fails with *"could not read the catalog store. Check ConnectionStrings:Catalog"* — a caught exception blaming configuration | Background realism. **Do not build a beat on it**: agents ran `migrate` first in every session observed |
| `update <id> <label>` | Prints success, writes nothing. `AsNoTracking()` on a write path | Found unaided by agents, twice, incidentally. Useful as an *entry* the artifact carries, not as a live surprise |
| `report` | Returns soft-deleted rows; no `HasQueryFilter` anywhere | Same. Found unaided in both arms |

The agent that had the artifact used the `update` entry to avoid setting up test data with a command
it knew to be broken. That is the artifact earning its place on a technical entry — not by revealing
the bug, but by saving the time it takes to rediscover it.

## The two candidates that were dropped

**Decimal ordering on SQLite.** EF Core maps `decimal` to TEXT, and text sorts lexicographically, so
`ORDER BY Price` should have put `100.00` before `42.00`. It does not. Logging the generated SQL showed
EF Core 10 emitting `ORDER BY "Price" COLLATE EF_DECIMAL`, a collation the provider registers for
exactly this case. A first attempt had also failed for a second reason: an explicit
`HasColumnType("decimal(18,2)")` gives NUMERIC affinity under SQLite's type rules and sorts numerically
anyway. Fixed twice over, once by the library and once by accident.

It survives as a **deliberately stale entry** in the pre-seeded artifact, so a session can exercise the
one capture trigger nothing else does — finding that an existing note is now wrong — and so the demo
has something honest to say about the problem this project cannot solve.

**`dotnet ef` writing to a different database than the app.** Modelled on a real note about a
containerised app where host tool and container app genuinely disagree. Here they agree:
`AppContext.BaseDirectory` resolves to the same output directory at design time and run time. Contriving
a split would teach the audience to discount the traps that are real.

## One detail that keeps the sample honest

**No comment in the sample source explains any of this.** The first version had them, written for a
human reading the repository, and the agent read them and narrated the trap before hitting it — the
same mistake as the artifact header that used to say *"Edit freely"* and was read by agents as
permission. A file with two audiences will have one of them act on words written for the other. All
explanation lives here, in the tool's repository, never inside the project under test.
