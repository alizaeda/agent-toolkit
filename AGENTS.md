# agent-toolkit

Shared skills and mods for several agent harnesses.

- One plugin per folder in `plugins/`.
- Skills live in `plugins/<name>/skills/<skill>/SKILL.md`. Keep them plain Markdown. No harness-only features.
- Harness-only code (for example Claude mods) lives in its own plugin. Say so in the README table.
- Plugin `name` must match its catalog entry name.
- Before a push: `claude plugin validate .`
