// agent-dock
//   Every prompt you type asks how many helper agents Claude may use for it
//   A picker pane opens: 1, 5, 10, 15, 20, 50 or 60. Up/Down choose, Enter confirms,
//   Esc keeps the current limit.
//   /agent-dock            open a pane listing every helper agent, its current task and its tokens;
//                          Up/Down move between agents, Enter expands one, Esc closes the pane
//   /agent-dock limit      open the picker to choose how many helper agents Claude may use
//   /agent-dock auto | none | <number>   set the limit directly
//   /agent-dock ask on | off             turn the question on each prompt on or off
// Each helper agent has its own color. While Claude works, a band above the prompt shows
// the helpers with a cycling RGB title; the pane's title cycles too.
// The spinner of each helper agent also shows its task and token count.

const PANE = 'agent-dock'
// The pane that asks how many helper agents to use
const PICKER = 'agent-dock-pick'
// What the picker offers
const CHOICES = [1, 5, 10, 15, 20, 50, 60]
const TITLE = 'AGENT DOCK'
// How often the RGB animation moves (the engine redraws at most ten times a second)
const FRAME_MS = 100

// Helper agents Claude has started, keyed by agent id.
// Each: { id, name, task, status: 'running' | 'done', tokens, hue }
const agents = new Map()
// Descriptions from agent.spawn that haven't been matched to an agent id yet
const pendingSpawns = []
// Tokens spent by the main conversation (not a helper)
let mainTokens = 0
// null = Claude decides, otherwise the maximum number of helper agents
let requestedCount = null
// Ask how many helpers with every prompt you type
let askEachPrompt = true
// The agent whose details are expanded in the pane
let expandedId = null
// Animation state: the hue offset, whether a turn is running, whether the pane is open
let phase = 0
let working = false
let paneOpen = false
let ticker = null
// The open picker: { question, resolve }, or null when it isn't open
let pick = null

const helpers = () => Array.from(agents.values())
const runningCount = () => helpers().filter((a) => a.status === 'running').length
const helperTokens = () => helpers().reduce((sum, a) => sum + a.tokens, 0)
const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n))
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const plural = (n) => n + ' helper agent' + (n === 1 ? '' : 's')

// ---- colors ----

// Hue (0-360), saturation and value (0-1) to a #rrggbb string
function hsv(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6
    const c = v - v * s * Math.max(0, Math.min(k, 4 - k, 1))
    return Math.round(c * 255).toString(16).padStart(2, '0')
  }
  return '#' + f(5) + f(3) + f(1)
}

// Each helper gets its own hue, spread by the golden angle so neighbours never look alike
const agentHue = (index) => (index * 137.5 + 200) % 360
// Running helpers shimmer in their own color; finished ones settle to a steady shade
const agentColor = (a) =>
  a.status === 'running'
    ? hsv(a.hue, 0.75, 0.8 + 0.2 * Math.sin((phase + a.hue) / 3))
    : hsv(a.hue, 0.45, 0.7)
// Token counts go green, then yellow, then red as they grow
const tokenColor = (n) => (n < 10000 ? 'success' : n < 50000 ? 'warning' : 'error')
const limitColor = () =>
  requestedCount === null ? 'suggestion' : requestedCount === 0 ? 'error' : 'success'

// One Text per letter, each a step further round the color wheel; the wheel turns with `phase`
function rainbow(Text, text) {
  return Array.from(text).map((ch, i) =>
    Text({ bold: true, color: hsv((phase * 12 + i * 24) % 360, 0.85, 1), children: [ch] }),
  )
}

// Keep the animation going only while something on screen moves
function startTicker($) {
  ticker?.cancel()
  ticker = $.clock.every(FRAME_MS, () => {
    if (!working && !paneOpen && !pick && runningCount() === 0) return
    phase = (phase + 1) % 3600
    $.ui.invalidate('ui.render')
  })
}

// ---- agents ----

function newAgent(id, name, task) {
  const agent = {
    id,
    name: name || 'helper-' + (agents.size + 1),
    task: task || 'starting…',
    status: 'running',
    tokens: 0,
    hue: agentHue(agents.size),
  }
  agents.set(id, agent)
  return agent
}

// Get (or create) the entry for a helper agent the first time we see its id
function entryFor(id) {
  const agent = agents.get(id)
  if (agent) return agent
  const spawn = pendingSpawns.shift()
  return newAgent(id, spawn?.name, spawn?.task)
}

// A short description of what a tool call is doing
function describeCall(e) {
  const detail = e.description || e.command || e.file_path || e.pattern || e.url || e.query || ''
  return clip(oneLine(e.tool + (detail ? ': ' + detail : '')), 80)
}

// ---- the limit ----

