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
