import { expect, mock, test } from 'claude-code/testing'

test('/queue adds an item and the band shows Send, Edit and Remove', async ($, on) => {
  mock.clock(on)
  mock.store(on)

  for (const surface of ['terminal', 'desktop'] as const) {
    await $.command.run({ command: 'queue', args: 'finish the report' })
    const list = await $.command.run({ command: 'queue', args: '' })
    expect(list.text).toContain('finish the report')

    const ui = await $.ui.mount({
      plugin: 'prompt-queue',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false },
    })
    expect(await ui.find({ key: 'queue' })).toBeTruthy()
    await ui.unmount()

    await $.command.run({ command: 'queue', args: 'clear' })
  }
})

test('After sends at once when the agent is idle', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const sent: string[] = []
  on('prompt.submit', async (_$, e) => {
    sent.push(e.text)

    return { text: e.text }
  })

  await $.command.run({ command: 'queue', args: 'run the tests' })
  const out = await $.command.run({ command: 'queue', args: 'after 1' })
  expect(out.text).toContain('Sent item 1')
  await clock.advance(100)
  expect(sent).toEqual(['run the tests'])
  const list = await $.command.run({ command: 'queue', args: '' })
  expect(list.text).toContain('empty')
})
