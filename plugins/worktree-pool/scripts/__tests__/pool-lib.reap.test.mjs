import assert from 'node:assert/strict';
import test from 'node:test';

import { classifySlot } from '../pool-lib.mjs';

// A leased slot whose work is fully done: clean tree, fully in sync with
// upstream (nothing to push, nothing to pull), merged to origin/main.
const done = { state: 'LEASED', dirty: false, hasUpstream: true, unpushed: 0, behind: 0, merged: true };

test('reaps a clean + in-sync + merged slot', () => {
  assert.equal(classifySlot(done), 'REAPABLE');
});

test('never touches a non-leased slot', () => {
  assert.equal(classifySlot({ ...done, state: 'AVAILABLE' }), 'SKIP');
  assert.equal(classifySlot({ ...done, state: 'BLOCKED' }), 'SKIP');
  assert.equal(classifySlot({ ...done, state: 'MISSING' }), 'SKIP');
});

test('merged but dirty -> review, never auto-reap', () => {
  assert.equal(classifySlot({ ...done, dirty: true }), 'REVIEW_MERGED_DIRTY');
});

test('merged but has unpushed commits -> review', () => {
  assert.equal(classifySlot({ ...done, unpushed: 3 }), 'REVIEW_MERGED_DIRTY');
});

test('merged but BEHIND upstream (remote has newer commits) -> review, never reaped', () => {
  assert.equal(classifySlot({ ...done, behind: 2 }), 'REVIEW_MERGED_DIRTY');
});

// merged is git-/gh-proven (ancestor of origin/main, or a merged PR head == HEAD),
// so a clean merged slot with no upstream (branch pruned on merge) has no feature
// drift and is reapable — releaseSlot re-proves integration before detaching.
test('merged + clean + no upstream tracking -> REAPABLE (proof does not need upstream)', () => {
  assert.equal(classifySlot({ ...done, hasUpstream: false }), 'REAPABLE');
});

// r7 P2#1: an ancestry/rebase-merged slot that still tracks origin/main is proven
// done by git ancestry alone. origin/main advancing makes behind>0, but that is base
// lag (upstreamIsBase), not feature work — so it reaps with NO gh lookup required.
test('ancestry-merged, tracks origin/main, base lag, no prMerge -> REAPABLE (no gh)', () => {
  assert.equal(
    classifySlot({ state: 'LEASED', dirty: false, hasUpstream: true, upstreamIsBase: true, unpushed: 0, behind: 4, merged: true, prMerged: false }),
    'REAPABLE',
  );
});

// An open PR does not hold a slot. Every commit is on origin/<branch> and
// releasing preserves the branch, so nothing is lost — it is reclaimable, just in
// a weaker class than a merged slot.
test('pushed + clean + unmerged (open PR) -> REAPABLE_PUSHED, not held', () => {
  assert.equal(classifySlot({ ...done, merged: false }), 'REAPABLE_PUSHED');
});

test('unmerged with unpushed work -> active, leave alone', () => {
  assert.equal(classifySlot({ ...done, merged: false, unpushed: 5 }), 'ACTIVE');
});

// behind>0 means origin/<branch> carries commits this worktree does not have —
// those are already safe on the remote, so they are not a reason to hold the slot.
test('unmerged + behind its own feature upstream -> REAPABLE_PUSHED', () => {
  assert.equal(classifySlot({ ...done, merged: false, behind: 4 }), 'REAPABLE_PUSHED');
});

// The one unmerged shape that MUST stay held: the slot never pushed a feature
// branch, so it still tracks origin/main and its commits exist nowhere but here.
test('unmerged + clean but still tracking origin/main -> ACTIVE (commits are local-only)', () => {
  assert.equal(
    classifySlot({ ...done, merged: false, upstreamIsBase: true, unpushed: 3 }),
    'ACTIVE',
  );
  assert.equal(
    classifySlot({ ...done, merged: false, upstreamIsBase: true, unpushed: 0 }),
    'ACTIVE',
  );
});

