// Save everything an abandoned slot holds BEFORE the pool frees it.
//
// The work tree is committed to a local branch `salvage/<slot>-<time>` using a temporary index,
// so the live index and the files are not touched while the snapshot is built. The snapshot is
// verified against the work tree. Only then is the slot cleaned. Ignored files (node_modules,
// .env, caches) are not part of the snapshot and stay in the slot.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WT, run } from './exec.mjs';

function stamp(now) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

/** Returns null when the work tree is clean, else { ref, commit, dir, files }. Throws before cleaning anything it could not save. */
export function salvageSlot({ stateRoot, slot, path, lease = null, now = new Date(), reason = 'takeover' }) {
  const porcelain = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: path }).stdout;
  if (!porcelain) return null;

  const name = `${slot}-${stamp(now)}`;
  const dir = join(stateRoot, 'salvage', name);
  mkdirSync(dir, { recursive: true });
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index.tmp') };

  let ref = `salvage/${name}`;
  for (let attempt = 2; run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${ref}`], { cwd: path, allowFailure: true }).status === 0; attempt += 1) {
    ref = `salvage/${name}-${attempt}`;
  }

  run('git', ['read-tree', 'HEAD'], { cwd: path, env });
  run('git', ['add', '-A'], { cwd: path, env });
  const tree = run('git', ['write-tree'], { cwd: path, env }).stdout;
  const message = `salvage: ${slot} ${lease?.branch ?? 'unleased'} (${reason}, owner ${lease?.owner ?? 'unknown'})`;
  const commit = run(
    'git',
    ['-c', 'user.name=Pool Salvage', '-c', 'user.email=pool-salvage@localhost', 'commit-tree', tree, '-p', 'HEAD', '-m', message],
    { cwd: path, env },
  ).stdout;
  run('git', ['update-ref', `refs/heads/${ref}`, commit], { cwd: path });

  // Verify before cleaning: the snapshot must equal the work tree, tracked and untracked alike.
  const same = run('git', ['diff', '--quiet', commit, '--'], { cwd: path, env, allowFailure: true });
  const stored = run('git', ['rev-parse', `refs/heads/${ref}`], { cwd: path, allowFailure: true }).stdout;
  if (same.status !== 0 || stored !== commit) {
    run('git', ['update-ref', '-d', `refs/heads/${ref}`], { cwd: path, allowFailure: true });
    throw new Error(`Salvage of ${slot} could not be verified; nothing was cleaned`);
  }

  writeFileSync(join(dir, 'status.txt'), `${porcelain}\n`);
  writeFileSync(join(dir, 'lease.json'), `${JSON.stringify(lease, null, 2)}\n`);
  writeFileSync(
    join(dir, 'README.txt'),
    [
      `Saved from ${slot} on ${now.toISOString()} (${reason}).`,
      `Branch ${ref} holds a commit of every uncommitted and untracked file.`,
      `Resume: ${WT} acquire ${ref} --purpose "recover ${slot}"`,
      'Discard: only with the owner\'s approval (git branch -D).',
      '',
    ].join('\n'),
  );

  // Clean: tracked changes and untracked, non-ignored files. Never -x: ignored files stay.
  run('git', ['reset', '--hard', 'HEAD'], { cwd: path });
  run('git', ['clean', '-fd'], { cwd: path });
  const left = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: path }).stdout;
  if (left) throw new Error(`Salvage of ${slot} saved ${ref} but the work tree is not clean:\n${left}`);

  return { ref, commit, dir, files: porcelain.split(/\r?\n/).filter(Boolean).length };
}
