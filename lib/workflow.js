import path from 'node:path';
import { configPath, getTokenType, normalizeConfig } from './config.js';
import { readFile, stat, writeFile } from 'node:fs/promises';
import {
  addOrSetRemote,
  checkoutBranch,
  cloneRepo,
  commit,
  commitsAhead,
  currentBranch,
  fetchOrigin,
  getConfig,
  gitVersion,
  isGitRepository,
  push,
  hasDisclosure,
  revParse,
  scanForDisclosure,
  setConfig,
  stageAll,
  stagedDiff,
  stagedFiles,
  stagedStat,
  statusPorcelain,
} from './git.js';
import { GitHubError } from './github.js';
import {
  appendEvent,
  compactRun,
  createRun,
  getRun,
  listRuns,
  makeRunId,
  parseRunId,
  saveRun,
  touchRun,
} from './state.js';

export const CLAIM_MARKER = '<!-- dsh-oss-autopilot:claim -->';
export const FOLLOWUP_MARKER = '<!-- dsh-oss-autopilot:claim-followup -->';
export const DISCLOSURE_MARKER = '<!-- dsh-oss-autopilot:ai-disclosure -->';

const CLAIM_ACTIONS = new Set(['request', 'status', 'follow_up']);

function fail(message, code = 'OSS_ERROR') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function clip(text, max) {
  const value = typeof text === 'string' ? text : text === undefined || text === null ? '' : String(text);
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function iso(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function escapeSearchTerm(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function parseRepoSlug(repo) {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(String(repo ?? '').trim());
  if (!match) throw fail('repo must look like "owner/repository"', 'INVALID_REPO');
  if (match[1] === '.' || match[1] === '..' || match[2] === '.' || match[2] === '..') {
    throw fail('repo must name a real owner/repository, not a relative path', 'INVALID_REPO');
  }
  return { owner: match[1], repo: match[2] };
}

function assertIssueNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw fail('issue_number must be a positive integer', 'INVALID_ISSUE');
  return value;
}

function ensureAgent(deps) {
  if (!deps.agent?.id) throw fail('This tool requires a calling DSH agent session', 'AGENT_REQUIRED');
  return deps.agent;
}

function ensureClient(deps) {
  if (!deps.client) throw fail('A GitHub client is unavailable. Run oss_doctor and configure a token.', 'GITHUB_REQUIRED');
  return deps.client;
}

function ensureScheduleCapability(deps) {
  if (!deps.schedule) {
    return { ok: false, warning: 'The DSH schedule service is unavailable; persistent wake-ups are disabled. Call oss_sync_status manually.' };
  }
  if (!deps.agent?.id) {
    return { ok: false, warning: 'No calling agent session; persistent wake-ups are disabled.' };
  }
  return { ok: true };
}

async function ensureUser(deps) {
  const client = ensureClient(deps);
  if (!deps.user) {
    deps.user = await client.getAuthenticatedUser();
    deps.login = deps.user.login;
  }
  if (!deps.login) deps.login = deps.user.login;
  return deps.user;
}

async function getRepoData(deps, owner, repo) {
  const client = ensureClient(deps);
  if (deps.repoCache?.full_name?.toLowerCase() === `${owner}/${repo}`.toLowerCase()) return deps.repoCache;
  deps.repoCache = await client.getRepo(owner, repo);
  return deps.repoCache;
}

async function getRunRequired(deps, runId) {
  const run = await getRun(deps.stateRoot, runId);
  if (!run) throw fail(`No run named "${runId}". Use oss_doctor to list runs, or claim the issue first.`, 'RUN_NOT_FOUND');
  return run;
}

function disclosure(deps) {
  return deps.config.disclosure.replaceAll('{login}', deps.login);
}

function claimComment(deps, custom) {
  const base = custom?.trim()
    ? custom.replaceAll(CLAIM_MARKER, '').replaceAll(FOLLOWUP_MARKER, '').trim().slice(0, 1400)
    : 'Hi! I would like to work on this issue if it is still available. If your workflow uses assignment, could you assign it to me? I will keep the change focused and include tests.';
  return `${base}\n\n${disclosure(deps)}\n\n${CLAIM_MARKER}`;
}

function followUpComment(deps) {
  return `Hi! A polite check on whether this issue is still available for me to work on. I am the AI-assisted contributor from my earlier comment. If it is taken or your workflow works differently, no problem — I will move on. Thank you!\n\n${disclosure(deps)}\n\n${FOLLOWUP_MARKER}`;
}

function dateOf(comment) {
  const time = Date.parse(comment?.created_at ?? '');
  return Number.isFinite(time) ? time : 0;
}

function commentsByLogin(comments, login) {
  const target = String(login).toLowerCase();
  return comments.filter((comment) => String(comment?.user?.login ?? '').toLowerCase() === target);
}

function claimState(comments, login, config, assigned, now = Date.now()) {
  const mine = commentsByLogin(comments, login);
  const claimComments = mine.filter((comment) => String(comment.body ?? '').includes(CLAIM_MARKER)).sort((a, b) => dateOf(a) - dateOf(b));
  const followUps = mine.filter((comment) => String(comment.body ?? '').includes(FOLLOWUP_MARKER)).sort((a, b) => dateOf(a) - dateOf(b));
  const first = claimComments[0];
  const last = [...claimComments, ...followUps].sort((a, b) => dateOf(a) - dateOf(b)).at(-1);
  const dueAt = last ? dateOf(last) + config.claimFollowUpHours * 3600_000 : null;
  const canFollowUp = Boolean(first) && !assigned && followUps.length < config.maxClaimFollowUps;
  return {
    requested: Boolean(first),
    comment_url: first?.html_url ?? null,
    requested_at: first?.created_at ?? null,
    follow_ups: followUps.length,
    last_comment_at: last?.created_at ?? null,
    next_follow_up_at: dueAt === null ? null : new Date(dueAt).toISOString(),
    follow_up_due: canFollowUp && dueAt !== null && now >= dueAt,
  };
}

function maintainerSignal(comments, claim, login) {
  const claimTime = Date.parse(claim?.requested_at ?? '') || 0;
  const relevant = comments.filter((comment) => {
    if (String(comment?.user?.login ?? '').toLowerCase() === String(login).toLowerCase()) return false;
    if (!['OWNER', 'MEMBER', 'COLLABORATOR'].includes(String(comment.author_association ?? ''))) return false;
    return dateOf(comment) >= claimTime;
  });
  const goAheadPattern = /\b(assign(?:ed)?\s+(?:you|this)|go ahead|please (?:work|proceed|go ahead)|you can (?:work|take|proceed)|feel free to (?:work|open|proceed)|sure[,! ]|yes[,! ])/i;
  return {
    comments: relevant.slice(-3).map((comment) => ({
      user: comment.user?.login ?? 'unknown',
      association: comment.author_association,
      body: clip(comment.body ?? '', 900),
      url: comment.html_url ?? null,
      created_at: comment.created_at,
    })),
    possible_go_ahead: relevant.some((comment) => goAheadPattern.test(String(comment.body ?? ''))),
    note: 'This is a heuristic only. Proceed without formal assignment only when a maintainer explicitly told this operator to work on the issue.',
  };
}

/**
 * A maintainer reply means the polite follow-up clock is no longer automatic.
 * The agent may still answer the thread, but it must not post a scheduled
 * "any update?" comment after a human has engaged.
 */
function applyMaintainerReplyRule(claim, maintainer) {
  if (maintainer.comments.length > 0) {
    claim.follow_up_due = false;
    claim.follow_up_blocked = 'A maintainer replied after the claim; do not auto-follow-up. Read and respond to the actual thread instead.';
  }
  return claim;
}

function assignmentState(issue, login) {
  const assignees = Array.isArray(issue.assignees) ? issue.assignees : [];
  const mine = assignees.some((assignee) => String(assignee?.login ?? '').toLowerCase() === String(login).toLowerCase());
  const others = assignees.filter((assignee) => String(assignee?.login ?? '').toLowerCase() !== String(login).toLowerCase());
  if (issue.state === 'closed') return 'closed';
  if (mine) return 'assigned_to_operator';
  if (others.length > 0) return 'assigned_to_other';
  return 'unassigned';
}

async function stopSchedule(deps, run) {
  if (!run.schedule?.id) {
    run.schedule = null;
    return { stopped: false };
  }
  const schedule = deps.schedule;
  if (!schedule) {
    run.schedule = null;
    return { stopped: false, warning: 'Schedule service unavailable; the stored reminder could not be removed.' };
  }
  try {
    await schedule.delete({ sessionId: run.schedule.sessionId, id: run.schedule.id });
    run.schedule = null;
    return { stopped: true };
  } catch (error) {
    return { stopped: false, warning: `Could not remove the recurring reminder: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function claimPrompt(run) {
  return [
    `OSS AUTOPILOT CLAIM CHECK — ${run.id}`,
    'This is an automated reminder from the open-source-autopilot plugin.',
    `Call oss_claim_issue with action="status", repo="${run.owner}/${run.repo}", issue_number=${run.issueNumber}.`,
    'If the issue is assigned to the operator, immediately call oss_start_work and begin the implementation.',
    'If it is not assigned, call oss_claim_issue with action="follow_up" only if the status says follow_up_due=true; otherwise do nothing public.',
    'If the issue is closed or assigned to someone else, call oss_stop and explain the outcome briefly.',
    'Do not ask the operator a question unless you are blocked.',
  ].join('\n');
}

function prPrompt(run) {
  return [
    `OSS AUTOPILOT PR CHECK — ${run.id}`,
    'This is an automated reminder from the open-source-autopilot plugin.',
    `Call oss_sync_status with run_id="${run.id}".`,
    'If next_action is fix_ci, address_review, resolve_conflicts, update_branch, mark_ready, or merge, do that work now and continue until the PR is healthy.',
    'If next_action starts with wait_, reply briefly and stop; the watcher will wake you again. Never merge unless the tool reports ready and the operator has merge permission.',
    'If the run is merged or closed, stop and report the outcome.',
  ].join('\n');
}

async function armSchedule(deps, run, kind) {
  const capability = ensureScheduleCapability(deps);
  if (!capability.ok) return { armed: false, warning: capability.warning };
  const everySeconds = kind === 'claim' ? deps.config.claimPollSeconds : deps.config.pollSeconds;
  if (run.schedule?.id && run.schedule.kind === kind && run.schedule.everySeconds === everySeconds) {
    return { armed: true, existing: true, id: run.schedule.id };
  }
  await stopSchedule(deps, run);
  const prompt = kind === 'claim' ? claimPrompt(run) : prPrompt(run);
  const title = `OSS Autopilot ${run.owner}/${run.repo}#${run.issueNumber}`.slice(0, 120);
  try {
    const record = await deps.schedule.create(ensureAgent(deps).id, {
      title,
      prompt,
      every_seconds: everySeconds,
    });
    run.schedule = {
      id: record.id,
      sessionId: ensureAgent(deps).id,
      kind,
      everySeconds,
      title,
      createdAt: new Date().toISOString(),
    };
    appendEvent(run, 'watch_armed', `${kind} watcher every ${everySeconds}s`);
    return { armed: true, id: record.id, everySeconds };
  } catch (error) {
    run.schedule = null;
    appendEvent(run, 'watch_failed', clip(error instanceof Error ? error.message : String(error), 600));
    return { armed: false, warning: `Could not arm the ${kind} watcher: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function mergePermission(repo) {
  const permissions = repo?.permissions ?? {};
  return Boolean(permissions.admin || permissions.maintain || permissions.push);
}

function summarizeReviews(reviews) {
  const latest = new Map();
  for (const review of reviews) {
    const login = String(review?.user?.login ?? '').toLowerCase();
    if (!login) continue;
    if (!['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(String(review.state))) continue;
    const at = Date.parse(review.submitted_at ?? '') || 0;
    const current = latest.get(login);
    if (!current || at >= current.at) latest.set(login, { at, state: review.state, user: review.user.login, url: review.html_url });
  }
  const values = [...latest.values()];
  const changes = values.filter((review) => review.state === 'CHANGES_REQUESTED');
  const approvals = values.filter((review) => review.state === 'APPROVED');
  return {
    decision: changes.length > 0 ? 'changes_requested' : approvals.length > 0 ? 'approved' : 'none',
    approvals: approvals.map((review) => review.user),
    changes_requested_by: changes.map((review) => review.user),
    latest: values,
  };
}

function checksSummary(checks) {
  return {
    overall: checks.overall,
    total: checks.total,
    passing: checks.passingCount,
    failing: (checks.failing ?? []).slice(0, 10).map((check) => ({
      name: check.name,
      url: check.url,
      summary: clip(check.summary ?? '', 500),
    })),
    pending: (checks.pending ?? []).slice(0, 10).map((check) => ({ name: check.name, url: check.url })),
  };
}

function reviewCommentsSummary(comments) {
  return comments
    .filter((comment) => String(comment.body ?? '').trim().length > 0)
    .slice(-10)
    .map((comment) => ({
      user: comment.user?.login ?? 'unknown',
      body: clip(comment.body ?? '', 900),
      path: comment.path ?? null,
      line: comment.line ?? comment.original_line ?? null,
      url: comment.html_url ?? null,
      created_at: comment.created_at,
    }));
}

function mainterCommentsSummary(comments, login) {
  return comments
    .filter((comment) => String(comment?.user?.login ?? '').toLowerCase() !== String(login).toLowerCase())
    .filter((comment) => ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(String(comment.author_association ?? '')))
    .slice(-5)
    .map((comment) => ({
      user: comment.user?.login ?? 'unknown',
      association: comment.author_association,
      body: clip(comment.body ?? '', 900),
      url: comment.html_url ?? null,
      created_at: comment.created_at,
    }));
}

function nextActionForNoPr({ assignment, issueClosed, claim, maintainer }) {
  if (issueClosed) return { kind: 'done', reason: 'The issue is closed.' };
  if (assignment === 'assigned_to_other') return { kind: 'done', reason: 'The issue is assigned to another contributor.' };
  if (assignment === 'assigned_to_operator') return { kind: 'start_work', reason: 'The issue is assigned to the operator. Start the implementation.' };
  if (maintainer.possible_go_ahead) return { kind: 'start_work', reason: 'A maintainer appears to have invited work. Confirm the thread, then start with allow_unassigned=true.' };
  if (claim.follow_up_due) return { kind: 'follow_up', reason: 'The polite follow-up window has elapsed.' };
  return { kind: 'wait_for_assignment', reason: 'Waiting for a maintainer to assign the issue.' };
}

function nextActionForPr({ pr, checks, review, repo, config }) {
  if (pr.merged) return { kind: 'done', reason: 'The pull request was merged.' };
  if (pr.state === 'closed') return { kind: 'done', reason: 'The pull request was closed without merging.' };
  if (pr.draft) return { kind: 'mark_ready', reason: 'The pull request is still a draft.' };
  if (pr.mergeable === false || pr.mergeable_state === 'dirty') return { kind: 'resolve_conflicts', reason: 'The pull request has merge conflicts.' };
  if (checks.overall === 'failure') return { kind: 'fix_ci', reason: 'One or more required checks are failing.' };
  if (review.decision === 'changes_requested') return { kind: 'address_review', reason: 'A reviewer requested changes.' };
  if (pr.mergeable_state === 'behind') return { kind: 'update_branch', reason: 'The branch is behind its base branch.' };
  if (checks.overall === 'pending') return { kind: 'wait_for_ci', reason: 'Checks are still running.' };
  if (pr.mergeable_state === 'blocked' || pr.mergeable_state === 'unstable') {
    return { kind: 'wait_for_review', reason: 'GitHub reports the pull request as blocked. Reviews or required checks are still outstanding.' };
  }
  const clean = pr.mergeable_state === 'clean' || pr.mergeable_state === 'has_hooks';
  if (!clean) return { kind: 'wait', reason: `GitHub merge state is ${pr.mergeable_state || 'unknown'}.` };
  if (!mergePermission(repo)) {
    return { kind: 'wait_for_maintainer_merge', reason: 'The operator does not have merge permission. A maintainer must merge.' };
  }
  if (!config.autoMerge) {
    return { kind: 'wait_for_maintainer_merge', reason: 'autoMerge is disabled in the plugin config.' };
  }
  return { kind: 'merge', reason: 'The pull request is clean, checks are green, and the operator can merge.' };
}

function actionNeedsWork(kind) {
  return ['start_work', 'follow_up', 'mark_ready', 'resolve_conflicts', 'fix_ci', 'address_review', 'update_branch', 'merge'].includes(kind);
}

function statusKey(value) {
  return JSON.stringify(value);
}

function isValidBranchName(branch) {
  if (typeof branch !== 'string' || branch.length === 0 || branch.length > 240) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) return false;
  if (branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/') || branch.endsWith('.lock')) return false;
  if (branch.includes('..') || branch.includes('//') || branch.includes('@{')) return false;
  return true;
}

/**
 * The session cwd is switched into the clone after startWork. If the operator
 * later starts another issue, clones must still live under the original
 * workspace, not inside the previous repository worktree.
 */
async function resolveHomeWorkspace(deps) {
  const current = path.resolve(deps.workspace || process.cwd());
  const marker = `${path.sep}.oss-autopilot${path.sep}repos${path.sep}`;
  const markerAt = current.indexOf(marker);
  if (markerAt > 0) return current.slice(0, markerAt);
  try {
    const runs = await listRuns(deps.stateRoot);
    for (const run of runs) {
      const repoPath = run.work?.repoPath ? path.resolve(run.work.repoPath) : null;
      if (!repoPath || !run.workspace) continue;
      if (current === repoPath || current.startsWith(`${repoPath}${path.sep}`)) {
        return path.resolve(run.workspace);
      }
    }
  } catch {
    // State is optional for resolving the home workspace.
  }
  return current;
}

function slugify(title) {
  const slug = String(title ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'fix';
}

function ensureIssueLink(body, issueNumber) {
  const pattern = new RegExp(`(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issueNumber}\\b`, 'i');
  if (pattern.test(body)) return body;
  return `${body.trim()}\n\nCloses #${issueNumber}`;
}

const PULL_REQUEST_TEMPLATE_CANDIDATES = [
  '.github/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'PULL_REQUEST_TEMPLATE.md',
  'docs/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE/default.md',
];

async function readPullRequestTemplate(repoDir) {
  for (const candidate of PULL_REQUEST_TEMPLATE_CANDIDATES) {
    try {
      const text = await readFile(path.join(repoDir, candidate), 'utf8');
      if (text.trim().length > 0) return text;
    } catch {
      // Missing templates are expected.
    }
  }
  return null;
}

function appendDisclosure(body, deps) {
  if (String(body).includes(DISCLOSURE_MARKER)) return body;
  const text = disclosure(deps);
  return `${String(body).trim()}\n\n---\n${text}\n${DISCLOSURE_MARKER}`;
}

function blockedFileName(file) {
  const normalized = file.replaceAll('\\', '/');
  const base = normalized.split('/').at(-1).toLowerCase();
  if (base === '.env' || (base.startsWith('.env.') && !['.env.example', '.env.sample', '.env.template', '.env.dist'].includes(base))) return 'environment file';
  if (/\.(pem|key|p12|pfx|jks|keystore)$/i.test(base)) return 'private key or certificate store';
  if (['id_rsa', 'id_ed25519', 'id_ecdsa', 'credentials.json', 'secrets.json', 'service-account.json', '.npmrc', '.pypirc'].includes(base)) return 'credential file';
  if (/(^|\/)(node_modules|\.venv|venv|__pycache__|\.git)(\/|$)/.test(normalized)) return 'generated or dependency directory';
  if (base === '.ds_store' || base === 'thumbs.db') return 'OS metadata file';
  return null;
}

const SECRET_RULES = [
  { name: 'private key block', pattern: /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----/ },
  { name: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/ },
  { name: 'OpenAI-style key', pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'GitLab token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{30,}\b/ },
];

function scanDiff(diff) {
  return SECRET_RULES.filter((rule) => rule.pattern.test(diff)).map((rule) => rule.name);
}

export async function searchIssues(deps, args) {
  const client = ensureClient(deps);
  await ensureUser(deps);
  const limit = Math.min(20, Math.max(1, Number.isSafeInteger(args.limit) ? args.limit : 10));
  const queryParts = [];
  if (args.query && String(args.query).trim()) queryParts.push(String(args.query).trim());
  else queryParts.push('is:issue is:open no:assignee');
  if (!/\bis:issue\b/i.test(queryParts.join(' '))) queryParts.push('is:issue');
  if (args.repo) {
    const { owner, repo } = parseRepoSlug(args.repo);
    queryParts.push(`repo:${owner}/${repo}`);
  }
  if (args.label) queryParts.push(`label:"${escapeSearchTerm(args.label)}"`);
  if (args.language) queryParts.push(`language:"${escapeSearchTerm(args.language)}"`);
  const query = queryParts.join(' ');
  const payload = await client.searchIssues(query, { perPage: limit, signal: deps.signal });
  const items = Array.isArray(payload?.items) ? payload.items.filter((item) => !item.pull_request) : [];
  const issues = items.slice(0, limit).map((item) => {
    const repoUrl = String(item.repository_url ?? '');
    const repoName = repoUrl.split('/').slice(-2).join('/');
    const labels = Array.isArray(item.labels) ? item.labels.map((label) => label.name).filter(Boolean) : [];
    const assignees = Array.isArray(item.assignees) ? item.assignees.map((assignee) => assignee.login).filter(Boolean) : [];
    return {
      repo: repoName,
      number: item.number,
      title: item.title,
      url: item.html_url,
      labels,
      assignees,
      comments: item.comments ?? 0,
      state: item.state,
      locked: Boolean(item.locked),
      updated_at: item.updated_at,
      body_excerpt: clip(item.body ?? '', 500),
      eligible_for_claim: item.state === 'open' && !item.locked && assignees.length === 0,
    };
  });
  return {
    ok: true,
    query,
    total: payload?.total_count ?? issues.length,
    returned: issues.length,
    issues,
    note: 'Read-only search. Prefer small, clearly scoped issues with a reproducible report. Confirm the repo contribution rules before claiming.',
  };
}

export async function claimIssue(deps, args) {
  const client = ensureClient(deps);
  const { owner, repo } = parseRepoSlug(args.repo);
  const issueNumber = assertIssueNumber(args.issue_number);
  const action = String(args.action ?? 'request');
  if (!CLAIM_ACTIONS.has(action)) throw fail('action must be request, status, or follow_up', 'INVALID_ACTION');
  await ensureUser(deps);
  const issue = await client.getIssue(owner, repo, issueNumber, deps.signal);
  if (issue?.pull_request) throw fail('That number is a pull request, not an issue.', 'NOT_AN_ISSUE');

  const existingRun = await getRun(deps.stateRoot, makeRunId(owner, repo, issueNumber));
  if (action !== 'request' && !existingRun) {
    throw fail(`No run exists for ${owner}/${repo}#${issueNumber}. Call action="request" first.`, 'RUN_NOT_FOUND');
  }
  if (existingRun && ['merged', 'closed', 'paused'].includes(existingRun.phase) && action === 'request') {
    throw fail(`Run ${existingRun.id} is ${existingRun.phase}. Remove it from state only if you intentionally want a fresh run.`, 'RUN_TERMINAL');
  }

  const comments = await client.listIssueComments(owner, repo, issueNumber, { signal: deps.signal });
  const assignment = assignmentState(issue, deps.login);
  const claim = claimState(comments, deps.login, deps.config, assignment === 'assigned_to_operator');
  const maintainer = maintainerSignal(comments, claim, deps.login);
  applyMaintainerReplyRule(claim, maintainer);

  const responseBase = {
    ok: true,
    action,
    run_id: makeRunId(owner, repo, issueNumber),
    repo: `${owner}/${repo}`,
    issue_number: issueNumber,
    issue_url: issue.html_url,
    issue_state: issue.state,
    assignment,
    claim,
    maintainer_signal: maintainer,
  };

  if (action === 'status') {
    const run = existingRun ?? createRun({
      owner,
      repo,
      issueNumber,
      issueTitle: issue.title,
      issueUrl: issue.html_url,
      workspace: deps.workspace,
    });
    if (assignment === 'closed' || issue.state === 'closed') run.phase = 'closed';
    else if (assignment === 'assigned_to_other') run.phase = 'taken';
    else if (assignment === 'assigned_to_operator') {
      run.phase = 'assigned';
      run.claim.assignedAt ??= new Date().toISOString();
      run.claim.assignee = deps.login;
    } else if (claim.requested) run.phase = 'claim_requested';
    run.claim.followUps = claim.follow_ups;
    run.claim.requestedAt ??= claim.requested_at;
    run.claim.commentUrl ??= claim.comment_url;
    if (run.phase === 'closed' || run.phase === 'taken') {
      const stopped = await stopSchedule(deps, run);
      if (stopped.warning) responseBase.warning = stopped.warning;
    }
    const next = nextActionForNoPr({ assignment, issueClosed: issue.state === 'closed', claim, maintainer });
    run.lastNextAction = next.kind;
    run.lastStatusKey = statusKey({ assignment, issueClosed: issue.state, followUpDue: claim.follow_up_due, maintainer: maintainer.possible_go_ahead });
    appendEvent(run, 'claim_status', `${assignment}; next=${next.kind}`);
    await saveRun(deps.stateRoot, run);
    return {
      ...responseBase,
      next_action: next.kind,
      next_reason: next.reason,
      follow_up_due: claim.follow_up_due,
      follow_ups_remaining: Math.max(0, deps.config.maxClaimFollowUps - claim.follow_ups),
      run_phase: run.phase,
    };
  }

  if (issue.state === 'closed') throw fail('The issue is closed; there is nothing to claim.', 'ISSUE_CLOSED');
  if (assignment === 'assigned_to_other') {
    throw fail('The issue is already assigned to another contributor. Do not comment or claim it.', 'ISSUE_TAKEN');
  }
  if (assignment === 'assigned_to_operator') {
    const run = existingRun ?? createRun({
      owner,
      repo,
      issueNumber,
      issueTitle: issue.title,
      issueUrl: issue.html_url,
      workspace: deps.workspace,
    });
    run.phase = 'assigned';
    run.claim.assignedAt ??= new Date().toISOString();
    run.claim.assignee = deps.login;
    appendEvent(run, 'already_assigned', `Already assigned to ${deps.login}`);
    await saveRun(deps.stateRoot, run);
    return {
      ...responseBase,
      already_assigned: true,
      next_action: 'start_work',
      message: 'The issue is already assigned to the operator. Start work; do not post a duplicate claim.',
      run_phase: run.phase,
    };
  }

  if (action === 'follow_up' && !claim.requested) {
    throw fail('No claim comment exists yet. Use action="request" first.', 'CLAIM_NOT_REQUESTED');
  }
  if (action === 'follow_up' && !claim.follow_up_due) {
    return {
      ...responseBase,
      ok: false,
      code: 'FOLLOW_UP_NOT_DUE',
      next_action: claim.follow_ups >= deps.config.maxClaimFollowUps ? 'wait_for_assignment' : 'wait_for_assignment',
      message: claim.follow_ups >= deps.config.maxClaimFollowUps
        ? `The maximum of ${deps.config.maxClaimFollowUps} follow-ups has been reached. Wait for the maintainers.`
        : `Do not follow up yet. The next permitted time is ${claim.next_follow_up_at ?? 'unknown'}.`,
    };
  }
  if (action === 'request' && claim.requested) {
    return {
      ...responseBase,
      ok: false,
      code: 'CLAIM_ALREADY_REQUESTED',
      next_action: 'wait_for_assignment',
      message: 'A claim comment already exists. Do not post a duplicate; use action="status" or wait.',
    };
  }

  const repoData = await getRepoData(deps, owner, repo);
  const preview = action === 'request' ? claimComment(deps, args.message) : followUpComment(deps);
  if (args.acknowledge_public_post !== true) {
    return {
      ...responseBase,
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      preview,
      message: 'This action posts a public GitHub comment. Re-run with acknowledge_public_post=true only after the operator has authorized public GitHub activity.',
    };
  }
  if (deps.config.dryRun) {
    return { ...responseBase, ok: true, dry_run: true, would_post: preview, next_action: 'dry_run' };
  }

  const comment = await client.createIssueComment(owner, repo, issueNumber, preview, deps.signal);
  const run = existingRun ?? createRun({
    owner,
    repo,
    issueNumber,
    issueTitle: issue.title,
    issueUrl: issue.html_url,
    workspace: deps.workspace,
  });
  run.phase = 'claim_requested';
  run.issueTitle = issue.title;
  run.issueUrl = issue.html_url;
  run.claim.requestedAt ??= comment.created_at ?? new Date().toISOString();
  run.claim.commentUrl ??= comment.html_url ?? null;
  if (action === 'follow_up') {
    run.claim.followUps = claim.follow_ups + 1;
    run.claim.lastFollowUpAt = new Date().toISOString();
  }
  run.repository.defaultBranch = repoData.default_branch ?? null;
  run.repository.cloneUrl = repoData.clone_url ?? null;
  run.repository.pushAllowed = mergePermission(repoData);
  appendEvent(run, action === 'request' ? 'claim_requested' : 'claim_follow_up', `Posted ${action} comment: ${comment.html_url}`);
  const watch = await armSchedule(deps, run, 'claim');
  await saveRun(deps.stateRoot, run);
  return {
    ...responseBase,
    ok: true,
    comment_url: comment.html_url,
    watch,
    follow_up_due: false,
    next_action: 'wait_for_assignment',
    next_reason: 'The claim request is public. Wait for a maintainer to assign the issue; the watcher will check periodically.',
    run_phase: run.phase,
  };
}

export async function startWork(deps, args) {
  const client = ensureClient(deps);
  const { owner, repo } = parseRepoSlug(args.repo);
  const issueNumber = assertIssueNumber(args.issue_number);
  const user = await ensureUser(deps);
  const issue = await client.getIssue(owner, repo, issueNumber, deps.signal);
  if (issue?.pull_request) throw fail('That number is a pull request, not an issue.', 'NOT_AN_ISSUE');
  if (issue.state === 'closed') throw fail('The issue is closed; do not start work.', 'ISSUE_CLOSED');
  const issueComments = await client.listIssueComments(owner, repo, issueNumber, { signal: deps.signal });
  const assignment = assignmentState(issue, deps.login);
  if (assignment === 'assigned_to_other') throw fail('The issue is assigned to another contributor.', 'ISSUE_TAKEN');
  if (assignment !== 'assigned_to_operator' && deps.config.requireAssignment && args.allow_unassigned !== true) {
    return {
      ok: false,
      code: 'ASSIGNMENT_REQUIRED',
      assignment,
      message: 'The issue is not assigned to the operator. Wait for assignment, or set allow_unassigned=true only after a maintainer explicitly invited work in the issue thread.',
    };
  }
  const preexistingRun = await getRun(deps.stateRoot, makeRunId(owner, repo, issueNumber));
  if (preexistingRun?.pr?.number && !['merged', 'closed'].includes(preexistingRun.phase)) {
    throw fail(`Run ${preexistingRun.id} already has PR #${preexistingRun.pr.number}. Use oss_sync_status instead of starting another worktree.`, 'PR_ALREADY_EXISTS');
  }

  const repoData = await getRepoData(deps, owner, repo);
  const base = String(args.base ?? repoData.default_branch ?? 'main').trim();
  if (!isValidBranchName(base)) throw fail(`Invalid base branch: ${base}`, 'INVALID_BRANCH');
  const branch = String(args.branch ?? `oss/issue-${issueNumber}-${slugify(issue.title)}`).trim();
  if (!isValidBranchName(branch)) throw fail(`Invalid branch name: ${branch}`, 'INVALID_BRANCH');
  if (!deps.workspace) throw fail('A workspace directory is required to clone the repository.', 'WORKSPACE_REQUIRED');
  const workspace = await resolveHomeWorkspace(deps);
  const repoDir = path.resolve(workspace, '.oss-autopilot', 'repos', owner, `${repo}-issue-${issueNumber}`);
  if (!repoDir.startsWith(`${workspace}${path.sep}`)) throw fail('Resolved repository path escaped the workspace.', 'PATH_ESCAPE');

  let existing = false;
  let dirty = false;
  if (await isGitRepository(repoDir).catch(() => false)) {
    existing = true;
    const branchNow = await currentBranch(repoDir).catch(() => '');
    const status = await statusPorcelain(repoDir);
    dirty = status.length > 0;
    if (dirty && branchNow !== branch) {
      throw fail(`The existing clone at ${repoDir} has uncommitted changes on ${branchNow || 'a detached HEAD'}. Commit, stash, or discard them before switching branches.`, 'DIRTY_WORKTREE');
    }
    await fetchOrigin(repoDir, { url: repoData.clone_url, token: deps.token, signal: deps.signal, branch: base });
    await checkoutBranch(repoDir, { branch, base, url: repoData.clone_url, token: deps.token, signal: deps.signal });
  } else {
    const cloneUrl = repoData.clone_url || `https://github.com/${owner}/${repo}.git`;
    await cloneRepo({ url: cloneUrl, destination: repoDir, token: deps.token, signal: deps.signal });
    await fetchOrigin(repoDir, { url: cloneUrl, token: deps.token, signal: deps.signal, branch: base });
    await checkoutBranch(repoDir, { branch, base, url: cloneUrl, token: deps.token, signal: deps.signal });
  }

  const configuredName = await getConfig(repoDir, 'user.name');
  const configuredEmail = await getConfig(repoDir, 'user.email');
  if (deps.config.gitAuthorName) await setConfig(repoDir, 'user.name', deps.config.gitAuthorName);
  else if (!configuredName) await setConfig(repoDir, 'user.name', deps.login);
  if (deps.config.gitAuthorEmail) await setConfig(repoDir, 'user.email', deps.config.gitAuthorEmail);
  else if (!configuredEmail) await setConfig(repoDir, 'user.email', `${user.id}+${deps.login}@users.noreply.github.com`);

  const run = preexistingRun ?? createRun({
    owner,
    repo,
    issueNumber,
    issueTitle: issue.title,
    issueUrl: issue.html_url,
    workspace,
  });
  run.phase = 'in_progress';
  run.issueTitle = issue.title;
  run.issueUrl = issue.html_url;
  run.workspace = workspace;
  run.repository = {
    defaultBranch: repoData.default_branch ?? base,
    cloneUrl: repoData.clone_url ?? null,
    pushAllowed: mergePermission(repoData),
    forkFullName: run.repository?.forkFullName ?? null,
  };
  if (assignment === 'assigned_to_operator') {
    run.claim.assignedAt ??= new Date().toISOString();
    run.claim.assignee = deps.login;
  }
  run.work = { repoPath: repoDir, branch, base, startedAt: run.work?.startedAt ?? new Date().toISOString() };
  if (args.allow_unassigned === true && assignment !== 'assigned_to_operator') {
    run.assignmentOverride = { at: new Date().toISOString(), reason: 'allow_unassigned requested' };
    appendEvent(run, 'assignment_override', 'Started work without formal assignment');
  }
  const stopped = await stopSchedule(deps, run);
  appendEvent(run, 'work_started', `${branch} from ${base} at ${repoDir}`);
  await saveRun(deps.stateRoot, run);

  let cwdChanged = false;
  if (typeof deps.setWorkingDirectory === 'function') {
    try {
      await deps.setWorkingDirectory(repoDir);
      cwdChanged = true;
    } catch {
      cwdChanged = false;
    }
  }

  const guideCandidates = [
    'CONTRIBUTING.md',
    '.github/CONTRIBUTING.md',
    'docs/CONTRIBUTING.md',
    'CODE_OF_CONDUCT.md',
    'README.md',
    'package.json',
    'pyproject.toml',
    'Cargo.toml',
    'go.mod',
    'Makefile',
    'justfile',
  ];
  const guides = [];
  for (const candidate of guideCandidates) {
    try {
      const info = await stat(path.join(repoDir, candidate));
      if (info.isFile()) guides.push(candidate);
    } catch {
      // Missing files are expected.
    }
  }

  return {
    ok: true,
    run_id: run.id,
    assignment,
    issue: {
      number: issueNumber,
      title: issue.title,
      url: issue.html_url,
      labels: (issue.labels ?? []).map((label) => label.name ?? label),
      body: clip(issue.body ?? '', 6000),
      recent_comments: issueComments.slice(-5).map((comment) => ({
        user: comment.user?.login ?? 'unknown',
        association: comment.author_association ?? null,
        body: clip(comment.body ?? '', 800),
        created_at: comment.created_at,
      })),
    },
    repo_path: repoDir,
    branch,
    base,
    cwd_changed: cwdChanged,
    reused_clone: existing,
    dirty_worktree: dirty,
    guide_files: guides,
    warning: stopped.warning ?? null,
    next_steps: [
      'Read the contribution guide and the issue thread before editing.',
      'Reproduce the problem, then make the smallest complete fix with tests.',
      'Run the repository test/lint commands. Do not claim they passed unless they did.',
      'Call oss_submit_pr with a focused title and a body that explains the change and testing.',
    ],
  };
}

async function sleep(ms, signal) {
  if (signal?.aborted) throw fail('Operation cancelled', 'ABORTED');
  await new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(fail('Operation cancelled', 'ABORTED'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function ensureFork(deps, owner, repo) {
  const client = ensureClient(deps);
  let fork = await client.getFork(deps.login, repo, deps.signal);
  if (!fork?.full_name) {
    try {
      const created = await client.createFork(owner, repo, deps.signal);
      fork = created?.full_name ? created : null;
    } catch (error) {
      if (error instanceof GitHubError && error.status === 422) {
        fork = await client.getFork(deps.login, repo, deps.signal);
      } else {
        throw fail(`Could not create a fork for ${owner}/${repo}: ${error instanceof Error ? error.message : String(error)}`, 'FORK_FAILED');
      }
    }
  }
  for (let attempt = 0; attempt < 15 && !fork?.clone_url; attempt += 1) {
    await sleep(2_000, deps.signal);
    fork = await client.getFork(deps.login, repo, deps.signal);
  }
  if (!fork?.clone_url) throw fail(`Fork ${deps.login}/${repo} did not become ready in time.`, 'FORK_NOT_READY');
  return fork;
}

function validatePrFields(args) {
  const title = String(args.title ?? '').trim();
  const body = String(args.body ?? '').trim();
  if (title.length === 0) throw fail('title is required', 'PR_TITLE_REQUIRED');
  if (title.length > 256) throw fail('title must be at most 256 characters', 'PR_TITLE_TOO_LONG');
  if (body.length < 20) throw fail('body must be a substantive PR description (at least 20 characters)', 'PR_BODY_REQUIRED');
  if (body.length > 60_000) throw fail('body must be at most 60000 characters', 'PR_BODY_TOO_LONG');
  return { title, body };
}

async function assertSafeChanges(repoDir, files, diff) {
  const blocked = [];
  const large = [];
  for (const file of files) {
    const reason = blockedFileName(file);
    if (reason) blocked.push(`${file} (${reason})`);
    try {
      const info = await stat(path.join(repoDir, file));
      if (info.isFile() && info.size > 5 * 1024 * 1024) large.push(`${file} (${Math.round(info.size / 1024)} KiB)`);
    } catch {
      // Deleted files have no stat entry.
    }
  }
  const secrets = scanDiff(diff);
  if (blocked.length > 0 || large.length > 0 || secrets.length > 0) {
    const parts = [];
    if (secrets.length > 0) parts.push(`possible secrets: ${secrets.join(', ')}`);
    if (blocked.length > 0) parts.push(`blocked files: ${blocked.slice(0, 8).join(', ')}`);
    if (large.length > 0) parts.push(`files larger than 5 MiB: ${large.slice(0, 8).join(', ')}`);
    throw fail(`Refusing to publish this diff — ${parts.join('; ')}. Remove or gitignore these files and rotate any exposed credential.`, 'UNSAFE_DIFF');
  }
  return { blocked, large, secrets };
}

export async function submitPullRequest(deps, args) {
  const client = ensureClient(deps);
  await ensureUser(deps);
  const run = await getRunRequired(deps, args.run_id);
  if (['merged', 'closed'].includes(run.phase)) throw fail(`Run ${run.id} is ${run.phase}; there is nothing to publish.`, 'RUN_TERMINAL');
  if (!run.work?.repoPath || !run.work?.branch) throw fail('Run has no worktree. Call oss_start_work first.', 'WORK_NOT_STARTED');
  const { owner, repo, issueNumber } = run;
  const repoData = await getRepoData(deps, owner, repo);
  const repoDir = run.work.repoPath;
  if (!(await isGitRepository(repoDir).catch(() => false))) throw fail(`Not a git repository: ${repoDir}`, 'NOT_A_REPO');
  const branchNow = await currentBranch(repoDir).catch(() => '');
  if (branchNow !== run.work.branch) {
    throw fail(`The worktree is on ${branchNow || 'a detached HEAD'}, but the run expects ${run.work.branch}. Check out the run branch before publishing.`, 'WRONG_BRANCH');
  }

  const status = await statusPorcelain(repoDir);
  const hasChanges = status.length > 0;
  const base = run.work.base;
  await fetchOrigin(repoDir, { url: repoData.clone_url, token: deps.token, signal: deps.signal, branch: base });
  const aheadBefore = await commitsAhead(repoDir, { base });
  if (!hasChanges && aheadBefore === 0 && !run.pr) throw fail('No changes to publish. Implement the fix first.', 'NOTHING_TO_PUBLISH');
  const fields = validatePrFields(args);
  const commitMessage = String(args.commit_message ?? `Fix #${issueNumber}: ${fields.title}`).trim();
  if (commitMessage.length === 0 || commitMessage.length > 10_000) throw fail('commit_message must be between 1 and 10000 characters', 'INVALID_COMMIT_MESSAGE');

  if (args.dry_run === true || deps.config.dryRun) {
    return {
      ok: true,
      dry_run: true,
      run_id: run.id,
      branch: run.work.branch,
      base,
      git_status: status,
      commits_ahead: aheadBefore,
      would_create_or_update_pr: true,
      title: fields.title,
      message: 'Dry run only. Nothing was staged, committed, pushed, or published.',
    };
  }

  const pushAllowed = mergePermission(repoData);
  let pushRemote = 'origin';
  let pushUrl = repoData.clone_url;
  let prHead = `${owner}:${run.work.branch}`;
  let fork = null;
  if (!pushAllowed) {
    if (!deps.config.fork) throw fail('The operator cannot push to this repository and fork mode is disabled in config.', 'NO_PUSH_PERMISSION');
    fork = await ensureFork(deps, owner, repo);
    await addOrSetRemote(repoDir, 'fork', fork.clone_url);
    pushRemote = 'fork';
    pushUrl = fork.clone_url;
    prHead = `${deps.login}:${run.work.branch}`;
    run.repository.forkFullName = fork.full_name;
  }

  let files = [];
  let diff = '';
  let diffStat = '';
  if (hasChanges) {
    await stageAll(repoDir);
    files = await stagedFiles(repoDir);
    if (files.length === 0) throw fail('No staged files after git add. Check .gitignore rules.', 'NOTHING_STAGED');
    diff = await stagedDiff(repoDir);
    diffStat = await stagedStat(repoDir);
    await assertSafeChanges(repoDir, files, diff);
  }

  let committed = false;
  if (hasChanges) {
    const result = await commit(repoDir, commitMessage, { signal: deps.signal });
    committed = result.committed;
    if (!committed) throw fail('Nothing was committed; the working tree changed unexpectedly.', 'COMMIT_EMPTY');
  }

  const ahead = await commitsAhead(repoDir, { base });
  if (ahead === 0 && !run.pr) throw fail('The branch has no commits ahead of the base branch.', 'NO_COMMITS');
  if (ahead > 0) {
    await push(repoDir, {
      remote: pushRemote,
      branch: run.work.branch,
      url: pushUrl,
      token: deps.token,
      signal: deps.signal,
    });
  }
  const headSha = await revParse(repoDir, 'HEAD');
  const bodyWithLink = ensureIssueLink(fields.body, issueNumber);
  let body = bodyWithLink;
  if (deps.config.usePrTemplate !== false) {
    const template = await readPullRequestTemplate(repoDir);
    if (template) body = `${template.trim()}\n\n${body.trim()}`;
  }
  if (deps.config.enforceDisclosure !== false) {
    body = appendDisclosure(body, deps);
  } else if (!hasDisclosure(body)) {
    appendEvent(run, 'disclosure_audit', 'PR body is missing the AI disclosure marker while enforceDisclosure is disabled');
  }

  let pr;
  let created = false;
  if (run.pr?.number) {
    const current = await client.getPull(owner, repo, run.pr.number, deps.signal);
    if (current.state !== 'open' || current.merged) throw fail(`PR #${run.pr.number} is ${current.merged ? 'merged' : current.state}; it cannot be updated.`, 'PR_CLOSED');
    const patch = { title: fields.title, body };
    if (args.draft === false && current.draft) patch.draft = false;
    pr = await client.updatePull(owner, repo, run.pr.number, patch, deps.signal);
  } else {
    try {
      pr = await client.createPull(owner, repo, {
        title: fields.title,
        head: prHead,
        base,
        body,
        draft: args.draft === true,
      }, deps.signal);
      created = true;
    } catch (error) {
      if (error instanceof GitHubError && error.status === 422 && /already exists/i.test(error.message)) {
        const candidates = await client.listPullsByHead(owner, repo, prHead, deps.signal);
        const open = candidates.find((candidate) => candidate.state === 'open');
        if (!open) throw error;
        pr = open;
      } else {
        throw error;
      }
    }
  }

  run.pr = {
    number: pr.number,
    url: pr.html_url,
    headSha,
    headRef: pr.head?.ref ?? run.work.branch,
    baseRef: pr.base?.ref ?? base,
    state: pr.state,
    isDraft: Boolean(pr.draft),
    createdAt: pr.created_at ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  run.phase = pr.draft ? 'draft' : 'pr_open';
  run.repository.pushAllowed = pushAllowed;
  run.repository.forkFullName = fork?.full_name ?? run.repository.forkFullName ?? null;
  if (Array.isArray(deps.config.prLabels) && deps.config.prLabels.length > 0) {
    try {
      await client.addLabels(owner, repo, pr.number, deps.config.prLabels, deps.signal);
      appendEvent(run, 'pr_labeled', `Applied labels: ${deps.config.prLabels.join(', ')}`);
    } catch (error) {
      appendEvent(run, 'label_failed', `Could not apply PR labels: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  appendEvent(run, created ? 'pr_created' : 'pr_updated', `${pr.html_url} @ ${headSha.slice(0, 12)}`);
  const watch = await armSchedule(deps, run, 'pr');
  await saveRun(deps.stateRoot, run);

  return {
    ok: true,
    run_id: run.id,
    created,
    pr: {
      number: pr.number,
      url: pr.html_url,
      state: pr.state,
      draft: Boolean(pr.draft),
      head: prHead,
      base,
      head_sha: headSha,
    },
    push: { remote: pushRemote, fork: fork?.full_name ?? null, operator: deps.login },
    changed_files: files.slice(0, 50),
    diff_stat: diffStat,
    commit: { committed, message: commitMessage },
    watch,
    next_action: 'wait_for_checks',
    next_steps: [
      'The watcher will wake this session when CI or review state changes.',
      'Call oss_sync_status for an immediate status refresh.',
      'Fix failures at their root cause; push review fixes as new commits unless a maintainer asks for a rewrite.',
    ],
  };
}

export async function syncStatus(deps, args) {
  const client = ensureClient(deps);
  await ensureUser(deps);
  const run = await getRunRequired(deps, args.run_id);
  const { owner, repo, issueNumber } = run;
  const [issue, repoData] = await Promise.all([
    client.getIssue(owner, repo, issueNumber, deps.signal),
    getRepoData(deps, owner, repo),
  ]);
  const login = deps.login;
  const assignment = assignmentState(issue, login);
  const comments = await client.listIssueComments(owner, repo, issueNumber, { signal: deps.signal });
  const claim = claimState(comments, login, deps.config, assignment === 'assigned_to_operator');
  const maintainer = maintainerSignal(comments, claim, login);
  applyMaintainerReplyRule(claim, maintainer);
  const warnings = [];

  if (!run.pr?.number) {
    let phase = run.phase;
    if (issue.state === 'closed') phase = 'closed';
    else if (assignment === 'assigned_to_other') phase = 'taken';
    else if (assignment === 'assigned_to_operator') phase = 'assigned';
    else if (claim.requested) phase = 'claim_requested';
    const next = nextActionForNoPr({ assignment, issueClosed: issue.state === 'closed', claim, maintainer });
    if (phase === 'closed' || phase === 'taken' || next.kind === 'done') {
      const stopped = await stopSchedule(deps, run);
      if (stopped.warning) warnings.push(stopped.warning);
    }
    const key = statusKey({ phase, assignment, followUpDue: claim.follow_up_due, maintainer: maintainer.possible_go_ahead, comments: comments.length });
    const changed = run.lastStatusKey !== key;
    run.phase = phase;
    run.claim.followUps = claim.follow_ups;
    run.claim.requestedAt ??= claim.requested_at;
    run.claim.commentUrl ??= claim.comment_url;
    run.lastStatusKey = key;
    run.lastNextAction = next.kind;
    appendEvent(run, 'status', `no PR; ${assignment}; next=${next.kind}`);
    await saveRun(deps.stateRoot, run);
    return {
      ok: true,
      run_id: run.id,
      phase,
      issue: {
        state: issue.state,
        title: issue.title,
        url: issue.html_url,
        assignees: (issue.assignees ?? []).map((assignee) => assignee.login),
      },
      assignment,
      claim,
      maintainer_signal: maintainer,
      next_action: next.kind,
      next_reason: next.reason,
      needs_action: actionNeedsWork(next.kind),
      changed_since_last_check: changed,
      watch: run.schedule,
      warnings,
    };
  }

  const pr = await client.getPull(owner, repo, run.pr.number, deps.signal);
  const checks = await client.getChecks(owner, repo, pr.head?.sha ?? run.pr.headSha, deps.signal);
  const [reviews, reviewComments] = await Promise.all([
    client.listReviews(owner, repo, pr.number, { signal: deps.signal }),
    client.listReviewComments(owner, repo, pr.number, { signal: deps.signal }),
  ]);
  const review = summarizeReviews(reviews);
  const next = nextActionForPr({ pr, checks, review, repo: repoData, config: deps.config });
  const phase = pr.merged ? 'merged'
    : pr.state === 'closed' ? 'closed'
      : pr.draft ? 'draft'
        : pr.mergeable === false || pr.mergeable_state === 'dirty' ? 'conflict'
          : checks.overall === 'failure' ? 'ci_failed'
            : review.decision === 'changes_requested' ? 'changes_requested'
              : pr.mergeable_state === 'behind' ? 'behind'
                : checks.overall === 'pending' ? 'ci_pending'
                  : pr.mergeable_state === 'clean' || pr.mergeable_state === 'has_hooks' ? 'ready'
                    : pr.mergeable_state === 'blocked' || pr.mergeable_state === 'unstable' ? 'blocked'
                      : 'pr_open';

  const key = statusKey({
    phase,
    head: pr.head?.sha ?? null,
    checks: checks.overall,
    failing: (checks.failing ?? []).map((check) => check.name),
    review: review.decision,
    reviewers: review.changes_requested_by,
    comments: reviewComments.length,
    mergeable: pr.mergeable_state,
  });
  const changed = run.lastStatusKey !== key;
  run.phase = phase;
  run.pr = {
    ...(run.pr ?? {}),
    number: pr.number,
    url: pr.html_url,
    headSha: pr.head?.sha ?? run.pr.headSha,
    headRef: pr.head?.ref ?? run.pr.headRef,
    baseRef: pr.base?.ref ?? run.pr.baseRef,
    state: pr.state,
    isDraft: Boolean(pr.draft),
    merged: Boolean(pr.merged),
    mergedAt: pr.merged_at ?? null,
    closedAt: pr.closed_at ?? null,
    mergeableState: pr.mergeable_state ?? null,
  };
  run.lastStatusKey = key;
  run.lastNextAction = next.kind;

  if (pr.merged || pr.state === 'closed') {
    const stopped = await stopSchedule(deps, run);
    if (stopped.warning) warnings.push(stopped.warning);
  } else if (!run.schedule?.id || run.schedule.kind !== 'pr') {
    const watch = await armSchedule(deps, run, 'pr');
    if (watch.warning) warnings.push(watch.warning);
  }

  const gates = {
    has_merge_permission: mergePermission(repoData),
    checks_green: checks.overall !== 'failure' && checks.overall !== 'pending',
    no_conflicts: pr.mergeable !== false && pr.mergeable_state !== 'dirty',
    approved: review.decision === 'approved',
    not_draft: !pr.draft,
    clean_merge_state: pr.mergeable_state === 'clean' || pr.mergeable_state === 'has_hooks',
    auto_merge_enabled: deps.config.autoMerge,
  };
  appendEvent(run, 'status', `${phase}; checks=${checks.overall}; review=${review.decision}; next=${next.kind}`);
  await saveRun(deps.stateRoot, run);

  return {
    ok: true,
    run_id: run.id,
    phase,
    pr: {
      number: pr.number,
      url: pr.html_url,
      state: pr.state,
      draft: Boolean(pr.draft),
      merged: Boolean(pr.merged),
      mergeable: pr.mergeable,
      mergeable_state: pr.mergeable_state,
      head_sha: pr.head?.sha ?? run.pr.headSha ?? null,
      title: pr.title,
      changed_files: pr.changed_files ?? null,
      additions: pr.additions ?? null,
      deletions: pr.deletions ?? null,
    },
    checks: checksSummary(checks),
    review,
    review_comments: reviewCommentsSummary(reviewComments),
    maintainer_comments: mainterCommentsSummary(comments, login),
    gates,
    next_action: next.kind,
    next_reason: next.reason,
    needs_action: actionNeedsWork(next.kind),
    changed_since_last_check: changed,
    watch: run.schedule,
    warnings,
    guidance: next.kind === 'fix_ci'
      ? 'Read the failing logs, reproduce locally, fix the root cause, and call oss_submit_pr again with the same run_id.'
      : next.kind === 'address_review'
        ? 'Address each review thread with code or a reasoned reply. Push fixes as new commits; do not force-push unless a maintainer asks.'
        : next.kind === 'merge'
          ? 'Call oss_merge with confirm=true after verifying the gates and that the operator authorized the merge.'
          : 'If this needs a human decision, call oss_stop and explain what is needed. Do not spam maintainers.',
  };
}

export async function mergeRun(deps, args) {
  const client = ensureClient(deps);
  const run = await getRunRequired(deps, args.run_id);
  if (!run.pr?.number) throw fail('This run has no pull request to merge.', 'NO_PR');
  const sync = await syncStatus(deps, { run_id: run.id });
  const method = String(args.method ?? deps.config.mergeMethod).toLowerCase();
  if (!['squash', 'merge', 'rebase'].includes(method)) throw fail('method must be squash, merge, or rebase', 'INVALID_MERGE_METHOD');

  if (sync.next_action === 'update_branch') {
    if (args.confirm !== true) {
      return { ok: false, code: 'CONFIRMATION_REQUIRED', next_action: sync.next_action, gates: sync.gates, message: 'Re-run with confirm=true to update the branch, then wait for checks.' };
    }
    const repoData = await getRepoData(deps, run.owner, run.repo);
    if (!mergePermission(repoData)) {
      return { ok: false, code: 'NO_MERGE_PERMISSION', next_action: 'wait_for_maintainer_merge', gates: sync.gates, message: 'The operator cannot update this branch. Ask a maintainer to update it or rebase locally.' };
    }
    if (!sync.pr?.head_sha) {
      return { ok: false, code: 'NOT_READY', next_action: 'wait_for_ci', gates: sync.gates, message: 'GitHub did not return a head SHA; wait and retry.' };
    }
    await client.updateBranch(run.owner, run.repo, run.pr.number, sync.pr.head_sha, deps.signal);
    run.phase = 'behind';
    appendEvent(run, 'branch_updated', `PR #${run.pr.number} branch update requested`);
    await saveRun(deps.stateRoot, run);
    return { ok: true, updated: true, retry: true, next_action: 'wait_for_checks', message: 'Branch updated. Wait for checks to restart, then call oss_sync_status again.' };
  }

  if (sync.next_action !== 'merge') {
    return {
      ok: false,
      code: 'NOT_READY',
      next_action: sync.next_action,
      next_reason: sync.next_reason,
      gates: sync.gates,
      message: 'The PR is not merge-ready. Resolve the reported action first; do not bypass branch protection or required reviews.',
    };
  }
  if (args.confirm !== true) {
    return {
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      next_action: 'merge',
      gates: sync.gates,
      message: 'Re-run with confirm=true only after verifying the operator authorized this merge.',
    };
  }

  const repoData = await getRepoData(deps, run.owner, run.repo);
  if (!mergePermission(repoData)) {
    return { ok: false, code: 'NO_MERGE_PERMISSION', next_action: 'wait_for_maintainer_merge', gates: sync.gates, message: 'The authenticated operator lacks merge permission; a maintainer must merge.' };
  }
  let result;
  try {
    result = await client.mergePull(run.owner, run.repo, run.pr.number, {
      method,
      sha: sync.pr.head_sha,
      commitTitle: `${sync.pr.title ?? run.issueTitle} (#${run.pr.number})`,
    }, deps.signal);
  } catch (error) {
    if (error instanceof GitHubError && (error.status === 405 || error.status === 409)) {
      return {
        ok: false,
        code: 'MERGE_REJECTED',
        next_action: 'wait_for_review',
        gates: sync.gates,
        message: `GitHub rejected the merge (${error.status}). Branch protection or required reviews may still be missing: ${error.message}`,
      };
    }
    throw error;
  }
  run.phase = 'merged';
  run.pr.merged = true;
  run.pr.mergeMethod = method;
  run.pr.state = 'closed';
  run.pr.mergedAt = result?.merged_at ?? new Date().toISOString();
  run.pr.mergeCommitSha = result?.sha ?? null;
  const stopped = await stopSchedule(deps, run);
  appendEvent(run, 'merged', `PR #${run.pr.number} merged via ${method}`);
  await saveRun(deps.stateRoot, run);
  return {
    ok: true,
    merged: true,
    run_id: run.id,
    pr_url: run.pr.url,
    method,
    merge_commit_sha: result?.sha ?? null,
    watch_stopped: stopped.stopped,
    warning: stopped.warning ?? null,
    message: 'Pull request merged. The run is complete.',
  };
}

export async function stopRun(deps, args) {
  const run = await getRunRequired(deps, args.run_id);
  const stopped = await stopSchedule(deps, run);
  if (!['merged', 'closed'].includes(run.phase)) run.phase = 'paused';
  run.stoppedReason = clip(args.reason ?? 'Stopped by operator or agent', 1000);
  appendEvent(run, 'stopped', run.stoppedReason);
  await saveRun(deps.stateRoot, run);
  return {
    ok: true,
    run_id: run.id,
    phase: run.phase,
    watch_stopped: stopped.stopped,
    warning: stopped.warning ?? null,
    message: 'Recurring checks are stopped. The PR, comments, and branch were not changed.',
  };
}

export async function doctor(deps) {
  const config = deps.config;
  const result = {
    ok: false,
    config_path: path.join(deps.stateRoot, 'config.json'),
    state_path: path.join(deps.stateRoot, 'state.json'),
    workspace: deps.workspace,
    token_present: Boolean(deps.tokenInfo?.token),
    token_source: deps.tokenInfo?.source ?? null,
    git: null,
    api: null,
    runs: [],
    config,
    warnings: [],
  };
  try {
    result.git = { version: await gitVersion(), ok: true };
  } catch (error) {
    result.git = { ok: false, error: error instanceof Error ? error.message : String(error) };
    result.warnings.push('git is required to clone, commit, and push.');
  }
  if (deps.tokenInfo?.token) {
    try {
      const client = deps.client;
      const raw = await client.requestRaw('GET', '/user');
      const rate = await client.getRateLimit();
      const scopes = raw.headers.get('x-oauth-scopes');
      const parsedScopes = scopes ? scopes.split(',').map((scope) => scope.trim()).filter(Boolean) : [];
      const tokenType = getTokenType(deps.tokenInfo?.token ?? deps.token);
      const requiredScopes = tokenType === 'classic' ? ['repo'] : [];
      const missingScopes = requiredScopes.filter((scope) => !parsedScopes.includes(scope) && !(scope === 'repo' && parsedScopes.includes('public_repo')));
      result.api = {
        ok: true,
        login: raw.data?.login ?? null,
        name: raw.data?.name ?? null,
        token_type: tokenType,
        scopes: parsedScopes,
        required_scopes: requiredScopes,
        missing_scopes: missingScopes,
        rate_limit: rate?.resources?.core ?? null,
        note: scopes ? '' : 'Fine-grained tokens do not expose OAuth scopes; verify repository permissions in GitHub settings.',
      };
      if (missingScopes.length > 0) result.warnings.push(`The GitHub token may lack required scopes: ${missingScopes.join(', ')}.`);
    } catch (error) {
      result.api = { ok: false, error: error instanceof Error ? error.message : String(error) };
      result.warnings.push('The GitHub API probe failed. Check the token, network, and apiBaseUrl.');
    }
  } else {
    result.api = { ok: false, error: 'No token found.' };
    result.warnings.push('Set a GitHub token before claiming issues or opening PRs.');
  }
  try {
    result.runs = (await listRuns(deps.stateRoot)).map(compactRun);
  } catch (error) {
    result.warnings.push(`Could not read saved runs: ${error instanceof Error ? error.message : String(error)}`);
  }
  result.ok = Boolean(result.git?.ok && result.api?.ok && result.token_present);
  result.next_steps = result.ok
    ? ['Run oss_find_issues, then oss_claim_issue.', 'Load the open-source-autopilot skill before the first public action.']
    : [
        deps.tokenHelp,
        'Make sure git is installed and available on PATH.',
        'Restart DSH after changing environment variables.',
      ];
  return result;
}

export async function batchStatus(deps, args) {
  const runIds = Array.isArray(args?.run_ids) ? args.run_ids : [];
  if (runIds.length === 0) throw fail('run_ids must be a non-empty array', 'INVALID_RUN_IDS');
  if (runIds.length > 20) throw fail('run_ids must contain at most 20 runs', 'INVALID_RUN_IDS');
  const results = [];
  for (const runId of runIds) {
    try {
      results.push(await syncStatus(deps, { run_id: runId }));
    } catch (error) {
      results.push({ ok: false, run_id: runId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    ok: true,
    total: results.length,
    results,
    next_actions: [...new Set(results.map((result) => result.next_action).filter(Boolean))],
  };
}

export async function getOssConfig(deps) {
  return {
    ok: true,
    config_path: configPath(deps.stateRoot),
    config: deps.config,
  };
}

export async function setOssConfig(deps, args) {
  const key = String(args?.key ?? '').trim();
  const allowed = Object.keys(normalizeConfig({}));
  if (!allowed.includes(key)) throw fail(`Unknown config key: ${key}`, 'INVALID_CONFIG_KEY');

  const file = configPath(deps.stateRoot);
  let existing = {};
  try {
    const text = await readFile(file, 'utf8');
    const parsed = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw fail(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`, 'CONFIG_READ_FAILED');
  }

  const next = { ...existing, [key]: args?.value };
  const merged = normalizeConfig({ ...next, ...(deps.patchConfig ?? {}) });
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  deps.config = merged;
  return {
    ok: true,
    config_path: file,
    key,
    value: merged[key],
    config: merged,
  };
}

export { makeRunId, parseRunId, createRun, listRuns, compactRun, touchRun };
export {
  blockedFileName,
  claimState,
  ensureIssueLink,
  hasDisclosure,
  isValidBranchName,
  nextActionForNoPr,
  nextActionForPr,
  scanDiff,
  scanForDisclosure,
  slugify,
  summarizeReviews,
};
