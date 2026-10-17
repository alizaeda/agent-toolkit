import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { WT, isProcessAlive, normalizedPath, run, sleepSync } from './exec.mjs';
import {
  appendEvent,
  DEFAULT_POLICY,
  formatDuration,
  heartbeatPath,
  leaseActivity,
  ownerLooksLikeSession,
  readHeartbeatMs,
  resolvePolicy,
  touchHeartbeat,
} from './liveness.mjs';
import { landedVia, unpushedCommitCount } from './proof.mjs';
import { salvageSlot } from './salvage.mjs';

export { run, WT, formatDuration, DEFAULT_POLICY };

const CONFIG_FILE = 'worktree-pool.config.json';
const FETCH_TIMEOUT_MS = 45_000;
// A lock whose process is gone and that is older than this is a crash leftover, not a busy lock.
const LOCK_STALE_MS = 30_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export function discoverMainRoot(cwd = process.cwd()) {
  const commonDir = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd }).stdout;
  return dirname(commonDir);
}

export function loadContext(cwd = process.cwd(), overrides = {}) {
  const mainRoot = overrides.mainRoot ? resolve(overrides.mainRoot) : discoverMainRoot(cwd);
  const configPath = join(mainRoot, CONFIG_FILE);
  if (!existsSync(configPath)) throw new Error(`Missing ${configPath}`);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (config.version !== 1 || !Number.isInteger(config.slotCount) || config.slotCount < 1) {
    throw new Error(`Invalid ${CONFIG_FILE}`);
  }
  const poolRoot = overrides.poolRoot
    ? resolve(overrides.poolRoot)
    : isAbsolute(config.poolDirectory)
      ? normalize(config.poolDirectory)
      : resolve(mainRoot, config.poolDirectory);
  const stateRoot = join(poolRoot, '.pool');
  const policy = resolvePolicy({ ...config.policy, ...overrides.policy });
  return { cwd: resolve(cwd), mainRoot, poolRoot, stateRoot, config, policy };
}

export function slotName(context, number) {
  return `${context.config.slotPrefix}${String(number).padStart(2, '0')}`;
}

export function slotPath(context, number) {
  return join(context.poolRoot, slotName(context, number));
}

function leasePath(context, number) {
  return join(context.stateRoot, 'leases', `${slotName(context, number)}.json`);
}

function stampPath(context, number) {
  return join(context.stateRoot, 'stamps', `${slotName(context, number)}.json`);
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // A file caught mid-write, or damaged: report "absent" and let the caller fail closed.
    return null;
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  try {
    renameSync(temp, path);
  } catch {
    writeFileSync(path, readFileSync(temp));
    rmSync(temp, { force: true });
  }
}

function logEvent(context, event) {
  appendEvent(context.stateRoot, { actor: resolveOwner(), ...event });
}

export function shortOwner(owner) {
  return typeof owner === 'string' && owner.length > 12 ? owner.slice(0, 8) : (owner ?? 'unknown');
}

// --- Locks ---------------------------------------------------------------------------------------

function lockWaitMs() {
  const value = Number(process.env.WT_LOCK_WAIT_MS);
  return Number.isFinite(value) && value >= 0 ? value : 90_000;
}

function lockIsStale(lockPath, holder) {
  const acquired = Date.parse(holder?.acquiredAt ?? '');
  let since = Number.isFinite(acquired) ? acquired : null;
  if (since == null) {
    try {
      since = statSync(lockPath).mtimeMs;
    } catch {
      return true;
    }
  }
  if (Date.now() - since < LOCK_STALE_MS) return false;
  // No owner record at all, so the process died between mkdir and writing it.
  if (!holder) return true;
  return !isProcessAlive(holder.pid);
}

function busyError(lockPath, holder) {
  const who = holder ? ` (held by ${shortOwner(holder.owner)}, pid ${holder.pid}, since ${holder.acquiredAt ?? 'unknown'})` : '';
  return new Error(`Worktree pool lock is busy: ${lockPath}${who}`);
}

/**
 * Takes a named lock, waiting for a busy one instead of failing at once. A lock whose process is dead
 * is broken after 30 s. A lock held by this very process is a bug, so it never waits on itself.
 */
export function withNamedLock(context, name, action, options = {}) {
  const lockPath = join(context.stateRoot, 'locks', name);
  mkdirSync(dirname(lockPath), { recursive: true });
  const waitMs = options.waitMs ?? lockWaitMs();
  const startedAt = Date.now();
  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = readJson(join(lockPath, 'owner.json'));
      if (holder?.pid === process.pid) throw busyError(lockPath, holder);
      if (lockIsStale(lockPath, holder)) {
        rmSync(lockPath, { recursive: true, force: true });
        logEvent(context, { type: 'lock-broken', lock: name, holder });
        continue;
      }
      if (Date.now() - startedAt >= waitMs) throw busyError(lockPath, holder);
      sleepSync(120 + Math.floor(Math.random() * 130));
    }
  }
  try {
    writeJson(join(lockPath, 'owner.json'), {
      owner: resolveOwner(),
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    });
    return action();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

export function withPoolLock(context, action) {
  return withNamedLock(context, 'allocation', action);
}

export function recoverInternalLock(context, name, options = {}) {
  if (!['allocation', 'dependency-install'].includes(name)) throw new Error(`Unknown recoverable lock: ${name}`);
  if (!options.force) throw new Error('Stale-lock recovery requires --force after inspecting the owner');
  const path = join(context.stateRoot, 'locks', name);
  const owner = readJson(join(path, 'owner.json'));
  if (!owner) throw new Error(`${name} lock does not exist or has no owner record`);
  if (isProcessAlive(owner.pid)) throw new Error(`${name} lock owner PID ${owner.pid} is still running`);
  rmSync(path, { recursive: true });
  return owner;
}

export function resolveOwner() {
  return (
    process.env.WT_OWNER ||
    process.env.CODEX_THREAD_ID ||
    process.env.CLAUDE_CODE_SESSION_ID ||
    `${process.env.USERNAME ?? 'unknown'}@${process.env.COMPUTERNAME ?? 'unknown'}`
  );
}

// --- Git state of the slots -------------------------------------------------------------------

function worktreeRecords(context) {
  const output = run('git', ['worktree', 'list', '--porcelain'], { cwd: context.mainRoot }).stdout;
  const records = [];
  let current = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice(9), detached: false, branch: null };
      records.push(current);
    } else if (current && line === 'detached') current.detached = true;
    else if (current && line.startsWith('branch refs/heads/')) current.branch = line.slice('branch refs/heads/'.length);
  }
  return records;
}

function recordForSlot(context, number, records = worktreeRecords(context)) {
  const target = normalizedPath(slotPath(context, number));
  return records.find((record) => normalizedPath(record.path) === target) ?? null;
}

function gitStatus(path) {
  return run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: path }).stdout;
}

function gitOperation(path) {
  const gitDir = run('git', ['rev-parse', '--path-format=absolute', '--git-dir'], { cwd: path }).stdout;
  const markers = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply'];
  return markers.find((marker) => existsSync(join(gitDir, marker))) ?? null;
}

export function setupPool(context) {
  return withPoolLock(context, () => {
    mkdirSync(context.poolRoot, { recursive: true });
    run('git', ['fetch', 'origin'], { cwd: context.mainRoot });
    const created = [];
    const records = worktreeRecords(context);
    for (let number = 1; number <= context.config.slotCount; number += 1) {
      const path = slotPath(context, number);
      const record = recordForSlot(context, number, records);
      if (record) continue;
      if (existsSync(path)) throw new Error(`Unregistered path blocks ${slotName(context, number)}: ${path}`);
      run('git', ['worktree', 'add', '--detach', path, context.config.baseRef], { cwd: context.mainRoot });
      created.push(path);
    }
    return created;
  });
}

