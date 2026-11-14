import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigSchema } from './config.js';
import { reviewPrByNumber } from './pr-review.js';

const config = ConfigSchema.parse({ org: 'Team', repos: ['demo'] });
const secrets = { githubToken: 'unused' };
const patch = { filename: 'src/app.js', patch: '@@ -1 +1 @@\n-old\n+new' };

function fakeClient(rows: Record<string, unknown[] | Error>) {
  const pull = {
    head: { sha: 'abcdef012' }, base: { sha: '123', ref: 'main', repo: { default_branch: 'main' } },
    state: 'open', merged: false, draft: false, mergeable: true, mergeable_state: 'clean',
    user: { login: 'developer' }, html_url: 'https://github.com/Team/demo/pull/17',
  };
  return (async () => ({
    rest: {
      issues: { listComments: 'conversation' },
      pulls: {
        get: async () => ({ data: pull }), listFiles: 'files', listReviews: 'reviews', listReviewComments: 'inline',
      },
    },
    paginate: async (source: string, params: { issue_number?: number; pull_number?: number }) => {
      assert.equal(params.issue_number ?? params.pull_number, 17);
      const row = rows[source];
      if (row instanceof Error) throw row;
      return row ?? [];
    },
  })) as unknown as NonNullable<Parameters<typeof reviewPrByNumber>[4]>;
}

test('reviews latest patch with conversation, published review and inline context', async () => {
  const source = fakeClient({
    files: [patch],
    conversation: [{ body: 'fixed latest', user: { login: 'dev' }, updated_at: '2026-11-14T06:00:00Z' }],
    reviews: [{ body: 'previous issue', state: 'COMMENTED' }, { body: 'unpublished', state: 'PENDING' }],
    inline: [{ body: 'original line', path: 'src/app.js', line: 1, commit_id: '123' }],
  });
  const reply = await reviewPrByNumber(config, secrets, 17, 'demo', source, async (input, discussion) => {
    assert.equal(JSON.parse(input)[0].patch, patch.patch);
    const items = JSON.parse(discussion!);
    assert.deepEqual(items.map((item: { kind: string }) => item.kind).sort(), ['comment', 'inline', 'review']);
    assert.ok(items.some((item: { kind: string; path?: string; line?: number }) =>
      item.kind === 'inline' && item.path === 'src/app.js' && item.line === 1));
    return { findings: [] };
  });
  assert.match(reply, /머지해도 돼요/);
  assert.doesNotMatch(reply, /fixed latest|original line/);
});

test('reports incomplete discussion and keeps the patch review when a comment endpoint fails', async () => {
  const source = fakeClient({
    files: [patch], conversation: new Error('failing endpoint'), inline: [{ body: 'available inline comment' }],
  });
  const reply = await reviewPrByNumber(config, secrets, 17, 'demo', source, async (_input, discussion) => {
    assert.match(discussion ?? '', /available inline comment/);
    return { findings: [] };
  });
  assert.match(reply, /일부 PR 댓글은 조회 실패/);
  assert.doesNotMatch(reply, /머지해도 돼요/);
});

test('keeps findings for changed files even when the line is outside the diff', async () => {
  const source = fakeClient({
    files: [{ ...patch, patch: '@@ -1,2 +1,2 @@\n-old\n+new\n context' }],
  });
  const reply = await reviewPrByNumber(config, secrets, 17, 'demo', source, async () => ({
    findings: [
      { path: 'src/app.js', line: 2, comment: 'Context line' },
      { path: 'src/app.js', line: 99, comment: 'File-level concern' },
      { path: 'src/unknown.js', line: 1, comment: 'Unknown file' },
    ],
  }));
  assert.match(reply, /src\/app\.js:2.*Context line/);
  assert.match(reply, /줄 번호 미확인.*File-level concern/);
  assert.match(reply, /지적 1건은 변경 파일과 연결할 수 없어/);
  assert.doesNotMatch(reply, /Unknown file|머지해도 돼요/);
});
