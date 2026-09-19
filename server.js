// Tester Manager server: Express + built-in node:sqlite, live updates over Server-Sent Events.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const { parseSuite, renderMd, cleanTitle, SECTIONS, splitBody, buildSuiteMd } = require('./md');

const PORT = Number(process.env.PORT) || 3000;
const CREDS = path.join(__dirname, 'admin-credentials.txt');
const UPLOADS = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

// ---------- database ----------
const db = new DatabaseSync(path.join(__dirname, 'data.db'));
// An image belongs to exactly one test answer, problem or concern.
const IMAGE_COLUMNS = `
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users ON DELETE CASCADE,
    test_id INTEGER REFERENCES tests ON DELETE CASCADE,
    problem_id INTEGER REFERENCES problems ON DELETE CASCADE,
    concern_id INTEGER REFERENCES concerns ON DELETE CASCADE,
    file TEXT NOT NULL,
    CHECK ((test_id IS NOT NULL) + (problem_id IS NOT NULL) + (concern_id IS NOT NULL) = 1)`;
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pass_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS suites (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    intro_html TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS tests (
    id INTEGER PRIMARY KEY,
    suite_id INTEGER NOT NULL REFERENCES suites ON DELETE CASCADE,
    num INTEGER NOT NULL,
    title TEXT NOT NULL,
    body_html TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS answers (
    test_id INTEGER NOT NULL REFERENCES tests ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users ON DELETE CASCADE,
    status TEXT CHECK (status IN ('PASS', 'FAIL')),
    feedback TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (test_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS problems (
    id INTEGER PRIMARY KEY,
    suite_id INTEGER NOT NULL REFERENCES suites ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '',
    comments TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'saved')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  -- Concerns: a tester's card for the admin, outside any test document. The tester writes it;
  -- only the admin moves its status.
  CREATE TABLE IF NOT EXISTS concerns (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '',
    comments TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'saved')),
    status TEXT NOT NULL DEFAULT 'on-hold' CHECK (status IN ('on-hold', 'on-process', 'applied')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS images (${IMAGE_COLUMNS});
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY,
    suite_id INTEGER NOT NULL REFERENCES suites ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users ON DELETE CASCADE,
    suite_id INTEGER REFERENCES suites ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const get = (sql, ...args) => db.prepare(sql).get(...args);
const all = (sql, ...args) => db.prepare(sql).all(...args);
const run = (sql, ...args) => db.prepare(sql).run(...args);

// Columns added after the first version; ALTER keeps existing data.db files working.
function addColumn(table, column, definition) {
  if (!all(`PRAGMA table_info(${table})`).some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
addColumn('users', 'password', 'TEXT'); // readable copy, shown to its owner in the profile (requested)
addColumn('suites', 'notified', 'INTEGER NOT NULL DEFAULT 1'); // did publishing send a "new tests" alert?
addColumn('notifications', 'comment_id', 'INTEGER REFERENCES comments ON DELETE CASCADE'); // deleting a comment takes its alerts
// The editor needs the markdown back, not just the rendered HTML. NULL on documents published
// before the editor existed: those keep their body_html until someone types over it.
addColumn('suites', 'intro_md', 'TEXT');
addColumn('tests', 'body_md', 'TEXT');
addColumn('concerns', 'hidden', 'INTEGER NOT NULL DEFAULT 0'); // the admin's own filing; testers never see it
// Documents published before titles dropped "— acceptance tests": fix them and their alerts.
for (const s of all("SELECT id, title FROM suites WHERE title LIKE '%acceptance test%'")) {
  const title = cleanTitle(s.title);
  run('UPDATE suites SET title = ? WHERE id = ?', title, s.id);
  run('UPDATE notifications SET text = replace(text, ?, ?) WHERE suite_id = ?', s.title, title, s.id);
}
function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
const removeFiles = rows => rows.forEach(r => fs.rm(path.join(UPLOADS, r.file), { force: true }, () => {}));

// data.db files from before concerns have an images table whose CHECK only knows tests and problems.
// SQLite can't widen a CHECK in place, so the table is rebuilt once, keeping every row and id.
if (!all('PRAGMA table_info(images)').some(c => c.name === 'concern_id')) {
  db.exec('PRAGMA foreign_keys = OFF'); // can't be switched inside a transaction
  tx(() => db.exec(`
    CREATE TABLE images_new (${IMAGE_COLUMNS});
    INSERT INTO images_new (id, user_id, test_id, problem_id, file) SELECT id, user_id, test_id, problem_id, file FROM images;
    DROP TABLE images;
    ALTER TABLE images_new RENAME TO images;`));
  db.exec('PRAGMA foreign_keys = ON');
}

// ---------- passwords + admin account ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}
function checkPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), crypto.scryptSync(password, salt, 64));
}

// The admin login is kept in plain text in admin-credentials.txt (as the spec asks).
// Login checks the hash; the readable `password` column only feeds the profile modal.
// The file wins on every start, so editing it and restarting resets the admin login.
function readCreds() {
  const txt = fs.readFileSync(CREDS, 'utf8');
  const line = key => txt.match(new RegExp(`^${key}:[ \\t]*(.+)$`, 'm'))?.[1].trim();
  return { username: line('username'), password: line('password') };
}
function writeCreds({ username, password }) {
  fs.writeFileSync(CREDS, [
    'Tester Manager admin login (plain text, for the programmer only).',
    'Edit these two lines and restart the server to change it.',
    '',
    `username: ${username}`,
    `password: ${password}`,
    '',
  ].join('\n'));
}
if (!fs.existsSync(CREDS)) writeCreds({ username: 'admin', password: crypto.randomBytes(9).toString('base64url') });
const creds = readCreds();
if (!creds.username || !creds.password) throw new Error(`${CREDS} needs "username:" and "password:" lines`);
const admin = get('SELECT id FROM users WHERE is_admin = 1');
if (admin) {
  run('UPDATE users SET username = ?, pass_hash = ?, password = ? WHERE id = ?',
    creds.username, hashPassword(creds.password), creds.password, admin.id);
} else {
  run('INSERT INTO users (username, pass_hash, password, is_admin) VALUES (?, ?, ?, 1)',
    creds.username, hashPassword(creds.password), creds.password);
}

const noticeText = (title, testCount) => `New tests: ${title} (${testCount} tests)`;

// ---------- live updates ----------
// Every open page keeps one SSE stream (tagged with its user, which is also how "online" is known).
// Events only say what changed; pages refetch.
// ponytail: "changed, refetch" instead of diffs; fine for a handful of testers.
const streams = new Set();
function broadcast(req, type, suiteId = null) {
  const event = { type, suiteId, userId: req.user?.id ?? null, tab: req.get('x-tab') ?? null };
  for (const res of streams) res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// ---------- app ----------
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const str = v => (typeof v === 'string' ? v : '');
const validUsername = name => /^[A-Za-z0-9_.-]{3,32}$/.test(name);
const USERNAME_RULE = 'Username must be 3–32 letters, numbers, dots, dashes or underscores';
const sessionToken = req => /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '';

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  run('INSERT INTO sessions (token, user_id) VALUES (?, ?)', token, userId);
  // ponytail: sessions never expire server-side; add an expires_at column if that starts to matter.
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 });
}

app.post('/api/register', (req, res) => {
  const username = str(req.body?.username).trim();
  const password = str(req.body?.password);
  if (!validUsername(username)) return res.status(400).json({ error: USERNAME_RULE });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (get('SELECT 1 FROM users WHERE username = ?', username)) return res.status(409).json({ error: 'That username is taken' });
  const userId = tx(() => {
    const id = run('INSERT INTO users (username, pass_hash, password) VALUES (?, ?, ?)',
      username, hashPassword(password), password).lastInsertRowid;
    // Late joiners get every "new tests" alert that went out before they registered, with its original date.
    const insertNotice = db.prepare('INSERT INTO notifications (user_id, suite_id, text, created_at) VALUES (?, ?, ?, ?)');
    for (const s of all(`SELECT s.id, s.title, s.created_at, (SELECT COUNT(*) FROM tests t WHERE t.suite_id = s.id) AS n
                         FROM suites s WHERE s.notified = 1 ORDER BY s.id`)) {
      insertNotice.run(id, s.id, noticeText(s.title, s.n), s.created_at);
    }
    return id;
  });
  startSession(res, userId);
  broadcast(req, 'suites'); // new tester column for everyone else
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const password = str(req.body?.password);
  const user = get('SELECT id, pass_hash FROM users WHERE username = ?', str(req.body?.username).trim());
  if (!user || !checkPassword(password, user.pass_hash)) {
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  run('UPDATE users SET password = ? WHERE id = ?', password, user.id); // fills it in for accounts made before it was stored
  startSession(res, user.id);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  run('DELETE FROM sessions WHERE token = ?', sessionToken(req));
  res.clearCookie('sid');
  res.json({ ok: true });
});

// Everything below needs a signed-in user.
function auth(req, res, next) {
  req.user = get(`SELECT u.id, u.username, u.is_admin, u.password FROM sessions s JOIN users u ON u.id = s.user_id
                  WHERE s.token = ?`, sessionToken(req));
  if (!req.user) return res.status(401).json({ error: 'Please sign in' });
  next();
}
const adminOnly = (req, res, next) => (req.user.is_admin ? next() : res.status(403).json({ error: 'Admin only' }));
const testerOnly = (req, res, next) =>
  (req.user.is_admin ? res.status(403).json({ error: 'Only testers can do this' }) : next());

app.use('/api', auth);
app.use('/uploads', auth, express.static(UPLOADS, { setHeaders: res => res.set('X-Content-Type-Options', 'nosniff') }));

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('retry: 2000\n\n');
  res.userId = req.user.id;
  streams.add(res);
  broadcast(req, 'presence');
  const ping = setInterval(() => res.write(': ping\n\n'), 25000); // keeps ngrok from closing idle streams
  req.on('close', () => {
    clearInterval(ping);
    streams.delete(res);
    broadcast(req, 'presence');
  });
});