export function getPoolStatus(context) {
  const rows = [];
  const records = worktreeRecords(context);
  for (let number = 1; number <= context.config.slotCount; number += 1) {
    const path = slotPath(context, number);
    const record = recordForSlot(context, number, records);
    const lease = readJson(leasePath(context, number));
    let state = 'AVAILABLE';
    let detail = '';
    if (!record) {
      state = 'MISSING';
      detail = existsSync(path) ? 'path exists but is not registered' : 'not created';
    } else if (lease) {
      state = record.branch === lease.branch ? 'LEASED' : 'BLOCKED';
      detail = record.branch === lease.branch
        ? `${lease.owner}${lease.purpose ? ` - ${lease.purpose}` : ''}`
        : `lease=${lease.branch}, checkout=${record.branch ?? 'detached'}`;
    } else if (!record.detached) {
      state = 'BLOCKED';
      detail = `unleased branch ${record.branch}`;
    } else if (gitStatus(path)) {
      // Only an unleased slot needs a work-tree scan: a leased one is judged by its lease.
      state = 'BLOCKED';
      detail = 'unleased dirty worktree';
    }
    rows.push({ number, slot: slotName(context, number), path, state, branch: record?.branch ?? null, detail, lease });
  }
  return rows;
}

function validateBranchName(branch) {
  if (!branch || branch === 'main' || branch === 'master') throw new Error('A unique feature branch is required; main/master cannot be leased');
  const result = run('git', ['check-ref-format', '--branch', branch], { allowFailure: true });
  if (result.status !== 0) throw new Error(`Invalid branch name: ${branch}`);
}

// --- Facts and classification ------------------------------------------------------------------

// GitHub's default squash-merge rewrites the branch's commits, so a merged PR's
// branch tip is NOT an ancestor of origin/main. The content proof in proof.mjs covers most of
// those; this asks GitHub for the head commit (headRefOid) of a MERGED PR whose head branch is
// `branch` AND whose base is the pool's base branch, so the caller can confirm it is *exactly* this
// slot's HEAD. gh is OPTIONAL: missing binary, no auth, or offline all resolve to `null`.
function mergedPrHeadSha(mainRoot, branch, baseBranch) {
  if (!branch || !mainRoot) return null;
  const args = ['pr', 'list', '--head', branch, '--state', 'merged', '--json', 'number,headRefOid', '--limit', '1'];
  if (baseBranch) args.push('--base', baseBranch);
  const res = run('gh', args, { cwd: mainRoot, allowFailure: true, timeout: 20_000 });
  if (res.status !== 0) return null;
  try {
    const parsed = JSON.parse(res.stdout || '[]');
    return Array.isArray(parsed) && parsed.length ? parsed[0].headRefOid ?? null : null;
  } catch {
    return null;
  }
}

// One call for every slot of a sweep: branch -> head SHA of its newest merged PR into the base. null = gh unavailable.
function mergedPrHeadMap(mainRoot, baseBranch) {
  const args = ['pr', 'list', '--state', 'merged', '--limit', '300', '--json', 'headRefName,headRefOid'];
  if (baseBranch) args.push('--base', baseBranch);
  const res = run('gh', args, { cwd: mainRoot, allowFailure: true, timeout: 30_000 });
  if (res.status !== 0) return null;
  try {
    const heads = {};
    for (const pr of JSON.parse(res.stdout || '[]')) if (!(pr.headRefName in heads)) heads[pr.headRefName] = pr.headRefOid;
    return heads;
  } catch {
    return null;
  }
}

function slotActivityMs(path, porcelain) {
  let newest = 0;
  const reflog = run('git', ['reflog', '-1', '--format=%ct', 'HEAD'], { cwd: path, allowFailure: true });
  if (reflog.status === 0 && Number(reflog.stdout) > 0) newest = Number(reflog.stdout) * 1000;
  for (const line of porcelain.split(/\r?\n/).filter(Boolean).slice(0, 300)) {
    const file = line.slice(3).replace(/^"|"$/g, '').split(' -> ').pop();
    try {
      newest = Math.max(newest, statSync(join(path, file)).mtimeMs);
    } catch {
      // a deleted file has no mtime
    }
  }
  return newest || null;
}

/**
 * Everything the pool needs to judge one slot, as plain data (it is also computed in worker threads).
 * `row` is a getPoolStatus row; a BLOCKED row may have no lease.
 */
export function collectSlotFacts(context, row, options = {}) {
  const now = options.now ?? Date.now();
  const mergeTarget = options.mergeTarget || context.config.baseRef;
  const path = row.path;
  const lease = row.lease ?? null;
  const porcelain = gitStatus(path);
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: path }).stdout;
  const upstream = run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: path, allowFailure: true });
  let hasUpstream = upstream.status === 0;
  // `origin/main` means the slot never pushed to its own feature upstream and still tracks the base.
  const upstreamIsBase = hasUpstream && upstream.stdout === mergeTarget;
  let unpushed = 0;
  let behind = 0;
  if (hasUpstream) {
    const counts = run('git', ['rev-list', '--left-right', '--count', '@{u}...HEAD'], { cwd: path, allowFailure: true });
    if (counts.status === 0) {
      const [back, ahead] = counts.stdout.split(/\s+/).map(Number);
      behind = back || 0;
      unpushed = ahead || 0;
    } else {
      // A pruned remote-tracking ref makes @{u} unresolvable: treat as no upstream.
      hasUpstream = false;
    }
  }
  const localOnly = unpushedCommitCount(path);
  let via = landedVia(path, mergeTarget);
  let prMerged = false;
  if (!via) {
    const baseBranch = (mergeTarget || '').replace(/^origin\//, '');
    // A sweep passes one prefetched map; a lone slot asks GitHub itself.
    const sha = options.mergedPrHeads !== undefined ? (options.mergedPrHeads?.[row.branch] ?? null) : mergedPrHeadSha(context.mainRoot, row.branch, baseBranch);
    prMerged = sha != null && sha === head;
    if (prMerged) via = 'pr';
  }
  const lockNames = lease ? resourcesOwnedByLease(context, lease) : [];
  const activity = leaseActivity({
    now,
    lease: lease ?? { acquiredAt: null, token: null, owner: null },
    stateRoot: context.stateRoot,
    slotActivityMs: slotActivityMs(path, porcelain),
  });
  return {
    state: row.state,
    branch: row.branch,
    head,
    dirty: porcelain.length > 0,
    dirtyCount: porcelain ? porcelain.split(/\r?\n/).length : 0,
    gitOp: gitOperation(path),
    hasUpstream,
    upstreamIsBase,
    unpushed,
    behind,
    localOnly,
    pushed: localOnly === 0,
    merged: via != null,
    landedVia: via,
    ancestryMerged: via === 'ancestor',
    prMerged,
    // "Untouched" = HEAD still at the lease's acquisition commit; fail closed when baseCommit is absent.
    untouched: lease ? lease.baseCommit == null || head === lease.baseCommit : false,
    holdsLocks: lockNames,
    owner: lease?.owner ?? null,
    pressure: Boolean(options.pressure),
    policy: context.policy,
    idleMs: activity.idleMs,
    ownerEnded: activity.ownerEnded,
    ownerKnown: activity.ownerKnown,
    endReason: activity.endReason,
    now,
  };
}

function policyMinutes(facts, minutes) {
  const policy = { ...DEFAULT_POLICY, ...facts.policy };
  return { policy, ms: (facts.ownerEnded ? Math.min(minutes, policy.endedGraceMinutes) : minutes) * MINUTE };
}

function abandonedAfterMs(facts) {
  const policy = { ...DEFAULT_POLICY, ...facts.policy };
  const hours = facts.ownerEnded ? policy.endedAbandonedHours : facts.ownerKnown ? policy.abandonedIdleHours : policy.unknownOwnerAbandonedHours;
  return hours * HOUR;
}

/**
 * Pure classification of a LEASED slot.
 *
 *   REAPABLE         clean, work already landed on the base (or nothing was ever done), owner quiet.
 *   REAPABLE_PUSHED  clean, every commit on a remote branch (an open PR does not hold a slot), owner quiet.
 *   TAKEOVER         the owner has been gone for a long time; dirty files / local-only commits are saved first.
 *   REVIEW_MERGED_DIRTY / ACTIVE   leave alone; a human or the owner decides.
 *
 * Without `policy` and `idleMs` in the facts (old callers, unit tests of the git rules) there is no
 * liveness gate, which is the pre-liveness behaviour.
 */
