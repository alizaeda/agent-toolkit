import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// worktree-guard decides from the EDITED path whether an Edit/Write lands in the
// main (root) checkout. These tests build a fake main checkout with a linked
// worktree beside it, the same layout `git worktree add` produces, and run the
// hook from both.

const hookPath = fileURLToPath(new URL('../worktree-guard.cjs', import.meta.url));

let scratch;
let root; // main checkout: .git is a directory
let slot; // linked worktree: .git is a `gitdir:` file, gitdir has a commondir
let bareSlot; // linked worktree whose gitdir has no commondir file
let lostSlot; // linked worktree whose gitdir cannot be resolved

before(() => {
  scratch = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'worktree-guard-')));
  root = path.join(scratch, 'main-repo');
  slot = path.join(scratch, 'pool-worktrees', 'slot-01');
  bareSlot = path.join(scratch, 'pool-worktrees', 'slot-02');
  lostSlot = path.join(scratch, 'pool-worktrees', 'slot-03');

  mkdirSync(path.join(root, '.git', 'worktrees', 'slot-01'), { recursive: true });
  writeFileSync(path.join(root, '.git', 'worktrees', 'slot-01', 'commondir'), '../..\n');
  mkdirSync(path.join(root, '.git', 'worktrees', 'slot-02'), { recursive: true });
  mkdirSync(path.join(root, 'apps', 'api', 'src'), { recursive: true });

  for (const dir of [slot, bareSlot, lostSlot]) mkdirSync(path.join(dir, 'apps', 'api', 'src'), { recursive: true });
  // Git writes forward slashes in the pointer, also on Windows.
  const fwd = (p) => p.replace(/\\/g, '/');
  writeFileSync(path.join(slot, '.git'), `gitdir: ${fwd(path.join(root, '.git', 'worktrees', 'slot-01'))}\n`);
  writeFileSync(path.join(bareSlot, '.git'), `gitdir: ${fwd(path.join(root, '.git', 'worktrees', 'slot-02'))}\n`);
  writeFileSync(path.join(lostSlot, '.git'), 'gitdir: somewhere-else\n');
});

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function guard(cwd, filePath, raw) {
  return spawnSync(process.execPath, [hookPath], {
    cwd,
    input: raw ?? JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: filePath } }),
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function assertBlocked(result, rel) {
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, new RegExp(`BLOCKED: ${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is in the root checkout`));
}

describe('session in the main checkout', () => {
  test('blocks source edits in the root checkout', () => {
    assertBlocked(guard(root, path.join(root, 'apps', 'api', 'src', 'x.ts')), 'apps/api/src/x.ts');
  });

  test('has no allowlist for docs or agent config', () => {
    for (const rel of [
      'AGENTS.md',
      'CLAUDE.md',
      'README.md',
      'docs/ai-rules/validation.md',
      '.claude/settings.json',
      '.agents/skills/x/SKILL.md',
      '.codex/README.md',
    ]) {
      assertBlocked(guard(root, path.join(root, ...rel.split('/'))), rel.toLowerCase());
    }
  });

  test('allows paths outside the main checkout', () => {
    assert.equal(guard(root, path.join(slot, 'apps', 'x.ts')).status, 0);
    assert.equal(guard(root, path.join(scratch, 'scratchpad', 'notes.md')).status, 0);
  });

  test('only the two nested-worktree roots are exempt, not any folder named worktrees', () => {
    assertBlocked(guard(root, path.join(root, 'scripts', 'worktrees', 'pool.mjs')), 'scripts/worktrees/pool.mjs');
    assertBlocked(guard(root, path.join(root, 'apps', 'x', '.worktrees', 'y.ts')), 'apps/x/.worktrees/y.ts');
    assert.equal(guard(root, path.join(root, '.claude', 'worktrees', 'x', 'AGENTS.md')).status, 0);
  });

  test('allows the nested-worktree roots', () => {
    for (const rel of ['.claude/worktrees/feature/apps/x.ts', '.worktrees/feature/apps/x.ts']) {
      const result = guard(root, path.join(root, ...rel.split('/')));
      assert.equal(result.status, 0, `${rel}: ${result.stderr}`);
    }
  });

  test('no built-in allowlist: scratch-like folders are blocked', () => {
    for (const rel of ['tmp-notes/query.sql', 'drafts/today.md', 'vendor-repo/main.tf']) {
      assertBlocked(guard(root, path.join(root, ...rel.split('/'))), rel);
    }
  });

  test('walks up to the checkout root from a subfolder and reports the path relative to it', () => {
    const cwd = path.join(root, 'apps', 'api', 'src');
    assertBlocked(guard(cwd, path.join(cwd, 'x.ts')), 'apps/api/src/x.ts');
  });

  test('compares paths case-insensitively on Windows', (t) => {
    if (process.platform !== 'win32') return t.skip('case-insensitive filesystem only');
    assertBlocked(guard(root, path.join(root, 'APPS', 'x.ts').toUpperCase()), 'apps/x.ts');
  });
});

