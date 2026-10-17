import { spawnSync } from 'node:child_process';
import { normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The pool CLI, as a command line. Messages print it so a user or agent can paste the next step. */
export const WT = `node "${fileURLToPath(new URL('./pool.mjs', import.meta.url))}"`;

export function normalizedPath(value) {
  return normalize(resolve(value)).toLowerCase();
}

export function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env ?? process.env,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeout,
    shell: Boolean(options.shell),
  });

  if (result.error) {
    // A timeout or spawn failure is a failure the caller may want to survive (a fetch on a bad network).
    if (options.allowFailure) return { status: 1, stdout: '', stderr: result.error.message };
    throw new Error(`Could not run ${command}: ${result.error.message}`);
  }

  const stdout = result.stdout?.trim() ?? '';
  const stderr = result.stderr?.trim() ?? '';
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error([`Command failed: ${command} ${args.join(' ')}`, stderr, stdout].filter(Boolean).join('\n'));
  }

  return { status: result.status ?? 1, stdout, stderr };
}

/** Blocks the thread without burning CPU. Pool commands are synchronous, so waiting is synchronous too. */
export function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}
