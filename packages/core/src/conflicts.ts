import type { Config, Secrets } from './config.js';
import { resolveOctokit } from './github-auth.js';

export function createConflictCheck(secrets: Secrets, getClient = resolveOctokit) {
  const notified = new Set<string>();

  return async (config: Config, notify: (message: string) => Promise<void>) => {
    if (!config.repos.length) throw new Error('Set explicit repos for PR conflict checks.');
    const github = await getClient(config, secrets);
    for (const repo of config.repos) {
      const owner = config.org;
      const open = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open' });
      const prefix = `${owner}/${repo}#`;
      const openKeys = new Set(open.map((pr) => prefix + pr.number));
      for (const key of notified) {
        if (key.startsWith(prefix) && !openKeys.has(key)) notified.delete(key);
      }

      for (const pr of open) {
        const key = prefix + pr.number;
        const { data } = await github.rest.pulls.get({ owner, repo, pull_number: pr.number });
        if (data.mergeable === null) continue;
        if (data.state !== 'open' || data.mergeable) {
          notified.delete(key);
          continue;
        }
        if (notified.has(key)) continue;
        const owners = data.assignees?.map(({ login }) => login).join(', ') || data.user?.login || '미지정';
        await notify(
          `⚠️ 머지 충돌: [${key}](${data.html_url})\n` +
          `브랜치: ${data.head.ref} → ${data.base.ref}\n담당자 또는 작성자: ${owners}`,
        );
        notified.add(key);
      }
    }
  };
}
