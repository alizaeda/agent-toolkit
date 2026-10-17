import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import {
  acquireSlot,
  assertSlot,
  classifyBlockedSlot,
  classifySlot,
  DEFAULT_POLICY,
  doctorPool,
  existingLaneNumbers,
  getPoolStatus,
  reapPool,
  releaseSlot,
  run,
  setupPool,
  switchSlot,
  takeoverSlot,
} from '../pool-lib.mjs';
import { leaseActivity, ownerTranscriptMtimeMs, resetLivenessCaches, touchHeartbeat } from '../liveness.mjs';
import { landedVia, unpushedCommitCount } from '../proof.mjs';
import { salvageSlot } from '../salvage.mjs';
import { HOUR, NO_WAIT_POLICY, branchExists, cleanupFixtures, commitFile, fixture } from './fixture.mjs';

afterEach(cleanupFixtures);

const MINUTE = 60_000;
const git = (path, ...args) => run('git', args, { cwd: path }).stdout;

function pushedLease(context, branch, owner, file = `${branch.replace(/\W/g, '-')}.txt`) {
  return acquireSlot(context, branch, { purpose: `test ${branch}`, owner }).then((lease) => {
    commitFile(lease.path, file);
    git(lease.path, 'push', '-u', 'origin', branch);
    return lease;
  });
}

// --- Ownership on release --------------------------------------------------------------------

test('a finished slot of someone else is released without asking; a live one is refused', async () => {
  const context = fixture(2, NO_WAIT_POLICY);
  setupPool(context);
  const finished = await pushedLease(context, 'codex/finished', 'owner-a');
  const result = releaseSlot(context, { cwd: finished.path, actor: 'owner-b' });
  assert.equal(result.foreign, true);
  assert.equal(result.tier, 'REAPABLE_PUSHED');
  assert.equal(branchExists(context, 'codex/finished'), true);

  // Dirty work of someone who was active a moment ago is never released.
  const busy = await acquireSlot(context, 'codex/busy', { purpose: 'busy', owner: 'owner-a' });
  commitFile(busy.path, 'busy.txt');
  writeFileSync(join(busy.path, 'wip.txt'), 'wip');
  assert.throws(() => releaseSlot(context, { cwd: busy.path, actor: 'owner-b' }), /not to this session.*adopt --slot/s);
  assert.equal(getPoolStatus(context).find((r) => r.branch === 'codex/busy').state, 'LEASED');
});

test('--expect-branch refuses a slot that was re-leased to another branch', async () => {
  const context = fixture();
  setupPool(context);
  const lease = await acquireSlot(context, 'codex/now-here', { purpose: 'expect' });
  assert.throws(() => releaseSlot(context, { cwd: lease.path, expectBranch: 'codex/was-here' }), /not codex\/was-here/);
  assert.equal(getPoolStatus(context)[0].state, 'LEASED');
});

// --- Proofs ----------------------------------------------------------------------------------

test('release proves landed work itself: cherry-pick, squash (content) and push under another name', async () => {
  const context = fixture(3);
  setupPool(context);

  // 1. same patch on main (cherry-pick or rebase merge)
  const one = await acquireSlot(context, 'codex/cherry', { purpose: 'cherry' });
  commitFile(one.path, 'c.txt', 'same');
  commitFile(context.mainRoot, 'c.txt', 'same', 'main got the same patch');
  git(context.mainRoot, 'push', 'origin', 'main');
  assert.equal(landedVia(one.path, 'origin/main'), 'cherry');
  assert.equal(releaseSlot(context, { cwd: one.path }).landedVia, 'cherry');

  // 2. squash: two commits on the branch, one commit on main with the same final files
  const two = await acquireSlot(context, 'codex/squash', { purpose: 'squash' });
  commitFile(two.path, 's1.txt', 'one');
  commitFile(two.path, 's2.txt', 'two');
  writeFileSync(join(context.mainRoot, 's1.txt'), 'one');
  writeFileSync(join(context.mainRoot, 's2.txt'), 'two');
  git(context.mainRoot, 'add', 's1.txt', 's2.txt');
  git(context.mainRoot, 'commit', '-m', 'squash of codex/squash');
  git(context.mainRoot, 'push', 'origin', 'main');
  assert.equal(landedVia(two.path, 'origin/main'), 'content');
  assert.equal(releaseSlot(context, { cwd: two.path }).landedVia, 'content');

  // 3. pushed to a branch of another name, no upstream: not "unpushed"
  const three = await acquireSlot(context, 'codex/local-name', { purpose: 'renamed push' });
  commitFile(three.path, 'r.txt');
  git(three.path, 'push', 'origin', 'HEAD:codex/remote-name');
  assert.equal(unpushedCommitCount(three.path), 0);
  assert.equal(releaseSlot(context, { cwd: three.path }).landedVia, null);

  // Work that exists nowhere else is still refused, with the count in the message.
  const four = await acquireSlot(context, 'codex/only-here', { purpose: 'local only' });
  commitFile(four.path, 'only.txt');
  assert.equal(unpushedCommitCount(four.path), 1);
  assert.equal(landedVia(four.path, 'origin/main'), null);
  assert.throws(() => releaseSlot(context, { cwd: four.path }), /1 commit\(s\) exist on no remote branch/);
});

