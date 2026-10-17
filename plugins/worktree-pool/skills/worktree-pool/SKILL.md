---
name: worktree-pool
description: Run parallel coding agents on one repo with a pool of leased git worktree slots. Use when the repo has a worktree-pool.config.json, when starting feature work that must not happen in the root checkout, or when asked to acquire, release, reap, adopt or take over a worktree slot.
---

# Worktree pool

A fixed set of git worktrees ("slots") next to the repo. Each agent session leases one slot, works there, and releases it. Slots keep their own `node_modules`, so a new task does not reinstall. The pool tools prove nothing is lost before they free a slot.

## Run the CLI

`POOL` below means `node <this plugin>/scripts/pool.mjs`. From this file that is `../../scripts/pool.mjs`. Use the absolute path. Run it from anywhere inside the repo or a slot.

First time in a repo: add `worktree-pool.config.json` at the repo root (see `config.example.json` in the plugin), then run `POOL setup` to create the slots.

## States

- `AVAILABLE`: detached at the base ref, clean, no lease.
- `LEASED`: on one feature branch. The lease holds the owner (session id), branch, purpose and a heartbeat.
- `BLOCKED`: branch and lease disagree. The pool repairs it when safe.
- `MISSING`: slot not created yet. Run `POOL setup`.

The root checkout is for coordination. Do not implement features there.

## Workflow

1. `POOL status` (add `--long` for tier and local-only commit count).
2. `POOL acquire <unique-branch> --purpose "<task>"`. `--purpose` is required. Acquire is the atomic ownership step. Never pick an `AVAILABLE` directory by eye. Do not ask first.
3. `cd` to the path it prints. Work only there.
4. `POOL prepare` before any build or test (or pass `--prepare` to `acquire`).
5. Before a slot write from a shell, run `POOL assert`. (With the `worktree-pool-hooks` plugin, Edit and Write are checked by a hook. Shell commands are not.)
6. Push early: `git push -u origin HEAD` after the first commit and after each batch. Slot commits live on one disk.
7. Finish: verify, make sure the slot is clean and no merge or rebase is running, push.
8. From inside the slot: `POOL release --expect-branch <branch>`. Then check `POOL status` shows `AVAILABLE`.

Waiting on CI does not need a slot. A clean, pushed slot may be reclaimed when idle. Your branch and PR survive. Run `acquire` with the same branch to continue.

## Signals

- **Idle**: time since the newest of: owner transcript change, heartbeat, slot activity, lease start. An `ended` marker means the owner session closed.
- **Landed**: HEAD is in the base ref, or every commit is patch-equal there, or every changed file equals the base, or a merged PR head equals HEAD (`gh`).
- **Pushed**: no commit in HEAD is missing from every remote branch.

## Tiers: who may act

| Tier | Condition | Action |
|---|---|---|
| 0 MINE | Lease owner is this session. | Work freely. Release when merged. |
| A FINISHED | Foreign lease, clean tree, no git operation, no live locks, and landed + idle, or pushed + idle, or owner ended + short grace. | Anyone. `reap --apply`, auto-reap in `acquire`, `release --slot N`. |
| B STUCK-SAFE | Slot `BLOCKED`, clean, pushed, idle. | Anyone. Auto-repaired (detached to base). |
| C ABANDONED | Owner idle for hours (shorter if ended; longer if owner id unknown), no live locks, not mid merge/rebase. May be dirty or hold local-only commits. | Anyone. `takeover --slot N` saves everything to a `salvage/<slot>-<ts>` branch, then frees it. `adopt --slot N` re-leases in place. |
| D MAYBE LIVE | Owner recently active with dirty or local-only work, or mid merge/rebase, or live locks. | The tools refuse. Use another slot, wait, or ask the owner with 2 options. `--owner-approved` only after the owner said yes. |
| E NEVER | Discard or clean a slot by hand, delete a salvage or feature branch, `--allow-unpushed` for commits not proved landed. | Always ask the owner first. |

Act on tiers 0, A, B, C. Do not force D. Ask first for E, and show the exact command. A tool refusal is the answer: do not work around it with raw `git` in the slot.

