// prompt-editor
//   Every prompt you type opens an editor pane before it is sent to Claude.
//   In the pane:
//     - toggle add-on instructions ("Plan before editing", "Add or update tests", ...)
//     - choose how many helper agents Claude may use for the prompt
//     - see a live preview of exactly what will be sent
//   Up/Down move between buttons, Enter toggles or sends, Esc sends the prompt as you typed it.
//   Your toggles are remembered for the next prompt until you change them or /prompt-editor reset.
//
//   /prompt-editor                 show the current settings
//   /prompt-editor on | off        turn the editor pane on or off
//   /prompt-editor reset           clear the remembered add-ons
//   /prompt-editor auto | none | <number>   set the helper-agent limit directly

const PANE = 'prompt-editor'
const TITLE = 'PROMPT EDITOR'

// Add-on instructions the editor can append to a prompt
const EDITS = [
  { id: 'concise', label: 'Keep the answer short', text: 'Keep the answer short.' },
  { id: 'steps', label: 'Explain step by step', text: 'Explain your reasoning step by step.' },
  {
    id: 'plan',
    label: 'Plan before editing',
    text: 'Before changing any files, show me a short plan and wait for my go-ahead.',
  },
  { id: 'tests', label: 'Add or update tests', text: 'Add or update tests for what you change, and run them.' },
  {
    id: 'minimal',
    label: 'Smallest change',
    text: 'Make the smallest change that does this; do not refactor unrelated code.',
  },
  { id: 'ask', label: 'Ask if unclear', text: 'If anything is unclear, ask me before you start.' },
]

// What the helper-agent button cycles through (null = Claude decides, 0 = none)
const LIMITS = [null, 0, 1, 5, 10, 15, 20, 50, 60]
// How many lines of the preview the pane shows
const PREVIEW_LINES = 8

// Add-ons that are switched on; remembered between prompts
const chosen = new Set()
// null = Claude decides, otherwise the maximum number of helper agents
let requestedCount = null
// Open the editor for each prompt you type
let editorOn = true
// The prompt being edited: { text, resolve }, or null when the editor isn't open
let editing = null

// Helper agents that are running, and spawns not yet matched to an agent id
const running = new Set()
let pendingSpawns = 0

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const plural = (n) => n + ' helper agent' + (n === 1 ? '' : 's')

// ---- the prompt ----

// The prompt with the chosen add-ons appended, in the order they are listed
function compose(text) {
  const extras = EDITS.filter((edit) => chosen.has(edit.id)).map((edit) => edit.text)
  const base = String(text ?? '').trimEnd()
  return extras.length ? base + '\n\n' + extras.join('\n') : base
}

// ---- the limit ----

// Turn an answer ('auto', 'none', '3', ...) into a helper limit; undefined if not understood
function parseLimit(answer) {
  const s = oneLine(answer).toLowerCase()
  if (s === 'auto') return null
  if (s === 'none' || s === '0') return 0
  if (/^\d+$/.test(s)) return parseInt(s, 10)
  return undefined
}

const limitShort = () =>
  requestedCount === null ? 'Claude decides' : requestedCount === 0 ? 'none' : 'up to ' + requestedCount
const limitText = () => 'Helper agents: ' + limitShort() + '.'
const limitColor = () =>
  requestedCount === null ? 'suggestion' : requestedCount === 0 ? 'error' : requestedCount <= 5 ? 'success' : 'warning'

function nextLimit() {
  const i = LIMITS.indexOf(requestedCount)
  requestedCount = LIMITS[(i + 1) % LIMITS.length]
}

function limitHint() {
  if (requestedCount === null) return null
  return requestedCount === 0
    ? 'The user does not want helper agents for this prompt. Do the work yourself.'
    : 'The user wants at most ' + plural(requestedCount) + ' running at once for this prompt.'
}

function statusText() {
  const addOns = EDITS.filter((edit) => chosen.has(edit.id)).map((edit) => edit.label)
  return (
    'Prompt editor: ' + (editorOn ? 'on' : 'off') + '. ' +
    limitText() + ' Add-ons: ' + (addOns.length ? addOns.join(', ') : 'none') + '.'
  )
}

// ---- the editor pane ----

// End the edit: `sendEdited` true sends the composed prompt, false sends it as typed
function finishEdit(sendEdited) {
  const current = editing
  editing = null
  current?.resolve(sendEdited)
}

// Open the editor and wait. Resolves true for Send, false when closed with Esc or not shown.
function editPrompt($, text) {
  finishEdit(false)
  return new Promise((resolve) => {
    editing = { text, resolve }
    $.ui
      .open({ id: PANE, title: 'Prompt editor', focus: true, closeOnEscape: true, holdToasts: true, rows: 20 })
      .then((opened) => {
        if (!opened?.isPlaced && editing?.resolve === resolve) finishEdit(false)
      })
      .catch(() => {
        if (editing?.resolve === resolve) finishEdit(false)
      })
    $.ui.invalidate('ui.render')
  })
}