describe('session inside a linked worktree', () => {
  test('still blocks edits to the main checkout by absolute path', () => {
    assertBlocked(guard(slot, path.join(root, 'apps', 'api', 'src', 'x.ts')), 'apps/api/src/x.ts');
    assertBlocked(guard(slot, path.join(root, 'AGENTS.md')), 'agents.md');
  });

  test('blocks from a slot subfolder too', () => {
    const cwd = path.join(slot, 'apps', 'api', 'src');
    assertBlocked(guard(cwd, path.join(root, 'apps', 'x.ts')), 'apps/x.ts');
  });

  test('allows edits inside the slot itself', () => {
    assert.equal(guard(slot, path.join(slot, 'apps', 'api', 'src', 'x.ts')).status, 0);
    assert.equal(guard(slot, path.join(slot, 'AGENTS.md')).status, 0);
  });

  test('falls back to the <main>/.git/worktrees/<name> layout when commondir is missing', () => {
    assertBlocked(guard(bareSlot, path.join(root, 'apps', 'x.ts')), 'apps/x.ts');
    assert.equal(guard(bareSlot, path.join(bareSlot, 'apps', 'x.ts')).status, 0);
  });

  test('fails open when the main checkout cannot be resolved', () => {
    assert.equal(guard(lostSlot, path.join(root, 'apps', 'x.ts')).status, 0);
  });

  test('a Claude Code file_path ignores the payload cwd, which follows the shell cd', () => {
    const raw = JSON.stringify({
      cwd: path.join(scratch, 'not-a-repo'),
      tool_name: 'Edit',
      tool_input: { file_path: path.join(root, 'apps', 'x.ts') },
    });
    assertBlocked(guard(root, null, raw), 'apps/x.ts');
  });
});

// Codex PreToolUse payload for apply_patch: the patch text is tool_input.command and
// the session cwd is in the payload. The patches below use the real envelope.
function codex(hookCwd, sessionCwd, patch, toolName = 'apply_patch') {
  return guard(
    hookCwd,
    null,
    JSON.stringify({
      session_id: 's',
      transcript_path: null,
      cwd: sessionCwd,
      hook_event_name: 'PreToolUse',
      model: 'gpt-5-codex',
      permission_mode: 'default',
      turn_id: 't',
      tool_name: toolName,
      tool_use_id: 'call_1',
      tool_input: { command: patch },
    }),
  );
}

const patchOf = (...sections) => ['*** Begin Patch', ...sections, '*** End Patch', ''].join('\n');
const update = (p) => `*** Update File: ${p}\n@@ export function a() {\n-  return 1;\n+  return 2;\n }`;
const add = (p) => `*** Add File: ${p}\n+export const x = 1;`;
const del = (p) => `*** Delete File: ${p}`;
const move = (from, to) => `*** Update File: ${from}\n*** Move to: ${to}\n@@\n-a\n+b`;

