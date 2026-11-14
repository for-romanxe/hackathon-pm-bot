import { existsSync, readFileSync } from 'node:fs';

const path = new URL('./launch-team.json', import.meta.url);
const settings = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
export const startAt = settings.startAt ? Date.parse(settings.startAt) : 0;
if (!Number.isFinite(startAt)) throw new Error('launch-team.json의 startAt에 ISO 날짜를 입력해.');
export const team = (settings.team ?? []).map(({ login, name }) => ({ login: login.toLowerCase(), name }));
