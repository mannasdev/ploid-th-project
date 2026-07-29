import { loadConfig } from './config.js';
import { MemoryStore } from './store.js';

function main(): void {
  const cfg = loadConfig();
  const store = new MemoryStore(cfg.dbPath);
  try {
    const all = store.allMemories();
    if (all.length === 0) {
      console.log('(no memories)');
      return;
    }
    console.log('ACTIVE:');
    for (const m of all.filter((x) => x.status === 'active')) {
      console.log(`  [${m.id}] (${m.channel} ${m.scope}:${m.subject} ${m.kind}, ${m.certainty}, conf ${m.confidence.toFixed(2)}) ${m.statement}`);
    }
    const superseded = all.filter((x) => x.status === 'superseded');
    if (superseded.length > 0) {
      console.log('\nSUPERSEDED:');
      for (const m of superseded) {
        console.log(`  [${m.id}] ${m.statement}  → superseded by [${m.superseded_by}] at ${m.invalid_at}`);
      }
    }
  } finally {
    store.close();
  }
}

main();
