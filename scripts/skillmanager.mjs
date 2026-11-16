#!/usr/bin/env node
// SkillManager CLI: the deterministic half of the plugin. The skills call it; nothing here needs a model.
import fs from 'node:fs';
import path from 'node:path';
import { inventory, oneLine, paths } from './lib/inventory.mjs';
import { FILE, TIERABLE, TIERS, apply, digest, moveItems, parse, reconcile, render, summarize } from './lib/tiers.mjs';
import { dismiss } from './lib/session.mjs';
import { check, passDue, pending, readState, skip, stampPass, writeState } from './lib/updates.mjs';
import { report, scan } from './lib/scan.mjs';
import { startServer } from './lib/serve.mjs';
import { discover, report as discoverReport } from './lib/discover.mjs';

const USAGE = `usage: skillmanager <command> [--project <dir>] [--json]
  inventory                       everything installed for this profile and project
  init --essential a,b --useful c writes SKILLMANAGER.md (the rest goes to informative) and applies it; --force to overwrite
  move <tier> <id> [<id>...]      tier: essential | useful | informative | none (none drops the line)
  apply                           writes the tiers into .claude/settings.local.json
  status                          tiers, drift and settings that are out of step
  digest                          what the SessionStart hook prints
  check [--cached]                which plugins and skills have updates upstream (--cached: the last result, no network)
  skip <id> [--reason text]       stop proposing the pending update of <id> until a newer one appears
  scan <path> [--no-external]     facts about a plugin or skill folder before installing it
  discover <words>                candidates for a job from your marketplaces, SkillsMP, GitHub and skillsllm.com; installs nothing
  serve                           the status page on 127.0.0.1; prints its link, then the queue for Claude on exit
  dismiss                         stop offering configuration in this project`;

const argv = process.argv.slice(2);
const flags = {};
const args = [];
for (let i = 0; i < argv.length; i++) {
  const m = /^--([\w-]+)(?:=(.*))?$/.exec(argv[i]);
  if (!m) args.push(argv[i]);
  else if (m[2] !== undefined) flags[m[1]] = m[2];
  else if (['json', 'force', 'cached', 'quiet', 'no-external'].includes(m[1]) || argv[i + 1] === undefined) flags[m[1]] = true;
  else flags[m[1]] = argv[++i];
}
const [cmd, ...rest] = args;
const projectDir = path.resolve(flags.project || process.env.CLAUDE_PROJECT_DIR || process.cwd());
const file = path.join(projectDir, FILE);
const fail = (msg) => { console.error(`SkillManager: ${msg}`); process.exit(1); };
const print = (data, text) => console.log(flags.json ? JSON.stringify(data, null, 2) : text);
const readFile = () => { try { return fs.readFileSync(file, 'utf8'); } catch { return fail(`no ${FILE} in ${projectDir}. Run /skillmanager-configure first.`); } };

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
      informative: things.filter((t) => TIERABLE.has(t.kind) && !taken.has(t.id) && !t.id.startsWith('plugin:skillmanager@')).map((t) => t.id),
    };
    fs.writeFileSync(file, render({ scope: typeof flags.scope === 'string' ? flags.scope : '', tiers, things }));
    const res = apply(projectDir, parse(fs.readFileSync(file, 'utf8')).items);
    print({ file, tiers, ...res }, `Wrote ${FILE}: ${TIERS.map((t) => `${tiers[t].length} ${t}`).join(', ')}.\n${applied(res)}`);
    break;
  }
  case 'move': {
    const [tier, ...ids] = rest;
    readFile(); // a clear message when there is no SKILLMANAGER.md
    let res;
    try { res = moveItems(projectDir, tier, ids, inventory({ projectDir }).things); } catch (err) { fail(err.message); }
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
  case 'check': {
    const p = paths();
    if (!flags.cached) {
      writeState(p, { ...readState(p), checkStartedAt: new Date().toISOString() });
      await check(p);
      if (!flags.quiet) stampPass(p); // --quiet is the hook's background run, which is no update pass
    }
    const st = readState(p);
    const list = pending(st);
    if (flags.quiet) break;
    const when = (iso) => new Date(iso).toLocaleString();
    const out = [`Profile ${p.configDir.replace(/\\/g, '/')}.`, st.checkedAt ? `Last check ${when(st.checkedAt)}: ${list.length} update(s) pending.` : 'No update check has run yet. Run `check` without --cached.'];
    out.push(st.passAt ? `Last update pass ${when(st.passAt)}${passDue(st) ? ', so a new one is due' : ''}.` : 'No update pass yet.');
    for (const u of list) out.push(`- ${u.id}: ${u.installed} → ${u.latest}  (${u.how})`);
    const skipped = Object.entries(st.skipped || {});
    if (skipped.length) out.push(`Skipped: ${skipped.map(([id, s]) => `${id} ${s.latest}${s.reason ? ` (${s.reason})` : ''}`).join(', ')}`);
    if (st.checkErrors?.length) out.push(`Not checked: ${st.checkErrors.join('; ')}`);
    print({ checkedAt: st.checkedAt || null, passAt: st.passAt || null, passDue: passDue(st), updates: list, skipped: st.skipped || {}, errors: st.checkErrors || [] }, out.join('\n'));
    break;
  }
  case 'skip': {
    let u;
    try { u = skip(paths(), rest[0], typeof flags.reason === 'string' ? flags.reason : ''); } catch (err) { fail(err.message); }
    console.log(`Skipped ${rest[0]} ${u.latest}. A newer version will be proposed again.`);
    break;
  }
  case 'scan': {
    if (!rest[0]) fail('usage: scan <path>');
    let r;
    try { r = scan(rest[0], { things: inventory({ projectDir }).things, external: !flags['no-external'] }); } catch (err) { fail(err.message); }
    print(r, report(r));
    break;
  }
  case 'discover': {
    let r;
    try { r = await discover(rest.join(' '), { things: inventory({ projectDir }).things }); } catch (err) { fail(err.message); }
    print(r, discoverReport(r));
    break;
  }
  case 'serve': {
    readFile(); // the page shows SKILLMANAGER.md, so it needs one
    // Synchronous writes: the output goes to a file that Claude reads, and process.exit follows at once.
    const s = await startServer({ projectDir, onExit: (r) => { fs.writeSync(1, `skillmanager-queue: ${JSON.stringify(r)}\n`); process.exit(0); } });
    fs.writeSync(1, `skillmanager-status: ready ${s.url}\n`);
    break; // the server keeps the process alive until Send to Claude or 30 idle minutes
  }
  case 'dismiss':
    dismiss(projectDir);
    console.log(`SkillManager will not offer configuration in ${projectDir.replace(/\\/g, '/')} again.`);
    break;
  default:
    console.log(USAGE);
    process.exit(cmd ? 1 : 0);
}
