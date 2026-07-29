import type { Llm } from './llm.js';
import type { MemoryStore } from './store.js';
import type { CandidateFact, Memory, ReconcileDecision } from './types.js';

export type AppliedOp = 'add' | 'update' | 'supersede' | 'noop';

export const RECONCILE_SYSTEM = `You maintain a memory store for a team chat. You are given ONE new candidate fact and the existing ACTIVE memories about the same subject. Choose exactly one operation:
- "add": genuinely new information not covered by any existing memory
- "update": the same underlying fact as target_id with better/richer wording that does NOT change numbers, dates, or key qualifiers — provide the merged statement. The merged statement must stay fully self-contained and unambiguous: keep every qualifier from the original statement that still holds (who, why, under what condition), and if it carries a new number or date, say plainly what that number/date refers to — never leave a bare phrase like "the new date" unlabeled.
- "supersede": the new fact contradicts or replaces target_id (a date moved, a decision reversed, a value changed). Newer information wins.
- "noop": target_id already fully captures this fact — including when the new fact is just a reconfirmation of unchanged information (e.g. someone reaffirming an existing assignment)

Rules:
- Facts that differ on numbers, dates, or key qualifiers are NEVER the same fact: that is "supersede" if they answer the same question, "add" if they answer different questions.
- "supersede" is ONLY for a fact that answers the SAME question as the target with newer information. A fact that explains, justifies, or gives background for a change (e.g. why an old date was dropped) does not replace the fact carrying the new value — that is "add".
- A tentative fact does not replace a decided one — prefer "add" so both are visible (the system enforces this).
- Prefer "noop" over "update" for a bare reconfirmation. Never pad a merged statement with a number or date that belongs to a DIFFERENT subject's fact and is already tracked there (e.g. don't fold a launch date into a person's checklist-ownership statement) — that duplication is what creates ambiguity later, not clarity.
- Pick exactly one target_id for update/supersede/noop.

Example: new candidate fact "Jordan still owns the on-call rotation, now under the revised schedule." (kind ownership) against existing active memory id=5 "Jordan owns the on-call rotation." Correct output: { op: "noop", target_id: 5 } — the assignment itself is unchanged; "now under the revised schedule" is not new ownership information and belongs to a separate schedule fact, not this one.`;

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

/** Code-enforced invariants (not prompt vibes): a tentative fact never supersedes OR rewords a decided one; a decided update of a tentative target escalates to supersede so certainty isn't left stuck; unknown/targetless supersede and noop targets fall back to add; a fact never supersedes a target established AFTER it (no backwards-in-time supersession). */
export function applyCertaintyGuard(
  decision: ReconcileDecision,
  fact: CandidateFact,
  factTs: string,
  candidates: Memory[],
): ReconcileDecision {
  if (decision.op === 'noop') {
    const target = candidates.find((c) => c.id === decision.target_id);
    if (!target) return { op: 'add' };
    return decision;
  }
  if (decision.op === 'update') {
    const target = candidates.find((c) => c.id === decision.target_id);
    if (target && fact.certainty === 'tentative' && target.certainty === 'decided') return { op: 'add' };
    if (target && fact.certainty === 'decided' && target.certainty === 'tentative') {
      if (target.created_at > factTs) return { op: 'add' };
      return { op: 'supersede', target_id: decision.target_id };
    }
    return decision;
  }
  if (decision.op !== 'supersede') return decision;
  const target = candidates.find((c) => c.id === decision.target_id);
  if (!target) return { op: 'add' };
  if (fact.certainty === 'tentative' && target.certainty === 'decided') return { op: 'add' };
  if (target.created_at > factTs) return { op: 'add' };
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
  const guarded = applyCertaintyGuard(decision, fact, factTs, candidates);

  switch (guarded.op) {
    case 'add': {
      store.insertMemory(channel, fact, factTs);
      return 'add';
    }
    case 'update': {
      const target = candidates.find((c) => c.id === guarded.target_id);
      if (!target) { store.insertMemory(channel, fact, factTs); return 'add'; }
      console.log(`  ↳ updates [${target.id}] "${target.statement}"`);
      store.updateStatement(target.id, guarded.statement, fact.source_msg_ids);
      return 'update';
    }
    case 'supersede': {
      const target = candidates.find((c) => c.id === guarded.target_id);
      if (target) console.log(`  ↳ supersedes [${guarded.target_id}] "${target.statement}"`);
      store.insertSuperseding(channel, fact, factTs, guarded.target_id);
      return 'supersede';
    }
    case 'noop': {
      const target = candidates.find((c) => c.id === guarded.target_id);
      if (target) store.mergeSourceIds(target.id, fact.source_msg_ids);
      return 'noop';
    }
  }
}
