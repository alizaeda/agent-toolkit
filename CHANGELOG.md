# Changelog

## Unreleased
- Add `worktree-pool` 0.1.0: leased git worktree slots for parallel agents. Skills `worktree-pool` and `wt-status-table`, plus the Node CLI.
- Add `worktree-pool-hooks` 0.1.0 (Claude Code and Codex hooks): root-edit guard, slot ownership, heartbeats.
- prompt-queue 0.2.0: **After** button and `/queue after <n>`. Sends an item when the agent finishes its turn. **Hold** cancels. Items chain one per turn.
- prompt-queue: `/queue send <n>` now sends through a short timer (the engine rejects submit from a command hook).

## 0.1.0
- Add `prompt-queue` (Claude Code mod).
