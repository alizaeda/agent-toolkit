/**
 * PreToolUse hook: refuses file edits against the MAIN (root) checkout.
 * `wt` below means the pool CLI: node scripts/pool.mjs of the worktree-pool plugin.
 *   - Claude Code: Edit/MultiEdit/Write/NotebookEdit, path in tool_input.file_path.
 *   - Codex: apply_patch, patch text in tool_input.command. Every path on an
 *     `*** Add File:`, `*** Update File:`, `*** Delete File:` or `*** Move to:`
 *     line is checked; relative paths resolve against the payload `cwd`. A
 *     command that holds a patch (`*** Begin Patch`) is parsed the same way
 *     whatever the tool name, also as an argv array.
 *
 * The root checkout is coordination-only. Every repo edit belongs in a leased
 * pool slot (`wt acquire`). Decisions are made on the EDITED FILE PATH, not on
 * where the session runs.
 *
 * Finding the main checkout
 * -------------------------
 * The search starts at process.cwd() for a Claude Code file_path, and at the
 * payload `cwd` for a patch, then walks up to the nearest `.git`:
 *   - `.git` is a DIRECTORY: that directory is the main checkout.
 *   - `.git` is a FILE (`gitdir: <path>`): a linked worktree. Its gitdir has a
 *     `commondir` file that points back at `<main>/.git`, so a session inside a
 *     slot still cannot edit the root checkout by absolute path.
 * When the main checkout cannot be resolved, the hook fails open.
 *
 * Config: <main>/worktree-pool.config.json
 *   poolDirectory      where the slots live (relative to the main checkout)
 *   slotPrefix         slot folder prefix (default "slot-")
 *   rootAllow          optional string array of path prefixes, relative to the
 *                      main checkout, that stay editable at the root (default [])
 *   ownerUnlockPhrase  optional string; see Owner unlock (default: feature OFF)
 *
 * Transcripts
 * -----------
 * Blocked wherever the session runs, slot or not: `*.jsonl` under
 * ~/.claude/projects/ (any depth) and anything under ~/.codex/sessions/. A
 * forged human line in a transcript would read as the owner's words. Memory
 * notes (~/.claude/projects/<p>/memory/*.md) stay writable. Judged at the real
 * location too, case-insensitively.
 *
 * Path forms
 * ----------
 * Device paths (backslash-backslash-? or -.), UNC paths (\\server\share) and a
 * `:` after the drive letter (NTFS streams such as `::$INDEX_ALLOCATION`) are
 * refused outright. Each target is judged as written and at its real location
 * (realpath of the deepest existing ancestor), so a junction or symlink into
 * the root is caught.
 *
 * Allowed:
 *   - Anything outside the main checkout: pool slots, other worktrees, the
 *     session scratchpad, ~/.claude.
 *   - The two nested-worktree roots under the main checkout: .worktrees/ and
 *     .claude/worktrees/. Other folders named `worktrees` are source.
 *   - Paths under a `rootAllow` prefix from the config.
 *
 * Owner unlock
 * ------------
 * Off unless the config sets `ownerUnlockPhrase`. When set, the owner can allow
 * root-checkout edits for ONE session by typing that phrase in a message. The
 * guard reads the session transcript (`transcript_path`) and counts only text a
 * human typed (see human-typed.cjs): tool output, assistant text, injected
 * reminders and pasted content never count, and agents cannot write
 * transcripts. The unlock covers root edits only: transcripts and device, UNC
 * and NTFS-stream paths stay blocked. A missing or unreadable transcript keeps
 * the block.
 *
 * Slot ownership
 * --------------
 * A pool slot is leased to one session (`<poolRoot>/.pool/leases/slot-NN.json`).
 * An edit inside `<poolRoot>/<slotPrefix>NN/` (as written or at its real
 * location) is checked against that lease:
 *   - no lease: blocked, with the `acquire` command to run.
 *   - the lease owner is a session id (UUID-shaped) and none of this session's
 *     ids match it: blocked. The message names the lessee (first 8 chars) and
 *     its branch, and points at `wt adopt --slot N` for an own slot after
 *     /clear or a resume.
 *   - the owner is not UUID-shaped (`user@host`, custom WT_OWNER), or this
 *     session's id is unknown: allowed, nothing to compare.
 * This session's ids: payload.session_id, the id in payload.transcript_path
 * (Claude `<id>.jsonl`, Codex `rollout-<ts>-<id>.jsonl`) and the env vars
 * WT_OWNER, CODEX_THREAD_ID and CLAUDE_CODE_SESSION_ID. An allowed slot edit
 * touches `<poolRoot>/.pool/heartbeats/<lease.token>`. Without a pool config
 * there is no slot enforcement. Every error in this check fails OPEN.
 * Root-checkout rules are judged first and always win.
 *
 * Fails OPEN on unparseable input.
 *
 * Exit 2 = block, with the reason on stderr fed back to the agent.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

// Windows drive letters and paths are case-insensitive at the filesystem level;
// compare case-insensitively so e.g. "p:/..." vs "P:/..." (same file, different
// casing from wherever each path string originated) can't slip past the guard as
// if they were unrelated locations.
const norm = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();

/** `<main>/.git` for a linked worktree whose `.git` file is `dotGitFile`, or null. */
function commonGitDir(worktreeDir, dotGitFile) {
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGitFile, 'utf8'));
  if (!match) return null;
  const gitdir = path.resolve(worktreeDir, match[1]);
  try {
    return path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim());
  } catch {
    // No commondir file: fall back to the standard `<main>/.git/worktrees/<name>` layout.
    const layout = /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/.exec(gitdir);
    return layout ? path.join(layout[1], '.git') : null;
  }
}

