import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadTranscript } from '../src/transcript.js';

function writeTmp(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'memtest-'));
  const p = join(dir, 't.json');
  writeFileSync(p, JSON.stringify(content));
  return p;
}

test('loads, sorts by ts, assigns stable ids', () => {
  const msgs = loadTranscript(writeTmp([
    { ts: '2026-07-20T10:02:00Z', channel: '#launch', author: 'dan', text: 'second' },
    { ts: '2026-07-20T10:01:00Z', channel: '#launch', author: 'priya', text: 'first' },
  ]));
  assert.equal(msgs[0]?.text, 'first');
  assert.equal(msgs.length, 2);
  assert.match(msgs[0]!.id, /^[0-9a-f]{12}$/);
  // stable: same content → same id
  const again = loadTranscript(writeTmp([
    { ts: '2026-07-20T10:01:00Z', channel: '#launch', author: 'priya', text: 'first' },
  ]));
  assert.equal(again[0]?.id, msgs[0]?.id);
});

test('rejects mixed channels and missing fields', () => {
  assert.throws(() => loadTranscript(writeTmp([
    { ts: '2026-07-20T10:01:00Z', channel: '#a', author: 'x', text: 'hi' },
    { ts: '2026-07-20T10:02:00Z', channel: '#b', author: 'x', text: 'hi' },
  ])), /single channel/);
  assert.throws(() => loadTranscript(writeTmp([{ ts: '2026-07-20T10:01:00Z', author: 'x' }])), /missing|invalid/i);
});

test('rejects a non-UTC-offset timestamp', () => {
  assert.throws(() => loadTranscript(writeTmp([
    { ts: '2026-07-20T10:01:00+02:00', channel: '#launch', author: 'priya', text: 'hi' },
  ])), /UTC|"Z"/);
});

test('rejects fractional-seconds timestamps (would break lexicographic ordering)', () => {
  assert.throws(() => loadTranscript(writeTmp([
    { ts: '2026-07-20T10:01:00.500Z', channel: '#launch', author: 'priya', text: 'hi' },
  ])), /UTC|fixed-width/);
});

test('rejects impossible calendar dates even in the right shape (V8 would roll Feb 31 to Mar 3)', () => {
  assert.throws(() => loadTranscript(writeTmp([
    { ts: '2026-02-31T10:01:00Z', channel: '#launch', author: 'priya', text: 'hi' },
  ])), /UTC|real calendar/);
});
