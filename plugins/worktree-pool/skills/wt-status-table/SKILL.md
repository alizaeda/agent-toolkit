---
name: wt-status-table
description: Show the status of every worktree pool slot as one table (branch, PR, lease age, last commit, last file edit, state, tier verdict). Use when asked about slots, "what is in each slot", "which slots are free or stale", or before freeing slots. Read-only: never releases, resets or cleans a slot.
---

# Worktree slot status table

One command, one table. It changes nothing.

## Run

```bash
node "<plugin>/scripts/pool-report.mjs"
```

`<plugin>` is the worktree-pool plugin folder (from this file: `../../`). Add `--json` for raw rows. It reads git state in every slot, so it can take 10-30 s on a big pool.

## Show this table

Print the table as the script gives it. Do not drop columns:

| Slot | Branch | PR | Age | Last commit | Last file edit | State | Verdict |
|---|---|---|---|---|---|---|---|

- **Age**: time since the lease started.
- **Last commit**: newest commit in the slot. **Last file edit**: newest change time of an uncommitted file (`-` when clean).
- **State**: whether the tree is clean and every commit is pushed.
- **Verdict**: the tier from the `worktree-pool` skill: `free: reap releases it` (A/B), `abandoned: takeover saves state` (C), `live: keep` (tier 0 or active owner), `ask: tier D`.

After the table, add 2 or 3 plain lines: which slots `reap --apply` would free, which need a takeover, which need the owner.

## Rules

1. A `live: keep` slot may belong to a live session. Never call it free.
2. Freeing is a separate step. Agents may run `reap --apply` (tiers A, B, C). Ask the owner for `ask: tier D` and anything in tier E.
3. `takeover` saves the tree on a `salvage/<slot>-<ts>` branch before it frees the slot. Do not hand-save patches to skip the tool.
4. If `gh` is missing or offline, the PR column shows `none` for every slot. Say so. Do not call a slot "no PR" on that evidence.
