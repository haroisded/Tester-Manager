// UAT - Manager client: hash router, answer sheets, live updates over Server-Sent Events.
const TAB = Math.random().toString(36).slice(2); // tags our own writes so we can ignore their echo
const $ = (sel, root = document) => root.querySelector(sel);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const toDate = sqlDate => new Date(`${sqlDate.replace(' ', 'T')}Z`);
const when = sqlDate => toDate(sqlDate).toLocaleDateString(undefined, { dateStyle: 'medium' });
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function ago(sqlDate) {
  const seconds = (toDate(sqlDate) - Date.now()) / 1000;
  for (const [unit, size] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const main = $('#main');

let me;             // signed-in user (includes their own password)
let route = {};     // { name: 'home' | 'users' | 'concerns' | 'downloads' | 'editor' | 'suite', id?, tab?, test? }
let S = null;       // GET /api/suites/:id payload for the open suite
let viewing = null; // suite: user id whose sheet is shown; concerns (admin): whose cards, null = every tester
let filter = 'all'; // tests: 'all' | 'na' | 'PASS' | 'FAIL'; concerns (admin): 'all' | a concern status
let current = null; // id of the test shown in the Tests tab's window (null = the first one)
let opage = 1;      // 1-based page of testers on the Overview

// Width, content and scroll change in the same frame. Setting the width before the page's fetch
// resolved used to stretch the old page for the length of the request, which read as a jump.
let routeChanged = false;
function paint(html, cls = '') {
  main.className = cls;
  main.innerHTML = html;
  if (routeChanged) {
    routeChanged = false;
    scrollTo(0, 0);
  }
}

async function api(url, opts = {}) {
  const headers = { 'X-Tab': TAB, ...opts.headers };
  if (typeof opts.body === 'string') headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401) {
    location.replace('/');
    throw new Error('Signed out');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
const send = (method, body) => ({ method, body: JSON.stringify(body) });

function toast(msg, ms = 4000) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), ms);
}
const safe = fn => async (...args) => {
  try {
    return await fn(...args);
  } catch (err) {
    toast(err.message);
  }
};

