import type { Llm } from './llm.js';
import type { MemoryStore } from './store.js';
import type { CandidateFact } from './types.js';

export type AppliedOp = 'add' | 'update' | 'supersede' | 'noop';

export async function reconcileFact(
  store: MemoryStore,
  _llm: Llm,
  channel: string,
  fact: CandidateFact,
  factTs: string,
): Promise<AppliedOp> {
  store.insertMemory(channel, fact, factTs);
  return 'add';
}