// --- Takeover and adopt ------------------------------------------------------------------------

test('takeover saves dirty files and local commits, then frees an abandoned slot', async () => {
  const context = fixture();
  setupPool(context);
  const lease = await acquireSlot(context, 'codex/ghost', { purpose: 'ghost', owner: 'ghost-owner' });
  commitFile(lease.path, 'local.txt', 'local commit');
  writeFileSync(join(lease.path, 'dirty.txt'), 'dirty file');
  writeFileSync(join(lease.path, 'package.json'), '{"name":"changed"}\n');

  // The owner was active a moment ago: nothing happens.
  const early = takeoverSlot(context, { slot: 1, actor: 'me' });
  assert.equal(early.action, 'refused');
  assert.equal(getPoolStatus(context)[0].state, 'LEASED');

  const done = takeoverSlot(context, { slot: 1, actor: 'me', now: Date.now() + 100 * HOUR });
  assert.equal(done.action, 'taken-over');
  assert.match(done.salvage.ref, /^salvage\/slot-01-/);
  assert.equal(done.localOnly, 1);
  assert.equal(getPoolStatus(context)[0].state, 'AVAILABLE');
  assert.equal(git(context.mainRoot, 'show', `${done.salvage.ref}:dirty.txt`), 'dirty file');
  assert.equal(git(context.mainRoot, 'show', `${done.salvage.ref}:package.json`), '{"name":"changed"}');
  assert.equal(git(context.mainRoot, 'show', 'codex/ghost:local.txt'), 'local commit');
  assert.ok(existsSync(join(context.stateRoot, 'salvage')));
  assert.match(readFileSync(join(context.stateRoot, 'events.jsonl'), 'utf8'), /"type":"takeover"/);
});

test('adopt re-leases in place and keeps the tree; an ended owner may be adopted early', async () => {
  const context = fixture();
  setupPool(context);
  const lease = await acquireSlot(context, 'codex/continued', { purpose: 'continued', owner: 'old-session' });
  writeFileSync(join(lease.path, 'wip.txt'), 'wip');

  // Quiet owner but not abandoned for 24 h, no end marker: refused.
  assert.equal(takeoverSlot(context, { slot: 1, actor: 'new-session', adopt: true, now: Date.now() + 10 * MINUTE }).action, 'refused');

  // The session closed (SessionEnd hook): after the short grace the slot can be adopted, dirty or not.
  mkdirSync(join(context.stateRoot, 'ended'), { recursive: true });
  writeFileSync(join(context.stateRoot, 'ended', 'old-session.json'), JSON.stringify({ owner: 'old-session', endedAt: new Date().toISOString(), reason: 'clear' }));
  const adopted = takeoverSlot(context, { slot: 1, actor: 'new-session', adopt: true, now: Date.now() + 10 * MINUTE });
  assert.equal(adopted.action, 'adopted');
  assert.equal(adopted.lease.owner, 'new-session');
  assert.equal(adopted.lease.previousOwners[0].owner, 'old-session');
  assert.notEqual(adopted.lease.token, lease.token);
  assert.equal(readFileSync(join(lease.path, 'wip.txt'), 'utf8'), 'wip');
  assert.equal(getPoolStatus(context)[0].branch, 'codex/continued');
});

