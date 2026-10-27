import { DEFAULT_CONFIG, findToken, loadConfig, normalizeConfig, resolveStateRoot, tokenHelp } from './config.js';
import { GitHubClient } from './github.js';
import {
  batchClaim,
  batchStatus,
  claimIssue,
  doctor,
  draftReviewReplies,
  getLeaderboard,
  getMetrics,
  getOssConfig,
  mergeRun,
  processWebhook,
  searchIssues,
  startWork,
  setOssConfig,
  stopRun,
  submitPullRequest,
  syncStatus,
} from './workflow.js';

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: true,
    properties: {
      ok: { type: 'boolean' },
    },
  },
  render: (_args, value) => [{
    type: 'text',
    text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  }],
};

async function resolveWorkspace(ctx, agent) {
  const service = ctx.get?.('workingDirectory');
  if (service && agent) {
    try {
      return await service.ensure(agent);
    } catch {
      if (typeof service.defaultDirectory === 'string') return service.defaultDirectory;
    }
  }
  return process.cwd();
}

async function buildDeps(ctx, exec, patchConfig, { requireClient = true, doctorMode = false } = {}) {
  const stateRoot = resolveStateRoot();
  let config;
  let configError = null;
  try {
    config = await loadConfig({ root: stateRoot, patchConfig });
  } catch (error) {
    if (!doctorMode) throw error;
    configError = error instanceof Error ? error.message : String(error);
    config = normalizeConfig({ ...DEFAULT_CONFIG, ...patchConfig });
  }

  const tokenInfo = findToken(config);
  let client;
  if (tokenInfo) {
    client = new GitHubClient({ token: tokenInfo.token, apiBaseUrl: config.apiBaseUrl });
  }
  if (requireClient && !client) {
    throw new Error(`No GitHub token found. ${tokenHelp(config)}`);
  }

  const workspace = await resolveWorkspace(ctx, exec.agent);
  const workingDirectory = ctx.get?.('workingDirectory');
  const schedule = ctx.get?.('schedule');
  const deps = {
    client,
    config,
    patchConfig,
    stateRoot,
    tokenInfo,
    token: tokenInfo?.token,
    workspace,
    agent: exec.agent,
    schedule,
    signal: exec.signal,
    login: undefined,
    user: undefined,
    repoCache: undefined,
    tokenHelp: tokenHelp(config),
    configError,
    setWorkingDirectory: workingDirectory && exec.agent
      ? async (dir) => {
          await workingDirectory.set(exec.agent, dir, exec.signal);
        }
      : undefined,
  };
  return deps;
}

function callTitle(value, fallback) {
  const text = String(value ?? '').trim();
  return text.length > 0 ? text.slice(0, 120) : fallback;
}

