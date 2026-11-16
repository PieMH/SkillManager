# How skillset works

The [README](../README.md) is the short version. This page covers each part, the limits and what leaves your machine.

## Why

Everything you install globally is loaded in every project. Claude Code caps the skill listing at 1% of the context window and, when it overflows, drops the descriptions of the skills you use least, so a large stack costs tokens and makes relevant skills stop triggering. skillset gives each project a `SKILLSET.md` with three tiers and applies it through Claude Code's own settings:

- **essential**: loaded in every session of this project
- **useful**: kept out of the way, pulled in when a task calls for it
- **informative**: installed on the machine, switched off here, still listed so the agent knows it exists

## SKILLSET.md and the session-start hook

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

The hook reads files only and never spawns `claude`; once a week it starts the update check as a detached process. `CLAUDE.md` gets a pointer, not an `@` import, because an import would load the whole file every session. Re-tier by moving a line to another section of `SKILLSET.md`, or from the status page.

## The band above the prompt

One row sits above the prompt in every session: the count of pending updates, **update pass due** once a week has passed since the last one, and a **Skill set** button that opens the status page. The button turns into the primary action while the pass is due. The row reads its state on every redraw, so it shows mid-session; no new session is needed. In a project with no `SKILLSET.md` it offers **Set up tiers** instead, and it disappears in a project where you declined. It reads two files and runs the plugin's own commands as if typed, queued until Claude is idle; it changes nothing. Other plugins keep their own rows.

## The status page

`/skillset-status` starts a small local server and opens the page in the session's browser panel (in CCWrapper) or gives you the link. From the top: when the weekly update pass is due, a banner with a glowing **Run update pass**; the **Ask Claude** bar, where a question or a search joins the queue as a chip; the tiers as tabs (Essential, Useful, Informative, Updates) with the loadout bar above them; then the filter and the list. Moving something between tiers and skipping an update apply at once, with no model and no tokens. Reviewing an update, uninstalling, finding alternatives and questions go to the queue; **Send to Claude** stops the page and hands the queue to the session, which handles it with `/skillset-update`. The update pass checks every plugin and skill upstream and, if anything changed, hands the review to Claude at once.

The server listens on 127.0.0.1 only, needs the per-launch token in its link, refuses other hosts and origins, loads nothing from the network, and stops after 30 minutes without use.

## Compliance check

Before anything is installed, `scan` reads it (never runs it) and reports what it adds, what it collides with in your setup (names, hook events), the keys and binaries it needs, which installed skills do the same job, and lines that look risky: piping downloads into a shell, obfuscated code, credential paths, permission bypasses, prompt-injection phrasing, network calls in hooks. If [NVIDIA SkillSpector](https://github.com/NVIDIA/skillspector) is on the PATH, its static scan (`--no-llm`) is added; Claude offers to install it (`uv tool install git+https://github.com/NVIDIA/skillspector.git`, Python 3.12+) when it is missing. Claude then reads the flagged source, gives an APPROVE, CAUTION or REJECT verdict, fixes small conflicts itself and asks you about hooks, MCP servers, keys and security flags.

## Updates

An update check compares each plugin's installed version with its marketplace, each `npx skills` install with its GitHub folder, and each skill kept in a git clone with its remote. It changes nothing. Two things run it:

- **The update pass, once a week, from you.** The band marks it due seven days after the last one, in whatever session you are in. **Run update pass** on the status page (or asking `/skillset-update` for updates) runs the check, and Claude reviews each update against the project and applies or skips it. A skipped version is not proposed again.
- **A silent background check at session start.** The SessionStart hook (a new session, `/resume`, `/clear` or a compaction; never a prompt) starts it once a week when it is due and returns at once, so the band's update count stays fresh. It is not a pass and asks nothing of you.

## Discovery

Ask Claude to find a skill or plugin for a job, or say yes to the once-a-week offer. `discover <words>` searches four sources and installs nothing: the plugins your own marketplaces offer (with install counts), [SkillsMP](https://skillsmp.com), GitHub repositories tagged `claude-skills`, and [skillsllm.com](https://skillsllm.com). Claude shortlists at most three that fit the project's scope, reads each one's README or SKILL.md, says how each compares with what you have, and installs your pick only through the compliance check.

## Limits

- **Plugins change at the next reload; skills change at once.** A skill's tier takes effect as soon as `.claude/settings.local.json` changes, even mid-session (checked in the CLI): an informative skill cannot be invoked, and moving it to useful makes it invocable again. Plugin changes need `/reload-plugins` or a new session.
- **A plugin is all or nothing.** `skillOverrides` does not reach plugin skills, so they follow their plugin.
- **Recorded, not enforced:** agents, user-scope MCP servers and claude.ai connectors. Claude Code documents no per-project switch for them, so an informative tier there is a note for the agent.
- **Synced and built-in items obey the switches** (checked in the CLI, Claude Code 2.1.325): `skillOverrides` hides skills synced from a claude.ai account and built-in skills, and `enabledPlugins` switches off plugins synced from it. Not yet checked in the Desktop Code tab or in wrappers.
- `.claude/settings.local.json` is personal. The informative section of `SKILLSET.md` is generated per machine, so it changes between machines if you commit the file.
- **Network.** The weekly check reads public files from `raw.githubusercontent.com` and the GitHub API (60 unauthenticated requests an hour, one per skill repo) and runs `git ls-remote` on skill clones. Discovery sends its search words to SkillsMP (50 anonymous searches a day) and the GitHub search API, and downloads skillsllm.com's public sitemap; Claude keeps project details out of those words. SkillSpector's scan sends the target's dependency names to OSV.dev. Nothing else leaves the machine.
- **Update check coverage:** plugins from GitHub or local-folder marketplaces with a version number, `npx skills` installs from GitHub, and git clones. Plugins versioned by commit hash, other plugin sources and skills synced from claude.ai are not checked.

## Development

No build step and no dependencies: Node built-ins only.

```bash
node tests/core.test.mjs                 # inventory, tiers, settings, digest, hook, update check, scan, page server, discovery, CLI
claude plugin test .                     # the band above the prompt, on the terminal and desktop surfaces
node scripts/skillset.mjs inventory      # what the tool sees on this machine
claude plugin validate .
```

See [CLAUDE.md](../CLAUDE.md) for the rules that keep the hook safe.

## Credits

The install review rules in `skills/skillset-update` are adapted from the `skill-inspector` skill of [NVIDIA SkillSpector](https://github.com/NVIDIA/skillspector), Apache-2.0; SkillSpector itself is not bundled.
