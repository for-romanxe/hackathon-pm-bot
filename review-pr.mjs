import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [number] = process.argv.slice(2);
if (process.argv.length !== 3 || !/^[1-9]\d*$/.test(number ?? '')) {
  console.error('사용법: node review-pr.mjs <PR 번호>');
  process.exit(1);
}

const { owner, repo } = JSON.parse(readFileSync(new URL('./launch-team.json', import.meta.url), 'utf8'));
const repository = owner + '/' + repo;
const gh = (...args) => execFileSync('gh', [...args, '--repo', repository], {
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024,
});

try {
  const readHead = () => JSON.parse(gh('pr', 'view', number, '--json', 'number,url,state,headRefOid'));
  const before = readHead();
  if (before.state !== 'OPEN') throw new Error('열린 PR 번호를 입력해.');
  const diff = gh('pr', 'diff', number, '--color', 'never');
  const after = readHead();
  if (before.headRefOid !== after.headRefOid || after.state !== 'OPEN') {
    throw new Error('조회 도중 PR 상태나 커밋이 바뀌었어. 다시 실행해.');
  }
  console.log(JSON.stringify(after));
  process.stdout.write(diff);
} catch (error) {
  console.error(error.stderr?.trim() || error.message);
  process.exitCode = 1;
}
