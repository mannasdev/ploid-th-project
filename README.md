# Channel Memory — a memory brain for a Slack-observing agent

A TypeScript CLI that passively observes a team-chat transcript, decides what deserves to become a memory (most messages don't), and later answers questions from what it kept. The pipeline: transcripts → salience-filtered structured memories → subject-indexed SQLite with soft supersession → selective, two-stage retrieval Q&A. No memory framework, no vector DB — the judgment layer (what to keep, whose it is, when it's dead) is what this repo builds and what the design writeup below explains.

## Setup (clean machine)

```bash
node -v          # need >= 22 (better-sqlite3@13 requires it)
npm i
export ANTHROPIC_API_KEY=sk-ant-...
```

The key is read from the environment, never written to disk by this repo. If you'd rather not export it in your shell, drop it in a `./.env` file (`ANTHROPIC_API_KEY=sk-ant-...`) — `demo.sh` sources `.env` automatically when present; for the other commands, load it yourself first (`set -a; . ./.env; set +a`).

Optional env vars:
- `MEMORY_MODEL` — model id for the pipeline (extraction/reconcile/query). Default `claude-haiku-4-5`.
- `MEMORY_JUDGE_MODEL` — model id for eval grading only. Default `claude-sonnet-5` (deliberately stronger than the pipeline — see the LLM-judge note in the design writeup).
- `MEMORY_DB` — SQLite file path. Default `./memory.db`. (`:memory:` works for tests.)

**Cost note:** a full `npm run demo` + `npm run eval` run makes on the order of a few dozen small structured-output calls (windowed extraction, reconcile, two-stage query on Haiku, judge grading on Sonnet) and costs roughly **$0.20**; `npm run eval:holdout` adds about **$0.05**.

## Run the demo

```bash
npm run demo
```

`demo.sh` deletes any existing `./memory.db`, then runs, as **separate OS processes**, in order:

1. `ingest` transcript A (`fixtures/launch-a.json`) — first process, empty DB.
2. `ingest` transcript B (`fixtures/launch-b.json`) — a **new process**, contains the Aug 14 → Aug 21 launch-date supersession.
3. `ingest` transcript C (`fixtures/platform-eng.json`) — a second channel, a **new process**, contains a freeze-then-cancel supersession.
4. Six `query` calls, each its **own process**, including one that requires the *updated* launch date and one that baits noise recall ("What did Dan say about the woods?").
5. A `memories` dump — a final **new process** — showing active memories plus every superseded row and the pointer it was closed by.

Each step is a fresh `npx tsx ...` invocation with no shared process state; the only channel between steps is the SQLite file. That's deliberate: persistence across restarts is proven structurally (a later process can only see what an earlier process actually wrote to disk), not asserted in a comment.

Expected shape of the output (real excerpt from a run — exact statement wording is an LLM call and can vary slightly between runs, but the shape — labels, pointers, counts — should not):

```
=== Ingest #launch transcript A (process 1)
window 1: 3 fact(s)
  ADD       [channel:#launch] Launch is scheduled for 2026-08-14.
  ADD       [person:priya] Priya is out all of the week starting 2026-07-21 and returns on 2026-07-28.
  ADD       [person:sam] Sam owns the launch checklist while Priya is out.
window 2: 0 fact(s)

ingested #launch: 16 messages (16 new) → 3 facts (add 3, update 0, supersede 0, noop 0)

=== Ingest #launch transcript B in a NEW process (persistence + supersession)
window 1: 4 fact(s)
  ADD       [channel:#launch] A blocker was found in the billing migration that prevented the originally planned launch date.
  ↳ supersedes [1] "Launch is scheduled for 2026-08-14."
  SUPERSEDE [channel:#launch] Launch is scheduled for 2026-08-21.
  ...

=== Q: When is the launch?
The launch is scheduled for 2026-08-21.

=== Memory store dump (note SUPERSEDED rows with pointers)
ACTIVE:
  [5] (#launch channel:#launch deadline, decided, conf 0.99) Launch is scheduled for 2026-08-21.
  ...
SUPERSEDED:
  [1] Launch is scheduled for 2026-08-14.  → superseded by [5] at 2026-07-22T15:34:00Z
  [7] Deploy freeze begins on 2026-07-27 (Monday).  → superseded by [11] at 2026-07-23T10:07:00Z
```

```bash
npm run eval
```

Ingests all three fixtures into a fresh temp DB, then runs two independent checks and prints a scorecard:

