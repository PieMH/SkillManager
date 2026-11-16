---
name: skillmanager-status
description: Open this project's skill set as a page in the browser, with its tiers, drift and pending updates, and buttons to move things between tiers, check or skip updates, and queue requests for Claude. Use when the user asks for the skill set status, the status page, or types /skillmanager-status.
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/skillmanager.mjs" *)
---

# skillmanager-status

1. **Start the page server in the background:** run `node "${CLAUDE_PLUGIN_ROOT}/scripts/skillmanager.mjs" serve` from the project root with `run_in_background`. Read its output file until the line `skillmanager-status: ready <url>` appears. If the project has no `SKILLMANAGER.md`, offer `/skillmanager-configure` instead.
2. **Open the link.** Use the session's browser panel if it has one (CCWrapper's Browser panel). Otherwise give the user the link to open. The link carries a token for this launch: show it only to the user.
3. **Tell the user how the page works, in two lines.** Tier moves and update skips apply at once. Reviews, uninstalls, alternatives and research questions go to a queue, and **Send to Claude** hands the queue to you. The page stops after 30 minutes without use.
4. **When the background task ends, read the last line of its output,** `skillmanager-queue: {"reason": …, "queue": […]}`.
   - `reason` is `sent`: handle the requests in order with the `/skillmanager-update` workflows. An `update` gets reviewed, then applied or skipped. `updates` is the update pass from the page: the check has just run, so review every pending update from `check --cached`. An `uninstall` is confirmed with the user first. For `similar`, run the Discover job on the id's job and compare the candidates with it. For `research`, answer the text, running Discover when it asks for a skill or plugin.
   - `reason` is `idle` with an empty queue: say the page closed and stop.
5. **Offer to open the page again** when you are done.
