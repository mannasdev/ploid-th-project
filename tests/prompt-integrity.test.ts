import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXTRACTION_SYSTEM } from '../src/extract.js';
import { ANSWER_SYSTEM, SELECT_SYSTEM } from '../src/query.js';
import { RECONCILE_SYSTEM } from '../src/reconcile.js';
import { JUDGE_SYSTEM } from '../src/eval.js';

interface Scenario {
  question: string;
  expected: string;
}

const scenarios = [
  ...(JSON.parse(readFileSync(new URL('../eval/scenarios.json', import.meta.url), 'utf8')) as Scenario[]),
  ...(JSON.parse(readFileSync(new URL('../eval/holdout/scenarios.json', import.meta.url), 'utf8')) as Scenario[]),
];

const normalize = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim();
const prompts = normalize(
  [
    EXTRACTION_SYSTEM,
    SELECT_SYSTEM,
    ANSWER_SYSTEM('2020-01-01T00:00:00Z'),
    RECONCILE_SYSTEM,
    JUDGE_SYSTEM,
  ].join('\n'),
);

test('prompts do not mention fixture participants or channels', () => {
  const fixtureFiles = [
    '../fixtures/launch-a.json',
    '../fixtures/launch-b.json',
    '../fixtures/platform-eng.json',
    '../eval/holdout/transcript.json',
  ];
  const authors = new Set<string>();
  const channels = new Set<string>();
  for (const f of fixtureFiles) {
    const msgs = JSON.parse(readFileSync(new URL(f, import.meta.url), 'utf8')) as Array<{
      author: string;
      channel: string;
    }>;
    for (const m of msgs) {
      authors.add(m.author.toLowerCase());
      channels.add(m.channel.toLowerCase());
    }
  }
  for (const name of [...authors, ...channels]) {
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    assert.equal(re.test(prompts), false, `fixture name "${name}" appears in a prompt`);
  }
});

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