// ---------- routing ----------
// Pages the admin alone can open fall through to home for everyone else.
function parseHash() {
  const h = location.hash;
  let m;
  if ((m = h.match(/^#\/suite\/(\d+)(?:\/(problems|overview)|\/t\/(\d+))?$/))) {
    return { name: 'suite', id: Number(m[1]), tab: m[2] ?? 'tests', test: m[3] ? Number(m[3]) : null };
  }
  if (h === '#/concerns') return { name: 'concerns' };
  if (h === '#/downloads') return { name: 'downloads' };
  if (!me.is_admin) return { name: 'home' };
  if (h === '#/users') return { name: 'users' };
  if (h === '#/new') return { name: 'editor', id: null };
  if ((m = h.match(/^#\/edit\/(\d+)$/))) return { name: 'editor', id: Number(m[1]) };
  return { name: 'home' };
}
const NAV_OF = { users: 'users', concerns: 'concerns', downloads: 'downloads' }; // everything else lights up "Tests"

const router = safe(async () => {
  await flushSaves();
  const next = parseHash();
  if (next.name !== route.name || next.id !== route.id) {
    viewing = null;
    filter = 'all';
    search = '';
    page = 1;
    opage = 1;
    current = null;
    routeChanged = true;
  }
  if (next.test) current = next.test; // switching tabs keeps your place in the Tests tab
  route = next;
  for (const a of document.querySelectorAll('[data-nav]')) a.classList.toggle('on', a.dataset.nav === (NAV_OF[route.name] ?? 'home'));
  if (route.name === 'home') await showHome();
  else if (route.name === 'users') await showUsers();
  else if (route.name === 'concerns') await showConcerns();
  else if (route.name === 'downloads') await showDownloads();
  else if (route.name === 'editor') await showEditor();
  else await showSuite();
});

// ---------- home: a searchable, paginated gallery of test documents ----------
const PER_PAGE = 7;
let search = '';   // text typed in the gallery's search box
let page = 1;      // 1-based page of the filtered gallery
let home = null;   // last GET /api/suites payload, kept so search and paging need no refetch

async function showHome() {
  S = null;
  home = await api('/api/suites');
  if (route.name !== 'home') return;
  paint(`
    <p class="eyebrow">Test documents</p>
    <div class="page-head">
      <h1>All tests</h1>
      ${me.is_admin ? '<a class="btn primary" href="#/new">+ New tests</a>' : ''}
    </div>
    <div class="list-tools">
      <input id="suite-search" type="search" placeholder="Search tests…" aria-label="Search test documents"
             autocomplete="off" value="${esc(search)}">
      <p class="meta" id="suite-count"></p>
    </div>
    <div id="gallery"></div>`, 'wide');
  renderGallery();
}

// Only the grid and its counter redraw, so the search box keeps focus and caret while you type.
function renderGallery() {
  const grid = $('#gallery');
  if (!grid) return;
  const q = search.trim().toLowerCase();
  const list = q ? home.suites.filter(s => s.title.toLowerCase().includes(q)) : home.suites;
  const pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
  page = Math.min(Math.max(1, page), pages);
  // Testers see their own problem count; the admin sees everyone's on that document.
  const problems = id => home.problems
    .filter(p => p.suite_id === id && (me.is_admin || p.user_id === me.id))
    .reduce((n, p) => n + p.n, 0);

  $('#suite-count').textContent = `// ${plural(list.length, 'document')}${q ? ' found' : ''}`;
  if (!list.length) {
    grid.innerHTML = `<div class="empty">${q ? `Nothing matches <b>${esc(search.trim())}</b>.`
      : me.is_admin ? 'No tests yet. Use <b>New tests</b> to write or paste a test document.'
        : 'No tests yet. The bell lets you know when the admin publishes some.'}</div>`;
    return;
  }
  grid.innerHTML = `<div class="gallery">${list.slice((page - 1) * PER_PAGE, page * PER_PAGE).map(s => `
    <article class="feed-item card">
      <div class="card-head">
        <h2><a href="#/suite/${s.id}${me.is_admin ? '/overview' : ''}">${esc(s.title)}</a></h2>
        ${s.published ? '' : '<span class="tag draft">Unpublished</span>'}
      </div>
      <div class="card-body">
        <div class="counts">
          <span class="stat"><b>${s.total}</b> ${s.total === 1 ? 'test' : 'tests'}</span>
          <span class="stat"><b>${problems(s.id)}</b> ${problems(s.id) === 1 ? 'problem' : 'problems'}</span>
        </div>
        <p class="meta">Published ${when(s.created_at)}</p>
        ${me.is_admin ? `<div class="card-actions raise">
          <a class="btn small" href="#/edit/${s.id}">Edit</a>
          <button class="btn small warn" data-del-suite="${s.id}">Delete</button>
        </div>` : ''}
      </div>
    </article>`).join('')}</div>${pager(pages, page, 'page')}`;
}

// `attr` names the data attribute the click handler reads: data-page (gallery) or data-opage (Overview).
function pager(pages, at, attr) {
  if (pages < 2) return '';
  const step = (to, label, on) => `<button class="btn small" data-${attr}="${to}" ${on ? '' : 'disabled'}>${label}</button>`;
  return `<nav class="pager" aria-label="Pages">
    ${step(at - 1, '‹ Prev', at > 1)}
    <span class="page-nums">${Array.from({ length: pages }, (_, i) => i + 1).map(n =>
      `<button class="page-num ${n === at ? 'on' : ''}" data-${attr}="${n}"
        aria-current="${n === at ? 'page' : 'false'}">${n}</button>`).join('')}</span>
    ${step(at + 1, 'Next ›', at < pages)}
  </nav>`;
}

// ---------- users (admin) ----------
let users = [];
const shownPasswords = new Set(); // user ids whose password the admin revealed

async function showUsers() {
  users = await api('/api/users');
  if (route.name === 'users') renderUsers();
}

// Drawn from state, so live presence updates keep revealed passwords.
function renderUsers() {
  const online = users.filter(u => u.online).length;
  paint(`
    <p class="eyebrow">Admin</p>
    <div class="page-head"><h1>Users</h1></div>
    <p class="meta">// ${online} of ${plural(users.length, 'user')} online</p>
    <ul class="user-list card">${users.map(u => `<li>
      <div class="who">
        <span class="avatar">${esc(u.username[0].toUpperCase())}</span>
        <span class="name">${esc(u.username)}</span>
        ${u.is_admin ? '<span class="tag boxed">Admin</span>' : ''}
        <span class="presence ${u.online ? 'on' : ''}">${u.online ? 'Online' : 'Offline'}</span>
      </div>
      ${u.is_admin ? '' : `<div class="secret">
        ${u.password == null ? '<span class="muted">Password shows after their next sign-in</span>' : `
          <code>${shownPasswords.has(u.id) ? esc(u.password) : '••••••••'}</code>
          <button class="btn small" data-show-pass="${u.id}">${shownPasswords.has(u.id) ? 'Hide' : 'Show'}</button>`}
        <button class="btn small warn" data-del-user="${u.id}">Delete</button>
      </div>`}
    </li>`).join('')}</ul>`);
}

// ---------- concerns: testers write cards for the admin; the admin moves them through statuses ----------
let C = null; // GET /api/concerns payload
const CONCERN_STATUS = [['on-hold', 'On-hold', 'hold'], ['on-process', 'On-process', 'process'], ['applied', 'Applied', 'applied']];
const concernStatus = value => CONCERN_STATUS.find(([v]) => v === value);
// Head tag: the status once it reaches the admin, "Unpublished" while only its writer can see it.
const concernTag = c => (c.state === 'saved'
  ? `<span class="pill ${concernStatus(c.status)[2]}" data-tag>${concernStatus(c.status)[1]}</span>`
  : '<span class="tag draft" data-tag>Unpublished</span>');
const concernImages = id => C.images.filter(i => i.concern_id === id);
const CONCERN_CHIPS = [['all', 'All'], ...CONCERN_STATUS, ['hidden', 'Hidden']];
// The admin's cards under a chip: hidden ones leave All and their status for Hidden. Follows the tester picker.
const inView = f => C.concerns.filter(c => (viewing == null || c.user_id === viewing)
  && (f === 'hidden' ? c.hidden : !c.hidden && (f === 'all' || c.status === f)));

async function showConcerns() {
  C = await api('/api/concerns');
  if (route.name !== 'concerns') return;
  paint(`
    <p class="eyebrow">${me.is_admin ? 'Admin' : 'For the admin'}</p>
    <div class="page-head">
      <h1>Concerns</h1>
      ${me.is_admin ? '' : '<button class="btn primary" id="add-concern">+ Add concern</button>'}
    </div>
    <p class="meta" id="concern-meta"></p>
    ${me.is_admin ? `<div class="concern-tools">
      <div class="chips" id="concern-chips"></div>
      <label class="viewing">Tester <select id="concern-who"></select></label>
    </div>` : ''}
    <div id="concern-list"></div>`, 'wide');
  renderConcerns();
}

function renderConcerns() {
  const list = $('#concern-list');
  if (!list) return;
  if (me.is_admin && !C.concerns.some(c => c.user_id === viewing)) viewing = null; // their last card was deleted
  renderConcernMeta();
  if (!me.is_admin) {
    list.innerHTML = C.concerns.length
      ? `<div class="concern-grid">${C.concerns.map(myConcern).join('')}</div>`
      : '<div class="empty">Something bothering you that no test covers? Write it here and the admin will pick it up.</div>';
  } else {
    const shown = inView(filter);
    const groups = C.testers.map(u => [u, shown.filter(c => c.user_id === u.id)]).filter(([, cards]) => cards.length);
    list.innerHTML = groups.length ? groups.map(([u, cards]) => `
      <section class="concern-group">
        <p class="note">Read only · <b>${esc(u.username)}</b>'s concerns · ${cards.length}</p>
        <div class="concern-grid">${cards.map(theirConcern).join('')}</div>
      </section>`).join('')
      : `<div class="empty">${!C.concerns.length ? 'No concerns yet. Testers\' saved concerns show up here, grouped by tester.'
        : filter === 'hidden' ? 'No hidden concerns.'
          : filter === 'all' ? 'Nothing to show. Hidden concerns are under <b>Hidden</b>.'
            : `Nothing is ${concernStatus(filter)[1]} right now.`}</div>`;
  }
  list.querySelectorAll('.fit').forEach(fit);
}

function renderConcernMeta() {
  const saved = C.concerns.filter(c => c.state === 'saved');
  $('#concern-meta').textContent = me.is_admin
    ? `// ${plural(saved.length, 'concern')} from ${plural(new Set(saved.map(c => c.user_id)).size, 'tester')}`
    : '// only you and the admin see these · the admin sets the status';
  if (!me.is_admin) return;
  $('#concern-chips').innerHTML = CONCERN_CHIPS.map(([v, label]) => `<button class="chip ${filter === v ? 'on' : ''}" data-cfilter="${v}"
    aria-pressed="${filter === v}">${label} <span>${inView(v).length}</span></button>`).join('');
  $('#concern-who').innerHTML = '<option value="">All testers</option>' + C.testers.filter(u => C.concerns.some(c => c.user_id === u.id))
    .map(u => `<option value="${u.id}" ${u.id === viewing ? 'selected' : ''}>${esc(u.username)}</option>`).join('');
}

// The tester's own card: the problem card, plus the status the admin gave it.
function myConcern(c) {
  return `<article class="item card problem" id="c-${c.id}" data-concern="${c.id}" data-state="${c.state}">
    <div class="item-head card-head">
      <input id="ct${c.id}" class="title-input" value="${esc(c.title)}" maxlength="200" placeholder="Concern title" aria-label="Concern title">
      ${concernTag(c)}
    </div>
    <div class="card-body">
      <textarea class="concern-text" rows="2" placeholder="Comments (optional)" aria-label="Comments">${esc(c.comments)}</textarea>
      <div class="concern-extras">${thumbs(concernImages(c.id), true)}${NOTEPAD}</div>
      <div class="actions">
        <button type="button" class="btn small primary" data-act="saved">Publish</button>
        <button type="button" class="btn small" data-act="draft">Unpublish</button>
        <span class="save-state" aria-live="polite"></span>
        <button type="button" class="btn small warn" data-act="delete">Delete</button>
      </div>
    </div>
  </article>`;
}

// The admin's view of a tester's card: their words read-only, the status in the admin's hands.
function theirConcern(c) {
  return `<article class="item card" id="c-${c.id}" data-concern="${c.id}">
    <div class="item-head card-head">
      <h3 class="item-title">${esc(c.title)}</h3>
      ${concernTag(c)}
    </div>
    <div class="card-body">
      ${c.comments ? `<p class="pre feedback folded">${esc(c.comments)}</p>` : ''}
      <div class="status-row">
        <div class="seg" role="radiogroup" aria-label="Status of ${esc(c.title)}">
          ${CONCERN_STATUS.map(([v, label, cls]) => `<label class="${cls}">
            <input type="radio" name="cs${c.id}" value="${v}" data-status ${c.status === v ? 'checked' : ''}><span>${label}</span>
          </label>`).join('')}
        </div>
      </div>
      <div class="concern-extras">${thumbs(concernImages(c.id), false)}</div>
      <div class="card-actions">
        <button type="button" class="btn small" data-hide-concern="${c.id}">${c.hidden ? 'Unhide' : 'Hide'}</button>
        <button type="button" class="btn small warn" data-del-concern="${c.id}">Delete</button>
        ${c.comments ? NOTEPAD : ''}
      </div>
    </div>
  </article>`;
}

// `redraw` is for changes you made yourself. Otherwise a tester's cards stay put (they may be typing)
// and only their status tags update, unless a card on screen was deleted by the admin.
async function reloadConcerns(redraw) {
  if (route.name !== 'concerns') return;
  C = await api('/api/concerns');
  const gone = [...main.querySelectorAll('[data-concern]')].some(r => !C.concerns.some(c => c.id === Number(r.dataset.concern)));
  if (redraw || me.is_admin || gone) return renderConcerns();
  for (const c of C.concerns) {
    const tag = $(`#c-${c.id} [data-tag]`);
    if (tag) tag.outerHTML = concernTag(c);
  }
  renderConcernMeta();
}

async function setStatus(id, status) {
  await api(`/api/concerns/${id}/status`, send('PATCH', { status }));
  await reloadConcerns(true);
}

// Autosave and image changes land on whichever page the row lives on.
const reload = redraw => (route.name === 'concerns' ? reloadConcerns(redraw) : reloadSuite(redraw));

// ---------- downloads: the admin's app links, one card per app, older versions kept below ----------
let R = [];              // GET /api/releases payload, newest first
let editingRelease = null; // release being edited in #release, null = a new one
const RELEASE_STATUS = [['active', 'Active', 'applied'], ['laggy', 'Laggy', 'laggy'], ['maintenance', 'Under maintenance', 'fail']];
const releaseStatus = value => RELEASE_STATUS.find(([v]) => v === value);

async function showDownloads() {
  R = await api('/api/releases');
  if (route.name !== 'downloads') return;
  const open = new Set([...main.querySelectorAll('details.versions[open]')].map(d => d.dataset.app));
  const apps = Map.groupBy(R, r => r.name); // insertion order: the app with the newest release first
  paint(`
    <p class="eyebrow">Apps to test</p>
    <div class="page-head">
      <h1>Downloads</h1>
      ${me.is_admin ? '<button class="btn primary" id="new-release">+ New release</button>' : ''}
    </div>
    <p class="meta">// ${plural(apps.size, 'app')} · newest version on top, older ones below it</p>
    ${apps.size ? [...apps].map(([name, [latest, ...older]]) => `
      <section class="card release">
        <div class="card-head">
          <h2>${esc(name)}</h2>
          ${me.is_admin ? `<button class="btn small" data-new-version="${esc(name)}">+ New version</button>` : ''}
        </div>
        <div class="card-body">
          ${releaseHtml(latest, true)}
          ${older.length ? `<details class="versions" data-app="${esc(name)}" ${open.has(name) ? 'open' : ''}>
            <summary class="btn small">Previous versions (${older.length})</summary>
            ${older.map(r => `<div class="release-old">${releaseHtml(r, false)}</div>`).join('')}
          </details>` : ''}
        </div>
      </section>`).join('')
      : `<div class="empty">${me.is_admin ? 'No downloads yet. Use <b>New release</b> to add the first app.'
        : 'No downloads yet. The bell lets you know when the admin adds one.'}</div>`}`);
}

// Testers get the download button, shaped by the status; the admin gets the link and status controls.
function releaseHtml(r, latest) {
  const [, label, cls] = releaseStatus(r.status);
  const meta = `<p class="release-meta">
    <b>${esc(r.version)}</b>${latest ? ' <span class="tag boxed">Latest</span>' : ''}
    <span>· ${when(r.created_at)}${r.updated_at !== r.created_at ? ` · updated ${when(r.updated_at)}` : ''}</span>
    <span class="pill ${cls}">${label}</span>
  </p>
  <div class="md">${r.description_html}</div>`;
  if (me.is_admin) {
    return `${meta}
      <div class="status-row">
        <div class="seg" role="radiogroup" aria-label="Status of ${esc(r.name)} ${esc(r.version)}">
          ${RELEASE_STATUS.map(([v, l, c]) => `<label class="${c}">
            <input type="radio" name="rs${r.id}" value="${v}" data-rstatus="${r.id}" ${r.status === v ? 'checked' : ''}><span>${l}</span>
          </label>`).join('')}
        </div>
      </div>
      <p class="meta release-link">${r.url ? `Link: <a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.url)}</a>` : 'No link yet. Testers see "Link coming soon".'}</p>
      <div class="card-actions">
        <button class="btn small primary" data-release-link="${r.id}">${r.url ? 'Change link' : 'Set link'}</button>
        <button class="btn small" data-edit-release="${r.id}">Edit</button>
        <button class="btn small warn" data-del-release="${r.id}">Delete</button>
      </div>`;
  }
  const size = latest ? 'btn' : 'btn small';
  if (!r.url) return `${meta}<div class="release-slot"><button class="${size}" disabled>Link coming soon</button></div>`;
  if (r.status === 'maintenance') {
    return `${meta}<div class="release-slot"><button class="${size}" disabled>Under maintenance</button>
      <p class="hint">This download is being worked on. Check back later.</p></div>`;
  }
  return `${meta}<div class="release-slot">
    <a class="${size} ${latest ? 'primary' : ''}" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">Download</a>
    ${r.status === 'laggy' ? '<p class="note caution">Downloads may be slow or unstable right now.</p>' : ''}
  </div>`;
}

// One dialog for New release, New version, Edit and Set / Change link.
function openRelease(r, focus = 'rel-name') {
  editingRelease = r.id ?? null;
  $('#release-head').textContent = editingRelease ? `Edit ${r.name} ${r.version}` : 'New release';
  $('#rel-name').value = r.name ?? '';
  $('#rel-version').value = r.version ?? '';
  $('#rel-desc').value = r.description ?? '';
  $('#rel-url').value = r.url ?? '';
  $('#release-error').textContent = '';
  $('#release').showModal();
  $(`#${focus}`).focus();
}
const releaseBody = r => ({ name: r.name, version: r.version, description: r.description, url: r.url, status: r.status });
$('#release-form').addEventListener('submit', safe(async e => {
  e.preventDefault();
  const body = {
    name: $('#rel-name').value, version: $('#rel-version').value, description: $('#rel-desc').value, url: $('#rel-url').value,
    status: R.find(r => r.id === editingRelease)?.status ?? 'active',
  };
  try {
    if (editingRelease) await api(`/api/releases/${editingRelease}`, send('PUT', body));
    else await api('/api/releases', send('POST', body));
  } catch (err) {
    $('#release-error').textContent = err.message;
    return;
  }
  $('#release').close();
  toast('Download saved');
  await showDownloads();
}));

// ---------- suite page ----------
const answerOf = (testId, userId) => S.answers.find(a => a.test_id === testId && a.user_id === userId) ?? {};
const statusOf = (testId, userId) => answerOf(testId, userId).status ?? 'na'; // no status yet = N/A
const imagesOf = (key, id, userId) => S.images.filter(i => i[key] === id && i.user_id === userId);
const statusCount = (userId, status) => S.tests.filter(t => statusOf(t.id, userId) === status).length;
// Saved problems are numbered 1, 2, 3… in the order they were created; drafts get n = 0.
function problemsOf(userId) {
  let n = 0;
  return S.problems.filter(p => p.user_id === userId).map(p => ({ ...p, n: p.state === 'saved' ? ++n : 0 }));
}
function pickViewing() {
  if (!S.testers.some(u => u.id === viewing)) viewing = me.is_admin ? (S.testers[0]?.id ?? null) : me.id;
}

async function showSuite() {
  const id = route.id;
  try {
    S = await api(`/api/suites/${id}`);
  } catch (err) {
    S = null;
    paint(`<div class="empty">${esc(err.message)}<br><br><a class="btn small" href="#/">← All tests</a></div>`);
    return;
  }
  if (route.id !== id) return;
  pickViewing();
  const tab = (to, key, label) => `<a href="#/suite/${id}${to}" class="${route.tab === key ? 'on' : ''}">${label}</a>`;
  paint(`
    <div class="back-row">
      <a class="btn small" href="#/">← All tests</a>
      ${me.is_admin ? `<span class="back-actions">
        <button class="btn small" id="open-comment">Comment</button>
        <a class="btn small" href="#/edit/${id}">Edit tests</a>
      </span>` : ''}
    </div>
    <header class="suite-head">
      <p class="eyebrow">Test document</p>
      <h1>${esc(S.suite.title)}</h1>
      <p class="meta">// ${plural(S.tests.length, 'test')} · published ${when(S.suite.created_at)}</p>
      ${S.suite.intro_html ? `<div class="intro">${S.suite.intro_html}</div>` : ''}
    </header>
    <div class="suite-grid">
      <div class="suite-top">
        <section class="card comments" id="comments" hidden>
          <div class="card-head"><span class="eyebrow">Admin comment</span></div>
          <div class="card-body" id="comments-list"></div>
        </section>
        <nav class="tabs">
          ${me.is_admin ? tab('/overview', 'overview', 'Overview') : ''}${tab('', 'tests', 'Tests')}${tab('/problems', 'problems', 'Problems')}${me.is_admin ? '' : tab('/overview', 'overview', 'Overview')}
        </nav>
        <div class="toolbar" id="toolbar"></div>
      </div>
      <section id="sheet"></section>
    </div>`, 'wide');
  renderComments();
  renderToolbar();
  renderSheet();
}

async function reloadSuite(withSheet) {
  if (route.name !== 'suite') return;
  S = await api(`/api/suites/${route.id}`);
  pickViewing();
  renderComments();
  renderToolbar();
  if (withSheet) renderSheet();
  else renderDrawer(); // no inputs in it, so its pills can follow every save
}

// The admin's comment, as testers see it. The admin writes it in #comment-pad instead.
function renderComments() {
  const box = $('#comments');
  if (!box) return;
  box.hidden = me.is_admin || !S.comment;
  if (box.hidden) return;
  $('#comments-list').innerHTML = `<div class="comment" data-fold="comment">
    <p class="pre fit">${esc(S.comment.text)}</p>
    ${MORE}
    <p class="meta">admin · ${ago(S.comment.created_at)}</p>
  </div>`;
  $('#comments-list').querySelectorAll('.fit').forEach(fit);
}

const STATUS_LABEL = { PASS: 'PASS', FAIL: 'FAIL', na: 'N/A' };
const pill = status => `<span class="pill ${(status ?? 'na').toLowerCase()}">${STATUS_LABEL[status ?? 'na']}</span>`;

// The "Viewing" picker above the sheet, plus the filter chips in the drawer.
// The Overview tab has its own page, so the toolbar steps aside there.
function renderToolbar() {
  const bar = $('#toolbar');
  if (!bar) return;
  bar.hidden = route.tab === 'overview';
  if (!bar.hidden) {
    bar.innerHTML = `
      <label class="viewing">Viewing <select id="viewing" ${S.testers.length ? '' : 'disabled'}>${S.testers.length
        ? S.testers.map(u => `<option value="${u.id}" ${u.id === viewing ? 'selected' : ''}>${esc(u.username)}${u.id === me.id ? ' (you)' : ''}</option>`).join('')
        : '<option>No testers yet</option>'}</select></label>`;
  }
  renderChips();
}

// The Overview tab: a summary card per tester (what reads on a phone) over the full matrix (what
// reads on a desktop). Both are drawn from the same counts. The admin pages through 5 testers at a time.
const OVERVIEW_PER_PAGE = 5;
function overviewHtml() {
  if (!S.testers.length) return '<p class="note">The status overview fills in once testers register.</p>';
  const per = me.is_admin ? OVERVIEW_PER_PAGE : S.testers.length;
  const pages = Math.ceil(S.testers.length / per);
  opage = Math.min(Math.max(1, opage), pages);
  const testers = S.testers.slice((opage - 1) * per, opage * per);
  const row = (label, cell) => `<tr><th scope="row">${label}</th>${testers.map(u => `<td>${cell(u)}</td>`).join('')}</tr>`;
  return `
    ${me.is_admin ? '<div class="overview-bar"><button class="btn small" id="pdfs">Download PDFs</button></div>' : ''}
    <div class="overview-cards">${testers.map(u => `
      <article class="card tester-card">
        <div class="card-head">
          <span class="who">
            <span class="avatar">${esc(u.username[0].toUpperCase())}</span>
            <span class="name">${esc(u.username)}${u.id === me.id ? ' (you)' : ''}</span>
          </span>
          <span class="tag">${statusCount(u.id, 'PASS') + statusCount(u.id, 'FAIL')}/${S.tests.length} tested</span>
        </div>
        <div class="card-body">
          <div class="counts">
            <span class="stat pass"><b>${statusCount(u.id, 'PASS')}</b> pass</span>
            <span class="stat fail"><b>${statusCount(u.id, 'FAIL')}</b> fail</span>
            <span class="stat"><b>${statusCount(u.id, 'na')}</b> n/a</span>
            <span class="stat"><b>${problemsOf(u.id).filter(p => p.n).length}</b> problems</span>
          </div>
          <button class="btn small" data-view="${u.id}">Open sheet</button>
        </div>
      </article>`).join('')}</div>
    <div class="card matrix-card">
      <div class="card-head"><span>Every test</span><span class="tag">${plural(S.testers.length, 'tester')}</span></div>
      <div class="matrix-wrap"><table class="matrix">
        <thead><tr><th scope="col">Test</th>${testers.map(u => `<th scope="col">
          <button data-view="${u.id}" class="${u.id === viewing ? 'on' : ''}" title="Show ${esc(u.username)}'s sheet">${esc(u.username)}</button>
        </th>`).join('')}</tr></thead>
        <tbody>${S.tests.map(t => row(`<button data-jump="${t.id}" title="${esc(t.title)}">${t.num}</button>`, u => pill(answerOf(t.id, u.id).status))).join('')}</tbody>
        <tfoot>
          ${row('Pass', u => statusCount(u.id, 'PASS'))}
          ${row('Fail', u => statusCount(u.id, 'FAIL'))}
          ${row('N/A', u => statusCount(u.id, 'na'))}
          ${row('Problems', u => problemsOf(u.id).filter(p => p.n).length)}
        </tfoot>
      </table></div>
    </div>
    ${pager(pages, opage, 'opage')}`;
}

const FILTERS = [['all', 'All'], ['na', 'N/A'], ['PASS', 'Pass'], ['FAIL', 'Fail']];
function renderChips() {
  const el = $('#chips');
  if (!el) return;
  el.hidden = route.tab !== 'tests' || viewing == null;
  if (el.hidden) return;
  el.innerHTML = FILTERS.map(([f, label]) => `<button class="chip ${filter === f ? 'on' : ''}" data-filter="${f}" aria-pressed="${filter === f}">
    ${label} <span>${f === 'all' ? S.tests.length : statusCount(viewing, f)}</span></button>`).join('');
}

function renderSheet() {
  const sheet = $('#sheet');
  if (!sheet) return;
  if (route.tab === 'overview') {
    sheet.innerHTML = overviewHtml();
    return;
  }
  const open = [...sheet.querySelectorAll('details[open]')].map(d => d.closest('.item').id);
  const mine = viewing === me.id;
  const who = S.testers.find(u => u.id === viewing);
  const note = mine ? '' : `<p class="note">${who
    ? `Read only · ${esc(who.username)}'s ${route.tab === 'tests' ? 'answers' : 'problems'}`
    : 'No testers yet. Answers show up here once testers register.'}</p>`;

  if (route.tab === 'tests') {
    // One test at a time. Back / Next walk the tests the filter chip lets through.
    const tests = shownTests();
    const i = Math.max(0, tests.findIndex(t => t.id === current));
    const t = tests[i];
    if (t && t.id !== current) {
      current = t.id;
      history.replaceState(null, '', `#/suite/${route.id}/t/${current}`);
    }
    const step = (to, label) => (to ? `<button class="btn small" data-go="${to.id}">${label}</button>` : '<span></span>');
    sheet.innerHTML = `<div class="window">${note}${t ? `${testRow(t, mine)}
      <div class="stepper">
        ${step(tests[i - 1], '‹ Back')}
        <span class="meta">${i + 1} / ${tests.length}</span>
        ${step(tests[i + 1], 'Next ›')}
      </div>` : `<div class="empty">No tests marked ${FILTERS.find(([f]) => f === filter)[1]} on this sheet.</div>`}</div>
      <button class="fab" id="fab" aria-label="List of tests" title="List of tests">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"
             aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/></svg>
      </button>`;
  } else {
    const list = problemsOf(viewing);
    sheet.innerHTML = note
      + (list.length ? list.map(p => problemRow(p, mine)).join('')
        : `<div class="empty">${mine ? 'Found a problem that none of the tests cover? Add it here.' : 'No problems reported.'}</div>`)
      + (mine ? '<button class="btn add-problem" id="add-problem">+ Add problem</button>' : '');
  }
  for (const id of open) document.getElementById(id)?.querySelector('details')?.setAttribute('open', '');
  sheet.querySelectorAll('.fit').forEach(fit);
  renderDrawer();
}

