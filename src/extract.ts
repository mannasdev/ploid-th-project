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
- a genuinely open consideration tied to a real, stated dependency ("maybe we push X — let's see how Y goes first") — record as tentative; this is different from a proposal nobody engages with

NEVER record:
- jokes, sarcasm, banter — judge sincerity by how the conversation proceeds, not by surface wording; if others treat a jokey message as a real decision, it is one, and if a "decision" is met with laughter and dropped, it is not
- speculation and hypotheticals ("maybe we should...", "what if we...") that get no engagement, get dismissed, or get met with a joke
- open questions that are dropped or deferred to an unspecified future conversation with no stated dependency
- greetings, reactions, emoji, chatter, social plans that never resolve into a decision

Rules:
- subject = who or what the fact is ABOUT, never who said it. "Asha prefers written updates" said by Luis → subject "asha". Team-level facts (release policies, maintenance windows, rules) → scope "channel" with subject set to the channel name.
- Normalize EVERY calendar date written in a stored statement — relative or explicit — to YYYY-MM-DD. Resolve relative dates ("next week", "the 17th", "Monday") using the TIMESTAMP OF THE MESSAGE. Each message is rendered as "[id] ISO-timestamp (Weekday; "next week" Monday = YYYY-MM-DD) author: text" — that Monday date is precomputed for you. Use it ONLY when a bare "next week" / "starting Monday" phrase is the sole way of pinning that point in time (e.g. "inventory count starting Monday", "training next week"). If the message itself gives an explicit date for a point ("back the 17th", "the 3rd"), that stated date wins; convert it to YYYY-MM-DD rather than copying month-name wording.
- When a fact changes a previously known value (a date moves, a decision reverses), emit a replacement fact that states only the new CURRENT value. Never write the literal old value in ANY new fact's statement, and never use "changed/moved from OLD to NEW" wording; supersession already preserves the old row. Generic example: WRONG "Log retention changed from 90 days to 30 days." RIGHT "Application logs are retained for 30 days." A reason may be included, but without restating the old value.
- Choose the kind from the fact itself: use "deadline" when the primary fact is a scheduled date or deadline (including a moved date), "availability" for a person's availability, "ownership" for responsibility, and the closest remaining kind otherwise.
- certainty "decided" only for explicit commitments, locks, and announcements; "tentative" for hedged-but-real signal ("we might move the workshop").
- Write each statement as one self-contained sentence that makes sense without the conversation.
- Sweep the ENTIRE window — unrelated facts can appear anywhere, including in passing.
- Extract only from TARGET messages; CONTEXT messages exist solely to resolve references.
- source_msg_ids: the ids of the target messages that establish the fact.

Example window:
  [x1] 2026-03-02T10:00:00Z ana: what if every status meeting had a theme song
  [x2] 2026-03-02T10:01:00Z leo: only if you perform it live
  [x3] 2026-03-02T10:02:00Z ana: absolutely not 😂
Correct output: { facts: [] }. The suggestion is banter that produces no durable fact.

Example window:
  [y1] 2026-04-06T09:00:00Z nora: customer exports should default to CSV from now on
  [y2] 2026-04-06T09:01:00Z omar: agreed, let's make that the standard
  [y3] 2026-04-06T09:02:00Z nora: I'll own the export documentation
Correct output — exactly two facts:
  { subject: "#chan", scope: "channel", kind: "decision", statement: "Customer exports default to CSV.", certainty: "decided", confidence: 0.98, source_msg_ids: ["y1", "y2"] }
  { subject: "nora", scope: "person", kind: "ownership", statement: "Nora owns the customer-export documentation.", certainty: "decided", confidence: 0.98, source_msg_ids: ["y3"] }

Example window — availability with a vague range plus an explicit date:
  [w1] 2027-09-06T11:00:00Z tara: reminder — I'm off most of next week, back the 15th
Correct output — one fact:
  { subject: "tara", scope: "person", kind: "availability", statement: "Tara is out of office and returns on 2027-09-15.", certainty: "decided", confidence: 0.97, source_msg_ids: ["w1"] }
The explicitly stated return date ("the 15th" → 2027-09-15 from the message timestamp) is the anchor and MUST appear in the statement as an ISO date. The vague range ("most of next week") is NOT converted into invented boundary dates — never write a "through DATE" you computed yourself alongside a stated return date, and never write a through-date equal to the return date (being out through a date and returning on it contradict each other).

Example window — a stored value changes (an active memory already records a different log-retention period):
  [z1] 2026-05-11T14:00:00Z ivan: storage review is complete; reduce application-log retention
  [z2] 2026-05-11T14:01:00Z mira: approved, set retention to 30 days starting today
Correct output — one fact carrying the new current value:
  { subject: "#chan", scope: "channel", kind: "decision", statement: "Application logs are retained for 30 days beginning 2026-05-11 after the storage review.", certainty: "decided", confidence: 0.99, source_msg_ids: ["z1", "z2"] }
The old retention value is not repeated — this applies even inside the reason clause: "after the storage review" is correct, while "after the storage review required the original 90-day retention to be shortened" is WRONG because it writes the old value into the new fact. Refer to what changed descriptively ("the original period", "the previous date"); the superseded row already records the old value.`;

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

export function weekday(ts: string): string {
  return new Date(ts).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
}

/** ISO weekday: Monday=1 ... Sunday=7. */
export function isoWeekday(d: Date): number {
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  return day === 0 ? 7 : day;
}

/** The Monday that starts the calendar week AFTER the one containing ts — i.e. what "next week" means, computed in code so the model never has to. */
export function nextWeekMonday(ts: string): string {
  const d = new Date(ts);
  const daysUntilNextMonday = 8 - isoWeekday(d);
  const next = new Date(d.getTime() + daysUntilNextMonday * 86_400_000);
  return next.toISOString().slice(0, 10);
}

function renderMessages(msgs: StoredMessage[]): string {
  return msgs
    .map((m) => `[${m.id}] ${m.ts} (${weekday(m.ts)}; "next week" Monday = ${nextWeekMonday(m.ts)}) ${m.author}: ${m.text}`)
    .join('\n');
}

function isValidFact(x: unknown): x is CandidateFact {
  if (typeof x !== 'object' || x === null) return false;
  const f = x as Record<string, unknown>;
  return (
    typeof f['subject'] === 'string' && f['subject'].trim().length > 0 &&
    SCOPES.includes(f['scope'] as never) &&
    KINDS.includes(f['kind'] as never) &&
    typeof f['statement'] === 'string' && f['statement'].trim().length > 0 &&
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
    schema: RECORD_FACTS_SCHEMA,
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
      subject: candidate.scope === 'channel' ? channel : candidate.subject.trim().toLowerCase(),
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
