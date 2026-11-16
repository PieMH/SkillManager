// Facts about a plugin, a skill or a folder of skills before it is installed: what it adds, what it
// collides with in this profile, what it needs, and lines that look risky. The target is untrusted data:
// it is read, never run. `claude plugin validate` and NVIDIA SkillSpector run only when on the PATH.
// The /skillset-update skill reads these facts and decides; nothing here gives a verdict.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { frontmatter, mdIn, readJson, skillsIn } from './inventory.mjs';

const fwd = (p) => String(p).replace(/\\/g, '/');
const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build']);
const TEXT = /\.(md|mdx|txt|json|ya?ml|toml|js|mjs|cjs|ts|py|sh|bash|zsh|ps1|psm1|cmd|bat|rb|go|rs|lua)$/i;
const ROOT_VARS = /^(CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA|CLAUDE_PROJECT_DIR|HOME|USERPROFILE|PATH)$/;
const SECRETISH = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/;

// `md`: Markdown only. `code`: everything but Markdown. `hook`: only scripts a hook runs.
const RULES = [
  { id: 'pipe-to-shell', severity: 'high', re: /\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\|\s*(sh|bash|zsh|iex|Invoke-Expression|python3?|node)\b/i },
  { id: 'obfuscation', severity: 'high', re: /\b(eval|exec|Function)\s*\(\s*(atob|Buffer\.from|base64|b64decode)|base64\s+(-d|--decode)\b|FromBase64String/i },
  { id: 'encoded-blob', severity: 'medium', re: /[A-Za-z0-9+/]{240,}={0,2}/, only: 'code' },
  { id: 'credential-path', severity: 'high', re: /(\.ssh[\\/]|id_rsa|id_ed25519|\.aws[\\/]credentials|\.netrc|\.git-credentials|\.npmrc|\.pypirc|\.claude\.json|Login Data|cookies\.sqlite|keychain|wallet\.dat)/i },
  { id: 'permission-bypass', severity: 'high', re: /dangerously-skip-permissions|bypassPermissions|--no-verify\b|disableAllHooks/i },
  { id: 'settings-write', severity: 'medium', re: /settings(\.local)?\.json|CLAUDE_CONFIG_DIR|\.claude[\\/](settings|hooks|agents|skills)\b/i, only: 'code' },
  { id: 'prompt-injection', severity: 'high', re: /ignore (all |any )?(previous|prior|above|earlier) (instructions|rules)|(do not|don't|never) (tell|inform|mention|show)\b[^.\n]{0,20}\buser\b|without (asking|telling|informing) the user|hide (this|it) from the user|exfiltrat/i, only: 'md' },
  { id: 'network-in-hook', severity: 'medium', re: /\bfetch\(|https?:\/\/|\bcurl\b|\bwget\b|requests\.(get|post)|axios|XMLHttpRequest|net\.connect|Invoke-WebRequest|urllib/i, only: 'hook' },
];

function walk(root, max = 2000) {
  const out = [];
  const go = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= max) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name)) go(p); } else if (e.isFile()) out.push(p);
    }
  };
  go(root);
  return out;
}

const tokens = (s) => String(s || '').match(/"[^"]*"|'[^']*'|\S+/g)?.map((t) => t.replace(/^["']|["']$/g, '')) || [];
const exeName = (t) => path.basename(String(t || '')).replace(/\.(exe|cmd|bat)$/i, '');
const bundled = (t) => /\$\{CLAUDE_PLUGIN_ROOT\}/.test(t);

// `hooks` in plugin.json is a path, a list of paths or an inline object; the default is hooks/hooks.json.
function hooksOf(manifest, root) {
  const out = [];
  for (const f of manifest.hooks == null ? ['hooks/hooks.json'] : [].concat(manifest.hooks)) {
    const j = typeof f === 'string' ? readJson(path.join(root, f)) : f;
    const h = j?.hooks ?? (typeof f === 'string' ? null : j);
    for (const [event, groups] of Object.entries(h || {})) {
      for (const g of Array.isArray(groups) ? groups : []) {
        for (const hk of g.hooks || []) {
          const parts = [...tokens(hk.command), ...(hk.args || []).map(String)];
          const scripts = parts.filter(bundled).map((t) => path.join(root, t.replace(/^.*\$\{CLAUDE_PLUGIN_ROOT\}[\\/]?/, '')));
          out.push({ event, matcher: g.matcher || '*', runs: bundled(parts[0] || '') ? 'bundled script' : exeName(parts[0]) || hk.type, exe: bundled(parts[0] || '') ? null : exeName(parts[0]), scripts });
        }
      }
    }
  }
  return out;
}

