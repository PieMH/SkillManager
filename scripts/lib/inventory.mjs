// What is installed for this profile and project. Reads files only: the SessionStart hook calls this,
// so it must stay fast and never spawn `claude`. The on-disk formats are Claude Code internals, so
// every reader degrades to "nothing found" instead of throwing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; }
};
const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const exists = (file) => fs.existsSync(file);
const listDir = (dir) => { try { return fs.readdirSync(dir).filter((n) => !n.startsWith('.')); } catch { return []; } };

const norm = (p) => {
  const s = path.resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
};
export const samePath = (a, b) => Boolean(a && b) && norm(a) === norm(b);

export function paths(env = process.env, home = os.homedir()) {
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  return {
    home,
    configDir,
    // Claude Code keeps .claude.json in the home dir unless CLAUDE_CONFIG_DIR moves it.
    globalJson: path.join(env.CLAUDE_CONFIG_DIR ? configDir : home, '.claude.json'),
    stateFile: path.join(configDir, 'skillset', 'state.json'),
  };
}

// Only `name` and `description` matter here, so this handles the YAML shapes skills use for them:
// plain, quoted, and block (`|`, `>`) or indented continuation lines.
export function frontmatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!m) return out;
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const top = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (top) { key = top[1]; out[key] = top[2]; } else if (key && /^\s+\S/.test(line)) out[key] += ' ' + line.trim();
  }
  for (const k of Object.keys(out)) {
    out[k] = out[k].replace(/^[>|][+-]?(\s+|$)/, '').trim().replace(/^(["'])([\s\S]*)\1$/, '$2').replace(/\\"/g, '"');
  }
  return out;
}

// First sentence when it is short enough, otherwise a cut with an ellipsis.
export function oneLine(s, max = 140) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  const first = /^(.{20,}?[.!?])(\s|$)/.exec(t);
  const cut = first && first[1].length <= max ? first[1] : t;
  return cut.length > max ? cut.slice(0, max - 1).trimEnd() + '…' : cut;
}

function skillsIn(dir) {
  const out = [];
  for (const folder of listDir(dir)) {
    const text = readText(path.join(dir, folder, 'SKILL.md')); // follows junctions; '' for plain files
    if (!text) continue;
    const fm = frontmatter(text);
    out.push({ folder, name: fm.name || folder, description: fm.description || '', dir: path.join(dir, folder) });
  }
  return out;
}

const mdIn = (dir) => listDir(dir).filter((n) => n.endsWith('.md')).map((n) => {
  const fm = frontmatter(readText(path.join(dir, n)));
  return { name: fm.name || n.slice(0, -3), description: fm.description || '', file: path.join(dir, n) };
});

// The origin remote of the git clone a skill lives in, if any. Stops at the home dir so a
// dotfiles repo there is not mistaken for the skill's source.
function gitRemote(dir, home) {
  let d;
  try { d = fs.realpathSync(dir); } catch { return null; }
  for (let i = 0; i < 4 && !samePath(d, home); i++) {
    const cfg = readText(path.join(d, '.git', 'config'));
    if (cfg) {
      const m = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(cfg);
      return m ? m[1].replace(/\.git$/, '') : null;
    }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

// `hooks` in a plugin manifest is a path, a list of paths or an inline object; default hooks/hooks.json.
function hookEvents(value, root) {
  const events = new Set();
  for (const f of value == null ? ['hooks/hooks.json'] : [].concat(value)) {
    const j = typeof f === 'string' ? readJson(path.join(root, f)) : f;
    const h = j?.hooks ?? (typeof f === 'string' ? null : j);
    for (const [event, groups] of Object.entries(h || {})) if (Array.isArray(groups) && groups.length) events.add(event);
  }
  return [...events];
}

function mcpNames(manifest, root) {
  let v = manifest.mcpServers ?? '.mcp.json';
  if (typeof v === 'string') { const j = readJson(path.join(root, v)); v = j?.mcpServers ?? j; }
  return v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : [];
}

// shortcut: default component folders only, a manifest's custom `skills`/`agents` paths are not followed;
// add that if a plugin that uses them shows up with an empty skill list.
function describePlugin(root) {
  const manifest = readJson(path.join(root, '.claude-plugin', 'plugin.json')) || {};
  const commands = listDir(path.join(root, 'commands')).filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3));
  const c = {
    skills: [...skillsIn(path.join(root, 'skills')).map((s) => s.name), ...commands],
    agents: mdIn(path.join(root, 'agents')).map((a) => a.name),
    hooks: hookEvents(manifest.hooks, root),
    mcp: mcpNames(manifest, root),
    bin: exists(path.join(root, 'bin')),
    lsp: Boolean(manifest.lspServers) || exists(path.join(root, '.lsp.json')),
  };
  // Instruction-only plugins can be used by reading a SKILL.md from the install path, without enabling them.
  const instructionOnly = c.skills.length > 0 && !c.agents.length && !c.hooks.length && !c.mcp.length && !c.bin && !c.lsp;
  return { manifest, components: c, instructionOnly };
}

