#!/usr/bin/env node
// skillset CLI: the deterministic half of the plugin. The skills call it; nothing here needs a model.
import fs from 'node:fs';
import path from 'node:path';
import { inventory, oneLine } from './lib/inventory.mjs';
import { FILE, TIERABLE, TIERS, apply, digest, itemLine, parse, reconcile, render, setTier, split, summarize } from './lib/tiers.mjs';
import { dismiss } from './lib/session.mjs';

const USAGE = `usage: skillset <command> [--project <dir>] [--json]
  inventory                       everything installed for this profile and project
  init --essential a,b --useful c writes SKILLSET.md (the rest goes to informative) and applies it; --force to overwrite
  move <tier> <id> [<id>...]      tier: essential | useful | informative | none (none drops the line)
  apply                           writes the tiers into .claude/settings.local.json
  status                          tiers, drift and settings that are out of step
  digest                          what the SessionStart hook prints
  dismiss                         stop offering configuration in this project`;

const argv = process.argv.slice(2);
const flags = {};
const args = [];
for (let i = 0; i < argv.length; i++) {
  const m = /^--([\w-]+)(?:=(.*))?$/.exec(argv[i]);
  if (!m) args.push(argv[i]);
  else if (m[2] !== undefined) flags[m[1]] = m[2];
  else if (['json', 'force'].includes(m[1]) || argv[i + 1] === undefined) flags[m[1]] = true;
  else flags[m[1]] = argv[++i];
}
const [cmd, ...rest] = args;
const projectDir = path.resolve(flags.project || process.env.CLAUDE_PROJECT_DIR || process.cwd());
const file = path.join(projectDir, FILE);
const fail = (msg) => { console.error(`skillset: ${msg}`); process.exit(1); };
const print = (data, text) => console.log(flags.json ? JSON.stringify(data, null, 2) : text);
const readFile = () => { try { return fs.readFileSync(file, 'utf8'); } catch { return fail(`no ${FILE} in ${projectDir}. Run /skillset-configure first.`); } };

function applied(res) {
  const out = [];
  if (res.error) out.push(`NOT APPLIED: ${res.error}`);
  for (const line of summarize(res.changes)) out.push(`  ${line}`);
  if (!res.error && !res.changes.length) out.push('  settings already match');
  if (res.reload) out.push('Plugin changes take effect after /reload-plugins or in a new session.');
  if (res.unenforced.length) out.push(`Recorded as informative but not switched off (Claude Code documents no per-project switch for them): ${res.unenforced.join(', ')}`);
  return out.join('\n');
}

function describe(t) {
  const meta = [t.scope];
  if (t.kind === 'plugin') {
    meta.push(t.enabled ? 'enabled' : 'disabled');
    if (t.version) meta.push(`v${t.version}`);
    const c = t.components;
    if (c.skills.length) meta.push(`${c.skills.length} skills`);
    if (c.agents.length) meta.push(`${c.agents.length} agents`);
    if (c.hooks.length) meta.push(`hooks: ${c.hooks.join('+')}`);
    if (c.mcp.length) meta.push(`mcp: ${c.mcp.join('+')}`);
  }
  if (t.kind === 'skill' && t.state !== 'on') meta.push(t.state);
  if (t.uses) meta.push(`used ${t.uses}x, last ${t.lastUsed}`);
  return `${t.id}  [${meta.join(', ')}]  ${oneLine(t.description, 90)}  <${t.source}>`;
}

