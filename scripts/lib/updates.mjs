// Update check: which installed plugins and skills have something newer upstream. It reads Claude Code's
// files and asks GitHub; it never changes an install. The SessionStart hook starts it once a week in the
// background, and /skillmanager-update runs it on demand. Results live in the per-account state file.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitRoot, readJson } from './inventory.mjs';

const WEEK = 7 * 24 * 3600 * 1000;
const UA = { 'User-Agent': 'skillmanager-plugin' }; // GitHub's API refuses requests without one

export const readState = (p) => readJson(p.stateFile) || {};
export function writeState(p, state) {
  fs.mkdirSync(path.dirname(p.stateFile), { recursive: true });
  const tmp = `${p.stateFile}.${process.pid}.tmp`; // two sessions can start at once
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, p.stateFile);
}

// Due when no check has started in the last seven days. The hook stamps the start before spawning,
// so sessions that open together start one check, not several.
export const due = (state, now = Date.now()) => !(now - (Date.parse(state.checkStartedAt) || 0) < WEEK);

// The update pass is the person's weekly review: a check they asked for, and the review of what it found.
// The background check refreshes the list but is no pass. The band and the board both read this.
export const passDue = (state, now = Date.now()) => !(now - (Date.parse(state.passAt) || 0) <= WEEK);
export const stampPass = (p, now = Date.now()) => writeState(p, { ...readState(p), passAt: new Date(now).toISOString() });

// Pending: found by the last check and not skipped at that same version.
export const pending = (state) => (state.updates || []).filter((u) => state.skipped?.[u.id]?.latest !== u.latest);

// Stops proposing the pending update of `id` until a version newer than this one appears.
export function skip(p, id, reason = '') {
  const st = readState(p);
  const u = (st.updates || []).find((x) => x.id === id);
  if (!u) throw new Error(`no pending update for ${id}. Run \`check --cached\` for the list.`);
  writeState(p, { ...st, skipped: { ...st.skipped, [id]: { latest: u.latest, reason, at: new Date().toISOString().slice(0, 10) } } });
  return u;
}

// True when `a` is a higher dotted version than `b`. Commit-hash versions are not compared.
// shortcut: pre-release tags are ignored (1.2.0-beta reads as 1.2.0); compare them if a plugin ships them.
export function newer(a, b) {
  const num = (v) => (/^v?\d+(\.\d+)*/.exec(String(v || ''))?.[0] || '').replace(/^v/, '');
  const [x, y] = [num(a), num(b)];
  if (!x || !y) return false;
  const [xs, ys] = [x.split('.').map(Number), y.split('.').map(Number)];
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) if ((xs[i] || 0) !== (ys[i] || 0)) return (xs[i] || 0) > (ys[i] || 0);
  return false;
}

const rel = (s) => String(s || '').replace(/^(\.\/)+/, '').replace(/^\.$/, '').replace(/\/$/, ''); // keeps `.claude-plugin`
const join = (...parts) => parts.map(rel).filter(Boolean).join('/');

// The version a marketplace entry offers: its own `version`, else the plugin.json it points at.
async function offered(entry, readFile) {
  if (!entry) return null;
  if (entry.version) return entry.version;
  const src = entry.source;
  if (typeof src === 'string') return (await readFile(null, join(src, '.claude-plugin/plugin.json')))?.version || null;
  if (src?.source === 'github' && src.repo) return (await readFile(src.repo, '.claude-plugin/plugin.json', src.ref))?.version || null;
  return null; // shortcut: git-url and npm plugin sources are not checked; add them when one is installed
}

// Each source counts the remotes it tried and maps the ids it could not reach to what is installed now
// (`log.failed`), so check() keeps their last result instead of reading an outage as "up to date".
async function pluginUpdates(p, get, log) {
  const installed = readJson(path.join(p.configDir, 'plugins', 'installed_plugins.json'))?.plugins || {};
  const markets = readJson(path.join(p.configDir, 'plugins', 'known_marketplaces.json')) || {};
  const manifests = new Map();
  const out = [];
  for (const [id, entries] of Object.entries(installed)) {
    const e = (Array.isArray(entries) ? entries : []).find((x) => x.scope === 'user') || entries?.[0];
    const [name, mkt] = id.split('@');
    const src = markets[mkt]?.source;
    if (!e || !src) continue;
    let readFile;
    if (src.source === 'directory' && src.path) readFile = async (repo, file) => (repo ? null : readJson(path.join(src.path, file)));
    else if (src.source === 'github' && src.repo) readFile = (repo, file, ref) => get.raw(repo || src.repo, file, ref);
    else continue;
    if (src.source !== 'directory') log.tried++; // a local folder answers offline too, so it proves nothing
    try {
      if (!manifests.has(mkt)) manifests.set(mkt, await readFile(null, '.claude-plugin/marketplace.json'));
      const latest = await offered(manifests.get(mkt)?.plugins?.find((x) => x.name === name), readFile);
      // The scope names the install compared here; without it, the project's own install would be updated instead.
      const cd = e.scope !== 'user' && e.projectPath ? `cd "${String(e.projectPath).replace(/\\/g, '/')}" && ` : '';
      if (newer(latest, e.version)) out.push({ id: `plugin:${id}`, installed: e.version, latest, how: `claude plugin marketplace update ${mkt} && ${cd}claude plugin update ${id} --scope ${e.scope}` });
    } catch (err) { log.errors.push(`${id}: ${err.message}`); log.failed.set(`plugin:${id}`, e.version); }
  }
  return out;
}

