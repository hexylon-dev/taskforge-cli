#!/usr/bin/env node
// Task Forge CLI — a zero-dependency client for the Task Forge API.
// Designed to be driven by Claude Code: every data command prints a single JSON
// object to stdout ({ ok: true, ... } or { ok: false, error, ... }).
//
// Exit codes: 0 ok · 1 error · 2 needs input (ambiguous/unknown name, missing field) · 3 not logged in

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const VERSION = '1.1.0';
const DEFAULT_ESTIMATE_MINUTES = 60; // used when no --estimate is given
const PRIORITIES = ['urgent', 'high', 'normal', 'low'];
const PRIORITY_ALIASES = { medium: 'normal', med: 'normal', critical: 'urgent', p0: 'urgent', p1: 'high', p2: 'normal', p3: 'low' };

// Per-user config: $TASKFORGE_CONFIG_DIR, else %APPDATA%\taskforge on Windows, else $XDG_CONFIG_HOME/taskforge or ~/.config/taskforge.
const CONFIG_DIR =
  process.env.TASKFORGE_CONFIG_DIR ||
  (process.platform === 'win32' && process.env.APPDATA
    ? path.join(process.env.APPDATA, 'taskforge')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'taskforge'));
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// ── errors & output ─────────────────────────────────────────────

class CliError extends Error {
  constructor(message, { exitCode = 1, ...extra } = {}) {
    super(message);
    this.exitCode = exitCode;
    this.extra = extra;
  }
}

const out = (obj) => process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
const info = (msg) => process.stderr.write(msg + '\n');

// ── config ──────────────────────────────────────────────────────

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
}

function requireSession(cfg) {
  if (!cfg.url || !cfg.accessToken) {
    throw new CliError('Not logged in. Ask the user to run: taskforge login', { exitCode: 3 });
  }
}

// "host:port", "http://host:port/", "https://x.com/api" → "http://host:port" (no trailing /api)
function normalizeBaseUrl(raw) {
  let url = String(raw || '').trim();
  if (!url) throw new CliError('A server URL is required (e.g. 192.168.1.10:4000)');
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  url = url.replace(/\/+$/, '').replace(/\/api$/i, '');
  try {
    new URL(url);
  } catch {
    throw new CliError(`Invalid URL: ${raw}`);
  }
  return url;
}

// ── HTTP ────────────────────────────────────────────────────────

