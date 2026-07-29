import type { Llm } from './llm.js';
import type { CandidateFact, StoredMessage } from './types.js';
import { CERTAINTIES, KINDS, SCOPES } from './types.js';

export const EXTRACTION_SYSTEM = `You are the memory system for an agent that passively observes a team chat channel. You read a window of messages and record only durable, useful facts. Most windows contain NOTHING worth remembering — recording zero facts is the normal, correct outcome.

Record ONLY:
- decisions actually made ("locked", "let's do it", a proposal others accept) — not proposals still open
- deadlines and dates that were set or changed
- availability: out-of-office, return dates, on-call
- ownership: accepted assignments ("can you own X?" ... "sure")
- durable team rules or preferences that get adopted
- concrete facts about people or the team's work, including facts about people who are not in the channel

NEVER record:
- jokes, sarcasm, banter — judge sincerity by how the conversation proceeds, not by surface wording; if others treat a jokey message as a real decision, it is one, and if a "decision" is met with laughter and dropped, it is not
- speculation and hypotheticals ("maybe we should...", "what if we...") that nobody commits to
- open questions and proposals that get no answer
- greetings, reactions, emoji, chatter, social plans that never resolve into a decision

Rules:
- subject = who or what the fact is ABOUT, never who said it. "Priya is out next week" said by Dan → subject "priya". Team-level facts (launch dates, freezes, rules) → scope "channel" with subject set to the channel name.
- Resolve every relative date ("next week", "the 28th", "Monday") to an absolute ISO date using the TIMESTAMP OF THE MESSAGE, and write the absolute date into the statement.
- certainty "decided" only for explicit commitments, locks, and announcements; "tentative" for hedged-but-real signal ("we may push the email").
- Write each statement as one self-contained sentence that makes sense without the conversation.
- Sweep the ENTIRE window — unrelated facts can appear anywhere, including in passing.
- Extract only from TARGET messages; CONTEXT messages exist solely to resolve references.
- source_msg_ids: the ids of the target messages that establish the fact.

Example window:
  [x1] 2026-03-02T10:00:00Z ana: ok shipping v2 on March 9, it's locked
  [x2] 2026-03-02T10:01:00Z leo: lol or we ship never and open a bakery
  [x3] 2026-03-02T10:02:00Z ana: leo pls. also I'm off this friday
Correct output — exactly two facts:
  { subject: "#chan", scope: "channel", kind: "deadline", statement: "v2 ships on 2026-03-09.", certainty: "decided", source_msg_ids: ["x1"] }
  { subject: "ana", scope: "person", kind: "availability", statement: "Ana is off on 2026-03-06.", certainty: "decided", source_msg_ids: ["x3"] }
The bakery message produces nothing.`;

const RECORD_FACTS_SCHEMA = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          scope: { enum: [...SCOPES] },
          kind: { enum: [...KINDS] },
          statement: { type: 'string' },
          certainty: { enum: [...CERTAINTIES] },
          confidence: { type: 'number' },
          source_msg_ids: { type: 'array', items: { type: 'string' } },
        },
        required: ['subject', 'scope', 'kind', 'statement', 'certainty', 'confidence', 'source_msg_ids'],
      },
    },
  },
  required: ['facts'],
} as const;

function renderMessages(msgs: StoredMessage[]): string {
  return msgs.map((m) => `[${m.id}] ${m.ts} ${m.author}: ${m.text}`).join('\n');
}

function isValidFact(x: unknown): x is CandidateFact {
  if (typeof x !== 'object' || x === null) return false;
  const f = x as Record<string, unknown>;
  return (
    typeof f['subject'] === 'string' && f['subject'].length > 0 &&
    SCOPES.includes(f['scope'] as never) &&
    KINDS.includes(f['kind'] as never) &&
    typeof f['statement'] === 'string' && f['statement'].length > 0 &&
    CERTAINTIES.includes(f['certainty'] as never) &&
    typeof f['confidence'] === 'number' &&
    Array.isArray(f['source_msg_ids']) && f['source_msg_ids'].every((s) => typeof s === 'string')
  );
}

export async function extractFacts(
  llm: Llm,
  win: { context: StoredMessage[]; target: StoredMessage[] },
): Promise<CandidateFact[]> {
  const channel = win.target[0]?.channel;
  if (!channel) return [];
  const user = [
    `Channel: ${channel}`,
    win.context.length > 0 ? `CONTEXT (reference only):\n${renderMessages(win.context)}` : '',
    `TARGET messages:\n${renderMessages(win.target)}`,
  ].filter(Boolean).join('\n\n');

  const raw = await llm.structured<{ facts: unknown[] }>({
    system: EXTRACTION_SYSTEM,
    user,
    toolName: 'record_facts',
    toolDescription: 'Record the durable facts found in the target messages. An empty list is a normal outcome.',
    schema: RECORD_FACTS_SCHEMA as unknown as Record<string, unknown>,
  });

  const targetIds = new Set(win.target.map((m) => m.id));
  const knownIds = new Set([...targetIds, ...win.context.map((m) => m.id)]);
  const facts: CandidateFact[] = [];
  for (const candidate of raw.facts ?? []) {
    if (!isValidFact(candidate)) {
      console.warn('  ! dropped malformed fact from extractor');
      continue;
    }
    const sourceIds = candidate.source_msg_ids.filter((id) => knownIds.has(id));
    if (!sourceIds.some((id) => targetIds.has(id))) {
      console.warn(`  ! dropped fact with no target-message provenance: "${candidate.statement}"`);
      continue;
    }
    facts.push({
      ...candidate,
      subject: candidate.subject.trim().toLowerCase(),
      confidence: Math.max(0, Math.min(1, candidate.confidence)),
      source_msg_ids: sourceIds,
    });
  }
  return facts;
}

/** A fact's timestamp = the latest source message that establishes it. */
export function factTimestamp(fact: CandidateFact, byId: Map<string, StoredMessage>): string {
  const stamps = fact.source_msg_ids
    .map((id) => byId.get(id)?.ts)
    .filter((ts): ts is string => ts !== undefined)
    .sort();
  const last = stamps[stamps.length - 1];
  if (!last) throw new Error(`fact "${fact.statement}" has no resolvable source messages`);
  return last;
}
