// agent-dock
//   /agent-dock        open a pane listing every helper agent, its current task and its tokens;
//                      Up/Down move between agents, Enter expands one, Esc closes the pane
//   /agent-dock limit  pick how many helper agents Claude may use (a number, or let Claude decide)
//                      (or set it directly: /agent-dock auto | none | <number>)
// The spinner of each helper agent also shows its task and token count.

const PANE = 'agent-dock'
const MAIN = 'main'

// Helper agents Claude has started, keyed by agent id.
// Each: { id, name, task, status: 'running' | 'done', tokens }
const agents = new Map()
// Descriptions from agent.spawn that haven't been matched to an agent id yet
const pendingSpawns = []
// Tokens spent by the main conversation (not a helper)
let mainTokens = 0
// null = Claude decides, otherwise the maximum number of helper agents
let requestedCount = null
// The agent whose details are expanded in the pane
let expandedId = null

const helpers = () => Array.from(agents.values())
const runningCount = () => helpers().filter((a) => a.status === 'running').length
const helperTokens = () => helpers().reduce((sum, a) => sum + a.tokens, 0)
const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n))
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

// Get (or create) the entry for a helper agent the first time we see its id
function entryFor(id) {
  let agent = agents.get(id)
  if (!agent) {
    const spawn = pendingSpawns.shift()
    agent = {
      id,
      name: spawn?.name || 'helper-' + (agents.size + 1),
      task: spawn?.task || 'starting…',
      status: 'running',
      tokens: 0,
    }
    agents.set(id, agent)
  }
  return agent
}

// A short description of what a tool call is doing
function describeCall(e) {
  const detail = e.description || e.command || e.file_path || e.pattern || e.url || e.query || ''
  return clip(oneLine(e.tool + (detail ? ': ' + detail : '')), 80)
}

// Turn an answer ('auto', 'none', '3', 'Let Claude decide', ...) into a helper limit.
// Returns undefined when the answer isn't one we understand.
function parseLimit(answer) {
  const s = oneLine(answer).toLowerCase()
  if (s === 'auto' || s === 'let claude decide') return null
  if (s === 'none' || s === 'off' || s === '0') return 0
  if (/^\d+$/.test(s)) return parseInt(s, 10)
  return undefined
}

const limitText = () =>
  requestedCount === null
    ? 'Helper agents: Claude decides.'
    : requestedCount === 0
      ? 'Helper agents: none.'
      : 'Helper agents: up to ' + requestedCount + '.'

