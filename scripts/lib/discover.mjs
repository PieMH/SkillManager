// Discovery: candidates for a job, from four public sources. It installs nothing and judges nothing:
// /skillmanager-update filters the candidates by the project's scope and sends the promising ones through `scan`.
// The search words leave the machine (SkillsMP, GitHub); the marketplace list is read through the local CLI.
import { spawnSync } from 'node:child_process';
import { oneLine } from './inventory.mjs';
import { which } from './scan.mjs';

const UA = { 'User-Agent': 'skillmanager-plugin' };
const STOP = new Set('the and for with from that this into your skill skills plugin plugins claude code agent agents'.split(' '));
export const terms = (q) => [...new Set(String(q || '').toLowerCase().match(/[a-z0-9][a-z0-9+#.]{2,}/g) || [])].filter((w) => !STOP.has(w));
const hits = (words, text) => { const t = String(text || '').toLowerCase(); return words.filter((w) => t.includes(w)).length; };
const base = (name) => String(name).split('@')[0].split('/').pop().replace(/^anthropic-skills:/, '').toLowerCase();

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
async function getText(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Network and the claude CLI, swappable in tests.
export const live = {
  getJson,
  getText,
  plugins(env = process.env) {
    const exe = which('claude', env);
    if (!exe) throw new Error('the claude CLI is not on the PATH');
    // The arguments are fixed, so a .cmd shim can go through the shell without quoting risk.
    const r = spawnSync(exe, ['plugin', 'list', '--json', '--available'], { encoding: 'utf8', timeout: 90000, windowsHide: true, maxBuffer: 64 * 1024 * 1024, shell: /\.(cmd|bat)$/i.test(exe) });
    if (r.status !== 0) throw new Error('`claude plugin list --available` failed');
    return JSON.parse(r.stdout).available || [];
  },
};

// A multi-word query needs two of its words to match, so "database migrations" skips every page about databases.
const enough = (words) => Math.min(2, words.length);

// The first of each key wins, so sort before calling.
const once = (list, key) => { const seen = new Set(); return list.filter((x) => !seen.has(key(x)) && seen.add(key(x))); };

function marketplaces(words, io, limit) {
  const ranked = io.plugins()
    .map((p) => ({ p, s: hits(words, `${p.name} ${p.description}`) }))
    .filter((x) => x.s >= enough(words))
    .sort((a, b) => b.s - a.s || (b.p.installCount || 0) - (a.p.installCount || 0));
  return once(ranked, (x) => x.p.name) // the same plugin listed by two marketplaces: keep the most installed
    .slice(0, limit)
    .map(({ p }) => ({ source: 'marketplace', kind: 'plugin', name: p.pluginId, description: oneLine(p.description, 160), popularity: p.installCount ? `${p.installCount.toLocaleString('en')} installs` : null, install: `claude plugin install ${p.pluginId}` }));
}

// Its search is loose (a query for migrations returns a Notion archiver), so the same word rule applies.
async function skillsmp(words, io, limit) {
  const j = await io.getJson(`https://skillsmp.com/api/v1/skills/search?q=${encodeURIComponent(words.join(' '))}`);
  const all = (j?.data?.skills || []).filter((s) => hits(words, `${s.name} ${s.description}`) >= enough(words));
  const en = all.filter((s) => !s.contentLanguage || s.contentLanguage === 'en'); // the same skill comes back once per translation
  return once(en.length ? en : all, (s) => `${s.author}/${s.name}`).slice(0, limit)
    .map((s) => ({ source: 'skillsmp', kind: 'skill', name: s.name, description: oneLine(s.description, 160), popularity: s.stars ? `${s.stars.toLocaleString('en')} stars on ${s.author || 'its'} repo` : null, url: s.githubUrl || s.skillUrl }));
}

// shortcut: one topic (claude-skills); add agent-skills or claude-code-plugin if results run thin.
async function github(words, io, limit) {
  const q = encodeURIComponent(`${words.join(' ')} topic:claude-skills`);
  const j = await io.getJson(`https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=${limit}`, { Accept: 'application/vnd.github+json' });
  return (j.items || []).map((r) => ({ source: 'github', kind: 'repo', name: r.full_name, description: oneLine(r.description, 160), popularity: `${r.stargazers_count.toLocaleString('en')} stars, pushed ${String(r.pushed_at || '').slice(0, 10)}`, url: r.html_url }));
}

// skillsllm.com has no API (robots.txt closes /api/); its sitemap lists every skill page by slug.
async function skillsllm(words, io, limit) {
  const xml = await io.getText('https://skillsllm.com/sitemap.xml');
  return [...xml.matchAll(/<loc>(https:\/\/skillsllm\.com\/skill\/([^<]+))<\/loc>/g)]
    .map(([, url, slug]) => ({ url, slug, s: hits(words, slug.replace(/[-_]/g, ' ')) }))
    .filter((x) => x.s >= enough(words))
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(({ url, slug }) => ({ source: 'skillsllm', kind: 'skill', name: decodeURIComponent(slug), description: null, popularity: null, url }));
}

export async function discover(query, { things = [], io = live, limit = 6, env = process.env } = {}) {
  const words = terms(query);
  if (!words.length) throw new Error('describe the job in a few words, for example "database migrations"');
  const have = new Set(things.filter((t) => t.kind === 'skill' || t.kind === 'plugin').map((t) => base(t.name)));
  const errors = [];
  const from = async (name, fn) => { try { return await fn(); } catch (err) { errors.push(`${name}: ${err.message}`); return []; } };
  const lists = await Promise.all([
    from('marketplaces', () => marketplaces(words, { ...io, plugins: () => io.plugins(env) }, limit)),
    from('skillsmp', () => skillsmp(words, io, limit)),
    from('github', () => github(words, io, limit)),
    from('skillsllm', () => skillsllm(words, io, limit)),
  ]);
  return { query: words.join(' '), candidates: lists.flat().map((c) => ({ ...c, installed: have.has(base(c.name)) })), errors };
}

const SOURCES = { marketplace: 'Your marketplaces', skillsmp: 'SkillsMP', github: 'GitHub, topic claude-skills', skillsllm: 'skillsllm.com' };
export function report(r) {
  const out = [`discover: "${r.query}"`];
  for (const [key, title] of Object.entries(SOURCES)) {
    const list = r.candidates.filter((c) => c.source === key);
    if (!list.length) continue;
    out.push('', `${title}:`);
    for (const c of list) out.push(`- ${c.name}${c.installed ? ' (installed)' : ''}${c.description ? ` — ${c.description}` : ''}${c.popularity ? ` · ${c.popularity}` : ''} · ${c.install || c.url}`);
  }
  if (!r.candidates.length) out.push('No candidates. Try other words for the job.');
  if (r.errors.length) out.push('', `Not searched: ${r.errors.join('; ')}`);
  return out.join('\n');
}