switch (cmd) {
  case 'inventory': {
    const inv = inventory({ projectDir });
    print(inv, [`${inv.things.length} things in ${inv.configDir.replace(/\\/g, '/')} and this project`, ...inv.things.map(describe), ...inv.warnings.map((w) => `warning: ${w}`)].join('\n'));
    break;
  }
  case 'init': {
    if (fs.existsSync(file) && !flags.force) fail(`${FILE} already exists. Re-tier with \`move\`, or pass --force to regenerate it (hand-written notes are lost).`);
    const { things } = inventory({ projectDir });
    const pick = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
    const chosen = { essential: pick(flags.essential), useful: pick(flags.useful) };
    const known = new Set(things.map((t) => t.id));
    const unknown = [...chosen.essential, ...chosen.useful].filter((id) => !known.has(id) && !/^(builtin|connector):./.test(id));
    if (unknown.length) fail(`not installed: ${unknown.join(', ')}. Run \`inventory\` for the ids.`);
    const taken = new Set([...chosen.essential, ...chosen.useful]);
    const tiers = {
      // Settings hooks always run, so they are listed with the essentials for information.
      essential: [...chosen.essential, ...things.filter((t) => t.kind === 'hook' && !taken.has(t.id)).map((t) => t.id)],
      useful: chosen.useful,
      informative: things.filter((t) => TIERABLE.has(t.kind) && !taken.has(t.id) && !t.id.startsWith('plugin:skillset@')).map((t) => t.id),
    };
    fs.writeFileSync(file, render({ scope: typeof flags.scope === 'string' ? flags.scope : '', tiers, things }));
    const res = apply(projectDir, parse(fs.readFileSync(file, 'utf8')).items);
    print({ file, tiers, ...res }, `Wrote ${FILE}: ${TIERS.map((t) => `${tiers[t].length} ${t}`).join(', ')}.\n${applied(res)}`);
    break;
  }
  case 'move': {
    const [tier, ...ids] = rest;
    if (![...TIERS, 'none'].includes(tier) || !ids.length) fail('usage: move <essential|useful|informative|none> <id> [<id>...]');
    let text = readFile();
    const { things } = inventory({ projectDir });
    const have = new Set(parse(text).items.map((i) => i.id));
    for (const id of ids) {
      if (split(id)[0] === 'hook' && tier !== 'none') fail(`${id}: a hook has no switch of its own; it follows its plugin or settings file.`);
      const t = things.find((x) => x.id === id);
      if (!have.has(id) && !t && tier !== 'none' && !/^(builtin|connector):./.test(id)) fail(`${id} is not installed and has no line in ${FILE}. Run \`inventory\` for the ids.`);
      text = setTier(text, id, tier, itemLine(t || { id }, tier));
    }
    fs.writeFileSync(file, text);
    const res = apply(projectDir, parse(text).items, tier === 'none' ? ids : []);
    print({ moved: ids, tier, ...res }, `${tier === 'none' ? 'Dropped' : `Moved to ${tier}`}: ${ids.join(', ')}\n${applied(res)}`);
    break;
  }
  case 'apply': {
    const res = apply(projectDir, parse(readFile()).items);
    print(res, applied(res));
    break;
  }
  case 'status': {
    const { items } = parse(readFile());
    const { things } = inventory({ projectDir });
    const drift = reconcile(items, things);
    const counts = Object.fromEntries(TIERS.map((t) => [t, items.filter((i) => i.tier === t).map((i) => i.id)]));
    const out = TIERS.map((t) => `${t} (${counts[t].length}): ${t === 'informative' ? counts[t].length ? 'see the file' : '-' : counts[t].join(', ') || '-'}`);
    if (drift.untiered.length) out.push(`installed but not in ${FILE}: ${drift.untiered.join(', ')}`);
    if (drift.missing.length) out.push(`listed but not installed in this profile: ${drift.missing.join(', ')}`);
    print({ tiers: counts, drift }, out.join('\n'));
    break;
  }
  case 'digest': {
    const { items } = parse(readFile());
    process.stdout.write(digest({ items, things: inventory({ projectDir }).things }));
    break;
  }
  case 'dismiss':
    dismiss(projectDir);
    console.log(`skillset will not offer configuration in ${projectDir.replace(/\\/g, '/')} again.`);
    break;
  default:
    console.log(USAGE);
    process.exit(cmd ? 1 : 0);
}
