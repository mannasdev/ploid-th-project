import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { Llm } from './llm.js';
import { MemoryStore } from './store.js';
import type { Memory } from './types.js';

export const SELECT_SYSTEM = `You are the retrieval stage of a memory system. Given a question and an index of stored memories (one line each), return the ids of ONLY the memories needed to answer it. Relevance is strict: do not include loosely related memories — they pollute the answer. An empty list is the correct output when nothing is relevant.
- If the question asks WHY something happened, include the memory stating that outcome AND the memory that gives its direct, immediate reason for THAT SAME outcome (same channel/subject and same event) — never a memory explaining a different, earlier decision just because it shares a keyword.
- If the question asks for multiple independently stored details, include the memory for each requested detail, not only the one matching the main noun.
- If the question names a person or thing inside a supporting clause ("while X is out", "after Y ships", "until Z is signed"), include that person's or thing's own status memory as well — the clause makes their status part of the answer even though the main question is about someone else.
Example: question "Which vendor audits access, and how quickly must critical findings be escalated?" over an index containing [3] "Northstar audits access controls.", [7] "Critical findings must be escalated within 30 minutes.", and [9] "The finance team renewed Northstar's invoicing contract." Correct selection is [3, 7]; [9] shares a vendor name but does not answer either requested detail.
Example: question "Who covers billing escalations while Dana is on leave?" over an index containing [4] "Rafael covers billing escalations." and [8] "Dana is on leave until 2027-02-02." Correct selection is [4, 8] — Dana's leave status answers the "while" clause, so it is part of the answer, not just Rafael's coverage.
Example: question "Why was the office lease renewed?" over an index containing [2] "(#facilities) The office lease was renewed because relocation costs exceeded the approved budget." and [5] "(#finance) Travel budgets were reduced after airfare increased." Correct selection is [2] only — [5] is a different decision that merely shares a cost theme.`;

const SELECT_SCHEMA = {
  type: 'object',
  properties: { memory_ids: { type: 'array', items: { type: 'integer' } } },
  required: ['memory_ids'],
} as const;

const ANSWER_SYSTEM = (asOf: string): string => `You answer questions using ONLY the memories provided — nothing else. Today's date is ${asOf}; resolve phrases like "this week" against it.
- If the memories do not contain the answer, say plainly that it is not in memory. Never guess, never use outside knowledge.
- Present tentative memories as tentative ("there was discussion of..., but no decision").
- When multiple memories are provided, synthesize ALL of them into one complete answer — do not drop specific dates, names, or reasons that are present in the memories.
- Quote dates exactly as labeled in the memory. If a memory states a range plus a distinct labeled date (e.g. "out through DATE1, returning DATE2"), use the date with the matching label for what's asked (a return date is DATE2, not the range's end DATE1) — never substitute an adjacent date.
- Be concise and direct.`;

const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    cited_memory_ids: { type: 'array', items: { type: 'integer' } },
  },
  required: ['answer', 'cited_memory_ids'],
} as const;

function indexLine(m: Memory): string {
  return `[${m.id}] (${m.channel} ${m.scope}:${m.subject} ${m.kind}, ${m.certainty}) ${m.statement}`;
}

/** Coerce an LLM-supplied id list to numbers we actually offered — anything else is discarded. */
function filterValidIds(raw: unknown, allowed: ReadonlySet<number>): number[] {
  return Array.isArray(raw)
    ? raw.filter((n): n is number => typeof n === 'number' && allowed.has(n))
    : [];
}

export async function answerQuestion(
  store: MemoryStore,
  llm: Llm,
  question: string,
  asOf: string,
): Promise<{ answer: string; citedMemoryIds: number[] }> {
  const active = store.activeMemories();
  if (active.length === 0) return { answer: "I don't have any memories yet.", citedMemoryIds: [] };

  const selection = await llm.structured<{ memory_ids: unknown }>({
    system: SELECT_SYSTEM,
    user: `Question: ${question}\n\nMemory index:\n${active.map(indexLine).join('\n')}`,
    toolName: 'select_memories',
    toolDescription: 'Select the ids of the memories relevant to the question.',
    schema: SELECT_SCHEMA,
    maxTokens: 300,
  });
  const ids = filterValidIds(selection.memory_ids, new Set(active.map((m) => m.id)));
  if (ids.length === 0) {
    return { answer: "I don't have anything in memory about that.", citedMemoryIds: [] };
  }

  const selected = active.filter((m) => ids.includes(m.id));
  const rendered = selected
    .map((m) => `[${m.id}] (${m.certainty}, learned ${m.created_at}) ${m.statement}`)
    .join('\n');
  const result = await llm.structured<{ answer: unknown; cited_memory_ids: unknown }>({
    system: ANSWER_SYSTEM(asOf),
    user: `Question: ${question}\n\nMemories:\n${rendered}`,
    toolName: 'answer',
    toolDescription: 'Answer the question from the memories, citing the ids you used.',
    schema: ANSWER_SCHEMA,
    maxTokens: 500,
  });
  const cited = filterValidIds(result.cited_memory_ids, new Set(ids));
  if (cited.length === 0) {
    // An answer that cites none of the offered memories is ungrounded — refuse it structurally.
    return { answer: "I don't have anything in memory about that.", citedMemoryIds: [] };
  }
  return {
    answer: typeof result.answer === 'string' ? result.answer : "I couldn't produce an answer.",
    citedMemoryIds: cited,
  };
}

function parseArgs(argv: string[]): { question: string; asOf: string | undefined } {
  const args = argv.slice(2);
  const asOfIdx = args.indexOf('--as-of');
  let asOf: string | undefined;
  if (asOfIdx !== -1) {
    asOf = args[asOfIdx + 1];
    if (!asOf || Number.isNaN(Date.parse(asOf))) {
      console.error('--as-of requires a valid ISO timestamp');
      process.exit(1);
    }
    args.splice(asOfIdx, 2);
  }
  const question = args[0];
  if (!question) {
    console.error('usage: tsx src/query.ts "<question>" [--as-of <ISO timestamp>]');
    process.exit(1);
  }
  return { question, asOf };
}

async function main(): Promise<void> {
  const { question, asOf } = parseArgs(process.argv);
  const cfg = loadConfig();
  const store = new MemoryStore(cfg.dbPath);
  try {
    const llm = new Llm(cfg);
    const referenceTime = asOf ?? store.latestMessageTs() ?? new Date().toISOString();
    const { answer, citedMemoryIds } = await answerQuestion(store, llm, question, referenceTime);
    console.log(answer);
    if (citedMemoryIds.length > 0) {
      const byId = new Map(store.activeMemories().map((m) => [m.id, m]));
      console.log('\nsources:');
      for (const id of citedMemoryIds) {
        const mem = byId.get(id);
        if (!mem) continue;
        console.log(`  memory ${id}: ${mem.statement}`);
        for (const msg of store.getMessages(mem.source_msg_ids)) {
          console.log(`    ${msg.ts} ${msg.author}: ${msg.text}`);
        }
      }
    }
  } finally {
    store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