test('acquire of a branch held by an abandoned owner adopts it in place; a live owner keeps it', async () => {
  const context = fixture();
  setupPool(context);
  const lease = await acquireSlot(context, 'codex/shared', { purpose: 'shared', owner: 'ghost' });
  writeFileSync(join(lease.path, 'wip.txt'), 'wip');

  await assert.rejects(acquireSlot(context, 'codex/shared', { purpose: 'me too', owner: 'me' }), /already checked out.*leased to ghost/s);
  const adopted = await acquireSlot(context, 'codex/shared', { purpose: 'continue it', owner: 'me', now: Date.now() + 100 * HOUR });
  assert.equal(adopted.adopted, true);
  assert.equal(adopted.slot, 'slot-01');
  assert.equal(existsSync(join(lease.path, 'wip.txt')), true);
  assert.equal(getPoolStatus(context).filter((row) => row.state === 'LEASED').length, 1);
});

test('acquire is idempotent for the caller and prefers a slot whose install matches the lockfile', async () => {
  const context = fixture(3);
  setupPool(context);
  const first = await acquireSlot(context, 'codex/again', { purpose: 'again', owner: 'me' });
  const second = await acquireSlot(context, 'codex/again', { purpose: 'again', owner: 'me' });
  assert.equal(second.reused, true);
  assert.equal(second.token, first.token);
  assert.equal(getPoolStatus(context).filter((row) => row.state === 'LEASED').length, 1);

  // slot-03 was installed against the current lockfile, slot-02 was not.
  const blob = git(context.mainRoot, 'rev-parse', 'origin/main:pnpm-lock.yaml');
  mkdirSync(join(context.stateRoot, 'stamps'), { recursive: true });
  writeFileSync(join(context.stateRoot, 'stamps', 'slot-03.json'), JSON.stringify({ node: process.version, lockfileBlob: blob }));
  const warm = await acquireSlot(context, 'codex/warm', { purpose: 'warm', owner: 'me' });
  assert.equal(warm.slot, 'slot-03');
});

// --- Stuck slots heal themselves ----------------------------------------------------------------

test('reap repairs a clean, pushed BLOCKED slot (unleased branch, lease drift) but not a dirty one', async () => {
  const context = fixture(3);
  setupPool(context);
  const future = Date.now() + HOUR;

  // unleased branch: the lease record vanished, the branch is still checked out
  const stuck = await pushedLease(context, 'codex/stuck', 'owner-a');
  rmSync(join(context.stateRoot, 'leases', 'slot-01.json'));
  // drift: someone switched branches inside a leased slot
  const drift = await pushedLease(context, 'codex/drift-a', 'owner-a');
  git(drift.path, 'switch', '-c', 'codex/drift-b');
  git(drift.path, 'push', '-u', 'origin', 'codex/drift-b');
  // dirty drift: not safe
  const dirty = await pushedLease(context, 'codex/dirty-a', 'owner-a');
  git(dirty.path, 'switch', '-c', 'codex/dirty-b');
  git(dirty.path, 'push', '-u', 'origin', 'codex/dirty-b');
  writeFileSync(join(dirty.path, 'wip.txt'), 'wip');
  assert.deepEqual(getPoolStatus(context).map((r) => r.state), ['BLOCKED', 'BLOCKED', 'BLOCKED']);

  const early = await reapPool(context, { apply: true });
  assert.ok(early.results.every((r) => !r.reaped), 'nothing is repaired while the owner is active');

  const result = await reapPool(context, { apply: true, now: future });
  const byBranch = Object.fromEntries(result.results.map((r) => [r.slot, r]));
  assert.equal(byBranch['slot-01'].classification, 'REAPABLE_BLOCKED');
  assert.equal(byBranch['slot-01'].reaped, true);
  assert.equal(byBranch['slot-02'].classification, 'REAPABLE_BLOCKED');
  assert.equal(byBranch['slot-02'].reaped, true);
  assert.equal(byBranch['slot-03'].reaped, false);
  assert.deepEqual(getPoolStatus(context).map((r) => r.state), ['AVAILABLE', 'AVAILABLE', 'BLOCKED']);
  assert.equal(branchExists(context, stuck.branch), true);
  assert.equal(branchExists(context, 'codex/drift-b'), true);
});

