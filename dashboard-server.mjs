import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { team } from './dashboard-team.mjs';

const port = Number(process.env.DASHBOARD_PORT ?? 4182);
const { DASHBOARD_DATA_PATH: dataPath, DASHBOARD_ACCESS_KEY: accessKey } = process.env;
if (dataPath && !accessKey) throw new Error('실전 대시보드에 팀 링크의 접속 키가 필요해.');
const digest = (value) => createHash('sha256').update(value).digest();
const accessDigest = accessKey && digest(accessKey);
const sessionToken = accessKey && digest('inky-session:' + accessKey).toString('base64url');
const sessionDigest = sessionToken && digest(sessionToken);
const routes = new Map([
  ['/', ['live.html', 'text/html']],
  ['/index.html', ['live.html', 'text/html']],
  ['/live.css', ['live.css', 'text/css']],
  ['/live.js', ['live.js', 'text/javascript']],
]);

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

createServer((req, res) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
  const path = req.url?.split('?')[0];
  if (accessDigest && path?.startsWith('/join/')) {
    const key = path.slice('/join/'.length);
    if (!timingSafeEqual(accessDigest, digest(key))) {
      return send(res, 403, 'Discord의 팀 대시보드 링크를 다시 열어주세요.');
    }
    res.setHeader('Set-Cookie', `__Host-inky=${sessionToken}; Path=/; Secure; HttpOnly; SameSite=Lax`);
    res.setHeader('Location', '/');
    return send(res, 303, '');
  }
  if (sessionDigest) {
    const cookie = req.headers.cookie?.match(/(?:^|;\s*)__Host-inky=([^;]*)/)?.[1] ?? '';
    if (!timingSafeEqual(sessionDigest, digest(cookie))) {
      return send(res, 403, 'Discord의 팀 대시보드 링크를 열어주세요.');
    }
  }
  if (path === '/api/dashboard') {
    let data;
    try { if (dataPath) data = readFileSync(dataPath); }
    catch (error) {
      if (error.code !== 'ENOENT') return send(res, 503, '활동을 읽을 수 없습니다.');
    }
    return send(res, 200, data ?? JSON.stringify({ updatedAt: null, people: team, pulls: [], activity: [] }), 'application/json; charset=utf-8');
  }
  const asset = routes.get(path);
  if (!asset) return send(res, 404, 'Not found');
  const [file, type] = asset;
  return send(res, 200, readFileSync(new URL('./dashboard/' + file, import.meta.url)), type + '; charset=utf-8');
}).listen(port, '127.0.0.1', () => console.log(`dashboard: http://127.0.0.1:${port}`));