const shownTests = () => S.tests.filter(t => filter === 'all' || statusOf(t.id, viewing) === filter);
const pad = n => String(n).padStart(2, '0');

// The drawer's list: every test the filter lets through, with the shown sheet's status on the right.
function renderDrawer() {
  const list = $('#drawer-list');
  if (!S || route.tab !== 'tests') return;
  const tests = shownTests();
  list.innerHTML = tests.length ? tests.map(t => `<li>
    <button class="drawer-row ${t.id === current ? 'on' : ''}" data-go="${t.id}" ${t.id === current ? 'aria-current="true"' : ''}>
      <span class="num">${pad(t.num)}</span><span class="t">${esc(t.title)}</span>${pill(statusOf(t.id, viewing))}
    </button></li>`).join('')
    : `<li class="empty">No tests marked ${FILTERS.find(([f]) => f === filter)[1]}.</li>`;
}

// Picked in the drawer or with Back / Next. Replaces the URL rather than adding history, so the
// browser's Back still leaves the page instead of walking through every test.
async function goTest(id) {
  await flushSaves();
  current = id;
  history.replaceState(null, '', `#/suite/${route.id}/t/${id}`);
  renderSheet();
  const card = $('#sheet .item');
  if (card && card.getBoundingClientRect().top < 0) card.scrollIntoView();
}