test('reap takes over an abandoned dirty slot only after the abandoned window, and saves it first', async () => {
  const context = fixture();
  setupPool(context);
  const lease = await acquireSlot(context, 'codex/forgotten', { purpose: 'forgotten', owner: 'ghost' });
  commitFile(lease.path, 'work.txt');
  writeFileSync(join(lease.path, 'wip.txt'), 'wip');

  const soon = await reapPool(context, { apply: true, now: Date.now() + 5 * HOUR });
  assert.equal(soon.results[0].classification, 'ACTIVE');
  assert.equal(getPoolStatus(context)[0].state, 'LEASED');

  const later = await reapPool(context, { apply: true, now: Date.now() + 30 * HOUR });
  assert.equal(later.results[0].classification, 'TAKEOVER');
  assert.equal(later.results[0].reaped, true);
  assert.match(later.results[0].salvage, /^salvage\/slot-01-/);
  assert.equal(getPoolStatus(context)[0].state, 'AVAILABLE');
  const noTakeover = await acquireSlot(context, 'codex/new', { purpose: 'new' });
  assert.equal(noTakeover.slot, 'slot-01');
});

test('a full pool frees an abandoned slot for the next acquire', async () => {
  const context = fixture(1);
  setupPool(context);
  const lease = await acquireSlot(context, 'codex/hog', { purpose: 'hog', owner: 'ghost' });
  commitFile(lease.path, 'hog.txt');
  git(lease.path, 'push', '-u', 'origin', 'codex/hog');

  await assert.rejects(acquireSlot(context, 'codex/blocked-by-live', { purpose: 'x', owner: 'me' }), /No available worktree slots/);
  const freed = [];
  const next = await acquireSlot(context, 'codex/next', { purpose: 'next', owner: 'me', now: Date.now() + 2 * HOUR, onAutoReap: (r) => freed.push(...r) });
  assert.equal(next.slot, 'slot-01');
  assert.equal(freed.length, 1);
  assert.equal(branchExists(context, 'codex/hog'), true);
});

// --- switch and assert -----------------------------------------------------------------------------

test('switch re-leases the same slot to another branch and refuses dirty or unpushed work', async () => {
  const context = fixture();
  setupPool(context);
  const lease = await pushedLease(context, 'codex/first-task', 'me');
  writeFileSync(join(lease.path, 'wip.txt'), 'wip');
  assert.throws(() => switchSlot(context, 'codex/second-task', { cwd: lease.path, purpose: 'next', actor: 'me' }), /dirty/);
  rmSync(join(lease.path, 'wip.txt'));
  commitFile(lease.path, 'unpushed.txt');
  assert.throws(() => switchSlot(context, 'codex/second-task', { cwd: lease.path, purpose: 'next', actor: 'me' }), /exist on no remote branch/);
  git(lease.path, 'push');
  assert.throws(() => switchSlot(context, 'codex/second-task', { cwd: lease.path, purpose: 'next', actor: 'someone-else' }), /only its owner/);

  const next = switchSlot(context, 'codex/second-task', { cwd: lease.path, purpose: 'next', actor: 'me' });
  assert.equal(next.branch, 'codex/second-task');
  assert.equal(next.switchedFrom, 'codex/first-task');
  assert.notEqual(next.token, lease.token);
  assert.equal(git(lease.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'codex/second-task');
  assert.equal(getPoolStatus(context)[0].state, 'LEASED');
});

test('assert says whether the slot at hand still belongs to the caller', async () => {
  const context = fixture();
  setupPool(context);
  const lease = await acquireSlot(context, 'codex/mine', { purpose: 'assert', owner: 'me' });
  assert.equal(assertSlot(context, { cwd: lease.path, actor: 'me' }).ok, true);
  assert.ok(existsSync(join(context.stateRoot, 'heartbeats', lease.token)));
  const other = assertSlot(context, { cwd: lease.path, actor: 'you' });
  assert.equal(other.ok, false);
  assert.match(other.reason, /not to this session.*adopt --slot/s);
  git(lease.path, 'switch', '--detach');
  assert.match(assertSlot(context, { cwd: lease.path, actor: 'me' }).reason, / switch/);
  assert.equal(assertSlot(context, { cwd: context.mainRoot, actor: 'me' }).ok, false);
});

// --- Lanes and doctor ------------------------------------------------------------------------------

test('lanes are found on disk, not by WT_LANE_CAP: release refuses, doctor sees and fixes orphans', async () => {
  const context = fixture();
  setupPool(context);
  const lease = await acquireSlot(context, 'codex/lane-holder', { purpose: 'lane', owner: 'me' });
  commitFile(lease.path, 'l.txt');
  git(lease.path, 'push', '-u', 'origin', 'codex/lane-holder');
  const lane = join(context.stateRoot, 'locks', 'runtime-lane-3');
  mkdirSync(lane, { recursive: true });
  writeFileSync(join(lane, 'owner.json'), JSON.stringify({ lane: 3, slot: lease.slot, token: lease.token, owner: 'me' }));
  assert.deepEqual(existingLaneNumbers(context), [3]);
  assert.throws(() => releaseSlot(context, { cwd: lease.path }), /runtime-lane-3/);

  // The lane of a slot that moved on is an orphan, whatever cap this process has.
  writeFileSync(join(lane, 'owner.json'), JSON.stringify({ lane: 3, slot: lease.slot, token: 'older-lease', owner: 'gone' }));
  const report = doctorPool(context);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((line) => /runtime-lane-3: orphaned lane/.test(line)));
  const fixed = doctorPool(context, { fix: true });
  assert.equal(fixed.ok, true);
  assert.ok(fixed.fixed.some((line) => /runtime-lane-3/.test(line)));
  assert.deepEqual(existingLaneNumbers(context), []);
});

