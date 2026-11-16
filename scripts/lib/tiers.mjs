// SKILLSET.md: three tier sections, one list item per thing. The scripts read only the backticked
// id and the section it sits in; the rest of each line is for people and agents.
import fs from 'node:fs';
import path from 'node:path';
import { oneLine, readJson } from './inventory.mjs';

export const FILE = 'SKILLSET.md';
export const TIERS = ['essential', 'useful', 'informative'];
// Kinds a tier can be chosen for. Hooks are listed for information; connectors and built-in
// skills are added by hand because nothing on disk describes them.
export const TIERABLE = new Set(['skill', 'plugin', 'mcp', 'agent']);

const HEAD = /^##\s+(essential|useful|informative)\b/i;
const ITEM = /^\s*[-*]\s+`([a-z-]+:[^`]+)`\s*(?:[—–-]+\s*)?(.*)$/;
const SKILL_STATE = { essential: 'on', useful: 'name-only', informative: 'off' };
const title = (tier) => tier[0].toUpperCase() + tier.slice(1);
const fwd = (p) => String(p).replace(/\\/g, '/');
export const split = (id) => { const i = id.indexOf(':'); return [id.slice(0, i), id.slice(i + 1)]; };

export function parse(text) {
  const lines = text.split(/\r?\n/);
  const items = [];
  const seen = new Set();
  let tier = null;
  lines.forEach((line, i) => {
    const h = HEAD.exec(line);
    if (h) { tier = h[1].toLowerCase(); return; }
    if (/^#{1,2}\s/.test(line)) { tier = null; return; } // any other top-level heading ends the tier
    const m = tier && ITEM.exec(line);
    if (!m || seen.has(m[1].trim())) return; // a repeated id keeps its first tier
    seen.add(m[1].trim());
    items.push({ id: m[1].trim(), tier, text: m[2].trim(), line: i });
  });
  return { items, lines, eol: text.includes('\r\n') ? '\r\n' : '\n' };
}

function useHint(t) {
  if (t.kind === 'skill') return `invoke \`${t.name}\``;
  if (t.kind === 'mcp') return `tools \`mcp__${t.name}__*\``;
  if (t.kind === 'agent') return `Agent type \`${t.name}\``;
  if (t.kind === 'hook') return 'runs automatically';
  const c = t.components || {};
  const parts = [];
  if (c.skills?.length) parts.push(`skills ${c.skills.slice(0, 6).join(', ')}${c.skills.length > 6 ? ` and ${c.skills.length - 6} more` : ''}`);
  if (c.agents?.length) parts.push(`agents ${c.agents.join(', ')}`);
  if (c.mcp?.length) parts.push(`MCP server ${c.mcp.join(', ')}`);
  if (c.hooks?.length) parts.push(`hooks on ${c.hooks.join(', ')}`);
  return parts.join('; ') || 'see its README';
}

export function itemLine(t, tier) {
  const parts = [`- \`${t.id}\` — ${oneLine(t.description, tier === 'informative' ? 100 : 160) || 'No description'}`];
  if (t.source) parts.push(`Source: ${t.source}`);
  if (tier !== 'informative' && t.kind) {
    parts.push(`Use: ${useHint(t)}`, `Config: ${t.scope} scope${t.version ? `, v${t.version}` : ''}`);
  }
  return parts.join(' · ');
}

const NOTES = {
  essential: 'Loaded in every session of this project.',
  useful: 'Not loaded up front. Pulled in when a task calls for it.',
  informative: 'Installed on this machine and profile, switched off for this project. This section is regenerated per machine.',
};

export function render({ scope, tiers, things }) {
  const byId = new Map(things.map((t) => [t.id, t]));
  const out = [
    '# Skill set', '',
    `Scope: ${scope || '(what this project is for)'}`, '',
    'The Claude Code skills, plugins, MCP servers and agents for this project, in three tiers. The skillset plugin',
    'applies them at every session start. To re-tier something, move its line to another section or run `/skillset-update`.', '',
  ];
  for (const tier of TIERS) {
    out.push(`## ${title(tier)}`, '', NOTES[tier], '', ...(tiers[tier] || []).map((id) => itemLine(byId.get(id) || { id }, tier)), '');
  }
  return out.join('\n');
}

// Moves an item to a tier, or drops it with tier 'none'. `newLine` is used when the id has no line yet.
export function setTier(text, id, tier, newLine) {
  const { items, lines, eol } = parse(text);
  const cur = items.find((i) => i.id === id);
  let line = newLine;
  if (cur) { line = lines[cur.line]; lines.splice(cur.line, 1); }
  if (tier !== 'none') {
    if (!line) throw new Error(`no line for ${id}`);
    const now = parse(lines.join('\n'));
    const last = now.items.filter((i) => i.tier === tier).pop();
    const head = lines.findIndex((l) => HEAD.exec(l)?.[1].toLowerCase() === tier);
    if (last) lines.splice(last.line + 1, 0, line);
    else if (head >= 0) lines.splice(head + 1, 0, '', line);
    else {
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      lines.push('', `## ${title(tier)}`, '', line, '');
    }
  }
  return lines.join(eol);
}

