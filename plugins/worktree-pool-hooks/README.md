# worktree-pool-hooks

Claude Code hooks for [worktree-pool](../worktree-pool). Claude Code only.

| Hook | What it does |
|---|---|
| `PreToolUse` on Edit, MultiEdit, Write, NotebookEdit | Blocks edits in the root checkout. Blocks edits in a slot leased to another session and names the lessee. Records a heartbeat when an edit is allowed. |
| `Stop` | Records a heartbeat for every lease this session owns. |
| `SessionEnd` | Writes an `ended` marker, so the pool can tell a closed session from an idle one. |

The hooks do nothing in a repo without `worktree-pool.config.json`. They fail open on bad input or any error, so they never lock you out of editing.

Also blocked, in any repo with a pool: edits to Claude and Codex session transcripts, device paths (`\\?\`), UNC paths and NTFS stream paths.

## Install

```bash
claude plugin marketplace add alizaeda/agent-toolkit
claude plugin install worktree-pool@agent-toolkit
claude plugin install worktree-pool-hooks@agent-toolkit
```

## Optional config

Add to `worktree-pool.config.json`:

| Key | Meaning |
|---|---|
| `rootAllow` | Path prefixes in the root checkout that may still be edited (for example `tmp-notes/`). Default none. |
| `ownerUnlockPhrase` | If set, the owner typing this phrase in a message lets that one session edit the root checkout. Only text the human typed counts. Off when unset. An agent must never type or suggest the phrase. |

## Tests

```bash
cd hooks
node --test __tests__/*.test.mjs
```
