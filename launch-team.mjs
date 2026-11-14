import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startAt } from './dashboard-team.mjs';

process.chdir(fileURLToPath(new URL('.', import.meta.url)));

const workerEntry = 'packages/core/dist/cli.js';
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' }).trim();
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

function startDetached(command, args, env, logPath) {
  const output = openSync(logPath, 'a', 0o600);
  try {
    const child = spawn(command, args, { env, detached: true, stdio: ['ignore', output, output] });
    child.unref();
    return child;
  } finally {
    closeSync(output);
  }
}

async function waitForTunnel(logPath, accessKey) {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    const url = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)?.[0];
    if (url) {
      const joinUrl = `${url}/join/${accessKey}`;
      const response = await fetch(joinUrl, {
        redirect: 'manual', signal: AbortSignal.timeout(3000),
      }).catch(() => null);
      const cookie = response?.headers.get('set-cookie')?.split(';')[0];
      if (response?.status === 303 && response.headers.get('location') === '/' && cookie?.startsWith('__Host-inky=')) {
        const dashboard = await fetch(url, {
          headers: { Cookie: cookie }, signal: AbortSignal.timeout(3000),
        }).catch(() => null);
        if (dashboard?.ok) return joinUrl;
      }
    }
    await setTimeout(750);
  }
  throw new Error(`대시보드 공개 주소를 만들지 못했어. ${logPath}를 확인해.`);
}