function testRow(t, mine) {
  const a = answerOf(t.id, viewing);
  return `<article class="item card" id="t-${t.id}" data-test="${t.id}" data-fold="${viewing}:t${t.id}">
    <div class="item-head card-head">
      <h3 class="item-title">${esc(t.title)}</h3>
      <span class="tag">Test ${pad(t.num)}</span>
    </div>
    <div class="card-body">
      <details class="steps"><summary class="btn small"><span class="show">Show steps</span><span class="hide">Hide steps</span></summary>
        <div class="md">${t.body_html}</div></details>
      ${mine ? `
        <div class="status-row">
          <div class="seg" role="radiogroup" aria-label="Status of test ${t.num}">
            ${[['PASS', 'Pass'], ['FAIL', 'Fail'], ['', 'N/A']].map(([value, label]) => `<label class="${value ? value.toLowerCase() : 'na'}">
              <input type="radio" name="s${t.id}" value="${value}" ${(a.status ?? '') === value ? 'checked' : ''}><span>${label}</span>
            </label>`).join('')}
          </div>
          <span class="save-state" aria-live="polite"></span>
        </div>
        <textarea class="fit" rows="1" placeholder="Add feedback (optional)" aria-label="Feedback for test ${t.num}">${esc(a.feedback)}</textarea>`
      : `<div class="status-row">${pill(a.status)}</div>
        ${a.feedback ? `<p class="pre feedback fit">${esc(a.feedback)}</p>` : ''}`}
      ${MORE}
      ${thumbs(imagesOf('test_id', t.id, viewing), mine)}
    </div>
  </article>`;
}

function problemRow(p, mine) {
  const tag = `<span class="tag ${p.n ? '' : 'draft'}">${p.n ? `Problem ${String(p.n).padStart(2, '0')}` : 'Draft'}</span>`;
  return `<article class="item card problem" id="p-${p.id}" data-problem="${p.id}" data-state="${p.state}" data-fold="p${p.id}">
    <div class="item-head card-head">
      ${mine ? `<input id="pt${p.id}" class="title-input" value="${esc(p.title)}" maxlength="200" placeholder="Problem title" aria-label="Problem title">`
        : `<h3 class="item-title">${esc(p.title)}</h3>`}
      ${tag}
    </div>
    <div class="card-body">
      ${mine ? `<textarea class="fit" rows="1" placeholder="Comments (optional)" aria-label="Comments">${esc(p.comments)}</textarea>`
        : p.comments ? `<p class="pre feedback fit">${esc(p.comments)}</p>` : ''}
      ${MORE}
      ${thumbs(imagesOf('problem_id', p.id, p.user_id), mine)}
      ${mine ? `
        ${p.n ? '' : '<p class="hint">Only you can see drafts. Save to share it with everyone.</p>'}
        <div class="actions">
          <button type="button" class="btn small primary" data-act="saved">Save</button>
          <button type="button" class="btn small" data-act="draft">Draft</button>
          <span class="save-state" aria-live="polite"></span>
          <button type="button" class="btn small warn" data-act="delete">Delete</button>
        </div>` : ''}
    </div>
  </article>`;
}

