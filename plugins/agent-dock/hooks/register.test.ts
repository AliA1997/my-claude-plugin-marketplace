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