describe('Codex apply_patch', () => {
  test('blocks a relative path that resolves into the root checkout', () => {
    assertBlocked(codex(root, root, patchOf(update('apps/api/src/x.ts'))), 'apps/api/src/x.ts');
  });

  test('allows a patch inside a slot', () => {
    const result = codex(slot, slot, patchOf(update('apps/api/src/x.ts'), add('apps/new.ts'), del('apps/old.ts')));
    assert.equal(result.status, 0, result.stderr);
  });

  test('checks Add, Delete and Move to paths too', () => {
    assertBlocked(codex(slot, slot, patchOf(add(path.join(root, 'apps', 'new.ts')))), 'apps/new.ts');
    assertBlocked(codex(slot, slot, patchOf(del(path.join(root, 'apps', 'old.ts')))), 'apps/old.ts');
    assertBlocked(codex(slot, slot, patchOf(move('apps/a.ts', path.join(root, 'apps', 'a.ts')))), 'apps/a.ts');
  });

  test('one root path in a multi-file patch blocks the whole patch', () => {
    const result = codex(slot, slot, patchOf(update('apps/ok.ts'), update(path.join(root, 'AGENTS.md'))));
    assertBlocked(result, 'agents.md');
    assert.doesNotMatch(result.stderr, /apps\/ok\.ts/);
  });

  test('resolves relative paths against the payload cwd, not the hook process cwd', () => {
    const sessionCwd = path.join(root, 'apps', 'api');
    const outside = path.join(scratch, 'codex-hook-cwd');
    mkdirSync(outside, { recursive: true });
    assertBlocked(codex(outside, sessionCwd, patchOf(update('src/x.ts'))), 'apps/api/src/x.ts');
    assertBlocked(codex(outside, sessionCwd, patchOf(update('../../AGENTS.md'))), 'agents.md');
  });

  test('a session in a slot cannot patch the root checkout, and the nested-worktree rule still holds', () => {
    assertBlocked(codex(slot, slot, patchOf(update(path.join(root, 'scripts', 'worktrees', 'pool.mjs')))), 'scripts/worktrees/pool.mjs');
    assert.equal(codex(root, root, patchOf(update('.claude/worktrees/x/AGENTS.md'))).status, 0);
  });

  test('parses CRLF patches', () => {
    assertBlocked(codex(root, root, patchOf(update('apps/x.ts')).replace(/\n/g, '\r\n')), 'apps/x.ts');
  });

  test('a shell command that holds a patch is parsed whatever the tool name', () => {
    const heredoc = `apply_patch <<'EOF'\n${patchOf(update('apps/x.ts'))}EOF\n`;
    assertBlocked(codex(root, root, heredoc, 'Bash'), 'apps/x.ts');
    assert.equal(codex(root, root, 'git status', 'Bash').status, 0);
  });

  test('a Codex Bash argv array that holds a patch is parsed too', () => {
    const heredoc = `apply_patch <<'EOF'\n${patchOf(update('apps/x.ts'))}EOF\n`;
    assertBlocked(codex(root, root, ['/bin/bash', '-lc', heredoc], 'Bash'), 'apps/x.ts');
    assert.equal(codex(root, root, ['pwsh.exe', '-Command', 'git status'], 'Bash').status, 0);
  });

  test('allows an apply_patch with no file headers', () => {
    assert.equal(codex(root, root, '*** Begin Patch\n*** End Patch\n').status, 0);
  });

  test('headers with extra or leading whitespace, or other casing, are still checked', () => {
    for (const header of [' *** Add File: AGENTS.md', '***  Add File: AGENTS.md', '\t***\tUpdate  File :AGENTS.md', '*** add file: AGENTS.md', '  *** Move to: AGENTS.md']) {
      assertBlocked(codex(root, root, `*** Begin Patch\n${header}\n+x\n*** End Patch\n`), 'agents.md');
    }
    assertBlocked(codex(root, root, ` ***  Begin Patch\n *** Delete File: AGENTS.md\n *** End Patch\n`, 'Bash'), 'agents.md');
  });
});