// Feedback, problem comments and admin comments (posted or being written) grow with their text, blank lines
// too. Past 3 lines they fold to a 3-line preview (.folded in style.css) behind "See more". Each one sits in a
// [data-fold] box whose key remembers that it was opened.
const MORE = '<button type="button" class="more btn small" hidden>See more</button>';
const NOTEPAD = '<button type="button" class="btn small notepad-btn" data-notepad>Open in notepad</button>'; // concern cards
const unfolded = new Set(); // data-fold keys of text that was opened
// A textarea that is exactly as tall as its text. Used on its own by the editor, whose boxes grow
// but never fold.
function grow(el) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
}
function fit(el) {
  const row = el.closest('[data-fold]');
  const open = unfolded.has(row.dataset.fold);
  if (el.tagName === 'TEXTAREA') grow(el);
  el.classList.add('folded'); // capped at 3 lines: anything still overflowing means there's more
  const long = el.scrollHeight > el.clientHeight + 1;
  el.classList.toggle('folded', long && !open);
  const more = $('.more', row);
  more.hidden = !long;
  more.textContent = open ? 'See less' : 'See more';
}
function unfold(row, open) {
  if (open) unfolded.add(row.dataset.fold);
  else unfolded.delete(row.dataset.fold);
  fit($('.fit', row));
}

// Images as small squares. Your own rows get one add control: a button when empty, a tile after the images.
function thumbs(list, mine) {
  if (!list.length && !mine) return '';
  const input = '<input type="file" accept="image/*" multiple class="sr-only">';
  if (!list.length) return `<div class="thumbs"><label class="btn small add">${input}+ Add image</label></div>`;
  return `<div class="thumbs">
    ${list.map(i => `<figure class="thumb">
      <img src="/uploads/${i.file}" alt="Attached image" loading="lazy">
      ${mine ? `<button type="button" class="x" data-del-img="${i.id}" aria-label="Remove image">×</button>` : ''}
    </figure>`).join('')}
    ${mine ? `<label class="thumb add" title="Add image">${input}+ Image</label>` : ''}
  </div>`;
}

// ---------- autosave ----------
const timers = new Map(); // row element -> pending autosave timer
function setSaveState(row, text, cls = '') {
  const el = $('.save-state', row);
  if (el) [el.textContent, el.className] = [text, `save-state ${cls}`];
}
function cancelSave(row) {
  clearTimeout(timers.get(row));
  timers.delete(row);
}
function queueSave(row) {
  cancelSave(row);
  setSaveState(row, '');
  timers.set(row, setTimeout(() => saveRow(row), 600));
}
const flushRow = row => (timers.has(row) ? saveRow(row) : undefined);
const flushSaves = () => Promise.all([...timers.keys()].map(flushRow));

// Saves one row from what's on screen. `state` is only passed by the Save / Draft buttons.
// Saves of the same row run one after another, so a blur-save can't land after a Save click.
const saving = new WeakMap();
function saveRow(row, state) {
  cancelSave(row);
  const done = (saving.get(row) ?? Promise.resolve()).then(() => writeRow(row, state));
  saving.set(row, done);
  return done;
}
async function writeRow(row, state) {
  setSaveState(row, 'Saving…');
  try {
    if (row.dataset.test) {
      await api(`/api/answers/${row.dataset.test}`, send('PUT', {
        status: $('input[type=radio]:checked', row)?.value || null, // N/A is sent as null
        feedback: $('textarea', row).value,
      }));
    } else {
      const explicit = state !== undefined;
      state ??= row.dataset.state;
      const title = $('.title-input', row).value.trim();
      if (state === 'saved' && !title) {
        setSaveState(row, 'Needs a title', 'err');
        if (explicit) $('.title-input', row).focus();
        return false;
      }
      const url = row.dataset.concern ? `/api/concerns/${row.dataset.concern}` : `/api/problems/${row.dataset.problem}`;
      await api(url, send('PUT', { title, comments: $('textarea', row).value, state }));
    }
    setSaveState(row, 'Saved', 'ok');
    await reload(false);
    return true;
  } catch (err) {
    setSaveState(row, err.message, 'err');
    return false;
  }
}

