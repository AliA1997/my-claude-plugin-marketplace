import { test, expect } from 'claude-code/testing'

test('registers /prompt-editor', async ($, on) => {
  const names: string[] = []
  const toasts: string[] = []
  // Stand in for the engine: refuse built-in names, as a real session does
  on('command.register' as any, async (_$: any, e: any) => {
    if (['agents', 'help', 'clear'].includes(e.name)) {
      throw new Error('"/' + e.name + '" refused: it is the built-in /' + e.name)
    }
    names.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.toast' as any, async (_$: any, e: any) => {
    toasts.push(JSON.stringify(e))
    return { value: undefined }
  })
  on('session.start' as any, async (_$: any, e: any) => ({ cwd: e.cwd }) as any)

  await $.session.start({ source: 'startup', cwd: '.' } as any)
  expect(names).toEqual(['prompt-editor'])
  expect(toasts).toEqual([])
})

test('/prompt-editor shows the current settings', async ($) => {
  const result = await $.command.run({ command: 'prompt-editor', args: '' })
  expect(result.text).toBe('Prompt editor: on. Helper agents: Claude decides. Add-ons: none.')
})

test('/prompt-editor <number>, auto and none set the helper limit', async ($) => {
  expect((await $.command.run({ command: 'prompt-editor', args: '3' })).text).toBe('Helper agents: up to 3.')
  expect((await $.command.run({ command: 'prompt-editor', args: 'none' })).text).toBe('Helper agents: none.')
  expect((await $.command.run({ command: 'prompt-editor', args: 'auto' })).text).toBe('Helper agents: Claude decides.')
})

test('/prompt-editor with an unknown argument explains the usage', async ($) => {
  const result = await $.command.run({ command: 'prompt-editor', args: 'banana' })
  expect(result.text).toContain('is not a setting')
})

// Stand in for the engine at the bottom of prompt.submit: echo what reached it
function fakeSubmit(on: any) {
  on('prompt.submit' as any, async (_$: any, e: any) => ({ text: e.text, context: e.context }))
}

// Stand in for the surface placing panes: `placed` false is a terminal too narrow to show one
function fakePanes(on: any, placed = true) {
  on('ui.open' as any, async () => ({ value: placed ? { isPlaced: true } : { isPlaced: false, reason: 'too narrow' } }))
  on('ui.close' as any, async () => ({ value: undefined }))
}

