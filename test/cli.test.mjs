// End-to-end tests for the taskforge CLI against an in-process mock of the Task Forge API.
// Run: node --test packages/cli/test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'taskforge.mjs');

// ── mock API ────────────────────────────────────────────────────

const USERS = [
  { id: 'u-me', name: 'Alex Admin', email: 'alex@acme.test', active: true, deletedAt: null, jobTitle: 'Lead', role: { name: 'Admin' } },
  { id: 'u-r1', name: 'Rahul Shah', email: 'rahul.shah@acme.test', active: true, deletedAt: null, jobTitle: 'Backend', role: { name: 'Member' } },
  { id: 'u-r2', name: 'Rahul Patel', email: 'rpatel@acme.test', active: true, deletedAt: null, jobTitle: 'QA', role: { name: 'Member' } },
  { id: 'u-p', name: 'Priya Nair', email: 'priya@acme.test', active: true, deletedAt: null, jobTitle: 'Frontend', role: { name: 'Member' } },
  { id: 'u-k', name: 'Kanji', email: 'priyanka.k@acme.test', active: true, deletedAt: null, jobTitle: 'Ops', role: { name: 'Member' } },
  { id: 'u-x', name: 'Old Timer', email: 'old@acme.test', active: false, deletedAt: null, role: { name: 'Member' } },
];
const PROJECTS = [
  { id: 'p-web', name: 'Website', description: 'Marketing site' },
  { id: 'p-app', name: 'Mobile App', description: null },
];
const FIELDS = {
  'p-web': [],
  'p-app': [
    { key: 'platform', name: 'Platform', type: 'select', required: true, options: [{ id: 'opt-ios', label: 'iOS' }, { id: 'opt-and', label: 'Android' }] },
    { key: 'story_points', name: 'Story Points', type: 'number', required: false, options: null },
  ],
};

const state = { validTokens: new Set(), refreshTokens: new Set(), created: [], n: 0, multiCompany: false };

function issue() {
  const n = ++state.n;
  state.validTokens.add(`at-${n}`);
  state.refreshTokens.add(`rt-${n}`);
  return { accessToken: `at-${n}`, refreshToken: `rt-${n}` };
}

let server;
let baseUrl;

before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    const url = new URL(req.url, 'http://x');
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const authed = () => state.validTokens.has((req.headers.authorization || '').replace('Bearer ', ''));
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /api/health') return send(200, { ok: true });
    if (route === 'POST /api/auth/login') {
      if (body.password !== 'secret123') return send(401, { error: 'Invalid credentials' });
      if (state.multiCompany && !body.companySlug) {
        return send(200, { requiresCompany: true, companies: [{ id: 'c1', name: 'Acme', slug: 'acme' }, { id: 'c2', name: 'Globex', slug: 'globex' }] });
      }
      const company = body.companySlug === 'globex' ? { id: 'c2', name: 'Globex', slug: 'globex' } : { id: 'c1', name: 'Acme', slug: 'acme' };
      return send(200, { ...issue(), requiresCompany: false, user: { ...USERS[0], company } });
    }
    if (route === 'POST /api/auth/refresh') {
      if (!state.refreshTokens.delete(body.refreshToken)) return send(401, { error: 'Invalid refresh token' });
      return send(200, issue());
    }
    if (!authed()) return send(401, { error: 'Invalid or expired token' });
    if (route === 'POST /api/auth/logout') return send(200, { ok: true });
    if (route === 'GET /api/auth/me') return send(200, { user: { ...USERS[0], company: { id: 'c1', name: 'Acme', slug: 'acme' } } });
    if (route === 'GET /api/users') return send(200, USERS);
    if (route === 'GET /api/projects') return send(200, PROJECTS);
    if (route === 'GET /api/custom-fields') return send(200, FIELDS[url.searchParams.get('projectId')] ?? []);
    if (route === 'POST /api/tasks') {
      if (!body.projectId || !body.title) return send(400, { error: 'Validation failed' });
      const task = { id: `t-${state.created.length + 1}`, priority: 'normal', ...body };
      state.created.push(body);
      return send(201, task);
    }
    send(404, { error: 'Not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `127.0.0.1:${server.address().port}`;
});

after(() => server.close());

// ── helpers ─────────────────────────────────────────────────────

function run(args, { stdin = '', env = {}, configDir } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, TASKFORGE_CONFIG_DIR: configDir, TASKFORGE_PASSWORD: '', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.end(stdin);
    child.on('close', (code) => {
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {}
      resolve({ code, stdout, stderr, json });
    });
  });
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'taskforge-test-'));