// Claude Code calls this once when the mod loads
export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'prompt-editor',
        description: 'Edit each prompt before it is sent, or change the prompt editor settings',
        argumentHint: '[on | off | reset | auto | none | <number>]',
      })
    } catch (err) {
      $.ui.toast('prompt-editor: could not add /prompt-editor: ' + (err?.message ?? err))
    }
    return next(e)
  })

  on('command.run', { command: 'prompt-editor' }, async ($, e) => {
    const args = oneLine(e.args).toLowerCase()

    if (args === '' || args === 'status') return { text: statusText() }

    if (args === 'on' || args === 'off') {
      editorOn = args === 'on'
      return {
        text: editorOn
          ? 'The prompt editor will open for each prompt you type.'
          : 'The prompt editor is off. Prompts are sent as typed. (/prompt-editor on to turn it back on)',
      }
    }

    if (args === 'reset') {
      chosen.clear()
      return { text: 'Add-ons cleared.' }
    }

    const limit = parseLimit(args)
    if (limit === undefined) {
      return {
        text:
          'prompt-editor: "' + args + '" is not a setting. ' +
          'Use /prompt-editor on|off, /prompt-editor reset, /prompt-editor auto, /prompt-editor none or /prompt-editor <number>.',
      }
    }
    requestedCount = limit
    return { text: limitText() }
  })

  // Esc or the close mark: send the prompt as typed
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) finishEdit(false)
    return next(e)
  })

  // Open the editor for each typed prompt, then send what was chosen
  on('prompt.submit', async ($, e, next) => {
    const typed = e.origin?.kind === 'composer' || e.origin?.kind === 'bridge'
    let text = e.text
    if (editorOn && typed && !e.text.trimStart().startsWith('/')) {
      const send = await editPrompt($, e.text)
      if (send) text = compose(e.text)
    }
    const hint = limitHint()
    return next({ ...e, text, ...(hint ? { context: [...(e.context ?? []), hint] } : {}) })
  })

  // Enforce the helper-agent limit
  on('agent.spawn', async ($, e, next) => {
    if (requestedCount !== null && running.size + pendingSpawns >= requestedCount) {
      return {
        deny:
          requestedCount === 0
            ? 'The user turned off helper agents. Do this work yourself.'
            : 'The user allows at most ' + plural(requestedCount) +
              ' at a time. Wait for one to finish or do this work yourself.',
      }
    }
    if (e.agentId) running.add(e.agentId)
    else pendingSpawns++
    return next(e)
  })

  // A helper's first tool call is where its id first shows up
  on('tool.call', async ($, e, next) => {
    if (e.agentId && !running.has(e.agentId)) {
      running.add(e.agentId)
      if (pendingSpawns > 0) pendingSpawns--
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) running.delete(e.agentId)
    return next(e)
  })

  // The editor: add-on toggles, the helper limit, a preview and Send
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const redraw = () => $.ui.invalidate('ui.render')

    if (!editing) {
      return Box({ flexDirection: 'column', children: [Text({ dimColor: true, children: ['No prompt to edit.'] })] })
    }

    const toggles = EDITS.map((edit) => {
      const isOn = chosen.has(edit.id)
      return Box({
        key: 'row-' + edit.id,
        flexDirection: 'row',
        children: [
          Text({ color: isOn ? 'success' : undefined, dimColor: !isOn, children: [isOn ? '[x] ' : '[ ] '] }),
          Button({
            key: 'edit-' + edit.id,
            plain: true,
            label: edit.label,
            onPress: () => {
              if (chosen.has(edit.id)) chosen.delete(edit.id)
              else chosen.add(edit.id)
              redraw()
            },
          }),
        ],
      })
    })

    const lines = compose(editing.text).split('\n')
    const shown = lines.slice(0, PREVIEW_LINES).map((line, i) =>
      Text({ key: 'preview-' + i, color: i === 0 ? undefined : 'suggestion', children: [clip(line || ' ', 200)] }),
    )
    const more = lines.length > PREVIEW_LINES
      ? [Text({ dimColor: true, children: ['… ' + (lines.length - PREVIEW_LINES) + ' more lines'] })]
      : []

    return Box({
      flexDirection: 'column',
      children: [
        Text({ bold: true, color: 'suggestion', children: [TITLE] }),
        ...toggles,
        Box({
          flexDirection: 'row',
          children: [
            Button({
              key: 'helpers',
              plain: true,
              label: 'Helper agents: ',
              onPress: () => {
                nextLimit()
                redraw()
              },
            }),
            Text({ color: limitColor(), bold: true, children: [limitShort()] }),
          ],
        }),
        Text({ dimColor: true, children: ['Will send:'] }),
        Box({ flexDirection: 'column', paddingLeft: 2, children: [...shown, ...more] }),
        Button({
          key: 'send',
          label: 'Send',
          onPress: () => {
            finishEdit(true)
            $.ui.close({ id: PANE }).catch(() => {})
          },
        }),
        Text({ dimColor: true, children: ['↑/↓ move · Enter toggle or send · Esc send as typed'] }),
      ],
    })
  })
}