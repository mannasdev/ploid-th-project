import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windows } from '../src/transcript.js';
import type { StoredMessage } from '../src/types.js';

const msg = (i: number): StoredMessage => ({
  id: `m${i}`, channel: '#c', ts: `2026-07-20T10:${String(i).padStart(2, '0')}:00Z`, author: 'a', text: `t${i}`,
});
const many = (n: number): StoredMessage[] => Array.from({ length: n }, (_, i) => msg(i));

test('single window when messages fit', () => {
  const w = windows(many(10));
  assert.equal(w.length, 1);
  assert.equal(w[0]?.context.length, 0);
  assert.equal(w[0]?.target.length, 10);
});

test('splits with trailing context, covers every message exactly once as target', () => {
  const w = windows(many(35), 15, 5);
  assert.equal(w.length, 3);
  assert.equal(w[1]?.context.length, 5);
  assert.equal(w[1]?.context[4]?.id, 'm14'); // last 5 of previous window
  assert.equal(w[1]?.target[0]?.id, 'm15');
  const targeted = w.flatMap((x) => x.target.map((m) => m.id));
  assert.deepEqual(targeted, many(35).map((m) => m.id));
});
