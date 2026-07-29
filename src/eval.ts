import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from './config.js';
import { Llm } from './llm.js';
import { MemoryStore } from './store.js';
import { ingestTranscript } from './ingest.js';
import { answerQuestion } from './query.js';
import type { Memory } from './types.js';

interface Scenario {
  id: string;
  category: 'single_hop' | 'multi_hop' | 'knowledge_update' | 'abstention' | 'attribution';
  question: string;
  as_of: string;
  expected: string;
}

const JUDGE_SYSTEM = `You grade a memory system's answer against a gold answer. Verdict "correct" if the answer conveys the gold answer's substance — wording may differ and extra accurate context is fine. Verdict "incorrect" if it contradicts the gold answer, misses its key fact, or gives a confident answer where the gold says the correct behavior is to abstain.
Grade by checklist, not by diff: list each fact the gold answer requires, then check whether the system answer states each one correctly. If every required fact is present and correct, the verdict is "correct" — regardless of how much additional material the answer includes. Additional facts (other dates, names, reasons) are only a problem when one of them asserts a DIFFERENT value for the SAME question a gold fact answers; information answering a different question is never a contradiction, even when it is the same kind of value (another date, another number) in the same sentence.
Example: gold "Nadia returns 2027-03-04." System answer "Omar handles the release, which ships 2027-04-15; Nadia returns 2027-03-04." → correct: the ship date answers a different question than Nadia's return; the required fact is present and right.
One-sentence reason.`;

const JUDGE_SCHEMA = {
  type: 'object',
  properties: { verdict: { enum: ['correct', 'incorrect'] }, reason: { type: 'string' } },
  required: ['verdict', 'reason'],
} as const;

interface StoreCheck {
  id: string;
  description: string;
  run: (all: Memory[]) => boolean;
}

const STORE_CHECKS: StoreCheck[] = [
  {
    id: 'sc-woods',
    description: 'the woods joke was never stored (any status)',
    run: (all) => !all.some((m) => /woods/i.test(m.statement)),
  },
  {
    id: 'sc-party',
    description: 'unresolved party/venue speculation was never stored',
    run: (all) => !all.some((m) => /party|rooftop|ramen/i.test(m.statement)),
  },
  {
    id: 'sc-aug14',
    description: 'Aug 14 launch date exists, is superseded, and its supersession chain terminates in an active row; no active Aug 14 remains; a decided Aug 21 launch deadline is active',
    run: (all) => {
      // Availability facts may mention dates in passing (e.g. an OOO range); only
      // launch-date-bearing rows belong to this lineage assertion.
      const aug14 = all.filter((m) => /2026-08-14/.test(m.statement) && m.kind !== 'availability');
      // An active row may reference the old date descriptively while stating the
      // new one ("moved from the original date") — that is not a stale claim. What
      // must never exist is an active row carrying the old date WITHOUT the
      // current date: a naked Aug-14 assertion.
      if (
        !aug14.some((m) => m.status === 'superseded' && m.superseded_by !== null) ||
        aug14.some((m) => m.status === 'active' && !/2026-08-21/.test(m.statement))
      ) return false;

      const byId = new Map(all.map((m) => [m.id, m]));
      for (const row of aug14.filter((m) => m.status === 'superseded')) {
        const seen = new Set<number>();
        let current: Memory = row;
        while (current.status === 'superseded' && current.superseded_by !== null) {
          if (seen.has(current.id)) return false; // cycle
          seen.add(current.id);
          const next = byId.get(current.superseded_by);
          if (!next) return false; // missing pointer target
          current = next;
        }
        if (current.status !== 'active') return false;
      }

      // kind is deliberately loose here: a date change legitimately extracts as
      // 'deadline' or 'decision' depending on phrasing — the assertion's point is
      // that an active #launch row carries the Aug 21 date with decided certainty.
      return all.some(
        (m) =>
          m.status === 'active' &&
          (m.kind === 'deadline' || m.kind === 'decision') &&
          m.channel === '#launch' &&
          m.certainty === 'decided' &&
          /2026-08-21/.test(m.statement),
      );
    },
  },
  {
    id: 'sc-priya',
    description: "Priya's availability is a person-scoped fact about priya with an absolute date",
    run: (all) =>
      all.some(
        (m) => m.scope === 'person' && m.subject === 'priya' && m.status === 'active' && /2026-07-28/.test(m.statement),
      ),
  },
  {
    id: 'sc-certainty-guard',
    description: 'the Aug 21 launch date is active+decided, and any announcement-email memory stayed tentative',
    run: (all) =>
      all.some((m) => /2026-08-21/.test(m.statement) && m.status === 'active' && m.certainty === 'decided') &&
      all.filter((m) => /email/i.test(m.statement)).every((m) => m.certainty === 'tentative'),
  },
  {
    id: 'sc-supersession-count',
    description: 'at least two supersessions occurred (launch date + deploy freeze)',
    run: (all) => all.filter((m) => m.status === 'superseded').length >= 2,
  },
  {
    id: 'sc-freeze-lineage',
    description: 'the freeze decision was superseded BY the cancellation fact (target-aware, not just counted)',
    run: (all) => {
      const frozen = all.find(
        (m) => /freeze/i.test(m.statement) && m.status === 'superseded' && m.superseded_by !== null,
      );
      if (!frozen) return false;
      const successor = all.find((m) => m.id === frozen.superseded_by);
      return (
        successor !== undefined &&
        successor.status === 'active' &&
        /cancel|scrap|no deploy freeze|no freeze/i.test(successor.statement)
      );
    },
  },
  {
    id: 'sc-channel-subject',
    description: 'regression guard: channel-scoped subjects are pinned to the channel in code (extract.ts), so this can only fail if that normalization regresses',
    run: (all) => all.filter((m) => m.scope === 'channel').every((m) => m.subject === m.channel),
  },
];