describe('path forms that name a root file without looking like it', () => {
  const refused = (result, why) => {
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, why);
  };

  test('device and UNC prefixes are refused', () => {
    const win = path.join(root, 'AGENTS.md').replace(/\//g, '\\');
    refused(guard(root, `\\\\?\\${win}`), /device or UNC path/);
    refused(guard(root, `\\\\.\\${win}`), /device or UNC path/);
    refused(guard(root, '\\\\server\\share\\AGENTS.md'), /device or UNC path/);
    refused(guard(root, '//server/share/AGENTS.md'), /device or UNC path/);
  });

  test('a ":" after the drive letter (an NTFS stream) is refused', () => {
    refused(guard(root, `${root}::$INDEX_ALLOCATION/AGENTS.md`), /NTFS stream/);
    refused(guard(root, `${path.join(root, 'AGENTS.md')}:hidden`), /NTFS stream/);
    refused(codex(root, root, patchOf(add('AGENTS.md::$DATA'))), /NTFS stream/);
  });

  test('a plain drive-letter path is not refused', () => {
    assert.equal(guard(root, path.join(slot, 'apps', 'x.ts')).status, 0);
  });

  test('a junction or symlink that points into the root is judged by where it lands', () => {
    const link = path.join(scratch, 'link-to-root');
    const inSlot = path.join(slot, 'link-to-root');
    symlinkSync(root, link, 'junction');
    symlinkSync(root, inSlot, 'junction');
    try {
      assertBlocked(guard(root, path.join(link, 'AGENTS.md')), 'agents.md');
      // The file does not exist yet: its deepest existing ancestor is the link.
      assertBlocked(guard(slot, path.join(inSlot, 'apps', 'new-dir', 'new.ts')), 'apps/new-dir/new.ts');
      assertBlocked(codex(slot, slot, patchOf(update('link-to-root/AGENTS.md'))), 'agents.md');
    } finally {
      // Remove the links themselves, never what they point at.
      for (const p of [link, inSlot]) {
        try {
          unlinkSync(p);
        } catch {
          rmdirSync(p);
        }
      }
    }
  });
});

describe('transcripts and approval stores', () => {
  // os.homedir() reads USERPROFILE (Windows) / HOME; os.tmpdir() reads TEMP/TMP / TMPDIR.
  let home;
  let tmp;
  before(() => {
    home = path.join(scratch, 'home');
    tmp = path.join(scratch, 'tmp');
    for (const d of [
      path.join(home, '.claude', 'projects', 'p--repo', 'memory'),
      path.join(home, '.claude', 'projects', 'p--repo', 'session-1', 'subagents'),
      path.join(home, '.codex', 'sessions', '2026', '10', '09'),
    ]) {
      mkdirSync(d, { recursive: true });
    }
    writeFileSync(path.join(home, '.claude', 'projects', 'p--repo', 'session-1.jsonl'), '{}\n');
  });

  const run = (payload, cwd = root) =>
    spawnSync(process.execPath, [hookPath], {
      cwd,
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, USERPROFILE: home, HOME: home, TEMP: tmp, TMP: tmp, TMPDIR: tmp },
    });
  const edit = (file, cwd) => run({ tool_name: 'Edit', tool_input: { file_path: file } }, cwd);
  const protectedBlock = (result, what) => {
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, what);
  };

  test('blocks Claude Code transcripts at any depth, from a slot and from outside any repo', () => {
    const projects = path.join(home, '.claude', 'projects', 'p--repo');
    protectedBlock(edit(path.join(projects, 'session-1.jsonl')), /a Claude Code transcript/);
    protectedBlock(edit(path.join(projects, 'session-1', 'subagents', 'agent-a1.jsonl'), slot), /a Claude Code transcript/);
    protectedBlock(edit(path.join(projects, 'new-session.JSONL'), scratch), /a Claude Code transcript/);
  });

  test('keeps memory notes and other ~/.claude files writable', () => {
    const memory = path.join(home, '.claude', 'projects', 'p--repo', 'memory');
    for (const file of [path.join(memory, 'MEMORY.md'), path.join(memory, 'feedback_x.md'), path.join(home, '.claude', 'settings.json')]) {
      const result = edit(file, slot);
      assert.equal(result.status, 0, `${file}: ${result.stderr}`);
    }
  });

  test('blocks Codex sessions', () => {
    protectedBlock(edit(path.join(home, '.codex', 'sessions', '2026', '10', '09', 'rollout-1.jsonl')), /a Codex session transcript/);
    protectedBlock(edit(path.join(home, '.codex', 'sessions', 'notes.txt')), /a Codex session transcript/);
  });

  test('blocks a Codex apply_patch into a transcript', () => {
    const transcript = path.join(home, '.claude', 'projects', 'p--repo', 'session-1.jsonl');
    const patch = `*** Begin Patch\n*** Update File: ${transcript}\n@@\n-{}\n+{"type":"user"}\n*** End Patch\n`;
    protectedBlock(run({ cwd: slot, tool_name: 'apply_patch', tool_input: { command: patch } }, slot), /a Claude Code transcript/);
  });

  test('a junction to the projects folder is judged by where it lands', () => {
    const link = path.join(scratch, 'projects-link');
    symlinkSync(path.join(home, '.claude', 'projects'), link, 'junction');
    try {
      protectedBlock(edit(path.join(link, 'p--repo', 'session-1.jsonl'), slot), /a Claude Code transcript/);
    } finally {
      try {
        unlinkSync(link);
      } catch {
        rmdirSync(link);
      }
    }
  });

  test('compares case-insensitively on Windows', (t) => {
    if (process.platform !== 'win32') return t.skip('case-insensitive filesystem only');
    protectedBlock(edit(path.join(home, '.CLAUDE', 'PROJECTS', 'p--repo', 'S.JSONL')), /a Claude Code transcript/);
  });
});