// Admin only: everyone, online first. Online = has the site open (an SSE stream) right now.
app.get('/api/users', adminOnly, (req, res) => {
  const online = new Set([...streams].map(s => s.userId));
  // Passwords included on purpose: the admin can look up a tester's password (requested).
  const users = all('SELECT id, username, is_admin, password FROM users ORDER BY username COLLATE NOCASE')
    .map(u => ({ ...u, online: online.has(u.id) }));
  res.json(users.sort((a, b) => b.online - a.online));
});

// Cascades take their sessions, answers, problems, images and alerts; their open tabs are sent to sign-in.
function deleteUser(req, userId) {
  const files = all('SELECT file FROM images WHERE user_id = ?', userId);
  run('DELETE FROM users WHERE id = ?', userId);
  removeFiles(files);
  for (const s of streams) {
    if (s.userId !== userId) continue;
    streams.delete(s);
    s.end(`data: ${JSON.stringify({ type: 'deleted' })}\n\n`);
  }
  broadcast(req, 'suites');
  broadcast(req, 'presence');
}

app.delete('/api/users/:id', adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const user = get('SELECT is_admin FROM users WHERE id = ?', id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.is_admin) return res.status(403).json({ error: "The admin account can't be deleted" });
  deleteUser(req, id);
  res.json({ ok: true });
});

