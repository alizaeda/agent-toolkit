#!/usr/bin/env node
import {
  acquireResourceLock,
  acquireRuntimeLane,
  acquireSlot,
  assertSlot,
  doctorPool,
  formatDuration,
  getPoolStatus,
  loadContext,
  prepareSlot,
  reapPool,
  recoverInternalLock,
  releaseResourceLock,
  releaseRuntimeLane,
  releaseSlot,
  setupPool,
  shortOwner,
  switchSlot,
  takeoverSlot,
  WT,
  touchOwnHeartbeat,
} from './pool-lib.mjs';
import { leaseActivity } from './liveness.mjs';

function parseArgs(values) {
  const positional = [];
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--') continue;
    if (!value.startsWith('--')) positional.push(value);
    else {
      const key = value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      const next = values[index + 1];
      // Flags that never take a value, so `--apply <next-positional>` cannot swallow an argument.
      if (next && !next.startsWith('--') && !BOOLEAN_FLAGS.has(key)) {
        options[key] = next;
        index += 1;
      } else options[key] = true;
    }
  }
  return { positional, options };
}

const BOOLEAN_FLAGS = new Set([
  'apply', 'adopt', 'dryRun', 'fix', 'json', 'long', 'noFetch', 'noTakeover', 'ownerApproved', 'prepare',
  'allowUnpushed', 'allowUntouched', 'reconcileBranch', 'force',
]);

function leaseLine(context, row, now) {
  if (!row.lease) return row.detail;
  const activity = leaseActivity({ now, lease: row.lease, stateRoot: context.stateRoot });
  const age = formatDuration(now - Date.parse(row.lease.acquiredAt));
  const ended = activity.ownerEnded ? ' ended' : '';
  return `${shortOwner(row.lease.owner)}  age ${age}  idle ${formatDuration(activity.idleMs)}${ended}  ${row.lease.purpose ? `- ${row.lease.purpose}` : ''}`.trimEnd();
}

function printRows(context, rows) {
  const now = Date.now();
  for (const row of rows) {
    const detail = row.state === 'LEASED' ? leaseLine(context, row, now) : row.detail;
    console.log(`${row.slot.padEnd(8)} ${row.state.padEnd(9)} ${(row.branch ?? '-').padEnd(42)} ${detail}`.trimEnd());
  }
}

async function printLong(context, rows) {
  const result = await reapPool(context, { apply: false });
  const now = Date.now();
  for (const row of rows) {
    const found = result.results.find((r) => r.number === row.number);
    const detail = row.state === 'LEASED' ? leaseLine(context, row, now) : row.detail;
    const facts = found && found.classification !== 'SKIP'
      ? `  [${found.classification} dirty=${found.dirty ? found.dirtyCount : 0} local-only=${found.localOnly ?? '?'} landed=${found.landedVia ?? 'no'}]`
      : '';
    console.log(`${row.slot.padEnd(8)} ${row.state.padEnd(9)} ${(row.branch ?? '-').padEnd(42)} ${detail}${facts}`.trimEnd());
  }
}

function printReap(result) {
  const label = {
    REAPABLE: result.apply ? 'released' : 'free: landed/quiet',
    REAPABLE_PUSHED: result.apply ? 'released (pushed, PR may be open)' : 'free: fully pushed, quiet',
    REAPABLE_BLOCKED: result.apply ? 'repaired' : 'repairable: clean+pushed',
    TAKEOVER: result.apply ? 'taken over (state saved)' : 'abandoned: takeover saves state',
    REVIEW_MERGED_DIRTY: 'review: landed, has local changes',
    REVIEW_DRIFT: 'BLOCKED: lease/checkout drift',
    REVIEW_UNLEASED: 'BLOCKED: unleased branch',
    ACTIVE: 'keep',
    SKIP: '-',
  };
  for (const r of result.results) {
    let text = label[r.classification] ?? r.classification;
    if (r.classification === 'REVIEW_MERGED_DIRTY' && !r.dirty && r.unpushed === 0) text = 'review: landed, no upstream';
    let facts = '';
    if (r.classification !== 'SKIP') {
      facts = `landed=${r.landedVia ?? 'n'} local-only=${r.localOnly ?? '?'} dirty=${r.dirty ? 'y' : 'n'} idle=${formatDuration(r.idleMs)}${r.ownerEnded ? ' ended' : ''}`;
    }
    const note = r.error ? `  !! ${r.error}` : r.salvage ? `  saved as ${r.salvage}` : '';
    console.log(`${r.slot.padEnd(8)} ${text.padEnd(38)} ${(r.branch ?? '-').padEnd(42)} ${facts}${note}`.trimEnd());
  }
  const freeable = result.results.filter((r) => ['REAPABLE', 'REAPABLE_PUSHED', 'REAPABLE_BLOCKED', 'TAKEOVER'].includes(r.classification));
  const done = result.results.filter((r) => r.reaped);
  const keep = result.results.filter((r) => ['ACTIVE', 'REVIEW_MERGED_DIRTY', 'REVIEW_DRIFT', 'REVIEW_UNLEASED'].includes(r.classification));
  console.log('');
  if (result.apply) {
    console.log(`Freed ${done.length} slot(s). ${keep.length} kept (owner active or not provably safe): ask the owner about those, never discard them.`);
  } else {
    console.log(`${freeable.length} slot(s) can be freed now (run \`${WT} reap --apply\`; it saves state before it takes over). ${keep.length} kept. No changes made.`);
  }
}

