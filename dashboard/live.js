const byId = (id) => document.getElementById(id);
const statusLabels = {
  open: '열림', checking: '확인 중', conflict: '충돌',
  draft: '초안', merged: '머지 완료', closed: '닫힘',
};
const typeLabels = { commit: '커밋', pr: 'PR', merge: '머지', conflict: '충돌' };
const clock = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const updatedClock = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const pageSize = 30;
let visibleCount = pageSize;
let kind = 'all';
let snapshot;

function el(tag, content, className) {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  if (className) node.className = className;
  return node;
}

function showRows(id, rows, emptyMessage) {
  byId(id).replaceChildren(...(rows.length ? rows : [el('li', emptyMessage, 'empty')]));
}

function pullNumber({ id }) {
  return Number(id?.match(/^(?:pr|merge|conflict):(\d+)(?::|$)/)?.[1] ?? 0);
}

function renderActivity() {
  const { activity, people } = snapshot;
  const names = new Map(people.map(({ login, name }) => [login, name]));
  const filtered = activity.filter((event) => kind === 'all' || event.type === kind || (kind === 'pr' && pullNumber(event) > 0));
  const pullEvents = filtered.filter(pullNumber).sort((a, b) => pullNumber(b) - pullNumber(a));
  // Keep commit positions while sorting all PR events before paging.
  let nextPull = 0;
  const ordered = filtered.map((event) => pullNumber(event) ? pullEvents[nextPull++] : event);
  const rows = ordered.slice(0, visibleCount).map((event) => {
    const row = el('li', undefined, 'row activity-row');
    const time = el('time', clock.format(new Date(event.at)));
    time.dateTime = event.at;
    const description = el('div');
    const name = names.get(event.person) ?? event.person ?? '작성자 미연결';
    description.append(el('strong', event.title), el('div', name + ' · ' + event.branch, 'meta'));
    row.append(time, el('span', typeLabels[event.type], 'tag ' + event.type), description);
    return row;
  });
  showRows('activity', rows, '표시할 활동이 없어요.');
  byId('more').hidden = filtered.length <= visibleCount;
}

function render() {
  const { activity, people, pulls } = snapshot;
  const mergedCount = pulls.filter(({ status }) => status === 'merged').length;
  const mergePercent = pulls.length ? Math.floor(1000 * mergedCount / pulls.length) / 10 : 0;
  byId('open-count').textContent = pulls.filter(({ status }) => status !== 'merged' && status !== 'closed').length;
  byId('merge-count').textContent = mergedCount;
  byId('merge-percent').textContent = mergePercent + '% 완료';
  byId('merge-progress').value = mergePercent;
  byId('merge-progress-count').textContent = mergedCount + ' / ' + pulls.length + '개 머지';
  byId('commit-count').textContent = activity.filter(({ type }) => type === 'commit').length;
  byId('conflict-count').textContent = pulls.filter(({ status }) => status === 'conflict').length;
  showRows('pulls', pulls.slice().sort((a, b) => b.number - a.number).map(({ number, status }) => {
    const row = el('li', undefined, 'row pr-row');
    row.append(el('strong', '#' + number), el('span', statusLabels[status], 'tag ' + status));
    return row;
  }), '등록된 PR이 없어요.');
  showRows('people', people.map(({ login, name }) => {
    const row = el('li', undefined, 'row member');
    const member = el('div');
    member.append(el('strong', name), el('span', '@' + login, 'meta'));
    const commits = activity.filter((event) => event.person === login && event.type === 'commit').length;
    const merges = activity.filter((event) => event.person === login && event.type === 'merge').length;
    row.append(member, el('span', '커밋 ' + commits + ' · 머지 ' + merges, 'meta'));
    return row;
  }), '팀원 정보를 불러오는 중이에요.');
  renderActivity();
}

byId('filters').addEventListener('click', (event) => {
  const button = event.target.closest('[data-kind]');
  if (!button || !snapshot) return;
  kind = button.dataset.kind;
  visibleCount = pageSize;
  for (const filter of byId('filters').querySelectorAll('button')) {
    filter.setAttribute('aria-pressed', String(filter === button));
  }
  renderActivity();
});
byId('more').addEventListener('click', () => {
  visibleCount += pageSize;
  renderActivity();
});

const menuLinks = [...document.querySelectorAll('aside nav a')];
function renderView() {
  const selected = menuLinks.find((link) => link.hash === location.hash) ?? menuLinks[0];
  byId('overview').dataset.view = selected.hash.slice(1);
  for (const link of menuLinks) {
    if (link === selected) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', renderView);
renderView();

const embedded = document.querySelector('meta[name="discord-app-id"]');
let discordHeaders;

async function refresh() {
  try {
    const options = { cache: 'no-store', signal: AbortSignal.timeout(8000) };
    let response = await fetch('/api/dashboard', { ...options, headers: discordHeaders });
    if (response.status === 401 && embedded) {
      const { activityHeaders } = await import('/activity.js');
      discordHeaders = await activityHeaders();
      response = await fetch('/api/dashboard', { ...options, signal: AbortSignal.timeout(8000), headers: discordHeaders });
    }
    if (!response.ok) throw new Error('dashboard unavailable');
    const data = await response.json();
    if (!snapshot || snapshot.updatedAt !== data.updatedAt) {
      snapshot = data;
      render();
    }
    const lagging = data.updatedAt && Date.now() - Date.parse(data.updatedAt) > 120_000;
    byId('connection').textContent = lagging ? 'GitHub 동기화 지연' : data.updatedAt ? 'GitHub 연결됨' : data.preview ? 'Discord 미리보기' : embedded ? 'Discord 연결됨' : 'GitHub 연결 대기 중';
    byId('updated').textContent = data.updatedAt ? '마지막 동기화 ' + updatedClock.format(new Date(data.updatedAt)) + ' KST' : '마지막 동기화 —';
  } catch {
    byId('connection').textContent = embedded
      ? 'Discord 연결 대기 중' : '연결 재시도 중';
  } finally {
    setTimeout(refresh, 15_000);
  }
}
refresh();
