import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCertaintyGuard } from '../src/reconcile.js';
import type { CandidateFact, Memory } from '../src/types.js';

const fact = (certainty: CandidateFact['certainty']): CandidateFact => ({
  subject: '#launch', scope: 'channel', kind: 'deadline',
  statement: 'x', certainty, confidence: 0.8, source_msg_ids: ['m1'],
});
const memory = (id: number, certainty: Memory['certainty']): Memory => ({
  ...fact(certainty), id, channel: '#launch', status: 'active',
  created_at: '2026-07-20T10:00:00Z', invalid_at: null, superseded_by: null,
});

const TS = '2026-07-22T15:34:00Z'; // fact timestamp later than memory() created_at

test('tentative supersede of decided downgrades to add', () => {
  const out = applyCertaintyGuard({ op: 'supersede', target_id: 1 }, fact('tentative'), TS, [memory(1, 'decided')]);
  assert.deepEqual(out, { op: 'add' });
});

test('decided may supersede tentative and decided', () => {
  assert.equal(applyCertaintyGuard({ op: 'supersede', target_id: 1 }, fact('decided'), TS, [memory(1, 'tentative')]).op, 'supersede');
  assert.equal(applyCertaintyGuard({ op: 'supersede', target_id: 1 }, fact('decided'), TS, [memory(1, 'decided')]).op, 'supersede');
});

test('supersede of unknown target downgrades to add', () => {
  assert.deepEqual(applyCertaintyGuard({ op: 'supersede', target_id: 99 }, fact('decided'), TS, [memory(1, 'decided')]), { op: 'add' });
});

test('supersede of a target established after the fact downgrades to add (no backwards supersession)', () => {
  const earlierTs = '2026-07-20T09:00:00Z'; // fact predates memory(1).created_at
  assert.deepEqual(applyCertaintyGuard({ op: 'supersede', target_id: 1 }, fact('decided'), earlierTs, [memory(1, 'decided')]), { op: 'add' });
});

test('noop passes through untouched', () => {
  const noop = { op: 'noop' as const, target_id: 1 };
  assert.deepEqual(applyCertaintyGuard(noop, fact('tentative'), TS, [memory(1, 'decided')]), noop);
});

test('tentative update of decided downgrades to add; decided update of decided still passes through', () => {
  const upd = { op: 'update' as const, target_id: 1, statement: 'y' };
  assert.deepEqual(applyCertaintyGuard(upd, fact('tentative'), TS, [memory(1, 'decided')]), { op: 'add' });
  assert.deepEqual(applyCertaintyGuard(upd, fact('decided'), TS, [memory(1, 'decided')]), upd);
});

test('noop with no target_id downgrades to add', () => {
  const noop = { op: 'noop' as const };
  assert.deepEqual(applyCertaintyGuard(noop, fact('decided'), TS, [memory(1, 'decided')]), { op: 'add' });
});

test('noop with an unknown target_id downgrades to add', () => {
  const noop = { op: 'noop' as const, target_id: 99 };
  assert.deepEqual(applyCertaintyGuard(noop, fact('decided'), TS, [memory(1, 'decided')]), { op: 'add' });
});

test('decided update of a tentative target escalates to supersede, preserving target_id', () => {
  const upd = { op: 'update' as const, target_id: 1, statement: 'y' };
  const out = applyCertaintyGuard(upd, fact('decided'), TS, [memory(1, 'tentative')]);
  assert.deepEqual(out, { op: 'supersede', target_id: 1 });
});

test('decided update of a tentative target established after the fact downgrades to add (no backwards supersession)', () => {
  const earlierTs = '2026-07-20T09:00:00Z'; // fact predates memory(1).created_at
  const upd = { op: 'update' as const, target_id: 1, statement: 'y' };
  assert.deepEqual(applyCertaintyGuard(upd, fact('decided'), earlierTs, [memory(1, 'tentative')]), { op: 'add' });
});

test('decided noop of a tentative target escalates to supersede (confirmation promotes certainty)', () => {
  const noop = { op: 'noop' as const, target_id: 1 };
  assert.deepEqual(applyCertaintyGuard(noop, fact('decided'), TS, [memory(1, 'tentative')]), { op: 'supersede', target_id: 1 });
});

test('decided noop of a tentative target established after the fact stays a noop (no backwards supersession)', () => {
  const earlierTs = '2026-07-20T09:00:00Z'; // fact predates memory(1).created_at
  const noop = { op: 'noop' as const, target_id: 1 };
  assert.deepEqual(applyCertaintyGuard(noop, fact('decided'), earlierTs, [memory(1, 'tentative')]), noop);
});

test('update from a fact older than its target demotes to noop (newer wording wins, provenance merged)', () => {
  const earlierTs = '2026-07-20T09:00:00Z'; // fact predates memory(1).created_at
  const upd = { op: 'update' as const, target_id: 1, statement: 'y' };
  assert.deepEqual(applyCertaintyGuard(upd, fact('decided'), earlierTs, [memory(1, 'decided')]), { op: 'noop', target_id: 1 });
});
