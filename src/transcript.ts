import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { StoredMessage, TranscriptMessage } from './types.js';

/** Fixed-width UTC ISO-8601 (no fractional seconds, no offsets) — the only form under which lexicographic order IS chronological order. */
const UTC_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** Strictly-formed UTC timestamp: fixed-width shape AND a real calendar date-time. Date.parse alone is not enough — V8 rolls impossible dates over (Feb 31 → Mar 3), so we require the parsed value to round-trip back to the same string. */
function isUtcIsoTs(ts: unknown): ts is string {
  if (typeof ts !== 'string' || !UTC_TS_RE.test(ts)) return false;
  const ms = Date.parse(ts);
  return !Number.isNaN(ms) && new Date(ms).toISOString() === `${ts.slice(0, -1)}.000Z`;
}

/** Non-null only when ts is a parseable timestamp in the WRONG form (offset, fractional seconds, non-fixed-width, rolled-over date) — gives a precise error instead of the generic "invalid" message. */
function tsOffsetError(ts: unknown): string | null {
  if (isUtcIsoTs(ts) || typeof ts !== 'string' || Number.isNaN(Date.parse(ts))) return null;
  return `ts "${ts}" must be UTC ISO-8601 in the exact form "YYYY-MM-DDTHH:MM:SSZ" denoting a real calendar date-time — messages are sorted lexicographically by ts, which is only provably chronological for this fixed-width UTC form`;
}

function isTranscriptMessage(x: unknown): x is TranscriptMessage {
  if (typeof x !== 'object' || x === null) return false;
  const m = x as Record<string, unknown>;
  return (
    isUtcIsoTs(m['ts']) &&
    typeof m['channel'] === 'string' && m['channel'].length > 0 &&
    typeof m['author'] === 'string' && m['author'].length > 0 &&
    typeof m['text'] === 'string'
  );
}

function messageId(m: TranscriptMessage): string {
  return createHash('sha256').update(`${m.channel}|${m.ts}|${m.author}|${m.text}`).digest('hex').slice(0, 12);
}

export function loadTranscript(filePath: string): StoredMessage[] {
  const raw: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${filePath}: expected a non-empty JSON array of messages`);
  }
  raw.forEach((m, i) => {
    if (typeof m === 'object' && m !== null) {
      const err = tsOffsetError((m as Record<string, unknown>)['ts']);
      if (err) throw new Error(`${filePath}: message ${i}: ${err}`);
    }
    if (!isTranscriptMessage(m)) {
      throw new Error(`${filePath}: message ${i} is missing/invalid — need { ts, channel, author, text }`);
    }
  });
  const messages = raw as TranscriptMessage[];
  const channels = new Set(messages.map((m) => m.channel));
  if (channels.size > 1) {
    throw new Error(`${filePath}: expected a single channel per file, got ${[...channels].join(', ')}`);
  }
  return messages
    .slice()
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .map((m) => ({ ...m, id: messageId(m) }));
}

export function windows(
  messages: StoredMessage[],
  size = 15,
  contextSize = 5,
): Array<{ context: StoredMessage[]; target: StoredMessage[] }> {
  const out: Array<{ context: StoredMessage[]; target: StoredMessage[] }> = [];
  for (let start = 0; start < messages.length; start += size) {
    out.push({
      context: messages.slice(Math.max(0, start - contextSize), start),
      target: messages.slice(start, start + size),
    });
  }
  return out;
}
