import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store.js';
import type { CandidateFact } from '../src/types.js';

const fact = (over: Partial<CandidateFact> = {}): CandidateFact => ({
  subject: 'priya',
  scope: 'person',
  kind: 'availability',
  statement: 'Priya is out until 2026-07-28.',
  certainty: 'decided',
  confidence: 0.9,
  source_msg_ids: ['m1'],
  ...over,
});

test('messages insert idempotently', () => {
  const store = new MemoryStore(':memory:');
  const msg = { id: 'abc', channel: '#launch', ts: '2026-07-20T10:00:00Z', author: 'priya', text: 'hi' };
  assert.equal(store.insertMessages([msg]), 1);
  assert.equal(store.insertMessages([msg]), 0);
  assert.equal(store.latestMessageTs(), '2026-07-20T10:00:00Z');
});

test('insertMemory + activeCandidates round-trips by subject', () => {
  const store = new MemoryStore(':memory:');
  const m = store.insertMemory('#launch', fact(), '2026-07-20T10:07:00Z');
  assert.equal(m.status, 'active');
  const found = store.activeCandidates('#launch', 'priya');
  assert.equal(found.length, 1);
  assert.deepEqual(found[0]?.source_msg_ids, ['m1']);
  assert.equal(store.activeCandidates('#launch', 'dan').length, 0);
});

test('supersede closes the old row and keeps it queryable', () => {
  const store = new MemoryStore(':memory:');
  const oldM = store.insertMemory('#launch', fact({ subject: '#launch', scope: 'channel', kind: 'deadline', statement: 'Launch is 2026-08-14.' }), '2026-07-20T10:05:00Z');
  const newM = store.insertMemory('#launch', fact({ subject: '#launch', scope: 'channel', kind: 'deadline', statement: 'Launch is 2026-08-21.' }), '2026-07-22T15:34:00Z');
  store.supersede(oldM.id, newM.id, '2026-07-22T15:34:00Z');
  assert.equal(store.activeCandidates('#launch', '#launch').length, 1);
  const all = store.allMemories();
  const closed = all.find((m) => m.id === oldM.id);
  assert.equal(closed?.status, 'superseded');
  assert.equal(closed?.superseded_by, newM.id);
  assert.equal(closed?.invalid_at, '2026-07-22T15:34:00Z');
});

test('insertSuperseding atomically inserts the new row and closes the old one, matching insert+supersede lineage', () => {
  const store = new MemoryStore(':memory:');
  const oldM = store.insertMemory('#launch', fact({ subject: '#launch', scope: 'channel', kind: 'deadline', statement: 'Launch is 2026-08-14.' }), '2026-07-20T10:05:00Z');
  const newM = store.insertSuperseding('#launch', fact({ subject: '#launch', scope: 'channel', kind: 'deadline', statement: 'Launch is 2026-08-21.' }), '2026-07-22T15:34:00Z', oldM.id);
  assert.equal(newM.status, 'active');
  assert.equal(store.activeCandidates('#launch', '#launch').length, 1);
  const all = store.allMemories();
  const closed = all.find((m) => m.id === oldM.id);
  assert.equal(closed?.status, 'superseded');
  assert.equal(closed?.superseded_by, newM.id);
  assert.equal(closed?.invalid_at, '2026-07-22T15:34:00Z');
});

test('updateStatement replaces wording and merges provenance', () => {
  const store = new MemoryStore(':memory:');
  const m = store.insertMemory('#launch', fact(), '2026-07-20T10:07:00Z');
  store.updateStatement(m.id, 'Priya is OOO, returning 2026-07-28.', ['m2']);
  const [got] = store.activeCandidates('#launch', 'priya');
  assert.equal(got?.statement, 'Priya is OOO, returning 2026-07-28.');
  assert.deepEqual(got?.source_msg_ids, ['m1', 'm2']);
});
