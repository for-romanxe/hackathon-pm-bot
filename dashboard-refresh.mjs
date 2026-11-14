import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { loadConfig, loadSecrets } from './packages/core/dist/config.js';
import { resolveOctokit } from './packages/core/dist/github-auth.js';
import { startAt, team } from './dashboard-team.mjs';

const config = loadConfig(process.argv[2] ?? '.inky/launch-config.json');
const [repo] = config.repos;
const owner = config.org;
const dataPath = process.env.DASHBOARD_DATA_PATH;
const initialCommit = process.env.DASHBOARD_INITIAL_COMMIT;
const reportStart = config.discord.standupStartAt ? Date.parse(config.discord.standupStartAt) : startAt;
if (config.repos.length !== 1 || !dataPath) {
  throw new Error('저장소 한 곳과 대시보드 데이터 경로가 필요해.');
}
const github = await resolveOctokit(config, loadSecrets());
const since = new Date(reportStart).toISOString();
const params = { owner, repo, per_page: 100 };

function readPrevious() {
  try { return JSON.parse(readFileSync(dataPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { pulls: [], activity: [] };
    throw error;
  }
}

async function refresh() {
  const previous = readPrevious();
  const events = new Map(previous.activity.map((entry) => [entry.id, entry]));
  function record(id, at, type, login, title, branch) {
    if (!at || Date.parse(at) < reportStart) return;
    events.set(id, { id, at, type, person: login?.toLowerCase() ?? null, title, branch });
  }

  const branches = await github.paginate(github.rest.repos.listBranches, params);
  for (const branch of branches) {
    const commits = await github.paginate(github.rest.repos.listCommits, { ...params, sha: branch.name, since });
    for (const commit of commits) {
      if (commit.sha === initialCommit || events.has('commit:' + commit.sha)) continue;
      record('commit:' + commit.sha, commit.commit.committer?.date, 'commit', commit.author?.login,
        commit.commit.message.split('\n')[0], branch.name);
    }
  }

  const pulls = [];
  const knownPulls = new Map(previous.pulls.map((pr) => [pr.number, pr.status]));
  const listed = await github.paginate(github.rest.pulls.list, { ...params, state: 'all' });
  for (const pull of listed) {
    if (Date.parse(pull.created_at) < reportStart) continue;
    const { number, user } = pull;
    const branch = pull.head.ref + ' → ' + pull.base.ref;
    let status;
    if (pull.state === 'open') {
      const { data } = await github.rest.pulls.get({ owner, repo, pull_number: number });
      // GitHub can recompute mergeability asynchronously after a push.
      status = data.mergeable === false ? 'conflict'
        : data.mergeable === null ? 'checking'
        : data.draft ? 'draft' : 'open';
    } else {
      status = pull.merged_at ? 'merged' : 'closed';
    }
    pulls.push({ number, status });
    record('pr:' + number, pull.created_at, 'pr', user?.login, '#' + number + ' 열림', branch);
    record('merge:' + number, pull.merged_at, 'merge', user?.login, '#' + number + ' 머지 완료', branch);
    if (status === 'conflict' && knownPulls.get(number) !== 'conflict') {
      const now = new Date().toISOString();
      record('conflict:' + number + ':' + now, now, 'conflict', user?.login, '#' + number + ' 충돌 감지', branch);
    }
  }
  const activity = [...events.values()].sort((a, b) => b.at.localeCompare(a.at));
  pulls.sort((a, b) => b.number - a.number);
  mkdirSync(dirname(dataPath), { recursive: true, mode: 0o700 });
  const temporary = dataPath + '.' + process.pid + '.tmp';
  writeFileSync(temporary, JSON.stringify({ updatedAt: new Date().toISOString(), people: team, pulls, activity }), { mode: 0o600 });
  renameSync(temporary, dataPath);
  console.log(`dashboard: refreshed ${activity.length} activities, ${pulls.length} PRs`);
}

const watch = process.argv.includes('--watch');
do {
  try { await refresh(); }
  catch (error) {
    console.error('dashboard: refresh failed:', error.message);
    if (!watch) process.exitCode = 1;
  }
  if (watch) await setTimeout(45_000);
} while (watch);