const FIXTURES = ['fixtures/launch-a.json', 'fixtures/launch-b.json', 'fixtures/platform-eng.json'];

async function main(): Promise<void> {
  const cfg = loadConfig();
  const dir = mkdtempSync(join(tmpdir(), 'memory-eval-'));
  const dbPath = join(dir, 'eval.db');
  console.log(`eval db: ${dbPath}`);
  try {
    const store = new MemoryStore(dbPath);
    const llm = new Llm(cfg);
    // The judge runs on a stronger model than the pipeline under test: grading
    // noise from a small judge showed up as flaky misgrades of correct answers,
    // and a same-model judge also maximizes self-preference risk.
    const judgeLlm = new Llm({ ...cfg, model: process.env['MEMORY_JUDGE_MODEL'] ?? 'claude-sonnet-5' });

    console.log('--- ingest ---');
    for (const f of FIXTURES) await ingestTranscript(store, llm, f);

    console.log('\n--- store checks ---');
    const all = store.allMemories();
    let storeFails = 0;
    for (const check of STORE_CHECKS) {
      const ok = check.run(all);
      if (!ok) storeFails += 1;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${check.id}: ${check.description}`);
    }

    console.log('\n--- QA scenarios ---');
    const scenarios = JSON.parse(readFileSync('eval/scenarios.json', 'utf8')) as Scenario[];
    // Ingestion is complete and the store is read-only from here, so scenario
    // chains are independent — run them concurrently, report in file order.
    const results = await Promise.all(
      scenarios.map(async (s) => {
        const { answer } = await answerQuestion(store, llm, s.question, s.as_of);
        const judged = await judgeLlm.structured<{ verdict: string; reason: string }>({
          system: JUDGE_SYSTEM,
          user: `Question: ${s.question}\nGold answer: ${s.expected}\nSystem answer: ${answer}`,
          toolName: 'grade',
          toolDescription: 'Grade the system answer against the gold answer.',
          schema: JUDGE_SCHEMA,
          maxTokens: 300,
        });
        return { s, answer, judged };
      }),
    );
    const byCategory = new Map<string, { pass: number; total: number }>();
    let qaFails = 0;
    for (const { s, answer, judged } of results) {
      const ok = judged.verdict === 'correct';
      if (!ok) qaFails += 1;
      const cat = byCategory.get(s.category) ?? { pass: 0, total: 0 };
      cat.total += 1;
      if (ok) cat.pass += 1;
      byCategory.set(s.category, cat);
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${s.id} [${s.category}] ${s.question}`);
      if (!ok) console.log(`      answer: ${answer}\n      judge: ${judged.reason}`);
    }

    console.log('\n--- scorecard ---');
    for (const [cat, { pass, total }] of byCategory) console.log(`${cat.padEnd(17)} ${pass}/${total}`);
    console.log(`store checks      ${STORE_CHECKS.length - storeFails}/${STORE_CHECKS.length}`);
    store.close();

    if (storeFails + qaFails > 0) {
      console.error(`\n${storeFails + qaFails} failure(s)`);
      process.exitCode = 1;
      return;
    }
    console.log('\nall green');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
