#!/usr/bin/env node
// pool-report: read-only status table for the worktree pool. Changes nothing.
// Run: node pool-report.mjs [--json]  (or the `report` skill command)
//
// The verdict comes from the same classifier that `reap`, `release` and `acquire` use, so the
// table can never promise something the tools then refuse.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_POLICY, explainClassification, formatDuration, getPoolStatus, loadContext, reapPool, run } from './pool-lib.mjs';

function git(path, args) {
  return run('git', args, { cwd: path, allowFailure: true }).stdout;
}

function stamp(date) {
  if (!date || Number.isNaN(date.getTime())) return '-';
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

function lastFileEdit(path, porcelain) {
  let newest = 0;
  for (const line of porcelain.split(/\r?\n/).filter(Boolean)) {
    const file = line.slice(3).replace(/^"|"$/g, '').split(' -> ').pop();
    const full = join(path, file);
    if (!existsSync(full)) continue;
    newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest ? new Date(newest) : null;
}

// One gh call for every PR; the newest PR per head branch wins.
function loadPrs(root) {
  const out = run('gh', ['pr', 'list', '--state', 'all', '--limit', '500', '--json', 'number,state,headRefName'], {
    cwd: root,
    allowFailure: true,
  });
  const byBranch = new Map();
  try {
    for (const pr of JSON.parse(out.stdout || '[]')) {
      const known = byBranch.get(pr.headRefName);
      if (!known || pr.number > known.number) byBranch.set(pr.headRefName, { number: pr.number, state: pr.state.toLowerCase() });
    }
  } catch {
    // gh missing or offline: every PR column reads "none"; SKILL.md tells the agent to say so.
  }
  return byBranch;
}

function describeState(result) {
  const parts = [];
  parts.push(result.dirty ? `${result.dirtyCount} uncommitted file(s)` : 'clean');
  parts.push(result.localOnly ? `${result.localOnly} commit(s) not pushed` : 'pushed');
  return parts.join(', ');
}

// Advice only, in the words of the tier model in docs/ai-rules/worktree-pool.md.
function verdict(result) {
  const policy = { ...DEFAULT_POLICY, ...result.policy };
  const idle = formatDuration(result.idleMs);
  switch (result.classification) {
    case 'REAPABLE':
    case 'REAPABLE_PUSHED':
    case 'REAPABLE_BLOCKED':
      return `free: reap releases it (${result.landedVia ? `landed via ${result.landedVia}` : 'pushed'}, owner quiet ${idle})`;
    case 'TAKEOVER':
      return `abandoned: takeover saves state (owner gone ${idle})`;
    case 'ACTIVE':
      if (typeof result.idleMs === 'number' && result.idleMs < policy.liveWithinMinutes * 60_000) return `live: keep (owner active ${idle} ago)`;
      if (!result.dirty && result.pushed && !result.gitOp && !result.holdsLocks?.length) return `live: keep (quiet ${idle}; freed after ${policy.finishedIdleMinutes} min)`;
      return `ask: tier D (${explainClassification('ACTIVE', result)})`;
    default:
      return `ask: tier D (${explainClassification(result.classification, result)})`;
  }
}

function table(headers, rows) {
  const width = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => `| ${cells.map((c, i) => String(c).padEnd(width[i])).join(' | ')} |`;
  return [line(headers), line(width.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

const context = loadContext();
const now = Date.now();
const prs = loadPrs(context.mainRoot);
const swept = await reapPool(context, { apply: false, now });
const byNumber = new Map(swept.results.map((r) => [r.number, r]));
const rows = [];
for (const row of getPoolStatus(context)) {
  const result = byNumber.get(row.number);
  if (!result || result.classification === 'SKIP') {
    rows.push({ slot: row.slot.replace(/^slot-/, ''), branch: '-', pr: '-', age: '-', lastCommit: '-', lastEdit: '-', state: row.state, verdict: row.state === 'AVAILABLE' ? 'free' : row.detail });
    continue;
  }
  const pr = prs.get(row.branch) ?? null;
  const acquired = row.lease?.acquiredAt ? Date.parse(row.lease.acquiredAt) : NaN;
  rows.push({
    slot: row.slot.replace(/^slot-/, ''),
    branch: row.branch ?? '-',
    pr: pr ? `#${pr.number} ${pr.state}` : 'none',
    age: Number.isNaN(acquired) ? '-' : formatDuration(now - acquired),
    lastCommit: stamp(new Date(git(row.path, ['log', '-1', '--format=%cI']))),
    lastEdit: stamp(lastFileEdit(row.path, git(row.path, ['status', '--porcelain']))),
    state: row.state === 'BLOCKED' ? `BLOCKED (${row.detail})` : describeState(result),
    verdict: verdict(result),
  });
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log(`Now: ${stamp(new Date(now))}. Age = time since the lease started.\n`);
  console.log(table(
    ['Slot', 'Branch', 'PR', 'Age', 'Last commit', 'Last file edit', 'State', 'Verdict'],
    rows.map((r) => [r.slot, r.branch, r.pr, r.age, r.lastCommit, r.lastEdit, r.state, r.verdict]),
  ));
}