// Turn an answer ('auto', 'none', '3', 'Let Claude decide', ...) into a helper limit.
// Returns undefined when the answer isn't one we understand.
function parseLimit(answer) {
  const s = oneLine(answer).toLowerCase()
  if (s === 'auto' || s === 'let claude decide') return null
  if (s === 'none' || s === 'off' || s === '0') return 0
  if (/^\d+$/.test(s)) return parseInt(s, 10)
  return undefined
}

const limitShort = () =>
  requestedCount === null ? 'Claude decides' : requestedCount === 0 ? 'none' : 'up to ' + requestedCount

const limitText = () => 'Helper agents: ' + limitShort() + '.'

// Small limits green, middling yellow, large red
const choiceColor = (n) => (n <= 5 ? 'success' : n <= 20 ? 'warning' : 'error')

// End the open picker with a number, or undefined when it was closed without one
function finishPick(value) {
  const p = pick
  pick = null
  p?.resolve(value)
}

// Open the picker pane and wait for a choice. Resolves to the number picked,
// or undefined when it is closed (Esc) or can't be shown.
function pickLimit($, question) {
  finishPick(undefined)
  return new Promise((resolve) => {
    pick = { question, resolve }
    $.ui
      .open({ id: PICKER, title: 'Helper agents', focus: true, closeOnEscape: true, holdToasts: true, rows: 7 })
      .then((opened) => {
        if (!opened?.isPlaced && pick?.resolve === resolve) finishPick(undefined)
      })
      .catch(() => {
        if (pick?.resolve === resolve) finishPick(undefined)
      })
    $.ui.invalidate('ui.render')
  })
}