async function upload(row, input) {
  const target = row.dataset.test ? `test=${row.dataset.test}`
    : row.dataset.problem ? `problem=${row.dataset.problem}` : `concern=${row.dataset.concern}`;
  $('.add', row).classList.add('busy');
  for (const file of input.files) {
    try {
      await api(`/api/images?${target}`, { method: 'POST', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
    } catch (err) {
      toast(`${file.name}: ${err.message}`);
    }
  }
  await afterImageChange(row);
}
// Redraw only this row's images so nothing being typed elsewhere gets touched.
async function afterImageChange(row) {
  await reload(false);
  const list = row.dataset.concern ? concernImages(Number(row.dataset.concern))
    : row.dataset.test ? imagesOf('test_id', Number(row.dataset.test), viewing) : imagesOf('problem_id', Number(row.dataset.problem), viewing);
  $('.thumbs', row).outerHTML = thumbs(list, true);
}

// ---------- page events ----------
// Answer sheets and concern cards autosave; the test editor has an explicit Save, so it is left out.
const EDITABLE = '.item:not(.block) textarea, .item:not(.block) .title-input';
main.addEventListener('input', e => {
  if (e.target.id === 'suite-search') {
    search = e.target.value;
    page = 1;
    return renderGallery();
  }
  if (e.target.matches('textarea.auto')) return grow(e.target);
  if (e.target.matches('.fit')) unfold(e.target.closest('[data-fold]'), true); // never fold what you're typing
  if (e.target.matches(EDITABLE)) queueSave(e.target.closest('.item'));
});
// Editing always shows the whole text. It doesn't fold back on blur, so nothing jumps under your next click.
main.addEventListener('focusin', e => {
  if (e.target.matches('textarea.folded')) unfold(e.target.closest('[data-fold]'), true);
});
addEventListener('resize', () => { // text rewraps
  main.querySelectorAll('.fit').forEach(fit);
  main.querySelectorAll('textarea.auto').forEach(grow);
});
main.addEventListener('focusout', e => {
  if (e.target.matches(EDITABLE)) flushRow(e.target.closest('.item'));
});
main.addEventListener('change', safe(async e => {
  const t = e.target;
  if (t.id === 'viewing') return showSheetOf(Number(t.value));
  if (t.id === 'concern-who') {
    viewing = t.value ? Number(t.value) : null;
    return renderConcerns();
  }
  if ('status' in t.dataset) return setStatus(t.closest('.item').dataset.concern, t.value);
  if ('rstatus' in t.dataset) {
    const r = R.find(x => x.id === Number(t.dataset.rstatus));
    await api(`/api/releases/${r.id}`, send('PUT', { ...releaseBody(r), status: t.value }));
    return showDownloads();
  }
  if (t.type === 'radio') return saveRow(t.closest('.item'));
  if (t.type === 'file') return upload(t.closest('.item'), t);
}));

async function showSheetOf(userId) {
  await flushSaves();
  viewing = userId;
  if (route.tab === 'overview') { // picked from the overview: show that sheet on the Tests tab
    location.hash = `#/suite/${route.id}`;
    return;
  }
  renderToolbar();
  renderSheet();
}

main.addEventListener('click', safe(async e => {
  const t = e.target;
  let el;
  if ((el = t.closest('[data-page]'))) {
    page = Number(el.dataset.page);
    renderGallery();
    return scrollTo({ top: 0, behavior: 'smooth' });
  }
  if ((el = t.closest('[data-opage]'))) {
    opage = Number(el.dataset.opage);
    return renderSheet();
  }
  if ((el = t.closest('[data-go]'))) return goTest(Number(el.dataset.go));
  if (t.closest('#fab')) {
    renderChips();
    renderDrawer();
    $('#drawer').showModal();
    return $('#drawer .on')?.scrollIntoView({ block: 'center' });
  }
  if (t.closest('#pdfs')) return openPdfPick();
  if (t.closest('#open-comment')) return openCommentPad();
  if (t.closest('#new-release')) return openRelease({});
  if ((el = t.closest('[data-new-version]'))) return openRelease({ name: el.dataset.newVersion }, 'rel-version');
  if ((el = t.closest('[data-edit-release]'))) return openRelease(R.find(r => r.id === Number(el.dataset.editRelease)));
  if ((el = t.closest('[data-release-link]'))) return openRelease(R.find(r => r.id === Number(el.dataset.releaseLink)), 'rel-url');
  if ((el = t.closest('[data-del-release]'))) {
    const r = R.find(x => x.id === Number(el.dataset.delRelease));
    if (!(await ask(`Delete ${r.name} ${r.version}?`, 'Testers can no longer download it, and its bell alerts go with it. This cannot be undone.'))) return;
    await api(`/api/releases/${r.id}`, { method: 'DELETE' });
    return showDownloads();
  }
  if ((el = t.closest('[data-publish]'))) return saveDoc(el.dataset.publish === '1');
  if (t.closest('#open-paste')) return openPaste();
  if (t.closest('#add-block')) {
    readEditor();
    const added = blankTest();
    doc.tests.push(added);
    renderBlocks();
    return $(`[data-block="${added.key}"] .title-input`).focus();
  }
  if ((el = t.closest('[data-del-block]'))) {
    readEditor();
    const block = doc.tests.find(x => x.key === Number(el.dataset.delBlock));
    const name = block.title.trim() ? `"${block.title.trim()}"` : 'this test';
    if (block.id != null && !(await ask(`Delete ${name}?`,
      'When you save, every tester loses their answer, feedback and images for this test. This cannot be undone.'))) return;
    doc.tests = doc.tests.filter(x => x !== block);
    return renderBlocks();
  }
  if ((el = t.closest('[data-toggle-block]'))) {
    const block = doc.tests.find(x => x.key === Number(el.dataset.toggleBlock));
    block.open = !block.open;
    const card = el.closest('[data-block]');
    card.classList.toggle('closed', !block.open);
    el.textContent = block.open ? 'Hide' : 'Show';
    el.setAttribute('aria-expanded', block.open);
    // sized while hidden, they measured 0
    if (block.open) card.querySelectorAll('textarea.auto').forEach(grow);
    return;
  }
  if ((el = t.closest('.more'))) {
    const open = el.textContent === 'See more';
    const row = el.closest('[data-fold]');
    unfold(row, open);
    if (!open) row.scrollIntoView({ block: 'nearest' });
    return;
  }
  if ((el = t.closest('[data-show-pass]'))) {
    const id = Number(el.dataset.showPass);
    if (!shownPasswords.delete(id)) shownPasswords.add(id);
    return renderUsers();
  }
  if ((el = t.closest('[data-del-user]'))) {
    const name = users.find(u => u.id === Number(el.dataset.delUser))?.username;
    if (!(await ask(`Delete ${name}?`, 'Their account goes, along with all their answers, problems, concerns and images. This cannot be undone.'))) return;
    await api(`/api/users/${el.dataset.delUser}`, { method: 'DELETE' });
    return showUsers();
  }
  if ((el = t.closest('[data-del-suite]'))) {
    const title = home.suites.find(s => s.id === Number(el.dataset.delSuite))?.title ?? 'these tests';
    if (!(await ask(`Delete ${title}?`, 'Every test in it goes, along with every answer, problem and image. This cannot be undone.'))) return;
    await api(`/api/suites/${el.dataset.delSuite}`, { method: 'DELETE' });
    return showHome();
  }
  if ((el = t.closest('[data-view]'))) return showSheetOf(Number(el.dataset.view));
  if ((el = t.closest('[data-jump]'))) {
    filter = 'all'; // the test might be hidden by a filter
    location.hash = `#/suite/${route.id}/t/${el.dataset.jump}`;
    return;
  }
  if (t.matches('.thumb img')) {
    $('#lightbox img').src = t.src;
    return $('#lightbox').showModal();
  }
  if ((el = t.closest('[data-del-img]'))) {
    const row = el.closest('.item');
    await api(`/api/images/${el.dataset.delImg}`, { method: 'DELETE' });
    return afterImageChange(row);
  }
  if (t.closest('#add-concern')) {
    await flushSaves();
    const { id } = await api('/api/concerns', { method: 'POST' });
    await reloadConcerns(true);
    return document.getElementById(`ct${id}`)?.focus();
  }
  if ((el = t.closest('[data-cfilter]'))) {
    filter = el.dataset.cfilter;
    return renderConcerns();
  }
  if ((el = t.closest('[data-notepad]'))) return openNotepad(el.closest('[data-concern]'));
  if ((el = t.closest('[data-hide-concern]'))) {
    const c = C.concerns.find(x => x.id === Number(el.dataset.hideConcern));
    await api(`/api/concerns/${c.id}/hidden`, send('PATCH', { hidden: !c.hidden }));
    return reloadConcerns(true);
  }
  if ((el = t.closest('[data-del-concern]'))) {
    const c = C.concerns.find(x => x.id === Number(el.dataset.delConcern));
    const who = C.testers.find(u => u.id === c.user_id)?.username ?? 'the tester';
    if (!(await ask(`Delete "${c.title}"?`,
      `This deletes ${who}'s concern for everyone, ${who} included, together with its images. This cannot be undone.`))) return;
    await api(`/api/concerns/${c.id}`, { method: 'DELETE' });
    toast('Concern deleted');
    return reloadConcerns(true);
  }
  if (t.closest('#add-problem')) {
    await flushSaves();
    const { id } = await api(`/api/suites/${route.id}/problems`, { method: 'POST' });
    await reloadSuite(true);
    return document.getElementById(`pt${id}`)?.focus();
  }
  if ((el = t.closest('[data-act]'))) {
    const row = el.closest('.item');
    if (el.dataset.act === 'delete') {
      if (!(await ask(`Delete this ${row.dataset.concern ? 'concern' : 'problem'}?`, 'It goes with its images. This cannot be undone.'))) return;
      cancelSave(row);
      await api(row.dataset.concern ? `/api/concerns/${row.dataset.concern}` : `/api/problems/${row.dataset.problem}`, { method: 'DELETE' });
    } else if (!(await saveRow(row, el.dataset.act))) return;
    await flushSaves();
    return reload(true);
  }
}));

// ---------- PDF (browser print → Save as PDF) ----------
// The admin picks testers on the Overview; their reports go into one print, each on a new page.
function openPdfPick() {
  $('#pdf-list').innerHTML = S.testers.map(u => `<label class="check"><input type="checkbox" value="${u.id}" checked> ${esc(u.username)}</label>`).join('');
  $('#pdf-go').disabled = false;
  $('#pdf-pick').showModal();
}
const pickedIds = () => [...$('#pdf-list').querySelectorAll('input:checked')].map(i => Number(i.value));
$('#pdf-pick').addEventListener('change', () => ($('#pdf-go').disabled = !pickedIds().length));
$('#pdf-pick').addEventListener('click', e => {
  const all = e.target.closest('#pdf-all');
  if (!all && !e.target.closest('#pdf-none')) return;
  $('#pdf-list').querySelectorAll('input').forEach(i => (i.checked = Boolean(all)));
  $('#pdf-go').disabled = !all;
});
$('#pdf-go').addEventListener('click', safe(async () => {
  const ids = pickedIds();
  $('#pdf-pick').close();
  await printReports(ids);
}));

function reportHtml(who) {
  const id = who.id;
  const problems = problemsOf(id).filter(p => p.n);
  const images = list => (list.length ? `<div class="p-imgs">${list.map(i => `<img src="/uploads/${i.file}" alt="">`).join('')}</div>` : '');
  return `
    <h1>${esc(S.suite.title)}</h1>
    <p class="p-meta">Tester: ${esc(who.username)} · ${new Date().toLocaleDateString(undefined, { dateStyle: 'medium' })} ·
      ${statusCount(id, 'PASS')} passed, ${statusCount(id, 'FAIL')} failed, ${statusCount(id, 'na')} N/A</p>
    ${S.tests.map(t => {
      const a = answerOf(t.id, id);
      return `<section>
        <h2>Test ${t.num} - Title: ${esc(t.title)}</h2>
        <p><b>Status:</b> ${STATUS_LABEL[a.status ?? 'na']}</p>
        <p class="pre"><b>Feedback:</b> ${esc(a.feedback)}</p>
        ${images(imagesOf('test_id', t.id, id))}
      </section>`;
    }).join('')}
    ${problems.length ? `<h2 class="p-section">Problems</h2>${problems.map(p => `<section>
      <h2>Problem ${p.n} - ${esc(p.title)}</h2>
      <p class="pre"><b>Comments:</b> ${esc(p.comments)}</p>
      ${images(imagesOf('problem_id', p.id, id))}
    </section>`).join('')}` : ''}`;
}

async function printReports(ids) {
  await reloadSuite(false);
  const who = S.testers.filter(u => ids.includes(u.id));
  if (!who.length) return;
  const out = $('#print');
  out.innerHTML = who.map((u, i) => `<div class="${i ? 'p-break' : ''}">${reportHtml(u)}</div>`).join('');
  await Promise.all([...out.querySelectorAll('img')].map(img => img.complete || new Promise(r => (img.onload = img.onerror = r))));
  const title = document.title;
  // becomes the PDF file name
  document.title = who.length === 1 ? `${S.suite.title} - ${who[0].username}` : `${S.suite.title} - ${who.length} testers`;
  addEventListener('afterprint', () => (document.title = title), { once: true });
  print();
}

// ---------- live updates ----------
const onEvent = safe(async ev => {
  if (ev.type === 'deleted') return location.replace('/?deleted'); // this account was deleted (by you or the admin)
  if (ev.type === 'notify') return loadNotifications();
  if (route.name === 'users') return ev.type === 'suite' || ev.type === 'concerns' || showUsers(); // presence, sign-ups, renames, deletions
  if (ev.type === 'presence' || ev.tab === TAB) return; // presence only matters on Users; own changes are on screen
  if (route.name === 'editor') return; // the form is yours until you save it
  if (route.name === 'downloads') return ev.type === 'releases' || ev.type === 'suites' ? showDownloads() : undefined;
  if (ev.type === 'releases') return;
  // Concerns listen to their own event, plus sign-ups, renames and deletions of testers.
  if (route.name === 'concerns') return ev.type === 'concerns' || ev.type === 'suites' ? reloadConcerns(false) : undefined;
  if (ev.type === 'concerns') return;
  if (route.name === 'home') return showHome();
  if (ev.type === 'suites' && ev.suiteId === route.id) return showSuite(); // this suite was deleted
  if (ev.type === 'suite' && ev.suiteId !== route.id) return;
  // Never redraw your own sheet because of someone else's change: you might be typing in it.
  await reloadSuite(viewing !== me.id || ev.userId === me.id);
});

function listen() {
  const events = new EventSource('/api/events');
  let connected = false;
  events.onopen = () => {
    if (connected) onEvent({ type: 'suites' }); // reconnected: catch up on anything missed
    connected = true;
  };
  events.onmessage = e => onEvent(JSON.parse(e.data));
  // A page kept in the back/forward cache must not keep its stream, or its user would still look online.
  addEventListener('pagehide', () => events.close(), { once: true });
}
addEventListener('pageshow', e => {
  if (!e.persisted) return;
  listen();
  onEvent({ type: 'suites' });
});

// ---------- notifications (testers) ----------
async function loadNotifications() {
  if (me.is_admin) return [];
  const list = await api('/api/notifications');
  const badge = $('#bell .badge');
  badge.textContent = list.length > 9 ? '9+' : list.length;
  badge.hidden = !list.length;
  $('#bell').setAttribute('aria-label', `Notifications (${list.length})`);
  $('#bell-panel').innerHTML = `
    <div class="panel-head"><b>Notifications</b>${list.length ? `<span class="muted">· ${list.length}</span>
      <button class="btn small" data-clear-notes>Clear all</button>` : ''}</div>
    <div class="panel-list">${list.length ? list.map(n => `<div class="note-item">
      <a href="${n.suite_id ? `#/suite/${n.suite_id}` : n.release_id ? '#/downloads' : '#/'}" data-open-note="${n.id}">${esc(n.text)}<small>${ago(n.created_at)}</small></a>
      <button class="x" data-del-note="${n.id}" aria-label="Delete notification">×</button>
    </div>`).join('') : '<p class="empty">You\'re all caught up.</p>'}</div>`;
  return list;
}

$('#bell').addEventListener('click', () => {
  const panel = $('#bell-panel');
  panel.hidden = !panel.hidden;
  $('#bell').setAttribute('aria-expanded', !panel.hidden);
});
$('#bell-panel').addEventListener('click', safe(async e => {
  const del = e.target.closest('[data-del-note]');
  const open = e.target.closest('[data-open-note]');
  if (del) await api(`/api/notifications/${del.dataset.delNote}`, { method: 'DELETE' });
  else if (e.target.closest('[data-clear-notes]')) await api('/api/notifications', { method: 'DELETE' });
  else if (open) {
    // Opening an alert also dismisses it, so a long backlog shrinks as you work through it.
    $('#bell-panel').hidden = true;
    await api(`/api/notifications/${open.dataset.openNote}`, { method: 'DELETE' });
  } else return;
  await loadNotifications();
}));
document.addEventListener('click', e => {
  if (!e.target.closest('.bell-wrap')) $('#bell-panel').hidden = true;
  e.target.closest('[data-close]')?.closest('dialog').close();
});

// ---------- the Tests tab's drawer ----------
$('#drawer').addEventListener('click', safe(async e => {
  const drawer = $('#drawer');
  if (e.target === drawer) return drawer.close(); // the backdrop
  let el;
  if ((el = e.target.closest('[data-go]'))) {
    drawer.close();
    return goTest(Number(el.dataset.go));
  }
  if ((el = e.target.closest('[data-filter]'))) {
    await flushSaves();
    filter = el.dataset.filter;
    renderChips();
    renderSheet();
  }
}));

// ---------- admin comment: a notepad with Save / Draft and no autosave ----------
let commentSaved = ''; // the text as last saved, to spot unsaved edits on close
function openCommentPad() {
  commentSaved = S.comment?.text ?? '';
  $('#comment-text').value = commentSaved;
  $('#comment-state').textContent = !S.comment ? 'No comment yet. Save shows it to every tester and rings their bell.'
    : S.comment.state === 'saved' ? `Published ${ago(S.comment.created_at)}. Testers see it above the tabs.`
      : `Draft, saved ${ago(S.comment.created_at)}. Only you can see it.`;
  $('#comment-pad').showModal();
  $('#comment-text').focus();
}
async function closeCommentPad() {
  if ($('#comment-text').value.trim() !== commentSaved.trim()
    && !(await ask('Discard changes?', 'Your edits to the comment are not saved.', 'Discard'))) return;
  $('#comment-pad').close();
}
const saveComment = state => safe(async () => {
  const text = $('#comment-text').value;
  await api(`/api/suites/${route.id}/comment`, send('PUT', { text, state }));
  commentSaved = text;
  $('#comment-pad').close();
  toast(!text.trim() ? 'Comment removed' : state === 'saved'
    ? (S.suite.published ? 'Comment published. Testers were alerted.' : 'Comment saved. Testers see it once the tests are published.')
    : 'Draft saved. Only you can see it.');
  await reloadSuite(false);
});
$('#comment-save').addEventListener('click', saveComment('saved'));
$('#comment-draft').addEventListener('click', saveComment('draft'));
$('#comment-x').addEventListener('click', closeCommentPad);
$('#comment-pad').addEventListener('cancel', e => { // Esc
  e.preventDefault();
  closeCommentPad();
});

// ---------- profile ----------
function paintUser() {
  const initial = me.username[0].toUpperCase();
  $('#avatar').textContent = initial;
  $('#profile-avatar').textContent = initial;
  $('#profile-name').textContent = me.username;
  $('#role').textContent = me.is_admin ? 'Admin account' : 'Tester account';
}
$('#avatar').addEventListener('click', () => {
  $('#profile-main').hidden = false;
  $('#profile-delete').hidden = true;
  $('#new-name').value = me.username;
  $('#profile-error').textContent = '';
  $('#my-password').value = me.password ?? '';
  $('#my-password').type = 'password';
  $('#toggle-password').textContent = 'Show';
  $('#toggle-password').disabled = !me.password;
  $('#password-hint').hidden = Boolean(me.password);
  $('#delete-account').hidden = Boolean(me.is_admin);
  $('#profile').showModal();
});
$('#toggle-password').addEventListener('click', () => {
  const input = $('#my-password');
  input.type = input.type === 'password' ? 'text' : 'password';
  $('#toggle-password').textContent = input.type === 'password' ? 'Show' : 'Hide';
});
$('#profile-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const username = $('#new-name').value.trim();
    await api('/api/me', send('PATCH', { username }));
    me.username = username;
    paintUser();
    toast('Username updated');
    onEvent({ type: 'suites' });
  } catch (err) {
    $('#profile-error').textContent = err.message;
  }
});
$('#signout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  location.replace('/');
});
$('#delete-account').addEventListener('click', () => {
  $('#profile-main').hidden = true;
  $('#profile-delete').hidden = false;
  $('#delete-error').textContent = '';
});
$('#cancel-delete').addEventListener('click', () => {
  $('#profile-main').hidden = false;
  $('#profile-delete').hidden = true;
});
$('#confirm-delete').addEventListener('click', async () => {
  try {
    await api('/api/me', { method: 'DELETE' });
    location.replace('/?deleted');
  } catch (err) {
    $('#delete-error').textContent = err.message;
  }
});

