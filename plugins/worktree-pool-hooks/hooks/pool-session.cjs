/**
 * Session hook for the worktree pool. One script, two events, picked
 * by payload.hook_event_name:
 *   - `Stop`: the turn ended. Touch the heartbeat of every pool lease this
 *     session owns (`<poolRoot>/.pool/heartbeats/<lease.token>`), so pool
 *     commands see the owner was active now.
 *   - `SessionEnd`: the session closed. If this session owns at least one lease,
 *     write `<poolRoot>/.pool/ended/<session_id>.json`
 *     ({ owner, endedAt, reason }), so pool commands can tell a closed session
 *     from an idle one. Nothing is written for a session without a lease.
 *
 * Which leases are "this session's": lease.owner equals payload.session_id, the
 * id in payload.transcript_path (Claude `<id>.jsonl`, Codex
 * `rollout-<ts>-<id>.jsonl`) or env WT_OWNER / CODEX_THREAD_ID /
 * CLAUDE_CODE_SESSION_ID, compared case-insensitively. The same rule as the
 * worktree-guard slot check.
 *
 * The pool is found like the guard finds it: walk up from process.cwd() to the
 * main checkout, then read
 * `worktree-pool.config.json` there. No config, no pool, no leases: nothing to do.
 *
 * ALWAYS exits 0, whatever the input or any error: a non-zero Stop hook would
 * stop Claude from finishing a turn, and SessionEnd has a ~1.5 s budget. Only
 * node builtins, no network, no git.
 */
const path = require('path');
const fs = require('fs');

const POOL_CONFIG_FILE = 'worktree-pool.config.json';
const TRAILING_UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const SAFE_NAME = /^[\w.-]+$/;

/** `<main>/.git` for a linked worktree whose `.git` file is `dotGitFile`, or null. */
function commonGitDir(worktreeDir, dotGitFile) {
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGitFile, 'utf8'));
  if (!match) return null;
  const gitdir = path.resolve(worktreeDir, match[1]);
  try {
    return path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim());
  } catch {
    const layout = /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/.exec(gitdir);
    return layout ? path.join(layout[1], '.git') : null;
  }
}

/** The main checkout of the repo that contains `start`, or null. */
function mainCheckoutRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    let stat = null;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      // keep walking up
    }
    if (stat?.isDirectory()) return dir;
    if (stat?.isFile()) {
      const common = commonGitDir(dir, dotGit);
      if (!common || path.basename(common).toLowerCase() !== '.git') return null;
      return path.dirname(common);
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** `{ stateRoot }` of the pool configured in the main checkout above `start`, or null. */
function poolState(start) {
  const mainRoot = mainCheckoutRoot(start);
  if (!mainRoot) return null;
  const config = JSON.parse(fs.readFileSync(path.join(mainRoot, POOL_CONFIG_FILE), 'utf8'));
  if (!config || typeof config.poolDirectory !== 'string' || !config.poolDirectory) return null;
  return { stateRoot: path.join(path.resolve(mainRoot, config.poolDirectory), '.pool') };
}

/** Every id this session may be known by in a lease. */
function sessionIds(payload) {
  const ids = [];
  const add = (v) => {
    if (typeof v === 'string' && v.trim() && !ids.includes(v.trim())) ids.push(v.trim());
  };
  add(payload.session_id);
  if (typeof payload.transcript_path === 'string') {
    const m = TRAILING_UUID.exec(path.basename(payload.transcript_path).replace(/\.jsonl?$/i, ''));
    if (m) add(m[1]);
  }
  add(process.env.WT_OWNER);
  add(process.env.CODEX_THREAD_ID);
  add(process.env.CLAUDE_CODE_SESSION_ID);
  return ids;
}

/** Leases under `stateRoot` whose owner is one of `ids`. Unreadable leases are skipped. */
function ownedLeases(stateRoot, ids) {
  const dir = path.join(stateRoot, 'leases');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const lower = ids.map((id) => id.toLowerCase());
  const out = [];
  for (const name of names) {
    try {
      const lease = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (lease && typeof lease.owner === 'string' && lower.includes(lease.owner.trim().toLowerCase())) out.push(lease);
    } catch {
      // skip a broken lease
    }
  }
  return out;
}

function touchHeartbeat(stateRoot, lease) {
  try {
    const token = lease.token;
    if (typeof token !== 'string' || !SAFE_NAME.test(token)) return;
    const dir = path.join(stateRoot, 'heartbeats');
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
    // advisory only
  }
}

function writeEndedMarker(stateRoot, owner, reason) {
  if (typeof owner !== 'string' || !SAFE_NAME.test(owner)) return;
  const dir = path.join(stateRoot, 'ended');
  fs.mkdirSync(dir, { recursive: true });
  const marker = { owner, endedAt: new Date().toISOString(), reason: typeof reason === 'string' ? reason : 'unknown' };
  fs.writeFileSync(path.join(dir, `${owner}.json`), `${JSON.stringify(marker, null, 2)}\n`);
}

function run(payload) {
  if (!payload || typeof payload !== 'object') return;
  const event = payload.hook_event_name;
  if (event !== 'Stop' && event !== 'SessionEnd') return;
  const pool = poolState(process.cwd());
  if (!pool) return;
  const ids = sessionIds(payload);
  if (ids.length === 0) return;
  const leases = ownedLeases(pool.stateRoot, ids);
  if (leases.length === 0) return;
  if (event === 'Stop') {
    for (const lease of leases) touchHeartbeat(pool.stateRoot, lease);
    return;
  }
  // SessionEnd: one marker per owner id that holds a lease (normally exactly one).
  const owners = [...new Set(leases.map((lease) => lease.owner.trim()))];
  for (const owner of owners) writeEndedMarker(pool.stateRoot, owner, payload.reason);
}

let data = '';
process.stdin.on('data', (chunk) => (data += chunk));
process.stdin.on('end', () => {
  try {
    run(JSON.parse(data));
  } catch {
    // never block or fail the host
  }
  process.exit(0);
});
process.stdin.on('error', () => process.exit(0));