describe('input handling', () => {
  test('fails open on malformed JSON and on a payload with no file path', () => {
    assert.equal(guard(root, null, '{not json').status, 0);
    assert.equal(guard(root, null, JSON.stringify({ tool_input: {} })).status, 0);
    assert.equal(guard(root, null, 'null').status, 0);
  });

  test('allows everything when no .git exists above cwd', (t) => {
    const outside = path.join(scratch, 'not-a-repo');
    mkdirSync(outside, { recursive: true });
    // A dotfiles repo in a parent of the temp dir would make this a real repo.
    for (let dir = scratch; ; dir = path.dirname(dir)) {
      if (existsSync(path.join(dir, '.git'))) return t.skip(`${dir} is inside a git repo`);
      if (path.dirname(dir) === dir) break;
    }
    assert.equal(guard(outside, path.join(root, 'apps', 'x.ts')).status, 0);
  });
});

describe('owner unlock (ownerUnlockPhrase)', () => {
  const PHRASE = 'UNLOCK-ROOT-7';
  const human = (text, uuid = 'u1') =>
    JSON.stringify({ type: 'user', uuid, origin: { kind: 'human' }, message: { role: 'user', content: [{ type: 'text', text }] } });
  const assistant = (text) =>
    JSON.stringify({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  const toolResult = (text) =>
    JSON.stringify({ type: 'user', uuid: 't1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: text }] } });
  const codexHuman = (text) =>
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'c1', content: [{ type: 'text', text }] } },
    });

  let n = 0;
  const transcriptOf = (...lines) => {
    n += 1;
    const file = path.join(scratch, `transcript-${n}.jsonl`);
    writeFileSync(file, `${lines.join('\n')}\n`);
    return file;
  };
  const configFile = () => path.join(root, 'worktree-pool.config.json');
  const withConfig = (config, fn) => {
    writeFileSync(configFile(), JSON.stringify(config));
    try {
      fn();
    } finally {
      rmSync(configFile(), { force: true });
    }
  };
  const rootFile = () => path.join(root, 'apps', 'api', 'src', 'x.ts');
  const edit = (transcriptPath, extra = {}) =>
    guard(root, null, JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: rootFile() }, transcript_path: transcriptPath, ...extra }));
  const configured = { poolDirectory: '../pool-worktrees', ownerUnlockPhrase: PHRASE };

  test('allows root edits when the human typed the phrase in an earlier message', () => {
    withConfig(configured, () => {
      const t = transcriptOf(human(`ok do that. ${PHRASE}`, 'u1'), assistant('done'), human('now fix the bug', 'u2'));
      const result = edit(t);
      assert.equal(result.status, 0, result.stderr);
    });
  });

  test('the feature is OFF when the config sets no phrase', () => {
    withConfig({ poolDirectory: '../pool-worktrees' }, () => {
      assertBlocked(edit(transcriptOf(human(PHRASE))), 'apps/api/src/x.ts');
    });
    assertBlocked(edit(transcriptOf(human(PHRASE))), 'apps/api/src/x.ts'); // no config at all
  });

  test('keeps the block without the phrase, or with a near miss', () => {
    withConfig(configured, () => {
      assertBlocked(edit(transcriptOf(human('fix the bug'))), 'apps/api/src/x.ts');
      assertBlocked(edit(transcriptOf(human(`${PHRASE}S`))), 'apps/api/src/x.ts');
      assertBlocked(edit(transcriptOf(human(PHRASE.toLowerCase()))), 'apps/api/src/x.ts');
    });
  });

  test('a phrase with regex characters is matched literally', () => {
    withConfig({ ...configured, ownerUnlockPhrase: 'a.b (go)' }, () => {
      assert.equal(edit(transcriptOf(human('please a.b (go) now'))).status, 0);
      assertBlocked(edit(transcriptOf(human('please axb (go) now'))), 'apps/api/src/x.ts');
    });
  });

  test('ignores the phrase in assistant text, tool output, reminders, pasted content and IDE selections', () => {
    withConfig(configured, () => {
      for (const line of [
        assistant(`type ${PHRASE} to unlock`),
        toolResult(PHRASE),
        JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: PHRASE }] } }),
        human(`<system-reminder>${PHRASE}</system-reminder> hello`),
        human(`<pasted_content id="x">${PHRASE}</pasted_content> what is this?`),
        human(`<ide_selection>${PHRASE}</ide_selection>`),
      ]) {
        assertBlocked(edit(transcriptOf(human('hi', 'u0'), line)), 'apps/api/src/x.ts');
      }
    });
  });

  test('keeps the block when there is no transcript or it cannot be read', () => {
    withConfig(configured, () => {
      assertBlocked(guard(root, rootFile()), 'apps/api/src/x.ts');
      assertBlocked(edit(path.join(scratch, 'missing.jsonl')), 'apps/api/src/x.ts');
    });
  });

  test('reads a Codex rollout for the Codex human-message shape', () => {
    withConfig(configured, () => {
      assert.equal(edit(transcriptOf(codexHuman(PHRASE)), { turn_id: 'turn-1' }).status, 0);
    });
  });

  test('never unlocks transcripts', () => {
    withConfig(configured, () => {
      const t = transcriptOf(human(PHRASE));
      const raw = JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: path.join(homedir(), '.claude', 'projects', 'p', 'session.jsonl') },
        transcript_path: t,
      });
      const result = guard(root, null, raw);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /a Claude Code transcript/);
    });
  });
});