// ---------- confirmation modal ----------
// Resolves true only on the red button; Cancel, × and Esc all resolve false.
function ask(title, body, yes = 'Delete') {
  const dialog = $('#confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-body').textContent = body;
  $('#confirm-yes').textContent = yes;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'yes'), { once: true }));
}
$('#confirm-yes').addEventListener('click', () => $('#confirm').close('yes'));

// ---------- notepad: a roomy view of one concern's Comments ----------
// Testers type here and it mirrors into the card, which autosaves as usual; the admin reads it, line breaks kept.
let notepadRow = null;
function openNotepad(row) {
  const c = C.concerns.find(x => x.id === Number(row.dataset.concern));
  notepadRow = me.is_admin ? null : row;
  $('#notepad-title').textContent = (me.is_admin ? c.title : $('.title-input', row).value.trim()) || 'Untitled concern';
  $('#notepad-text').hidden = me.is_admin;
  $('#notepad-read').hidden = !me.is_admin;
  if (me.is_admin) $('#notepad-read').textContent = c.comments;
  else $('#notepad-text').value = $('textarea', row).value;
  $('#notepad').showModal();
}
$('#notepad-text').addEventListener('input', e => {
  const box = $('textarea', notepadRow);
  box.value = e.target.value;
  box.dispatchEvent(new Event('input', { bubbles: true })); // the card's own handler grows it and queues the save
});
$('#notepad').addEventListener('close', () => notepadRow?.isConnected && flushRow(notepadRow));

// ---------- test editor (admin): #/new and #/edit/:id ----------
// Same four headings as SECTIONS in md.js, which checks that they round-trip.
const SECTIONS = ['What will be tested?', 'What do you need before starting?', 'Steps', "What's the expected output?"];
const HINTS = [
  'That tapping Resources shows or hides its three screens.',
  '- Signed in, inside a system, on a phone.',
  '1. Open the side menu.\n2. Tap Resources.',
  '- The three entries appear under Resources.',
];
let doc = null;  // { title, intro, tests: [{ key, id?, title, sections, extra, legacy_html, open }] }
let keySeq = 0;  // gives every block a key that survives reordering and deletes
// Written tests start folded to their title; a blank one starts open, ready to type in.
const withKeys = tests => tests.map(t => ({ sections: {}, extra: '', legacy_html: null, open: false, ...t, key: ++keySeq }));
const blankTest = () => withKeys([{ title: '', open: true }])[0];

