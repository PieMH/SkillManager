---
name: skillmanager-configure
description: Set up or redo this project's SKILLMANAGER.md, the file that tiers which skills, plugins, MCP servers and agents load every session (essential), on demand (useful) or stay off (informative). Use when a project has no SKILLMANAGER.md, when the user asks to configure or tier the project's skills, plugins or stack, or types /configureThisProjectSkills.
argument-hint: "[what this project is for]"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/skillmanager.mjs" *)
---

# skillmanager-configure

Arguments: $ARGUMENTS

Tool: `node "${CLAUDE_PLUGIN_ROOT}/scripts/skillmanager.mjs" <command>`, run from the project root. It reads what is installed from disk and writes two files: `SKILLMANAGER.md` and `.claude/settings.local.json`. It never touches user-level settings.

## What a tier does

| Kind | essential | useful | informative |
|---|---|---|---|
| Skill | listed with its description | listed by name only; the session-start digest carries its one-liner | hidden and not invocable |
| Plugin (all its skills, hooks, agents and MCP together) | enabled | disabled here, named in the digest with its enable command | disabled here |
| MCP server from `.mcp.json` | enabled | enabled; its tools are deferred anyway | disabled here |
| Agent, user-scope MCP server, connector | recorded | recorded | recorded only: no documented per-project switch |

A plugin cannot be split: its skills go where the plugin goes. Nothing is unloaded from a running session. Skill changes apply when the settings file reloads; plugin changes need `/reload-plugins` or a new session.

## Steps

1. **Scope.** Use the arguments if given. Otherwise read CLAUDE.md and the README, write one paragraph on what this project is for and what stack it uses, and ask the user to confirm or correct it. In an empty project, ask the user directly. Wait for the answer.
2. **Inventory.** Run `inventory`. If `SKILLMANAGER.md` already exists, also run `status` and read the file: this is a re-tier, so in step 6 use `move` instead of `init`.
3. **What the tool cannot see.** From your own tool and skill lists add: claude.ai connectors as `connector:<server name>`, and built-in skills worth tiering as `builtin:<name>`. If CLAUDE.md already describes a skill list or points at a skills file, read it and carry its choices over.
4. **Propose tiers**, judged against the scope:
   - essential: needed in most sessions here. Keep it short, ten or fewer. Anything with hooks that is enabled at user scope stays essential unless the user says otherwise: those are global choices.
   - useful: plausible for some tasks in this project.
   - informative: everything else. A thing never used (`used` is absent from its line) goes here unless the scope clearly needs it.
5. **Show and ask.** One table: essential and useful in full with the reason for each, informative as a count plus the names the user might miss. Say what changes from today (everything loads today). Ask what to change. Wait for the answer.
6. **Write.** New file: `init --essential <id,id> --useful <id,id>`; everything else installed goes to informative. Existing file: `move <essential|useful|informative|none> <id> [<id>...]` for each change, which keeps the notes already written. Then edit `SKILLMANAGER.md`: fill in the `Scope:` line, and for essential and useful lines sharpen `Use:` and `Config:` with what matters in this project. Keep each item on one line and keep the backticked id unchanged. Add `connector:` and `builtin:` lines by hand in the section they belong to, then run `apply`.
7. **CLAUDE.md.** Add this block once, replacing an older copy between the markers. If there is no CLAUDE.md, run the built-in `init` skill first, or write a short one with the scope if that skill is unavailable.

   ```markdown
   <!-- skillmanager:start -->
   ## SkillManager
   This project's skills, plugins, MCP servers and agents are tiered in `SKILLMANAGER.md`: essential loads every session, useful is pulled in on demand, informative is installed but off here. Read it before saying a capability is missing, and change tiers with `/skillmanager-update` rather than by installing things again.
   <!-- skillmanager:end -->
   ```

   Do not `@`-import `SKILLMANAGER.md`: an import loads the whole file every session.
8. **Report.** List the changes the tool printed, which of them need `/reload-plugins` or a new session, and anything it reported as recorded but not switched off. Suggest running `/context` in a new session to compare the skill and MCP figures. `.claude/settings.local.json` is personal: if the project is a git repo and that file is not ignored, say so.

If the user declines configuration, run `dismiss` and do not offer again in this project.
