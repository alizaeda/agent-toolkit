# agent-toolkit

My mods, skills and plugins for coding agents. Skills use the open `SKILL.md` format, so they work in many harnesses. Mods are harness-only and are marked below.

## What is inside

| Plugin | What it does | Works in |
|---|---|---|
| [prompt-queue](plugins/prompt-queue) | Park prompt drafts above the prompt box. Send, edit or remove each one later. | Claude Code only (mod) |

## Install

**Claude Code** (mods and plugins):

```bash
claude plugin marketplace add alizaeda/agent-toolkit
claude plugin install prompt-queue@agent-toolkit
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