function printTakeover(result) {
  if (result.action === 'refused') {
    console.log(`Not done: ${result.reason}.`);
    process.exitCode = 1;
    return;
  }
  if (result.action === 'none') console.log(result.reason);
  else if (result.action === 'dry-run') console.log(`${result.slot} (${result.classification}): ${result.reason}. Nothing changed.`);
  else if (result.action === 'adopted') console.log(`Adopted ${result.slot} on ${result.lease.branch}. The tree and branch are untouched.\n${result.lease.path}`);
  else if (result.action === 'released') console.log(`Released ${result.slot}; branch ${result.released.branch} was preserved.`);
  else if (result.action === 'healed') console.log(`Repaired ${result.slot}: ${result.reason}.`);
  else if (result.action === 'taken-over') {
    const saved = result.salvage ? `Saved uncommitted work as branch ${result.salvage.ref} (${result.salvage.files} file(s)); recover with: ${WT} acquire ${result.salvage.ref} --purpose "recover".` : 'Nothing uncommitted to save.';
    const local = result.localOnly > 0 ? ` ${result.localOnly} local-only commit(s) stay on branch ${result.branch}; push it soon.` : '';
    console.log(`Freed ${result.slot} (branch ${result.branch} preserved). ${saved}${local}`);
  }
}

