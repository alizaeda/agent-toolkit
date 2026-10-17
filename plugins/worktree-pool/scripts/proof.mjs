// Git proofs the pool uses to decide that releasing a slot loses nothing.
//
// Releasing a slot only detaches the worktree: the branch ref and every commit on it survive in
// the shared repository. What can really be lost is (a) uncommitted files, (b) commits made on a
// detached HEAD, and (c) the only copy of work when the disk dies. These proofs answer (c) and
// "did this work already reach main?" without asking anyone.
import { run } from './exec.mjs';

/**
 * Commits reachable from HEAD but from no remote-tracking branch, i.e. work that exists only on this
 * disk. It does not matter which remote branch holds them, so a PR branch pushed under another name,
 * or a branch that still tracks origin/main, is judged correctly. null = could not be computed.
 */
export function unpushedCommitCount(path) {
  const result = run('git', ['rev-list', '--count', 'HEAD', '--not', '--remotes'], { cwd: path, allowFailure: true });
  if (result.status !== 0) return null;
  const count = Number(result.stdout);
  return Number.isFinite(count) ? count : null;
}

const CONTENT_CHUNK = 150;
const CONTENT_FILE_LIMIT = 3000;

/**
 * Has this HEAD's work already reached `baseRef`? Returns how it was proved, or null.
 *   ancestor  HEAD is an ancestor of baseRef (merge or rebase merge).
 *   cherry    every commit has an equivalent patch on baseRef (cherry-pick, rebase).
 *   content   every file the branch changed is identical on baseRef (squash merge).
 *   empty     the branch changes nothing against its merge-base.
 * A merged-PR head match (needs gh) is checked by the caller.
 */
export function landedVia(path, baseRef) {
  const ancestor = run('git', ['merge-base', '--is-ancestor', 'HEAD', baseRef], { cwd: path, allowFailure: true });
  if (ancestor.status === 0) return 'ancestor';

  const cherry = run('git', ['cherry', baseRef, 'HEAD'], { cwd: path, allowFailure: true });
  if (cherry.status === 0) {
    const lines = cherry.stdout.split(/\r?\n/).filter(Boolean);
    if (lines.length > 0 && lines.every((line) => line.startsWith('-'))) return 'cherry';
  }

  const base = run('git', ['merge-base', baseRef, 'HEAD'], { cwd: path, allowFailure: true });
  if (base.status !== 0 || !base.stdout) return null;
  // --no-renames lists both sides of a rename, so a deleted old path is checked too.
  const names = run('git', ['diff', '--no-renames', '--name-only', base.stdout, 'HEAD'], { cwd: path, allowFailure: true });
  if (names.status !== 0) return null;
  const files = names.stdout.split(/\r?\n/).filter(Boolean);
  if (files.length === 0) return 'empty';
  if (files.length > CONTENT_FILE_LIMIT) return null;
  for (let index = 0; index < files.length; index += CONTENT_CHUNK) {
    const chunk = files.slice(index, index + CONTENT_CHUNK);
    const same = run('git', ['diff', '--quiet', baseRef, 'HEAD', '--', ...chunk], { cwd: path, allowFailure: true });
    if (same.status !== 0) return null;
  }
  return 'content';
}
