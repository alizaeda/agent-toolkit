// Shared fixture for pool tests: a bare "remote", a main checkout and a pool directory next to it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadContext, run } from '../pool-lib.mjs';

// No real transcripts, no waiting on locks: tests must not depend on the machine they run on.
process.env.WT_LOCK_WAIT_MS = '0';
process.env.WT_CLAUDE_PROJECTS_DIR = join(tmpdir(), 'pool-wt-no-claude-projects');
process.env.WT_CODEX_SESSIONS_DIR = join(tmpdir(), 'pool-wt-no-codex-sessions');

export const HOUR = 60 * 60 * 1000;
// Every liveness window at zero: a slot that is finished is reclaimable at once. Tests of the gates use none.
export const NO_WAIT_POLICY = {
  landedIdleMinutes: 0,
  finishedIdleMinutes: 0,
  finishedIdleMinutesFull: 0,
  endedGraceMinutes: 0,
  blockedIdleMinutes: 0,
};

const roots = [];

export function fixture(slotCount = 2, policy = undefined) {
  const root = mkdtempSync(join(tmpdir(), 'pool-wt-pool-'));
  roots.push(root);
  const remote = join(root, 'remote.git');
  const main = join(root, 'main');
  const pool = join(root, 'pool');
  mkdirSync(main);
  run('git', ['init', '--bare', remote], { cwd: root });
  run('git', ['init'], { cwd: main });
  run('git', ['config', 'user.email', 'test@example.com'], { cwd: main });
  run('git', ['config', 'user.name', 'Pool Test'], { cwd: main });
  writeFileSync(join(main, 'package.json'), '{"name":"fixture","packageManager":"pnpm@10.28.1"}\n');
  writeFileSync(join(main, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  const config = { version: 1, slotCount, poolDirectory: '../pool', baseRef: 'origin/main', slotPrefix: 'slot-' };
  if (policy) config.policy = policy;
  writeFileSync(join(main, 'worktree-pool.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  run('git', ['add', '.'], { cwd: main });
  run('git', ['commit', '-m', 'initial'], { cwd: main });
  run('git', ['branch', '-M', 'main'], { cwd: main });
  run('git', ['remote', 'add', 'origin', remote], { cwd: main });
  run('git', ['push', '-u', 'origin', 'main'], { cwd: main });
  return loadContext(main, { mainRoot: main, poolRoot: pool });
}

export function cleanupFixtures() {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

export function commitFile(path, name, content = name, message = `add ${name}`) {
  writeFileSync(join(path, name), content);
  run('git', ['add', name], { cwd: path });
  run('git', ['commit', '-m', message], { cwd: path });
  return run('git', ['rev-parse', 'HEAD'], { cwd: path }).stdout;
}

export function branchExists(context, branch) {
  return run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: context.mainRoot, allowFailure: true }).status === 0;
}