// ---------- profile ----------
app.get('/api/me', (req, res) => res.json(req.user)); // the caller's own row, including their password

// Testers can delete their own account.
app.delete('/api/me', testerOnly, (req, res) => {
  deleteUser(req, req.user.id);
  res.clearCookie('sid');
  res.json({ ok: true });
});

app.patch('/api/me', (req, res) => {
  const username = str(req.body?.username).trim();
  if (!validUsername(username)) return res.status(400).json({ error: USERNAME_RULE });
  if (get('SELECT 1 FROM users WHERE username = ? AND id != ?', username, req.user.id)) {
    return res.status(409).json({ error: 'That username is taken' });
  }
  run('UPDATE users SET username = ? WHERE id = ?', username, req.user.id);
  if (req.user.is_admin) writeCreds({ username, password: readCreds().password });
  broadcast(req, 'suites');
  res.json({ ok: true });
});

// ---------- test documents ----------
app.get('/api/suites', (req, res) => {
  res.json({
    suites: all(`SELECT s.id, s.title, s.created_at, (SELECT COUNT(*) FROM tests t WHERE t.suite_id = s.id) AS total
                 FROM suites s ORDER BY s.id DESC`),
    problems: all(`SELECT suite_id, user_id, COUNT(*) AS n FROM problems WHERE state = 'saved'
                   GROUP BY suite_id, user_id`),
  });
});