// Moves ids to a tier ('none' drops their lines) and applies the result. The CLI and the status page both
// come through here. Every id is checked before the file is written, so a bad id changes nothing.
export function moveItems(projectDir, tier, ids, things) {
  if (![...TIERS, 'none'].includes(tier) || !ids.length) throw new Error('usage: move <essential|useful|informative|none> <id> [<id>...]');
  const file = path.join(projectDir, FILE);
  let text = fs.readFileSync(file, 'utf8');
  const have = new Set(parse(text).items.map((i) => i.id));
  for (const id of ids) {
    if (split(id)[0] === 'hook' && tier !== 'none') throw new Error(`${id}: a hook has no switch of its own; it follows its plugin or settings file.`);
    const t = things.find((x) => x.id === id);
    if (!have.has(id) && !t && tier !== 'none' && !/^(builtin|connector):./.test(id)) throw new Error(`${id} is not installed and has no line in ${FILE}. Run \`inventory\` for the ids.`);
    text = setTier(text, id, tier, itemLine(t || { id }, tier));
  }
  fs.writeFileSync(file, text);
  return apply(projectDir, parse(text).items, tier === 'none' ? ids : []);
}

// The settings each tier turns into. Only switches the docs describe are written here.
export function desired(items, projectMcp = new Set()) {
  const d = { skillOverrides: {}, enabledPlugins: {}, mcpOff: [], mcpOn: [], unenforced: [] };
  for (const it of items) {
    const [kind, name] = split(it.id);
    if (kind === 'skill' || kind === 'builtin') d.skillOverrides[name] = SKILL_STATE[it.tier];
    else if (kind === 'plugin') { if (!name.startsWith('skillset@')) d.enabledPlugins[name] = it.tier === 'essential'; } // never switch ourselves off
    else if (kind === 'mcp' && projectMcp.has(name)) (it.tier === 'informative' ? d.mcpOff : d.mcpOn).push(name);
    else if (it.tier === 'informative' && kind !== 'hook') d.unenforced.push(it.id); // no documented per-project switch
  }
  return d;
}

// Writes the tiers into the project's .claude/settings.local.json. Touches only the entries of
// things listed in SKILLSET.md (plus `drop`, ids that were just removed from it); idempotent.
export function apply(projectDir, items, drop = []) {
  const file = path.join(projectDir, '.claude', 'settings.local.json');
  let cur = {};
  if (fs.existsSync(file)) {
    cur = readJson(file);
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return { changes: [], unenforced: [], error: `${fwd(file)} is not valid JSON, so it was left untouched` };
  }
  const projectMcp = new Set(Object.keys(readJson(path.join(projectDir, '.mcp.json'))?.mcpServers || {}));
  const d = desired(items, projectMcp);
  const next = structuredClone(cur);
  const changes = [];
  const change = (kind, name, from, to) => changes.push({ kind, name, from, to });
  const setAll = (key, want, kind, word, unset) => {
    for (const [name, v] of Object.entries(want)) {
      const was = cur[key]?.[name];
      if (was === v) continue;
      (next[key] ||= {})[name] = v;
      if ((was ?? unset) !== v) change(kind, name, word(was ?? unset), word(v)); // writing an explicit default is not news
    }
  };
  setAll('skillOverrides', d.skillOverrides, 'skill', (v) => v, 'on');
  setAll('enabledPlugins', d.enabledPlugins, 'plugin', (v) => (v ? 'enabled' : 'disabled'), true);

  const off = new Set(Array.isArray(cur.disabledMcpjsonServers) ? cur.disabledMcpjsonServers : []);
  for (const n of d.mcpOff) if (!off.has(n)) { off.add(n); change('mcp', n, 'enabled', 'disabled'); }
  for (const n of d.mcpOn) if (off.delete(n)) change('mcp', n, 'disabled', 'enabled');

  for (const id of drop) {
    const [kind, name] = split(id);
    const key = kind === 'plugin' ? 'enabledPlugins' : kind === 'skill' || kind === 'builtin' ? 'skillOverrides' : null;
    if (key && next[key] && name in next[key]) { delete next[key][name]; change(kind, name, 'managed', 'unmanaged'); }
    if (kind === 'mcp' && off.delete(name)) change('mcp', name, 'managed', 'unmanaged');
  }
  if (off.size) next.disabledMcpjsonServers = [...off]; else delete next.disabledMcpjsonServers;

  const wrote = JSON.stringify(next) !== JSON.stringify(cur);
  if (wrote) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`; // Claude Code watches this file, so swap it in whole
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    fs.renameSync(tmp, file);
  }
  return { changes, wrote, unenforced: d.unenforced, reload: changes.some((c) => c.kind === 'plugin') };
}

// One line per kind of change, so sixty skills going off read as one line.
export function summarize(changes) {
  const groups = new Map();
  for (const c of changes) {
    const key = `${c.kind}: ${c.from} → ${c.to}`;
    groups.set(key, [...(groups.get(key) || []), c.name]);
  }
  return [...groups].map(([key, list]) => `${key} (${list.length}): ${list.slice(0, 6).join(', ')}${list.length > 6 ? ` and ${list.length - 6} more` : ''}`);
}

export function reconcile(items, things) {
  const listed = new Set(items.map((i) => i.id));
  const installed = new Set(things.map((t) => t.id));
  return {
    untiered: things.filter((t) => TIERABLE.has(t.kind) && !listed.has(t.id) && !t.id.startsWith('plugin:skillset@')).map((t) => t.id),
    missing: items.filter((i) => TIERABLE.has(split(i.id)[0]) && !installed.has(i.id)).map((i) => i.id),
  };
}

export const lead = (text) => text.split(/ · (?:Source|Use|Config):/)[0].trim();
const sentence = (s) => (/[.!?…]$/.test(s) ? s : `${s}.`);
const names = (ids, max = 8) => ids.slice(0, max).map((i) => `\`${i}\``).join(', ') + (ids.length > max ? ` and ${ids.length - max} more` : '');

