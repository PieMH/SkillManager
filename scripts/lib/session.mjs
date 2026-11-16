// What the SessionStart hook does, kept here so it can be tested without spawning a process.
import fs from 'node:fs';
import path from 'node:path';
import { spawn as spawnProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inventory, paths, samePath } from './inventory.mjs';
import { FILE, apply, digest, parse } from './tiers.mjs';
import { due, pending, readState, writeState } from './updates.mjs';

const CLI = fileURLToPath(new URL('../skillmanager.mjs', import.meta.url)).replace(/\\/g, '/');

export function dismiss(projectDir, env = process.env, home) {
  const p = paths(env, home);
  const state = readState(p);
  const list = (state.dismissed || []).filter((d) => !samePath(d, projectDir));
  writeState(p, { ...state, dismissed: [...list, path.resolve(projectDir).replace(/\\/g, '/')] });
}

// The weekly update check runs detached: the hook stamps the start, launches it and returns at once.
// Returns true in the session that starts it, which is also the one that offers discovery that week.
function startCheck(p, state, now, env, spawn) {
  if (!due(state, now)) return false;
  try {
    writeState(p, { ...state, checkStartedAt: new Date(now).toISOString() });
    spawn(process.execPath, [CLI, 'check', '--quiet'], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ...env } }).unref();
    return true;
  } catch { return false; } // a check that cannot start is skipped until next week
}

export function sessionStart({ projectDir, env = process.env, home, now = Date.now(), spawn = spawnProcess } = {}) {
  const p = paths(env, home);
  let text;
  try { text = fs.readFileSync(path.join(projectDir, FILE), 'utf8'); } catch {
    const dismissed = (readState(p).dismissed || []).some((d) => samePath(d, projectDir));
    if (dismissed || samePath(projectDir, p.home)) return ''; // the home dir is not a project
    return 'SkillManager: this project has no SKILLMANAGER.md, so every installed skill, plugin and MCP server loads here. '
      + 'Once, when it does not interrupt the user\'s request, offer to tier them for this project with /skillmanager-configure. '
      + `If the user declines, run \`node "${CLI}" dismiss\` and do not offer again.\n`;
  }
  const { items } = parse(text);
  if (!items.length) return ''; // a SKILLMANAGER.md with no tier items is not ours to act on
  const state = readState(p);
  const weekly = startCheck(p, state, now, env, spawn);
  const { things } = inventory({ projectDir, env, home: p.home });
  return digest({ items, things, applied: apply(projectDir, items), updates: pending(state), discover: weekly });
}