export function classifySlot(facts) {
  if (facts.state !== 'LEASED') return 'SKIP';
  const gated = facts.policy != null && typeof facts.idleMs === 'number';
  const idleAtLeast = (minutes) => !gated || facts.idleMs >= policyMinutes(facts, minutes).ms;
  const abandoned = gated && facts.idleMs >= abandonedAfterMs(facts);
  const finishedMinutes = facts.pressure ? (facts.policy?.finishedIdleMinutesFull ?? DEFAULT_POLICY.finishedIdleMinutesFull) : (facts.policy?.finishedIdleMinutes ?? DEFAULT_POLICY.finishedIdleMinutes);
  const landedMinutes = facts.policy?.landedIdleMinutes ?? DEFAULT_POLICY.landedIdleMinutes;
  const clean = !facts.dirty;

  // Held locks and half-finished Git operations belong to a running person or process.
  if (facts.gitOp) return 'ACTIVE';
  if (facts.holdsLocks?.length && !abandoned) return 'ACTIVE';

  // HEAD == the lease's base commit: the owner committed NOTHING. Without a liveness signal this could
  // be a lease taken seconds ago, so it is never reaped. With one, a clean, quiet, untouched lease holds nothing.
  if (facts.untouched) {
    if (!gated) return 'ACTIVE';
    if (clean && idleAtLeast(facts.merged ? landedMinutes : finishedMinutes)) return 'REAPABLE';
    if (!clean && abandoned) return 'TAKEOVER';
    return 'ACTIVE';
  }

  const behind = facts.behind ?? 0;
  // Real un-reaped work is a LIVE FEATURE upstream ahead of HEAD or local commits not yet on it. A slot
  // that never pushed still tracks the BASE, so its unpushed/behind only measure the base advancing.
  const featureDrift = facts.hasUpstream && !facts.upstreamIsBase && (facts.unpushed > 0 || behind > 0);
  if (facts.merged && clean && !featureDrift) return idleAtLeast(landedMinutes) ? 'REAPABLE' : 'ACTIVE';
  if (facts.merged) return !clean && abandoned ? 'TAKEOVER' : 'REVIEW_MERGED_DIRTY';

  // An OPEN PR is NOT a reason to hold a slot: releasing only detaches the worktree. `pushed` (no commit
  // that exists on no remote branch) is the whole test; `behind` is deliberately not a bar.
  const pushed = facts.pushed ?? (facts.hasUpstream && !facts.upstreamIsBase && facts.unpushed === 0);
  if (clean && pushed) return idleAtLeast(finishedMinutes) ? 'REAPABLE_PUSHED' : 'ACTIVE';

  return abandoned ? 'TAKEOVER' : 'ACTIVE';
}

/** Verdict for a BLOCKED row (no live lease/checkout pair). */
export function classifyBlockedSlot(facts, kind) {
  const gated = facts.policy != null && typeof facts.idleMs === 'number';
  if (!gated || facts.gitOp) return kind === 'drift' ? 'REVIEW_DRIFT' : 'REVIEW_UNLEASED';
  const policy = { ...DEFAULT_POLICY, ...facts.policy };
  const quiet = facts.idleMs >= policyMinutes(facts, policy.blockedIdleMinutes).ms;
  if (!facts.dirty && facts.pushed && quiet) return 'REAPABLE_BLOCKED';
  if (kind === 'unleased-dirty' && facts.idleMs >= abandonedAfterMs(facts)) return 'TAKEOVER';
  return kind === 'drift' ? 'REVIEW_DRIFT' : 'REVIEW_UNLEASED';
}

function blockedKind(row) {
  if (row.lease?.branch && row.branch && row.lease.branch !== row.branch) return 'drift';
  if (!row.lease && row.branch) return 'unleased';
  if (!row.lease) return 'unleased-dirty';
  return null;
}

/** One-line reason a human or agent can act on. */
export function explainClassification(classification, facts) {
  const idle = formatDuration(facts.idleMs);
  const policy = { ...DEFAULT_POLICY, ...facts.policy };
  switch (classification) {
    case 'REAPABLE':
      return 'clean and its work is on the base (or nothing was done); the owner is quiet';
    case 'REAPABLE_PUSHED':
      return 'clean and every commit is on a remote branch; the owner is quiet';
    case 'REAPABLE_BLOCKED':
      return 'stuck but clean and pushed; safe to repair';
    case 'TAKEOVER':
      return `the owner has been gone ${idle}; takeover saves uncommitted files and local commits first`;
    case 'REVIEW_MERGED_DIRTY':
      return `work landed but the slot has local changes; the owner was active ${idle} ago`;
    case 'REVIEW_DRIFT':
    case 'REVIEW_UNLEASED':
      return 'blocked and not provably safe to repair (dirty, local-only commits, or the owner is still active)';
    case 'ACTIVE':
    default:
      if (facts.gitOp) return `a Git operation is in progress (${facts.gitOp})`;
      if (facts.holdsLocks?.length) return `it holds shared lock(s): ${facts.holdsLocks.join(', ')}`;
      if (facts.dirty || (facts.localOnly ?? 0) > 0) {
        return `it has ${facts.dirty ? 'uncommitted files' : 'local-only commits'} and the owner was active ${idle} ago (takeover needs ${policy.abandonedIdleHours}h)`;
      }
      return `the owner was active ${idle} ago`;
  }
}

function evaluateRow(context, row, options = {}) {
  const facts = collectSlotFacts(context, row, options);
  const kind = blockedKind(row);
  const classification = row.state === 'BLOCKED' && kind ? classifyBlockedSlot(facts, kind) : classifySlot(facts);
  return { facts, classification };
}

const FREE_CLASSES = new Set(['REAPABLE', 'REAPABLE_PUSHED', 'REAPABLE_BLOCKED']);

// --- Parallel fact collection ------------------------------------------------------------------

async function collectFactsParallel(context, rows, options) {
  const out = new Map();
  const sequential = (list) => {
    for (const row of list) out.set(row.number, collectSlotFacts(context, row, options));
  };
  const workerCount = Math.min(5, rows.length);
  if (rows.length <= 2 || process.env.WT_NO_WORKERS) {
    sequential(rows);
    return out;
  }
  const buckets = Array.from({ length: workerCount }, () => []);
  rows.forEach((row, index) => buckets[index % workerCount].push(row));
  const failed = [];
  await Promise.all(
    buckets.map(
      (bucket) =>
        new Promise((done) => {
          const worker = new Worker(new URL('./facts-worker.mjs', import.meta.url), { workerData: { context, rows: bucket, options } });
          let settled = false;
          const finish = (results) => {
            if (settled) return;
            settled = true;
            for (const result of results ?? []) {
              if (result.facts) out.set(result.number, result.facts);
            }
            for (const row of bucket) if (!out.has(row.number)) failed.push(row);
            done();
          };
          worker.once('message', finish);
          worker.once('error', () => finish([]));
          worker.once('exit', () => finish([]));
        }),
    ),
  );
  if (failed.length) sequential(failed);
  return out;
}

// --- Acquire -----------------------------------------------------------------------------------

function firstLine(text) {
  return (text ?? '').split(/\r?\n/).find(Boolean) ?? '';
}

function leasesOwnedBy(context, owner) {
  return getPoolStatus(context).filter((row) => row.lease && row.lease.owner === owner);
}

/** Free slot to prefer: one whose install stamp matches the current lockfile, so `prepare` can skip the install. */
function warmSlotOrder(context, candidates) {
  if (candidates.length < 2) return candidates;
  const lockfile = prepareSettings(context, context.mainRoot).lockfile;
  if (!lockfile) return candidates;
  const base = run('git', ['rev-parse', `${context.config.baseRef}:${lockfile}`], { cwd: context.mainRoot, allowFailure: true });
  if (base.status !== 0 || !base.stdout) return candidates;
  const warm = (row) => {
    const stamp = readJson(stampPath(context, row.number));
    return stamp?.lockfileBlob === base.stdout && stamp.node === process.version ? 0 : 1;
  };
  return candidates.slice().sort((a, b) => warm(a) - warm(b) || a.number - b.number);
}

/**
 * Leases a slot. Async only because a full pool first frees what it provably may (see reapPool).
 * Returns the lease; `reused` is true when the caller already held this branch, `adopted` when a slot
 * left by an ended or idle owner was taken over in place.
 */