async function rawRequest(baseUrl, method, apiPath, { body, token } = {}) {
  let res;
  try {
    res = await fetch(`${baseUrl}/api${apiPath}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    const reason = err?.cause?.code || err?.name || err?.message;
    throw new CliError(`Cannot reach Task Forge at ${baseUrl} (${reason})`);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  return { status: res.status, ok: res.ok, data };
}

function apiError(res) {
  const msg = res.data?.error || res.data?.raw || `HTTP ${res.status}`;
  const extra = res.data?.details ? { details: res.data.details } : {};
  return new CliError(msg, { status: res.status, ...extra });
}

// Authenticated request with one transparent refresh on 401.
async function api(cfg, method, apiPath, body) {
  requireSession(cfg);
  let res = await rawRequest(cfg.url, method, apiPath, { body, token: cfg.accessToken });
  if (res.status === 401 && cfg.refreshToken) {
    const r = await rawRequest(cfg.url, 'POST', '/auth/refresh', { body: { refreshToken: cfg.refreshToken } });
    if (!r.ok) {
      saveConfig({ ...cfg, accessToken: null, refreshToken: null });
      throw new CliError('Session expired. Ask the user to run: taskforge login', { exitCode: 3 });
    }
    cfg.accessToken = r.data.accessToken;
    cfg.refreshToken = r.data.refreshToken;
    saveConfig(cfg);
    res = await rawRequest(cfg.url, method, apiPath, { body, token: cfg.accessToken });
  }
  if (res.status === 401) throw new CliError('Not authorized. Ask the user to run: taskforge login', { exitCode: 3 });
  if (!res.ok) throw apiError(res);
  return res.data;
}

// ── interactive prompts (login only) ───────────────────────────

let pipedLines = null;
async function readPipedLine() {
  if (pipedLines === null) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    pipedLines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
  }
  return pipedLines.shift() ?? '';
}

async function prompt(question, def) {
  const label = def ? `${question} [${def}]: ` : `${question}: `;
  let answer;
  if (!process.stdin.isTTY) {
    process.stderr.write(label);
    answer = await readPipedLine();
    process.stderr.write('\n');
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    answer = await new Promise((resolve) => rl.question(label, resolve));
    rl.close();
  }
  answer = answer.trim();
  return answer || def || '';
}

async function promptHidden(question) {
  if (!process.stdin.isTTY) {
    process.stderr.write(`${question}: `);
    const line = await readPipedLine();
    process.stderr.write('\n');
    return line;
  }
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stderr.write(`${question}: `);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const done = (value) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stderr.write('\n');
      resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return done(buf);
        if (ch === '\u0003') {
          done('');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

// ── arg parsing ─────────────────────────────────────────────────

const BOOLEAN_FLAGS = new Set(['help', 'dry-run', 'all', 'force', 'version']);
const REPEATABLE_FLAGS = new Set(['assignee', 'field']);
const SHORT = { h: 'help', a: 'assignee', p: 'project', t: 'title', d: 'description', v: 'version' };

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    let key;
    let value;
    if (arg.startsWith('--')) {
      arg = arg.slice(2);
      const eq = arg.indexOf('=');
      if (eq >= 0) [key, value] = [arg.slice(0, eq), arg.slice(eq + 1)];
      else key = arg;
    } else if (/^-[a-zA-Z]$/.test(arg)) {
      key = SHORT[arg[1]];
      if (!key) throw new CliError(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
      continue;
    }
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = value === undefined ? true : !/^(false|0|no)$/i.test(value);
      continue;
    }
    if (value === undefined) {
      if (i + 1 >= argv.length) throw new CliError(`Option --${key} needs a value`);
      value = argv[++i];
    }
    if (REPEATABLE_FLAGS.has(key)) (flags[key] ||= []).push(value);
    else flags[key] = value;
  }
  return { positional, flags };
}

// ── matching helpers ────────────────────────────────────────────

const norm = (s) => String(s ?? '').toLowerCase().trim();

const wordPrefix = (value, q) => {
  const v = norm(value);
  return v.startsWith(q) || v.split(/[\s._@-]+/).some((w) => w.startsWith(q));
};

// Tiered match, first tier with any hit wins:
//   exact id → exact key fields → word-prefix per fuzzy group → substring per fuzzy group.
// `fuzzy` is a list of field getters in priority order (e.g. name before email), so
// "keval" picks the user *named* Keval over one whose email merely starts with "keval".
// Returns exactly one item or throws a needs-input error with candidates.
function resolveOne(items, query, { kind, exact, fuzzy, describe }) {
  const q = norm(query);
  if (!q) throw new CliError(`Empty ${kind} name`, { exitCode: 2 });
  const tiers = [
    items.filter((it) => norm(it.id) === q),
    items.filter((it) => exact(it).some((v) => norm(v) === q)),
    ...fuzzy.map((get) => items.filter((it) => wordPrefix(get(it), q))),
    ...fuzzy.map((get) => items.filter((it) => norm(get(it)).includes(q))),
  ];
  for (const hits of tiers) {
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      throw new CliError(`"${query}" matches ${hits.length} ${kind}s — ask the user which one`, {
        exitCode: 2,
        reason: 'ambiguous',
        query,
        candidates: hits.slice(0, 15).map(describe),
      });
    }
  }
  throw new CliError(`No ${kind} matches "${query}"`, {
    exitCode: 2,
    reason: 'not_found',
    query,
    available: items.slice(0, 50).map(describe),
  });
}

const describeUser = (u) => ({ id: u.id, name: u.name, email: u.email, jobTitle: u.jobTitle ?? null, role: u.role?.name ?? null });
const describeProject = (p) => ({ id: p.id, name: p.name, description: p.description ?? null });

function makeContext(cfg) {
  const cache = {};
  const ctx = {
    cfg,
    async users() {
      cache.users ||= (await api(cfg, 'GET', '/users')).filter((u) => u.active && !u.deletedAt);
      return cache.users;
    },
    async projects() {
      cache.projects ||= await api(cfg, 'GET', '/projects');
      return cache.projects;
    },
    async resolveUser(query) {
      if (['me', 'myself', 'self'].includes(norm(query))) {
        const self = (await ctx.users()).find((u) => u.id === cfg.user?.id);
        if (self) return self;
      }
      return resolveOne(await ctx.users(), query, {
        kind: 'user',
        exact: (u) => [u.email, u.name, u.email?.split('@')[0]],
        fuzzy: [(u) => u.name, (u) => u.email],
        describe: describeUser,
      });
    },
    async resolveProject(query) {
      return resolveOne(await ctx.projects(), query, {
        kind: 'project',
        exact: (p) => [p.name],
        fuzzy: [(p) => p.name],
        describe: describeProject,
      });
    },
  };
  return ctx;
}

// ── value parsing ───────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Returns an ISO-8601 UTC string accepted by the API, or null.
// Date-only values mirror the web app (<input type=date> → new Date('YYYY-MM-DD')).
function parseDate(raw, label) {
  if (raw === undefined || raw === null || raw === '') return null;
  let s = String(raw).trim();
  const lower = s.toLowerCase();
  const now = new Date();
  if (lower === 'today') s = ymd(now);
  else if (lower === 'tomorrow') s = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  else if (/^\+\d+d$/.test(lower)) s = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + parseInt(lower.slice(1), 10)));
  else if (/^\+\d+w$/.test(lower)) s = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7 * parseInt(lower.slice(1), 10)));

  let d;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) d = new Date(s);
  else if (/^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(:\d{2})?$/.test(s)) d = new Date(s.replace(' ', 'T')); // local time
  else d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new CliError(`Invalid ${label}: "${raw}" (use YYYY-MM-DD, "YYYY-MM-DD HH:mm", ISO-8601, today, tomorrow, +3d, +1w)`, { exitCode: 2 });
  }
  return d.toISOString();
}

// "90", "90m", "2h", "1h30m", "1.5h" → minutes
function parseEstimate(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'number') return Math.round(raw);
  const s = String(raw).trim().toLowerCase().replace(/\s+/g, '');
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const m = s.match(/^(?:(\d+(?:\.\d+)?)h(?:ours?|rs?)?)?(?:(\d+)m(?:in(?:utes?|s)?)?)?$/);
  if (!m || (!m[1] && !m[2])) throw new CliError(`Invalid estimate: "${raw}" (use minutes, 2h, 1h30m, 1.5h)`, { exitCode: 2 });
  const minutes = Math.round(parseFloat(m[1] || '0') * 60 + parseInt(m[2] || '0', 10));
  if (minutes <= 0) throw new CliError('Estimate must be greater than zero', { exitCode: 2 });
  return minutes;
}

function parsePriority(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const p = norm(raw);
  const val = PRIORITY_ALIASES[p] || p;
  if (!PRIORITIES.includes(val)) throw new CliError(`Invalid priority "${raw}" — use one of: ${PRIORITIES.join(', ')}`, { exitCode: 2 });
  return val;
}

// Convert a human value into what the custom-field validator expects for its type.
async function coerceFieldValue(def, value, ctx) {
  if (value === null || value === undefined || value === '') return null;
  const opts = Array.isArray(def.options) ? def.options : [];
  const findOpt = (v) => {
    const o = opts.find((x) => x.id === v) || opts.find((x) => norm(x.label) === norm(v));
    if (!o) {
      throw new CliError(`"${v}" is not a valid option for field "${def.name}"`, {
        exitCode: 2,
        field: def.key,
        options: opts.map((x) => x.label),
      });
    }
    return o.id;
  };
  switch (def.type) {
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      if (Number.isNaN(n)) throw new CliError(`Field "${def.name}" expects a number`, { exitCode: 2 });
      return n;
    }
    case 'checkbox':
      if (typeof value === 'boolean') return value;
      return /^(true|yes|y|1|on|checked)$/i.test(String(value));
    case 'date':
      return parseDate(value, `date for "${def.name}"`);
    case 'user':
      return (await ctx.resolveUser(String(value))).id;
    case 'select':
      return findOpt(String(value));
    case 'multiselect': {
      const list = Array.isArray(value) ? value : String(value).split(',').map((s) => s.trim()).filter(Boolean);
      return list.map((v) => findOpt(String(v)));
    }
    default:
      return String(value);
  }
}

const describeField = (f) => ({
  key: f.key,
  name: f.name,
  type: f.type,
  required: !!f.required,
  ...(Array.isArray(f.options) && f.options.length ? { options: f.options.map((o) => o.label) } : {}),
});

// ── commands ────────────────────────────────────────────────────

async function cmdLogin(flags) {
  const cfg = loadConfig();
  const url = normalizeBaseUrl(flags.url || (await prompt('Task Forge URL (host:port)', cfg.url)));

  const health = await rawRequest(url, 'GET', '/health');
  if (!health.ok || !health.data?.ok) {
    throw new CliError(`${url} does not look like a Task Forge API (GET /api/health returned ${health.status})`);
  }

  const email = flags.email || (await prompt('Email', cfg.user?.email));
  if (!email) throw new CliError('Email is required');
  const password = process.env.TASKFORGE_PASSWORD || (await promptHidden('Password'));
  if (!password) throw new CliError('Password is required');

  let res = await rawRequest(url, 'POST', '/auth/login', { body: { email, password, companySlug: flags.company } });
  if (res.ok && res.data?.requiresCompany) {
    const companies = res.data.companies;
    info('\nThis email belongs to several companies:');
    companies.forEach((c, i) => info(`  ${i + 1}) ${c.name} (${c.slug})`));
    const pick = await prompt('Choose a company number');
    const chosen = companies[parseInt(pick, 10) - 1] || companies.find((c) => c.slug === pick);
    if (!chosen) throw new CliError('Invalid company selection');
    res = await rawRequest(url, 'POST', '/auth/login', { body: { email, password, companySlug: chosen.slug } });
  }
  if (!res.ok) throw apiError(res);

  const { accessToken, refreshToken, user } = res.data;
  saveConfig({
    url,
    accessToken,
    refreshToken,
    user: { id: user.id, name: user.name, email: user.email },
    company: user.company ? { id: user.company.id, name: user.company.name, slug: user.company.slug } : null,
  });
  info(`\n✓ Logged in as ${user.name} <${user.email}>${user.company ? ` — ${user.company.name}` : ''}`);
  info(`  Server: ${url}`);
  info(`  Saved to: ${CONFIG_FILE}`);
}

async function cmdLogout() {
  const cfg = loadConfig();
  if (cfg.url && cfg.accessToken) {
    await rawRequest(cfg.url, 'POST', '/auth/logout', { token: cfg.accessToken }).catch(() => {});
  }
  saveConfig({ url: cfg.url });
  out({ ok: true, message: 'Logged out' });
}

async function cmdWhoami() {
  const cfg = loadConfig();
  const { user } = await api(cfg, 'GET', '/auth/me');
  out({
    ok: true,
    server: cfg.url,
    user: { id: user.id, name: user.name, email: user.email, role: user.role?.name ?? null, jobTitle: user.jobTitle ?? null },
    company: user.company ? { id: user.company.id, name: user.company.name, slug: user.company.slug } : null,
  });
}

async function cmdUsers(flags, positional) {
  const ctx = makeContext(loadConfig());
  const q = norm(flags.search ?? positional[0]);
  let users = await ctx.users();
  if (q) users = users.filter((u) => [u.name, u.email, u.jobTitle].some((v) => norm(v).includes(q)));
  out({ ok: true, count: users.length, users: users.map(describeUser) });
}

async function cmdProjects(flags, positional) {
  const ctx = makeContext(loadConfig());
  const q = norm(flags.search ?? positional[0]);
  let projects = await ctx.projects();
  if (q) projects = projects.filter((p) => norm(p.name).includes(q));
  out({ ok: true, count: projects.length, projects: projects.map(describeProject) });
}

async function cmdFields(flags, positional) {
  const ctx = makeContext(loadConfig());
  const projectQuery = flags.project ?? positional[0];
  if (!projectQuery) throw new CliError('Usage: taskforge fields --project <name|id>', { exitCode: 2 });
  const project = await ctx.resolveProject(projectQuery);
  const defs = await api(ctx.cfg, 'GET', `/custom-fields?projectId=${encodeURIComponent(project.id)}`);
  out({ ok: true, project: describeProject(project), fields: defs.map(describeField) });
}

async function readJsonInput(src) {
  let text = src;
  if (src === '-') {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    text = Buffer.concat(chunks).toString('utf8');
  } else if (src.startsWith('@')) {
    text = fs.readFileSync(src.slice(1), 'utf8');
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch (err) {
    throw new CliError(`--json must be a JSON object (${err.message})`, { exitCode: 2 });
  }
}

function parseFieldFlag(s) {
  const eq = s.indexOf('=');
  if (eq <= 0) throw new CliError(`--field expects key=value, got "${s}"`, { exitCode: 2 });
  const key = s.slice(0, eq).trim();
  const rawVal = s.slice(eq + 1);
  let value = rawVal;
  try {
    value = JSON.parse(rawVal);
  } catch {
    /* keep as plain string */
  }
  return [key, value];
}

async function cmdCreate(flags) {
  const cfg = loadConfig();
  requireSession(cfg);
  const ctx = makeContext(cfg);

  // Merge: JSON payload first, explicit flags override.
  const input = flags.json ? await readJsonInput(flags.json) : {};
  const pick = (...keys) => keys.map((k) => input[k]).find((v) => v !== undefined && v !== null && v !== '');

  const title = String(flags.title ?? pick('title', 'name') ?? '').trim();
  if (!title) throw new CliError('A task title is required (--title)', { exitCode: 2, reason: 'missing_title' });

  let assigneeQueries = flags.assignee ?? pick('assignees', 'assignee', 'assigneeIds', 'assigneeId') ?? [];
  if (!Array.isArray(assigneeQueries)) assigneeQueries = [assigneeQueries];
  assigneeQueries = assigneeQueries
    .map((a) => (a && typeof a === 'object' ? a.userId ?? a.id ?? a.email ?? a.name : a))
    .flatMap((a) => (typeof a === 'string' ? a.split(',') : [a]))
    .map((a) => String(a ?? '').trim())
    .filter(Boolean);

  // Project: explicit, or the only visible project.
  const projectQuery = flags.project ?? pick('project', 'projectId', 'projectName');
  let project;
  if (projectQuery) project = await ctx.resolveProject(String(projectQuery));
  else {
    const projects = await ctx.projects();
    if (projects.length === 1) project = projects[0];
    else {
      throw new CliError('Which project should this task go in? Pass --project', {
        exitCode: 2,
        reason: 'missing_project',
        available: projects.map(describeProject),
      });
    }
  }

  const assignees = [];
  for (const q of assigneeQueries) {
    const u = await ctx.resolveUser(q);
    if (!assignees.some((a) => a.id === u.id)) assignees.push(u);
  }

  const description = flags.description ?? pick('description', 'desc', 'details');
  const priority = parsePriority(flags.priority ?? pick('priority'));
  const dueDate = parseDate(flags.due ?? pick('due', 'dueDate', 'deadline'), 'due date');
  const startDate = parseDate(flags.start ?? pick('start', 'startDate'), 'start date');
  // Companies can require an estimate (tasks.requireEstimate); default to 1h so a create never bounces on it.
  const givenEstimate = parseEstimate(flags.estimate ?? pick('estimate', 'estimatedMinutes', 'estimateMinutes'));
  const estimateDefaulted = givenEstimate === null;
  const estimatedMinutes = givenEstimate ?? DEFAULT_ESTIMATE_MINUTES;
  const githubLink = flags.github ?? pick('github', 'githubLink');
  const parentTaskId = flags.parent ?? pick('parent', 'parentTaskId');

  // Custom fields: accept key or display name; coerce labels → option ids etc.
  const rawFields = { ...(input.fields || input.customFields || {}) };
  for (const f of flags.field ?? []) {
    const [k, v] = parseFieldFlag(f);
    rawFields[k] = v;
  }
  const defs = await api(cfg, 'GET', `/custom-fields?projectId=${encodeURIComponent(project.id)}`);
  const customFields = {};
  for (const [k, v] of Object.entries(rawFields)) {
    const def = defs.find((d) => d.key === k) || defs.find((d) => norm(d.name) === norm(k) || norm(d.key) === norm(k));
    if (!def) {
      throw new CliError(`Unknown custom field "${k}" for project "${project.name}"`, {
        exitCode: 2,
        reason: 'unknown_field',
        fields: defs.map(describeField),
      });
    }
    customFields[def.key] = await coerceFieldValue(def, v, ctx);
  }
  // Server only enforces required fields for assigned top-level tasks — check up front for a clearer error.
  if (assignees.length && !parentTaskId) {
    const missing = defs.filter((d) => d.required && (customFields[d.key] === undefined || customFields[d.key] === null || (Array.isArray(customFields[d.key]) && !customFields[d.key].length)));
    if (missing.length) {
      throw new CliError(`Project "${project.name}" requires: ${missing.map((d) => d.name).join(', ')}`, {
        exitCode: 2,
        reason: 'missing_required_fields',
        missing: missing.map(describeField),
        hint: 'Pass each with --field "<key>=<value>"',
      });
    }
  }

  const payload = {
    projectId: project.id,
    title,
    ...(description ? { description: String(description) } : {}),
    ...(assignees.length ? { assignees: assignees.map((u) => ({ userId: u.id })) } : {}),
    ...(priority ? { priority } : {}),
    ...(estimatedMinutes ? { estimatedMinutes } : {}),
    ...(dueDate ? { dueDate } : {}),
    ...(startDate ? { startDate } : {}),
    ...(githubLink ? { githubLink: String(githubLink) } : {}),
    ...(parentTaskId ? { parentTaskId: String(parentTaskId) } : {}),
    ...(Object.keys(customFields).length ? { customFields } : {}),
  };

  const summary = {
    title,
    project: describeProject(project),
    assignees: assignees.map(describeUser),
    priority: priority ?? '(company default)',
    dueDate: dueDate ?? null,
    startDate: startDate ?? null,
    estimatedMinutes,
    estimateDefaulted,
  };

  if (flags['dry-run']) {
    out({ ok: true, dryRun: true, wouldCreate: summary, payload });
    return;
  }

  const task = await api(cfg, 'POST', '/tasks', payload);
  out({
    ok: true,
    task: {
      id: task.id,
      title: task.title,
      priority: task.priority,
      dueDate: task.dueDate ?? null,
      startDate: task.startDate ?? null,
      estimatedMinutes: task.estimatedMinutes ?? null,
      estimateDefaulted,
      project: describeProject(project),
      assignees: assignees.map(describeUser),
      createdBy: cfg.user ?? null,
    },
  });
}

async function cmdInstallSkill(flags) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = path.resolve(here, '..', 'skill', 'SKILL.md');
  const base = flags.project ? path.resolve(flags.project, '.claude') : path.join(os.homedir(), '.claude');
  const destDir = path.join(base, 'skills', 'taskforge');
  const dest = path.join(destDir, 'SKILL.md');
  if (fs.existsSync(dest) && !flags.force) {
    const same = fs.readFileSync(dest, 'utf8') === fs.readFileSync(src, 'utf8');
    if (!same) throw new CliError(`${dest} already exists and differs — re-run with --force to overwrite`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, dest);
  info(`✓ Claude Code skill installed: ${dest}`);
  info('  Restart Claude Code (or start a new session) to pick it up.');
}

// ── help ────────────────────────────────────────────────────────

const HELP = `taskforge ${VERSION} — Task Forge CLI

Usage: taskforge <command> [options]

Setup
  login [--url host:port] [--email e] [--company slug]
                       Sign in (prompts for anything not given; password is
                       read hidden, or from $TASKFORGE_PASSWORD)
  logout               Revoke the session and forget tokens
  whoami               Show the signed-in user, company and server
  install-skill [--project <dir>] [--force]
                       Install the Claude Code skill (default: ~/.claude/skills)

Lookup (JSON output)
  users [query]        Active users in the company (filter by name/email/title)
  projects [query]     Projects you can see
  fields --project p   Custom fields for a project (with required flags/options)

Create (JSON output)
  create --title "..." --project <name|id> [options]
    -a, --assignee <name|email|id|me>   Repeatable; first = primary assignee
    -d, --description "..."
        --priority urgent|high|normal|low
        --due <date>       YYYY-MM-DD | "YYYY-MM-DD HH:mm" | ISO | today | tomorrow | +3d | +1w
        --start <date>
        --estimate <dur>   90 | 90m | 2h | 1h30m | 1.5h   (default: 1h)
        --github <url>
        --parent <taskId>  Create as a subtask
        --field key=value  Custom field (repeatable; select fields take the option label)
        --json '<obj>'     Supply any of the above as JSON ('-' = stdin, @file = file)
        --dry-run          Resolve names and validate without creating

Exit codes: 0 ok · 1 error · 2 needs user input (see "candidates"/"missing") · 3 not logged in
Config: ${CONFIG_FILE}`;

// ── main ────────────────────────────────────────────────────────

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);

  if (!command || command === 'help' || command === '--help' || command === '-h') return void process.stdout.write(HELP + '\n');
  if (command === '--version' || command === '-v' || command === 'version') return void process.stdout.write(VERSION + '\n');
  if (flags.help) return void process.stdout.write(HELP + '\n');

  const commands = {
    login: cmdLogin,
    logout: cmdLogout,
    whoami: cmdWhoami,
    users: cmdUsers,
    projects: cmdProjects,
    fields: cmdFields,
    create: cmdCreate,
    'install-skill': cmdInstallSkill,
  };
  const fn = commands[command];
  if (!fn) throw new CliError(`Unknown command "${command}". Run: taskforge help`);
  await fn(flags, positional);
}

const INTERACTIVE = new Set(['login', 'install-skill']);

main().catch((err) => {
  const cmd = process.argv[2];
  if (err instanceof CliError) {
    if (INTERACTIVE.has(cmd)) info(`✗ ${err.message}`);
    else out({ ok: false, error: err.message, ...err.extra });
    process.exit(err.exitCode);
  }
  if (INTERACTIVE.has(cmd)) info(`✗ ${err?.stack || err}`);
  else out({ ok: false, error: String(err?.message || err) });
  process.exit(1);
});