// Let the prompt.submit chain reach the editor
async function settle() {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

const EDITOR_PROPS = { title: 'Prompt editor', isFocused: true, bodyColumns: 120, placement: 'inline' } as any

async function mountEditor($: any) {
  return $.ui.mount({ plugin: 'prompt-editor', surface: 'terminal', component: 'Pane', requestId: 'prompt-editor', props: EDITOR_PROPS })
}

async function press(ui: any, key: string) {
  const button: any = await ui.find({ key })
  button.props.onPress()
}

test('a typed prompt opens the editor with a preview and every add-on', async ($, on) => {
  fakePanes(on)
  fakeSubmit(on)
  const pending: any = $.prompt.submit({ text: 'fix the login bug', origin: { kind: 'composer' }, wait: false } as any)
  await settle()
  const ui = await mountEditor($)
  expect(await ui.find({ type: 'Text', text: /fix the login bug/ } as any)).toBeDefined()
  for (const key of ['edit-concise', 'edit-steps', 'edit-plan', 'edit-tests', 'edit-minimal', 'edit-ask', 'helpers', 'send']) {
    expect(await ui.find({ key })).toBeDefined()
  }
  await press(ui, 'send')
  const result = await pending
  expect(result.text).toBe('fix the login bug')
  await ui.unmount()
})

test('chosen add-ons are appended in order and remembered for the next prompt', async ($, on) => {
  fakePanes(on)
  fakeSubmit(on)
  const first: any = $.prompt.submit({ text: 'fix the login bug', origin: { kind: 'composer' }, wait: false } as any)
  await settle()
  let ui = await mountEditor($)
  await press(ui, 'edit-tests')
  await press(ui, 'edit-plan')
  await press(ui, 'send')
  expect((await first).text).toBe(
    'fix the login bug\n\n' +
      'Before changing any files, show me a short plan and wait for my go-ahead.\n' +
      'Add or update tests for what you change, and run them.',
  )
  await ui.unmount()

  const second: any = $.prompt.submit({ text: 'rename the column', origin: { kind: 'composer' }, wait: false } as any)
  await settle()
  ui = await mountEditor($)
  await press(ui, 'edit-plan')
  await press(ui, 'send')
  expect((await second).text).toBe('rename the column\n\nAdd or update tests for what you change, and run them.')
  await ui.unmount()
})

test('Esc sends the prompt as typed', async ($, on) => {
  fakePanes(on)
  fakeSubmit(on)
  const pending: any = $.prompt.submit({ text: 'fix the bug', origin: { kind: 'composer' }, wait: false } as any)
  await settle()
  const ui = await mountEditor($)
  await press(ui, 'edit-concise')
  await $.ui.close({ id: 'prompt-editor' } as any)
  expect((await pending).text).toBe('fix the bug')
  await ui.unmount()
})

test('the helper button cycles the limit and tells Claude', async ($, on) => {
  fakePanes(on)
  fakeSubmit(on)
  const pending: any = $.prompt.submit({ text: 'go', origin: { kind: 'composer' }, wait: false } as any)
  await settle()
  const ui = await mountEditor($)
  // Claude decides -> none -> 1
  await press(ui, 'helpers')
  await press(ui, 'helpers')
  await press(ui, 'send')
  expect((await pending).context).toEqual(['The user wants at most 1 helper agent running at once for this prompt.'])
  await ui.unmount()
})

test('an editor that cannot be shown sends the prompt as typed with the current limit', async ($, on) => {
  fakePanes(on, false)
  fakeSubmit(on)
  await $.command.run({ command: 'prompt-editor', args: 'none' })
  const result: any = await $.prompt.submit({ text: 'fix the bug', origin: { kind: 'composer' }, wait: false } as any)
  expect(result.text).toBe('fix the bug')
  expect(result.context).toEqual(['The user does not want helper agents for this prompt. Do the work yourself.'])
})

test('/prompt-editor off sends prompts without opening the editor', async ($, on) => {
  let opened = 0
  on('ui.open' as any, async () => {
    opened++
    return { value: { isPlaced: true } }
  })
  fakeSubmit(on)
  await $.command.run({ command: 'prompt-editor', args: 'off' })
  const result: any = await $.prompt.submit({ text: 'fix the bug', origin: { kind: 'composer' }, wait: false } as any)
  expect(result.text).toBe('fix the bug')
  expect(opened).toBe(0)
})

test('slash commands skip the editor', async ($, on) => {
  let opened = 0
  on('ui.open' as any, async () => {
    opened++
    return { value: { isPlaced: true } }
  })
  fakeSubmit(on)
  const result: any = await $.prompt.submit({ text: '/compact', origin: { kind: 'composer' }, wait: false } as any)
  expect(result.text).toBe('/compact')
  expect(opened).toBe(0)
})

test('/prompt-editor reset clears the remembered add-ons', async ($, on) => {
  fakePanes(on)
  fakeSubmit(on)
  const pending: any = $.prompt.submit({ text: 'go', origin: { kind: 'composer' }, wait: false } as any)
  await settle()
  const ui = await mountEditor($)
  await press(ui, 'edit-ask')
  await press(ui, 'send')
  await pending
  await ui.unmount()
  expect((await $.command.run({ command: 'prompt-editor', args: '' })).text).toContain('Add-ons: Ask if unclear.')
  await $.command.run({ command: 'prompt-editor', args: 'reset' })
  expect((await $.command.run({ command: 'prompt-editor', args: '' })).text).toContain('Add-ons: none.')
})