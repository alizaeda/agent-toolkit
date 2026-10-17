import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  acquireResourceLock,
  acquireSlot,
  computeDependencyHash,
  doctorPool,
  getPoolStatus,
  reapPool,
  releaseResourceLock,
  releaseSlot,
  recoverInternalLock,
  run,
  prepareSlot,
  setupPool,
  withNamedLock,
  withPoolLock,
} from '../pool-lib.mjs';
import { NO_WAIT_POLICY, cleanupFixtures, fixture } from './fixture.mjs';

const roots = [];

afterEach(() => {
  cleanupFixtures();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('setup is idempotent and creates detached available slots', async () => {
  const context = fixture();
  assert.equal(setupPool(context).length, 2);
  assert.equal(setupPool(context).length, 0);
  const rows = getPoolStatus(context);
  assert.deepEqual(rows.map((row) => row.state), ['AVAILABLE', 'AVAILABLE']);
  assert.equal(doctorPool(context).ok, true);
});

test('acquire is exclusive and never leases main', async () => {
  const context = fixture();
  setupPool(context);
  const lease = await acquireSlot(context, 'codex/feature-one', { owner: 'test-owner', purpose: 'exclusive test' });
  assert.equal(lease.slot, 'slot-01');
  await assert.rejects(acquireSlot(context, 'codex/feature-one', { purpose: 'duplicate' }), /already checked out/);
  await assert.rejects(acquireSlot(context, 'main', { purpose: 'invalid' }), /cannot be leased/);
  await assert.rejects(acquireSlot(context, 'codex/missing-purpose'), /purpose is required/);
  assert.equal(getPoolStatus(context)[0].state, 'LEASED');
});

test('release refuses dirty and unpushed work then preserves branch', async () => {
  const context = fixture();
  setupPool(context);
  const lease = await acquireSlot(context, 'codex/release-test', { purpose: 'release test' });
  writeFileSync(join(lease.path, 'dirty.txt'), 'dirty');
  assert.throws(() => releaseSlot(context, { cwd: lease.path }), /dirty worktree/);
  rmSync(join(lease.path, 'dirty.txt'));
  writeFileSync(join(lease.path, 'committed.txt'), 'committed');
  run('git', ['add', 'committed.txt'], { cwd: lease.path });
  run('git', ['commit', '-m', 'feature'], { cwd: lease.path });
  assert.throws(() => releaseSlot(context, { cwd: lease.path }), /unpushed commits/);
  const result = releaseSlot(context, { cwd: lease.path, allowUnpushed: true });
  assert.equal(result.branch, 'codex/release-test');
  assert.equal(getPoolStatus(context)[0].state, 'AVAILABLE');
  assert.equal(run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/codex/release-test'], { cwd: context.mainRoot, allowFailure: true }).status, 0);
});

test('an untouched lease: its owner gives it back freely, anyone else is refused', async () => {
  // A manual `release --slot <n>` used to detach a lease someone acquired seconds ago, because a lease
  // with zero commits looked identical to a finished one. Ownership now tells them apart: the owner may
  // always release it; a different session may only when the owner has been quiet for the policy window.
  const context = fixture();
  setupPool(context);
  const lease = await acquireSlot(context, 'codex/untouched-release', { purpose: 'untouched release test', owner: 'owner-a' });

  assert.throws(() => releaseSlot(context, { cwd: lease.path, actor: 'owner-b' }), /not to this session/);
  assert.equal(getPoolStatus(context)[0].state, 'LEASED');
  const result = releaseSlot(context, { cwd: lease.path, actor: 'owner-a' });
  assert.equal(result.branch, 'codex/untouched-release');
  assert.equal(getPoolStatus(context)[0].state, 'AVAILABLE');
});

test('release accepts a SHA-verified merged head when upstream is missing (pruned on merge)', async () => {
  const context = fixture();
  setupPool(context);
  const lease = await acquireSlot(context, 'codex/pr-merged-pruned', { purpose: 'verified merge test' });
  // Commit on the branch with NO upstream — the shape left after GitHub squash-
  // merges and deletes the head branch: HEAD != baseCommit and `@{u}` is gone, so
  // hasUnpushedCommits() reports true even though the commit is already merged.
  writeFileSync(join(lease.path, 'merged.txt'), 'merged');
  run('git', ['add', 'merged.txt'], { cwd: lease.path });
  run('git', ['commit', '-m', 'squash-merged work'], { cwd: lease.path });
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: lease.path }).stdout;

  // No override, or one that no longer matches HEAD, still fails closed.
  assert.throws(() => releaseSlot(context, { cwd: lease.path }), /unpushed commits/);
  assert.throws(() => releaseSlot(context, { cwd: lease.path, expectedToken: lease.token, mergedHead: `${'0'.repeat(40)}` }), /unpushed commits/);
  // mergedHead WITHOUT a valid expectedToken must NOT bypass — this is the exact
  // shape a manual `release --merged-head <sha>` would take. Reaper-only.
  assert.throws(() => releaseSlot(context, { cwd: lease.path, mergedHead: head }), /unpushed commits/);

  // Only the reaper's path — a valid lease token AND mergedHead == live HEAD —
  // releases and preserves the branch.
  const result = releaseSlot(context, { cwd: lease.path, expectedToken: lease.token, mergedHead: head });
  assert.equal(result.branch, 'codex/pr-merged-pruned');
  assert.equal(getPoolStatus(context)[0].state, 'AVAILABLE');
  assert.equal(run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/codex/pr-merged-pruned'], { cwd: context.mainRoot, allowFailure: true }).status, 0);
});

test('reap frees a clean, fully-pushed but UNMERGED slot (an open PR does not hold a slot)', async () => {
  const context = fixture(2, NO_WAIT_POLICY);
  setupPool(context);
  const lease = await acquireSlot(context, 'codex/open-pr', { purpose: 'open PR test' });
  writeFileSync(join(lease.path, 'work.txt'), 'work');
  run('git', ['add', 'work.txt'], { cwd: lease.path });
  run('git', ['commit', '-m', 'pushed work'], { cwd: lease.path });
  run('git', ['push', '-u', 'origin', 'codex/open-pr'], { cwd: lease.path });

  // Nothing is merged, so the merged-only pass must leave it alone.
  const conservative = await reapPool(context, { apply: true, includePushed: false });
  const held = conservative.results.find((r) => r.branch === 'codex/open-pr');
  assert.equal(held.classification, 'REAPABLE_PUSHED');
  assert.equal(held.reaped, false);
  assert.equal(getPoolStatus(context)[0].state, 'LEASED');

  // The full sweep reclaims it: every commit is already on origin/<branch>, so
  // releasing loses nothing and the branch (and its PR) survives untouched.
  const result = await reapPool(context, { apply: true });
  const row = result.results.find((r) => r.branch === 'codex/open-pr');
  assert.equal(row.classification, 'REAPABLE_PUSHED');
  assert.equal(row.reaped, true);
  assert.equal(getPoolStatus(context)[0].state, 'AVAILABLE');
  assert.equal(run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/codex/open-pr'], { cwd: context.mainRoot, allowFailure: true }).status, 0);
});

test('reap never frees an unmerged slot whose commits are only local', async () => {
  const context = fixture();
  setupPool(context);
  const lease = await acquireSlot(context, 'codex/never-pushed', { purpose: 'local-only test' });
  writeFileSync(join(lease.path, 'local.txt'), 'local');
  run('git', ['add', 'local.txt'], { cwd: lease.path });
  run('git', ['commit', '-m', 'local-only work'], { cwd: lease.path });

  const result = await reapPool(context, { apply: true });
  const row = result.results.find((r) => r.branch === 'codex/never-pushed');
  assert.equal(row.classification, 'ACTIVE');
  assert.equal(row.reaped, false);
  assert.equal(getPoolStatus(context)[0].state, 'LEASED');
});

test('a drifted lease/checkout pair is reported by reap and freed only with --reconcile-branch', async () => {
  const context = fixture();
  setupPool(context);
  const lease = await acquireSlot(context, 'codex/leased-branch', { purpose: 'drift test' });
  // Simulate the rule violation that parks a slot in BLOCKED forever: someone
  // switches branches INSIDE a leased slot, so lease.branch != checkout branch.
  run('git', ['switch', '-c', 'codex/drifted-branch'], { cwd: lease.path });
  run('git', ['push', '-u', 'origin', 'codex/drifted-branch'], { cwd: lease.path });
  assert.equal(getPoolStatus(context)[0].state, 'BLOCKED');

  // reap surfaces it instead of silently skipping it, and never auto-reaps it.
  const seen = await reapPool(context, { apply: true });
  const row = seen.results.find((r) => r.slot === 'slot-01');
  assert.equal(row.classification, 'REVIEW_DRIFT');
  assert.equal(row.leaseBranch, 'codex/leased-branch');
  assert.equal(row.reaped, false);
  assert.equal(getPoolStatus(context)[0].state, 'BLOCKED');

  // Release still refuses by default...
  assert.throws(() => releaseSlot(context, { cwd: lease.path }), /Lease\/checkout mismatch/);

  // ...and the reconcile path still fails closed on real uncommitted work.
  writeFileSync(join(lease.path, 'dirty.txt'), 'dirty');
  assert.throws(() => releaseSlot(context, { cwd: lease.path, reconcileBranch: true }), /dirty worktree/);
  rmSync(join(lease.path, 'dirty.txt'));

  // Clean + pushed: the checked-out branch is adopted, released, and preserved.
  const result = releaseSlot(context, { cwd: lease.path, reconcileBranch: true });
  assert.equal(result.branch, 'codex/drifted-branch');
  assert.equal(getPoolStatus(context)[0].state, 'AVAILABLE');
  assert.equal(run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/codex/leased-branch'], { cwd: context.mainRoot, allowFailure: true }).status, 0);
  assert.equal(run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/codex/drifted-branch'], { cwd: context.mainRoot, allowFailure: true }).status, 0);
});

test('--reconcile-branch still refuses a drifted slot holding unpushed commits', async () => {
  const context = fixture();
  setupPool(context);
  const lease = await acquireSlot(context, 'codex/leased-two', { purpose: 'drift guard test' });
  run('git', ['switch', '-c', 'codex/drifted-two'], { cwd: lease.path });
  writeFileSync(join(lease.path, 'unpushed.txt'), 'unpushed');
  run('git', ['add', 'unpushed.txt'], { cwd: lease.path });
  run('git', ['commit', '-m', 'unpushed drift work'], { cwd: lease.path });
  assert.throws(() => releaseSlot(context, { cwd: lease.path, reconcileBranch: true }), /unpushed commits/);
  assert.equal(getPoolStatus(context)[0].state, 'BLOCKED');
});

test('reap never detaches a freshly leased, untouched slot', async () => {
  const context = fixture();
  setupPool(context);
  // Fresh lease: HEAD == base == origin/main, clean, tracks origin/main. Its HEAD is
  // trivially an ancestor of main, so without the untouched guard classifySlot would
  // call it merged+in-sync and reapPool --apply would detach it mid-onboarding.
  const lease = await acquireSlot(context, 'codex/just-leased', { purpose: 'fresh lease' });
  const result = await reapPool(context, { apply: true });
  const row = result.results.find((r) => r.branch === 'codex/just-leased');
  assert.equal(row.classification, 'ACTIVE');
  assert.equal(row.reaped, false);
  assert.equal(getPoolStatus(context)[0].state, 'LEASED');
  assert.equal(getPoolStatus(context)[0].branch, lease.branch);
});

test('reap never detaches a slot reacquired at a base/merged tip with no new work', async () => {
  const context = fixture();
  setupPool(context);
  // Build a merged feature branch on the remote (tip is an ancestor of origin/main),
  // then drop the local ref so acquire takes the remote-resume path.
  run('git', ['switch', '-c', 'codex/resumed'], { cwd: context.mainRoot });
  writeFileSync(join(context.mainRoot, 'resumed.txt'), 'resumed');
  run('git', ['add', 'resumed.txt'], { cwd: context.mainRoot });
  run('git', ['commit', '-m', 'resumed feature'], { cwd: context.mainRoot });
  run('git', ['push', '-u', 'origin', 'codex/resumed'], { cwd: context.mainRoot });
  run('git', ['switch', 'main'], { cwd: context.mainRoot });
  run('git', ['merge', '--no-ff', 'codex/resumed', '-m', 'merge codex/resumed'], { cwd: context.mainRoot });
  run('git', ['push', 'origin', 'main'], { cwd: context.mainRoot });
  run('git', ['branch', '-D', 'codex/resumed'], { cwd: context.mainRoot });

  // Reacquire that branch and do NO further work: HEAD == baseCommit. The owner is
  // about to start work, so even though the branch is already merged the slot must
  // NOT be reaped out from under them. never-steal-over-never-leak: this slot leaks
  // until the owner commits work or releases it manually.
  const lease = await acquireSlot(context, 'codex/resumed', { purpose: 'resume merged branch' });
  const result = await reapPool(context, { apply: true });
  const row = result.results.find((r) => r.branch === 'codex/resumed');
  assert.equal(row.classification, 'ACTIVE');
  assert.equal(row.reaped, false);
  assert.equal(getPoolStatus(context)[0].state, 'LEASED');
  assert.equal(getPoolStatus(context)[0].branch, lease.branch);
});

test('reap frees an ancestry-merged slot with a pruned upstream using git-only proof (no gh)', async () => {
  const context = fixture(2, NO_WAIT_POLICY);
  setupPool(context);
  // Fresh-from-base lease that DOES commit work, gets merged into origin/main, then
  // has its upstream branch deleted (pruned). HEAD != baseCommit (touched), no
  // upstream, but HEAD is an ancestor of origin/main — so classifySlot reaps it with
  // no gh, and releaseSlot's git-only ancestor-of-base check clears the unpushed guard.
  const lease = await acquireSlot(context, 'codex/anc-merged', { purpose: 'ancestry merge, pruned upstream' });
  writeFileSync(join(lease.path, 'anc.txt'), 'anc');
  run('git', ['add', 'anc.txt'], { cwd: lease.path });
  run('git', ['commit', '-m', 'feature work'], { cwd: lease.path });
  run('git', ['push', '-u', 'origin', 'codex/anc-merged'], { cwd: lease.path });
  // Merge into origin/main, then delete the remote branch so reap's fetch --prune
  // drops the upstream.
  run('git', ['fetch', 'origin', 'codex/anc-merged'], { cwd: context.mainRoot });
  run('git', ['merge', '--no-ff', 'origin/codex/anc-merged', '-m', 'merge anc'], { cwd: context.mainRoot });
  run('git', ['push', 'origin', 'main'], { cwd: context.mainRoot });
  run('git', ['push', 'origin', '--delete', 'codex/anc-merged'], { cwd: context.mainRoot });

  const result = await reapPool(context, { apply: true });
  const row = result.results.find((r) => r.branch === 'codex/anc-merged');
  assert.equal(row.classification, 'REAPABLE');
  assert.equal(row.reaped, true);
  assert.equal(getPoolStatus(context)[0].state, 'AVAILABLE');
});

test('resource locks reject contention and foreign unlock', async () => {
  const context = fixture();
  setupPool(context);
  const first = await acquireSlot(context, 'codex/first', { purpose: 'first lock owner' });
  const second = await acquireSlot(context, 'codex/second', { purpose: 'second lock owner' });
  acquireResourceLock(context, 'runtime', { cwd: first.path });
  assert.throws(() => releaseSlot(context, { cwd: first.path }), /holding shared lock/);
  assert.throws(() => acquireResourceLock(context, 'runtime', { cwd: second.path }), /already leased/);
  assert.throws(() => releaseResourceLock(context, 'runtime', { cwd: second.path }), /refusing foreign unlock/);
  assert.equal(releaseResourceLock(context, 'runtime', { cwd: first.path }).slot, 'slot-01');
});

test('allocation lock: never waits on its own process, waits then fails on a busy one, breaks a dead one', async () => {
  const context = fixture();
  const lock = join(context.stateRoot, 'locks', 'allocation');
  const hold = (owner) => {
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'owner.json'), JSON.stringify(owner));
  };

  // This process already holds it: waiting would deadlock, so it fails at once.
  hold({ pid: process.pid, acquiredAt: new Date().toISOString() });
  assert.throws(() => withPoolLock(context, () => {}), /pool lock is busy/);
  rmSync(lock, { recursive: true });

  // A dead holder that is fresh is not stale yet: the caller waits the allowed time, then fails with the holder named.
  hold({ pid: 2147483647, owner: 'ghost-session', acquiredAt: new Date().toISOString() });
  const started = Date.now();
  assert.throws(() => withNamedLock(context, 'allocation', () => {}, { waitMs: 300 }), /pool lock is busy.*ghost-se/);
  assert.ok(Date.now() - started >= 280, 'it waited for the lock before failing');
  assert.throws(() => recoverInternalLock(context, 'allocation'), /requires --force/);
  assert.equal(recoverInternalLock(context, 'allocation', { force: true }).pid, 2147483647);
  assert.doesNotThrow(() => withPoolLock(context, () => {}));

  // A dead holder older than 30 s is a crash leftover: it is broken without a human.
  hold({ pid: 2147483647, acquiredAt: new Date(Date.now() - 120_000).toISOString() });
  assert.doesNotThrow(() => withPoolLock(context, () => {}));
});

test('dependency hash changes with tracked manifests and runtime ABI inputs', async () => {
  const context = fixture(1);
  setupPool(context);
  const lease = await acquireSlot(context, 'codex/hash-test', { purpose: 'hash test' });
  const before = computeDependencyHash(context, 1);
  writeFileSync(join(lease.path, 'package.json'), '{"name":"fixture","packageManager":"pnpm@10.28.1","dependencies":{"x":"1.0.0"}}\n');
  const after = computeDependencyHash(context, 1);
  assert.notEqual(after, before);
});

test('prepare runs the configured command once, then skips until the inputs change', async () => {
  const context = fixture(1);
  context.config.prepare = {
    command: ['node', '-e', "require('fs').mkdirSync('node_modules',{recursive:true})"],
    outputs: ['node_modules'],
  };
  setupPool(context);
  const lease = await acquireSlot(context, 'codex/prep-test', { purpose: 'prepare test' });
  const first = prepareSlot(context, { cwd: lease.path });
  assert.equal(first.installed, true);
  assert.equal(prepareSlot(context, { cwd: lease.path }).installed, false);
  writeFileSync(join(lease.path, 'package.json'), '{"name":"fixture","dependencies":{"x":"1.0.0"}}\n');
  assert.equal(prepareSlot(context, { cwd: lease.path }).installed, true);
  context.config.prepare = { command: null };
  assert.match(prepareSlot(context, { cwd: lease.path }).reason, /no install command/);
});