// Skills installed by `npx skills`: the lock file keeps the git tree SHA of each skill folder, so one
// tree listing per repo tells which folders changed upstream.
// shortcut: a skill installed with `--rename` never matches its upstream tree, so it always shows as
// pending until skipped; read the lock's own `computedHash` if the skills CLI starts writing it here.
async function lockUpdates(p, get, log) {
  const lock = readJson(path.join(p.home, '.agents', '.skill-lock.json'))?.skills || {};
  const byRepo = new Map();
  for (const [key, s] of Object.entries(lock)) {
    if (s.sourceType !== 'github' || !s.source || !s.skillFolderHash) continue;
    if (!fs.existsSync(path.join(p.configDir, 'skills', key))) continue; // installed for another profile only
    byRepo.set(s.source, [...(byRepo.get(s.source) || []), [key, s]]);
  }
  const out = [];
  for (const [repo, skills] of byRepo) {
    log.tried++;
    try {
      const tree = await get.api(`repos/${repo}/git/trees/HEAD?recursive=1`);
      const sha = new Map((tree?.tree || []).filter((t) => t.type === 'tree').map((t) => [t.path, t.sha]));
      for (const [key, s] of skills) {
        const dir = path.posix.dirname(rel(s.skillPath));
        const now = dir === '.' || dir === '' ? tree?.sha : sha.get(dir);
        if (now && now !== s.skillFolderHash) out.push({ id: `skill:${key}`, installed: s.skillFolderHash.slice(0, 7), latest: now.slice(0, 7), how: `npx skills update ${key}` });
      }
    } catch (err) { log.errors.push(`${repo}: ${err.message}`); for (const [key, s] of skills) log.failed.set(`skill:${key}`, s.skillFolderHash.slice(0, 7)); }
  }
  return out;
}

// Skills that live in a git clone (linked into the skills folder): local HEAD against the remote's.
function cloneUpdates(p, git, log) {
  const lock = readJson(path.join(p.home, '.agents', '.skill-lock.json'))?.skills || {};
  const out = [];
  const dir = path.join(p.configDir, 'skills');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => !n.startsWith('.') && n !== 'synced' && !lock[n]); } catch { return out; }
  const roots = new Map();
  for (const n of names) {
    const d = gitRoot(path.join(dir, n), p.home);
    if (d) roots.set(d, [...(roots.get(d) || []), n]);
  }
  for (const [root, skills] of roots) {
    log.tried++;
    const head = git(root, ['rev-parse', 'HEAD']);
    const remote = git(root, ['ls-remote', 'origin', 'HEAD'])?.split(/\s/)[0];
    if (!head || !remote) {
      log.errors.push(`${root.replace(/\\/g, '/')}: git could not compare with origin`);
      for (const n of skills) log.failed.set(`skill:${n}`, head ? head.slice(0, 7) : null);
      continue;
    }
    if (head !== remote) for (const n of skills) out.push({ id: `skill:${n}`, installed: head.slice(0, 7), latest: remote.slice(0, 7), how: `git -C "${root.replace(/\\/g, '/')}" pull --ff-only` });
  }
  return out;
}

// Network and git access, swappable in tests.
export const live = {
  get: {
    async raw(repo, file, ref = 'HEAD') {
      const res = await fetch(`https://raw.githubusercontent.com/${repo}/${ref}/${file}`, { headers: UA, signal: AbortSignal.timeout(15000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return JSON.parse(await res.text());
    },
    // shortcut: unauthenticated GitHub API (60 requests an hour, one per skill repo); add a token if that runs out.
    async api(route) {
      const res = await fetch(`https://api.github.com/${route}`, { headers: { ...UA, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`GitHub API ${res.status}`);
      return res.json();
    },
  },
  git(cwd, args) {
    // No prompts: a private remote must fail, not open a credential window in the background.
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 20000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } });
    return r.status === 0 ? r.stdout.trim() : null;
  },
};

// `reached` is false when every source failed (offline, rate-limited): such a check is no update pass.
export async function check(p, io = live) {
  const log = { tried: 0, errors: [], failed: new Map() };
  const found = [...await pluginUpdates(p, io.get, log), ...await lockUpdates(p, io.get, log), ...cloneUpdates(p, io.git, log)];
  const state = readState(p); // re-read: a session may have written it while the network calls ran
  // A kept update must still describe what is installed: one applied since then is gone, not pending.
  const stillInstalled = (u) => log.failed.has(u.id) && (log.failed.get(u.id) == null || log.failed.get(u.id) === u.installed);
  const updates = [...found, ...(state.updates || []).filter(stillInstalled)];
  writeState(p, { ...state, checkedAt: new Date().toISOString(), updates, checkErrors: log.errors });
  return { updates, errors: log.errors, reached: !log.tried || log.errors.length < log.tried };
}