test('unmerged + clean + no upstream at all -> ACTIVE (nothing proves the work is safe)', () => {
  assert.equal(classifySlot({ ...done, merged: false, hasUpstream: false }), 'ACTIVE');
});

test('unmerged + fully pushed but DIRTY -> ACTIVE (uncommitted work would be stranded)', () => {
  assert.equal(classifySlot({ ...done, merged: false, dirty: true }), 'ACTIVE');
});

// The untouched guard outranks the new class too: a freshly leased slot must not
// be reaped out from under the owner who just took it.
test('untouched fresh lease on a pushed branch -> ACTIVE', () => {
  assert.equal(classifySlot({ ...done, merged: false, untouched: true }), 'ACTIVE');
});

test('unmerged + dirty + no upstream -> active', () => {
  assert.equal(
    classifySlot({ state: 'LEASED', dirty: true, hasUpstream: false, unpushed: 0, behind: 0, merged: false }),
    'ACTIVE',
  );
});

// The leak this fix closes: a GitHub squash-merge is not a git ancestor of main,
// so ancestry alone reports `merged: false`. slotGitFacts now folds a merged-PR
// signal into `merged`, so a clean + in-sync squash-merged slot reaches REAPABLE
// exactly like an ancestry-merged one.
test('squash-merged PR (merged via PR signal) + clean + in-sync -> REAPABLE', () => {
  assert.equal(classifySlot({ ...done, merged: true }), 'REAPABLE');
});

// A squash-merged slot with leftover uncommitted edits (the orphaned-codex-slot
// case) is still surfaced for review and never auto-reaped.
test('merged PR but dirty tree -> review, never auto-reap', () => {
  assert.equal(classifySlot({ ...done, merged: true, dirty: true }), 'REVIEW_MERGED_DIRTY');
});

// SHA-verified PR-merge (local HEAD == the merged PR head commit) is safe to reap
// even when GitHub deleted the head branch on merge and the upstream ref was
// pruned (hasUpstream=false). The SHA match substitutes for the in-sync check.
test('SHA-verified merged PR + clean + no upstream (branch deleted on merge) -> REAPABLE', () => {
  assert.equal(
    classifySlot({ state: 'LEASED', dirty: false, hasUpstream: false, unpushed: 0, behind: 0, merged: true, prMerged: true }),
    'REAPABLE',
  );
});

// But a SHA-verified merge whose live upstream advanced past HEAD (behind>0) still
// defers — those remote commits could be a new round of work on the branch.
test('SHA-verified merged PR but upstream ahead (behind>0) -> review, never reaped', () => {
  assert.equal(
    classifySlot({ ...done, merged: true, prMerged: true, behind: 2 }),
    'REVIEW_MERGED_DIRTY',
  );
});

// A freshly-leased slot sits at HEAD == its lease base commit == origin/main, which
// is trivially an ancestor of main (merged=true). Without the untouched guard,
// auto-reap-on-acquire would detach it out from under an owner who just leased it or
// is mid `prepare`. It must stay ACTIVE until real work is committed.
test('untouched fresh lease (HEAD == base) -> ACTIVE even though ancestor-of-main', () => {
  assert.equal(
    classifySlot({ state: 'LEASED', dirty: false, hasUpstream: true, upstreamIsBase: true, unpushed: 0, behind: 0, merged: true, untouched: true }),
    'ACTIVE',
  );
});

// A slot that never pushed its own feature branch still tracks origin/main, so once
// its PR merges and origin/main advances, unpushed/behind reflect base movement, not
// unreaped work. A SHA-verified prMerge must still reap despite that base lag.
test('SHA-verified merged PR with base-branch lag (tracks origin/main) -> REAPABLE', () => {
  assert.equal(
    classifySlot({ state: 'LEASED', dirty: false, hasUpstream: true, upstreamIsBase: true, unpushed: 5, behind: 3, merged: true, prMerged: true }),
    'REAPABLE',
  );
});
