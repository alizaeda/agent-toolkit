import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// pool-session runs on Claude Code `Stop` (heartbeat every owned lease) and
// `SessionEnd` (write an `ended/<session>.json` marker when the session owns a
// lease). It must always exit 0. These tests build a fake main checkout with a
// pool config and a few leases beside it.

const hookPath = fileURLToPath(new URL('../pool-session.cjs', import.meta.url));

const OWN = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-8888-4777-8666-555555555555';
const OWN_TOKEN = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER_TOKEN = 'bbbbbbbb-0000-4000-8000-000000000002';

let scratch;
let root;
let stateRoot;

const cleanEnv = (extra = {}) => {
  const env = { ...process.env };
  for (const k of ['WT_OWNER', 'CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID']) delete env[k];
  return { ...env, ...extra };
};

function run(payload, { cwd = root, env = cleanEnv() } = {}) {
  return spawnSync(process.execPath, [hookPath], {
    cwd,
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 30_000,
    env,
  });
}

const heartbeat = (token) => path.join(stateRoot, 'heartbeats', token);
const marker = (owner) => path.join(stateRoot, 'ended', `${owner}.json`);

before(() => {
  scratch = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'pool-session-')));
  root = path.join(scratch, 'main-repo');
  const poolRoot = path.join(scratch, 'pool-worktrees');
  stateRoot = path.join(poolRoot, '.pool');
  mkdirSync(path.join(root, '.git'), { recursive: true });
  mkdirSync(path.join(stateRoot, 'leases'), { recursive: true });
  writeFileSync(
    path.join(root, 'worktree-pool.config.json'),
    JSON.stringify({ version: 1, slotCount: 3, poolDirectory: '../pool-worktrees', baseRef: 'origin/main', slotPrefix: 'slot-' }),
  );
  const lease = (slot, owner, token) =>
    writeFileSync(
      path.join(stateRoot, 'leases', `${slot}.json`),
      JSON.stringify({ version: 1, token, slot, path: path.join(poolRoot, slot), branch: `feat/${slot}`, owner, acquiredAt: '2026-10-16T00:00:00.000Z' }),
    );
  lease('slot-01', OWN, OWN_TOKEN);
  lease('slot-02', OTHER, OTHER_TOKEN);
  writeFileSync(path.join(stateRoot, 'leases', 'slot-03.json'), '{not json');
});

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('Stop', () => {
  test('touches the heartbeat of every lease the session owns, and no other', () => {
    const result = run({ hook_event_name: 'Stop', session_id: OWN, stop_hook_active: false });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(heartbeat(OWN_TOKEN)), 'own heartbeat created');
    assert.ok(!existsSync(heartbeat(OTHER_TOKEN)), 'foreign heartbeat untouched');
  });

  test('updates the mtime of an existing heartbeat', () => {
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(heartbeat(OWN_TOKEN), old, old);
    assert.equal(run({ hook_event_name: 'Stop', session_id: OWN }).status, 0);
    assert.ok(statSync(heartbeat(OWN_TOKEN)).mtimeMs > old.getTime() + 60_000);
  });

  test('matches the owner through the transcript file name and env too', () => {
    rmSync(heartbeat(OWN_TOKEN), { force: true });
    assert.equal(run({ hook_event_name: 'Stop', transcript_path: path.join(scratch, `rollout-2026-10-16T10-00-00-${OWN}.jsonl`) }).status, 0);
    assert.ok(existsSync(heartbeat(OWN_TOKEN)), 'codex rollout name');

    rmSync(heartbeat(OWN_TOKEN), { force: true });
    assert.equal(run({ hook_event_name: 'Stop', session_id: 'x' }, { env: cleanEnv({ WT_OWNER: OWN }) }).status, 0);
    assert.ok(existsSync(heartbeat(OWN_TOKEN)), 'WT_OWNER');
  });

  test('a session with no lease writes nothing and exits 0', () => {
    const result = run({ hook_event_name: 'Stop', session_id: 'cccccccc-0000-4000-8000-000000000003' });
    assert.equal(result.status, 0);
    assert.ok(!existsSync(heartbeat(OTHER_TOKEN)));
  });
});

describe('SessionEnd', () => {
  test('writes the ended marker only for a session that owns a lease', () => {
    const result = run({ hook_event_name: 'SessionEnd', session_id: OWN, reason: 'prompt_input_exit' });
    assert.equal(result.status, 0, result.stderr);
    const written = JSON.parse(readFileSync(marker(OWN), 'utf8'));
    assert.equal(written.owner, OWN);
    assert.equal(written.reason, 'prompt_input_exit');
    assert.ok(!Number.isNaN(Date.parse(written.endedAt)));

    const stranger = 'dddddddd-0000-4000-8000-000000000004';
    assert.equal(run({ hook_event_name: 'SessionEnd', session_id: stranger, reason: 'clear' }).status, 0);
    assert.ok(!existsSync(marker(stranger)));
  });

  test('takes the session id from a Claude transcript file name', () => {
    rmSync(marker(OWN), { force: true });
    assert.equal(run({ hook_event_name: 'SessionEnd', transcript_path: path.join(scratch, 'projects', 'p', `${OWN}.jsonl`), reason: 'logout' }).status, 0);
    assert.equal(JSON.parse(readFileSync(marker(OWN), 'utf8')).reason, 'logout');
  });
});

describe('never fails the host', () => {
  test('malformed input, no event name and an unknown event exit 0', () => {
    assert.equal(run('{not json').status, 0);
    assert.equal(run('null').status, 0);
    assert.equal(run({ session_id: OWN }).status, 0);
    assert.equal(run({ hook_event_name: 'PreToolUse', session_id: OWN }).status, 0);
  });

  test('exits 0 when there is no pool config or no .git above cwd', () => {
    const bare = path.join(scratch, 'bare-repo');
    mkdirSync(path.join(bare, '.git'), { recursive: true });
    assert.equal(run({ hook_event_name: 'Stop', session_id: OWN }, { cwd: bare }).status, 0);
    const outside = path.join(scratch, 'not-a-repo');
    mkdirSync(outside, { recursive: true });
    assert.equal(run({ hook_event_name: 'SessionEnd', session_id: OWN, reason: 'other' }, { cwd: outside }).status, 0);
  });

  test('exits 0 when the pool config points at a missing pool', () => {
    const lonely = path.join(scratch, 'lonely');
    mkdirSync(path.join(lonely, '.git'), { recursive: true });
    writeFileSync(path.join(lonely, 'worktree-pool.config.json'), JSON.stringify({ version: 1, slotCount: 1, poolDirectory: '../no-such-pool' }));
    assert.equal(run({ hook_event_name: 'Stop', session_id: OWN }, { cwd: lonely }).status, 0);
  });
});
