import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { StoredMessage, TranscriptMessage } from './types.js';

function isTranscriptMessage(x: unknown): x is TranscriptMessage {
  if (typeof x !== 'object' || x === null) return false;
  const m = x as Record<string, unknown>;
  return (
    typeof m['ts'] === 'string' && !Number.isNaN(Date.parse(m['ts'])) &&
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