// --- Classification (pure) ---------------------------------------------------------------------------

const quiet = { state: 'LEASED', ownerKnown: true, dirty: false, hasUpstream: true, upstreamIsBase: false, unpushed: 0, behind: 0, merged: false, pushed: true, policy: DEFAULT_POLICY };

test('clean + pushed slots need a quiet owner; the window shrinks when the pool is full or the owner ended', () => {
  assert.equal(classifySlot({ ...quiet, idleMs: 30 * MINUTE }), 'ACTIVE');
  assert.equal(classifySlot({ ...quiet, idleMs: 61 * MINUTE }), 'REAPABLE_PUSHED');
  assert.equal(classifySlot({ ...quiet, idleMs: 16 * MINUTE, pressure: true }), 'REAPABLE_PUSHED');
  assert.equal(classifySlot({ ...quiet, idleMs: 10 * MINUTE, pressure: true }), 'ACTIVE');
  assert.equal(classifySlot({ ...quiet, idleMs: 3 * MINUTE, ownerEnded: true }), 'REAPABLE_PUSHED');
  assert.equal(classifySlot({ ...quiet, idleMs: MINUTE, ownerEnded: true }), 'ACTIVE');
});

test('landed work needs a short quiet window; untouched leases are reaped only when quiet', () => {
  assert.equal(classifySlot({ ...quiet, merged: true, idleMs: 4 * MINUTE }), 'ACTIVE');
  assert.equal(classifySlot({ ...quiet, merged: true, idleMs: 6 * MINUTE }), 'REAPABLE');
  assert.equal(classifySlot({ ...quiet, untouched: true, merged: true, idleMs: 2 * MINUTE }), 'ACTIVE');
  assert.equal(classifySlot({ ...quiet, untouched: true, merged: true, idleMs: 6 * MINUTE }), 'REAPABLE');
  assert.equal(classifySlot({ ...quiet, untouched: true, idleMs: 30 * MINUTE }), 'ACTIVE');
  assert.equal(classifySlot({ ...quiet, untouched: true, idleMs: 61 * MINUTE }), 'REAPABLE');
});

test('dirty or local-only work is taken over only after the abandoned window for that kind of owner', () => {
  const work = { ...quiet, dirty: true, pushed: false, hasUpstream: false };
  assert.equal(classifySlot({ ...work, ownerKnown: true, idleMs: 23 * HOUR }), 'ACTIVE');
  assert.equal(classifySlot({ ...work, ownerKnown: true, idleMs: 25 * HOUR }), 'TAKEOVER');
  assert.equal(classifySlot({ ...work, ownerKnown: false, idleMs: 25 * HOUR }), 'ACTIVE');
  assert.equal(classifySlot({ ...work, ownerKnown: false, idleMs: 73 * HOUR }), 'TAKEOVER');
  assert.equal(classifySlot({ ...work, ownerKnown: true, ownerEnded: true, idleMs: 5 * HOUR }), 'TAKEOVER');
  assert.equal(classifySlot({ ...work, merged: true, ownerKnown: true, idleMs: 25 * HOUR }), 'TAKEOVER');
});