describe('rootAllow', () => {
  const configFile = () => path.join(root, 'worktree-pool.config.json');
  const withConfig = (config, fn) => {
    writeFileSync(configFile(), JSON.stringify(config));
    try {
      fn();
    } finally {
      rmSync(configFile(), { force: true });
    }
  };

  test('defaults to nothing allowed', () => {
    withConfig({ poolDirectory: '../pool-worktrees' }, () => {
      assertBlocked(guard(root, path.join(root, 'notes', 'a.md')), 'notes/a.md');
    });
  });

  test('allows listed prefixes (case-insensitive, with or without slashes) and nothing else', () => {
    withConfig({ poolDirectory: '../pool-worktrees', rootAllow: ['notes/', './Scratch', 'tmp\\out'] }, () => {
      for (const rel of ['notes/a.md', 'notes/deep/b.md', 'scratch/q.sql', 'tmp/out/x.txt']) {
        const result = guard(root, path.join(root, ...rel.split('/')));
        assert.equal(result.status, 0, `${rel}: ${result.stderr}`);
      }
      assertBlocked(guard(root, path.join(root, 'notes-extra', 'a.md')), 'notes-extra/a.md');
      assertBlocked(guard(root, path.join(root, 'tmp', 'other.txt')), 'tmp/other.txt');
    });
  });

  test('a malformed rootAllow is ignored', () => {
    withConfig({ poolDirectory: '../pool-worktrees', rootAllow: 'notes' }, () => {
      assertBlocked(guard(root, path.join(root, 'notes', 'a.md')), 'notes/a.md');
    });
  });

  test('applies to a Codex apply_patch too', () => {
    withConfig({ poolDirectory: '../pool-worktrees', rootAllow: ['notes'] }, () => {
      const patch = `*** Begin Patch\n*** Add File: notes/a.md\n+x\n*** End Patch\n`;
      assert.equal(guard(root, null, JSON.stringify({ cwd: root, tool_name: 'apply_patch', tool_input: { command: patch } })).status, 0);
    });
  });
});

