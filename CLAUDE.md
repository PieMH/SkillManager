# CLAUDE.md

Guidance for Claude Code, and for people, working on this repo. The README explains what the plugin does for its users. This file covers how to change it without breaking it.

## What this repo is

A Claude Code plugin that is also its own one-plugin marketplace (`.claude-plugin/marketplace.json`, `"source": "./"`). No build step and no npm dependencies: Markdown prompts plus Node scripts with one self-check.

| Path | What it is | Read by |
|---|---|---|
| `hooks/session-start.mjs` | The SessionStart hook: applies `SKILLSET.md`, prints the digest | Claude Code, in every session of every user |
| `scripts/lib/inventory.mjs` | What is installed, read from Claude Code's files on disk | the hook and the CLI |
| `scripts/lib/tiers.mjs` | Parse and write `SKILLSET.md`, turn tiers into settings, build the digest | the hook and the CLI |
| `scripts/lib/session.mjs` | What the hook does, as a testable function | the hook |
| `scripts/lib/updates.mjs` | The update check and the per-account state file | the CLI; the hook reads its state |
| `scripts/lib/scan.mjs` | Compliance facts about a plugin or skill folder before install | the CLI |
| `scripts/skillset.mjs` | The CLI the skills call | the model, through Bash |
| `skills/skillset-configure/SKILL.md` | The configure workflow | the model |
| `skills/skillset-update/SKILL.md` | Status, moves, install, uninstall, drift, updates | the model |

`ProjectScope.txt` is the original brief. The approved plan covers five phases: phase 1 is the core, phase 2 is change management (update check, `scan`, `/skillset-update`).

## Invariants: don't break these

- **The hook never fails and never blocks.** It reads no stdin, reads files only, exits 0 on every error and prints nothing when it has nothing to say. The one process it starts is the weekly `check`, detached, with no stdio, never awaited. It runs at the start of every session of every user.
- **Checking and scanning change nothing.** `check` reads Claude Code's files and public GitHub data; `scan` reads the target and never runs it. Installs, updates and uninstalls happen only through native commands the user approves in `/skillset-update`.
- **The hook's output is paid for in every session.** Keep the digest short (target under 4,000 characters; Claude Code cuts hook output at 10,000). Tighten before you add a line.
- **Only documented switches are written.** `skillOverrides`, `enabledPlugins` and `disabledMcpjsonServers`. A tier with no documented switch is reported as recorded, not enforced. Do not write a setting on a guess.
- **Only the project's `.claude/settings.local.json` is written**, and only entries for ids listed in `SKILLSET.md`. Never user-level settings, never another key. A settings file that is not valid JSON is left alone.
- **No secrets in output.** Hook commands, MCP args, env values and URL paths can hold tokens: the inventory shows the executable name or the host and nothing else. The self-check asserts this.
- **`SKILLSET.md` belongs to the user.** Commands change the one line they are asked to change. Only `init --force` regenerates the file.
- **The plugin never switches itself off.**
- **Zero dependencies.** Node 18+ built-ins only. Use `path` APIs, print forward slashes, parse `\r\n` as well as `\n`.
- **Claude Code's files are internals.** `installed_plugins.json`, `.claude.json` and the synced folders can change shape: every reader returns "nothing found" instead of throwing.

## Testing

```bash
node tests/core.test.mjs
```

A plain `node:assert` script that builds a fake home, config dir and project in a temp folder. Add a case for any logic change. Prompt changes (`SKILL.md`) have no unit tests: try them in a throwaway project.

To try changes, install from the working copy:

```bash
claude plugin marketplace add /path/to/SkillManager
claude plugin install skillset@skillset
```

## Releasing

1. Bump `version` in `.claude-plugin/plugin.json` (semver).
2. Keep the tier table identical in `README.md` and `skills/skillset-configure/SKILL.md`.
3. Users update with `claude plugin marketplace update skillset && claude plugin update skillset@skillset`.

## Style

- Prompts are short, imperative and concrete. Name the exact command or file.
- Commits get a short imperative subject and no AI attribution trailers.

<!-- skillset:start -->
## Skill set
This project's skills, plugins, MCP servers and agents are tiered in `SKILLSET.md`: essential loads every session, useful is pulled in on demand, informative is installed but off here. Read it before saying a capability is missing, and change tiers with `/skillset-update` rather than by installing things again.
<!-- skillset:end -->