const bad = message => Object.assign(new Error(message), { status: 400 });

// The editor posts fields, not markdown. They are turned into markdown and put through the same
// parser as a pasted file, so both routes end up with byte-identical HTML.
function fromFields(body) {
  const title = str(body?.title).trim();
  const tests = Array.isArray(body?.tests) ? body.tests : [];
  if (!title) throw bad('Give the test document a title');
  if (!tests.length) throw bad('Add at least one test');
  const blank = tests.findIndex(t => !str(t?.title).trim());
  if (blank >= 0) throw bad(`Test ${blank + 1} needs a title`);
  return { doc: { title, intro: str(body?.intro), tests }, parsed: parseSuite(buildSuiteMd({ title, intro: str(body?.intro), tests })) };
}
// A test whose fields are all blank is one the editor never filled in (an older document shown
// read-only). Its stored body is left alone rather than being wiped.
const noBody = t => !SECTIONS.some(h => str(t?.sections?.[h]).trim()) && !str(t?.extra).trim();

// Pasted markdown -> the editor's fields, so the form is the only way a document is written.
app.post('/api/suites/parse', adminOnly, (req, res) => {
  let parsed;
  try {
    parsed = parseSuite(str(req.body?.markdown));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  res.json({
    title: parsed.title,
    intro: parsed.intro,
    tests: parsed.tests.map(t => ({ title: t.title, ...splitBody(t.body) })),
  });
});

app.post('/api/suites', adminOnly, (req, res) => {
  const { parsed } = fromFields(req.body);
  const notify = Boolean(req.body.notify);
  const suiteId = tx(() => {
    const id = run('INSERT INTO suites (title, intro_html, intro_md, notified) VALUES (?, ?, ?, ?)',
      parsed.title, renderMd(parsed.intro), parsed.intro, notify ? 1 : 0).lastInsertRowid;
    const insertTest = db.prepare('INSERT INTO tests (suite_id, num, title, body_html, body_md) VALUES (?, ?, ?, ?, ?)');
    for (const t of parsed.tests) insertTest.run(id, t.num, t.title, renderMd(t.body), t.body);
    if (notify) {
      run(`INSERT INTO notifications (user_id, suite_id, text) SELECT id, ?, ? FROM users WHERE is_admin = 0`,
        id, noticeText(parsed.title, parsed.tests.length));
    }
    return id;
  });
  broadcast(req, 'suites', suiteId);
  if (notify) broadcast(req, 'notify');
  res.json({ id: suiteId });
});

// The editor's fields for an existing document.
app.get('/api/suites/:id/source', adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const suite = get('SELECT id, title, intro_md, intro_html FROM suites WHERE id = ?', id);
  if (!suite) return res.status(404).json({ error: 'These tests were deleted.' });
  res.json({
    id: suite.id,
    title: suite.title,
    intro: suite.intro_md ?? '',
    legacy_intro_html: suite.intro_md == null && suite.intro_html ? suite.intro_html : null,
    tests: all('SELECT id, num, title, body_md, body_html FROM tests WHERE suite_id = ? ORDER BY num, id', id)
      .map(t => ({ id: t.id, title: t.title, ...splitBody(t.body_md), legacy_html: t.body_md == null ? t.body_html : null })),
  });
});

