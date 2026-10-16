import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { QueueItem } from '../types'

const items = atom({ plugin: 'prompt-queue', key: 'items' } as const, [])

const STORE_KEY = 'items'
const PREVIEW = 36

const preview = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > PREVIEW ? `${flat.slice(0, PREVIEW - 1)}…` : flat
}

type Dollar = EngineInterface

async function persist($: Dollar, list: QueueItem[]) {
  await $.store.set(STORE_KEY, list)
}

async function add($: Dollar, text: string): Promise<boolean> {
  const clean = text.trim()

  if (clean === '') {
    return false
  }

  const id = `${await $.clock.now()}-${Math.random().toString(36).slice(2, 6)}`
  const next = await update($, items, (list: QueueItem[]) => [...list, { id, text: clean }])
  await persist($, next)

  return true
}

async function remove($: Dollar, id: string) {
  const next = await update($, items, (list: QueueItem[]) => list.filter(one => one.id !== id))
  await persist($, next)
}

async function sendNow($: Dollar, item: QueueItem) {
  await remove($, item.id)
  void $.prompt.submit({ text: item.text, asUser: true })
}

async function setArmed($: Dollar, id: string, armed: boolean) {
  const next = await update($, items, (list: QueueItem[]) =>
    list.map(one => (one.id === id ? { ...one, armed } : one)),
  )
  await persist($, next)
}

async function sendNext($: Dollar): Promise<boolean> {
  const list = (await read($, items)) as QueueItem[]
  const item = list.find(one => one.armed)

  if (!item) {
    return false
  }

  await sendNow($, item)

  return true
}

async function queueDraft($: Dollar) {
  const { text } = await $.prompt.read()

  if (!(await add($, text))) {
    $.ui.toast('Prompt box is empty. Nothing to queue.')

    return
  }

  await $.prompt.fill({ text: '', mode: 'replace' })
  $.ui.toast('Queued.')
}

export const register: Register = on => {
  let isBusy = false

  on('prompt.submit', async ($, e, next) => {
    isBusy = isBusy || !e.text.trimStart().startsWith('/')

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    isBusy = await sendNext($)

    return next(e)
  })

  on('session.start', async ($, e, next) => {
    const saved = await $.store.get(STORE_KEY)

    if (Array.isArray(saved)) {
      await update($, items, () => saved as QueueItem[])
    }

    await $.command.register({
      name: 'queue',
      description: 'Queue a prompt: /queue <text> | send <n> | after <n> | edit <n> | rm <n> | clear',
    })

    return next(e)
  })

  on('command.run', { command: 'queue' }, async ($, e) => {
    const args = e.args.trim()
    const list = (await read($, items)) as QueueItem[]
    const [verb, rest] = args.split(/\s+/, 2)
    const pick = (): QueueItem | undefined => list[Number(rest) - 1]

    if (args === '') {
      if (list.length === 0) {
        return { text: 'Queue is empty. Use /queue <text> or the Queue draft button.' }
      }

      return { text: list.map((one, i) => `${i + 1}. ${one.armed ? '[after] ' : ''}${preview(one.text)}`).join('\n') }
    }

    if (verb === 'clear') {
      await update($, items, () => [])
      await persist($, [])

      return { text: 'Queue cleared.' }
    }

    if (verb === 'send' || verb === 'after' || verb === 'edit' || verb === 'rm') {
      const item = pick()

      if (!item) {
        return { text: `No queue item "${rest ?? ''}". Use /queue to see the list.` }
      }

      if (verb === 'after') {
        if (isBusy) {
          await setArmed($, item.id, true)

          return { text: `Item ${rest} will send when the agent is done.` }
        }

        isBusy = true
        $.clock.after(50, () => void sendNow($, item))

        return { text: `Agent is idle. Sent item ${rest}.` }
      }

      if (verb === 'send') {
        isBusy = true
        $.clock.after(50, () => void sendNow($, item))

        return { text: `Sent item ${rest}.` }
      }

      await remove($, item.id)

      if (verb === 'edit') {
        await $.prompt.fill({ text: item.text, mode: 'replace' })

        return { text: `Item ${rest} is in the prompt box.` }
      }

      return { text: `Removed item ${rest}.` }
    }

    await add($, args)

    return { text: 'Queued.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const list = (await read($, items)) as QueueItem[]
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box gap={1}>
          <Button key="queue" label="+ Queue" onPress={() => queueDraft($)} />
          {list.length > 0 && <Text dimColor>{list.length} waiting</Text>}
        </Box>
        {list.map(one => (
          <Box key={one.id} gap={1} paddingLeft={2}>
            <Text dimColor>
              {one.armed ? '⏱ ' : ''}
              {preview(one.text)}
            </Text>
            <Button
              key={`send-${one.id}`}
              label="Send"
              onPress={async () => {
                isBusy = true
                await sendNow($, one)
              }}
            />
            {one.armed ? (
              <Button key={`hold-${one.id}`} label="Hold" onPress={() => setArmed($, one.id, false)} />
            ) : (
              <Button
                key={`after-${one.id}`}
                label="After"
                onPress={async () => {
                  if (isBusy) {
                    await setArmed($, one.id, true)
                    $.ui.toast('Will send when the agent is done.')
                  } else {
                    isBusy = true
                    await sendNow($, one)
                  }
                }}
              />
            )}
            <Button
              key={`edit-${one.id}`}
              label="Edit"
              onPress={async () => {
                await remove($, one.id)
                await $.prompt.fill({ text: one.text, mode: 'replace' })
              }}
            />
            <Button key={`rm-${one.id}`} label="✕" onPress={() => remove($, one.id)} />
          </Box>
        ))}
      </Box>
    )
  })
}
