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
- subject = who or what the fact is ABOUT, never who said it. "Priya is out next week" said by Dan → subject "priya". Team-level facts (launch dates, freezes, rules) → scope "channel" with subject set to the channel name.
- Resolve every relative date ("next week", "the 28th", "Monday") to an absolute ISO date using the TIMESTAMP OF THE MESSAGE, and write the absolute date into the statement. Each message is rendered as "[id] ISO-timestamp (Weekday; "next week" Monday = YYYY-MM-DD) author: text" — that Monday date is precomputed for you. Use it ONLY when a bare "next week" / "starting Monday" phrase is the sole way of pinning that point in time (e.g. "deploy freeze starting Monday", "on call next week"). If the message itself already gives an explicit date for a point ("back the 28th", "the 14th"), that stated date always wins for that point — never let the precomputed Monday override or redefine a date the message states explicitly.
- When a fact changes a previously known value (a date moves, a decision reverses), the new statement MUST explicitly state the new CURRENT value (e.g. the actual new date) — never write a fact that only explains why the old value no longer holds without giving the replacement value. Never write the literal old value (its exact number or ISO-style date) in ANY new fact's statement, including a separate fact that merely explains or gives background for the change — refer to it descriptively instead ("the original date", "the previous plan") if you need to reference it at all; supersession already preserves the history.
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
The bakery message produces nothing.

Example window — a value changes with a stated reason (an existing active memory already says "v2 ships on 2026-03-09."):
  [y1] 2026-04-01T09:00:00Z bo: eng found a blocker, march 9 isn't happening
  [y2] 2026-04-01T09:01:00Z bo: new ship date is march 16
Correct output — exactly two facts, and note NEITHER repeats "2026-03-09":
  { subject: "#chan", scope: "channel", kind: "fact", statement: "A blocker was found that prevented shipping on the originally planned date.", certainty: "decided", source_msg_ids: ["y1"] }
  { subject: "#chan", scope: "channel", kind: "deadline", statement: "v2 ships on 2026-03-16.", certainty: "decided", source_msg_ids: ["y2"] }
The store's supersession link already preserves the old date's history — restating "2026-03-09" in either new fact would be wrong.`;

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