// Editing keeps each surviving test's row id, so its answers, feedback and images survive with it.
// A test dropped in the editor takes its answers and images with it.
app.put('/api/suites/:id', adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const current = get('SELECT intro_md FROM suites WHERE id = ?', id);
  if (!current) return res.status(404).json({ error: 'These tests were deleted.' });
  const { doc, parsed } = fromFields(req.body);
  const keepIntro = current.intro_md == null && !parsed.intro; // an older intro the editor never showed as text
  const own = new Set(all('SELECT id FROM tests WHERE suite_id = ?', id).map(r => r.id));
  const ids = doc.tests.map(t => (own.has(Number(t?.id)) ? Number(t.id) : null)); // ids from elsewhere read as new tests
  const keep = ids.filter(v => v !== null);
  const notKept = keep.length ? ` AND id NOT IN (${keep.map(() => '?').join(',')})` : '';
  const files = all(`SELECT file FROM images WHERE test_id IN (SELECT id FROM tests WHERE suite_id = ?${notKept})`, id, ...keep);
  tx(() => {
    if (keepIntro) run('UPDATE suites SET title = ? WHERE id = ?', parsed.title, id);
    else run('UPDATE suites SET title = ?, intro_html = ?, intro_md = ? WHERE id = ?', parsed.title, renderMd(parsed.intro), parsed.intro, id);
    run(`DELETE FROM tests WHERE suite_id = ?${notKept}`, id, ...keep);
    const insert = db.prepare('INSERT INTO tests (suite_id, num, title, body_html, body_md) VALUES (?, ?, ?, ?, ?)');
    const update = db.prepare('UPDATE tests SET num = ?, title = ?, body_html = ?, body_md = ? WHERE id = ?');
    const rename = db.prepare('UPDATE tests SET num = ?, title = ? WHERE id = ?');
    parsed.tests.forEach((t, i) => {
      if (ids[i] === null) insert.run(id, t.num, t.title, renderMd(t.body), t.body);
      else if (noBody(doc.tests[i])) rename.run(t.num, t.title, ids[i]);
      else update.run(t.num, t.title, renderMd(t.body), t.body, ids[i]);
    });
  });
  removeFiles(files);
  broadcast(req, 'suites', id);
  broadcast(req, 'suite', id);
  res.json({ ok: true });
});

app.delete('/api/suites/:id', adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const files = all(`SELECT i.file FROM images i LEFT JOIN tests t ON t.id = i.test_id
                     LEFT JOIN problems p ON p.id = i.problem_id WHERE t.suite_id = ? OR p.suite_id = ?`, id, id);
  run('DELETE FROM suites WHERE id = ?', id);
  removeFiles(files);
  broadcast(req, 'suites', id);
  broadcast(req, 'notify'); // its notifications went with it
  res.json({ ok: true });
});