async function launch() {
  const args = process.argv.slice(2);
  const checkOnly = args.length === 1 && args[0] === '--check';
  if (args.length && !checkOnly) throw new Error('사용법: node launch-team.mjs [--check]');


  if (!existsSync('launch-team.json')) throw new Error('launch-team.example.json을 launch-team.json으로 복사하고 실제 팀 정보를 입력해.');
  const { owner, repo, teammates } = readJson('launch-team.json');
  if (!startAt) throw new Error('launch-team.json에 프로젝트 시작 시각(startAt)을 입력해.');
  if (!checkOnly && Date.now() < startAt) throw new Error(`프로젝트 시작 시각(${new Date(startAt).toISOString()}) 이후에 실행해.`);
  const username = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i;
  if (!username.test(owner) || !/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(repo) || repo === 'REPO_NAME') {
    throw new Error('launch-team.json에 GitHub 소유자와 실제 저장소 이름을 입력해.');
  }
  if (!Array.isArray(teammates) || teammates.some((user) => typeof user !== 'string' || !username.test(user)) ||
      new Set(teammates.map((user) => user.toLowerCase())).size !== teammates.length) {
    throw new Error('나를 제외한 팀원의 서로 다른 GitHub 아이디를 입력해.');
  }
  if (!existsSync(workerEntry)) throw new Error('HANDOFF.md의 명령으로 Inky를 먼저 빌드해.');
  const login = gh('api', 'user', '--jq', '.login');
  if (teammates.some((user) => user.toLowerCase() === login.toLowerCase())) {
    throw new Error('초대 목록에서 현재 로그인 계정을 빼줘.');
  }
  for (const user of teammates) gh('api', `users/${user}`, '--jq', '.login');

  const ghToken = gh('auth', 'token');
  if (existsSync('.env')) process.loadEnvFile('.env');
  const webhook = process.env.DISCORD_WEBHOOK_URL ?? '';
  if (!/^https:\/\/discord\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(webhook)) {
    throw new Error('.env에 Discord 채널 웹훅 URL을 입력해.');
  }
  const response = await fetch(webhook, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!response?.ok) throw new Error('Discord 웹훅 조회에 실패했어. URL과 네트워크를 확인해.');
  const { channel_id: channelId, guild_id: guildId } = await response.json();
  const config = readJson('inky.config.json');
  if (channelId !== config.discord.channelId || guildId !== config.discord.guildId) {
    throw new Error('웹훅이 inky.config.json의 채널 및 서버 ID와 일치하지 않아.');
  }
  const appId = process.env.DISCORD_APPLICATION_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (Boolean(appId) !== Boolean(botToken) || (appId && !/^\d+$/.test(appId))) {
    throw new Error('슬래시 명령을 사용하려면 .env에 Discord Application ID와 Bot Token을 함께 설정해.');
  }
  if (appId) config.discord.applicationId = appId;
  const target = `${owner}/${repo}`;
  console.log(`GitHub ${login} → 공개 레포 ${target}, 초대 ${teammates.join(', ')}, Discord 채널 ID ${channelId}`);
  console.log(appId ? 'Discord 슬래시 명령 설정 있음' : 'Discord 슬래시 명령 연결 대기');
  const codexStatus = spawnSync('codex', ['login', 'status'], { encoding: 'utf8', timeout: 5000 });
  const chatgptLogin = codexStatus.status === 0 && /Logged in using ChatGPT/i.test(
    (codexStatus.stdout ?? '') + (codexStatus.stderr ?? ''),
  );
  console.log(chatgptLogin ? '자동 PR 리뷰: Codex ChatGPT 로그인 확인'
    : '자동 PR 리뷰: Codex CLI 설치와 ChatGPT 로그인을 확인해.');
  if (checkOnly) return;

  mkdirSync('.inky', { recursive: true, mode: 0o700 });
  const receipt = `.inky/${owner}--${repo}.json`;
  const pidPath = '.inky/launch-worker.pid';
  if (existsSync(pidPath)) {
    const pid = Number(readFileSync(pidPath, 'utf8'));
    let running = Number.isSafeInteger(pid) && pid > 0;
    if (running) {
      try { process.kill(pid, 0); } catch (error) {
        if (error.code !== 'ESRCH') throw error;
        running = false;
      }
    }
    if (running) throw new Error(`Inky 실행 중(PID ${pid}). 중복 실행을 중단했어.`);
  }
  if (!existsSync(receipt)) {
    gh('repo', 'create', target, '--public', '--add-readme');
    writeFileSync(receipt, JSON.stringify({ target, invited: [] }), { mode: 0o600 });
  }
  const state = readJson(receipt);
  if (gh('repo', 'view', target, '--json', 'visibility', '--jq', '.visibility') !== 'PUBLIC') {
    throw new Error('레포 공개 범위를 확인해.');
  }
  if (!state.initialCommit) {
    if (state.invited.length) throw new Error('실행 기록에 초기 README 커밋 SHA를 입력해.');
    const initialCommit = gh('api', `repos/${target}/commits?per_page=2`, '--jq', 'if length == 1 then .[0].sha else empty end');
    if (!/^[a-f0-9]{40}$/.test(initialCommit)) throw new Error('초기 README 커밋을 확인하지 못했어.');
    state.initialCommit = initialCommit;
    writeFileSync(receipt, JSON.stringify(state));
  }
  for (const user of teammates) {
    if (state.invited.includes(user)) continue;
    gh('api', '--method', 'PUT', `repos/${target}/collaborators/${user}`);
    state.invited.push(user);
    writeFileSync(receipt, JSON.stringify(state));
    console.log(`초대 요청 처리: ${user}`);
  }

  const token = process.env.GITHUB_TOKEN || ghToken;
  const access = await fetch(`https://api.github.com/repos/${target}/pulls?per_page=1`, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'Hackathon-PM-Bot' },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!access?.ok) throw new Error('Inky의 GitHub 읽기 요청에 실패했어. 토큰과 네트워크를 확인해.');
  const configPath = '.inky/launch-config.json';
  const dataPath = `.inky/${owner}--${repo}-dashboard.json`;
  config.discord.standupStartAt = new Date(startAt).toISOString();
  writeFileSync(configPath, JSON.stringify({ ...config, org: owner, repos: [repo] }, null, 2));
  if (appId) {
    const { registerCommands } = await import('./packages/core/dist/commands.js');
    try {
      await registerCommands({ token: botToken, applicationId: appId, guildId, dashboardLink: true, log: console.log });
    } catch {
      throw new Error('Discord 명령 등록 실패. 앱이 대상 서버에 설치됐는지 확인해.');
    }
  }
  const port = process.env.DASHBOARD_PORT ?? '4184';
  const dashboardAccessKey = randomBytes(24).toString('base64url');
  const dashboardLog = '.inky/dashboard.log';
  const refreshLog = '.inky/dashboard-refresh.log';
  const tunnelLog = `.inky/dashboard-tunnel-${Date.now()}.log`;
  const dashboard = startDetached(process.execPath, ['dashboard-server.mjs'], {
    PATH: process.env.PATH, DASHBOARD_PORT: port, DASHBOARD_DATA_PATH: dataPath, DASHBOARD_ACCESS_KEY: dashboardAccessKey,
  }, dashboardLog);
  const refresh = startDetached(process.execPath, ['dashboard-refresh.mjs', configPath, '--watch'], {
    PATH: process.env.PATH, GITHUB_TOKEN: token, DASHBOARD_DATA_PATH: dataPath, DASHBOARD_INITIAL_COMMIT: state.initialCommit,
  }, refreshLog);
  const tunnel = startDetached('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`], {
    PATH: process.env.PATH, HOME: process.env.HOME,
  }, tunnelLog);
  tunnel.on('error', (error) => console.error(`대시보드 터널 실행 실패: ${error.message}`));
  writeFileSync('.inky/dashboard-processes.json', JSON.stringify({ dashboard: dashboard.pid, refresh: refresh.pid, tunnel: tunnel.pid, port }, null, 2), { mode: 0o600 });
  let dashboardUrl;
  try {
    dashboardUrl = await waitForTunnel(tunnelLog, dashboardAccessKey);
    console.log('팀 대시보드 링크 접속 확인.');
  } catch (error) {
    console.error(error.message);
  }

  const logPath = '.inky/launch-worker.log';
  const runtimeEnv = { ...process.env, GITHUB_TOKEN: token, DISCORD_WEBHOOK_URL: webhook, DASHBOARD_JOIN_URL: dashboardUrl ?? '' };
  const worker = startDetached(process.execPath, [workerEntry, 'serve', '--config', configPath], runtimeEnv, logPath);
  await new Promise((resolve, reject) => {
    worker.once('spawn', resolve);
    worker.once('error', reject);
  });
  writeFileSync(pidPath, String(worker.pid));
  await setTimeout(1000);
  if (worker.exitCode !== null || worker.signalCode !== null) throw new Error(`Inky 종료. ${logPath}를 확인해.`);
  console.log(`Inky 실행 중(PID ${worker.pid}). https://github.com/${target}`);

  const dashboardNotice = dashboardUrl ? `팀 대시보드 · <${dashboardUrl}>` : `대시보드 터널 연결 실패 · ${tunnelLog} 확인`;
  const posted = await fetch(`${webhook}?wait=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: `Inky 연결 완료 · https://github.com/${target}\n${dashboardNotice}`, allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!posted?.ok) throw new Error('봇은 실행 중이지만 Discord 시작 알림 전송은 확인하지 못했어.');
  console.log('Discord 시작 알림 전송 확인.');
}

launch().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