export async function acquireSlot(context, branch, options = {}) {
  validateBranchName(branch);
  if (!options.purpose?.trim()) throw new Error('A short --purpose is required for slot ownership');
  const actor = options.owner ?? resolveOwner();
  const warn = typeof options.onWarn === 'function' ? options.onWarn : () => {};

  // Refresh origin BEFORE taking the lock, and survive a bad network: a stale base only means the
  // branch starts a few commits behind, which the PR gate reports anyway.
  let fetched = false;
  if (options.fetch !== false) {
    const result = run('git', ['fetch', 'origin', '--prune', '--quiet'], { cwd: context.mainRoot, allowFailure: true, timeout: FETCH_TIMEOUT_MS });
    fetched = result.status === 0;
    if (!fetched) warn(`git fetch failed (${firstLine(result.stderr) || 'timeout'}); using the last known ${context.config.baseRef}`);
  }

  // Self-heal: when the pool is full, free what is provably done BEFORE taking the lock (reapPool ->
  // releaseSlot takes it, and the lock is not re-entrant). Best-effort: a failed reap falls through to
  // the normal "No available worktree slots" error.
  if (!options.slot && options.autoReap !== false) {
    try {
      const isFull = () => !getPoolStatus(context).some((row) => row.state === 'AVAILABLE');
      if (isFull()) {
        const result = await reapPool(context, {
          apply: true,
          fetched,
          pressure: true,
          now: options.now,
          stopWhenFree: true,
          takeover: options.autoTakeover !== false,
        });
        const reaped = result.results.filter((r) => r.reaped);
        if (reaped.length && typeof options.onAutoReap === 'function') options.onAutoReap(reaped);
      }
    } catch {
      // fall through to the guarded selection below
    }
  }

  return withPoolLock(context, () => {
    let rows = getPoolStatus(context);

    // Idempotent: asking again for a branch this caller already holds returns that lease.
    const mine = rows.find((row) => row.state === 'LEASED' && row.lease?.branch === branch && row.lease.owner === actor);
    if (mine && !options.slot) {
      touchHeartbeat(context.stateRoot, mine.lease.token);
      return { ...mine.lease, reused: true };
    }

    const checkedOut = worktreeRecords(context).find((record) => record.branch === branch);
    if (checkedOut) {
      const holder = rows.find((row) => normalizedPath(row.path) === normalizedPath(checkedOut.path));
      if (!holder) throw new Error(`Branch ${branch} is already checked out at ${checkedOut.path}`);
      if (holder.lease && holder.state === 'LEASED') {
        const taken = takeoverLocked(context, { number: holder.number, actor, adopt: true, purpose: options.purpose, now: options.now ?? Date.now() });
        if (taken.action === 'adopted') return { ...taken.lease, adopted: true };
        throw new Error(
          `Branch ${branch} is already checked out at ${checkedOut.path} (${holder.slot}, leased to ${shortOwner(holder.lease.owner)}): ${taken.reason}. ` +
            'Use another branch name, or ask the owner.',
        );
      }
      // A BLOCKED slot with the branch attached but no live lease: repair it when that is provably safe.
      const healed = holder.state === 'BLOCKED' ? healBlockedLocked(context, holder, { now: options.now ?? Date.now() }) : null;
      if (!healed?.healed) {
        throw new Error(`Branch ${branch} is already checked out at ${checkedOut.path} (${holder.slot} is ${holder.state}: ${holder.detail}); ${healed?.reason ?? 'repair it first'}`);
      }
      rows = getPoolStatus(context);
    }

    const free = options.slot
      ? rows.filter((row) => row.number === Number(options.slot))
      : warmSlotOrder(context, rows.filter((row) => row.state === 'AVAILABLE'));
    const selected = free[0];
    if (!selected) throw new Error(options.slot ? `Unknown slot ${options.slot}` : 'No available worktree slots');
    if (selected.state !== 'AVAILABLE') throw new Error(`${selected.slot} is ${selected.state}: ${selected.detail}`);

    const path = selected.path;
    const local = run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: context.mainRoot, allowFailure: true }).status === 0;
    const remote = run('git', ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { cwd: context.mainRoot, allowFailure: true }).status === 0;
    if (local) {
      run('git', ['switch', branch], { cwd: path });
      if (remote) {
        // `git switch <branch>` takes the LOCAL branch, which can be stale. Fast-forward it; never rewrite it.
        const ff = run('git', ['merge', '--ff-only', `origin/${branch}`], { cwd: path, allowFailure: true });
        if (ff.status !== 0) warn(`local ${branch} has diverged from origin/${branch}; it was left as is. Reconcile before you push.`);
      }
    } else if (remote) run('git', ['switch', '--track', '-c', branch, `origin/${branch}`], { cwd: path });
    else run('git', ['switch', '-c', branch, context.config.baseRef], { cwd: path });

    const lease = {
      version: 1,
      token: randomUUID(),
      slot: selected.slot,
      path,
      branch,
      owner: actor,
      purpose: options.purpose ?? '',
      acquiredAt: new Date().toISOString(),
      baseRef: context.config.baseRef,
      baseCommit: run('git', ['rev-parse', 'HEAD'], { cwd: path }).stdout,
    };
    writeJson(leasePath(context, selected.number), lease);
    touchHeartbeat(context.stateRoot, lease.token);
    logEvent(context, { type: 'acquire', slot: selected.slot, branch, owner: actor });
    return lease;
  });
}

function resolveSlotNumber(context, cwd, explicitSlot) {
  if (explicitSlot) return Number(explicitSlot);
  const current = normalizedPath(cwd);
  for (let number = 1; number <= context.config.slotCount; number += 1) {
    const root = normalizedPath(slotPath(context, number));
    if (current === root || current.startsWith(`${root}\\`) || current.startsWith(`${root}/`)) return number;
  }
  throw new Error('Run this command inside a leased slot or pass --slot');
}

/** Slot number for `cwd`, or null when it is not inside a pool slot. */
export function slotNumberForPath(context, cwd) {
  try {
    return resolveSlotNumber(context, cwd);
  } catch {
    return null;
  }
}

// --- Shared locks held by a lease --------------------------------------------------------------

export const RUNTIME_LANE_CAP = Number(process.env.WT_LANE_CAP || 2);

function laneLockPath(context, n) {
  return join(context.stateRoot, 'locks', `runtime-lane-${n}`);
}

