import { loadConfig } from './config.js';
import { Llm } from './llm.js';
import { MemoryStore } from './store.js';
import { loadTranscript, windows } from './transcript.js';
import { extractFacts, factTimestamp } from './extract.js';
import { reconcileFact } from './reconcile.js';
import type { StoredMessage } from './types.js';

export interface IngestReport {
  channel: string;
  messages: number;
  newMessages: number;
  extracted: number;
  ops: { add: number; update: number; supersede: number; noop: number };
}

export async function ingestTranscript(store: MemoryStore, llm: Llm, filePath: string): Promise<IngestReport> {
  const messages = loadTranscript(filePath);
  const channel = messages[0]!.channel;
  const newMessages = store.insertMessages(messages);
  const byId = new Map<string, StoredMessage>(messages.map((m) => [m.id, m]));

  const report: IngestReport = {
    channel, messages: messages.length, newMessages, extracted: 0,
    ops: { add: 0, update: 0, supersede: 0, noop: 0 },
  };

  for (const [i, win] of windows(messages).entries()) {
    const facts = await extractFacts(llm, win);
    report.extracted += facts.length;
    console.log(`window ${i + 1}: ${facts.length} fact(s)`);
    for (const fact of facts) {
      const ts = factTimestamp(fact, byId);
      const op = await reconcileFact(store, llm, channel, fact, ts);
      report.ops[op] += 1;
      console.log(`  ${op.toUpperCase().padEnd(9)} [${fact.scope}:${fact.subject}] ${fact.statement}`);
    }
  }
  return report;
}

async function main(): Promise<void> {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('usage: tsx src/ingest.ts <transcript.json>');
    process.exit(1);
  }
  const cfg = loadConfig();
  const store = new MemoryStore(cfg.dbPath);
  try {
    const llm = new Llm(cfg);
    const r = await ingestTranscript(store, llm, filePath);
    console.log(
      `\ningested ${r.channel}: ${r.messages} messages (${r.newMessages} new) → ` +
      `${r.extracted} facts (add ${r.ops.add}, update ${r.ops.update}, supersede ${r.ops.supersede}, noop ${r.ops.noop})`,
    );
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
