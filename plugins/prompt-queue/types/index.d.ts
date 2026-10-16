export type QueueItem = { id: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    'prompt-queue': { items: QueueItem[] }
  }
}
