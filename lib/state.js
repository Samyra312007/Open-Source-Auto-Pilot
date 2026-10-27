import path from 'node:path';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolveStateRoot, statePath } from './config.js';

export const STATE_VERSION = 1;

const locks = new Map();

function locked(key, operation) {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  locks.set(key, next);
  next.finally(() => {
    if (locks.get(key) === next) locks.delete(key);
  }).catch(() => {});
  return next;
}

export function emptyState() {
  const now = new Date().toISOString();
  return { version: STATE_VERSION, createdAt: now, updatedAt: now, runs: {} };
}

export function makeRunId(owner, repo, issueNumber) {
  return `${owner}/${repo}#${issueNumber}`;
}

export function parseRunId(runId) {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/.exec(String(runId ?? '').trim());
  if (!match) throw new Error('run_id must look like "owner/repo#123"');
  if (match[1] === '.' || match[1] === '..' || match[2] === '.' || match[2] === '..') {
    throw new Error('run_id must name a real owner/repository, not a relative path');
  }
  return { owner: match[1], repo: match[2], issueNumber: Number(match[3]) };
}

export async function ensureStateRoot(root) {
  const resolved = resolveStateRoot(root);
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  return resolved;
}

/**
 * Read the persisted state. A missing file is an empty state; a malformed or
 * newer file is a hard error so an older plugin never overwrites newer work.
 *
 * @param {string} [root]
 */
export async function readState(root) {
  const resolved = await ensureStateRoot(root);
  const file = statePath(resolved);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyState();
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`State file is not valid JSON: ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`State file must contain a JSON object: ${file}`);
  }
  if (parsed.version !== STATE_VERSION) {
    throw new Error(`State version ${String(parsed.version)} is not supported (expected ${STATE_VERSION}): ${file}. Move it aside instead of overwriting it.`);
  }
  if (parsed.runs === null || typeof parsed.runs !== 'object' || Array.isArray(parsed.runs)) {
    throw new Error(`State file has no valid runs object: ${file}`);
  }
  return parsed;
}

async function writeStateAtomic(resolved, state) {
  const file = statePath(resolved);
  const temp = `${file}.${process.pid}.${randomBytes(5).toString('hex')}.tmp`;
  const body = `${JSON.stringify(state, null, 2)}\n`;
  await writeFile(temp, body, { encoding: 'utf8', mode: 0o600 });
  try {
    await rename(temp, file);
  } catch (error) {
    if (error?.code === 'EEXIST' || error?.code === 'EPERM') {
      await rm(file, { force: true });
      await rename(temp, file);
    } else {
      await rm(temp, { force: true });
      throw error;
    }
  }
}

/**
 * Serialize one read-modify-write per state root. Network calls must happen
 * outside this transaction.
 *
 * @template T
 * @param {string} [root]
 * @param {(state: ReturnType<typeof emptyState>) => T | Promise<T>} operation
 * @returns {Promise<T>}
 */
export async function mutateState(root, operation) {
  const resolved = await ensureStateRoot(root);
  return locked(resolved, async () => {
    const state = await readState(resolved);
    const result = await operation(state);
    state.updatedAt = new Date().toISOString();
    await writeStateAtomic(resolved, state);
    return result;
  });
}

export async function getRun(root, runId) {
  const state = await readState(root);
  return state.runs[String(runId)];
}

export async function saveRun(root, run) {
  await mutateState(root, (state) => {
    state.runs[run.id] = run;
  });
}

export async function listRuns(root) {
  const state = await readState(root);
  return Object.values(state.runs).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export function createRun({ owner, repo, issueNumber, issueTitle, issueUrl, workspace }) {
  const now = new Date().toISOString();
  return {
    id: makeRunId(owner, repo, issueNumber),
    owner,
    repo,
    issueNumber,
    issueTitle: issueTitle ?? '',
    issueUrl: issueUrl ?? `https://github.com/${owner}/${repo}/issues/${issueNumber}`,
    workspace: workspace ?? '',
    phase: 'claim_requested',
    createdAt: now,
    updatedAt: now,
    claim: {
      requestedAt: null,
      commentUrl: null,
      followUps: 0,
      lastFollowUpAt: null,
      assignedAt: null,
      assignee: null,
    },
    repository: {
      defaultBranch: null,
      cloneUrl: null,
      pushAllowed: null,
      forkFullName: null,
    },
    work: {
      repoPath: null,
      branch: null,
      base: null,
      startedAt: null,
    },
    pr: null,
    schedule: null,
    lastStatusKey: null,
    lastNextAction: null,
    stoppedReason: null,
    events: [],
  };
}

export function appendEvent(run, type, summary, data) {
  const event = {
    at: new Date().toISOString(),
    type,
    summary: String(summary ?? '').slice(0, 1200),
    ...(data === undefined ? {} : { data }),
  };
  run.events ??= [];
  run.events.push(event);
  if (run.events.length > 100) run.events.splice(0, run.events.length - 100);
  run.updatedAt = event.at;
  return event;
}

export function touchRun(run) {
  run.updatedAt = new Date().toISOString();
}

export function compactRun(run) {
  if (run === undefined) return null;
  return {
    id: run.id,
    issue: run.issueUrl,
    title: run.issueTitle,
    phase: run.phase,
    branch: run.work?.branch ?? null,
    repoPath: run.work?.repoPath ?? null,
    pr: run.pr?.url ?? null,
    schedule: run.schedule?.id ?? null,
    updatedAt: run.updatedAt,
  };
}