// Names only: an MCP definition's values (env, args, URL path) are where tokens live.
function mcpOf(manifest, root) {
  let v = manifest.mcpServers ?? '.mcp.json';
  if (typeof v === 'string') { const j = readJson(path.join(root, v)); v = j?.mcpServers ?? j; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return [];
  return Object.entries(v).map(([name, def]) => {
    const refs = [...JSON.stringify(def || {}).matchAll(/\$\{([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]).filter((n) => !ROOT_VARS.test(n));
    let host = null;
    try { if (def?.url) host = new URL(String(def.url).replace(/\$\{[^}]*\}/g, 'x')).host; } catch { host = 'remote'; }
    return { name, transport: def?.url ? `${def.type || 'http'} ${host}` : `stdio ${bundled(def?.command || '') ? 'bundled' : exeName(def?.command)}`, exe: def?.url || bundled(def?.command || '') ? null : exeName(def?.command), env: [...new Set([...Object.keys(def?.env || {}), ...refs])] };
  });
}

function which(exe, env = process.env) {
  if (!exe) return null;
  const exts = process.platform === 'win32' ? ['', ...(env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase())] : [''];
  for (const dir of (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) { const f = path.join(dir, exe + ext); try { if (fs.statSync(f).isFile()) return f; } catch { /* next */ } }
  }
  return null;
}

const STOP = new Set('this that with when from your their them they have will what which into used uses using about only also more than then such each like make made code file files skill skills plugin claude user users task tasks work works should must need needs before after'.split(' '));
const words = (s) => new Set((String(s || '').toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) || []).filter((w) => !STOP.has(w)));
function similarity(a, b) {
  const [x, y] = [words(a), words(b)];
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

// What the target is. A marketplace is scanned through the plugins it holds in its own repo.
function describe(root) {
  const manifest = readJson(path.join(root, '.claude-plugin', 'plugin.json'));
  const market = readJson(path.join(root, '.claude-plugin', 'marketplace.json'));
  const skill = fs.existsSync(path.join(root, 'SKILL.md')) ? frontmatter(fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8')) : null;
  if (manifest || (market && !skill)) {
    const m = manifest || {};
    const plugins = manifest ? [{ root, manifest: m }] : (market.plugins || [])
      .filter((e) => typeof e.source === 'string')
      .map((e) => { const r = path.join(root, e.source); return { root: r, manifest: readJson(path.join(r, '.claude-plugin', 'plugin.json')) || { name: e.name, description: e.description } }; });
    const parts = plugins.map(({ root: r, manifest: pm }) => ({
      name: pm.name, version: pm.version || null, description: pm.description || '',
      skills: [...skillsIn(path.join(r, 'skills')), ...mdIn(path.join(r, 'commands'))].map((s) => ({ name: s.name, description: s.description })),
      agents: mdIn(path.join(r, 'agents')).map((a) => a.name),
      hooks: hooksOf(pm, r), mcp: mcpOf(pm, r),
      userConfig: Object.entries(pm.userConfig || {}).map(([key, c]) => ({ key, required: Boolean(c?.required), sensitive: Boolean(c?.sensitive) })),
      bin: fs.existsSync(path.join(r, 'bin')),
    }));
    return { kind: manifest ? 'plugin' : 'marketplace', name: m.name || market?.name || path.basename(root), plugins: parts, skills: [] };
  }
  if (skill) return { kind: 'skill', name: skill.name || path.basename(root), plugins: [], skills: [{ name: skill.name || path.basename(root), description: skill.description || '' }] };
  const found = walk(root).filter((f) => path.basename(f) === 'SKILL.md').slice(0, 200).map((f) => {
    const fm = frontmatter(fs.readFileSync(f, 'utf8'));
    return { name: fm.name || path.basename(path.dirname(f)), description: fm.description || '' };
  });
  return { kind: found.length ? 'skills' : 'unknown', name: path.basename(root), plugins: [], skills: found };
}

function flagsIn(root, hookScripts) {
  const hooks = new Set(hookScripts.map((s) => path.resolve(s).toLowerCase()));
  const out = [];
  const count = new Map();
  for (const f of walk(root)) {
    if (!TEXT.test(f) && !hooks.has(path.resolve(f).toLowerCase())) continue;
    let text;
    try { if (fs.statSync(f).size > 1_000_000) continue; text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const md = /\.mdx?$/i.test(f);
    const isHook = hooks.has(path.resolve(f).toLowerCase());
    text.split(/\r?\n/).forEach((line, i) => {
      for (const r of RULES) {
        if ((r.only === 'md' && !md) || (r.only === 'code' && md) || (r.only === 'hook' && !isHook)) continue;
        if (!r.re.test(line) || (count.get(r.id) || 0) >= 10) continue; // ten per rule is enough to judge
        count.set(r.id, (count.get(r.id) || 0) + 1);
        out.push({ rule: r.id, severity: r.severity, file: fwd(path.relative(root, f)), line: i + 1, text: line.trim().slice(0, 140) });
      }
    });
  }
  return out;
}

function skillspector(root, run, exe) {
  if (!exe) return { missing: true, install: 'uv tool install git+https://github.com/NVIDIA/skillspector.git' };
  const r = run(exe, ['scan', root, '--no-llm', '--format', 'json'], 300000);
  let j;
  try { j = JSON.parse(r.stdout); } catch { return { error: (r.stderr || r.error || `exit ${r.status}`).toString().trim().slice(0, 300) }; }
  const issues = j.issues || [];
  const bySeverity = {};
  for (const i of issues) bySeverity[i.severity] = (bySeverity[i.severity] || 0) + 1;
  return {
    version: j.metadata?.skillspector_version || null, ...j.risk_assessment, bySeverity,
    top: issues.filter((i) => /^(CRITICAL|HIGH)$/i.test(i.severity)).slice(0, 20)
      .map((i) => ({ id: i.id, category: i.category, severity: i.severity, file: i.location?.file, line: i.location?.start_line, message: [i.pattern, i.finding].filter(Boolean).join(': ').replace(/\s+/g, ' ').slice(0, 200), why: String(i.explanation || '').slice(0, 300) })),
  };
}

function validate(root, run, exe) {
  if (!exe) return null;
  const r = run(exe, ['plugin', 'validate', '--json', root], 60000);
  let report = null;
  try { report = JSON.parse(r.stdout); } catch { /* keep the exit status only */ }
  return { ok: r.status === 0, status: r.status, report };
}

const runProcess = (exe, args, timeout) => spawnSync(exe, args, { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });

export function scan(target, { things = [], env = process.env, external = true, run = runProcess, find = which } = {}) {
  let root = path.resolve(target);
  if (fs.existsSync(root) && fs.statSync(root).isFile()) root = path.dirname(root);
  if (!fs.existsSync(root)) throw new Error(`${fwd(root)} does not exist`);
  const d = describe(root);

  // Collisions with what this profile has. Plugin skills, agents and MCP servers are namespaced by their
  // plugin, so for a plugin only its own name and its hook events can clash.
  const installed = (kind) => things.filter((t) => t.kind === kind);
  const collisions = [];
  for (const p of d.plugins) {
    const same = installed('plugin').filter((t) => t.name.split('@')[0] === p.name).map((t) => t.id);
    if (same.length) collisions.push({ what: `plugin name ${p.name}`, with: same });
    for (const h of p.hooks) {
      const also = [
        ...installed('plugin').filter((t) => t.enabled && t.components?.hooks?.includes(h.event) && t.name.split('@')[0] !== p.name).map((t) => t.id),
        ...installed('hook').filter((t) => t.name === h.event).map((t) => t.id),
      ];
      if (also.length && !collisions.some((c) => c.what === `hook ${h.event}`)) collisions.push({ what: `hook ${h.event}`, with: also });
    }
  }
  for (const s of d.skills) {
    const same = installed('skill').filter((t) => t.name === s.name).map((t) => t.id);
    if (same.length) collisions.push({ what: `skill name ${s.name}`, with: same });
  }

  // What it needs: keys and executables.
  const keys = new Map();
  const need = (name, why) => keys.set(name, [...new Set([...(keys.get(name) || []), why])]);
  for (const p of d.plugins) {
    for (const c of p.userConfig) need(c.key, `userConfig${c.required ? ', required' : ''}${c.sensitive ? ', sensitive' : ''}`);
    for (const m of p.mcp) for (const e of m.env) need(e, `MCP server ${m.name}`);
  }
  for (const f of walk(root)) {
    if (!TEXT.test(f) || /\.mdx?$/i.test(f)) continue;
    let text = '';
    try { if (fs.statSync(f).size <= 1_000_000) text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)|process\.env\[['"]([A-Z_][A-Z0-9_]*)['"]\]|os\.environ(?:\.get\(|\[)\s*['"]([A-Z_][A-Z0-9_]*)['"]|getenv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g)) {
      const name = m[1] || m[2] || m[3] || m[4];
      if (SECRETISH.test(name)) need(name, `read in ${fwd(path.relative(root, f))}`);
    }
  }
  const exes = new Set(d.plugins.flatMap((p) => [...p.hooks.map((h) => h.exe), ...p.mcp.map((m) => m.exe)]).filter(Boolean));
  const binaries = [...exes].map((exe) => ({ exe, found: Boolean(find(exe, env)) }));

  // Installed things that do much the same job.
  const pool = things.filter((t) => (t.kind === 'skill' || t.kind === 'plugin') && t.description);
  const similar = [];
  for (const s of [...d.skills, ...d.plugins]) {
    for (const t of pool) {
      if (t.name.split('@')[0] === s.name) continue;
      const score = similarity(`${s.name} ${s.description}`, `${t.name} ${t.description}`);
      if (score >= 0.12) similar.push({ target: s.name, installed: t.id, score: Math.round(score * 100) / 100 });
    }
  }
  similar.sort((a, b) => b.score - a.score);

  const hookScripts = d.plugins.flatMap((p) => p.hooks.flatMap((h) => h.scripts));
  return {
    target: fwd(root), ...d, collisions,
    needs: { keys: [...keys].map(([name, why]) => ({ name, why })), binaries },
    similar: similar.slice(0, 5),
    flags: flagsIn(root, hookScripts),
    validate: external && d.plugins.length ? validate(root, run, find('claude', env)) : null,
    skillspector: external ? skillspector(root, run, find('skillspector', env)) : null,
  };
}

export function report(r) {
  const out = [`scan: ${r.kind} \`${r.name}\` at ${r.target}`];
  for (const p of r.plugins) {
    const adds = [];
    if (p.skills.length) adds.push(`${p.skills.length} skill(s): ${p.skills.map((s) => s.name).join(', ')}`);
    if (p.agents.length) adds.push(`agents: ${p.agents.join(', ')}`);
    if (p.hooks.length) adds.push(`hooks: ${[...new Set(p.hooks.map((h) => `${h.event}(${h.matcher}) runs ${h.runs}`))].join(', ')}`);
    if (p.mcp.length) adds.push(`MCP: ${p.mcp.map((m) => `${m.name} (${m.transport})`).join(', ')}`);
    if (p.bin) adds.push('a bin/ folder on the PATH');
    out.push(`plugin ${p.name}${p.version ? ` v${p.version}` : ''} adds ${adds.join('; ') || 'nothing that loads'}`);
  }
  if (!r.plugins.length && r.skills.length) out.push(`skills: ${r.skills.map((s) => s.name).join(', ')}`);
  out.push(r.collisions.length ? `collisions: ${r.collisions.map((c) => `${c.what} with ${c.with.join(', ')}`).join('; ')}` : 'collisions: none');
  const missing = r.needs.binaries.filter((b) => !b.found).map((b) => b.exe);
  out.push(`needs: ${r.needs.keys.length ? `keys ${r.needs.keys.map((k) => `${k.name} (${k.why.join('; ')})`).join(', ')}` : 'no keys'}${missing.length ? `; not on PATH: ${missing.join(', ')}` : ''}`);
  if (r.similar.length) out.push(`similar to installed: ${r.similar.map((s) => `${s.target} ~ ${s.installed} (${s.score})`).join(', ')}`);
  out.push(`flags: ${r.flags.length || 'none'}`);
  for (const f of r.flags) out.push(`  [${f.severity}] ${f.rule} ${f.file}:${f.line}  ${f.text}`);
  if (r.validate) out.push(`claude plugin validate: ${r.validate.ok ? 'passed' : `failed (exit ${r.validate.status})`}`);
  const s = r.skillspector;
  if (s?.missing) out.push(`skillspector: not installed (${s.install})`);
  else if (s?.error) out.push(`skillspector: failed: ${s.error}`);
  else if (s) {
    out.push(`skillspector ${s.version || ''}: score ${s.score}, ${s.severity}, ${s.recommendation}; ${Object.entries(s.bySeverity).map(([k, v]) => `${v} ${k}`).join(', ') || 'no issues'}`);
    for (const i of s.top) out.push(`  [${i.severity}] ${i.id} ${i.file}:${i.line}  ${i.message}`);
  }
  return out.join('\n');
}