- **13 LLM-judged QA scenarios** (`eval/scenarios.json`) across five categories — `single_hop`, `multi_hop`, `knowledge_update`, `abstention`, `attribution` — each graded by a Claude call that compares the system's answer to a gold answer.
- **8 deterministic store checks** that need no judge at all — plain TypeScript predicates over the memory rows: 7 substantive assertions like "the woods joke was never stored" or "the freeze decision's `superseded_by` points at a row whose statement is the cancellation, and that row is active" (`sc-freeze-lineage`), plus 1 regression guard (`sc-channel-subject`, which pins behavior already enforced in code).

```
single_hop        5/5
knowledge_update  2/2
abstention        3/3
attribution       1/1
multi_hop         2/2
store checks      8/8

all green
```

Non-zero exit on any failure, so it's CI-friendly.

**Individual commands**, one example each:

```bash
# ingest a transcript file
npx tsx src/ingest.ts fixtures/launch-a.json

# ask a question as of a specific point in time (affects "this week"-style resolution)
npx tsx src/query.ts "Is Priya around this week?" --as-of 2026-07-23T12:00:00Z

# dump the full memory store (active + superseded, with pointers)
npx tsx src/memories.ts
```

## Design writeup (~1 page)

### Memory model

Every memory is one row: `{ scope: person|channel, subject, kind: decision|deadline|availability|preference|ownership|fact, statement, certainty: decided|tentative, confidence, status: active|superseded, created_at, invalid_at, superseded_by, source_msg_ids }`, indexed on `(channel, status, subject)`. Two design choices carry the model:

- **Subject-indexed, not speaker-indexed.** `subject` is who or what the fact is *about* — "Priya is out until the 28th" files under `priya` no matter who said it; "launch is Aug 21" files under the channel, scope `channel`. This is the direct fix for the failure mode where naive systems attach facts to whoever spoke them, and it turns reconcile-candidate lookup into an exact indexed query instead of a similarity search.
- **Provenance is free.** `source_msg_ids` captured at extraction time lets every answer cite the raw messages that established it, and lets the eval assert lineage (not just "a memory changed" but "*this* memory was superseded *by that one*").

### Salience policy

One extraction call per 15-message window (the previous 5 messages are prepended read-only for reference resolution), prompted to output a list of durable facts. **An empty list is the expected, correct outcome for most windows — that emptiness is the salience filter itself**, not a separate scoring step applied afterward. The prompt is refusal-first: few-shot examples that produce zero facts (jokes, dropped speculation, chatter) come before examples that produce one, and the model is told to judge sincerity "by how the conversation proceeds, not by surface wording" — a joke others act on is a decision; a "decision" met with laughter and dropped is not.

Known failure modes: sarcasm needing context outside the window can slip through; a joke-disguised decision is judged by in-window conversational uptake, a real but imperfect signal; `confidence` is an uncalibrated model estimate; and with no separate scoring pass, a borderline fact is fully in or fully out — there's no "store it but weight it low."

### Supersession strategy

Each candidate fact is reconciled against the *active* memories with the same subject via one structured-output call choosing **ADD** (new), **UPDATE** (same fact, better wording), **SUPERSEDE** (contradicts an existing fact — newer wins), or **NOOP** (already known). Supersession is **soft**: the old row's `status` flips to `superseded`, gets an `invalid_at` timestamp and a `superseded_by` pointer to its replacement. Nothing is ever deleted — "wasn't wrong then, is dead now" is representable, and answers exclude superseded rows *by construction*, not by hoping retrieval ranks them low.

The reconciler's op choice passes through a code-enforced guard rather than being trusted (`applyCertaintyGuard`, `src/reconcile.ts`, exhaustively tested in `tests/guard.test.ts`): an unknown target on **any** op falls back to ADD; a **tentative fact never supersedes or rewords a decided one**; a **decided fact confirming a tentative one escalates to supersede** — whether the reconciler said UPDATE or NOOP — so a confirmation can never leave certainty stuck at tentative; and **chronology binds every mutation** — a fact never supersedes a target established after it, and an older fact's wording never replaces a newer row's (a backwards UPDATE demotes to a provenance-merging NOOP). What's still *not* code-enforced is the *content* of an UPDATE's merged statement — the actual wording it writes still depends on `RECONCILE_SYSTEM`'s prompt instructions (preserve every surviving qualifier, label new numbers/dates, don't fold in another subject's fact); the deterministic store checks in `npm run eval` are the backstop that would catch a bad merge, not a schema-level guarantee.

This backwards-in-time guard exists because of a real bug caught during a demo run. Within one window, the extractor can emit facts in an order that doesn't match their own message timestamps: a "blocker found" fact from *before* the new date got emitted after the "launch is now Aug 21" fact, and reconciling in that emission order let the older blocker-explanation fact supersede the Aug-21 fact it had been *established after* — closing the correct current launch date. The fix: facts are now sorted by their own source-message timestamp before reconciling (`src/ingest.ts`), and `applyCertaintyGuard` rejects any SUPERSEDE whose target postdates the candidate fact, demoting it to ADD instead (`src/reconcile.ts`, tested in `tests/guard.test.ts`). It's the strongest evidence for building the eval/demo harness early: the bug was invisible to isolated unit tests and only surfaced against real fixture data end-to-end, where it was fixable as a one-line invariant rather than a prompt-tuning guess.