// One test document with every tester's sheet. Problems: everyone's saved ones plus your own drafts.
app.get('/api/suites/:id', (req, res) => {
  const id = Number(req.params.id);
  const suite = get('SELECT id, title, intro_html, created_at FROM suites WHERE id = ?', id);
  if (!suite) return res.status(404).json({ error: 'These tests were deleted.' });
  res.json({
    suite,
    tests: all('SELECT id, num, title, body_html FROM tests WHERE suite_id = ? ORDER BY num, id', id),
    testers: all('SELECT id, username FROM users WHERE is_admin = 0 ORDER BY username'),
    // Text is trimmed of blank lines and spaces at both ends, so whitespace-only feedback reads as empty.
    answers: all(`SELECT a.test_id, a.user_id, a.status, trim(a.feedback, char(9,10,13,32)) AS feedback
                  FROM answers a JOIN tests t ON t.id = a.test_id WHERE t.suite_id = ?`, id),
    problems: all(`SELECT id, user_id, title, trim(comments, char(9,10,13,32)) AS comments, state FROM problems
                   WHERE suite_id = ? AND (state = 'saved' OR user_id = ?) ORDER BY id`, id, req.user.id),
    images: all(`SELECT i.id, i.user_id, i.test_id, i.problem_id, i.file FROM images i
                 LEFT JOIN tests t ON t.id = i.test_id LEFT JOIN problems p ON p.id = i.problem_id
                 WHERE t.suite_id = ? OR (p.suite_id = ? AND (p.state = 'saved' OR p.user_id = ?))
                 ORDER BY i.id`, id, id, req.user.id),
    comments: all('SELECT id, text, created_at FROM comments WHERE suite_id = ? ORDER BY id DESC', id),
  });
});

// ---------- admin comments (one thread per test document, shown to every tester) ----------
app.post('/api/suites/:id/comments', adminOnly, (req, res) => {
  const suite = get('SELECT id, title FROM suites WHERE id = ?', Number(req.params.id));
  if (!suite) return res.status(404).json({ error: 'These tests were deleted.' });
  const text = str(req.body?.text).trim();
  if (!text) return res.status(400).json({ error: 'Write a comment first' });
  const line = text.replace(/\s+/g, ' ');
  tx(() => {
    const id = run('INSERT INTO comments (suite_id, text) VALUES (?, ?)', suite.id, text).lastInsertRowid;
    run(`INSERT INTO notifications (user_id, suite_id, comment_id, text) SELECT id, ?, ?, ? FROM users WHERE is_admin = 0`,
      suite.id, id, `Admin comment on ${suite.title}: ${line.length > 80 ? `${line.slice(0, 80)}…` : line}`);
  });
  broadcast(req, 'suite', suite.id);
  broadcast(req, 'notify');
  res.json({ ok: true });
});

app.delete('/api/comments/:id', adminOnly, (req, res) => {
  const comment = get('SELECT id, suite_id FROM comments WHERE id = ?', Number(req.params.id));
  if (!comment) return res.status(404).json({ error: 'Comment not found' });
  run('DELETE FROM comments WHERE id = ?', comment.id);
  broadcast(req, 'suite', comment.suite_id);
  broadcast(req, 'notify');
  res.json({ ok: true });
});

// ---------- answers ----------
app.put('/api/answers/:testId', testerOnly, (req, res) => {
  const test = get('SELECT id, suite_id FROM tests WHERE id = ?', Number(req.params.testId));
  if (!test) return res.status(404).json({ error: 'Test not found' });
  const status = ['PASS', 'FAIL'].includes(req.body?.status) ? req.body.status : null;
  run(`INSERT INTO answers (test_id, user_id, status, feedback) VALUES (?, ?, ?, ?)
       ON CONFLICT (test_id, user_id) DO UPDATE
       SET status = excluded.status, feedback = excluded.feedback, updated_at = CURRENT_TIMESTAMP`,
    test.id, req.user.id, status, str(req.body?.feedback));
  broadcast(req, 'suite', test.suite_id);
  res.json({ ok: true });
});

// ---------- problems (tester's own findings outside the tests) ----------
app.post('/api/suites/:id/problems', testerOnly, (req, res) => {
  const suite = get('SELECT id FROM suites WHERE id = ?', Number(req.params.id));
  if (!suite) return res.status(404).json({ error: 'These tests were deleted.' });
  const { lastInsertRowid } = run('INSERT INTO problems (suite_id, user_id) VALUES (?, ?)', suite.id, req.user.id);
  res.json({ id: lastInsertRowid }); // a draft: nobody else can see it yet, so no broadcast
});

function ownProblem(req, res) {
  const problem = get('SELECT id, suite_id FROM problems WHERE id = ? AND user_id = ?', Number(req.params.id), req.user.id);
  if (!problem) res.status(404).json({ error: 'Problem not found' });
  return problem;
}

