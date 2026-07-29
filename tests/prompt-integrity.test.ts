import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXTRACTION_SYSTEM } from '../src/extract.js';
import { SELECT_SYSTEM } from '../src/query.js';
import { RECONCILE_SYSTEM } from '../src/reconcile.js';

interface Scenario {
  question: string;
  expected: string;
}

const scenarios = [
  ...(JSON.parse(readFileSync(new URL('../eval/scenarios.json', import.meta.url), 'utf8')) as Scenario[]),
  ...(JSON.parse(readFileSync(new URL('../eval/holdout/scenarios.json', import.meta.url), 'utf8')) as Scenario[]),
];
// eval.ts runs the live, credentialed harness at module load, so inspect its
// source rather than importing it into the offline test process. query.ts is
// read as source too so the unexported ANSWER_SYSTEM template is covered.
const evalSource = readFileSync(new URL('../src/eval.ts', import.meta.url), 'utf8');
const querySource = readFileSync(new URL('../src/query.ts', import.meta.url), 'utf8');

const normalize = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim();
const prompts = normalize([
  EXTRACTION_SYSTEM,
  SELECT_SYSTEM,
  RECONCILE_SYSTEM,
  evalSource,
  querySource,
].join('\n'));

test('prompts do not contain eval questions or substantive gold answers', () => {
  for (const scenario of scenarios) {
    assert.equal(
      prompts.includes(normalize(scenario.question)),
      false,
      `eval question leaked into a prompt: "${scenario.question}"`,
    );

    if (scenario.expected.length >= 20) {
      assert.equal(
        prompts.includes(normalize(scenario.expected)),
        false,
        `gold answer leaked into a prompt: "${scenario.expected}"`,
      );
    }
  }
});
