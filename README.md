# skillset

Per-project tiers for the skills, plugins, MCP servers and agents Claude Code loads.

## Why

Everything you install globally is loaded in every project. Claude Code caps the skill listing at 1% of the context window and, when it overflows, drops the descriptions of the skills you use least, so a large stack costs tokens and makes relevant skills stop triggering. skillset gives each project a `SKILLSET.md` with three tiers and applies it at session start through Claude Code's own settings:

- **essential**: loaded in every session of this project
- **useful**: kept out of the way, pulled in when a task calls for it
- **informative**: installed on the machine, switched off here, still listed so the agent knows it exists

## Install

```bash
claude plugin marketplace add PieMH/SkillManager
claude plugin install skillset@skillset
```

Needs Node 18 or newer on the PATH. Works wherever Claude Code runs plugins and hooks: the CLI, the Desktop app's Code tab and wrappers around the CLI.

## Use

- `/skillset-configure` asks what the project is for, shows what is installed against a proposed tiering, writes `SKILLSET.md`, applies it and adds a pointer to `CLAUDE.md`. In a project without a `SKILLSET.md`, Claude offers this once; decline and it stays quiet.
- Re-tier by moving a line to another section of `SKILLSET.md`. The next session applies it.

Version 0.1.0 is the core. Updating, installing with a compliance check, a status page and discovery are next.

## How it works

`SKILLSET.md` has three sections with one line per thing:

```markdown
## Useful
- `skill:humanizer` — Rewrite AI-sounding prose. · Source: https://github.com/blader/humanizer · Use: invoke `humanizer` · Config: user scope
```

Only the backticked id and the section matter to the tool. At every session start a hook reads the file and:

1. writes the tiers into the project's `.claude/settings.local.json`, touching only entries for things the file lists;
2. prints a short digest for the model: one line per useful item, how many things are switched off, and any drift (installed but not listed, listed but not installed in this profile).

| Kind | essential | useful | informative |
|---|---|---|---|
| Skill | `skillOverrides: "on"` | `"name-only"`, with its one-liner in the digest | `"off"` |
| Plugin | `enabledPlugins: true` | `false` here, named in the digest with its enable command | `false` here |
| MCP server from `.mcp.json` | enabled | enabled (its tools are deferred anyway) | `disabledMcpjsonServers` |

The hook reads files only and never spawns `claude`. `CLAUDE.md` gets a pointer, not an `@` import, because an import would load the whole file every session.

## Limits

- **Nothing is unloaded mid-session.** Tiers apply when a session starts. Plugin changes need `/reload-plugins` or a new session.
- **A plugin is all or nothing.** `skillOverrides` does not reach plugin skills, so they follow their plugin.
- **Recorded, not enforced:** agents, user-scope MCP servers and claude.ai connectors. Claude Code documents no per-project switch for them, so an informative tier there is a note for the agent.
- **Synced and built-in items obey the switches** (checked in the CLI, Claude Code 2.1.325): `skillOverrides` hides skills synced from a claude.ai account and built-in skills, and `enabledPlugins` switches off plugins synced from it. Not yet checked in the Desktop Code tab or in wrappers.
- `.claude/settings.local.json` is personal. The informative section of `SKILLSET.md` is generated per machine, so it changes between machines if you commit the file.

## Development

No build step and no dependencies: Node built-ins only.

```bash
node tests/core.test.mjs                 # inventory, tier file, settings, digest, hook, CLI
node scripts/skillset.mjs inventory      # what the tool sees on this machine
claude plugin validate .
```

See [CLAUDE.md](CLAUDE.md) for the rules that keep the hook safe.

## License

MIT
