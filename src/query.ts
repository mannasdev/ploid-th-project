import { loadConfig } from './config.js';
import { Llm } from './llm.js';
import { MemoryStore } from './store.js';
import type { Memory } from './types.js';

export const SELECT_SYSTEM = `You are the retrieval stage of a memory system. Given a question and an index of stored memories (one line each), return the ids of ONLY the memories needed to answer it. Relevance is strict: do not include loosely related memories — they pollute the answer. An empty list is the correct output when nothing is relevant.`;

const SELECT_SCHEMA = {
  type: 'object',
  properties: { memory_ids: { type: 'array', items: { type: 'integer' } } },
  required: ['memory_ids'],
} as const;

const ANSWER_SYSTEM = (asOf: string): string => `You answer questions using ONLY the memories provided — nothing else. Today's date is ${asOf}; resolve phrases like "this week" against it.
- If the memories do not contain the answer, say plainly that it is not in memory. Never guess, never use outside knowledge.
- Present tentative memories as tentative ("there was discussion of..., but no decision").
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
    schema: SELECT_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 300,
  });
  const validIds = new Set(active.map((m) => m.id));
  const ids = Array.isArray(selection.memory_ids)
    ? selection.memory_ids.filter((n): n is number => typeof n === 'number' && validIds.has(n))
    : [];
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
    schema: ANSWER_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 500,
  });
  const cited = Array.isArray(result.cited_memory_ids)
    ? result.cited_memory_ids.filter((n): n is number => typeof n === 'number' && ids.includes(n))
    : [];
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
