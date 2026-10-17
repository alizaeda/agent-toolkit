# agent-toolkit

My mods, skills and plugins for coding agents. Skills use the open `SKILL.md` format, so they work in many harnesses. Mods are harness-only and are marked below.

## What is inside

| Plugin | What it does | Works in |
|---|---|---|
| [prompt-queue](plugins/prompt-queue) | Park prompt drafts above the prompt box. Send, edit or remove each one later. | Claude Code only (mod) |
| [worktree-pool](plugins/worktree-pool) | Pool of leased git worktree slots. Many agents work on one repo at once and never collide. Safe reclaim of idle slots. | Any harness (skills + Node CLI) |
| [worktree-pool-hooks](plugins/worktree-pool-hooks) | Hooks for worktree-pool: block edits in the root checkout, enforce slot ownership, record heartbeats. | Claude Code only (hooks) |

## Featured: worktree-pool

Running more than one coding agent on a repo breaks things: agents overwrite each other, every task reinstalls dependencies, and nobody knows which worktree is safe to delete. `worktree-pool` gives each agent its own leased slot, keeps installs warm, and frees idle slots only with proof that no work is lost. Abandoned work is saved to a branch first. [Read why and how](plugins/worktree-pool).

## Install

**Claude Code** (mods and plugins):

```bash
claude plugin marketplace add alizaeda/agent-toolkit
claude plugin install prompt-queue@agent-toolkit
claude plugin install worktree-pool@agent-toolkit
claude plugin install worktree-pool-hooks@agent-toolkit
```

**Any harness** (skills only; detects Claude Code, Codex, Cursor, Gemini CLI and more):

```bash
npx skills add alizaeda/agent-toolkit
```

**Codex** (plugins): add `.agents/plugins/marketplace.json` once a plugin with skills is listed. See `templates/plugin/`.

## Add a new plugin

1. Copy `templates/plugin` to `plugins/<name>`.
2. Put skills in `plugins/<name>/skills/<skill>/SKILL.md` (start from `templates/skill`).
3. Add an entry to `.claude-plugin/marketplace.json`. The entry `name` must equal the plugin `name`.
4. For Codex, add an entry to `.agents/plugins/marketplace.json` (`source.path` starts with `./`).
5. Run `claude plugin validate .`, then update `CHANGELOG.md` and tag a version.

## License

MIT