Other known limitations: reconcile only sees same-subject candidates, so a contradiction under a different subject key escapes; one reconcile call targets exactly one memory; ingest assumes chronological order. And the reconciler is still an LLM call, not a deterministic function — in one observed run it misfiled which memory a supersession should target, caught after the fact by a store check added to verify lineage rather than just count (`sc-freeze-lineage`: the freeze decision's `superseded_by` must point at a row that is itself active and says the freeze was cancelled). The query layer, which only ever reads `active` rows, answered correctly regardless, but the store's history briefly had the wrong shape.

### Retrieval

Query is two stages over **active memories only**. Stage 1 shows the model a compact index (id + one-line summary per active memory) and asks it to select relevant ids — possibly none. Stage 2 answers using only the full records of the selected memories, hedging `tentative` facts and citing source messages. Abstention happens by construction at four layers: noise was (ideally) never stored; superseded facts never enter the index; the answering prompt is forbidden from answering outside the selected set and must say so plainly when that set is empty; and an answer that cites none of the offered memories is structurally refused and replaced with an abstention. `--as-of` sets an explicit reference time for resolving relative phrases like "this week"; without it, the CLI falls back to the timestamp of the latest ingested message.

### Key tradeoffs

**No framework.** The graded part of this assignment is the judgment layer — salience, attribution, supersession. A framework like Mem0 or Zep runs its own extraction and its own ADD/UPDATE/DELETE resolver the moment you call `add()`; using one means outsourcing exactly the part being evaluated, or fighting the framework to bypass it. This repo borrows the frameworks' validated ideas (retrieve-then-compare ops, soft invalidation with pointers) and implements them directly, in code that's fully inspectable.

**No vector DB, at this scale.** ~50 messages produce a few dozen memories; exact subject lookup is cheaper and more precise than similarity search here — "launch is Aug 14" and "launch is Aug 21" sit close together in embedding space, but only a status column can say which one is alive. I'd move reconcile-candidate lookup and query selection to hybrid (embedding + BM25) retrieval once the active-memory count reaches the thousands and exact lookup stops being the cheap option.

**LLM-judge caveat.** Eval QA scoring uses an LLM judge that by default runs on a *stronger* model (`claude-sonnet-5`; override with `MEMORY_JUDGE_MODEL`) than the pipeline under test (`claude-haiku-4-5`) — a same-tier judge produced flaky misgrades of demonstrably correct answers, and a same-model judge also maximizes self-preference risk. This is still an Anthropic-family judge grading an Anthropic-family system: bias is reduced, not eliminated, and the deterministic store checks remain the judge-free cross-check on the same data. Scores are mildly nondeterministic run to run: the tuned set typically lands 12–13/13 (the supporting-clause multi-hop is the flakiest scenario); store checks are 8/8 deterministically.

### Held-out generalization (`npm run eval:holdout`)

The tuned fixtures are also the data the prompts were iterated against, so their scorecard measures fit, not generalization. To measure the latter honestly, `eval/holdout/` contains a transcript and 10 scenarios **authored blind** — written against only the message format and a hard-case checklist, by an author who never saw this system's prompts or fixtures, in a domain (website redesign) excluded from every few-shot example. Policy: the holdout is run and reported **as-is** and is never used for prompt tuning; the moment it tunes anything, it stops being held out.

Result across four one-shot runs: **5–6/10** (6, 6, 6, 5 — two runs before and two after correcting one factually wrong gold answer against its own transcript; the correction is in the commit history) vs 13/13 tuned. Knowledge-update — a date moved 19 messages later — passed **all four** runs; most abstention and multi-hop cases held. The distinct failures decompose into: one gold-vs-design disagreement (the holdout gold expects a vetoed joke to be recalled-and-denied; this system deliberately never stores jokes and abstains instead); one real schema gap now quantified (the *requester* of an assignment isn't modeled — same class as the relayed-reporter limitation above); one unstable relative-weekday resolution ("back wednesday" mis-resolved in one run); one relayed third-party fact the salience filter dropped; and one state-vs-event case (the store records "the review is on the 17th," not the event of *deciding to move it*, so "was X back when the team decided…" can't be answered). One additional abstention scenario (a dependency-gated tentative) failed in one of the four runs. That 13/13 → 5–6/10 gap, with its decomposition, is the honest measure of where this system's judgment generalizes and where it doesn't. Prompt few-shot examples throughout the system are drawn from domains deliberately disjoint from the fixtures, and a regression test (`tests/prompt-integrity.test.ts`) asserts that no eval question or gold-answer text — tuned or held-out — appears verbatim in any prompt. (The test is an exact-substring tripwire; keeping example *domains* disjoint is a policy it cannot fully mechanize.)

### What I'd change for production

Trigger extraction on thread-end or conversational lulls instead of a fixed 15-message window, backed by an asynchronously refreshed channel summary. Move to hybrid (embedding + BM25) retrieval once subject-exact lookup stops scaling. Add real entity resolution instead of normalized name strings, so "P" and "Priya" don't create two subjects. Add decay/compaction so stale, low-value memories fade instead of accumulating forever. And add write-precision evals to CI — scenarios with a known-correct *store state* after ingest, not just known-correct answers, so a regression in what gets kept fails a build instead of shipping quietly.

## Assumptions & shortcuts

- One channel per transcript file (mixed-channel files are rejected at load time); messages are assumed chronological and are sorted by timestamp before processing.
- Subject identity is a normalized (trimmed, lowercased) name string — no cross-mention entity resolution, so "Priya" and a hypothetical "P." would be two different subjects.
- Re-ingesting an already-seen transcript is mostly absorbed by NOOP, not detected and skipped up front — messages themselves dedupe by content hash, but a repeated fact still costs a reconcile call.
- Single-writer CLI: no concurrency control around the SQLite file beyond what `better-sqlite3`'s WAL mode gives you for free (and WAL is a no-op against `:memory:`, used only in tests).
- `--as-of` is parsed with `Date.parse`, which accepts some non-ISO formats leniently — pass ISO-8601 timestamps as documented, not because anything else is rejected, but because anything else isn't guaranteed to mean what you think it means.
- Transcript timestamps must be UTC ISO-8601 ending in `Z`; this is enforced at load (`loadTranscript`, `src/transcript.ts`) with a specific error rather than accepted-and-hoped-for, because it's the precondition that makes sorting `ts` lexicographically (windowing, fact ordering) provably safe instead of accidentally safe.
- When a chronologically older fact arrives that contradicts a newer active one, the no-backwards-in-time-supersession guard demotes it to ADD rather than guessing which is "right" — the system conservatively keeps both facts active side by side instead of picking a winner from incomplete information. That's a documented tradeoff, not a gap: a stale-looking duplicate is a smaller failure than silently closing the correct current fact.
- Reconciliation scope is per-channel while retrieval is global: the same real-world fact can legitimately live in two channels' memories (the Aug-21 launch date does — once as the `#launch` deadline, once inside `#platform-eng`'s billing-fix fact), and a later change announced in only one channel supersedes only that channel's copy; the other channel's row stays active until its own channel corrects it. The production fix is cross-channel subject resolution; at this scale the duplication is visible in the dump and answers still resolve correctly.
- Relayed facts attribute to their subject, not their reporter: "marta from legal says the DPA is signed" stores a channel-level DPA fact whose provenance points at the *relaying* message's author — "who asserted this" beyond message authorship is not modeled, so a misreport by the relayer is indistinguishable from a first-hand statement.
- `confidence` is extracted, clamped, and stored but not yet consumed by retrieval or answering — it's schema headroom for ranking/decay, not a live signal.
- When a message mixes a vague range with a concrete date in the same breath ("out all next week — back the 28th"), extraction is prompted to anchor on the stated concrete date rather than the precomputed relative one, since an explicit date is the stronger, less ambiguous signal.
- A malformed LLM response (no valid tool call at all) fails the ingest loudly — `Llm.structured` throws and the CLI exits non-zero — rather than being silently skipped; a per-fact schema mismatch inside an otherwise-valid response is the narrower case that's dropped with a logged warning (`extractFacts`, `src/extract.ts`).

## Where AI helped

I used Claude for prior-art research (reading up on how Mem0, Zep/Graphiti, and the long-memory benchmark literature approach salience, attribution, and supersession, so I wasn't reinventing vocabulary or missing well-known failure modes), for scaffolding the CLI/module layout, for drafting the transcript fixtures against a list of hard cases I specified, and for iterating on the extraction/reconcile/query prompts against failing eval scenarios. The design decisions — subject-indexed storage over speaker-indexed, soft supersession with pointers over hard delete, the code-enforced reconcile guard, and the choice to skip a framework and a vector DB at this scale — are mine, reasoned about above and defended on their own terms rather than because AI proposed them. One concrete override: the backwards-in-time supersession bug described above was surfaced by AI-driven review of a real demo run, but the fix I chose — a code-level invariant plus chronological reconcile ordering, not a prompt instruction — was a deliberate call to keep that guarantee out of the LLM's hands.
