// SessionStart hook: applies this project's SKILLSET.md and prints the digest the model reads.
// It does not read stdin (Claude Code on Windows can leave a hook's stdin open, which would hang it)
// and it stays silent on any error: a broken hook here would get in the way of every session.
// Once a week it launches the update check as a detached process and does not wait for it.
import fs from 'node:fs';
import { sessionStart } from '../scripts/lib/session.mjs';

let out = '';
try { out = sessionStart({ projectDir: process.env.CLAUDE_PROJECT_DIR || process.cwd() }); } catch { /* silent */ }
// Synchronous: an async pipe write can be lost when the process exits.
if (out) { try { fs.writeSync(1, out); } catch { /* silent */ } }