// Claude Code calls this once when the mod loads
export function register(on) {
  // Runs when the session starts, before your first prompt.
  // (/agents is built into Claude Code, so the mod uses /agent-dock instead.)
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'agent-dock',
        description: 'Open the agent dock, or set how many helper agents Claude may use',
        argumentHint: '[limit | auto | none | <number> | ask on | ask off]',
      })
    } catch (err) {
      $.ui.toast('agent-dock: could not add /agent-dock: ' + (err?.message ?? err))
    }
    startTicker($)
    return next(e)
  })

  on('command.run', { command: 'agent-dock' }, async ($, e) => {
    const args = oneLine(e.args).toLowerCase()

    if (args === '' || args === 'open') {
      await $.ui.open({ id: PANE, title: 'Agent dock', focus: true, closeOnEscape: true })
      paneOpen = true
      return {}
    }

    if (args === 'ask on' || args === 'ask off') {
      askEachPrompt = args === 'ask on'
      return {
        text: askEachPrompt
          ? 'agent-dock will ask how many helper agents to use with each prompt.'
          : 'agent-dock will stop asking. ' + limitText() + ' (/agent-dock ask on to ask again)',
      }
    }

    if (args === 'limit') {
      const picked = await pickLimit($, 'How many helper agents should Claude use?')
      if (picked === undefined) return { text: 'Helper agents unchanged. ' + limitText() }
      requestedCount = picked
      return { text: limitText() }
    }

    const answer = args
    const limit = parseLimit(answer)
    if (limit === undefined) {
      return {
        text:
          'agent-dock: "' + answer + '" is not a limit. ' +
          'Use /agent-dock limit, /agent-dock auto, /agent-dock none, /agent-dock <number> or /agent-dock ask on|off.',
      }
    }
    requestedCount = limit
    return { text: limitText() }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) paneOpen = false
    // Esc or the close mark on the picker: keep the current limit
    if (e.id === PICKER) finishPick(undefined)
    return next(e)
  })

  // Ask how many helpers with each prompt you type, then tell Claude (only Claude reads the hint)
  on('prompt.submit', async ($, e, next) => {
    const typed = e.origin?.kind === 'composer' || e.origin?.kind === 'bridge'
    if (askEachPrompt && typed && !e.text.trimStart().startsWith('/')) {
      const picked = await pickLimit($, 'How many helper agents should Claude use for this prompt?')
      // Closed without a choice: keep the current limit
      if (picked !== undefined) requestedCount = picked
    }

    working = true
    $.ui.invalidate('ui.render')
    if (requestedCount === null) return next(e)
    const hint =
      requestedCount === 0
        ? 'The user does not want helper agents for this prompt. Do the work yourself.'
        : 'The user wants at most ' + plural(requestedCount) + ' running at once for this prompt.'
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
              plural(requestedCount) +
              ' at a time. Wait for one to finish or do this work yourself.',
      }
    }
    // Remember the task so we can attach it once the agent's id shows up
    const task = clip(oneLine(e.description || e.prompt || e.task || ''), 80)
    const name = e.name || e.type || e.agentType || e.subagent_type
    if (e.agentId) newAgent(e.agentId, name, task)
    else pendingSpawns.push({ name, task })
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

  // A helper agent finished its turn, or the main turn ended
  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      const agent = entryFor(e.agentId)
      agent.status = 'done'
      agent.task = 'done'
    } else {
      working = false
    }
    $.ui.invalidate('ui.render')
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

  // The band above the prompt while Claude works: RGB title, the limit, one colored chip per helper
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (!e.props.isWorking && runningCount() === 0)) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const chips = helpers()
      .filter((a) => a.status === 'running')
      .map((a) => Text({ color: agentColor(a), children: [' ● ' + clip(a.name, 18)] }))
    return Box({
      flexDirection: 'row',
      children: [
        ...rainbow(Text, TITLE),
        Text({ dimColor: true, children: [' · limit '] }),
        Text({ color: limitColor(), bold: true, children: [limitShort()] }),
        Text({ dimColor: true, children: [' · helpers ' + runningCount() + '/' + agents.size] }),
        ...chips,
      ],
    })
  })

  // The picker: the question, a color scale of the choices, and the Select itself
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PICKER) return next(e)
    const { Box, Text, Select } = $.ui.resolve(e)
    const current = CHOICES.includes(requestedCount) ? requestedCount : 5
    const scale = CHOICES.flatMap((n, i) => [
      ...(i ? [Text({ dimColor: true, children: [' · '] })] : []),
      Text({ color: choiceColor(n), bold: n === current, children: [String(n)] }),
    ])
    return Box({
      flexDirection: 'column',
      children: [
        Box({ flexDirection: 'row', children: rainbow(Text, TITLE) }),
        Text({ bold: true, children: [pick?.question ?? 'How many helper agents should Claude use?'] }),
        Box({ flexDirection: 'row', children: [Text({ dimColor: true, children: ['few '] }), ...scale, Text({ dimColor: true, children: [' many'] })] }),
        Select({
          key: 'helper-count',
          label: 'Helper agents: ',
          options: CHOICES.map((n) => ({ value: String(n), label: plural(n) })),
          value: String(current),
          autoFocus: true,
          onSelect: (value) => {
            finishPick(parseInt(value, 10))
            $.ui.close({ id: PICKER }).catch(() => {})
          },
        }),
        Text({ dimColor: true, children: ['↑/↓ choose · Enter confirm · Esc keep ' + limitShort()] }),
      ],
    })
  })

  // The dock pane: one row per helper agent, each in its own color
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const redraw = () => $.ui.invalidate('ui.render')
    const list = helpers()
    const total = mainTokens + helperTokens()

    const header = Box({
      flexDirection: 'row',
      children: [
        ...rainbow(Text, TITLE),
        Text({ dimColor: true, children: ['  ' + runningCount() + ' running · limit '] }),
        Text({ color: limitColor(), bold: true, children: [limitShort()] }),
        Text({ dimColor: true, children: [' · helpers '] }),
        Text({ color: tokenColor(helperTokens()), children: [fmt(helperTokens())] }),
        Text({ dimColor: true, children: [' · total '] }),
        Text({ color: tokenColor(total), children: [fmt(total) + ' tokens'] }),
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

    // Up and Down move focus between the buttons, Enter presses the focused one
    const rows = list.flatMap((a) => {
      const color = agentColor(a)
      const running = a.status === 'running'
      const row = Box({
        key: 'row-' + a.id,
        flexDirection: 'row',
        children: [
          Text({ color: running ? color : 'success', children: [running ? '● ' : '✓ '] }),
          Button({
            key: 'agent-' + a.id,
            plain: true,
            dimColor: !running,
            label: a.name,
            onPress: () => {
              expandedId = expandedId === a.id ? null : a.id
              redraw()
            },
          }),
          Text({ color, dimColor: !running, children: [' · ' + clip(a.task, 60) + ' · '] }),
          Text({ color: tokenColor(a.tokens), children: [fmt(a.tokens) + ' tokens'] }),
        ],
      })
      if (expandedId !== a.id) return [row]
      return [
        row,
        Box({
          flexDirection: 'column',
          paddingLeft: 4,
          children: [
            Text({ color, children: ['Task: ' + a.task] }),
            Text({ color: running ? 'warning' : 'success', children: ['Status: ' + a.status] }),
            Text({ color: tokenColor(a.tokens), children: ['Tokens: ' + a.tokens] }),
          ],
        }),
      ]
    })

    return Box({
      flexDirection: 'column',
      children: [header, Text({ dimColor: true, children: ['↑/↓ move · Enter expand · Esc close'] }), ...rows],
    })
  })
}
