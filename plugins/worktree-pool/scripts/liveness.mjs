// Liveness signals for pool leases. Pure file reads: no git, no network.
//
// A lease is a label, not proof that someone is working. These helpers answer "is the owner
// still around?" from four independent sources, so the pool can free abandoned slots without
// asking a human and still leave a live session's slot alone:
//   1. heartbeat   <stateRoot>/heartbeats/<lease.token>, touched by the worktree-guard hook on
//                  every slot edit, by the Stop hook, and by pool commands run in the slot.
//   2. transcript  the owner session's own log file (Claude: <session>.jsonl, Codex:
//                  rollout-<ts>-<thread>.jsonl). Its mtime is the last time the session did anything.
//   3. ended       <stateRoot>/ended/<owner>.json, written by the SessionEnd hook.
//   4. slot        the newest of HEAD reflog time and dirty-file mtime (passed in by the caller).
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_POLICY = Object.freeze({
  // Landed work (merged / content already on main) and clean: the owner only needs to be quiet this long.
  landedIdleMinutes: 5,
  // Clean and pushed but not landed (open PR, waiting on CI): quiet this long before anyone may reclaim it.
  finishedIdleMinutes: 60,
  // Same, when the pool has no free slot.
  finishedIdleMinutesFull: 15,
  // After the owner's SessionEnd marker, everything above shrinks to this.
  endedGraceMinutes: 2,
  // A BLOCKED slot (unleased branch, lease drift) that is clean and pushed.
  blockedIdleMinutes: 30,
  // Dirty or local-only work: quiet this long before takeover (state is saved first).
  abandonedIdleHours: 24,
  endedAbandonedHours: 4,
  unknownOwnerAbandonedHours: 72,
  // Inside this window the owner is "live"; nothing is released or taken over, whatever else is true.
  liveWithinMinutes: 10,
});

export function resolvePolicy(override) {
  const policy = { ...DEFAULT_POLICY };
  if (override && typeof override === 'object') {
    for (const key of Object.keys(DEFAULT_POLICY)) {
      if (Number.isFinite(override[key]) && override[key] >= 0) policy[key] = override[key];
    }
  }
  return policy;
}

export const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function ownerLooksLikeSession(owner) {
  return typeof owner === 'string' && SESSION_ID_PATTERN.test(owner);
}

export function heartbeatPath(stateRoot, token) {
  return join(stateRoot, 'heartbeats', token);
}

/** Never throws: a failed heartbeat must not break the command or hook that asked for it. */
export function touchHeartbeat(stateRoot, token, now = new Date()) {
  if (!token) return false;
  try {
    const path = heartbeatPath(stateRoot, token);
    mkdirSync(join(stateRoot, 'heartbeats'), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, '');
    utimesSync(path, now, now);
    return true;
  } catch {
    return false;
  }
}

export function readHeartbeatMs(stateRoot, token) {
  if (!token) return null;
  try {
    return statSync(heartbeatPath(stateRoot, token)).mtimeMs;
  } catch {
    return null;
  }
}

export function readEndedMarker(stateRoot, owner) {
  if (!owner) return null;
  try {
    const marker = JSON.parse(readFileSync(join(stateRoot, 'ended', `${owner}.json`), 'utf8'));
    const endedAtMs = Date.parse(marker.endedAt);
    return Number.isFinite(endedAtMs) ? { endedAtMs, reason: String(marker.reason ?? '') } : null;
  } catch {
    return null;
  }
}

// --- Owner transcript lookup ---------------------------------------------------------------

const UUID_TAIL = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
let codexIndexCache = null;

function claudeProjectsDir(env) {
  return env.WT_CLAUDE_PROJECTS_DIR || join(homedir(), '.claude', 'projects');
}

function codexSessionsDir(env) {
  return env.WT_CODEX_SESSIONS_DIR || join(homedir(), '.codex', 'sessions');
}

function* walkFiles(dir, depth = 0) {
  if (depth > 5) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full, depth + 1);
    else if (entry.name.endsWith('.jsonl')) yield full;
  }
}

function codexIndex(env) {
  const dir = codexSessionsDir(env);
  if (codexIndexCache?.dir === dir) return codexIndexCache.map;
  const map = new Map();
  for (const file of walkFiles(dir)) {
    const match = UUID_TAIL.exec(file);
    if (!match) continue;
    try {
      map.set(match[1].toLowerCase(), statSync(file).mtimeMs);
    } catch {
      // file vanished between listing and stat
    }
  }
  codexIndexCache = { dir, map };
  return map;
}

/** mtime (ms) of the owner session's transcript, or null when the owner is not a known session. */
export function ownerTranscriptMtimeMs(owner, env = process.env) {
  if (!ownerLooksLikeSession(owner)) return null;
  const projects = claudeProjectsDir(env);
  try {
    for (const entry of readdirSync(projects, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        return statSync(join(projects, entry.name, `${owner}.jsonl`)).mtimeMs;
      } catch {
        // not in this project folder
      }
    }
  } catch {
    // no Claude projects folder on this machine
  }
  return codexIndex(env).get(owner.toLowerCase()) ?? null;
}

export function resetLivenessCaches() {
  codexIndexCache = null;
}

// --- Audit log -------------------------------------------------------------------------------

/** Best effort append-only log of pool decisions (release, takeover, auto-heal). Never throws. */
export function appendEvent(stateRoot, event) {
  try {
    mkdirSync(stateRoot, { recursive: true });
    const file = join(stateRoot, 'events.jsonl');
    try {
      if (statSync(file).size > 2 * 1024 * 1024) renameSync(file, `${file}.1`);
    } catch {
      // no log yet
    }
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
  } catch {
    // the audit log is never a reason to fail a pool command
  }
}

// --- Activity ----------------------------------------------------------------------------------

/**
 * Everything the pool knows about whether a lease's owner is still around.
 * `slotActivityMs` (HEAD reflog time, newest dirty file) comes from git, so the caller supplies it.
 */
export function leaseActivity({ now = Date.now(), lease, stateRoot, slotActivityMs = null, env = process.env }) {
  const acquiredAtMs = Date.parse(lease?.acquiredAt ?? '');
  const heartbeatMs = readHeartbeatMs(stateRoot, lease?.token);
  const transcriptMs = ownerTranscriptMtimeMs(lease?.owner, env);
  const marker = readEndedMarker(stateRoot, lease?.owner);
  const sources = [acquiredAtMs, heartbeatMs, transcriptMs, slotActivityMs].filter((value) => Number.isFinite(value));
  const lastActiveMs = sources.length ? Math.max(...sources) : null;
  // The marker counts only while nothing happened after it: a resumed session writes its transcript again.
  const ownerEnded = Boolean(
    marker &&
      (!Number.isFinite(acquiredAtMs) || marker.endedAtMs >= acquiredAtMs - 1000) &&
      (heartbeatMs ?? 0) <= marker.endedAtMs + 1000 &&
      (transcriptMs ?? 0) <= marker.endedAtMs + 60_000,
  );
  return {
    lastActiveMs,
    idleMs: lastActiveMs == null ? null : Math.max(0, now - lastActiveMs),
    heartbeatMs,
    transcriptMs,
    ownerEnded,
    endReason: ownerEnded ? marker.reason : null,
    // A transcript or a heartbeat means we can judge this owner; without either only the slot itself speaks.
    ownerKnown: transcriptMs != null || heartbeatMs != null,
  };
}

export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '-';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}