## Commands

```
POOL setup
POOL status [--long|--json]
POOL acquire <branch> --purpose "<task>"   # [--prepare] [--slot N] [--no-fetch]
POOL assert                                # [--slot N] [--expect-branch <b>]
POOL touch                                 # heartbeat from inside a slot
POOL prepare                               # [--force]
POOL release --expect-branch <b>           # [--slot N] [--reconcile-branch] [--allow-unpushed] [--owner-approved]
POOL adopt --slot N
POOL takeover --slot N                     # [--dry-run] [--owner-approved]
POOL switch <new-branch> --purpose "<task>"
POOL reap                                  # dry run; [--apply] [--no-takeover]
POOL doctor                                # [--fix]
POOL lock <resource> / POOL unlock <resource>
POOL lane [N] / POOL unlane                # numbered runtime lanes, see below
POOL recover-lock <allocation|dependency-install> --force
node <plugin>/scripts/pool-report.mjs      # status table, see wt-status-table
```

- `acquire` is idempotent for your own branch. It prefers a free slot whose install already matches the base lockfile. A fetch failure only warns.
- `assert` exits 0 only if the cwd (or slot N) is leased to this session and HEAD is the lease branch.
- `release` is owner-checked and prints `landed via ...` as proof. Your own untouched lease releases with no flag.
- `switch` re-leases the same slot to another branch. Never `git checkout` another branch in a leased slot.
- `reap --apply` covers tiers A, B and C. Agents may run it without asking.
- `doctor --fix` clears orphan locks and dead-PID internal locks.
- Locks wait up to 90 s (env `WT_LOCK_WAIT_MS`). A lock held by a dead PID for over 30 s is broken.

## Preserve-work rules

- Release only detaches the worktree. The branch, commits and PR survive.
- `takeover` commits the whole tree (dirty files too) to a local `salvage/<slot>-<ts>` branch, writes `lease.json`, `status.txt` and `README.txt` to `<poolRoot>/.pool/salvage/<slot>-<ts>/`, and only then cleans the tree.
- Ignored files (`.env*`, caches, `node_modules`) stay in the slot. They are not saved and not deleted.
- Never `git clean -fdx` in a slot. Never share `node_modules` between slots.

## After `/clear` or resume

Your session id changes, so your own slot looks foreign. Run `POOL adopt --slot N` (or `acquire` with the same branch). No data moves.

## Pool full

1. `POOL reap --apply` (`acquire` already does this when no slot is free).
2. Still full: wait and retry.
3. Ask the owner only when tier D blocks every slot. Show `status --long`.

## Shared resources

For anything only one slot may use at a time (a fixed-port dev server, a shared database), take a named lock: `POOL lock <resource>`, then `POOL unlock <resource>` from the same slot. The built-in resource names are `runtime` and `database`. Never unlock another slot's live lock. For several isolated stacks at once, `POOL lane` hands out numbered lanes up to `WT_LANE_CAP` (default 2). A slot holding a lock or lane cannot be released.

## Preparation

`POOL prepare` runs the install command from `prepare.command` in the config. If unset, it detects one from the lockfile (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lock`). It skips the install when the stamp still matches the Node version, the tracked dependency inputs (`prepare.inputs`) and the `prepare.outputs` paths. Installs run with `CI=true` and are serialized across slots. Set `"command": null` for repos with no install step.

## Thresholds

Defaults. Override with a `policy` object in the config (same key names).

| Key | Default | Meaning |
|---|---|---|
| `landedIdleMinutes` | 5 | Tier A, landed |
| `finishedIdleMinutes` | 60 | Tier A, pushed |
| `finishedIdleMinutesFull` | 15 | Tier A, pushed, no free slot |
| `endedGraceMinutes` | 2 | Tier A, owner ended |
| `blockedIdleMinutes` | 30 | Tier B |
| `abandonedIdleHours` | 24 | Tier C |
| `endedAbandonedHours` | 4 | Tier C, owner ended |
| `unknownOwnerAbandonedHours` | 72 | Tier C, owner id has no transcript |
| `liveWithinMinutes` | 10 | Tier D, "owner active" |
