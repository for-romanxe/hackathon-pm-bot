import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Config, Secrets } from './config.js';
import { resolveOctokit } from './github-auth.js';
import { reviewWithCodex } from './codex-pr-review.js';

const MAX_REVIEW_INPUT_LENGTH = 500_000;
const MAX_DISCUSSION_LENGTH = 20_000;
const MAX_COMMENT_LENGTH = 2_000;

const report = z.object({
  findings: z.array(z.object({
    path: z.string(), line: z.number().int().positive(), comment: z.string().min(1).max(400),
  })).max(4),
});

function visibleLines(patch: string): Set<number> {
  const lines = new Set<number>();
  let line: number | undefined;
  for (const text of patch.split('\n')) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(text);
    if (header) line = Number(header[1]);
    else if (line !== undefined && /^[+ ]/.test(text)) lines.add(line++);
  }
  return lines;
}

export function createPrReviewer(
  secrets: Secrets, getClient = resolveOctokit, reviewPatch = reviewWithCodex, statePath?: string,
) {
  const reviewed = new Set<string>();
  let loaded = false;
  const skipped = new Map<string, string>();
  const retryAfter = new Map<string, number>();

  return async (config: Config, notify: (message: string) => Promise<void>, log: (message: string) => void) => {
    if (statePath && !loaded) {
      const saved = await readFile(statePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '[]';
        throw error;
      });
      for (const key of z.array(z.string()).parse(JSON.parse(saved))) reviewed.add(key);
      loaded = true;
    }
    const github = await getClient(config, secrets);
    for (const repo of config.repos) {
      const owner = config.org;
      const pulls = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', per_page: 100 });
      for (const pull of pulls) {
        if (pull.draft) continue;
        const key = `${owner}/${repo}#${pull.number}`;
        const sha = pull.head.sha;
        const revision = key + ':' + sha;
        if (reviewed.has(key) || skipped.get(key) === sha || (retryAfter.get(revision) ?? 0) > Date.now()) continue;
        const params = { owner, repo, pull_number: pull.number };
        let result: ReviewResult;
        try {
          result = await reviewPull(github, params, pull, '자동', reviewPatch);
        } catch {
          retryAfter.set(revision, Date.now() + 10 * 60_000);
          log(`inky: 자동 PR 리뷰 실패 (${key}). 10분 뒤 재시도합니다.`);
          continue;
        }
        const { data: current } = await github.rest.pulls.get(params);
        if (current.state !== 'open' || current.draft || current.head.sha !== sha) continue;
        await notify(result.message);
        if (result.completed) {
          reviewed.add(key);
          if (statePath) {
            await mkdir(dirname(statePath), { recursive: true });
            const tmp = statePath + '.tmp';
            await writeFile(tmp, JSON.stringify([...reviewed]) + '\n', { mode: 0o600 });
            await rename(tmp, statePath);
          }
        } else {
          skipped.set(key, sha);
        }
        retryAfter.delete(revision);
      }
    }
  };
}

type GitHub = Awaited<ReturnType<typeof resolveOctokit>>;
type PullParams = { owner: string; repo: string; pull_number: number };
type Pull = { head: { sha: string }; html_url: string; user?: { login: string } | null };

async function getDiscussion(github: GitHub, params: PullParams, remaining: number) {
  const { owner, repo, pull_number } = params;
  const limit = Math.min(remaining, MAX_DISCUSSION_LENGTH);
  const results = await Promise.allSettled([
    github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: pull_number, per_page: 100 })
      .then((items) => items.map((item) => ({ kind: 'comment', author: item.user?.login, body: item.body, at: item.updated_at }))),
    github.paginate(github.rest.pulls.listReviews, { ...params, per_page: 100 })
      .then((items) => items.filter((item) => item.state !== 'PENDING')
        .map((item) => ({ kind: 'review', author: item.user?.login, body: item.body, at: item.submitted_at }))),
    github.paginate(github.rest.pulls.listReviewComments, { ...params, per_page: 100 })
      .then((items) => items.map((item) => ({
        kind: 'inline', author: item.user?.login, body: item.body, at: item.updated_at,
        path: item.path, line: item.line, originalLine: item.original_line, commit: item.commit_id,
      }))),
  ]);
  let omitted = results.some((result) => result.status === 'rejected');
  const recent = results.flatMap<{ body: string | undefined; at: string | undefined }>((result) => result.status === 'fulfilled' ? result.value : [])
    .filter((item) => item.body?.trim())
    .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  const entries: string[] = [];
  let length = 2; // brackets
  for (const item of recent) {
    const body = item.body!.trim();
    if (body.length > MAX_COMMENT_LENGTH) omitted = true;
    const entry = JSON.stringify({ ...item, body: body.slice(0, MAX_COMMENT_LENGTH) });
    const size = entry.length + Number(entries.length > 0);
    if (length + size > limit) {
      omitted = true;
      continue;
    }
    entries.push(entry);
    length += size;
  }
  return { json: entries.length ? '[' + entries.reverse().join(',') + ']' : undefined, omitted };
}

type ReviewResult = { message: string; completed: boolean; clean: boolean };

