// The skillset band: one row above the prompt with the board one click away, and a mark once the weekly
// update pass is due, seen mid-session with no new session needed. It reads two files and runs the
// plugin's own commands, as if typed; it writes nothing. Each plugin has its own row, so ponytail's stays.
import type { EngineInterface, Register } from 'claude-code'

const WEEK = 7 * 24 * 3600 * 1000
const DAY = 24 * 3600 * 1000

type Seen = { tiered: boolean; dismissed: boolean; pending: number; due: boolean; days: number | null }
type Update = { id: string; latest: string }
type State = { passAt?: string; updates?: Update[]; skipped?: Record<string, { latest: string }>; dismissed?: string[] }

// The profile's config dir, as Claude Code and the plugin's scripts resolve it. Windows sets USERPROFILE.
async function configDir($: EngineInterface): Promise<string> {
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  if (dir) return dir
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  return `${home}/.claude`
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

// What the band shows, from the project's SKILLSET.md and the profile's state file. Missing files read as
// "nothing yet": an untiered project, no update pass so far.
export async function look($: EngineInterface): Promise<Seen> {
  const cwd = await $.session.cwd()
  const tiered = await $.fs.exists(`${cwd}/SKILLSET.md`).catch(() => false)
  let state: State = {}
  try { state = JSON.parse(await $.fs.read(`${await configDir($)}/skillset/state.json`)) as State } catch { /* none yet */ }
  const skipped = state.skipped ?? {}
  const pending = (state.updates ?? []).filter(u => skipped[u.id]?.latest !== u.latest).length
  const passAt = Date.parse(state.passAt ?? '')
  const now = await $.clock.now()
  return {
    tiered,
    dismissed: (state.dismissed ?? []).some(d => norm(d) === norm(cwd)),
    pending,
    due: Number.isNaN(passAt) || now - passAt > WEEK,
    days: Number.isNaN(passAt) ? null : Math.floor((now - passAt) / DAY),
  }
}

export const register: Register = on => {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const s = await look($)
    if (!s.tiered && s.dismissed) return next(e) // the person declined tiering here: no row

    const { Box, Text, Button } = $.ui.resolve(e)
    // Queued by the engine and run once the session is idle, so a click never cuts into a turn.
    const run = (command: string) => () => {
      void $.command.run({ command }).catch(() => $.ui.toast(`skillset: could not run /${command}`))
    }

    if (!s.tiered) {
      return (
        <Box flexDirection="row" alignItems="center" gap={2} width={e.props.bodyColumns}>
          <Text dimColor>skillset</Text>
          <Text dimColor>every installed skill loads here</Text>
          <Box flexGrow={1} />
          <Button key="configure" plain label="Set up tiers" onPress={run('skillset:skillset-configure')} />
        </Box>
      )
    }

    const last = s.days === null ? 'never run' : `last ${s.days} days ago`
    return (
      <Box flexDirection="row" alignItems="center" gap={2} width={e.props.bodyColumns}>
        <Text dimColor>skillset</Text>
        {s.pending > 0 && <Text>{s.pending} {s.pending === 1 ? 'update' : 'updates'}</Text>}
        {s.due && <Text color="warning">update pass due</Text>}
        {s.due && <Text dimColor>{last}</Text>}
        <Box flexGrow={1} />
        <Button
          key="board"
          label="Skill set"
          {...(s.due ? { variant: 'primary' as const } : { plain: true as const })}
          onPress={run('skillset:skillset-status')}
        />
      </Box>
    )
  }).catch(($, e, next) => next(e)) // a band that fails draws nothing of its own; the session goes on
}