const marketplaceUrl = (src) => {
  if (!src) return null;
  if (src.source === 'github' && src.repo) return `https://github.com/${src.repo}`;
  return src.url ? String(src.url).replace(/\.git$/, '') : src.path ? String(src.path).replace(/\\/g, '/') : null;
};

// Never the args, env or URL path of a server: those are where tokens live.
function describeMcp(def) {
  if (def?.url) {
    try { const u = new URL(def.url); return { description: `${def.type || 'http'} server at ${u.host}`, source: u.origin }; } catch { return { description: 'remote server', source: 'remote' }; }
  }
  const exe = def?.command ? path.basename(String(def.command)).replace(/\.(exe|cmd)$/i, '') : '';
  return { description: exe ? `stdio server (${exe})` : 'server', source: 'local' };
}

export function inventory({ projectDir, env = process.env, home = os.homedir() } = {}) {
  const p = paths(env, home);
  const g = readJson(p.globalJson) || {};
  const warnings = [];
  const things = [];
  const seen = new Set();
  const add = (t) => { if (!seen.has(t.id)) { seen.add(t.id); things.push(t); } };

  const scopes = [
    ['user', readJson(path.join(p.configDir, 'settings.json'))],
    ['project', projectDir && readJson(path.join(projectDir, '.claude', 'settings.json'))],
    ['local', projectDir && readJson(path.join(projectDir, '.claude', 'settings.local.json'))],
  ];
  const merged = (key) => Object.assign({}, ...scopes.map(([, s]) => s?.[key] || {})); // later scope wins
  const enabledPlugins = merged('enabledPlugins');
  const skillOverrides = merged('skillOverrides');

  const usage = (...keys) => {
    let best = null;
    for (const k of keys) {
      const u = g.skillUsage?.[k] || g.pluginUsage?.[k];
      if (u && (!best || (u.usageCount || 0) > (best.usageCount || 0))) best = u;
    }
    return { uses: best?.usageCount || 0, lastUsed: best?.lastUsedAt ? new Date(best.lastUsedAt).toISOString().slice(0, 10) : null };
  };

  // Skills. Personal wins over project on a name clash, as in Claude Code.
  const lock = readJson(path.join(home, '.agents', '.skill-lock.json'))?.skills || {}; // written by `npx skills`
  const skillDirs = [['user', path.join(p.configDir, 'skills')]];
  if (projectDir) skillDirs.push(['project', path.join(projectDir, '.claude', 'skills')]);
  for (const [scope, dir] of skillDirs) {
    for (const s of skillsIn(dir)) {
      const locked = lock[s.folder]?.sourceUrl || lock[s.name]?.sourceUrl;
      add({
        id: `skill:${s.name}`, kind: 'skill', name: s.name, scope, description: s.description,
        source: locked ? locked.replace(/\.git$/, '') : gitRemote(s.dir, home) || 'local',
        path: path.join(s.dir, 'SKILL.md'), state: skillOverrides[s.name] || 'on',
        ...usage(s.name, `${s.name}@skills-dir`),
      });
    }
  }
  // Skills synced from the claude.ai account. Claude Code lists them under the `anthropic-skills:` prefix.
  for (const bucket of listDir(path.join(p.configDir, 'skills', 'synced'))) {
    for (const s of skillsIn(path.join(p.configDir, 'skills', 'synced', bucket))) {
      const name = `anthropic-skills:${s.name}`;
      add({
        id: `skill:${name}`, kind: 'skill', name, scope: 'synced', description: s.description,
        source: 'claude.ai account', path: path.join(s.dir, 'SKILL.md'), state: skillOverrides[name] || 'on',
        ...usage(name, s.name),
      });
    }
  }

  // Plugins installed from marketplaces.
  const installed = readJson(path.join(p.configDir, 'plugins', 'installed_plugins.json'));
  if (installed && installed.version !== 2) warnings.push(`installed_plugins.json has version ${installed.version}; plugin data may be incomplete`);
  const markets = readJson(path.join(p.configDir, 'plugins', 'known_marketplaces.json')) || {};
  const addPlugin = (id, root, scope, version, fallbackSource) => {
    const d = describePlugin(root);
    add({
      id: `plugin:${id}`, kind: 'plugin', name: id, scope, version: version || d.manifest.version || null,
      description: d.manifest.description || '',
      source: d.manifest.homepage || (typeof d.manifest.repository === 'string' ? d.manifest.repository : d.manifest.repository?.url) || fallbackSource || 'local',
      path: root, enabled: enabledPlugins[id] !== false, components: d.components, instructionOnly: d.instructionOnly,
      ...usage(id),
    });
  };
  for (const [id, entries] of Object.entries(installed?.plugins || {})) {
    const mine = (Array.isArray(entries) ? entries : []).filter((e) => e.scope === 'user' || samePath(e.projectPath, projectDir));
    const e = mine.find((x) => x.scope !== 'user') || mine[0]; // an install for this project beats the user-scope one
    if (e) addPlugin(id, e.installPath, e.scope, e.version, marketplaceUrl(markets[id.split('@')[1]]?.source));
  }
  // Plugins synced from the claude.ai account: plugins/synced/<bucket>/<dir>/, tracked as `<name>@synced`.
  for (const bucket of listDir(path.join(p.configDir, 'plugins', 'synced'))) {
    const root = path.join(p.configDir, 'plugins', 'synced', bucket);
    for (const dir of listDir(root)) {
      const name = readJson(path.join(root, dir, '.claude-plugin', 'plugin.json'))?.name;
      if (name) addPlugin(`${name}@synced`, path.join(root, dir), 'synced', null, 'claude.ai account');
    }
  }

  // MCP servers. Plugin-provided ones are listed under their plugin.
  const projectKey = Object.keys(g.projects || {}).find((k) => samePath(k, projectDir));
  const mcpScopes = [
    ['project', projectDir && readJson(path.join(projectDir, '.mcp.json'))?.mcpServers],
    ['local', projectKey && g.projects[projectKey].mcpServers],
    ['user', g.mcpServers],
  ];
  for (const [scope, servers] of mcpScopes) {
    for (const [name, def] of Object.entries(servers || {})) {
      add({ id: `mcp:${name}`, kind: 'mcp', name, scope, ...describeMcp(def), uses: 0, lastUsed: null });
    }
  }

  // Agents.
  const agentDirs = [['user', path.join(p.configDir, 'agents')]];
  if (projectDir) agentDirs.push(['project', path.join(projectDir, '.claude', 'agents')]);
  for (const [scope, dir] of agentDirs) {
    for (const a of mdIn(dir)) add({ id: `agent:${a.name}`, kind: 'agent', name: a.name, scope, description: a.description, source: 'local', path: a.file, uses: 0, lastUsed: null });
  }

  // Hooks from settings files, for information: a hook has no switch of its own. Only the
  // executable name is shown, because hook commands can carry tokens.
  for (const [scope, s] of scopes) {
    for (const [event, groups] of Object.entries(s?.hooks || {})) {
      for (const group of Array.isArray(groups) ? groups : []) {
        const runs = (group.hooks || []).map((h) => path.basename(String(h.command || h.type || '').trim().split(/\s+/)[0]).replace(/"/g, '')).filter(Boolean);
        add({ id: `hook:${scope}/${event}/${group.matcher || '*'}`, kind: 'hook', name: event, scope, description: `runs ${runs.join(', ') || 'a hook'} on ${event}`, source: `${scope} settings`, uses: 0, lastUsed: null });
      }
    }
  }

  const order = ['plugin', 'skill', 'mcp', 'agent', 'hook'];
  things.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.id.localeCompare(b.id));
  return { things, warnings, configDir: p.configDir };
}