async function showEditor() {
  const id = route.id;
  let src = { title: '', intro: '', tests: [] };
  if (id != null) {
    try {
      src = await api(`/api/suites/${id}/source`);
    } catch (err) {
      return paint(`<div class="empty">${esc(err.message)}<br><br><a class="btn small" href="#/">← All tests</a></div>`);
    }
  }
  if (route.name !== 'editor' || route.id !== id) return;
  doc = { title: src.title, intro: src.intro, tests: withKeys(src.tests), published: Boolean(src.published) };
  if (!doc.tests.length) doc.tests.push(blankTest());
  $('#md-text').value = '';
  updateCount();
  paint(`
    <a class="btn small back" href="#/">← All tests</a>
    <p class="eyebrow">${id != null ? 'Edit tests' : 'New tests'}</p>
    <div class="page-head">
      <h1>${id != null ? esc(src.title) : 'Write a test document'}</h1>
      ${id != null ? `<span class="tag ${doc.published ? 'boxed' : 'draft'}">${doc.published ? 'Published' : 'Unpublished'}</span>` : ''}
    </div>
    <p class="meta">// ${id != null ? 'answers stay with every test you keep' : 'fill in the boxes, or paste a .md file'}</p>

    <section class="card editor-doc">
      <div class="card-head"><span class="eyebrow">Document</span><span class="tag" id="block-count"></span></div>
      <div class="card-body">
        <label class="label" for="doc-title">Title</label>
        <input id="doc-title" maxlength="200" placeholder="Resources" value="${esc(doc.title)}">
        <label class="label" for="doc-intro">Intro <span class="muted">(optional)</span></label>
        <textarea id="doc-intro" class="auto" rows="2" placeholder="What this document covers">${esc(doc.intro)}</textarea>
        ${src.legacy_intro_html ? `<p class="note">Published before the editor existed. Leave the intro empty to keep this one, or write a new one.</p>
          <div class="md">${src.legacy_intro_html}</div>` : ''}
      </div>
    </section>

    <div id="blocks"></div>
    <div class="editor-tools">
      <button type="button" class="btn" id="add-block">+ Add test</button>
      <button type="button" class="btn" id="open-paste">Paste a .md file…</button>
    </div>

    <div class="editor-bar">
      <label class="check" ${doc.published ? 'hidden' : ''}><input type="checkbox" id="md-notify" checked> Notify testers when published</label>
      <p class="error" id="editor-error" role="alert"></p>
      <div class="actions">
        <button type="button" class="btn primary" data-publish="1">Publish</button>
        <button type="button" class="btn" data-publish="0">Unpublish</button>
        <a class="btn" href="#/">Cancel</a>
      </div>
    </div>`);
  grow($('#doc-intro'));
  renderBlocks();
}

function renderBlocks() {
  const box = $('#blocks');
  if (!box) return;
  box.innerHTML = doc.tests.map((t, i) => {
    const untouched = t.legacy_html != null && !SECTIONS.some(h => t.sections[h]);
    return `<article class="item card block ${t.open ? '' : 'closed'}" data-block="${t.key}">
      <div class="item-head card-head">
        <input class="title-input" value="${esc(t.title)}" maxlength="200" placeholder="Test title" aria-label="Title of test ${i + 1}">
        <span class="tag">Test ${String(i + 1).padStart(2, '0')}</span>
        <button type="button" class="btn small" data-toggle-block="${t.key}" aria-expanded="${t.open}">${t.open ? 'Hide' : 'Show'}</button>
      </div>
      <div class="card-body">
        ${untouched ? `<p class="note">Published before the editor existed. Leave the boxes empty to keep these steps, or fill them in to replace them.</p>
          <details class="steps"><summary class="btn small"><span class="show">Show published steps</span><span class="hide">Hide published steps</span></summary>
            <div class="md">${t.legacy_html}</div></details>` : ''}
        ${SECTIONS.map((h, s) => `
          <label class="label" for="b${t.key}s${s}">${esc(h)}</label>
          <textarea class="auto" id="b${t.key}s${s}" data-sec="${s}" rows="2" placeholder="${esc(HINTS[s])}">${esc(t.sections[h] ?? '')}</textarea>`).join('')}
        ${t.extra ? '<p class="hint">This test has extra headings of its own. They are kept as they are.</p>' : ''}
        <div class="actions"><button type="button" class="btn small warn" data-del-block="${t.key}">Delete this test</button></div>
      </div>
    </article>`;
  }).join('');
  $('#block-count').textContent = plural(doc.tests.length, 'test');
  box.querySelectorAll('textarea.auto').forEach(grow);
}

// Pulls what is on screen back into `doc`, in on-screen order.
function readEditor() {
  doc.title = $('#doc-title').value;
  doc.intro = $('#doc-intro').value;
  doc.tests = [...main.querySelectorAll('[data-block]')].map(b => ({
    ...doc.tests.find(t => t.key === Number(b.dataset.block)),
    title: $('.title-input', b).value,
    sections: Object.fromEntries(SECTIONS.map((h, s) => [h, $(`[data-sec="${s}"]`, b).value])),
  }));
}

// Publish and Unpublish both save; they differ only in whether testers can open the document.
async function saveDoc(published) {
  readEditor();
  if (!published && doc.published && !(await ask('Unpublish these tests?',
    'Testers can no longer open them, and their bell alerts go. Their answers are kept for when you publish again.', 'Unpublish'))) return;
  const buttons = main.querySelectorAll('[data-publish]');
  $('#editor-error').textContent = '';
  buttons.forEach(b => (b.disabled = true));
  try {
    const body = {
      title: doc.title,
      intro: doc.intro,
      tests: doc.tests.map(({ id, title, sections, extra }) => ({ id, title, sections, extra })),
      published,
      notify: !doc.published && $('#md-notify').checked, // an already published document never re-alerts
    };
    if (route.id != null) await api(`/api/suites/${route.id}`, send('PUT', body));
    else await api('/api/suites', send('POST', body));
    toast(published ? `${doc.title.trim()} is published` : `${doc.title.trim()} is saved, unpublished. Only you can see it.`);
    location.hash = '#/';
  } catch (err) {
    $('#editor-error').textContent = err.message;
  } finally {
    buttons.forEach(b => (b.disabled = false));
  }
}

const countTests = text => (text.match(/^## Test \d+\s*[-–—]\s*Title:/gm) || []).length;
function updateCount() {
  const n = countTests($('#md-text').value);
  $('#md-count').textContent = `${plural(n, 'test')} found`;
  $('#md-load').disabled = !n;
  $('#md-append').disabled = !n;
}
// A new document is filled from the file. An existing one can take the file's tests at the end
// (its title, intro and answered tests stay) or be replaced by it.
function openPaste() {
  const editing = route.id != null;
  $('#md-help').innerHTML = `Each test starts with a line like <code>## Test 1 - Title: …</code>. ${editing
    ? '<b>Add to the end</b> keeps every test you have and adds the file\'s tests after them. <b>Replace all</b> swaps the whole form for the file.'
    : 'Loading it fills the form, where you can check it before publishing.'}`;
  $('#md-append').hidden = !editing;
  $('#md-load').textContent = editing ? 'Replace all' : 'Load into the form';
  $('#paste-md').showModal();
}
$('#paste-md').addEventListener('input', e => e.target.id === 'md-text' && updateCount());
$('#md-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  $('#md-text').value = await file.text();
  e.target.value = '';
  updateCount();
});
$('#md-load').addEventListener('click', safe(() => loadMd(false)));
$('#md-append').addEventListener('click', safe(() => loadMd(true)));

async function loadMd(append) {
  readEditor();
  const written = doc.title.trim() || doc.tests.some(t => t.title.trim() || SECTIONS.some(h => t.sections[h].trim()));
  if (!append && written && !(await ask('Replace the form with this file?',
    route.id != null
      ? 'Every test in the form is replaced by the ones in the file. When you publish, tests that are no longer there lose their answers, feedback and images.'
      : 'The title, intro and every test you have written are replaced by the ones in the file.', 'Replace'))) return;
  const src = await api('/api/suites/parse', send('POST', { markdown: $('#md-text').value }));
  $('#paste-md').close();
  if (append) {
    const added = withKeys(src.tests); // no ids, so they are saved as new tests
    doc.tests.push(...added);
    renderBlocks();
    $(`[data-block="${added[0].key}"]`).scrollIntoView({ behavior: 'smooth' });
    toast(`${plural(added.length, 'test')} added. Check them, then publish.`);
    return;
  }
  doc = { ...doc, title: src.title, intro: src.intro, tests: withKeys(src.tests) };
  $('#doc-title').value = doc.title;
  $('#doc-intro').value = doc.intro;
  grow($('#doc-intro'));
  renderBlocks();
  toast(`${plural(doc.tests.length, 'test')} loaded. Check them, then publish.`);
}

$('#lightbox').addEventListener('click', () => $('#lightbox').close());

// ---------- start ----------
(async () => {
  try {
    me = await api('/api/me');
  } catch {
    return;
  }
  paintUser();
  $('.bell-wrap').hidden = Boolean(me.is_admin);
  $('#nav-users').hidden = !me.is_admin;
  addEventListener('hashchange', router);
  listen();
  router();
  const notes = (await safe(loadNotifications)()) ?? [];
  let justSignedIn = false;
  try {
    justSignedIn = sessionStorage.getItem('justSignedIn') === '1';
    sessionStorage.removeItem('justSignedIn');
  } catch {}
  // One heads-up per sign-in when a backlog is waiting (e.g. a tester who just joined).
  if (justSignedIn && notes.length >= 3) toast(`${plural(notes.length, 'test document')} waiting for you. Open the bell to see them.`, 6000);
})();