async function reviewPull(
  github: GitHub,
  params: PullParams,
  pull: Pull,
  mode: '자동' | '요청',
  reviewPatch: typeof reviewWithCodex,
): Promise<ReviewResult> {
  const files = await github.paginate(github.rest.pulls.listFiles, { ...params, per_page: 100 });
  const patches = files.flatMap((file) => file.patch ? [{ path: file.filename, patch: file.patch }] : []);
  const input = JSON.stringify(patches);
  const key = `${params.owner}/${params.repo}#${params.pull_number}`;
  const author = pull.user?.login ?? '알 수 없음';
  const heading = `🔎 ${mode} PR 리뷰 [${key}](${pull.html_url}) · ${pull.head.sha.slice(0, 7)} · 작성자 \`${author}\``;
  let review: string;
  let completed = false;
  let clean = false;
  if (!patches.length) {
    review = `검토 가능한 텍스트 변경분이 없어 ${mode} 리뷰를 건너뛰었어요.`;
  } else if (input.length > MAX_REVIEW_INPUT_LENGTH) {
    const size = input.length.toLocaleString('ko-KR');
    const limit = MAX_REVIEW_INPUT_LENGTH.toLocaleString('ko-KR');
    review = `변경분이 ${mode} 리뷰 한도를 초과해서 건너뛰었어요. (검토 입력 ${size}자 / 한도 ${limit}자)`;
  } else {
    const discussion = await getDiscussion(github, params, MAX_REVIEW_INPUT_LENGTH - input.length);
    const parsed = report.parse(await reviewPatch(input, discussion.json));
    completed = true;
    const positions = new Map(patches.map(({ path, patch }) => [path, visibleLines(patch)]));
    const notes: string[] = [];
    let unknownPaths = 0;
    for (const { path, line, comment } of parsed.findings) {
      const lines = positions.get(path);
      if (!lines) {
        unknownPaths++;
        continue;
      }
      const file = path.replace(/[`\r\n]/g, '');
      const location = lines.has(line) ? `${file}:${line}` : file;
      const label = lines.has(line) ? '' : ' (줄 번호 미확인)';
      notes.push(`- \`${location}\`${label} — ${comment}`);
    }
    if (patches.length < files.length) {
      notes.push(`파일 ${files.length - patches.length}개의 텍스트 변경분을 받지 못했어요.`);
    }
    if (unknownPaths) {
      notes.push(`지적 ${unknownPaths}건은 변경 파일과 연결할 수 없어 표시하지 않았어요.`);
    }
    clean = notes.length === 0 && !discussion.omitted;
    review = notes.join('\n') || '검토한 변경분에서 구체적인 지적을 찾지 못했어요.';
    if (discussion.omitted) review += '\n일부 PR 댓글은 조회 실패 또는 입력 한도로 반영하지 못했어요.';
  }
  return { message: heading + '\n' + review, completed, clean };
}

export async function reviewPrByNumber(
  config: Config, secrets: Secrets, number: number, repo: string,
  getClient = resolveOctokit, reviewPatch = reviewWithCodex,
): Promise<string> {
  const github = await getClient(config, secrets);
  const params = { owner: config.org, repo, pull_number: number };
  const pull = await github.rest.pulls.get(params).catch((error: unknown) => {
    if ((error as { status?: number } | null)?.status === 404) return undefined;
    throw error;
  });
  if (!pull) return `#${number} PR을 ${repo}에서 찾지 못했어요.`;
  const result = await reviewPull(github, params, pull.data, '요청', reviewPatch);
  const { data: current } = await github.rest.pulls.get(params);
  if (current.head.sha !== pull.data.head.sha || current.base.sha !== pull.data.base.sha) {
    return `#${number} PR이 검토 중 업데이트됐어요. 최신 변경분을 보려면 다시 요청해 주세요.`;
  }
  if (!result.clean) return result.message;

  const link = `[#${number}](${current.html_url})`;
  if (current.merged) return `${link} 검토에서 지적할 문제가 없어요. 이미 머지됐어요.`;
  if (current.state !== 'open') return `${link} 검토에서 지적할 문제는 없지만, 닫힌 PR이라 머지할 수 없어요.`;
  if (current.draft) return `${link} 검토에서 지적할 문제는 없지만, 아직 초안이에요.`;
  if (current.mergeable === false) return `${link} 코드 리뷰에서 지적할 문제는 없지만, 머지 충돌을 먼저 해결해야 해요.`;
  const target = current.base.repo.default_branch;
  if (current.base.ref !== target) {
    return `${link} 코드 리뷰에서 지적할 문제는 없어요. 현재 대상은 \`${current.base.ref}\`이라 \`${target}\`에 머지할 수 있는지는 별도 확인이 필요해요.`;
  }
  if (current.mergeable !== true || current.mergeable_state !== 'clean') {
    return `${link} 코드 리뷰에서 지적할 문제는 없지만, GitHub에서 머지 준비가 확인되지 않았어요.`;
  }
  return `${link} 검토한 변경분에서 지적할 문제가 없고 GitHub에서도 머지 가능한 상태예요. 머지해도 돼요.`;
}