app.put('/api/problems/:id', testerOnly, (req, res) => {
  const problem = ownProblem(req, res);
  if (!problem) return;
  const title = str(req.body?.title).trim();
  const state = req.body?.state === 'saved' ? 'saved' : 'draft';
  if (state === 'saved' && !title) return res.status(400).json({ error: 'Give the problem a title before saving' });
  run('UPDATE problems SET title = ?, comments = ?, state = ? WHERE id = ?', title, str(req.body?.comments), state, problem.id);
  broadcast(req, 'suite', problem.suite_id);
  res.json({ ok: true });
});

app.delete('/api/problems/:id', testerOnly, (req, res) => {
  const problem = ownProblem(req, res);
  if (!problem) return;
  const files = all('SELECT file FROM images WHERE problem_id = ?', problem.id);
  run('DELETE FROM problems WHERE id = ?', problem.id);
  removeFiles(files);
  broadcast(req, 'suite', problem.suite_id);
  res.json({ ok: true });
});

// ---------- concerns ----------
// Testers see and write only their own cards. The admin sees every saved card, sets its status and
// can delete it (for everyone), but never edits what the tester wrote.
const CONCERN_STATUSES = ['on-hold', 'on-process', 'applied'];
const visibleConcerns = req => (req.user.is_admin ? ["c.state = 'saved'"] : ['c.user_id = ?', req.user.id]);

app.get('/api/concerns', (req, res) => {
  const [where, ...args] = visibleConcerns(req);
  res.json({
    concerns: all(`SELECT c.id, c.user_id, c.title, trim(c.comments, char(9,10,13,32)) AS comments, c.state, c.status,
                   ${req.user.is_admin ? 'c.hidden' : '0'} AS hidden FROM concerns c WHERE ${where} ORDER BY c.id`, ...args),
    testers: req.user.is_admin ? all('SELECT id, username FROM users WHERE is_admin = 0 ORDER BY username COLLATE NOCASE') : [],
    images: all(`SELECT i.id, i.user_id, i.concern_id, i.file FROM images i JOIN concerns c ON c.id = i.concern_id
                 WHERE ${where} ORDER BY i.id`, ...args),
  });
});

app.post('/api/concerns', testerOnly, (req, res) => {
  const { lastInsertRowid } = run('INSERT INTO concerns (user_id) VALUES (?)', req.user.id);
  res.json({ id: lastInsertRowid }); // a draft: nobody else can see it yet, so no broadcast
});

// Title, comments and draft/saved only: the status is the admin's, so it isn't read from the body.
app.put('/api/concerns/:id', testerOnly, (req, res) => {
  const concern = get('SELECT id FROM concerns WHERE id = ? AND user_id = ?', Number(req.params.id), req.user.id);
  if (!concern) return res.status(404).json({ error: 'Concern not found' });
  const title = str(req.body?.title).trim();
  const state = req.body?.state === 'saved' ? 'saved' : 'draft';
  if (state === 'saved' && !title) return res.status(400).json({ error: 'Give the concern a title before saving' });
  run('UPDATE concerns SET title = ?, comments = ?, state = ? WHERE id = ?', title, str(req.body?.comments), state, concern.id);
  broadcast(req, 'concerns');
  res.json({ ok: true });
});

