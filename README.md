<p align="center">
  <img src="assets/logo.svg" width="112" height="112" alt="skillset logo: three bars of falling length, coral, light grey and dark grey">
</p>

<h1 align="center">skillset</h1>

<p align="center">
  <b>Load what this project needs. Keep the rest one click away.</b><br>
  Per-project tiers for the skills, plugins and MCP servers Claude Code loads.
</p>

---

Everything you install in Claude Code loads in every project. Fifty skills in, each session pays for all of them, and Claude starts missing the ones that matter, because their descriptions get cut from an overflowing listing.

skillset gives each project a `SKILLSET.md` with three tiers and applies it through Claude Code's own settings:

| | |
|---|---|
| **Essential** | Loads in every session. |
| **Useful** | Named for Claude and pulled in when a task needs it. |
| **Informative** | Installed but switched off here. Claude still knows it exists. |

On the author's setup the skill listing went from 10k tokens to 735.

## Install

```bash
claude plugin marketplace add PieMH/SkillManager
claude plugin install skillset@skillset
```

Needs Node 18 or newer. Works in the CLI, the Desktop app's Code tab and wrappers around the CLI.

## Use

1. **Open a project.** Claude offers to tier it once. Say yes, or run `/skillset-configure`.
2. **Click Skill set** above the prompt. The board opens: move things between tiers, see what is pending, ask Claude to find a skill for a job.
3. **Once a week the button lights up.** Run the update pass and Claude reviews what changed upstream before anything is applied.

| Command | What it does |
|---|---|
| `/skillset-configure` | Tiers this project: asks what it is for, proposes, writes `SKILLSET.md`. |
| `/skillset-update` | Finds, installs, removes, re-tiers and updates. Claude also uses it when you ask in plain words. |
| `/skillset-status` | Opens the board. |

## Safe by default

- **Nothing is installed without your yes.** Each candidate is read, never run, and scanned for risky hooks, credential grabs and prompt injection. [NVIDIA SkillSpector](https://github.com/NVIDIA/skillspector) joins in when it is installed.
- **One file is written:** this project's `.claude/settings.local.json`, and only the entries `SKILLSET.md` lists. Never your user settings.
- **The board stays on your machine:** 127.0.0.1, a one-time token, nothing loaded from the network.

**[How it works, limits and network use →](docs/how-it-works.md)**

<sub>MIT · zero dependencies · built for Claude Code</sub>
