// What the SessionStart hook does, kept here so it can be tested without spawning a process.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventory, paths, readJson, samePath } from './inventory.mjs';
import { FILE, apply, digest, parse } from './tiers.mjs';

const CLI = fileURLToPath(new URL('../skillset.mjs', import.meta.url)).replace(/\\/g, '/');

export function dismiss(projectDir, env = process.env, home) {
  const p = paths(env, home);
  const state = readJson(p.stateFile) || {};
  const list = (state.dismissed || []).filter((d) => !samePath(d, projectDir));
  state.dismissed = [...list, path.resolve(projectDir).replace(/\\/g, '/')];
  fs.mkdirSync(path.dirname(p.stateFile), { recursive: true });
  fs.writeFileSync(p.stateFile, JSON.stringify(state, null, 2) + '\n');
}

export function sessionStart({ projectDir, env = process.env, home } = {}) {
  const p = paths(env, home);
  let text;
  try { text = fs.readFileSync(path.join(projectDir, FILE), 'utf8'); } catch {
    const dismissed = ((readJson(p.stateFile) || {}).dismissed || []).some((d) => samePath(d, projectDir));
    if (dismissed || samePath(projectDir, p.home)) return ''; // the home dir is not a project
    return 'skillset: this project has no SKILLSET.md, so every installed skill, plugin and MCP server loads here. '
      + 'Once, when it does not interrupt the user\'s request, offer to tier them for this project with /skillset-configure. '
      + `If the user declines, run \`node "${CLI}" dismiss\` and do not offer again.\n`;
  }
  const { items } = parse(text);
  if (!items.length) return ''; // a SKILLSET.md with no tier items is not ours to act on
  const { things } = inventory({ projectDir, env, home: p.home });
  return digest({ items, things, applied: apply(projectDir, items) });
}
