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
- `/skillset-update` shows the status, moves things between tiers, installs through a compliance check, uninstalls, reconciles drift and reviews pending updates. Claude also uses it when you ask it to install or remove something.
- Re-tier by moving a line to another section of `SKILLSET.md`. The next session applies it.

A status page and discovery of new skills are next.

### Compliance check

Before anything is installed, `scan` reads it (never runs it) and reports what it adds, what it collides with in your setup (names, hook events), the keys and binaries it needs, which installed skills do the same job, and lines that look risky: piping downloads into a shell, obfuscated code, credential paths, permission bypasses, prompt-injection phrasing, network calls in hooks. If [NVIDIA SkillSpector](https://github.com/NVIDIA/skillspector) is on the PATH, its static scan (`--no-llm`) is added; Claude offers to install it (`uv tool install git+https://github.com/NVIDIA/skillspector.git`, Python 3.12+) when it is missing. Claude then reads the flagged source, gives an APPROVE, CAUTION or REJECT verdict, fixes small conflicts itself and asks you about hooks, MCP servers, keys and security flags.

### Updates

Once a week, the first session start launches a background check and returns at once. It compares each plugin's installed version with its marketplace, each `npx skills` install with its GitHub folder, and each skill kept in a git clone with its remote. Nothing is changed: the next digest lists what is pending, and `/skillset-update` reviews each update against the project and applies or skips it. A skipped version is not proposed again.

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

The hook reads files only and never spawns `claude`; once a week it starts the update check as a detached process. `CLAUDE.md` gets a pointer, not an `@` import, because an import would load the whole file every session.

## Limits

- **Nothing is unloaded mid-session.** Tiers apply when a session starts. Plugin changes need `/reload-plugins` or a new session.
- **A plugin is all or nothing.** `skillOverrides` does not reach plugin skills, so they follow their plugin.
- **Recorded, not enforced:** agents, user-scope MCP servers and claude.ai connectors. Claude Code documents no per-project switch for them, so an informative tier there is a note for the agent.
- **Synced and built-in items obey the switches** (checked in the CLI, Claude Code 2.1.325): `skillOverrides` hides skills synced from a claude.ai account and built-in skills, and `enabledPlugins` switches off plugins synced from it. Not yet checked in the Desktop Code tab or in wrappers.
- `.claude/settings.local.json` is personal. The informative section of `SKILLSET.md` is generated per machine, so it changes between machines if you commit the file.
- **Network.** The weekly check reads public files from `raw.githubusercontent.com` and the GitHub API (60 unauthenticated requests an hour, one per skill repo) and runs `git ls-remote` on skill clones. SkillSpector's scan sends the target's dependency names to OSV.dev. Nothing else leaves the machine.
- **Update check coverage:** plugins from GitHub or local-folder marketplaces with a version number, `npx skills` installs from GitHub, and git clones. Plugins versioned by commit hash, other plugin sources and skills synced from claude.ai are not checked.

## Development

No build step and no dependencies: Node built-ins only.

```bash
node tests/core.test.mjs                 # inventory, tiers, settings, digest, hook, update check, scan, CLI
node scripts/skillset.mjs inventory      # what the tool sees on this machine
claude plugin validate .
```

See [CLAUDE.md](CLAUDE.md) for the rules that keep the hook safe.

## License

MIT. The install review rules in `skills/skillset-update` are adapted from the `skill-inspector` skill of [NVIDIA SkillSpector](https://github.com/NVIDIA/skillspector), Apache-2.0; SkillSpector itself is not bundled.
