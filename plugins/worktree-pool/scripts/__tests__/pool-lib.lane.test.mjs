import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { acquireRuntimeLane, doctorPool, releaseRuntimeLane } from '../pool-lib.mjs';

// Minimal fake context + lease so the allocator can run without a real worktree.
function makeContext() {
  const stateRoot = mkdtempSync(join(tmpdir(), 'pool-lane-'));
  mkdirSync(join(stateRoot, 'locks'), { recursive: true });
  return { stateRoot, config: { slotCount: 10 } };
}
const fakeLease = { slot: 'slot-01', token: 'tok-1', owner: 'test' };

let ctx;
beforeEach(() => {
  ctx = makeContext();
});
afterEach(() => {
  rmSync(ctx.stateRoot, { recursive: true, force: true });
});

test('hands out the lowest free lane and refuses past the cap', () => {
  const a = acquireRuntimeLane(ctx, { cap: 2, lease: fakeLease });
  const b = acquireRuntimeLane(ctx, { cap: 2, lease: fakeLease });
  assert.deepEqual([a.lane, b.lane].sort(), [1, 2]);
  assert.throws(() => acquireRuntimeLane(ctx, { cap: 2, lease: fakeLease }), /No free runtime lane/);
});

test('release frees the lane for reuse', () => {
  const a = acquireRuntimeLane(ctx, { cap: 2, lease: fakeLease });
  releaseRuntimeLane(ctx, { lane: a.lane, lease: fakeLease });
  const c = acquireRuntimeLane(ctx, { cap: 2, lease: fakeLease });
  assert.equal(c.lane, a.lane);
});

test('refuses to release a lane owned by a different lease token', () => {
  const a = acquireRuntimeLane(ctx, { cap: 2, lease: fakeLease });
  const foreignLease = { slot: 'slot-02', token: 'tok-2', owner: 'other' };
  assert.throws(
    () => releaseRuntimeLane(ctx, { lane: a.lane, lease: foreignLease }),
    /foreign unlock/,
  );
  // The lane must still be held after the refused foreign unlock.
  assert.throws(
    () => {
      acquireRuntimeLane(ctx, { cap: 1, lease: fakeLease });
    },
    /No free runtime lane/,
  );
});

test('refuses to release a held lane when the resolved slot has no lease (fail-closed)', () => {
  const a = acquireRuntimeLane(ctx, { cap: 2, lease: fakeLease });
  // Mirrors the exploit: `unlane --lane 1 --slot 9` from an idle slot with no
  // lease file. Previously freed another slot's live lane; must now fail closed.
  assert.throws(
    () => releaseRuntimeLane(ctx, { lane: a.lane, slot: 9 }),
    /foreign unlock/,
  );
});

test('doctor flags an orphaned lane whose owning slot has no matching lease', () => {
  const dir = join(ctx.stateRoot, 'locks', 'runtime-lane-1');
  mkdirSync(dir, { recursive: true });
  // Owner PID here would be a long-dead ephemeral `lane` command even for
  // a perfectly healthy lane, so doctor must not use PID liveness for lanes
  // — only whether the owning slot still holds a lease with the same token.
  writeFileSync(
    join(dir, 'owner.json'),
    JSON.stringify({ lane: 1, slot: 'slot-01', token: 'tok-A', pid: 999999 }),
  );
  const result = doctorPool({ ...ctx, config: { slotCount: 0 } });
  assert.match(result.errors.join('\n'), /runtime-lane-1: orphaned lane/);
});

test('doctor flags an orphaned lane when the owning slot lease token no longer matches', () => {
  const dir = join(ctx.stateRoot, 'locks', 'runtime-lane-1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'owner.json'), JSON.stringify({ lane: 1, slot: 'slot-01', token: 'tok-A' }));
  const leasesDir = join(ctx.stateRoot, 'leases');
  mkdirSync(leasesDir, { recursive: true });
  writeFileSync(join(leasesDir, 'slot-01.json'), JSON.stringify({ slot: 'slot-01', branch: 'x', token: 'tok-B' }));
  const result = doctorPool({ ...ctx, config: { slotCount: 0 } });
  assert.match(result.errors.join('\n'), /runtime-lane-1: orphaned lane/);
});

// The documented `unlane` (run with no --lane from inside the
// leased slot) previously required the caller to already know the lane
// number. It should instead resolve the lane this slot's lease is holding.
test('releaseRuntimeLane with no lane resolves and releases the lane held by the given lease', () => {
  const a = acquireRuntimeLane(ctx, { cap: 2, lease: fakeLease });
  const released = releaseRuntimeLane(ctx, { lease: fakeLease });
  assert.equal(released.lane, a.lane);
  // Freed for reuse — proves the lock directory was actually removed.
  const c = acquireRuntimeLane(ctx, { cap: 2, lease: fakeLease });
  assert.equal(c.lane, a.lane);
});

test('releaseRuntimeLane with no lane held by the lease throws a clear error', () => {
  assert.throws(
    () => releaseRuntimeLane(ctx, { lease: fakeLease }),
    /No runtime lane held by this slot/,
  );
});

// An orphaned lane (doctor's exact scenario: owner.json present, no matching
// slot lease) must be reclaimable via the printed `--force` hint, and must
// still refuse a normal (non-force) release.
test('an orphaned lane is released by releaseRuntimeLane with force, and still refuses without force', () => {
  const dir = join(ctx.stateRoot, 'locks', 'runtime-lane-1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'owner.json'), JSON.stringify({ lane: 1, slot: 'slot-01', token: 'tok-A' }));
  // No leases/slot-01.json at all — the owning slot's lease is simply gone,
  // exactly what makes doctorPool classify this lane as orphaned.

  assert.throws(
    () => releaseRuntimeLane(ctx, { lane: 1, slot: 1 }),
    /foreign unlock/,
  );

  const released = releaseRuntimeLane(ctx, { lane: 1, force: true });
  assert.equal(released.lane, 1);

  // Freed for reuse — proves the lock directory was actually removed.
  const c = acquireRuntimeLane(ctx, { cap: 2, lease: fakeLease });
  assert.equal(c.lane, 1);
});

test('doctor does not flag a lane whose owning slot still holds a matching lease', () => {
  const dir = join(ctx.stateRoot, 'locks', 'runtime-lane-1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'owner.json'), JSON.stringify({ lane: 1, slot: 'slot-01', token: 'tok-A' }));
  const leasesDir = join(ctx.stateRoot, 'leases');
  mkdirSync(leasesDir, { recursive: true });
  writeFileSync(join(leasesDir, 'slot-01.json'), JSON.stringify({ slot: 'slot-01', branch: 'x', token: 'tok-A' }));
  const result = doctorPool({ ...ctx, config: { slotCount: 0 } });
  assert.equal(result.errors.some((error) => error.includes('runtime-lane-1')), false);
});