function withToolErrors(fn) {
  return async (args, exec) => {
    try {
      return await fn(args, exec);
    } catch (error) {
      const code = error?.code ? `[${error.code}] ` : '';
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${code}${message}`);
    }
  };
}

/**
 * Register the model-facing OSS autopilot tools. Every tool is effect-scoped
 * through the registry; no process-global mutable handler is kept here.
 *
 * @param {any} ctx
 * @param {Record<string, unknown>} patchConfig
 */
export function registerOssTools(ctx, patchConfig = {}) {
  const register = (definition) => ctx.tools.register({ output: OUTPUT, timeoutMs: 120_000, ...definition });

  register({
    name: 'oss_doctor',
    description: 'Check GitHub authentication, git, merge policy, and saved open-source runs. Run this first; it does not post anything.',
    parameters: {},
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    execute: withToolErrors(async (_args, exec) => {
      const deps = await buildDeps(ctx, exec, patchConfig, { requireClient: false, doctorMode: true });
      const result = await doctor(deps);
      if (deps.configError) result.warnings.push(`Config error: ${deps.configError}`);
      return result;
    }),
    presentCall: () => ({ card: 'generic', title: 'Open Source Autopilot doctor', kind: 'other' }),
  });

  register({
    name: 'oss_find_issues',
    description: 'Search GitHub issues for suitable open-source work. Read-only; returns candidate issues with labels, assignees, comments, and body excerpts.',
    parameters: {
      query: { type: 'string', description: 'Optional GitHub issue search query. Defaults to open, unassigned issues. is:issue is added automatically.' },
      repo: { type: 'string', description: 'Optional owner/repository scope.' },
      label: { type: 'string', description: 'Optional label filter, such as "good first issue".' },
      language: { type: 'string', description: 'Optional repository language filter.' },
      limit: { type: 'number', description: 'Maximum results, 1-20. Defaults to 10.' },
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    execute: withToolErrors(async (args, exec) => {
      const deps = await buildDeps(ctx, exec, patchConfig);
      return searchIssues(deps, args);
    }),
    presentCall: (args) => ({ card: 'generic', title: callTitle(args.query || args.repo, 'Find open-source issues'), kind: 'search' }),
  });

  register({
    name: 'oss_claim_issue',
    description: 'Request assignment from maintainers with a public issue comment, or check/follow up. Public posting requires acknowledge_public_post=true. Load the open-source-autopilot skill before using this.',
    parameters: {
      repo: { type: 'string', required: true, description: 'owner/repository, for example "facebook/react".' },
      issue_number: { type: 'number', required: true, description: 'Issue number.' },
      action: { type: 'string', required: true, enum: ['request', 'status', 'follow_up'], description: 'request posts one claim comment; status is read-only; follow_up posts only when the polite follow-up window is due.' },
      message: { type: 'string', description: 'Optional custom claim text. The AI disclosure is appended automatically.' },
      acknowledge_public_post: { type: 'boolean', description: 'Must be true for request/follow_up. Set only when the operator has authorized public GitHub activity.' },
    },
    timeoutMs: 90_000,
    execute: withToolErrors(async (args, exec) => {
      const deps = await buildDeps(ctx, exec, patchConfig);
      return claimIssue(deps, args);
    }),
    presentCall: (args) => ({ card: 'generic', title: `${args.action || 'request'} ${args.repo}#${args.issue_number}`, kind: 'other' }),
  });

  register({
    name: 'oss_start_work',
    description: 'After assignment or an explicit maintainer go-ahead, clone the repository into the workspace, create an issue branch, and switch this session into the clone. Requires a prior oss_claim_issue run.',
    parameters: {
      repo: { type: 'string', required: true, description: 'owner/repository.' },
      issue_number: { type: 'number', required: true, description: 'Issue number.' },
      base: { type: 'string', description: 'Optional base branch. Defaults to the repository default branch.' },
      branch: { type: 'string', description: 'Optional branch name. Defaults to oss/issue-<n>-<slug>.' },
      allow_unassigned: { type: 'boolean', description: 'Set true only when a maintainer explicitly invited work without formal assignment.' },
    },
    timeoutMs: 300_000,
    execute: withToolErrors(async (args, exec) => {
      const deps = await buildDeps(ctx, exec, patchConfig);
      return startWork(deps, args);
    }),
    presentCall: (args) => ({ card: 'generic', title: `Start work on ${args.repo}#${args.issue_number}`, kind: 'other' }),
  });

  register({
    name: 'oss_submit_pr',
    description: 'Commit local changes, push to origin or a fork, and create or update the pull request. Scans the staged diff for secrets and credential files. This has public side effects.',
    parameters: {
      run_id: { type: 'string', required: true, description: 'Run id from oss_start_work, like owner/repo#123.' },
      title: { type: 'string', required: true, description: 'Pull request title, at most 256 characters.' },
      body: { type: 'string', required: true, description: 'Pull request body. Explain the change and the exact testing performed. Closes #N and the AI disclosure are appended.' },
      commit_message: { type: 'string', description: 'Commit message. Defaults to "Fix #N: <title>".' },
      draft: { type: 'boolean', description: 'Create as a draft. Set false to mark an existing draft ready for review.' },
      dry_run: { type: 'boolean', description: 'Validate the diff and report what would happen without committing, pushing, or opening a PR.' },
    },
    timeoutMs: 300_000,
    execute: withToolErrors(async (args, exec) => {
      const deps = await buildDeps(ctx, exec, patchConfig);
      return submitPullRequest(deps, args);
    }),
    presentCall: (args) => ({ card: 'generic', title: callTitle(args.title, `Publish ${args.run_id}`), kind: 'other' }),
  });

  register({
    name: 'oss_sync_status',
    description: 'Refresh issue, PR, CI, and review state, re-arm the persistent check, and return the single next_action to take. Read-only except for local state and the recurring reminder.',
    parameters: {
      run_id: { type: 'string', required: true, description: 'Run id, like owner/repo#123.' },
    },
    timeoutMs: 90_000,
    execute: withToolErrors(async (args, exec) => {
      const deps = await buildDeps(ctx, exec, patchConfig);
      return syncStatus(deps, args);
    }),
    presentCall: (args) => ({ card: 'generic', title: `Check ${args.run_id}`, kind: 'read' }),
  });

  register({
    name: 'oss_merge',
    description: 'Merge a pull request only when GitHub reports it clean, checks are green, and the operator has merge permission. confirm=true is mandatory. Never bypasses branch protection.',
    parameters: {
      run_id: { type: 'string', required: true, description: 'Run id, like owner/repo#123.' },
      confirm: { type: 'boolean', description: 'Must be true after verifying the operator authorized the merge. A false value returns the readiness gates without merging.' },
      method: { type: 'string', enum: ['squash', 'merge', 'rebase'], description: 'Merge method. Defaults to the plugin config (squash).' },
    },
    timeoutMs: 120_000,
    execute: withToolErrors(async (args, exec) => {
      const deps = await buildDeps(ctx, exec, patchConfig);
      return mergeRun(deps, args);
    }),
    presentCall: (args) => ({ card: 'generic', title: `Merge ${args.run_id}`, kind: 'other' }),
  });

  register({
    name: 'oss_config',
    description: 'Read or update the Open Source Autopilot configuration file. Use action "set" with a valid config key and JSON value.',
    parameters: {
      action: { type: 'string', enum: ['get', 'set'], description: 'get returns the active config; set writes one key to config.json.' },
      key: { type: 'string', description: 'Configuration key to update when action is set.' },
      value: { description: 'JSON value for the configuration key when action is set.' },
    },
    timeoutMs: 30_000,
    execute: withToolErrors(async (args, exec) => {
      const deps = await buildDeps(ctx, exec, patchConfig, { requireClient: false });
      if (args.action === 'set') return setOssConfig(deps, args);
      return getOssConfig(deps);
    }),
    presentCall: (args) => ({ card: 'generic', title: `Config ${args.action || 'get'}`, kind: 'read' }),
  });

  register({
    name: 'oss_batch_claim',
    description: 'Claim multiple eligible issues with a bounded, rate-limited batch. Requires acknowledge_public_post=true. Limited to five issues per batch.',
    parameters: {
      repo: { type: 'string', required: true, description: 'owner/repository.' },
      issue_numbers: { type: 'array', items: { type: 'number' }, description: 'Optional explicit issue numbers. Defaults to eligible search results.' },
      label: { type: 'string', description: 'Optional label filter when searching for issues.' },
      limit: { type: 'number', description: 'Maximum issues to claim, 1-5. Defaults to 3.' },
      message: { type: 'string', description: 'Optional custom claim text.' },
      acknowledge_public_post: { type: 'boolean', description: 'Must be true before public claim comments are posted.' },
    },
    timeoutMs: 300_000,
    execute: withToolErrors(async (args, exec) => {
      const deps = await buildDeps(ctx, exec, patchConfig);
      return batchClaim(deps, args);
    }),
    presentCall: (args) => ({ card: 'generic', title: `Batch claim ${args.repo}`, kind: 'other' }),
  });

  register({
    name: 'oss_batch_status',
    description: 'Refresh and aggregate status for multiple open-source runs at once. Returns each run status plus the set of next actions.',
    parameters: {
      run_ids: { type: 'array', items: { type: 'string' }, required: true, description: 'Run ids, like ["owner/repo#1", "owner/repo#2"].' },
    },
    timeoutMs: 180_000,
    execute: withToolErrors(async (args, exec) => {
      const deps = await buildDeps(ctx, exec, patchConfig);
      return batchStatus(deps, args);
    }),
    presentCall: (args) => ({ card: 'generic', title: `Batch status (${Array.isArray(args.run_ids) ? args.run_ids.length : 0})`, kind: 'read' }),
  });

  register({
    name: 'oss_draft_review_replies',
    description: 'Draft suggested replies to pull request review comments. Suggestions are returned only; nothing is posted automatically.',
    parameters: {
      run_id: { type: 'string', required: true, description: 'Run id, like owner/repo#123.' },
    },
    timeoutMs: 90_000,
    execute: withToolErrors(async (args, exec) => {
      const deps = await buildDeps(ctx, exec, patchConfig);
      return draftReviewReplies(deps, args);
    }),
    presentCall: (args) => ({ card: 'generic', title: `Draft review replies ${args.run_id}`, kind: 'read' }),
  });

  register({
    name: 'oss_metrics',
    description: 'Summarize run outcomes, success rate, merge time, and failure hotspots. Writes a local HTML report when possible.',
    parameters: {},
    timeoutMs: 60_000,
    execute: withToolErrors(async (_args, exec) => {
      const deps = await buildDeps(ctx, exec, patchConfig, { requireClient: false });
      return getMetrics(deps);
    }),
    presentCall: () => ({ card: 'generic', title: 'Open Source Autopilot metrics', kind: 'read' }),
  });

  register({
    name: 'oss_handle_webhook',
    description: 'Process a GitHub webhook payload for a tracked pull request and refresh the related run status.',
    parameters: {
      event: { type: 'string', description: 'GitHub event name, such as pull_request or check_suite.' },
      payload: { type: 'object', description: 'Parsed GitHub webhook payload.' },
    },
    timeoutMs: 90_000,
    execute: withToolErrors(async (args, exec) => {
      const deps = await buildDeps(ctx, exec, patchConfig);
      return processWebhook(deps, args);
    }),
    presentCall: (args) => ({ card: 'generic', title: `Handle webhook ${args.event || ''}`, kind: 'other' }),
  });

  register({
    name: 'oss_leaderboard',
    description: 'Rank repositories by merged pull requests and success rate across saved runs.',
    parameters: {},
    timeoutMs: 60_000,
    execute: withToolErrors(async (_args, exec) => {
      const deps = await buildDeps(ctx, exec, patchConfig, { requireClient: false });
      return getLeaderboard(deps);
    }),
    presentCall: () => ({ card: 'generic', title: 'Open Source Autopilot leaderboard', kind: 'read' }),
  });

  register({
    name: 'oss_stop',
    description: 'Stop recurring checks for a run and mark it paused. Does not close the PR, delete the branch, or withdraw public comments.',
    parameters: {
      run_id: { type: 'string', required: true, description: 'Run id, like owner/repo#123.' },
      reason: { type: 'string', description: 'Short reason stored with the run.' },
    },
    timeoutMs: 30_000,
    execute: withToolErrors(async (args, exec) => {
      const deps = await buildDeps(ctx, exec, patchConfig, { requireClient: false });
      return stopRun(deps, args);
    }),
    presentCall: (args) => ({ card: 'generic', title: `Stop ${args.run_id}`, kind: 'other' }),
  });
}
