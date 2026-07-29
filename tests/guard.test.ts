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

test('tentative supersede of decided downgrades to add', () => {
  const out = applyCertaintyGuard({ op: 'supersede', target_id: 1 }, fact('tentative'), [memory(1, 'decided')]);
  assert.deepEqual(out, { op: 'add' });
});

test('decided may supersede tentative and decided', () => {
  assert.equal(applyCertaintyGuard({ op: 'supersede', target_id: 1 }, fact('decided'), [memory(1, 'tentative')]).op, 'supersede');
  assert.equal(applyCertaintyGuard({ op: 'supersede', target_id: 1 }, fact('decided'), [memory(1, 'decided')]).op, 'supersede');
});

test('supersede of unknown target downgrades to add', () => {
  assert.deepEqual(applyCertaintyGuard({ op: 'supersede', target_id: 99 }, fact('decided'), [memory(1, 'decided')]), { op: 'add' });
});

test('non-supersede ops pass through', () => {
  const upd = { op: 'update' as const, target_id: 1, statement: 'y' };
  assert.deepEqual(applyCertaintyGuard(upd, fact('tentative'), [memory(1, 'decided')]), upd);
});