app.patch('/api/concerns/:id/status', adminOnly, (req, res) => {
  const status = str(req.body?.status);
  if (!CONCERN_STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status' });
  const { changes } = run("UPDATE concerns SET status = ? WHERE id = ? AND state = 'saved'", status, Number(req.params.id));
  if (!changes) return res.status(404).json({ error: 'Concern not found' });
  broadcast(req, 'concerns');
  res.json({ ok: true });
});

// Hiding only moves the card out of the admin's All view; the tester's card is unchanged.
app.patch('/api/concerns/:id/hidden', adminOnly, (req, res) => {
  const { changes } = run("UPDATE concerns SET hidden = ? WHERE id = ? AND state = 'saved'", req.body?.hidden ? 1 : 0, Number(req.params.id));
  if (!changes) return res.status(404).json({ error: 'Concern not found' });
  broadcast(req, 'concerns');
  res.json({ ok: true });
});

// The tester deletes their own; the admin deletes any card they can see, for everyone.
app.delete('/api/concerns/:id', (req, res) => {
  const [where, ...args] = visibleConcerns(req);
  const concern = get(`SELECT c.id FROM concerns c WHERE c.id = ? AND ${where}`, Number(req.params.id), ...args);
  if (!concern) return res.status(404).json({ error: 'Concern not found' });
  const files = all('SELECT file FROM images WHERE concern_id = ?', concern.id);
  run('DELETE FROM concerns WHERE id = ?', concern.id);
  removeFiles(files);
  broadcast(req, 'concerns');
  res.json({ ok: true });
});

// ---------- images ----------
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

// The browser sends the file itself as the request body: POST /api/images?test=ID, ?problem=ID or ?concern=ID
app.post('/api/images', testerOnly, express.raw({ type: Object.keys(IMAGE_TYPES), limit: '5mb' }), (req, res) => {
  const ext = IMAGE_TYPES[req.get('content-type')];
  if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) {
    return res.status(400).json({ error: 'Only PNG, JPEG, WebP or GIF images can be added' });
  }
  const id = key => (req.query[key] ? Number(req.query[key]) : null);
  const [testId, problemId] = [id('test'), id('problem')];
  const concernId = testId || problemId ? null : id('concern');
  const owner = testId ? get('SELECT suite_id FROM tests WHERE id = ?', testId)
    : problemId ? get('SELECT suite_id FROM problems WHERE id = ? AND user_id = ?', problemId, req.user.id)
      : get('SELECT NULL AS suite_id FROM concerns WHERE id = ? AND user_id = ?', concernId, req.user.id);
  if (!owner) return res.status(404).json({ error: 'Test, problem or concern not found' });
  const file = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS, file), req.body);
  const { lastInsertRowid } = run('INSERT INTO images (user_id, test_id, problem_id, concern_id, file) VALUES (?, ?, ?, ?, ?)',
    req.user.id, testId, problemId, concernId, file);
  broadcast(req, concernId ? 'concerns' : 'suite', owner.suite_id);
  res.json({ id: lastInsertRowid, file });
});

app.delete('/api/images/:id', testerOnly, (req, res) => {
  const image = get(`SELECT i.id, i.file, i.concern_id, COALESCE(t.suite_id, p.suite_id) AS suite_id FROM images i
                     LEFT JOIN tests t ON t.id = i.test_id LEFT JOIN problems p ON p.id = i.problem_id
                     WHERE i.id = ? AND i.user_id = ?`, Number(req.params.id), req.user.id);
  if (!image) return res.status(404).json({ error: 'Image not found' });
  run('DELETE FROM images WHERE id = ?', image.id);
  removeFiles([image]);
  broadcast(req, image.concern_id ? 'concerns' : 'suite', image.suite_id);
  res.json({ ok: true });
});

// ---------- notifications (testers) ----------
app.get('/api/notifications', (req, res) => {
  res.json(all('SELECT id, suite_id, text, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC', req.user.id));
});
app.delete('/api/notifications/:id', (req, res) => {
  run('DELETE FROM notifications WHERE id = ? AND user_id = ?', Number(req.params.id), req.user.id);
  res.json({ ok: true });
});
app.delete('/api/notifications', (req, res) => {
  run('DELETE FROM notifications WHERE user_id = ?', req.user.id);
  res.json({ ok: true });
});

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'File is too large (images: 5 MB max)' });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

app.listen(PORT, () => {
  console.log(`Tester Manager running at http://localhost:${PORT}`);
  console.log(`Admin login: ${CREDS}`);
});
