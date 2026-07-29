# Channel Memory — a memory brain for a Slack-observing agent

A TypeScript CLI that passively observes a team-chat transcript, decides what deserves to become a memory (most messages don't), and later answers questions from what it kept. The pipeline: transcripts → salience-filtered structured memories → subject-indexed SQLite with soft supersession → selective, two-stage retrieval Q&A. No memory framework, no vector DB — the judgment layer (what to keep, whose it is, when it's dead) is what this repo builds.

**Why it's built this way → [DESIGN.md](DESIGN.md)** (memory model, salience policy, supersession strategy, retrieval, eval design including the held-out generalization results, tradeoffs, production notes).

## Setup (clean machine)

```bash
node -v          # need >= 22 (better-sqlite3@13 requires it)
npm i
export ANTHROPIC_API_KEY=sk-ant-...
```

The key is read from the environment, never written to disk by this repo. If you'd rather not export it in your shell, drop it in a `./.env` file (`ANTHROPIC_API_KEY=sk-ant-...`) — `demo.sh` sources `.env` automatically when present; for the other commands, load it yourself first (`set -a; . ./.env; set +a`).

Optional env vars:
- `MEMORY_MODEL` — model id for the pipeline (extraction/reconcile/query). Default `claude-haiku-4-5`.
- `MEMORY_JUDGE_MODEL` — model id for eval grading only. Default `claude-sonnet-5` (deliberately stronger than the pipeline — see DESIGN.md § Eval design).
- `MEMORY_DB` — SQLite file path. Default `./memory.db`. (`:memory:` works for tests.)

**Cost note:** a full `npm run demo` + `npm run eval` run makes on the order of a few dozen small structured-output calls and costs roughly **$0.20**; `npm run eval:holdout` adds about **$0.05**.

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

=== Ingest #launch transcript B in a NEW process (persistence + supersession)
window 1: 4 fact(s)
  ...
  ↳ supersedes [1] "Launch is scheduled for 2026-08-14."
  SUPERSEDE [channel:#launch] Launch is scheduled for 2026-08-21.

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

## Run the evals

```bash
npm run eval            # tuned fixtures: 13 LLM-judged QA scenarios + 8 deterministic store checks
npm run eval:holdout    # blind-authored held-out set, reported as-is
```

`npm run eval` ingests all three fixtures into a fresh temp DB, grades 13 QA scenarios across five categories (`single_hop`, `multi_hop`, `knowledge_update`, `abstention`, `attribution`) with an LLM judge, and runs 8 deterministic store checks that need no judge. Non-zero exit on any failure, so it's CI-friendly. Expected scorecard:

```
single_hop        5/5
knowledge_update  2/2
abstention        3/3
attribution       1/1
multi_hop         2/2
store checks      8/8

all green
```

`npm run eval:holdout` runs the same harness on `eval/holdout/` — a transcript and scenarios authored blind, in a domain excluded from every prompt example, scoring **5–6/10**. That gap vs the tuned 13/13 is deliberate, honest, and explained with a per-failure decomposition in [DESIGN.md § Held-out generalization](DESIGN.md#held-out-generalization-npm-run-evalholdout).

**Individual commands**, one example each:

```bash
# ingest a transcript file
npx tsx src/ingest.ts fixtures/launch-a.json

# ask a question as of a specific point in time (affects "this week"-style resolution)
npx tsx src/query.ts "Is Priya around this week?" --as-of 2026-07-23T12:00:00Z

# dump the full memory store (active + superseded, with pointers)
npx tsx src/memories.ts
```

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

I used Claude for prior-art research (reading up on how Mem0, Zep/Graphiti, and the long-memory benchmark literature approach salience, attribution, and supersession, so I wasn't reinventing vocabulary or missing well-known failure modes), for scaffolding the CLI/module layout, for drafting the transcript fixtures against a list of hard cases I specified, and for iterating on the extraction/reconcile/query prompts against failing eval scenarios. The design decisions — subject-indexed storage over speaker-indexed, soft supersession with pointers over hard delete, the code-enforced reconcile guard, and the choice to skip a framework and a vector DB at this scale — are mine, reasoned about in DESIGN.md and defended on their own terms rather than because AI proposed them. One concrete override: the backwards-in-time supersession bug described in DESIGN.md was surfaced by AI-driven review of a real demo run, but the fix I chose — a code-level invariant plus chronological reconcile ordering, not a prompt instruction — was a deliberate call to keep that guarantee out of the LLM's hands.
