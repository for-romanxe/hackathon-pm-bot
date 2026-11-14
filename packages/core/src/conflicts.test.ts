import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Config } from './config.js';
import { createConflictCheck } from './conflicts.js';

test('alerts once per confirmed conflict and again if it returns after resolution', async () => {
  let mergeable: boolean | null = null;
  const github = {
    paginate: async () => [{ number: 24 }],
    rest: {
      pulls: {
        list: () => {},
        get: async () => ({
          data: {
            state: 'open', mergeable, html_url: 'https://github.com/team/demo/pull/24',
            head: { ref: 'feature' }, base: { ref: 'main' }, assignees: [{ login: 'owner' }],
          },
        }),
      },
    },
  };
  const getClient = (async () => github) as unknown as NonNullable<Parameters<typeof createConflictCheck>[1]>;
  const check = createConflictCheck({ githubToken: 'test-token' }, getClient);
  const config = { org: 'team', repos: ['demo'] } as Config;
  const alerts: string[] = [];
  const run = () => check(config, async (message) => { alerts.push(message); });
  await run();
  assert.equal(alerts.length, 0);
  mergeable = false;
  await run();
  await run();
  assert.equal(alerts.length, 1);
  assert.match(alerts[0] ?? '', /team\/demo#24.*\n브랜치: feature → main\n담당자 또는 작성자: owner/);
  mergeable = true;
  await run();
  mergeable = false;
  await run();
  assert.equal(alerts.length, 2);
});
