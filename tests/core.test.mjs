// Self-check for the inventory, the tier file, settings apply, the digest, the hook and the CLI.
// Builds a fake home, config dir and project in a temp folder. Run: node tests/core.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { frontmatter, inventory, oneLine } from '../scripts/lib/inventory.mjs';
import { apply, digest, parse, reconcile, render, setTier, summarize } from '../scripts/lib/tiers.mjs';
import { dismiss, sessionStart } from '../scripts/lib/session.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillset-test-'));
const home = path.join(root, 'home');
const cfg = path.join(home, '.claude-x');
const project = path.join(root, 'proj');
const env = { CLAUDE_CONFIG_DIR: cfg };
const write = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
};
const skill = (dir, name, description) => write(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
const fwd = (p) => p.replace(/\\/g, '/');

// --- fixture -------------------------------------------------------------------------------------
skill(path.join(cfg, 'skills'), 'humanizer', '|\n  Rewrite AI-sounding text so it reads like the writer.\n  Use when editing prose.');
skill(path.join(cfg, 'skills'), 'gsap-core', '"Official GSAP skill for the core API: gsap.to(), from(), easing."');
write(path.join(cfg, 'skills', 'README.md'), 'not a skill');
skill(path.join(cfg, 'skills', 'synced', 'bucket1'), 'docx', 'Word documents.');
skill(path.join(project, '.claude', 'skills'), 'deploy', 'Deploy this project.');
write(path.join(home, '.agents', '.skill-lock.json'), { version: 3, skills: { humanizer: { sourceUrl: 'https://github.com/acme/humanizer.git' } } });

const cache = path.join(cfg, 'plugins', 'cache', 'mkt');
write(path.join(cache, 'tool', '1.0.0', '.claude-plugin', 'plugin.json'), { name: 'tool', description: 'A tool with a hook.' });
write(path.join(cache, 'tool', '1.0.0', 'hooks', 'hooks.json'), { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node x.js' }] }] } });
skill(path.join(cache, 'tool', '1.0.0', 'skills'), 'tool-run', 'Run the tool.');
write(path.join(cache, 'notes', '2.0.0', '.claude-plugin', 'plugin.json'), { name: 'notes', description: 'Note-taking instructions.', repository: 'https://github.com/acme/notes' });
skill(path.join(cache, 'notes', '2.0.0', 'skills'), 'take-notes', 'Take notes.');
write(path.join(cache, 'other', '1.0.0', '.claude-plugin', 'plugin.json'), { name: 'other' });
write(path.join(cfg, 'plugins', 'installed_plugins.json'), {
  version: 2,
  plugins: {
    'tool@mkt': [{ scope: 'user', installPath: path.join(cache, 'tool', '1.0.0'), version: '1.0.0' }],
    'notes@mkt': [{ scope: 'user', installPath: path.join(cache, 'notes', '2.0.0'), version: '2.0.0' }],
    'other@mkt': [{ scope: 'project', projectPath: path.join(root, 'elsewhere'), installPath: path.join(cache, 'other', '1.0.0'), version: '1.0.0' }],
  },
});
write(path.join(cfg, 'plugins', 'known_marketplaces.json'), { mkt: { source: { source: 'github', repo: 'acme/mkt' } } });
write(path.join(cfg, 'plugins', 'synced', 'b1', 'design~g2', '.claude-plugin', 'plugin.json'), { name: 'design', description: 'Design help.' });
write(path.join(cfg, 'settings.json'), {
  enabledPlugins: { 'tool@mkt': true, 'notes@mkt': true },
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude --token SECRET' }] }] },
});
write(path.join(cfg, '.claude.json'), {
  mcpServers: { sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp?token=SECRET' } },
  pluginUsage: { 'humanizer@skills-dir': { usageCount: 3, lastUsedAt: 1793270259670 }, 'tool@mkt': { usageCount: 5, lastUsedAt: 1793270259670 } },
  projects: { [fwd(project)]: { mcpServers: { localdb: { command: 'C:/x/db.exe', args: ['--key', 'SECRET'] } } } },
});
write(path.join(cfg, 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Reviews copy.\n---\n');
write(path.join(project, '.mcp.json'), { mcpServers: { pg: { command: 'npx', args: ['pg-mcp'] } } });

// --- frontmatter and one-liners ------------------------------------------------------------------
assert.equal(frontmatter('---\nname: a\ndescription: |\n  One.\n  Two.\nlicense: MIT\n---\n').description, 'One. Two.');
assert.equal(frontmatter('---\r\ndescription: "Quoted: \\"x\\""\r\n---\r\n').description, 'Quoted: "x"');
assert.equal(frontmatter('---\ndescription: >-\n  Folded\n  text\n---').description, 'Folded text');
assert.deepEqual(frontmatter('# no frontmatter'), {});
assert.equal(oneLine('Rewrite AI-sounding text so it reads well. Use when editing.'), 'Rewrite AI-sounding text so it reads well.');
assert.equal(oneLine('x'.repeat(300), 50).length, 50);

// --- inventory -----------------------------------------------------------------------------------
const inv = inventory({ projectDir: project, env, home });
const by = Object.fromEntries(inv.things.map((t) => [t.id, t]));
assert.deepEqual(inv.warnings, []);
assert.equal(by['skill:humanizer'].source, 'https://github.com/acme/humanizer');
assert.equal(by['skill:humanizer'].uses, 3);
assert.equal(by['skill:humanizer'].description, 'Rewrite AI-sounding text so it reads like the writer. Use when editing prose.');
assert.equal(by['skill:gsap-core'].source, 'local');
assert.equal(by['skill:anthropic-skills:docx'].scope, 'synced');
assert.equal(by['skill:deploy'].scope, 'project');
assert.equal(by['plugin:tool@mkt'].enabled, true);
assert.deepEqual(by['plugin:tool@mkt'].components.hooks, ['SessionStart']);
assert.equal(by['plugin:tool@mkt'].instructionOnly, false);
assert.equal(by['plugin:tool@mkt'].source, 'https://github.com/acme/mkt');
assert.equal(by['plugin:notes@mkt'].instructionOnly, true);
assert.equal(by['plugin:notes@mkt'].source, 'https://github.com/acme/notes');
assert.equal(by['plugin:design@synced'].scope, 'synced');
assert.equal(by['plugin:other@mkt'], undefined, 'a plugin installed for another project is not ours');
assert.equal(by['mcp:sentry'].description, 'http server at mcp.sentry.dev');
assert.equal(by['mcp:localdb'].scope, 'local');
assert.equal(by['mcp:pg'].scope, 'project');
assert.equal(by['agent:reviewer'].description, 'Reviews copy.');
assert.equal(by['hook:user/PreToolUse/Bash'].description, 'runs rtk on PreToolUse');
assert.ok(!JSON.stringify(inv).includes('SECRET'), 'no token from a hook command, MCP url or args leaks into the inventory');
assert.deepEqual(inventory({ projectDir: project, env: { CLAUDE_CONFIG_DIR: path.join(root, 'nope') }, home }).things.map((t) => t.id), ['skill:deploy', 'mcp:pg'], 'a missing config dir is not an error');

// --- SKILLSET.md ---------------------------------------------------------------------------------
const tiers = { essential: ['plugin:tool@mkt', 'hook:user/PreToolUse/Bash'], useful: ['skill:humanizer', 'plugin:notes@mkt'], informative: ['skill:gsap-core', 'mcp:pg', 'agent:reviewer'] };
const text = render({ scope: 'A test project.', tiers, things: inv.things });
const parsed = parse(text);
for (const tier of Object.keys(tiers)) assert.deepEqual(parsed.items.filter((i) => i.tier === tier).map((i) => i.id), tiers[tier]);
assert.match(text, /^Scope: A test project\.$/m);
assert.match(text, /- `skill:humanizer` — Rewrite AI-sounding text so it reads like the writer\. · Source: https:\/\/github\.com\/acme\/humanizer · Use: invoke `humanizer` · Config: user scope/);

let moved = setTier(text, 'skill:humanizer', 'essential');
assert.equal(parse(moved).items.find((i) => i.id === 'skill:humanizer').tier, 'essential');
assert.match(moved, /Use: invoke `humanizer`/, 'a moved line keeps its text');
moved = setTier(moved, 'skill:deploy', 'useful', '- `skill:deploy` — Deploy.');
assert.deepEqual(parse(moved).items.filter((i) => i.tier === 'useful').map((i) => i.id), ['plugin:notes@mkt', 'skill:deploy']);
moved = setTier(moved, 'mcp:pg', 'none');
assert.equal(parse(moved).items.some((i) => i.id === 'mcp:pg'), false);
assert.equal(moved.split('\n').length, text.split('\n').length, 'one line added, one removed, nothing else touched');
const noUseful = '# Mine\r\n\r\n## Essential\r\n- `skill:a` — A\r\n\r\n## Notes\r\n- `skill:zzz` not an item here\r\n';
const added = setTier(noUseful, 'skill:b', 'useful', '- `skill:b` — B');
assert.deepEqual(parse(added).items.map((i) => `${i.tier}/${i.id}`), ['essential/skill:a', 'useful/skill:b']);
assert.ok(added.includes('\r\n## Useful\r\n') && !/[^\r]\n/.test(added), 'CRLF files stay CRLF');
assert.equal(parse('## Useful\n- `skill:a` x\n## Informative\n- `skill:a` y\n').items.length, 1, 'a repeated id keeps its first tier');

// --- apply ---------------------------------------------------------------------------------------
const local = path.join(project, '.claude', 'settings.local.json');
write(local, { permissions: { allow: ['Bash(ls)'] }, skillOverrides: { mine: 'off' }, disabledMcpjsonServers: ['old'] });
let res = apply(project, parsed.items);
let s = JSON.parse(fs.readFileSync(local, 'utf8'));
assert.deepEqual(s.permissions, { allow: ['Bash(ls)'] }, 'unmanaged settings are kept');
assert.deepEqual(s.skillOverrides, { mine: 'off', humanizer: 'name-only', 'gsap-core': 'off' });
assert.deepEqual(s.enabledPlugins, { 'tool@mkt': true, 'notes@mkt': false });
assert.deepEqual(s.disabledMcpjsonServers, ['old', 'pg']);
assert.deepEqual(res.changes.map((c) => `${c.kind} ${c.name}: ${c.from} → ${c.to}`), ['skill humanizer: on → name-only', 'skill gsap-core: on → off', 'plugin notes@mkt: enabled → disabled', 'mcp pg: enabled → disabled']);
assert.deepEqual(summarize([...res.changes, { kind: 'skill', name: 'b', from: 'on', to: 'off' }]).slice(0, 2), ['skill: on → name-only (1): humanizer', 'skill: on → off (2): gsap-core, b']);
assert.equal(res.reload, true);
assert.deepEqual(res.unenforced, ['agent:reviewer']);
res = apply(project, parsed.items);
assert.deepEqual([res.wrote, res.changes], [false, []], 'apply is idempotent');
res = apply(project, parse(setTier(text, 'skill:gsap-core', 'none')).items, ['skill:gsap-core']);
assert.equal('gsap-core' in JSON.parse(fs.readFileSync(local, 'utf8')).skillOverrides, false, 'a dropped id is no longer managed');
assert.equal(apply(project, parse('## Essential\n- `plugin:skillset@skillset` x\n## Informative\n- `plugin:skillset@x` y\n').items).wrote, false, 'skillset never switches itself off');
fs.writeFileSync(local, '{ broken');
res = apply(project, parsed.items);
assert.match(res.error, /not valid JSON/);
assert.equal(fs.readFileSync(local, 'utf8'), '{ broken', 'a broken settings file is left alone');
fs.rmSync(local);

// --- reconcile and digest ------------------------------------------------------------------------
const drift = reconcile(parse(text + '\n## Useful\n- `skill:ghost` — gone\n').items, inv.things);
assert.deepEqual(drift.missing, ['skill:ghost']);
assert.ok(drift.untiered.includes('skill:deploy') && !drift.untiered.some((id) => id.startsWith('hook:')));
const d = digest({ items: parsed.items, things: inv.things });
assert.match(d, /^skillset: /);
assert.match(d, /- skill `humanizer`: Rewrite AI-sounding text so it reads like the writer\.\n/);
assert.match(d, /plugin `notes@mkt` \(off here\): Note-taking instructions\. Skills: take-notes\. Usable right now by reading a SKILL\.md under .*\/notes\/2\.0\.0\/skills\/\.\n/);
assert.match(d, /To load an off plugin: `claude plugin enable <id> --scope local`/);
assert.match(d, /Informative tier: 3 more/);
assert.match(d, /not in SKILLSET\.md yet: .*`skill:deploy`/);
assert.ok(d.length < 4000);
const brief = digest({ items: parsed.items, things: inv.things, cap: 300 });
assert.ok(!brief.includes('Rewrite AI-sounding') && brief.includes('`skill:humanizer`'), 'over the cap, the useful tier falls back to names');

// --- session start -------------------------------------------------------------------------------
assert.match(sessionStart({ projectDir: project, env, home }), /no SKILLSET\.md.*\/skillset-configure.*dismiss/s);
assert.equal(sessionStart({ projectDir: home, env, home }), '', 'the home dir is not a project');
dismiss(project, env, home);
assert.equal(sessionStart({ projectDir: project, env, home }), '', 'a dismissed project stays quiet');
write(path.join(project, 'SKILLSET.md'), text);
const started = sessionStart({ projectDir: project, env, home });
assert.match(started, /Re-applied 4 tier setting\(s\).*\/reload-plugins/);
assert.equal(JSON.parse(fs.readFileSync(local, 'utf8')).skillOverrides.humanizer, 'name-only');
assert.ok(!sessionStart({ projectDir: project, env, home }).includes('Re-applied'), 'a second start has nothing to re-apply');
write(path.join(project, 'SKILLSET.md'), '# Skills\n\nSomething else entirely.\n');
assert.equal(sessionStart({ projectDir: project, env, home }), '', 'a SKILLSET.md without tier items is left alone');

// --- the hook and the CLI as processes -----------------------------------------------------------
const childEnv = { ...process.env, CLAUDE_CONFIG_DIR: cfg, CLAUDE_PROJECT_DIR: project, HOME: home, USERPROFILE: home };
const node = (script, args = [], extra = {}) => spawnSync(process.execPath, [path.join(repo, script), ...args], { encoding: 'utf8', env: { ...childEnv, ...extra } });
write(path.join(project, 'SKILLSET.md'), text);
let run = node('hooks/session-start.mjs');
assert.equal(run.status, 0);
assert.match(run.stdout, /^skillset: this project tiers/);
write(path.join(root, 'a-file'), 'x');
run = node('hooks/session-start.mjs', [], { CLAUDE_CONFIG_DIR: path.join(root, 'a-file'), CLAUDE_PROJECT_DIR: path.join(root, 'missing') });
assert.deepEqual([run.status, run.stderr], [0, ''], 'the hook never fails a session');

const fresh = path.join(root, 'fresh');
fs.mkdirSync(fresh);
const cli = (...args) => node('scripts/skillset.mjs', args, { CLAUDE_PROJECT_DIR: fresh });
run = cli('init', '--essential', 'plugin:tool@mkt', '--useful', 'skill:humanizer,connector:claude.ai Slack');
assert.equal(run.status, 0, run.stderr);
const made = parse(fs.readFileSync(path.join(fresh, 'SKILLSET.md'), 'utf8')).items;
assert.deepEqual(made.filter((i) => i.tier === 'essential').map((i) => i.id), ['plugin:tool@mkt', 'hook:user/PreToolUse/Bash']);
assert.deepEqual(made.filter((i) => i.tier === 'useful').map((i) => i.id), ['skill:humanizer', 'connector:claude.ai Slack']);
assert.ok(made.some((i) => i.tier === 'informative' && i.id === 'plugin:notes@mkt'));
assert.equal(cli('init').status, 1, 'init does not overwrite an existing file');
assert.equal(cli('init', '--essential', 'skill:nope', '--force').status, 1, 'unknown ids are refused');
run = cli('move', 'informative', 'skill:humanizer');
assert.match(run.stdout, /skill: name-only → off \(1\): humanizer/);
assert.equal(cli('move', 'useful', 'hook:user/PreToolUse/Bash').status, 1, 'hooks cannot be tiered');
run = cli('status', '--json');
assert.deepEqual(JSON.parse(run.stdout).drift, { untiered: [], missing: [] });
assert.match(cli('digest').stdout, /^skillset: /);
assert.equal(cli('nonsense').status, 1);

fs.rmSync(root, { recursive: true, force: true });
console.log('core.test.mjs: all checks passed');
