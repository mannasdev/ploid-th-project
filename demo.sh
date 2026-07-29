#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [ -f .env ]; then set -a; . ./.env; set +a; fi

export MEMORY_DB="${MEMORY_DB:-./memory.db}"
AS_OF="2026-07-23T12:00:00Z"

rm -f "$MEMORY_DB" "$MEMORY_DB"-wal "$MEMORY_DB"-shm

banner() { printf '\n=== %s\n' "$1"; }

banner "Ingest #launch transcript A (process 1)"
npx tsx src/ingest.ts fixtures/launch-a.json

banner "Ingest #launch transcript B in a NEW process (persistence + supersession)"
npx tsx src/ingest.ts fixtures/launch-b.json

banner "Ingest #platform-eng (process 3)"
npx tsx src/ingest.ts fixtures/platform-eng.json

QUESTIONS=(
  "When is the launch?"
  "Is Priya around this week?"
  "Who owns the launch checklist?"
  "Is there a deploy freeze next week?"
  "What did Dan say about the woods?"
  "What's the team rule about @here?"
)
for q in "${QUESTIONS[@]}"; do
  banner "Q: $q"
  npx tsx src/query.ts "$q" --as-of "$AS_OF"
done

banner "Memory store dump (note SUPERSEDED rows with pointers)"
npx tsx src/memories.ts
