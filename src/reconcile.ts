import type { Llm } from './llm.js';
import type { MemoryStore } from './store.js';
import type { CandidateFact, Memory, ReconcileDecision } from './types.js';

export type AppliedOp = 'add' | 'update' | 'supersede' | 'noop';

export const RECONCILE_SYSTEM = `You maintain a memory store for a team chat. You are given ONE new candidate fact and the existing ACTIVE memories about the same subject. Choose exactly one operation:
- "add": genuinely new information not covered by any existing memory
- "update": the same underlying fact as target_id with better/richer wording that does NOT change numbers, dates, or key qualifiers — provide the merged statement
- "supersede": the new fact contradicts or replaces target_id (a date moved, a decision reversed, a value changed). Newer information wins.
- "noop": target_id already fully captures this fact

Rules:
- Facts that differ on numbers, dates, or key qualifiers are NEVER the same fact: that is "supersede" if they answer the same question, "add" if they answer different questions.
- A tentative fact does not replace a decided one — prefer "add" so both are visible (the system enforces this).
- Pick exactly one target_id for update/supersede/noop.`;

const RECONCILE_SCHEMA = {
  type: 'object',
  properties: {
    op: { enum: ['add', 'update', 'supersede', 'noop'] },
    target_id: { type: 'integer' },
    statement: { type: 'string' },
  },
  required: ['op'],
} as const;

function isValidDecision(x: unknown): x is ReconcileDecision {
  if (typeof x !== 'object' || x === null) return false;
  const d = x as Record<string, unknown>;
  if (d['op'] === 'add') return true;
  if (d['op'] === 'noop') return d['target_id'] === undefined || typeof d['target_id'] === 'number';
  if (d['op'] === 'supersede') return typeof d['target_id'] === 'number';
  if (d['op'] === 'update') return typeof d['target_id'] === 'number' && typeof d['statement'] === 'string';
  return false;
}

/** Code-enforced invariants (not prompt vibes): tentative never kills decided; unknown targets fall back to add. */
export function applyCertaintyGuard(
  decision: ReconcileDecision,
  fact: CandidateFact,
  candidates: Memory[],
): ReconcileDecision {
  if (decision.op !== 'supersede') return decision;
  const target = candidates.find((c) => c.id === decision.target_id);
  if (!target) return { op: 'add' };
  if (fact.certainty === 'tentative' && target.certainty === 'decided') return { op: 'add' };
  return decision;
}

function renderCandidates(candidates: Memory[]): string {
  return candidates
    .map((c) => `id=${c.id} (${c.kind}, ${c.certainty}, since ${c.created_at}) ${c.statement}`)
    .join('\n');
}

export async function reconcileFact(
  store: MemoryStore,
  llm: Llm,
  channel: string,
  fact: CandidateFact,
  factTs: string,
): Promise<AppliedOp> {
  const candidates = store.activeCandidates(channel, fact.subject);
  if (candidates.length === 0) {
    store.insertMemory(channel, fact, factTs);
    return 'add';
  }

  const raw = await llm.structured<unknown>({
    system: RECONCILE_SYSTEM,
    user: `New candidate fact (${fact.kind}, ${fact.certainty}, from message at ${factTs}):\n"${fact.statement}"\n\nExisting ACTIVE memories for subject "${fact.subject}":\n${renderCandidates(candidates)}`,
    toolName: 'reconcile',
    toolDescription: 'Choose how the new fact relates to the existing memories.',
    schema: RECONCILE_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 500,
  });
  const decision = isValidDecision(raw) ? raw : ({ op: 'add' } as const);
  const guarded = applyCertaintyGuard(decision, fact, candidates);

  switch (guarded.op) {
    case 'add': {
      store.insertMemory(channel, fact, factTs);
      return 'add';
    }
    case 'update': {
      const target = candidates.find((c) => c.id === guarded.target_id);
      if (!target) { store.insertMemory(channel, fact, factTs); return 'add'; }
      store.updateStatement(target.id, guarded.statement, fact.source_msg_ids);
      return 'update';
    }
    case 'supersede': {
      const created = store.insertMemory(channel, fact, factTs);
      store.supersede(guarded.target_id, created.id, factTs);
      return 'supersede';
    }
    case 'noop': {
      if (guarded.target_id !== undefined) store.mergeSourceIds(guarded.target_id, fact.source_msg_ids);
      return 'noop';
    }
  }
}