/** Every runtime lane that exists on disk, whatever WT_LANE_CAP the current process has. */
export function existingLaneNumbers(context) {
  try {
    return readdirSync(join(context.stateRoot, 'locks'))
      .map((name) => /^runtime-lane-(\d+)$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

function resourcesOwnedByLease(context, lease) {
  const named = ['runtime', 'database'].filter((resource) => {
    const owner = readJson(join(context.stateRoot, 'locks', `resource-${resource}`, 'owner.json'));
    return owner?.token === lease.token;
  });
  const lanes = [];
  for (const n of existingLaneNumbers(context)) {
    const owner = readJson(join(laneLockPath(context, n), 'owner.json'));
    if (owner?.token === lease.token) lanes.push(`runtime-lane-${n}`);
  }
  return [...named, ...lanes];
}

function clearResourcesOfLease(context, lease) {
  const cleared = [];
  for (const resource of ['runtime', 'database']) {
    const path = join(context.stateRoot, 'locks', `resource-${resource}`);
    if (readJson(join(path, 'owner.json'))?.token === lease.token) {
      rmSync(path, { recursive: true, force: true });
      cleared.push(`resource-${resource}`);
    }
  }
  for (const n of existingLaneNumbers(context)) {
    if (readJson(join(laneLockPath(context, n), 'owner.json'))?.token === lease.token) {
      rmSync(laneLockPath(context, n), { recursive: true, force: true });
      cleared.push(`runtime-lane-${n}`);
    }
  }
  return cleared;
}

// --- Release -----------------------------------------------------------------------------------

function ownershipRefusal(context, lease, number, classification, facts) {
  const slot = slotName(context, number);
  return new Error(
    `${slot} is leased to ${shortOwner(lease.owner)} (branch ${lease.branch}), not to this session, so it was not released: ${explainClassification(classification, facts)}. ` +
      `Your own slot after /clear or resume: ${WT} adopt --slot ${number}. ` +
      `Abandoned (owner gone): ${WT} takeover --slot ${number}. Otherwise leave it alone or ask the owner.`,
  );
}

function releaseLocked(context, options = {}) {
  const number = resolveSlotNumber(context, options.cwd ?? context.cwd, options.slot);
  const path = slotPath(context, number);
  const lease = readJson(leasePath(context, number));
  if (!lease) throw new Error(`${slotName(context, number)} has no lease`);
  // TOCTOU guard: a reaper classifies a slot, then releases it by number. If another process released
  // and re-acquired that slot in between, the token no longer matches: refuse rather than detach a
  // different owner's freshly acquired branch.
  if (options.expectedToken && lease.token !== options.expectedToken) {
    throw new Error(`${slotName(context, number)} was re-leased since classification; refusing stale reap`);
  }
  if (options.expectBranch && lease.branch !== options.expectBranch) {
    throw new Error(
      `${slotName(context, number)} is leased to ${lease.branch} (owner ${shortOwner(lease.owner)}), not ${options.expectBranch}. ` +
        'It was re-leased since you last looked, so nothing was released.',
    );
  }
  const record = recordForSlot(context, number);
  if (!record) throw new Error(`${slotName(context, number)} has no registered worktree`);
  if (record.branch !== lease.branch) {
    // Branch drift: someone switched branches INSIDE a leased slot, which parks the slot in BLOCKED
    // forever. Adopting the branch that is actually checked out is safe because every guard below
    // (git operation, dirty, shared locks, unpushed) then runs against THAT branch. Opt-in only.
    if (!options.reconcileBranch) {
      throw new Error(
        `Lease/checkout mismatch for ${slotName(context, number)} (lease=${lease.branch}, checkout=${record.branch ?? 'detached'}); ` +
        're-run with --reconcile-branch to release the branch that is actually checked out',
      );
    }
    if (!record.branch) throw new Error(`Cannot reconcile ${slotName(context, number)}: the worktree is detached`);
    lease.branch = record.branch;
  }

  // Ownership: a lease is released by its owner, by the reaper (token-checked), by an explicit owner
  // approval, or by anyone when the tier rules prove the slot is finished or its owner is gone.
  const actor = options.actor ?? resolveOwner();
  const internal = Boolean(options.expectedToken);
  const mine = lease.owner === actor;
  let via = null;
  if (!mine && !internal && !options.ownerApproved) {
    const row = { number, slot: slotName(context, number), path, state: 'LEASED', branch: record.branch, lease };
    const { facts, classification } = evaluateRow(context, row, { now: options.now, pressure: false });
    if (!FREE_CLASSES.has(classification)) throw ownershipRefusal(context, lease, number, classification, facts);
    via = classification;
  }

  const operation = gitOperation(path);
  if (operation) throw new Error(`Cannot release during Git operation: ${operation}`);
  const dirty = gitStatus(path);
  if (dirty) throw new Error(`Cannot release dirty worktree:\n${dirty}`);
  const resources = resourcesOwnedByLease(context, lease);
  if (resources.length) throw new Error(`Cannot release while holding shared lock(s): ${resources.join(', ')}`);

  let proof = null;
  if (!options.allowUnpushed) {
    const localOnly = unpushedCommitCount(path);
    if (localOnly == null || localOnly > 0) {
      // Commits that exist on no remote branch. Releasing keeps the branch ref, so the real question is
      // whether the work already reached the base. The reaper path additionally accepts a gh-verified
      // merged PR head; a manual `--merged-head` is never accepted without the reaper's token.
      const head = run('git', ['rev-parse', 'HEAD'], { cwd: path }).stdout;
      proof = landedVia(path, context.config.baseRef);
      if (!proof && internal && options.mergedHead === head) proof = 'pr';
      if (!proof) {
        throw new Error(
          `Cannot release with unpushed commits; push first or use --allow-unpushed after explicit approval ` +
            `(${localOnly ?? 'unknown'} commit(s) exist on no remote branch and are not on ${context.config.baseRef}; git push -u origin HEAD saves them)`,
        );
      }
    }
  }

  run('git', ['switch', '--detach', context.config.baseRef], { cwd: path });
  rmSync(leasePath(context, number));
  rmSync(heartbeatPath(context.stateRoot, lease.token), { force: true });
  logEvent(context, {
    type: 'release',
    slot: slotName(context, number),
    branch: lease.branch,
    owner: lease.owner,
    foreign: !mine,
    tier: via,
    landedVia: proof,
    allowUnpushed: Boolean(options.allowUnpushed),
  });
  return { slot: slotName(context, number), path, branch: lease.branch, landedVia: proof, foreign: !mine, tier: via };
}

export function releaseSlot(context, options = {}) {
  return withPoolLock(context, () => releaseLocked(context, options));
}

// --- Takeover, adopt, heal ---------------------------------------------------------------------

/**
 * Re-lease a slot to `actor` in place (adopt) or save its state and free it (takeover).
 * Must run inside the pool lock. Returns { action, ... } and never throws for "not allowed": it returns
 * { action: 'refused', reason } so callers can print the reason.
 */
function takeoverLocked(context, options) {
  const { number, actor = resolveOwner(), adopt = false, ownerApproved = false, dryRun = false, now = Date.now() } = options;
  const slot = slotName(context, number);
  const row = getPoolStatus(context).find((candidate) => candidate.number === number);
  if (!row) throw new Error(`Unknown slot ${number}`);
  const lease = row.lease;
  // A stuck slot (unleased branch, lease/checkout drift) is repaired, not taken over.
  if (row.state === 'BLOCKED') {
    const healed = healBlockedLocked(context, row, { now, dryRun });
    return healed.healed ? { action: 'healed', slot, reason: healed.reason } : { action: 'refused', slot, reason: healed.reason };
  }
  if (!lease) throw new Error(`${slot} has no lease`);
  if (lease.owner === actor) return { action: 'none', slot, lease, reason: 'the lease is already yours' };
  if (row.state !== 'LEASED') return { action: 'refused', slot, reason: `${slot} is ${row.state} (${row.detail})` };

  const { facts, classification } = evaluateRow(context, row, { now, pressure: false });
  const ended = facts.ownerEnded && typeof facts.idleMs === 'number' && facts.idleMs >= (context.policy.endedGraceMinutes ?? 2) * MINUTE;
  const allowed = ownerApproved || FREE_CLASSES.has(classification) || classification === 'TAKEOVER' || (adopt && ended);
  const verdict = { slot, branch: lease.branch, owner: lease.owner, classification, idleMs: facts.idleMs, ownerEnded: facts.ownerEnded };
  if (!allowed) return { action: 'refused', reason: explainClassification(classification, facts), ...verdict };
  if (dryRun) return { action: 'dry-run', reason: explainClassification(classification, facts), ...verdict };

  if (adopt) {
    const stale = classification === 'TAKEOVER' || ended || ownerApproved;
    const cleared = stale ? clearResourcesOfLease(context, lease) : [];
    const next = {
      ...lease,
      token: randomUUID(),
      owner: actor,
      purpose: options.purpose?.trim() || lease.purpose,
      acquiredAt: new Date(now).toISOString(),
      previousOwners: [...(lease.previousOwners ?? []), { owner: lease.owner, token: lease.token, branch: lease.branch, takenAt: new Date(now).toISOString(), reason: 'adopt', tier: classification }],
    };
    writeJson(leasePath(context, number), next);
    rmSync(heartbeatPath(context.stateRoot, lease.token), { force: true });
    touchHeartbeat(context.stateRoot, next.token);
    logEvent(context, { type: 'adopt', slot, branch: lease.branch, from: lease.owner, to: actor, tier: classification, clearedLocks: cleared });
    return { action: 'adopted', lease: next, reason: explainClassification(classification, facts), ...verdict };
  }

  // Free the slot.
  if (FREE_CLASSES.has(classification)) {
    const released = releaseLocked(context, { slot: number, expectedToken: lease.token, actor, now });
    return { action: 'released', released, reason: explainClassification(classification, facts), ...verdict };
  }
  if (facts.gitOp) {
    return { action: 'refused', reason: `a Git operation is in progress (${facts.gitOp}); finish or abort it first`, ...verdict };
  }
  const cleared = clearResourcesOfLease(context, lease);
  const salvage = salvageSlot({ stateRoot: context.stateRoot, slot, path: row.path, lease, reason: ownerApproved && classification !== 'TAKEOVER' ? 'owner-approved takeover' : 'takeover' });
  run('git', ['switch', '--detach', context.config.baseRef], { cwd: row.path });
  rmSync(leasePath(context, number));
  rmSync(heartbeatPath(context.stateRoot, lease.token), { force: true });
  logEvent(context, {
    type: 'takeover',
    slot,
    branch: lease.branch,
    from: lease.owner,
    tier: classification,
    salvage: salvage?.ref ?? null,
    localOnlyCommits: facts.localOnly,
    clearedLocks: cleared,
  });
  return { action: 'taken-over', salvage, localOnly: facts.localOnly, reason: explainClassification(classification, facts), ...verdict };
}

export function takeoverSlot(context, options) {
  return withPoolLock(context, () => takeoverLocked(context, { ...options, number: Number(options.slot) }));
}

/** Repairs a BLOCKED slot (unleased branch, lease/checkout drift) when it is clean, pushed and quiet. */
function healBlockedLocked(context, row, options = {}) {
  const kind = blockedKind(row);
  if (!kind) return { healed: false, reason: `${row.slot} is not BLOCKED` };
  const { facts, classification } = evaluateRow(context, row, { now: options.now ?? Date.now(), pressure: false });
  if (classification === 'TAKEOVER' && kind === 'unleased-dirty') {
    if (options.dryRun) return { healed: false, reason: 'abandoned unleased work; takeover would save it first' };
    const salvage = salvageSlot({ stateRoot: context.stateRoot, slot: row.slot, path: row.path, lease: null, reason: 'unleased dirty slot' });
    run('git', ['switch', '--detach', context.config.baseRef], { cwd: row.path });
    logEvent(context, { type: 'heal', slot: row.slot, kind, salvage: salvage?.ref ?? null });
    return { healed: true, reason: `saved ${salvage?.ref} and freed the slot`, salvage };
  }
  if (classification !== 'REAPABLE_BLOCKED') return { healed: false, reason: explainClassification(classification, facts) };
  if (options.dryRun) return { healed: false, reason: 'would repair (clean and pushed)' };
  if (kind === 'drift') {
    releaseLocked(context, { slot: row.number, reconcileBranch: true, expectedToken: row.lease.token, actor: row.lease.owner, now: options.now });
  } else {
    run('git', ['switch', '--detach', context.config.baseRef], { cwd: row.path });
  }
  logEvent(context, { type: 'heal', slot: row.slot, kind, branch: row.branch });
  return { healed: true, reason: 'was clean and pushed; detached from its branch' };
}

/** Re-lease the caller's own slot to another branch without leaving the slot (replaces `git checkout` drift). */
export function switchSlot(context, branch, options = {}) {
  validateBranchName(branch);
  if (!options.purpose?.trim()) throw new Error('A short --purpose is required for slot ownership');
  return withPoolLock(context, () => {
    const number = resolveSlotNumber(context, options.cwd ?? context.cwd, options.slot);
    const slot = slotName(context, number);
    const path = slotPath(context, number);
    const lease = readJson(leasePath(context, number));
    if (!lease) throw new Error(`${slot} has no lease`);
    const actor = options.actor ?? resolveOwner();
    if (lease.owner !== actor) throw new Error(`${slot} is leased to ${shortOwner(lease.owner)}; only its owner can switch it (${WT} adopt --slot ${number} first)`);
    const record = recordForSlot(context, number);
    if (record?.branch !== lease.branch) throw new Error(`Lease/checkout mismatch for ${slot}; release it with --reconcile-branch first`);
    const checkedOut = worktreeRecords(context).find((candidate) => candidate.branch === branch);
    if (checkedOut) throw new Error(`Branch ${branch} is already checked out at ${checkedOut.path}`);
    const operation = gitOperation(path);
    if (operation) throw new Error(`Cannot switch during Git operation: ${operation}`);
    const dirty = gitStatus(path);
    if (dirty) throw new Error(`Cannot switch a dirty worktree:\n${dirty}`);
    const resources = resourcesOwnedByLease(context, lease);
    if (resources.length) throw new Error(`Cannot switch while holding shared lock(s): ${resources.join(', ')}`);
    if (!options.allowUnpushed) {
      const localOnly = unpushedCommitCount(path);
      if ((localOnly == null || localOnly > 0) && !landedVia(path, context.config.baseRef)) {
        throw new Error(`Cannot switch: ${lease.branch} has ${localOnly ?? 'unknown'} commit(s) that exist on no remote branch; push first (git push -u origin HEAD)`);
      }
    }
    run('git', ['fetch', 'origin', '--prune', '--quiet'], { cwd: context.mainRoot, allowFailure: true, timeout: FETCH_TIMEOUT_MS });
    const local = run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: context.mainRoot, allowFailure: true }).status === 0;
    const remote = run('git', ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { cwd: context.mainRoot, allowFailure: true }).status === 0;
    if (local) {
      run('git', ['switch', branch], { cwd: path });
      if (remote) run('git', ['merge', '--ff-only', `origin/${branch}`], { cwd: path, allowFailure: true });
    } else if (remote) run('git', ['switch', '--track', '-c', branch, `origin/${branch}`], { cwd: path });
    else run('git', ['switch', '-c', branch, context.config.baseRef], { cwd: path });
    const next = {
      ...lease,
      token: randomUUID(),
      branch,
      purpose: options.purpose,
      acquiredAt: new Date().toISOString(),
      baseCommit: run('git', ['rev-parse', 'HEAD'], { cwd: path }).stdout,
      switchedFrom: lease.branch,
    };
    writeJson(leasePath(context, number), next);
    rmSync(heartbeatPath(context.stateRoot, lease.token), { force: true });
    touchHeartbeat(context.stateRoot, next.token);
    logEvent(context, { type: 'switch', slot, from: lease.branch, to: branch });
    return next;
  });
}

/** Does this caller still own the slot at `cwd`? Touches the heartbeat when it does. Never throws. */
export function assertSlot(context, options = {}) {
  try {
    const number = resolveSlotNumber(context, options.cwd ?? context.cwd, options.slot);
    const slot = slotName(context, number);
    const lease = readJson(leasePath(context, number));
    if (!lease) return { ok: false, reason: `${slot} is not leased. Lease one: ${WT} acquire <branch> --purpose "<task>"` };
    const actor = options.actor ?? resolveOwner();
    if (lease.owner !== actor) {
      return { ok: false, reason: `${slot} is leased to ${shortOwner(lease.owner)} (branch ${lease.branch}), not to this session. After /clear or resume: ${WT} adopt --slot ${number}. Otherwise lease your own slot.` };
    }
    const head = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: slotPath(context, number), allowFailure: true }).stdout;
    if (head !== lease.branch) return { ok: false, reason: `${slot} has ${head || 'a detached HEAD'} checked out but is leased for ${lease.branch}. Use ${WT} switch, never git checkout, to change branch.` };
    if (options.expectBranch && options.expectBranch !== lease.branch) return { ok: false, reason: `${slot} is leased for ${lease.branch}, not ${options.expectBranch}` };
    touchHeartbeat(context.stateRoot, lease.token);
    return { ok: true, slot, branch: lease.branch, lease };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

/** Heartbeat for the slot that contains `cwd`, if it is leased to the caller. Never throws. */
export function touchOwnHeartbeat(cwd = process.cwd()) {
  try {
    const context = loadContext(cwd);
    const number = slotNumberForPath(context, cwd);
    if (number == null) return false;
    const lease = readJson(leasePath(context, number));
    if (!lease || lease.owner !== resolveOwner()) return false;
    return touchHeartbeat(context.stateRoot, lease.token);
  } catch {
    return false;
  }
}

// --- Dependencies ------------------------------------------------------------------------------
// Preparation is config-driven (`prepare` in worktree-pool.config.json) so the pool works with any
// package manager. A slot is "prepared" when its stamp matches the hash of the tracked dependency
// inputs plus the Node runtime, and every `outputs` path exists.

const LOCKFILES = [
  ['pnpm-lock.yaml', ['pnpm', 'install', '--frozen-lockfile']],
  ['package-lock.json', ['npm', 'ci']],
  ['yarn.lock', ['yarn', 'install', '--frozen-lockfile']],
  ['bun.lock', ['bun', 'install', '--frozen-lockfile']],
  ['bun.lockb', ['bun', 'install', '--frozen-lockfile']],
];
const DEFAULT_INPUTS = ['package.json', '*/package.json', ...LOCKFILES.map(([name]) => name), 'pnpm-workspace.yaml', '.npmrc', 'patches/'];

/** `{ command, inputs, outputs, lockfile }` for the repo at `path`. `command: null` means nothing to install. */
export function prepareSettings(context, path) {
  const cfg = context.config.prepare ?? {};
  const found = LOCKFILES.find(([name]) => existsSync(join(path, name)));
  return {
    command: cfg.command === undefined ? (found ? found[1] : null) : cfg.command,
    inputs: cfg.inputs ?? DEFAULT_INPUTS,
    outputs: cfg.outputs ?? ['node_modules'],
    lockfile: cfg.lockfile === undefined ? (found ? found[0] : null) : cfg.lockfile,
  };
}

function matchesInput(file, patterns) {
  return patterns.some((p) => {
    if (p.endsWith('/')) return file.startsWith(p);
    if (p.startsWith('*/')) return file === p.slice(2) || file.endsWith(p.slice(1));
    return file === p;
  });
}

export function computeDependencyHash(context, number) {
  const path = slotPath(context, number);
  const { inputs } = prepareSettings(context, path);
  const files = run('git', ['ls-files'], { cwd: path }).stdout.split(/\r?\n/).filter(Boolean).filter((file) => matchesInput(file, inputs));
  const hash = createHash('sha256');
  hash.update(`${process.version}\0${process.platform}\0${process.arch}\0`);
  for (const file of files.sort()) {
    hash.update(`${file}\0`);
    hash.update(readFileSync(join(path, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function outputsPresent(path, outputs) {
  return outputs.every((output) => existsSync(join(path, output)));
}

export function prepareSlot(context, options = {}) {
  const number = resolveSlotNumber(context, options.cwd ?? context.cwd, options.slot);
  const lease = readJson(leasePath(context, number));
  if (!lease) throw new Error(`${slotName(context, number)} must be leased before preparation`);
  const path = slotPath(context, number);
  const settings = prepareSettings(context, path);
  if (!settings.command) return { installed: false, reason: 'no install command configured or detected' };
  const dependencyHash = computeDependencyHash(context, number);
  if (!options.force && inspectPreparedSlotDependencies(path, { context }).valid) {
    return { installed: false, reason: 'dependency inputs unchanged', dependencyHash };
  }
  // CI mode keeps installs independent from slot-local secrets and prompts.
  const installEnv = { ...process.env, CI: 'true' };
  // Installs are serialized across slots and can take minutes; wait for the one in front of us.
  return withNamedLock(context, 'dependency-install', () => {
    if (!options.force && inspectPreparedSlotDependencies(path, { context }).valid) {
      return { installed: false, reason: 'dependency inputs unchanged', dependencyHash };
    }
    const [command, ...args] = settings.command;
    run(command, args, { cwd: path, env: installEnv, shell: process.platform === 'win32' });
    const lockfileBlob = settings.lockfile
      ? run('git', ['hash-object', settings.lockfile], { cwd: path, allowFailure: true }).stdout || null
      : null;
    writeJson(stampPath(context, number), {
      dependencyHash, node: process.version, platform: process.platform, arch: process.arch,
      lockfileBlob, preparedAt: new Date().toISOString(),
    });
    return { installed: true, reason: 'install command succeeded', dependencyHash };
  }, { waitMs: Number(process.env.WT_INSTALL_WAIT_MS) || 15 * MINUTE });
}

// Read-only proof that a slot's install still matches its inputs.
export function inspectPreparedSlotDependencies(cwd, options = {}) {
  try {
    const context = options.context ?? loadContext(cwd);
    const number = resolveSlotNumber(context, cwd);
    const path = slotPath(context, number);
    if (normalizedPath(cwd) !== normalizedPath(path)) return { valid: false, reason: 'not a pool slot root' };
    const lease = readJson(leasePath(context, number));
    if (!lease || normalizedPath(lease.path ?? '') !== normalizedPath(path)) {
      return { valid: false, reason: 'no matching slot lease' };
    }
    const stamp = readJson(stampPath(context, number));
    if (!stamp || stamp.node !== process.version || stamp.platform !== process.platform || stamp.arch !== process.arch) {
      return { valid: false, reason: 'missing preparation stamp or changed runtime' };
    }
    if (!outputsPresent(path, prepareSettings(context, path).outputs)) {
      return { valid: false, reason: 'install output missing' };
    }
    if (stamp.dependencyHash !== computeDependencyHash(context, number)) {
      return { valid: false, reason: 'dependency inputs changed' };
    }
    return { valid: true, reason: 'pool preparation inputs unchanged' };
  } catch {
    return { valid: false, reason: 'pool preparation could not be verified' };
  }
}

// --- Shared resource locks and lanes -----------------------------------------------------------

export function acquireResourceLock(context, resource, options = {}) {
  if (!['runtime', 'database'].includes(resource)) throw new Error(`Unknown shared resource: ${resource}`);
  const number = resolveSlotNumber(context, options.cwd ?? context.cwd, options.slot);
  const lease = readJson(leasePath(context, number));
  if (!lease) throw new Error(`${slotName(context, number)} must be leased first`);
  const path = join(context.stateRoot, 'locks', `resource-${resource}`);
  try {
    mkdirSync(path, { recursive: false });
  } catch (error) {
    if (error.code === 'ENOENT') {
      mkdirSync(dirname(path), { recursive: true });
      mkdirSync(path);
    } else if (error.code === 'EEXIST') {
      const owner = readJson(join(path, 'owner.json'));
      throw new Error(`${resource} is already leased by ${owner?.slot ?? 'unknown'} (${owner?.owner ?? 'unknown'})`);
    } else throw error;
  }
  const value = { resource, slot: lease.slot, token: lease.token, owner: lease.owner, acquiredAt: new Date().toISOString() };
  writeJson(join(path, 'owner.json'), value);
  return value;
}

export function releaseResourceLock(context, resource, options = {}) {
  const number = resolveSlotNumber(context, options.cwd ?? context.cwd, options.slot);
  const lease = readJson(leasePath(context, number));
  const path = join(context.stateRoot, 'locks', `resource-${resource}`);
  const owner = readJson(join(path, 'owner.json'));
  if (!owner) throw new Error(`${resource} is not leased`);
  if (!lease || owner.token !== lease.token) throw new Error(`${resource} belongs to ${owner.slot}; refusing foreign unlock`);
  rmSync(path, { recursive: true });
  return owner;
}

export function acquireRuntimeLane(context, options = {}) {
  const cap = options.cap ?? RUNTIME_LANE_CAP;
  const lease = options.lease
    ?? readJson(leasePath(context, resolveSlotNumber(context, options.cwd ?? context.cwd, options.slot)));
  if (!lease) throw new Error('A leased slot is required before acquiring a runtime lane');
  for (let n = 1; n <= cap; n += 1) {
    const path = laneLockPath(context, n);
    try {
      mkdirSync(path, { recursive: false });
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      if (error.code === 'ENOENT') { mkdirSync(dirname(path), { recursive: true }); mkdirSync(path); }
      else throw error;
    }
    const value = { lane: n, slot: lease.slot, token: lease.token, owner: lease.owner, pid: process.pid, acquiredAt: new Date().toISOString() };
    writeJson(join(path, 'owner.json'), value);
    return value;
  }
  throw new Error(`No free runtime lane (cap ${cap})`);
}

export function releaseRuntimeLane(context, options = {}) {
  let n = options.lane;
  let lease = options.lease;

  if (!n) {
    // The documented `${WT} unlane` (no --lane) is run from inside the leased slot that is holding a
    // lane — resolve which lane that is by scanning the lane locks for one whose owner token matches
    // this slot's lease, instead of requiring the caller to already know the lane number.
    lease = lease
      ?? readJson(leasePath(context, resolveSlotNumber(context, options.cwd ?? context.cwd, options.slot)));
    if (!lease) {
      throw new Error('No leased slot found to resolve a runtime lane from; pass --lane or run from a leased slot');
    }
    for (const candidate of existingLaneNumbers(context)) {
      const owner = readJson(join(laneLockPath(context, candidate), 'owner.json'));
      if (owner?.token === lease.token) {
        n = candidate;
        break;
      }
    }
    if (!n) throw new Error('No runtime lane held by this slot');
  }

  const path = laneLockPath(context, n);
  const owner = readJson(join(path, 'owner.json'));
  if (!owner) throw new Error(`runtime-lane-${n} is not leased`);
  // force: an orphaned lane's owning slot lease is, by definition, missing or token-mismatched (that's
  // what makes it orphaned — see doctorPool) — the normal ownership check below always fails for it, so
  // the doctor-printed reclaim command could never succeed. force skips lease/token ownership
  // verification entirely, but the owner.json existence check above still applies.
  if (!options.force) {
    lease = lease
      ?? readJson(leasePath(context, resolveSlotNumber(context, options.cwd ?? context.cwd, options.slot)));
    if (!lease || owner.token !== lease.token) throw new Error(`runtime-lane-${n} belongs to ${owner.slot}; refusing foreign unlock`);
  }
  rmSync(path, { recursive: true });
  return { lane: n };
}

export function doctorPool(context, options = {}) {
  const rows = getPoolStatus(context);
  const errors = [];
  const fixed = [];
  if (rows.length !== context.config.slotCount) errors.push(`Expected ${context.config.slotCount} slots`);
  for (const row of rows) {
    if (row.state === 'MISSING') errors.push(`${row.slot}: ${row.state} ${row.detail}`);
    else if (row.state === 'BLOCKED') {
      errors.push(`${row.slot}: BLOCKED ${row.detail} (${WT} reap --apply repairs it when it is clean and pushed)`);
    }
  }
  for (const name of ['allocation', 'dependency-install']) {
    const path = join(context.stateRoot, 'locks', name);
    const owner = readJson(join(path, 'owner.json'));
    if (owner && !isProcessAlive(owner.pid)) {
      if (options.fix && lockIsStale(path, owner)) {
        rmSync(path, { recursive: true, force: true });
        fixed.push(`${name}: cleared stale lock from PID ${owner.pid}`);
      } else errors.push(`${name}: stale internal lock from PID ${owner.pid}`);
    }
  }
  // Read the lease files themselves: a lane or lock is orphaned when ITS slot's lease file is gone or has another token.
  const leaseOf = (slot) => readJson(join(context.stateRoot, 'leases', `${slot}.json`));
  // Lanes are found on disk, not by WT_LANE_CAP: a lane made by a session with a bigger cap must
  // still be seen by one with the default.
  for (const n of existingLaneNumbers(context)) {
    const owner = readJson(join(laneLockPath(context, n), 'owner.json'));
    if (!owner) continue;
    // Lanes are held by a leased slot, not by a live process — `lane` exits right after acquiring, so
    // PID liveness always reads "dead". A lane is orphaned when its owning slot no longer holds a lease
    // with the SAME token (release refuses while a lane is held, so a mismatch means the slot moved on).
    const slotLease = leaseOf(owner.slot);
    if (!slotLease || slotLease.token !== owner.token) {
      if (options.fix) {
        rmSync(laneLockPath(context, n), { recursive: true, force: true });
        fixed.push(`runtime-lane-${n}: cleared orphan lane of ${owner.slot}`);
      } else {
        errors.push(`runtime-lane-${n}: orphaned lane (owning slot lease gone; reclaim: ${WT} doctor --fix, or ${WT} unlane --lane ${n} --force)`);
      }
    }
  }
  for (const resource of ['runtime', 'database']) {
    const path = join(context.stateRoot, 'locks', `resource-${resource}`);
    const owner = readJson(join(path, 'owner.json'));
    if (!owner) continue;
    const slotLease = leaseOf(owner.slot);
    if (!slotLease || slotLease.token !== owner.token) {
      if (options.fix) {
        rmSync(path, { recursive: true, force: true });
        fixed.push(`resource-${resource}: cleared orphan lock of ${owner.slot}`);
      } else errors.push(`resource-${resource}: orphaned lock (owning slot lease gone; reclaim: ${WT} doctor --fix)`);
    }
  }
  return { ok: errors.length === 0, errors, fixed, rows };
}

// --- Reaper: free what is provably done, take over what is provably abandoned ----------------------

// Dry-run by default. With { apply: true } it frees slots by tier, always through the guarded
// releaseSlot / takeover path, which re-checks live state under the pool lock AND revalidates the
// classified lease token (expectedToken), so a slot that changed or was re-leased between
// classification and release fails closed rather than detaching the wrong work.
//
//   REAPABLE, REAPABLE_BLOCKED   always applied (landed work; stuck-but-clean slots)
//   REAPABLE_PUSHED              clean + pushed, owner quiet for the policy window
//   TAKEOVER                     owner gone for the abandoned window; state is saved first
//
// Options: apply, includePushed (default true), takeover (default true), stopWhenFree (stop freeing
// pushed/abandoned slots once one is free: the acquire path), pressure (pool full: shorter windows),
// fetched (the caller already fetched), now.
export async function reapPool(context, options = {}) {
  const apply = Boolean(options.apply);
  const includePushed = options.includePushed !== false;
  const allowTakeover = options.takeover !== false;
  const mergeTarget = options.mergeTarget || context.config.baseRef; // e.g. origin/main
  // merged-detection compares HEAD against a remote-tracking ref refreshed by the fetch below. A local
  // ref (e.g. plain "main") can be advanced by local merges and produce a false-positive merged.
  if (!mergeTarget.startsWith('origin/')) {
    throw new Error(`reap requires a remote-tracking baseRef (origin/...), got "${mergeTarget}"`);
  }
  // Refresh EVERY origin remote-tracking ref: the per-slot counts read each branch's remote state.
  // Fail CLOSED (no allowFailure) — reaping is destructive, so a failed fetch must abort rather than
  // classify against stale refs.
  if (!options.fetched) run('git', ['fetch', 'origin', '--prune', '--quiet'], { cwd: context.mainRoot });

  const now = options.now ?? Date.now();
  const rows = getPoolStatus(context);
  const pressure = options.pressure ?? !rows.some((row) => row.state === 'AVAILABLE');
  const probe = rows.filter((row) => row.state === 'LEASED' || (row.state === 'BLOCKED' && blockedKind(row)));
  const mergedPrHeads = probe.length > 2 ? mergedPrHeadMap(context.mainRoot, mergeTarget.replace(/^origin\//, '')) : undefined;
  const factsByNumber = await collectFactsParallel(context, probe, { mergeTarget, now, pressure, mergedPrHeads });

  const results = rows.map((row) => {
    const facts = factsByNumber.get(row.number);
    if (!facts) return { slot: row.slot, number: row.number, branch: row.branch, classification: 'SKIP', reaped: false };
    const kind = row.state === 'BLOCKED' ? blockedKind(row) : null;
    const classification = kind ? classifyBlockedSlot(facts, kind) : classifySlot(facts);
    return {
      slot: row.slot,
      number: row.number,
      branch: row.branch,
      classification,
      leaseBranch: classification === 'REVIEW_DRIFT' ? row.lease?.branch ?? null : null,
      ...facts,
      reaped: false,
      row,
    };
  });

  if (apply) {
    const order = ['REAPABLE', 'REAPABLE_BLOCKED'];
    if (includePushed) order.push('REAPABLE_PUSHED');
    if (allowTakeover) order.push('TAKEOVER');
    const hasFree = () => getPoolStatus(context).some((row) => row.state === 'AVAILABLE');
    for (const cls of order) {
      for (const result of results.filter((r) => r.classification === cls)) {
        if (options.stopWhenFree && (cls === 'REAPABLE_PUSHED' || cls === 'TAKEOVER') && hasFree()) break;
        try {
          const outcome = withPoolLock(context, () => applyReap(context, result, cls, now));
          result.reaped = true;
          result.action = outcome.action;
          if (outcome.salvage) result.salvage = outcome.salvage.ref;
        } catch (error) {
          result.error = error.message;
        }
      }
    }
  }
  for (const result of results) delete result.row;
  return { apply, mergeTarget, results };
}

function applyReap(context, result, classification, now) {
  const row = result.row;
  // Re-read the live row: it must still be the lease that was classified.
  const live = getPoolStatus(context).find((candidate) => candidate.number === row.number);
  if (row.lease && live?.lease?.token !== row.lease.token) throw new Error(`${row.slot} was re-leased since classification; refusing stale reap`);
  if (classification === 'REAPABLE_BLOCKED') {
    const healed = healBlockedLocked(context, live, { now });
    if (!healed.healed) throw new Error(healed.reason);
    return { action: 'healed' };
  }
  if (classification === 'TAKEOVER') {
    if (!live.lease) {
      const healed = healBlockedLocked(context, live, { now });
      if (!healed.healed) throw new Error(healed.reason);
      return { action: 'healed', salvage: healed.salvage };
    }
    const taken = takeoverLocked(context, { number: row.number, actor: '__reaper__', now });
    if (taken.action !== 'taken-over' && taken.action !== 'released') throw new Error(taken.reason ?? taken.action);
    return { action: taken.action, salvage: taken.salvage };
  }
  // Pass the gh-verified merged-PR head so releaseSlot can release a squash-merged slot; it re-matches
  // it against live HEAD under the lock before accepting it.
  releaseLocked(context, {
    slot: row.number,
    expectedToken: row.lease?.token,
    mergedHead: result.prMerged ? result.head : undefined,
    now,
  });
  return { action: 'released' };
}