async function main() {
  const [command = 'status', ...rest] = process.argv.slice(2);
  const { positional, options } = parseArgs(rest);
  const context = loadContext(process.cwd());
  // Any pool command run inside the caller's own slot counts as a sign of life.
  touchOwnHeartbeat(process.cwd());

  if (command === 'setup') {
    const created = setupPool(context);
    console.log(created.length ? `Created ${created.length} slot(s).` : 'All slots already exist.');
  } else if (command === 'status') {
    const rows = getPoolStatus(context);
    if (options.json) {
      const now = Date.now();
      console.log(JSON.stringify(rows.map((row) => ({
        slot: row.slot, state: row.state, branch: row.branch, detail: row.detail, owner: row.lease?.owner ?? null,
        purpose: row.lease?.purpose ?? null, acquiredAt: row.lease?.acquiredAt ?? null,
        idleMs: row.lease ? leaseActivity({ now, lease: row.lease, stateRoot: context.stateRoot }).idleMs : null,
      })), null, 2));
    } else if (options.long) await printLong(context, rows);
    else printRows(context, rows);
  } else if (command === 'acquire') {
    const lease = await acquireSlot(context, positional[0], {
      ...options,
      fetch: options.noFetch ? false : undefined,
      onWarn: (message) => console.error(`warning: ${message}`),
      onAutoReap: (reaped) =>
        console.log(`Freed ${reaped.length} finished slot(s): ${reaped.map((r) => `${r.slot} (${r.branch})`).join(', ')}`),
    });
    console.log(`${lease.reused ? 'Already leased' : lease.adopted ? 'Adopted' : 'Leased'} ${lease.slot} to ${lease.branch}\n${lease.path}`);
    if (options.prepare) {
      const result = prepareSlot(context, { slot: Number(lease.slot.replace(/\D/g, '')), cwd: lease.path });
      console.log(result.installed ? `Dependencies prepared via ${result.reason}.` : `Skipped install: ${result.reason}.`);
    }
  } else if (command === 'prepare') {
    const result = prepareSlot(context, { ...options, cwd: process.cwd() });
    console.log(result.installed ? `Dependencies prepared via ${result.reason}.` : `Skipped install: ${result.reason}.`);
  } else if (command === 'release') {
    // Forward only user-facing flags. `mergedHead`/`expectedToken` are reaper-internal signals — never
    // accept them from the CLI, or a manual `release --merged-head <sha>` could skip the proof.
    const result = releaseSlot(context, {
      cwd: process.cwd(),
      slot: options.slot,
      expectBranch: typeof options.expectBranch === 'string' ? options.expectBranch : undefined,
      allowUnpushed: Boolean(options.allowUnpushed),
      reconcileBranch: Boolean(options.reconcileBranch),
      ownerApproved: Boolean(options.ownerApproved),
    });
    const proof = result.landedVia ? ` (work already landed: ${result.landedVia})` : '';
    const foreign = result.foreign ? ` [foreign slot, ${result.tier}]` : '';
    console.log(`Released ${result.slot}; branch ${result.branch} was preserved.${proof}${foreign}`);
  } else if (command === 'assert') {
    const result = assertSlot(context, {
      cwd: process.cwd(),
      slot: options.slot,
      expectBranch: typeof options.expectBranch === 'string' ? options.expectBranch : undefined,
    });
    if (result.ok) console.log(`OK ${result.slot} ${result.branch}`);
    else {
      console.error(`NOT YOURS: ${result.reason}`);
      process.exitCode = 1;
    }
  } else if (command === 'touch') {
    console.log(touchOwnHeartbeat(process.cwd()) ? 'Heartbeat recorded.' : 'No lease of yours here; nothing recorded.');
  } else if (command === 'adopt' || command === 'takeover') {
    if (!options.slot) throw new Error(`Usage: ${WT} ${command} --slot <n>${command === 'takeover' ? ' [--adopt] [--dry-run]' : ''} [--owner-approved]`);
    printTakeover(takeoverSlot(context, {
      slot: options.slot,
      adopt: command === 'adopt' || Boolean(options.adopt),
      dryRun: Boolean(options.dryRun),
      ownerApproved: Boolean(options.ownerApproved),
      purpose: typeof options.purpose === 'string' ? options.purpose : undefined,
    }));
  } else if (command === 'switch') {
    const lease = switchSlot(context, positional[0], { ...options, cwd: process.cwd() });
    console.log(`Switched ${lease.slot} from ${lease.switchedFrom} to ${lease.branch}\n${lease.path}`);
  } else if (command === 'doctor') {
    const result = doctorPool(context, { fix: Boolean(options.fix) });
    printRows(context, result.rows);
    for (const line of result.fixed) console.log(`fixed: ${line}`);
    if (!result.ok) throw new Error(result.errors.join('\n'));
    console.log('Worktree pool is healthy.');
  } else if (command === 'lock') {
    const value = acquireResourceLock(context, positional[0], { ...options, cwd: process.cwd() });
    console.log(`Leased ${value.resource} to ${value.slot}.`);
  } else if (command === 'unlock') {
    const value = releaseResourceLock(context, positional[0], { ...options, cwd: process.cwd() });
    console.log(`Released ${value.resource} from ${value.slot}.`);
  } else if (command === 'lane') {
    const value = acquireRuntimeLane(context, { cwd: process.cwd(), slot: options.slot ?? positional[0] });
    console.log(`Leased runtime-lane-${value.lane} to ${value.slot}.`);
  } else if (command === 'unlane') {
    const value = releaseRuntimeLane(context, {
      cwd: process.cwd(),
      lane: options.lane,
      slot: options.slot ?? positional[0],
      force: Boolean(options.force),
    });
    console.log(`Released runtime-lane-${value.lane}.`);
  } else if (command === 'recover-lock') {
    const value = recoverInternalLock(context, positional[0], options);
    console.log(`Recovered stale ${positional[0]} lock from PID ${value.pid}.`);
  } else if (command === 'reap') {
    const result = await reapPool(context, { apply: Boolean(options.apply), takeover: !options.noTakeover });
    printReap(result);
  } else {
    throw new Error('Usage: pool.mjs setup|status [--json|--long]|acquire <branch> --purpose <t> [--prepare] [--slot n] [--no-fetch]|prepare|release [--slot n] [--expect-branch b] [--reconcile-branch]|assert [--expect-branch b]|touch|adopt --slot n|takeover --slot n [--dry-run]|switch <branch> --purpose <t>|doctor [--fix]|lock <runtime|database>|unlock <runtime|database>|lane|unlane [--force]|recover-lock <allocation|dependency-install> --force|reap [--apply] [--no-takeover]');
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

