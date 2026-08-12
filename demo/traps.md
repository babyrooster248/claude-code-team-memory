# What is planted in the sample project, and why

For whoever is presenting: this is how you know a beat actually happened rather than nearly happened.

The stack is a .NET 10 console app on EF Core 10 + SQLite. .NET because the audience is a .NET team
and a trap they recognise is worth more than a trap that is merely true; SQLite because it is real EF
Core with real migrations and **no database server and no Docker** — the two things most likely to
fail in a meeting room. Migrations are applied in code with `Database.Migrate()`, so nobody needs the
`dotnet-ef` tool installed to take part.

Everything below was run before it was written down. Two candidate traps were **dropped** for failing
to reproduce, which is recorded at the bottom because "we tried it and it did not happen" is the part
usually left out.

## The three that are in

| | What the developer sees | What is actually wrong | Where it is used |
| --- | --- | --- | --- |
| **T1** | `dotnet run -- seed` prints *"could not read the catalog store. Check ConnectionStrings:Catalog in appsettings.json, and that the data directory is writable"* | No migration has ever been applied. The seeder catches `SqliteException` and blames configuration, so you go and read `appsettings.json` and check file permissions | **Act 1**, live, on the presenter's machine |
| **T2** | `dotnet run -- update 1 "New label"` prints *`updated item 1 to "New label"`* and exits 0 | `AsNoTracking()` on a write path. The entity comes back detached, `SaveChanges()` has nothing to save, and the old value stays in the database. **No exception, no warning** | **Act 5**, live, on the colleague's machine |
| **T3** | `dotnet run -- report` returns six rows | Three of them are soft-deleted — one item and a whole category. There is no `HasQueryFilter`, so every query has to remember `IsDeleted` by hand, and nothing fails when it does not | Pre-seeded `AGENTS.md` entry, not a live act |

**T1 is the visible one.** It fails immediately, the message is confidently wrong, and recovering from
it is one command. That makes it the right opening: the audience sees the agent get misled, work it
out, and write it down.

**T2 is the better trap and the worse demo.** A command that reports success and does nothing is the
kind of bug that survives review, and the agent only finds it by *verifying* rather than trusting the
output. Give the task as "rename item 1 and confirm it took effect" — a natural instruction, not a
hint. If the agent does not verify, it will report success too, and that is worth saying out loud:
it is the same failure the code has, one level up.

**T3 never fires.** Nothing breaks; the wrong rows just come back. That is exactly why it belongs in
the artifact rather than on stage — an invisible failure makes a poor live beat and a valuable note.

## What a captured note should contain

If the note does not name the string somebody would paste into a search box, the beat only half
happened. For T1 that is the phrase from the misleading message plus the real cause. For T2 it is
`AsNoTracking` and the word "silently". A note that says "run migrate first" and nothing else has
recorded the fix without recording the symptom, so the next person still loses the afternoon.

## The two that were dropped

**Decimal ordering on SQLite.** EF Core maps `decimal` to a TEXT column, and text sorts
lexicographically, so `ORDER BY Price` should have put `100.00` before `42.00`. It does not. Two
attempts produced correctly ordered output; logging the generated SQL showed why — EF Core 10 emits
`ORDER BY "Price" COLLATE EF_DECIMAL`, a collation the provider registers for exactly this case. The
first attempt failed for a second reason worth knowing: an explicit `HasColumnType("decimal(18,2)")`
gives the column NUMERIC affinity under SQLite's type rules, which sorts numerically anyway. So the
trap was fixed twice over, once by the library and once by accident.

**`dotnet ef` writing to a different database than the app.** Modelled on a real note about a
containerised app, where the tool on the host and the app in the container genuinely disagree about
the connection string. Here they agree: `AppContext.BaseDirectory` resolves to the same build output
directory at design time and at run time, and `dotnet ef database update` touched the same file the
app uses. Reproducing it would have meant contriving a split that this project does not have, and a
contrived trap teaches the audience to discount the ones that are real.

Both are recorded rather than quietly removed, because a demo built on traps that "should" fire is a
demo that finds out in front of an audience.

## One detail that makes T1 work

The failure message tells you to check `ConnectionStrings:Catalog` in `appsettings.json`. That file
**exists**, is copied to the output, holds a plausible connection string — and nothing reads it:
`CatalogContext` hard-codes its own. If the file were missing, the agent would know within seconds
that the message was fabricated and the trap would collapse. Because it is there and looks right, the
message costs real time, which is the whole point.

Configuration the code quietly ignores is also one of the more common things a newcomer loses an hour
to, so this detail is not only stagecraft.