test('a Git operation or held lock is never reaped while the owner could be running it', () => {
  const work = { ...quiet, dirty: true, pushed: false, ownerKnown: true };
  assert.equal(classifySlot({ ...work, gitOp: 'MERGE_HEAD', idleMs: 500 * HOUR }), 'ACTIVE');
  assert.equal(classifySlot({ ...quiet, holdsLocks: ['runtime-lane-1'], idleMs: 10 * HOUR }), 'ACTIVE');
  assert.equal(classifySlot({ ...quiet, holdsLocks: ['runtime-lane-1'], idleMs: 30 * HOUR }), 'REAPABLE_PUSHED');
});

test('BLOCKED slots are repairable only when clean, pushed and quiet', () => {
  const blocked = { ...quiet, idleMs: 31 * MINUTE };
  assert.equal(classifyBlockedSlot(blocked, 'drift'), 'REAPABLE_BLOCKED');
  assert.equal(classifyBlockedSlot({ ...blocked, idleMs: 10 * MINUTE }, 'drift'), 'REVIEW_DRIFT');
  assert.equal(classifyBlockedSlot({ ...blocked, dirty: true }, 'unleased'), 'REVIEW_UNLEASED');
  assert.equal(classifyBlockedSlot({ ...blocked, pushed: false }, 'drift'), 'REVIEW_DRIFT');
  assert.equal(classifyBlockedSlot({ ...blocked, dirty: true, pushed: false, idleMs: 100 * HOUR, ownerKnown: false }, 'unleased-dirty'), 'TAKEOVER');
});

// --- Liveness signals -------------------------------------------------------------------------------

test('owner transcripts are found for Claude sessions and Codex threads, and ignored for other owners', async () => {
  const context = fixture();
  const claudeId = '5c238adf-98a8-43f7-a373-bd78673ffcd5';
  const codexId = '01a135ed-a1c2-7a51-8bd2-69c9ad1717d3';
  const claude = join(context.poolRoot, '..', 'claude-projects');
  const codex = join(context.poolRoot, '..', 'codex-sessions');
  mkdirSync(join(claude, 'some-project'), { recursive: true });
  mkdirSync(join(codex, '2026', '10', '16'), { recursive: true });
  writeFileSync(join(claude, 'some-project', `${claudeId}.jsonl`), '{}');
  writeFileSync(join(codex, '2026', '10', '16', `rollout-2026-10-16T09-00-00-${codexId}.jsonl`), '{}');
  const env = { WT_CLAUDE_PROJECTS_DIR: claude, WT_CODEX_SESSIONS_DIR: codex };
  resetLivenessCaches();
  assert.ok(ownerTranscriptMtimeMs(claudeId, env) > 0);
  assert.ok(ownerTranscriptMtimeMs(codexId, env) > 0);
  assert.equal(ownerTranscriptMtimeMs('aliza@ALI', env), null);
  assert.equal(ownerTranscriptMtimeMs('11111111-2222-3333-4444-555555555555', env), null);
  resetLivenessCaches();
});

test('an ended marker counts only while nothing happened after it', async () => {
  const context = fixture();
  const lease = { token: 'tok-1', owner: 'owner-x', acquiredAt: new Date(Date.now() - HOUR).toISOString() };
  mkdirSync(join(context.stateRoot, 'ended'), { recursive: true });
  const endedAt = new Date(Date.now() - 30 * MINUTE);
  writeFileSync(join(context.stateRoot, 'ended', 'owner-x.json'), JSON.stringify({ owner: 'owner-x', endedAt: endedAt.toISOString(), reason: 'prompt_input_exit' }));
  const ended = leaseActivity({ lease, stateRoot: context.stateRoot });
  assert.equal(ended.ownerEnded, true);
  assert.equal(ended.endReason, 'prompt_input_exit');
  // The session came back (resume) and worked: the marker no longer applies.
  touchHeartbeat(context.stateRoot, 'tok-1');
  assert.equal(leaseActivity({ lease, stateRoot: context.stateRoot }).ownerEnded, false);
});

// --- Salvage -----------------------------------------------------------------------------------------