/** The main checkout of the repo that contains `start`, or null when it cannot be resolved. */
function mainCheckoutRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    let stat = null;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      // no .git here — keep walking up
    }
    if (stat?.isDirectory()) return dir;
    if (stat?.isFile()) {
      const common = commonGitDir(dir, dotGit);
      // A bare or otherwise unusual common dir has no main working tree to guard.
      if (!common || path.basename(common).toLowerCase() !== '.git') return null;
      return path.dirname(common);
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Main checkout for `start`, or null; an unreadable .git pointer counts as unresolved. */
function safeMainRoot(start) {
  try {
    return mainCheckoutRoot(start);
  } catch {
    return null;
  }
}

// apply_patch file headers. A patch names every file it adds, updates, deletes or
// moves to on one of these lines; `*** Move to:` follows an Update File header.
// Loose on whitespace and case on purpose: a header the guard skips is an unguarded
// edit. `[^\S\n]` is any whitespace except a line break, so a match stays on one line.
const PATCH_FILE_LINE =
  /^[^\S\n]*\*\*\*[^\S\n]*(?:(?:Add|Update|Delete)[^\S\n]+File|Move[^\S\n]+to)[^\S\n]*:[^\S\n]*(.+?)\s*$/gim;
const PATCH_BEGIN = /^[^\S\n]*\*\*\*[^\S\n]*Begin[^\S\n]+Patch\b/im;

/** Every path an apply_patch body touches, in order. */
function patchPaths(patch) {
  return [...patch.matchAll(PATCH_FILE_LINE)].map((m) => m[1]);
}

/**
 * Why a path string is refused outright, or null. No legitimate edit needs these
 * forms, and each one can name a root-checkout file without looking like it:
 * `\\?\` and `\\.\` device paths and `\\server\share` UNC paths skip normal path
 * parsing, and a `:` after the drive letter opens an NTFS stream such as
 * `::$INDEX_ALLOCATION`, which reaches a directory through a different spelling.
 */
function refusedForm(p) {
  if (/^[\\/]{2}/.test(p)) return 'a device or UNC path (\\\\?\\, \\\\.\\ or \\\\server\\share)';
  if (p.replace(/^[A-Za-z]:/, '').includes(':')) return 'a ":" after the drive letter (an NTFS stream)';
  return null;
}

/**
 * The real location of `abs`: realpath of its deepest existing ancestor, with the
 * part that does not exist yet appended. Follows junctions and symlinks, so a link
 * that points into the root checkout is judged by where it lands. Null if nothing
 * along the path resolves.
 */
function realLocation(abs) {
  const tail = [];
  let cur = path.resolve(abs);
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...tail);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/** Normalized spellings of `dir`: as written and at its real location. */
function spellingsOf(dir) {
  const out = [norm(dir)];
  const real = realLocation(dir);
  if (real && !out.includes(norm(real))) out.push(norm(real));
  return out;
}

/**
 * Files an agent must never write with file tools: session transcripts. A forged
 * "human" line would read as the owner's words. Memory notes
 * (~/.claude/projects/<p>/memory/*.md) stay writable: they are not .jsonl.
 */
function protectedAreas() {
  const home = os.homedir();
  return [
    { base: path.join(home, '.claude', 'projects'), only: (rel) => rel.endsWith('.jsonl'), what: 'a Claude Code transcript' },
    { base: path.join(home, '.codex', 'sessions'), only: () => true, what: 'a Codex session transcript' },
  ].map((a) => ({ ...a, bases: spellingsOf(a.base) }));
}

let areas = null;

/** What protected file one of the normalized `targets` spellings is, or null. */
function protectedKind(targets) {
  areas = areas || protectedAreas();
  for (const area of areas) {
    for (const base of area.bases) {
      for (const t of targets) {
        if (t.startsWith(`${base}/`) && area.only(t.slice(base.length + 1))) return area.what;
      }
    }
  }
  return null;
}

/** Lowercased, slash-separated `rootAllow` prefixes from a config value. */
function normalizeRootAllow(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v) => typeof v === 'string' && v.trim())
    .map((v) => v.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase())
    .filter(Boolean);
}

