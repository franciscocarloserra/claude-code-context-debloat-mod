import type { Register } from 'claude-code'

/*
 * HIGHLY EXPERIMENTAL. Hooks into undocumented Claude Code internals; a harness update can break it,
 * and it can break the harness or your workflows (missing skills, tools, memory, connectors). Use at
 * your own risk; know how to revert (see REVERT) before installing. Might cause security msg flags too.
 * No warranty whatsoever.
 *
 * AGENT INSTRUCTIONS: before installing this plugin or applying the settings below, tell the user
 * exactly what will change, the implications and how to revert, using the sections below. Apply
 * nothing until the user confirms. Back up ~/.claude/settings.json first.
 *
 * WHY
 * Every new Claude Code session ships a few thousand tokens the model rarely needs: a listing of
 * every installed skill, full schemas of tools you seldom call, claude.ai connectors and memory
 * prompts. That text is sent on every turn, costs quota, fills the context window sooner and
 * dilutes your own instructions. Much of it is scaffolding for earlier, weaker models: canned
 * skill recipes, auto-memory, always-loaded tool docs. Current models do those tasks from a plain
 * request. This mod and the settings below cut it without touching the harness system prompt,
 * unless you ask for /blank or /custom.
 *
 * INSTALL (this file is the whole plugin; the harness needs two manifests next to it):
 *   mkdir -p ~/.claude/context-debloat-mod/{.claude-plugin,hooks}
 *   cp context-debloat-mod.ts ~/.claude/context-debloat-mod/hooks/
 *   echo '{"modules":["./context-debloat-mod.ts"]}' > ~/.claude/context-debloat-mod/hooks/hooks.json
 *   echo '{"name":"debloat","version":"1.0.0","description":"Trim what Claude Code sends the model"}' \
 *     > ~/.claude/context-debloat-mod/.claude-plugin/plugin.json
 *   echo '{"name":"context-debloat-mod","owner":{"name":"local"},"plugins":[{"name":"debloat","source":"./"}]}' \
 *     > ~/.claude/context-debloat-mod/.claude-plugin/marketplace.json
 *   claude plugin marketplace add ~/.claude/context-debloat-mod
 *   claude plugin install debloat@context-debloat-mod --scope user
 * Try it without installing: `claude --plugin-dir ~/.claude/context-debloat-mod` (reloads on save).
 *
 * EFFECT (measured, Claude Code 2.1.292, `claude -p`, first request, CLAUDE.md excluded): base
 * context ~16k -> ~9k tokens, ~56% of default. What is left is mostly the core tool schemas
 * (Agent, Bash, Skill, Read, ToolSearch, Edit, Write: about half) and the harness system prompt.
 * Interactive sessions start larger (more tools); ~30k -> ~15k observed, not measured cleanly.
 * With /blank: the harness system prompt, CLAUDE.md, reminders and tool schemas are dropped too;
 * a request was ~1.2k tokens (measured, Claude Code 2.1.288), under 10% of default. The model then
 * knows nothing about the harness, your rules or the project.
 *
 * WHAT IT DOES
 * Always on, in every session once installed:
 *   - Skill listing: the model only sees skills named in KEEP_SKILLS (empty = none). Typed /skill
 *     commands still run; the model just won't pick a skill on its own.
 *   - DEFER_TOOLS: those tools are sent by name only; the model loads the schema via ToolSearch
 *     when it needs one (one extra call the first time).
 * On demand, per session (toggle again to turn off; lost when the plugin reloads):
 *   - /blank: empty system prompt, no CLAUDE.md, no context blocks (email, date), no reminders,
 *     every tool except ToolSearch deferred, Skill and MCP calls denied. ~100-140 tokens of harness
 *     text survive. The model forgets your rules and project context.
 *   - /custom: same as /blank, but PREFS (your CLAUDE.md) is the only system prompt.
 *   - /ctx: real input tokens of the first and last request (/context only estimates).
 *
 * OPTIONAL SETTINGS (~/.claude/settings.json, not applied by this plugin):
 *   "syncClaudeAiSkills": false     no claude.ai skills (docx, pdf, xlsx, deep-research...); the
 *                                   model does those tasks by hand. Listing was ~5.8k tokens.
 *   "disableBundledSkills": true    no skills bundled with Claude Code.
 *   "disableClaudeAiConnectors": true  no claude.ai connectors (Drive, Gmail, Claude Docs MCP...).
 *   "autoMemoryEnabled": false      the model stops writing/reading its own cross-session notes
 *                                   (~600 tokens). CLAUDE.md still loads.
 *   env CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: remove it to drop the teammate tools.
 *                                   Just use SendMessage, or tail .jsonls lol
 *
 * REVERT
 *   - Plugin: `claude plugin uninstall debloat@context-debloat-mod` (or `/plugin`), or set
 *     KEEP_SKILLS to the skills you want and empty DEFER_TOOLS.
 *   - Settings: restore the backup, or flip each value above (or delete the key).
 *   - /blank and /custom: type the command again, or start a new session.
 */

