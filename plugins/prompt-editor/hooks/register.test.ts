import { test, expect } from 'claude-code/testing'

const HOME = 'C:/Users/me'
const KEYS = HOME + '/.claude/keybindings.json'

// Stand in for the engine beneath the plugin: env, files, the store, toasts and commands
function fakeEngine(on: any, { files = {} as Record<string, string>, store = {} as Record<string, unknown> } = {}) {
  const toasts: string[] = []
  const commands: string[] = []
  // The engine hands paths over in the platform's own spelling
  const norm = (path: string) => path.replace(/\\/g, '/')
  on('env.get' as any, async (_$: any, e: any) => ({ value: e.name === 'USERPROFILE' ? HOME : undefined }))
  on('fs.exists' as any, async (_$: any, e: any) => ({ value: norm(e.path) in files }))
  on('fs.read' as any, async (_$: any, e: any) => {
    if (!(norm(e.path) in files)) throw new Error('ENOENT')
    return { value: files[norm(e.path)] }
  })
  on('fs.write' as any, async (_$: any, e: any) => {
    files[norm(e.path)] = e.text
    return { value: undefined }
  })
  on('store.get' as any, async (_$: any, e: any) => ({ value: store[e.key] }))
  on('store.set' as any, async (_$: any, e: any) => {
    store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('ui.toast' as any, async (_$: any, e: any) => {
    toasts.push(JSON.stringify(e))
    return { value: undefined }
  })
  on('command.register' as any, async (_$: any, e: any) => {
    commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start' as any, async (_$: any, e: any) => ({ cwd: e.cwd }) as any)
  // Echo what reached the bottom of prompt.submit
  on('prompt.submit' as any, async (_$: any, e: any) => ({ text: e.text, context: e.context }))
  // The editor's own splice at the bottom of prompt.edit
  on('prompt.edit' as any, async (_$: any, e: any) => {
    const text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    return { text, cursor: e.start + e.inputText.length }
  })
  return { files, store, toasts, commands }
}

const start = ($: any) => $.session.start({ source: 'startup', cwd: '.' } as any)
const run = async ($: any, args: string) => (await $.command.run({ command: 'prompt-editor', args })).text
const submit = ($: any, text: string) => $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false } as any)
const edit = ($: any, e: any) => $.prompt.edit({ origin: { kind: 'composer' }, ...e } as any)

test('starting a session registers /prompt-editor and binds Shift+Enter to a new line', async ($, on) => {
  const engine = fakeEngine(on)
  await start($)
  expect(engine.commands).toEqual(['prompt-editor'])
  expect(engine.toasts).toEqual([])
  const keys = JSON.parse(engine.files[KEYS])
  expect(keys.bindings).toEqual([{ context: 'Chat', bindings: { 'shift+enter': 'chat:newline' } }])
})

test('the binding is merged into existing keybindings, and a key you bound yourself is left alone', async ($, on) => {
  const own = {
    bindings: [
      { context: 'Global', bindings: { 'ctrl+k ctrl+t': 'app:toggleTodos' } },
      { context: 'Chat', bindings: { 'ctrl+e': 'chat:externalEditor' } },
    ],
  }
  const engine = fakeEngine(on, { files: { [KEYS]: JSON.stringify(own) } })
  await start($)
  const keys = JSON.parse(engine.files[KEYS])
  expect(keys.bindings[0]).toEqual(own.bindings[0])
  expect(keys.bindings[1].bindings).toEqual({ 'ctrl+e': 'chat:externalEditor', 'shift+enter': 'chat:newline' })

  const mine = { bindings: [{ context: 'Chat', bindings: { 'shift+enter': 'chat:submit' } }] }
  engine.files[KEYS] = JSON.stringify(mine)
  await start($)
  expect(JSON.parse(engine.files[KEYS])).toEqual(mine)
})

test('/prompt-editor off is saved, takes the binding out, and sends prompts as typed', async ($, on) => {
  const engine = fakeEngine(on, { store: { settings: { on: true, helpers: null } } })
  await start($)
  expect(await run($, 'off')).toContain('off in every session')
  expect(engine.store.settings).toEqual({ on: false, helpers: null })
  expect(JSON.parse(engine.files[KEYS]).bindings[0].bindings).toEqual({})
  expect((await submit($, 'fix the bug')).text).toBe('fix the bug')
})

test('a saved "off" stays off in the next session', async ($, on) => {
  const engine = fakeEngine(on, { store: { settings: { on: false, helpers: null } } })
  await start($)
  expect(engine.files[KEYS]).toBeUndefined()
  expect(await run($, '')).toBe('Prompt editor: off. Helper agents: Claude decides.')
})

test('every prompt is sent exactly as typed, whatever it asks for, with the helper limit as context', async ($, on) => {
  // Settings saved by an older version that had add-ons
  fakeEngine(on, { store: { settings: { on: true, addOns: ['tests', 'plan'], helpers: 3 } } })
  await start($)
  for (const text of ['plan the login fix', 'add tests for the login fix', '/compact']) {
    const result: any = await submit($, text)
    expect(result.text).toBe(text)
    expect(result.context).toEqual(['The user wants at most 3 helper agents running at once for this prompt.'])
  }
})

test('a new line keeps the indentation of the line above', async ($, on) => {
  fakeEngine(on)
  await start($)
  const text = 'steps:\n    - one'
  const result: any = await edit($, {
    text,
    cursor: text.length,
    start: text.length,
    end: text.length,
    inputText: '\n',
    key: { key: 'return', shift: true },
  })
  expect(result.text).toBe('steps:\n    - one\n    ')
  expect(result.cursor).toBe(result.text.length)
})

test('Shift+Enter that reaches the box as a bare key still makes a new line', async ($, on) => {
  fakeEngine(on)
  await start($)
  const result: any = await edit($, { text: 'ab', cursor: 1, start: 1, end: 1, inputText: '', key: { key: 'return', shift: true } })
  expect(result.text).toBe('a\nb')
})

test('ordinary typing, and every key while off, is left to the editor', async ($, on) => {
  fakeEngine(on)
  await start($)
  const typed: any = await edit($, { text: '  ab', cursor: 4, start: 4, end: 4, inputText: 'c', key: { key: 'c' } })
  expect(typed.text).toBe('  abc')
  await run($, 'off')
  const off: any = await edit($, { text: '  ab', cursor: 4, start: 4, end: 4, inputText: '\n' })
  expect(off.text).toBe('  ab\n')
})

test('/prompt-editor <number>, auto and none change and save the limit; old add-on names are not settings', async ($, on) => {
  const engine = fakeEngine(on)
  await start($)
  expect(await run($, '3')).toBe('Helper agents: up to 3.')
  expect(engine.store.settings).toEqual({ on: true, helpers: 3 })
  expect(await run($, 'none')).toBe('Helper agents: none.')
  expect(await run($, 'auto')).toBe('Helper agents: Claude decides.')
  for (const old of ['plan', 'tests', 'reset', 'banana']) expect(await run($, old)).toContain('is not a setting')
})

test('the strip above the prompt looks the same everywhere: just the helper limit', async ($, on) => {
  const engine = fakeEngine(on)
  await start($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui: any = await ($ as any).ui.mount({
      plugin: 'prompt-editor',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 },
    })
    expect(await ui.find({ key: 'helpers' })).toBeDefined()
    for (const key of ['edit-plan', 'edit-tests']) expect(await ui.find({ key })).toBeUndefined()
    await ui.press({ key: 'helpers' })
    expect(engine.store.settings).toEqual({ on: true, helpers: 0 })
    await run($, 'auto')
    await ui.unmount()
  }
})
