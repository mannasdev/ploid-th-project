import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekday, isoWeekday, nextWeekMonday } from '../src/extract.js';

test('weekday names a known UTC date correctly', () => {
  // 2026-07-20 is a Monday (verified via date math, independent of this module).
  assert.equal(weekday('2026-07-20T10:00:00Z'), 'Monday');
  // 2026-07-30 is a Thursday.
  assert.equal(weekday('2026-07-30T10:00:00Z'), 'Thursday');
});

test('nextWeekMonday resolves a Monday-dated input to the FOLLOWING Monday, not the same day', () => {
  // 2026-07-20 is itself a Monday (isoWeekday 1); "next week" must mean the Monday
  // that starts the NEXT calendar week (2026-07-27), seven days later — never the
  // input date itself.
  assert.equal(isoWeekday(new Date('2026-07-20T10:00:00Z')), 1);
  const next = nextWeekMonday('2026-07-20T10:00:00Z');
  assert.equal(next, '2026-07-27');
  assert.notEqual(next, '2026-07-20');
});

test('nextWeekMonday rolls over a month boundary', () => {
  // 2026-07-30 is a Thursday; the following Monday falls in August, not July.
  const next = nextWeekMonday('2026-07-30T10:00:00Z');
  assert.equal(next, '2026-08-03');
  assert.ok(next.startsWith('2026-08'), 'expected the resolved Monday to roll into August');
});