async function loggedIn() {
  const configDir = tmpDir();
  const r = await run(['login', '--url', baseUrl, '--email', 'alex@acme.test'], { configDir, env: { TASKFORGE_PASSWORD: 'secret123' } });
  assert.equal(r.code, 0, r.stderr);
  return configDir;
}

// ── tests ───────────────────────────────────────────────────────

test('login via prompts saves a 0600 config with normalized URL', async () => {
  const configDir = tmpDir();
  const r = await run(['login'], { configDir, stdin: `http://${baseUrl}/api/\nalex@acme.test\nsecret123\n` });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /Logged in as Alex Admin/);
  const file = path.join(configDir, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(cfg.url, `http://${baseUrl}`);
  assert.equal(cfg.user.id, 'u-me');
  assert.equal(cfg.company.slug, 'acme');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('login with wrong password fails', async () => {
  const r = await run(['login', '--url', baseUrl, '--email', 'alex@acme.test'], { configDir: tmpDir(), env: { TASKFORGE_PASSWORD: 'nope' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Invalid credentials/);
});

test('login rejects a server that is not Task Forge', async () => {
  const r = await run(['login', '--url', '127.0.0.1:1', '--email', 'a@b.c'], { configDir: tmpDir(), env: { TASKFORGE_PASSWORD: 'x' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Cannot reach Task Forge/);
});

test('login asks for a company when the email belongs to several', async () => {
  state.multiCompany = true;
  try {
    const configDir = tmpDir();
    const r = await run(['login', '--url', baseUrl, '--email', 'alex@acme.test'], { configDir, stdin: '2\n', env: { TASKFORGE_PASSWORD: 'secret123' } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8')).company.slug, 'globex');
  } finally {
    state.multiCompany = false;
  }
});

test('commands before login exit 3', async () => {
  const r = await run(['create', '--title', 'x'], { configDir: tmpDir() });
  assert.equal(r.code, 3);
  assert.equal(r.json.ok, false);
  assert.match(r.json.error, /taskforge login/);
});

test('whoami, users and projects return JSON; inactive users hidden', async () => {
  const configDir = await loggedIn();
  const who = await run(['whoami'], { configDir });
  assert.equal(who.json.user.email, 'alex@acme.test');
  const users = await run(['users'], { configDir });
  assert.equal(users.json.count, 5);
  assert.ok(!users.json.users.some((u) => u.email === 'old@acme.test'));
  const rahuls = await run(['users', 'rahul'], { configDir });
  assert.equal(rahuls.json.count, 2);
  const projects = await run(['projects'], { configDir });
  assert.deepEqual(projects.json.projects.map((p) => p.name), ['Website', 'Mobile App']);
});

test('create resolves names, parses dates/estimates and sends the right payload', async () => {
  const configDir = await loggedIn();
  const r = await run(
    ['create', '--title', 'Fix login bug', '--project', 'web', '-a', 'priya', '-a', 'rahul.shah@acme.test', '--priority', 'medium', '--due', '2026-11-20', '--estimate', '1h30m', '-d', 'SSO loop'],
    { configDir },
  );
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.task.assignees.map((a) => a.name), ['Priya Nair', 'Rahul Shah']);
  const sent = state.created.at(-1);
  assert.deepEqual(sent, {
    projectId: 'p-web',
    title: 'Fix login bug',
    description: 'SSO loop',
    assignees: [{ userId: 'u-p' }, { userId: 'u-r1' }],
    priority: 'normal',
    estimatedMinutes: 90,
    dueDate: '2026-11-20T00:00:00.000Z',
  });
});

test('ambiguous assignee exits 2 with candidates and creates nothing', async () => {
  const configDir = await loggedIn();
  const before = state.created.length;
  const r = await run(['create', '--title', 'X', '--project', 'Website', '-a', 'rahul'], { configDir });
  assert.equal(r.code, 2);
  assert.equal(r.json.reason, 'ambiguous');
  assert.deepEqual(r.json.candidates.map((c) => c.email).sort(), ['rahul.shah@acme.test', 'rpatel@acme.test']);
  assert.equal(state.created.length, before);
});

test('unknown assignee and missing project exit 2', async () => {
  const configDir = await loggedIn();
  const r1 = await run(['create', '--title', 'X', '--project', 'Website', '-a', 'zed'], { configDir });
  assert.equal(r1.code, 2);
  assert.equal(r1.json.reason, 'not_found');
  const r2 = await run(['create', '--title', 'X'], { configDir });
  assert.equal(r2.code, 2);
  assert.equal(r2.json.reason, 'missing_project');
  assert.equal(r2.json.available.length, 2);
});

test('required custom fields are reported, then accepted by label', async () => {
  const configDir = await loggedIn();
  const r1 = await run(['create', '--title', 'Push fix', '--project', 'Mobile App', '-a', 'me'], { configDir });
  assert.equal(r1.code, 2);
  assert.equal(r1.json.reason, 'missing_required_fields');
  assert.deepEqual(r1.json.missing[0].options, ['iOS', 'Android']);

  const r2 = await run(['create', '--title', 'Push fix', '--project', 'Mobile App', '-a', 'me', '--field', 'Platform=android', '--field', 'story_points=3'], { configDir });
  assert.equal(r2.code, 0, r2.stdout);
  assert.deepEqual(state.created.at(-1).customFields, { platform: 'opt-and', story_points: 3 });
  assert.deepEqual(state.created.at(-1).assignees, [{ userId: 'u-me' }]);
});

test('create accepts a JSON payload on stdin; --dry-run creates nothing', async () => {
  const configDir = await loggedIn();
  const payload = { title: 'Write release notes', project: 'Website', assignees: ['Priya Nair'], priority: 'high', due: '2026-12-01 17:30', estimate: '2h', description: 'Line 1\nLine "2"' };
  const before = state.created.length;
  const dry = await run(['create', '--json', '-', '--dry-run'], { configDir, stdin: JSON.stringify(payload) });
  assert.equal(dry.code, 0, dry.stdout);
  assert.equal(dry.json.dryRun, true);
  assert.equal(state.created.length, before);

  const r = await run(['create', '--json', '-'], { configDir, stdin: JSON.stringify(payload) });
  assert.equal(r.code, 0, r.stdout);
  const sent = state.created.at(-1);
  assert.equal(sent.description, 'Line 1\nLine "2"');
  assert.equal(sent.estimatedMinutes, 120);
  assert.equal(sent.dueDate, new Date('2026-12-01T17:30').toISOString());
});

test('expired access token is refreshed transparently and persisted', async () => {
  const configDir = await loggedIn();
  const file = path.join(configDir, 'config.json');
  const old = JSON.parse(fs.readFileSync(file, 'utf8'));
  state.validTokens.delete(old.accessToken); // simulate JWT expiry
  const r = await run(['projects'], { configDir });
  assert.equal(r.code, 0, r.stdout);
  const updated = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.notEqual(updated.accessToken, old.accessToken);
  assert.notEqual(updated.refreshToken, old.refreshToken);
});

test('revoked refresh token asks the user to log in again', async () => {
  const configDir = await loggedIn();
  const cfg = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'));
  state.validTokens.delete(cfg.accessToken);
  state.refreshTokens.delete(cfg.refreshToken);
  const r = await run(['projects'], { configDir });
  assert.equal(r.code, 3);
  assert.match(r.json.error, /Session expired/);
});

test('invalid priority / date / estimate exit 2', async () => {
  const configDir = await loggedIn();
  for (const extra of [['--priority', 'asap'], ['--due', 'someday'], ['--estimate', 'a while']]) {
    const r = await run(['create', '--title', 'X', '--project', 'Website', ...extra], { configDir });
    assert.equal(r.code, 2, `${extra.join(' ')} → ${r.stdout}`);
  }
});

test('install-skill copies SKILL.md into a project .claude dir', async () => {
  const dir = tmpDir();
  const r = await run(['install-skill', '--project', dir], { configDir: tmpDir() });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(fs.readFileSync(path.join(dir, '.claude', 'skills', 'taskforge', 'SKILL.md'), 'utf8').includes('name: taskforge'));
});

test('name matches win over email matches', async () => {
  const configDir = await loggedIn();
  // "priya" is a name-prefix of Priya Nair and an email-prefix of Kanji (priyanka.k@) → Priya wins.
  const r = await run(['create', '--title', 'X', '--project', 'Website', '-a', 'priya', '--dry-run'], { configDir });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.wouldCreate.assignees[0].id, 'u-p');
  // An email-only match still works when no name matches.
  const r2 = await run(['create', '--title', 'X', '--project', 'Website', '-a', 'priyanka', '--dry-run'], { configDir });
  assert.equal(r2.code, 0, r2.stdout);
  assert.equal(r2.json.wouldCreate.assignees[0].id, 'u-k');
});

test('estimate defaults to 1h when omitted, explicit estimate is kept', async () => {
  const configDir = await loggedIn();
  const r = await run(['create', '--title', 'No estimate', '--project', 'Website'], { configDir });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(state.created.at(-1).estimatedMinutes, 60);
  assert.equal(r.json.task.estimateDefaulted, true);
  const r2 = await run(['create', '--title', 'With estimate', '--project', 'Website', '--estimate', '8h'], { configDir });
  assert.equal(state.created.at(-1).estimatedMinutes, 480);
  assert.equal(r2.json.task.estimateDefaulted, false);
});