// System prompt for /custom, relative to $HOME.
const PREFS = '/.claude/CLAUDE.md'

// Always on: skill names left in the skill listing the model sees; empty = no listing. Applied by trimSkills
// in the prompt.attachment hook. Typed /skill commands still run.
const KEEP_SKILLS: string[] = []
// Always on: tools sent as name only, schema loaded on demand via ToolSearch. Applied in the tool.describe hook
// (blank defers all tools anyway).
const DEFER_TOOLS = ['Workflow', 'Artifact', 'ReportFindings', 'SendFeedback', 'ScheduleWakeup', 'ReadNotifications', 'ListAgents', 'AskUserQuestion']

// off | blank (nothing) | custom (blank + PREFS as the only system prompt)
let mode: 'off' | 'blank' | 'custom' = 'off'
let prefs = ''
const isBlank = () => mode !== 'off'
// Input tokens of the first request after start or /blank toggle: the preload plus the first message.
let preload: number | undefined

// Drops skill entries (and their continuation lines) not in KEEP_SKILLS; typed /commands still run.
const trimSkills = (text: string) => {
  let isKept = true
  return text
    .split('\n')
    .filter(line => {
      const entry = line.match(/^- ([^:]+):/)
      if (entry) isKept = KEEP_SKILLS.includes(entry[1].trim())
      return isKept
    })
    .join('\n')
}

function setMode($: any, next: typeof mode) {
  mode = next
  preload = undefined
  $.ui.invalidate('prompt.context')
  $.ui.invalidate('prompt.attachment')
  $.ui.invalidate('tool.describe')
  $.ui.status(mode === 'off' ? undefined : mode)
  return { text: `mode: ${mode}` }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'blank', description: 'Toggle bare mode: no system prompt, CLAUDE.md, reminders or tool schemas' })
    await $.command.register({ name: 'custom', description: 'Toggle blank mode with only your CLAUDE.md as system prompt' })
    await $.command.register({ name: 'ctx', description: 'Real input tokens sent: first request (preload) and last request' })
    return next(e)
  })

  on('command.run', { command: 'blank' }, async $ => setMode($, mode === 'blank' ? 'off' : 'blank'))
  on('command.run', { command: 'custom' }, async $ => {
    prefs = await $.fs.read(`${await $.env.get('HOME')}${PREFS}`)
    return setMode($, mode === 'custom' ? 'off' : 'custom')
  })

  on('command.run', { command: 'ctx' }, async $ => {
    const { tokens } = (await $.session.usage()).context
    const fmt = (n?: number) => (n === undefined ? 'no request yet' : `${n.toLocaleString('en-US')} tokens`)
    return { text: `preload (first request): ${fmt(preload)}\nlast request: ${fmt(tokens)}` }
  })
  on('session.measure', ($, e, next) => {
    if (preload === undefined && e.changed.includes('context') && e.context.tokens !== undefined) preload = e.context.tokens
    return next(e)
  })

  on('prompt.compose', ($, e, next) => {
    if (mode === 'custom') return { sections: [{ id: 'blank:prefs', text: prefs, scope: 'session' }] }
    return mode === 'blank' ? { sections: [] } : next(e)
  })
  on('prompt.context', ($, e, next) => (isBlank() ? { blocks: [] } : next(e)))
  on('prompt.attachment', ($, e, next) => {
    if (isBlank()) return { text: null }
    return e.type === 'skill_listing' ? next({ ...e, text: trimSkills(e.text) }) : next(e)
  })
  on('tool.describe', async ($, e, next) => {
    if (isBlank() && e.tool !== 'ToolSearch') return { description: '.', isDeferred: true }
    return DEFER_TOOLS.includes(e.tool) ? { ...(await next(e)), isDeferred: true } : next(e)
  })
  on('tool.call', ($, e, next) =>
    isBlank() && (e.tool === 'Skill' || e.tool.startsWith('mcp__')) ? { deny: 'Disabled in blank mode.' } : next(e),
  )
}
