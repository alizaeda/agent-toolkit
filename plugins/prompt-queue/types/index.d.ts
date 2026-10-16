export type QueueItem = { id: string; text: string; armed?: boolean }

declare module 'claude-code' {
  interface PluginState {
    'prompt-queue': { items: QueueItem[] }
  }
}
