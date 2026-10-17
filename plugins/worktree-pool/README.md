# worktree-pool

**Run many coding agents on one repo at the same time, and never lose work.**

## The problem

You start a second agent on the same repo. Now this happens:

- Two agents edit the same checkout. One overwrites the other. Branches switch under a running agent.
- Agents make a fresh `git worktree` for each task. Disks fill up. Every task waits for a full `npm install`.
- A session closes or you run `/clear`. The worktree it used is now "someone's", and nobody knows if it is safe to delete.
- A slot is full of uncommitted work. Cleanup scripts either delete it (data loss) or refuse forever (the pool fills up).
- You cannot tell which agent owns which directory. Agents guess, and they guess wrong.

Prompts like "please use your own worktree" do not fix this. Agents forget, run in parallel, and lose context.

## What this plugin does

It gives every agent a **lease** on one of a fixed set of worktree slots. The tool, not the agent's memory, decides who owns what.

### Top features

1. **Atomic leases.** `acquire` locks a slot to one session. Two agents can never get the same slot or the same branch.
2. **No reinstall.** Slots keep their own `node_modules`. The install is skipped while the lockfile is unchanged, and acquire prefers a slot that is already warm.
3. **Safe reclaim, with proof.** A finished slot is freed only when the tool proves the work is landed or pushed. It reads git, not guesses.
4. **Nothing is ever lost.** An abandoned slot with dirty files or local commits is saved to a `salvage/<slot>-<time>` branch first. Only then is it cleaned.
5. **Knows if an owner is alive.** Heartbeats and an "ended" marker tell a closed session from an idle one. A live owner is never touched.
6. **Survives `/clear` and resume.** `adopt` re-leases your own slot in place. No data moves.
7. **Self-healing.** `reap` frees finished slots. `doctor --fix` clears dead locks. A full pool tries to free a slot before it fails.
8. **Shared-resource locks.** One slot at a time can hold the dev server or the database. Numbered lanes allow a few isolated stacks.
9. **Clear tiers for agents.** Five tiers say what an agent may do alone and what needs the owner. No guessing.
10. **Works in any harness.** It is skills plus a plain Node CLI. Claude Code, Codex, Cursor, Gemini CLI and others all read `SKILL.md`. For Claude Code, add [worktree-pool-hooks](../worktree-pool-hooks) to enforce the rules with hooks.

### Before and after

| Without the pool | With the pool |
|---|---|
| Agents share one checkout and collide | One slot per agent, enforced by a lease |
| Fresh worktree plus full install per task | Warm slots, install only when inputs change |
| "Is this worktree safe to delete?" | The tool answers with proof |
| Cleanup deletes work or never runs | Salvage branch first, then clean |
| `/clear` orphans your worktree | `adopt` takes it back |
| Rules live in a prompt the agent forgets | Rules live in the tool and the hooks |

### A normal task

```bash
node pool.mjs acquire feat/login --purpose "add login page" --prepare   # lease + install
cd <path it prints>                                                      # work only here
git push -u origin HEAD                                                  # push early
node pool.mjs release --expect-branch feat/login                         # free the slot
```

The agent reads the `worktree-pool` skill and does this on its own. You only start the agents.

## Install

```bash
claude plugin marketplace add alizaeda/agent-toolkit
claude plugin install worktree-pool@agent-toolkit
claude plugin install worktree-pool-hooks@agent-toolkit   # Claude Code only: enforcement hooks
```

Other harnesses: `npx skills add alizaeda/agent-toolkit` gives you the skills. The CLI is `scripts/pool.mjs` in this folder. Needs Node 18+ and git. `gh` is optional (PR column, merged-PR proof).

## Set up a repo

1. Copy `config.example.json` to `worktree-pool.config.json` at the repo root. Commit it.
2. Create the slots:

```bash
node path/to/scripts/pool.mjs setup
```

3. Add one line to your `AGENTS.md` or `CLAUDE.md`: "Use the `worktree-pool` skill for all feature work. Do not edit the root checkout."

## Config

| Key | Meaning |
|---|---|
| `version` | Always `1`. |
| `slotCount` | How many slots. |
| `poolDirectory` | Where slots live. Relative to the repo root, or absolute. |
| `baseRef` | Ref slots sit on when free, and new branches start from. |
| `slotPrefix` | Slot folder prefix. `slot-` gives `slot-01`. |
| `prepare.command` | Install command as an array. Unset: detect from the lockfile (pnpm, npm, yarn, bun). `null`: no install. |
| `prepare.inputs` | Tracked files that decide if the install is stale. Default: manifests and lockfiles. |
| `prepare.outputs` | Paths that must exist after install. Default `["node_modules"]`. |
| `policy` | Idle limits. See the skill for the list. |

## Environment

| Variable | Use |
|---|---|
| `WT_OWNER` | Fixed owner id when no session id exists. |
| `WT_LOCK_WAIT_MS` | How long a lock waits before it fails. Default 90000. |
| `WT_LANE_CAP` | Number of runtime lanes. Default 2. |

## Tests

```bash
cd scripts
node --test __tests__/pool.test.mjs __tests__/pool-lib.lane.test.mjs __tests__/pool-lib.reap.test.mjs __tests__/pool-lib.ownership.test.mjs
```
