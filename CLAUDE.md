# CLAUDE.md

Guidance for Claude Code, and for people, working on this repo. The README explains what the plugin does for its users. This file covers how to change it without breaking it.

## What this repo is

A Claude Code plugin that is also its own one-plugin marketplace (`.claude-plugin/marketplace.json`, `"source": "./"`). No build step and no npm dependencies: Markdown prompts plus Node scripts with one self-check.

| Path | What it is | Read by |
|---|---|---|
| `hooks/session-start.mjs` | The SessionStart hook: applies `SKILLMANAGER.md`, prints the digest | Claude Code, in every session of every user |
| `hooks/band.tsx` | The band above the prompt (a hooks module named under `modules` in `hooks/hooks.json`): update count, pass due, the board button | Claude Code's mod engine, on every redraw |
| `scripts/lib/inventory.mjs` | What is installed, read from Claude Code's files on disk | the hook and the CLI |
| `scripts/lib/tiers.mjs` | Parse and write `SKILLMANAGER.md`, turn tiers into settings, build the digest | the hook and the CLI |
| `scripts/lib/session.mjs` | What the hook does, as a testable function | the hook |
| `scripts/lib/updates.mjs` | The update check and the per-account state file | the CLI; the hook reads its state |
| `scripts/lib/scan.mjs` | Compliance facts about a plugin or skill folder before install | the CLI |
| `scripts/lib/discover.mjs` | Candidates for a job from four public sources | the CLI |
| `scripts/lib/serve.mjs`, `scripts/lib/page.html` | The status page: a 127.0.0.1 server and its one self-contained page | the CLI (`serve`) |
| `scripts/skillmanager.mjs` | The CLI the skills call | the model, through Bash |
| `skills/skillmanager-configure/SKILL.md` | The configure workflow | the model |
| `skills/skillmanager-update/SKILL.md` | Status, moves, install, uninstall, drift, updates | the model |
| `skills/skillmanager-status/SKILL.md` | Start the status page and handle its queue | the model |

`ProjectScope.txt` is the original brief. The approved plan covers five phases: phase 1 is the core, phase 2 is change management (update check, `scan`, `/skillmanager-update`), phase 3 is the status page, phase 4 is discovery and the opt-in schedule.

## Invariants: don't break these

- **The hook never fails and never blocks.** It reads no stdin, reads files only, exits 0 on every error and prints nothing when it has nothing to say. The one process it starts is the weekly `check`, detached, with no stdio, never awaited. It runs at the start of every session of every user.
- **The band reads and never writes.** It reads `SKILLMANAGER.md` and the profile's `state.json`, runs only the plugin's own slash commands through `$.command.run`, and its `.catch` hands the row back to the engine, so a fault draws nothing instead of breaking the band. It cannot import the Node scripts (a hooks module has no Node), so the seven-day rule is written in both `band.tsx` and `updates.mjs`: change them together.
- **The status page is local and token-gated.** It listens on 127.0.0.1 only, checks the Host and Origin headers and the per-launch token on every request, sends a strict CSP and renders every value as text. It applies tier moves, checks and skips itself; installing and uninstalling only ever go to the queue for Claude.
- **Checking, scanning and discovering change nothing.** `check` reads Claude Code's files and public GitHub data; `scan` reads the target and never runs it; `discover` only lists candidates. Search words leave the machine, so the skills keep project details out of them. Installs, updates and uninstalls happen only through native commands the user approves in `/skillmanager-update`.
- **The hook's output is paid for in every session.** Keep the digest short (target under 4,000 characters; Claude Code cuts hook output at 10,000). Tighten before you add a line.
- **Only documented switches are written.** `skillOverrides`, `enabledPlugins` and `disabledMcpjsonServers`. A tier with no documented switch is reported as recorded, not enforced. Do not write a setting on a guess.
- **Only the project's `.claude/settings.local.json` is written**, and only entries for ids listed in `SKILLMANAGER.md`. Never user-level settings, never another key. A settings file that is not valid JSON is left alone.
- **No secrets in output.** Hook commands, MCP args, env values and URL paths can hold tokens: the inventory shows the executable name or the host and nothing else. The self-check asserts this.
- **`SKILLMANAGER.md` belongs to the user.** Commands change the one line they are asked to change. Only `init --force` regenerates the file.
- **The plugin never switches itself off.**
- **Zero dependencies.** Node 18+ built-ins only. Use `path` APIs, print forward slashes, parse `\r\n` as well as `\n`.
- **Claude Code's files are internals.** `installed_plugins.json`, `.claude.json` and the synced folders can change shape: every reader returns "nothing found" instead of throwing.

## Testing

```bash
node tests/core.test.mjs
claude plugin test .
```

The first is a plain `node:assert` script that builds a fake home, config dir and project in a temp folder; add a case for any logic change. The second runs `hooks/band.test.tsx` against Claude Code's own mod engine (it needs the `claude` CLI, so CI runs only the first). Prompt changes (`SKILL.md`) have no unit tests: try them in a throwaway project.

To try changes, install from the working copy:

```bash
claude plugin marketplace add /path/to/SkillManager
claude plugin install skillmanager@skillmanager
```

## Releasing

1. Bump `version` in `.claude-plugin/plugin.json` (semver).
2. Keep what each tier does consistent across `docs/how-it-works.md`, `skills/skillmanager-configure/SKILL.md` and the README's three-line table. The README stays short; details go in `docs/how-it-works.md`.
3. Users update with `claude plugin marketplace update skillmanager && claude plugin update skillmanager@skillmanager`.

## Style

- Prompts are short, imperative and concrete. Name the exact command or file.
- Commits get a short imperative subject and no AI attribution trailers.

<!-- skillmanager:start -->
## SkillManager
This project's skills, plugins, MCP servers and agents are tiered in `SKILLMANAGER.md`: essential loads every session, useful is pulled in on demand, informative is installed but off here. Read it before saying a capability is missing, and change tiers with `/skillmanager-update` rather than by installing things again.
<!-- skillmanager:end -->