test('salvage keeps edits, new, staged and deleted files, leaves ignored files, and cleans the tree', async () => {
  const context = fixture();
  setupPool(context);
  const lease = await acquireSlot(context, 'codex/salvage-me', { purpose: 'salvage', owner: 'ghost' });
  writeFileSync(join(lease.path, '.gitignore'), 'ignored.log\n');
  git(lease.path, 'add', '.gitignore');
  git(lease.path, 'commit', '-m', 'ignore logs');
  writeFileSync(join(lease.path, 'ignored.log'), 'keep me here');
  writeFileSync(join(lease.path, 'untracked.txt'), 'untracked');
  writeFileSync(join(lease.path, 'staged.txt'), 'staged');
  git(lease.path, 'add', 'staged.txt');
  writeFileSync(join(lease.path, 'package.json'), '{"name":"edited"}\n');
  rmSync(join(lease.path, 'pnpm-lock.yaml'));

  const saved = salvageSlot({ stateRoot: context.stateRoot, slot: lease.slot, path: lease.path, lease });
  assert.ok(saved.files >= 4);
  const show = (file) => run('git', ['show', `${saved.ref}:${file}`], { cwd: lease.path, allowFailure: true });
  assert.equal(show('untracked.txt').stdout, 'untracked');
  assert.equal(show('staged.txt').stdout, 'staged');
  assert.equal(show('package.json').stdout, '{"name":"edited"}');
  assert.notEqual(show('pnpm-lock.yaml').status, 0, 'the deletion is part of the snapshot');
  assert.equal(show('ignored.log').status !== 0, true, 'ignored files are not snapshotted');
  assert.equal(git(lease.path, 'status', '--porcelain'), '');
  assert.equal(readFileSync(join(lease.path, 'ignored.log'), 'utf8'), 'keep me here');
  assert.equal(salvageSlot({ stateRoot: context.stateRoot, slot: lease.slot, path: lease.path, lease }), null);
});

// --- Parallel probes and the CLI -----------------------------------------------------------------------

test('probing slots in worker threads gives the same verdicts as probing them one by one', async () => {
  const context = fixture(4, NO_WAIT_POLICY);
  setupPool(context);
  await pushedLease(context, 'codex/p1', 'a');
  const dirty = await pushedLease(context, 'codex/p2', 'b');
  writeFileSync(join(dirty.path, 'wip.txt'), 'wip');
  const local = await acquireSlot(context, 'codex/p3', { purpose: 'local', owner: 'c' });
  commitFile(local.path, 'p3.txt');
  await acquireSlot(context, 'codex/p4', { purpose: 'untouched', owner: 'd' });

  const shape = (result) => result.results.map((r) => ({ slot: r.slot, classification: r.classification, dirty: r.dirty, localOnly: r.localOnly, merged: r.merged }));
  const parallel = shape(await reapPool(context, { apply: false }));
  process.env.WT_NO_WORKERS = '1';
  let sequential;
  try {
    sequential = shape(await reapPool(context, { apply: false }));
  } finally {
    delete process.env.WT_NO_WORKERS;
  }
  assert.deepEqual(parallel, sequential);
  assert.deepEqual(parallel.map((r) => r.classification), ['REAPABLE_PUSHED', 'ACTIVE', 'ACTIVE', 'REAPABLE']);
});

test('the CLI prints status with owner, age and idle, and reports a slot that is not yours', async () => {
  const context = fixture();
  setupPool(context);
  await acquireSlot(context, 'codex/cli', { purpose: 'cli smoke', owner: 'cli-owner' });
  const cli = fileURLToPath(new URL('../pool.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: context.mainRoot, encoding: 'utf8', env: { ...process.env, WT_OWNER: 'cli-owner' } });
  const status = run('status');
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /slot-01\s+LEASED\s+codex\/cli\s+cli-owner\s+age .* idle .* - cli smoke/);
  assert.match(status.stdout, /slot-02\s+AVAILABLE/);
  const slot = join(context.poolRoot, 'slot-01');
  const mine = spawnSync(process.execPath, [cli, 'assert'], { cwd: slot, encoding: 'utf8', env: { ...process.env, WT_OWNER: 'cli-owner' } });
  assert.equal(mine.status, 0, mine.stderr);
  assert.match(mine.stdout, /OK slot-01 codex\/cli/);
  const theirs = spawnSync(process.execPath, [cli, 'assert'], { cwd: slot, encoding: 'utf8', env: { ...process.env, WT_OWNER: 'someone-else' } });
  assert.equal(theirs.status, 1);
  assert.match(theirs.stderr, /NOT YOURS.*adopt --slot/s);
});