function usefulLine(item, t) {
  const [kind, name] = split(item.id);
  const what = sentence(lead(item.text) || oneLine(t?.description, 120) || 'no description');
  if (kind === 'skill' || kind === 'builtin') return `skill \`${name}\`: ${what}`;
  if (kind === 'mcp') return `MCP server \`${name}\`: ${what} Its tools are deferred; load them with ToolSearch.`;
  if (kind === 'agent') return `agent \`${name}\`: ${what}`;
  if (kind !== 'plugin') return `\`${item.id}\`: ${what}`;
  const skills = t?.components?.skills?.length ? ` Skills: ${t.components.skills.slice(0, 8).join(', ')}.` : '';
  const read = t?.instructionOnly ? ` Usable right now by reading a SKILL.md under ${fwd(t.path)}/skills/.` : '';
  return `plugin \`${name}\` (off here): ${what}${skills}${read}`;
}

// What the SessionStart hook tells the model. Claude Code caps hook output at 10,000 characters.
export function digest({ items, things, applied = { changes: [] }, updates = [], cap = 4000 }) {
  const byId = new Map(things.map((t) => [t.id, t]));
  const useful = items.filter((i) => i.tier === 'useful');
  const off = items.filter((i) => i.tier === 'informative').length;
  const drift = reconcile(items, things);
  const build = (brief) => {
    const out = ['skillset: this project tiers its Claude Code stack in SKILLSET.md. Essential items are loaded.'];
    if (useful.length) {
      out.push('Useful tier, not loaded up front. Pull one in when a task calls for it:');
      if (brief) out.push(`${names(useful.map((u) => u.id), 60)}. Each has a one-line description in SKILLSET.md.`);
      else for (const u of useful) out.push(`- ${usefulLine(u, byId.get(u.id))}`);
      if (useful.some((u) => u.id.startsWith('plugin:'))) out.push('To load an off plugin: `claude plugin enable <id> --scope local`, then ask the user to run /reload-plugins.');
    }
    if (off) out.push(`Informative tier: ${off} more installed things are kept out of this project. Check SKILLSET.md before telling the user a capability is missing.`);
    if (drift.untiered.length) out.push(`Installed but not in SKILLSET.md yet: ${names(drift.untiered)}. Offer /skillset-update to tier them.`);
    if (drift.missing.length) out.push(`Listed in SKILLSET.md but not installed in this profile: ${names(drift.missing)}. Offer /skillset-update to reinstall or drop them.`);
    if (updates.length) out.push(`Updates available upstream: ${names(updates.map((u) => `${u.id} ${u.installed} → ${u.latest}`), 5)}. Offer /skillset-update to review them.`);
    if (applied.error) out.push(`skillset could not apply the tiers: ${applied.error}.`);
    else if (applied.changes?.length) out.push(`Re-applied ${applied.changes.length} tier setting(s) from SKILLSET.md.${applied.reload ? ' Plugin changes take effect after /reload-plugins or in a new session.' : ''}`);
    return out.join('\n') + '\n';
  };
  const full = build(false);
  return full.length <= cap ? full : build(true);
}