// Slot ownership: with a pool config in the main checkout, an edit inside
// <poolRoot>/slot-NN/ must match the slot's lease owner. The config is written
// only for this block, so the earlier tests keep running without enforcement.
describe('slot ownership', () => {
  const OWN = '11111111-2222-4333-8444-555555555555';
  const OTHER = '99999999-8888-4777-8666-555555555555';
  const OWN_TOKEN = 'aaaaaaaa-0000-4000-8000-000000000001';
  let stateRoot;
  let configFile;
  let foreignSlot; // slot-02 (bareSlot), leased to OTHER
  let freeSlot; // slot-03 (lostSlot), no lease
  let hostSlot; // slot-04, lease owner is user@host

  const cleanEnv = (extra = {}) => {
    const env = { ...process.env };
    for (const k of ['WT_OWNER', 'CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID']) delete env[k];
    return { ...env, ...extra };
  };
  const run = (payload, { cwd = slot, env = cleanEnv() } = {}) =>
    spawnSync(process.execPath, [hookPath], { cwd, input: JSON.stringify(payload), encoding: 'utf8', timeout: 30_000, env });
  const edit = (file, session, extra = {}, opts = {}) =>
    run({ tool_name: 'Edit', tool_input: { file_path: file }, ...(session ? { session_id: session } : {}), ...extra }, opts);
  const lease = (name, owner, token = `token-${name}`) =>
    writeFileSync(
      path.join(stateRoot, 'leases', `${name}.json`),
      JSON.stringify({ version: 1, token, slot: name, path: path.join(scratch, 'pool-worktrees', name), branch: `feat/${name}`, owner }),
    );

  before(() => {
    stateRoot = path.join(scratch, 'pool-worktrees', '.pool');
    configFile = path.join(root, 'worktree-pool.config.json');
    foreignSlot = bareSlot;
    freeSlot = lostSlot;
    hostSlot = path.join(scratch, 'pool-worktrees', 'slot-04');
    mkdirSync(path.join(hostSlot, 'apps'), { recursive: true });
    mkdirSync(path.join(stateRoot, 'leases'), { recursive: true });
    writeFileSync(configFile, JSON.stringify({ version: 1, slotCount: 4, poolDirectory: '../pool-worktrees', slotPrefix: 'slot-' }));
    lease('slot-01', OWN, OWN_TOKEN);
    lease('slot-02', OTHER);
    lease('slot-04', 'alice@LAPTOP');
  });

  after(() => {
    rmSync(configFile, { force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  });

  test('allows an edit in the slot this session leased and touches the heartbeat', () => {
    const result = edit(path.join(slot, 'apps', 'api', 'src', 'x.ts'), OWN);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(path.join(stateRoot, 'heartbeats', OWN_TOKEN)), 'heartbeat file created');
  });

  test('blocks an edit in an unleased slot with the acquire hint', () => {
    const result = edit(path.join(freeSlot, 'apps', 'x.ts'), OWN);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /BLOCKED: .*slot-03, which is not leased/);
    assert.match(result.stderr, /wt acquire <branch> --purpose "<task>"/);
  });

  test('blocks a slot leased to another session, naming the lessee, branch and the adopt command', () => {
    const result = edit(path.join(foreignSlot, 'apps', 'x.ts'), OWN);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /slot-02, which is leased to session 99999999 \(branch feat\/slot-02\)/);
    assert.match(result.stderr, /wt adopt --slot 2/);
    assert.doesNotMatch(result.stderr, new RegExp(OTHER));
    assert.ok(!existsSync(path.join(stateRoot, 'heartbeats', 'token-slot-02')), 'no heartbeat for a blocked edit');
  });

  test('allows a slot whose lease owner is not a session id (user@host)', () => {
    assert.equal(edit(path.join(hostSlot, 'apps', 'x.ts'), OWN).status, 0);
  });

  test('allows a foreign slot when this session id is unknown', () => {
    assert.equal(edit(path.join(foreignSlot, 'apps', 'x.ts'), null).status, 0);
  });

  test('takes the session id from the transcript file name (Claude and Codex)', () => {
    const file = path.join(slot, 'apps', 'x.ts');
    const claude = path.join(scratch, 'projects', 'p', `${OWN}.jsonl`);
    const codex = path.join(scratch, 'sessions', `rollout-2026-10-16T10-00-00-${OWN}.jsonl`);
    assert.equal(edit(file, null, { transcript_path: claude }).status, 0);
    assert.equal(edit(file, null, { transcript_path: codex }).status, 0);
    const other = path.join(scratch, 'projects', 'p', `${OTHER}.jsonl`);
    assert.equal(edit(file, null, { transcript_path: other }).status, 2);
  });

  test('matches the owner through WT_OWNER', () => {
    const file = path.join(slot, 'apps', 'x.ts');
    assert.equal(edit(file, null, {}, { env: cleanEnv({ WT_OWNER: OWN }) }).status, 0);
    assert.equal(edit(file, OTHER, {}, { env: cleanEnv({ WT_OWNER: OWN }) }).status, 0);
    assert.equal(edit(file, null, {}, { env: cleanEnv({ WT_OWNER: OTHER }) }).status, 2);
  });

  test('allows a slot whose lease file is broken JSON', () => {
    writeFileSync(path.join(stateRoot, 'leases', 'slot-02.json'), '{not json');
    try {
      assert.equal(edit(path.join(foreignSlot, 'apps', 'x.ts'), OWN).status, 0);
    } finally {
      lease('slot-02', OTHER);
    }
  });

  test('enforces nothing without a pool config', () => {
    rmSync(configFile, { force: true });
    try {
      assert.equal(edit(path.join(foreignSlot, 'apps', 'x.ts'), OWN).status, 0);
      assert.equal(edit(path.join(freeSlot, 'apps', 'x.ts'), OWN).status, 0);
    } finally {
      writeFileSync(configFile, JSON.stringify({ version: 1, slotCount: 4, poolDirectory: '../pool-worktrees', slotPrefix: 'slot-' }));
    }
  });

  test('checks Codex apply_patch paths against the lease too', () => {
    const patch = `*** Begin Patch\n*** Update File: apps/x.ts\n@@\n-a\n+b\n*** End Patch\n`;
    const blocked = run({ session_id: OWN, cwd: foreignSlot, tool_name: 'apply_patch', tool_input: { command: patch } }, { cwd: foreignSlot });
    assert.equal(blocked.status, 2, blocked.stderr);
    assert.match(blocked.stderr, /slot-02, which is leased to session 99999999/);
    const own = run({ session_id: OWN, cwd: slot, tool_name: 'apply_patch', tool_input: { command: patch } }, { cwd: slot });
    assert.equal(own.status, 0, own.stderr);
  });

  test('root-checkout rules still win over slot ownership', () => {
    assertBlocked(edit(path.join(root, 'apps', 'x.ts'), OWN), 'apps/x.ts');
    const patch = `*** Begin Patch\n*** Update File: ${path.join(root, 'AGENTS.md')}\n@@\n-a\n+b\n*** Update File: apps/x.ts\n@@\n-a\n+b\n*** End Patch\n`;
    assertBlocked(run({ session_id: OWN, cwd: foreignSlot, tool_name: 'apply_patch', tool_input: { command: patch } }, { cwd: foreignSlot }), 'agents.md');
  });
});
