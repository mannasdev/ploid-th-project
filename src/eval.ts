import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
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
If the answer contains multiple dates or numbers, find the specific clause that states what the gold answer states, and compare only that clause to the gold — a different, unrelated date or number mentioned elsewhere in the same answer is not a contradiction, it's extra accurate context, even if it sits right next to the one you're checking.
Example: gold "X returns 2026-07-28." System answer "Y owns the task for the 2026-08-21 project, and X returns 2026-07-28." → correct: the 2026-08-21 is a different, unrelated fact, not a contradiction of X's return date.
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
    description: 'Aug 14 launch date exists, is superseded, and points at its replacement; no active Aug 14 remains',
    run: (all) => {
      const aug14 = all.filter((m) => /2026-08-14/.test(m.statement) && m.kind !== 'availability');
      return (
        aug14.some((m) => m.status === 'superseded' && m.superseded_by !== null) &&
        !aug14.some((m) => m.status === 'active')
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
];

const FIXTURES = ['fixtures/launch-a.json', 'fixtures/launch-b.json', 'fixtures/platform-eng.json'];

async function main(): Promise<void> {
  const cfg = loadConfig();
  const dbPath = join(mkdtempSync(join(tmpdir(), 'memory-eval-')), 'eval.db');
  const store = new MemoryStore(dbPath);
  const llm = new Llm(cfg);

  console.log(`eval db: ${dbPath}\n--- ingest ---`);
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
  const byCategory = new Map<string, { pass: number; total: number }>();
  let qaFails = 0;
  for (const s of scenarios) {
    const { answer } = await answerQuestion(store, llm, s.question, s.as_of);
    const judged = await llm.structured<{ verdict: string; reason: string }>({
      system: JUDGE_SYSTEM,
      user: `Question: ${s.question}\nGold answer: ${s.expected}\nSystem answer: ${answer}`,
      toolName: 'grade',
      toolDescription: 'Grade the system answer against the gold answer.',
      schema: JUDGE_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 300,
    });
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
    process.exit(1);
  }
  console.log('\nall green');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