/** Root-relative path of normalized `target` when it is a guarded path under normalized `root`, else null. */
function guardedRel(target, root, rootAllow) {
  // Anything outside the main checkout (a slot, another worktree, the scratchpad,
  // ~/.claude) is allowed.
  if (!target.startsWith(`${root}/`)) return null;
  const rel = target.slice(root.length + 1);
  // The two nested-worktree roots only — not any folder that happens to be named
  // `worktrees` (scripts/worktrees/ is source).
  if (/^(\.worktrees|\.claude\/worktrees)\//.test(rel)) return null;
  // rel and rootAllow are both lowercased.
  if (rootAllow.some((d) => rel === d || rel.startsWith(`${d}/`))) return null;
  return rel;
}

/** Config object of the main checkout at `mainRoot`, or {} when missing or broken. */
function readConfig(mainRoot) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(mainRoot, POOL_CONFIG_FILE), 'utf8'));
    return config && typeof config === 'object' ? config : {};
  } catch {
    return {};
  }
}

/** True when the human typed the configured unlock phrase in this session. Any error keeps the block. */
function ownerUnlocked(payload, phrase) {
  if (typeof phrase !== 'string' || !phrase.trim()) return false;
  const transcript = payload && payload.transcript_path;
  if (typeof transcript !== 'string' || !transcript) return false;
  try {
    const escaped = phrase.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`);
    return pattern.test(require('./human-typed.cjs').humanTypedText(transcript));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Slot ownership (see the header). Everything here fails open.
// ---------------------------------------------------------------------------

const POOL_CONFIG_FILE = 'worktree-pool.config.json';
const DEFAULT_SLOT_PREFIX = 'slot-';
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRAILING_UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
// A lease token names the heartbeat file: refuse anything that could leave the dir.
const SAFE_TOKEN = /^[\w.-]+$/;

/** Pool layout for the main checkout at `mainRoot`, or null when it has no readable pool config. */
function poolLayout(mainRoot) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(mainRoot, POOL_CONFIG_FILE), 'utf8'));
    if (!config || typeof config.poolDirectory !== 'string' || !config.poolDirectory) return null;
    const poolRoot = path.resolve(mainRoot, config.poolDirectory);
    const prefix =
      typeof config.slotPrefix === 'string' && config.slotPrefix ? config.slotPrefix : DEFAULT_SLOT_PREFIX;
    return { poolRoot, stateRoot: path.join(poolRoot, '.pool'), prefix, roots: spellingsOf(poolRoot) };
  } catch {
    return null;
  }
}

/** The slot (`slot-NN`) one of the normalized `targets` spellings lands in, or null. */
function slotOf(targets, pool) {
  const prefix = pool.prefix.toLowerCase();
  for (const root of pool.roots) {
    for (const t of targets) {
      if (!t.startsWith(`${root}/`)) continue;
      const first = t.slice(root.length + 1).split('/')[0];
      if (!first.startsWith(prefix)) continue;
      const digits = first.slice(prefix.length);
      if (/^\d+$/.test(digits)) return { name: `${pool.prefix}${digits}`, number: Number(digits) };
    }
  }
  return null;
}

/** Every id this session may be known by in a lease: payload, transcript file name, env. */
function sessionIds(payload) {
  const ids = [];
  const add = (v) => {
    if (typeof v === 'string' && v.trim() && !ids.includes(v.trim())) ids.push(v.trim());
  };
  add(payload && payload.session_id);
  if (payload && typeof payload.transcript_path === 'string') {
    const base = path.basename(payload.transcript_path).replace(/\.jsonl?$/i, '');
    const m = TRAILING_UUID.exec(base);
    if (m) add(m[1]);
  }
  add(process.env.WT_OWNER);
  add(process.env.CODEX_THREAD_ID);
  add(process.env.CLAUDE_CODE_SESSION_ID);
  return ids;
}

/** Create-or-update the heartbeat file of `lease`. Never throws. */
function touchHeartbeat(pool, lease) {
  try {
    const token = lease && lease.token;
    if (typeof token !== 'string' || !SAFE_TOKEN.test(token)) return;
    const dir = path.join(pool.stateRoot, 'heartbeats');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, token);
    const now = new Date();
    try {
      fs.utimesSync(file, now, now);
    } catch {
      fs.closeSync(fs.openSync(file, 'a'));
      fs.utimesSync(file, now, now);
    }
  } catch {
    // a heartbeat is advisory: a failed touch never blocks an edit
  }
}

/**
 * Why a slot edit of the `raw` targets is refused, or null when every slot target
 * is allowed (and its lease heartbeat was touched). `mainRootOf(start)` resolves
 * the main checkout for a target. Any error means allow.
 */
function slotOwnershipBlock(raw, payload, mainRootOf) {
  try {
    const pools = new Map(); // main root -> pool layout or null
    const ids = sessionIds(payload);
    const allowed = new Map(); // slot name -> { pool, lease } to heartbeat
    for (const { p, base, start } of raw) {
      const mainRoot = mainRootOf(start);
      if (!mainRoot) continue;
      if (!pools.has(mainRoot)) pools.set(mainRoot, poolLayout(mainRoot));
      const pool = pools.get(mainRoot);
      if (!pool) continue;
      const abs = path.resolve(base, p);
      const real = realLocation(abs);
      const slot = slotOf(real ? [norm(abs), norm(real)] : [norm(abs)], pool);
      if (!slot) continue;
      if (allowed.has(slot.name)) continue;

      let lease = null;
      try {
        lease = JSON.parse(fs.readFileSync(path.join(pool.stateRoot, 'leases', `${slot.name}.json`), 'utf8'));
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          return (
            `BLOCKED: ${p} is in ${slot.name}, which is not leased. ` +
            'Lease a slot first: run the worktree-pool skill\'s `acquire` command (wt acquire <branch> --purpose "<task>"), then edit inside the returned slot path.'
          );
        }
        continue; // unreadable or broken lease: nothing to compare, allow
      }
      if (!lease || typeof lease !== 'object') continue;
      const owner = typeof lease.owner === 'string' ? lease.owner.trim() : '';
      if (UUID_SHAPE.test(owner) && ids.length > 0 && !ids.some((id) => id.toLowerCase() === owner.toLowerCase())) {
        const branch = typeof lease.branch === 'string' && lease.branch ? lease.branch : '(unknown branch)';
        return (
          `BLOCKED: ${p} is in ${slot.name}, which is leased to session ${owner.slice(0, 8)} (branch ${branch}). ` +
          `If this is your own slot after /clear or a resume, run: wt adopt --slot ${slot.number}. ` +
          'Otherwise lease your own slot: run the worktree-pool skill\'s `acquire` command (wt acquire <branch> --purpose "<task>").'
        );
      }
      allowed.set(slot.name, { pool, lease });
    }
    for (const { pool, lease } of allowed.values()) touchHeartbeat(pool, lease);
    return null;
  } catch {
    return null;
  }
}

let data = '';
process.stdin.on('data', (chunk) => (data += chunk));
process.stdin.on('end', () => {
  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    process.exit(0); // fail open
  }
  const input = (payload && payload.tool_input) || {};
  // Raw path strings, each with the directory a relative path resolves against and
  // the directory the root search starts from.
  const raw = [];

  // Claude Code Edit/Write/NotebookEdit: an absolute file_path. The root search starts
  // from process.cwd().
  if (typeof input.file_path === 'string' && input.file_path) {
    raw.push({ p: input.file_path, base: process.cwd(), start: process.cwd() });
  }

  // Codex apply_patch: the patch text is tool_input.command, and its paths are
  // relative to the session cwd in the payload. A Codex Bash call may send its command
  // as an argv array (`["bash", "-lc", "apply_patch <<'EOF' ..."]`): read it joined.
  const command =
    typeof input.command === 'string'
      ? input.command
      : Array.isArray(input.command) && input.command.every((part) => typeof part === 'string')
        ? input.command.join('\n')
        : '';
  if (payload?.tool_name === 'apply_patch' || PATCH_BEGIN.test(command)) {
    const base = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
    for (const p of patchPaths(command)) raw.push({ p, base, start: base });
  }

  const refused = raw.map(({ p }) => [p, refusedForm(p)]).filter(([, why]) => why);
  if (refused.length > 0) {
    const [p, why] = refused[0];
    console.error(
      `BLOCKED: ${p} uses ${why}. Name the file with a plain absolute path inside a leased slot.`,
    );
    process.exit(2);
  }

  // Agent transcripts and the approval stores, wherever the session runs.
  for (const { p, base } of raw) {
    const abs = path.resolve(base, p);
    const real = realLocation(abs);
    const what = protectedKind(real ? [norm(abs), norm(real)] : [norm(abs)]);
    if (what) {
      console.error(
        `BLOCKED: ${p} is ${what}. Agents may not write it with file tools: it is the record of ` +
          'what the human said and what each agent did.',
      );
      process.exit(2);
    }
  }

  const mainRoots = new Map(); // start dir -> main checkout path or null
  const mainRootOf = (start) => {
    if (!mainRoots.has(start)) mainRoots.set(start, safeMainRoot(start) || safeMainRoot(process.cwd()));
    return mainRoots.get(start);
  };
  const roots = new Map(); // start dir -> normalized root spellings ([] when unresolved)
  const rootsFor = (start) => {
    if (!roots.has(start)) {
      const mainRoot = mainRootOf(start);
      const spellings = [];
      if (mainRoot) {
        spellings.push(norm(mainRoot));
        const real = realLocation(mainRoot);
        if (real && !spellings.includes(norm(real))) spellings.push(norm(real));
      }
      roots.set(start, spellings);
    }
    return roots.get(start);
  };

  const allowOf = (start) => {
    const mainRoot = mainRootOf(start);
    return mainRoot ? normalizeRootAllow(readConfig(mainRoot).rootAllow) : [];
  };

  const blocked = [];
  let unlockPhrase = null;
  for (const { p, base, start } of raw) {
    const abs = path.resolve(base, p);
    const real = realLocation(abs);
    const spellings = real ? [norm(abs), norm(real)] : [norm(abs)];
    for (const target of spellings) {
      for (const root of rootsFor(start)) {
        const rel = guardedRel(target, root, allowOf(start));
        if (rel !== null && !blocked.includes(rel)) {
          blocked.push(rel);
          if (unlockPhrase === null) unlockPhrase = readConfig(mainRootOf(start)).ownerUnlockPhrase;
        }
      }
    }
  }
  if (blocked.length > 0 && !ownerUnlocked(payload, unlockPhrase)) {
    const what =
      blocked.length === 1 ? `${blocked[0]} is` : `${blocked.slice(0, 5).join(', ')}${blocked.length > 5 ? ', …' : ''} are`;
    console.error(
      `BLOCKED: ${what} in the root checkout, which is coordination-only.\n` +
        'Every repo edit, docs and agent config included, happens in a leased slot. ' +
        'Lease one first: run the worktree-pool skill\'s `acquire` command (wt acquire <branch> --purpose "<task>"), ' +
        'then edit inside the returned slot path.',
    );
    process.exit(2);
  }

  // Root rules passed: a target inside a pool slot must belong to this session's lease.
  const slotBlock = slotOwnershipBlock(raw, payload, mainRootOf);
  if (slotBlock) {
    console.error(slotBlock);
    process.exit(2);
  }
  process.exit(0);
});