// Claude Code calls this once when the mod loads
export function register(on) {
  // Runs when the session starts, before your first prompt.
  // (/agents is built into Claude Code, so the mod uses /agent-dock instead.)
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'agent-dock',
        description: 'Open the agent dock, or set how many helper agents Claude may use',
        argumentHint: '[limit | auto | none | <number>]',
      })
    } catch (err) {
      $.ui.toast('agent-dock: could not add /agent-dock: ' + (err?.message ?? err))
    }
    return next(e)
  })

  // /agent-dock              open the dock pane (Up/Down and Enter work at once)
  // /agent-dock limit        ask how many helper agents Claude may use
  // /agent-dock auto|none|N  set the limit directly
  on('command.run', { command: 'agent-dock' }, async ($, e) => {
    const args = oneLine(e.args).toLowerCase()

    if (args === '' || args === 'open') {
      await $.ui.open({ id: PANE, title: 'Agent dock', focus: true, closeOnEscape: true })
      return {}
    }

    let answer = args
    if (args === 'limit') {
      try {
        // ask takes 2-4 options; "Other" lets the user type any number
        answer = await $.ui.ask('How many helper agents should Claude use?', [
          'Let Claude decide',
          'None',
          '2',
          '4',
        ])
      } catch {
        return { text: 'Helper agents unchanged. ' + limitText() }
      }
    }

    const limit = parseLimit(answer)
    if (limit === undefined) {
      return {
        text:
          'agent-dock: "' + answer + '" is not a limit. ' +
          'Use /agent-dock limit, /agent-dock auto, /agent-dock none or /agent-dock <number>.',
      }
    }
    requestedCount = limit
    return { text: limitText() }
  })

  // Tell Claude the user's choice with every prompt (only Claude reads this)
  on('prompt.submit', async ($, e, next) => {
    if (requestedCount === null) return next(e)
    const hint =
      requestedCount === 0
        ? 'The user does not want helper agents. Do the work yourself.'
        : 'The user wants at most ' +
          requestedCount +
          ' helper agent' +
          (requestedCount === 1 ? '' : 's') +
          ' running at once.'
    return next({ ...e, context: [...(e.context ?? []), hint] })
  })

  // Enforce the limit when Claude tries to start a helper agent
  on('agent.spawn', async ($, e, next) => {
    if (requestedCount !== null && runningCount() + pendingSpawns.length >= requestedCount) {
      return {
        deny:
          requestedCount === 0
            ? 'The user turned off helper agents. Do this work yourself.'
            : 'The user allows at most ' +
              requestedCount +
              ' helper agent' +
              (requestedCount === 1 ? '' : 's') +
              ' at a time. Wait for one to finish or do this work yourself.',
      }
    }
    // Remember the task so we can attach it once the agent's id shows up
    const task = oneLine(e.description || e.prompt || e.task || '')
    const name = e.name || e.type || e.agentType || e.subagent_type
    if (e.agentId) {
      agents.set(e.agentId, {
        id: e.agentId,
        name: name || 'helper-' + (agents.size + 1),
        task: clip(task || 'starting…', 80),
        status: 'running',
        tokens: 0,
      })
    } else {
      pendingSpawns.push({ name, task: clip(task, 80) })
    }
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // Each tool call shows what that helper agent is doing right now
  on('tool.call', async ($, e, next) => {
    if (e.agentId) {
      entryFor(e.agentId).task = describeCall(e)
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  // Every request to the model reports its token usage, for the main agent or a helper
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (result?.usage) {
      const used = (result.usage.input_tokens || 0) + (result.usage.output_tokens || 0)
      if (e.agentId) entryFor(e.agentId).tokens += used
      else mainTokens += used
      $.ui.invalidate('ui.render')
    }
    return result
  })

  // A helper agent finished its turn
  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      const agent = entryFor(e.agentId)
      agent.status = 'done'
      agent.task = 'done'
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  // The spinner is drawn once per agent (requestId is the agent id): add its task and tokens
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const agent = agents.get(e.requestId)
    if (!agent) {
      // The main agent: show how many helpers are running and the session total
      if (agents.size === 0) return next(e)
      const total = mainTokens + helperTokens()
      const suffix =
        ' · helpers: ' + runningCount() + '/' + agents.size + ' · ' + fmt(total) + ' tokens'
      return next({ ...e, props: { ...e.props, suffix } })
    }
    const suffix = ' · ' + agent.task + ' · ' + fmt(agent.tokens) + ' tokens'
    return next({ ...e, props: { ...e.props, suffix } })
  })

  // The dock pane: one row per helper agent
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const redraw = () => $.ui.invalidate('ui.render')
    const list = helpers()

    const header = Text({
      bold: true,
      children: [
        'Helper agents · ' +
          runningCount() +
          ' running · ' +
          fmt(helperTokens()) +
          ' helper tokens · ' +
          fmt(mainTokens + helperTokens()) +
          ' total',
      ],
    })

    if (list.length === 0) {
      return Box({
        flexDirection: 'column',
        children: [
          header,
          Text({ dimColor: true, children: ['No helper agents yet. /agent-dock limit sets how many Claude may use.'] }),
        ],
      })
    }

    // Up and Down move focus between these buttons, Enter presses the focused one
    const rows = list.flatMap((a) => {
      const mark = a.status === 'running' ? '●' : '✓'
      const row = Button({
        key: 'agent-' + a.id,
        plain: true,
        dimColor: a.status === 'done',
        label: mark + ' ' + a.name + ' · ' + clip(a.task, 60) + ' · ' + fmt(a.tokens) + ' tokens',
        onPress: () => {
          expandedId = expandedId === a.id ? null : a.id
          redraw()
        },
      })
      if (expandedId !== a.id) return [row]
      return [
        row,
        Box({
          flexDirection: 'column',
          paddingLeft: 4,
          children: [
            Text({ children: ['Task: ' + a.task] }),
            Text({ children: ['Status: ' + a.status] }),
            Text({ children: ['Tokens: ' + a.tokens] }),
          ],
        }),
      ]
    })

    return Box({
      flexDirection: 'column',
      children: [
        header,
        Text({ dimColor: true, children: ['↑/↓ move · Enter expand · Esc close'] }),
        ...rows,
      ],
    })
  })
}