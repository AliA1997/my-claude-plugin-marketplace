import { test, expect } from 'claude-code/testing'

test('registers /agent-dock and not the built-in /agents', async ($, on) => {
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
  expect(names).toEqual(['agent-dock'])
  expect(toasts).toEqual([])
})

test('/agent-dock <number> sets the helper limit', async ($) => {
  const result = await $.command.run({ command: 'agent-dock', args: '3' })
  expect(result.text).toBe('Helper agents: up to 3.')
})

test('/agent-dock auto and none', async ($) => {
  expect((await $.command.run({ command: 'agent-dock', args: 'none' })).text).toBe('Helper agents: none.')
  expect((await $.command.run({ command: 'agent-dock', args: 'auto' })).text).toBe('Helper agents: Claude decides.')
})

test('/agent-dock with an unknown argument explains the usage', async ($) => {
  const result = await $.command.run({ command: 'agent-dock', args: 'banana' })
  expect(result.text).toContain('is not a limit')
})

// Stand in for the AskUserQuestion dialog: answer every question with `answer`, or dismiss it
function fakeAsk(on: any, answer: string | null, asked: string[]) {
  on('tool.call' as any, { tool: 'AskUserQuestion' }, async (_$: any, e: any) => {
    const questions = e.input?.questions ?? e.questions ?? []
    asked.push(...questions.map((q: any) => q.question))
    if (answer === null) throw new Error('dismissed')
    const answers = Object.fromEntries(questions.map((q: any) => [q.question, answer]))
    return { result: { questions, answers } }
  })
}

// Stand in for the engine at the bottom of prompt.submit: echo what reached it
function fakeSubmit(on: any) {
  on('prompt.submit' as any, async (_$: any, e: any) => ({ text: e.text, context: e.context }))
}

test('a typed prompt asks how many helpers and tells Claude the answer', async ($, on) => {
  const asked: string[] = []
  fakeAsk(on, '3', asked)
  fakeSubmit(on)
  const result: any = await $.prompt.submit({ text: 'fix the bug', origin: { kind: 'composer' }, wait: false } as any)
  expect(asked.length).toBe(1)
  expect(result.context).toEqual(['The user wants at most 3 helper agents running at once for this prompt.'])
})

test('dismissing the question keeps the current limit', async ($, on) => {
  const asked: string[] = []
  fakeAsk(on, null, asked)
  fakeSubmit(on)
  await $.command.run({ command: 'agent-dock', args: 'none' })
  const result: any = await $.prompt.submit({ text: 'fix the bug', origin: { kind: 'composer' }, wait: false } as any)
  expect(asked.length).toBe(1)
  expect(result.context).toEqual(['The user does not want helper agents for this prompt. Do the work yourself.'])
})

test('/agent-dock ask off stops the question', async ($, on) => {
  const asked: string[] = []
  fakeAsk(on, '2', asked)
  fakeSubmit(on)
  await $.command.run({ command: 'agent-dock', args: 'ask off' })
  await $.prompt.submit({ text: 'fix the bug', origin: { kind: 'composer' }, wait: false } as any)
  expect(asked.length).toBe(0)
})

test('the pane draws each helper in its own color under an RGB title', async ($, on) => {
  // A helper's first tool call is where the dock first sees it
  on('tool.call' as any, async () => ({ result: 'ok' }))
  await $.tool.call({ tool: 'Read', file_path: 'a.md', agentId: 'a1' } as any)
  await $.tool.call({ tool: 'Grep', pattern: 'todo', agentId: 'a2' } as any)
  const ui = await $.ui.mount({
    plugin: 'agent-dock',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'agent-dock',
    props: { title: 'Agent dock', isFocused: true, bodyColumns: 120, placement: 'dock' } as any,
  })
  const texts = await ui.findAll({ type: 'Text' })
  const title = texts.slice(0, 'AGENT DOCK'.length)
  expect(title.map((t) => t.text).join('')).toBe('AGENT DOCK')
  // Every letter of the title is a different color
  expect(new Set(title.map((t) => t.props.color)).size).toBe(title.length)
  // Each helper's task line is drawn in that helper's own color
  const a1 = texts.find((t) => t.text.includes('Read: a.md'))
  const a2 = texts.find((t) => t.text.includes('Grep: todo'))
  expect(a1?.props.color).toMatch(/^#[0-9a-f]{6}$/)
  expect(a1?.props.color).not.toBe(a2?.props.color)
  expect(await ui.find({ key: 'agent-a1' })).toBeDefined()
  await ui.unmount()
})

test('the band above the prompt shows while Claude works', async ($) => {
  const ui = await $.ui.mount({
    plugin: 'agent-dock',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120 } as any,
  })
  expect(await ui.find({ type: 'Text', text: /Claude decides/ } as any)).toBeDefined()
  await ui.unmount()
})
