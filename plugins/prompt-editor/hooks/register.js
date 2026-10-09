// prompt-editor
//   Makes the prompt box work like a text editor. It works the same way for every prompt:
//   planning, testing or anything else. Your prompt is sent exactly as you typed it.
//     - Shift+Enter (and Ctrl+J) start a new line instead of sending; Enter sends
//     - a new line keeps the indentation of the line above it
//     - a one-line strip above the prompt shows the helper-agent limit; ctrl+x tab focuses it
//   Every setting is saved, so the editor stays on in every session until you turn it off.
//
//   /prompt-editor                 show the current settings
//   /prompt-editor on | off        turn the editor on or off (remembered across sessions)
//   /prompt-editor auto | none | <number>   set the helper-agent limit

const STORE_KEY = 'settings'

// What the helper-agent button cycles through (null = Claude decides, 0 = none)
const LIMITS = [null, 0, 1, 5, 10, 15, 20, 50, 60]

// Keys the editor binds to a new line in ~/.claude/keybindings.json while it is on
const NEWLINE_KEYS = ['shift+enter']
const NEWLINE_ACTION = 'chat:newline'

// null = Claude decides, otherwise the maximum number of helper agents
let requestedCount = null
// The editor is on unless you turned it off
let editorOn = true

// Helper agents that are running, and spawns not yet matched to an agent id
const running = new Set()
let pendingSpawns = 0

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const plural = (n) => n + ' helper agent' + (n === 1 ? '' : 's')

// ---- saved settings ----

async function loadSettings($) {
  const saved = await $.store.get(STORE_KEY).catch(() => undefined)
  if (!saved || typeof saved !== 'object') return
  if (typeof saved.on === 'boolean') editorOn = saved.on
  if (saved.helpers === null || (Number.isInteger(saved.helpers) && saved.helpers >= 0)) requestedCount = saved.helpers
}

function saveSettings($) {
  return $.store
    .set(STORE_KEY, { on: editorOn, helpers: requestedCount })
    .catch((err) => $.ui.toast('prompt-editor: could not save settings: ' + (err?.message ?? err)))
}

// ---- the Shift+Enter binding ----

async function keybindingsPath($) {
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  if (configDir) return configDir.replace(/[\\/]+$/, '') + '/keybindings.json'
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  return home ? home.replace(/[\\/]+$/, '') + '/.claude/keybindings.json' : undefined
}

// The keybindings file with the new-line keys added (on) or taken out (off);
// undefined when nothing needs to change. A key you bound to something else is left alone.
function withNewlineKeys(file, on) {
  const bindings = Array.isArray(file.bindings) ? file.bindings : []
  let chat = bindings.find((block) => block && block.context === 'Chat')
  let changed = false

  if (on) {
    if (!chat) {
      chat = { context: 'Chat', bindings: {} }
      bindings.push(chat)
    }
    chat.bindings = chat.bindings ?? {}
    for (const key of NEWLINE_KEYS) {
      if (!(key in chat.bindings)) {
        chat.bindings[key] = NEWLINE_ACTION
        changed = true
      }
    }
  } else if (chat?.bindings) {
    for (const key of NEWLINE_KEYS) {
      if (chat.bindings[key] === NEWLINE_ACTION) {
        delete chat.bindings[key]
        changed = true
      }
    }
  }

  if (!changed) return undefined
  return {
    $schema: 'https://www.schemastore.org/claude-code-keybindings.json',
    $docs: 'https://code.claude.com/docs/en/keybindings',
    ...file,
    bindings,
  }
}

// Make Shift+Enter a new line while the editor is on, and undo that when it is off
async function syncNewlineKeys($) {
  try {
    const path = await keybindingsPath($)
    if (!path) return
    const exists = await $.fs.exists(path)
    if (!exists && !editorOn) return
    const file = exists ? JSON.parse(await $.fs.read(path)) : {}
    const next = withNewlineKeys(file, editorOn)
    if (next) await $.fs.write(path, JSON.stringify(next, null, 2) + '\n')
  } catch (err) {
    $.ui.toast('prompt-editor: could not update keybindings.json: ' + (err?.message ?? err))
  }
}

// ---- the prompt ----

// The spaces and tabs that start the line `offset` sits on
function indentAt(text, offset) {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1
  return text.slice(lineStart, offset).match(/^[ \t]*/)[0]
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

const statusText = () => 'Prompt editor: ' + (editorOn ? 'on' : 'off') + '. ' + limitText()

// Claude Code calls this once when the mod loads
export function register(on) {
  on('session.start', async ($, e, next) => {
    await loadSettings($)
    await syncNewlineKeys($)
    try {
      await $.command.register({
        name: 'prompt-editor',
        description: 'Turn the prompt editor on or off, or change its helper-agent limit',
        argumentHint: '[on | off | auto | none | <number>]',
      })
    } catch (err) {
      $.ui.toast('prompt-editor: could not add /prompt-editor: ' + (err?.message ?? err))
    }
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('command.run', { command: 'prompt-editor' }, async ($, e) => {
    const args = oneLine(e.args).toLowerCase()
    const redraw = () => $.ui.invalidate('ui.render')

    if (args === '' || args === 'status') return { text: statusText() }

    if (args === 'on' || args === 'off') {
      editorOn = args === 'on'
      await saveSettings($)
      await syncNewlineKeys($)
      redraw()
      return {
        text: editorOn
          ? 'The prompt editor is on in every session: Shift+Enter starts a new line, Enter sends.'
          : 'The prompt editor is off in every session. Prompts are sent as typed. (/prompt-editor on to turn it back on)',
      }
    }

    const limit = parseLimit(args)
    if (limit === undefined) {
      return {
        text:
          'prompt-editor: "' + args + '" is not a setting. ' +
          'Use /prompt-editor on, off, auto, none or <number>.',
      }
    }
    requestedCount = limit
    await saveSettings($)
    redraw()
    return { text: limitText() }
  })

  // Typing: Shift+Enter is a new line, and a new line keeps the indentation of the line above
  on('prompt.edit', async ($, e, next) => {
    if (!editorOn) return next(e)
    const key = e.key
    const isNewline =
      e.inputText === '\n' || (key?.key === 'return' && (key.shift || key.meta) && e.inputText === '')
    if (!isNewline) return next(e)
    return next({ ...e, inputText: '\n' + indentAt(e.text, e.start) })
  })

  // Sending: the prompt goes as typed; Claude is told the helper limit
  on('prompt.submit', async ($, e, next) => {
    const hint = limitHint()
    return hint ? next({ ...e, context: [...(e.context ?? []), hint] }) : next(e)
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

  // The strip above the prompt: the same every time, with the helper limit changed in place
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!editorOn || e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const change = async (fn) => {
      fn()
      await saveSettings($)
      $.ui.invalidate('ui.render')
    }

    return Box({
      flexDirection: 'column',
      children: [
        Box({
          flexDirection: 'row',
          flexWrap: 'wrap',
          columnGap: 2,
          children: [
            Text({ bold: true, color: 'suggestion', children: ['✎ Prompt editor'] }),
            Box({
              flexDirection: 'row',
              children: [
                Button({
                  key: 'helpers',
                  plain: true,
                  hotkey: 'h',
                  label: 'Helpers',
                  onPress: () => change(nextLimit),
                }),
                Text({ children: [' '] }),
                Text({ color: limitColor(), bold: true, children: [limitShort()] }),
              ],
            }),
          ],
        }),
        Text({
          dimColor: true,
          children: ['Enter send · Shift+Enter or Ctrl+J new line · ctrl+x tab change helpers · /prompt-editor off'],
        }),
      ],
    })
  })
}
