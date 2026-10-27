import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { normalizeConfig } from '../lib/config.js';
import { ensureStateRoot, getRun } from '../lib/state.js';
import { runGit } from '../lib/git.js';
import {
  claimIssue,
  doctor,
  mergeRun,
  searchIssues,
  startWork,
  stopRun,
  submitPullRequest,
  syncStatus,
} from '../lib/workflow.js';

class FakeClient {
  constructor(cloneUrl) {
    this.cloneUrl = cloneUrl;
    this.repo = {
      full_name: 'acme/widget',
      default_branch: 'main',
      clone_url: cloneUrl,
      permissions: { push: true, admin: false, maintain: false },
    };
    this.issue = {
      number: 12,
      title: 'Fix the widget crash',
      body: 'The widget crashes when opened twice.',
      state: 'open',
      html_url: 'https://github.com/acme/widget/issues/12',
      labels: [{ name: 'bug' }],
      assignees: [],
    };
    this.assigned = false;
    this.comments = [];
    this.pull = null;
    this.reviews = [];
    this.reviewComments = [];
    this.checks = {
      overall: 'success',
      total: 1,
      passingCount: 1,
      failing: [],
      pending: [],
      checks: [{ name: 'tests', source: 'check_run', status: 'success', conclusion: 'success', url: null, summary: null }],
      headSha: 'sha',
    };
    this.merged = false;
    this.commentSeq = 0;
  }

  async getAuthenticatedUser() { return { login: 'octocat', id: 123, name: 'Octo Cat' }; }

  async getRepo() { return this.repo; }

  async requestRaw() { return { data: { login: 'octocat' }, headers: new Headers({ 'x-oauth-scopes': 'repo, workflow' }) }; }

  async getRateLimit() { return { resources: { core: { limit: 5000, remaining: 4999, reset: 0 } } }; }

  async getIssue() {
    return { ...this.issue, assignees: this.assigned ? [{ login: 'octocat' }] : [] };
  }

  async listIssueComments() { return this.comments; }

  async createIssueComment(_owner, _repo, _number, body) {
    this.commentSeq += 1;
    const comment = {
      body,
      user: { login: 'octocat' },
      author_association: 'NONE',
      created_at: new Date().toISOString(),
      html_url: `https://github.com/acme/widget/issues/12#issuecomment-${this.commentSeq}`,
    };
    this.comments.push(comment);
    return comment;
  }

  async searchIssues() {
    return {
      total_count: 1,
      items: [{
        number: 12,
        title: 'Fix the widget crash',
        html_url: 'https://github.com/acme/widget/issues/12',
        repository_url: 'https://api.github.com/repos/acme/widget',
        labels: [{ name: 'bug' }],
        assignees: [],
        comments: 0,
        state: 'open',
        locked: false,
        updated_at: new Date().toISOString(),
        body: 'The widget crashes.',
      }],
    };
  }

  async getPull() {
    if (!this.pull) throw new Error('no pull');
    return this.pull;
  }

  async createPull(_owner, _repo, input) {
    this.pull = {
      number: 7,
      html_url: 'https://github.com/acme/widget/pull/7',
      state: 'open',
      draft: Boolean(input.draft),
      title: input.title,
      body: input.body,
      head: { ref: input.head, sha: null },
      base: { ref: input.base },
      mergeable: true,
      mergeable_state: 'clean',
      merged: false,
      merged_at: null,
      closed_at: null,
      changed_files: 1,
      additions: 1,
      deletions: 0,
      created_at: new Date().toISOString(),
    };
    return this.pull;
  }

  async updatePull(_owner, _repo, _number, patch) {
    this.pull = { ...this.pull, ...patch };
    return this.pull;
  }

  async listPullsByHead() { return this.pull ? [this.pull] : []; }

  async listReviews() { return this.reviews; }

  async listReviewComments() { return this.reviewComments; }

  async getChecks() { return this.checks; }

  async mergePull() {
    this.merged = true;
    this.pull = { ...this.pull, merged: true, state: 'closed', merged_at: new Date().toISOString() };
    return { merged: true, sha: 'merge-sha' };
  }

  async updateBranch() { return { message: 'updated' }; }

  async getFork() { return null; }

  async createFork() { return { full_name: 'octocat/widget', clone_url: this.repo.clone_url }; }
}

class FakeSchedule {
  constructor() {
    this.created = [];
    this.deleted = [];
    this.seq = 0;
  }

  async create(sessionId, request) {
    this.seq += 1;
    const record = { id: `sched-${this.seq}`, sessionId, ...request };
    this.created.push(record);
    return record;
  }

  async delete(request) {
    this.deleted.push(request);
    return { id: request.id, deleted: true };
  }
}

async function seedRepository(root) {
  const bare = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  await runGit(root, ['init', '--bare', bare]);
  await runGit(root, ['init', seed]);
  await writeFile(path.join(seed, 'README.md'), '# Widget\n', 'utf8');
  await runGit(seed, ['add', '.']);
  await runGit(seed, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.test', 'commit', '-m', 'initial']);
  await runGit(seed, ['branch', '-M', 'main']);
  await runGit(seed, ['remote', 'add', 'origin', bare]);
  await runGit(seed, ['push', 'origin', 'main']);
  await runGit(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  return bare;
}

test('end-to-end: claim, start, PR, status, merge, and watcher lifecycle', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oss-flow-'));
  try {
    const bare = await seedRepository(root);
    const client = new FakeClient(bare);
    const schedule = new FakeSchedule();
    const stateRoot = path.join(root, 'state');
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    await ensureStateRoot(stateRoot);
    let changedCwd = null;
    const deps = {
      client,
      config: normalizeConfig({
        pollSeconds: 60,
        claimPollSeconds: 60,
        claimFollowUpHours: 1,
        maxClaimFollowUps: 2,
        autoMerge: true,
        fork: false,
        requireAssignment: true,
        dryRun: false,
      }),
      stateRoot,
      tokenInfo: { token: 'test-token', source: 'test' },
      token: 'test-token',
      workspace,
      agent: { id: 'session-test' },
      schedule,
      signal: new AbortController().signal,
      login: 'octocat',
      user: { login: 'octocat', id: 123 },
      tokenHelp: 'set a token',
      setWorkingDirectory: async (dir) => { changedCwd = dir; },
    };

    const search = await searchIssues(deps, { label: 'good first issue', limit: 3 });
    assert.equal(search.issues.length, 1);
    assert.equal(search.issues[0].eligible_for_claim, true);

    const claimed = await claimIssue(deps, {
      repo: 'acme/widget',
      issue_number: 12,
      action: 'request',
      acknowledge_public_post: true,
    });
    assert.equal(claimed.ok, true);
    assert.equal(claimed.next_action, 'wait_for_assignment');
    assert.match(client.comments[0].body, /AI assistance/);
    assert.match(client.comments[0].body, /dsh-oss-autopilot:claim/);
    assert.equal(schedule.created.length, 1);
    let run = await getRun(stateRoot, 'acme/widget#12');
    assert.equal(run.phase, 'claim_requested');
    assert.equal(run.schedule.kind, 'claim');

    client.assigned = true;
    const status = await claimIssue(deps, { repo: 'acme/widget', issue_number: 12, action: 'status' });
    assert.equal(status.assignment, 'assigned_to_operator');
    assert.equal(status.next_action, 'start_work');

    const started = await startWork(deps, { repo: 'acme/widget', issue_number: 12 });
    assert.equal(started.ok, true);
    assert.equal(started.assignment, 'assigned_to_operator');
    assert.equal(started.cwd_changed, true);
    assert.equal(changedCwd, started.repo_path);
    assert.equal(schedule.deleted.length, 1);

    await writeFile(path.join(started.repo_path, 'fix.txt'), 'fixed\n', 'utf8');
    const submitted = await submitPullRequest(deps, {
      run_id: 'acme/widget#12',
      title: 'Fix widget crash',
      body: '## Summary\nFix the crash.\n\n## Testing\n- node --test passed',
      commit_message: 'Fix widget crash',
    });
    assert.equal(submitted.created, true);
    assert.match(client.pull.body, /Closes #12/);
    assert.match(client.pull.body, /dsh-oss-autopilot:ai-disclosure/);
    assert.equal(schedule.created.length, 2);
    assert.equal(schedule.created[1].prompt.includes('oss_sync_status'), true);

    run = await getRun(stateRoot, 'acme/widget#12');
    assert.equal(run.phase, 'pr_open');
    assert.ok(run.pr.headSha);
    client.pull.head.sha = run.pr.headSha;
    client.reviews = [{
      state: 'APPROVED',
      user: { login: 'maintainer' },
      submitted_at: new Date().toISOString(),
      html_url: 'https://github.com/acme/widget/pull/7#pullrequestreview-1',
    }];

    const sync = await syncStatus(deps, { run_id: 'acme/widget#12' });
    assert.equal(sync.next_action, 'merge');
    assert.equal(sync.needs_action, true);
    assert.equal(sync.gates.checks_green, true);

    const merged = await mergeRun(deps, { run_id: 'acme/widget#12', confirm: true });
    assert.equal(merged.merged, true);
    assert.equal(client.merged, true);
    run = await getRun(stateRoot, 'acme/widget#12');
    assert.equal(run.phase, 'merged');
    assert.equal(run.schedule, null);
    assert.equal(schedule.deleted.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('doctor reports a working token and git, and stop pauses a run', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oss-doctor-'));
  try {
    const bare = await seedRepository(root);
    const client = new FakeClient(bare);
    const deps = {
      client,
      config: normalizeConfig({}),
      stateRoot: path.join(root, 'state'),
      tokenInfo: { token: 'test-token', source: 'test' },
      token: 'test-token',
      workspace: root,
      agent: { id: 'session-test' },
      schedule: new FakeSchedule(),
      signal: new AbortController().signal,
      login: 'octocat',
      user: { login: 'octocat', id: 123 },
      tokenHelp: 'set a token',
    };
    const report = await doctor(deps);
    assert.equal(report.ok, true);
    assert.equal(report.api.login, 'octocat');
    assert.equal(report.git.ok, true);

    await claimIssue(deps, {
      repo: 'acme/widget',
      issue_number: 12,
      action: 'request',
      acknowledge_public_post: true,
    });
    const stopped = await stopRun(deps, { run_id: 'acme/widget#12', reason: 'test stop' });
    assert.equal(stopped.ok, true);
    assert.equal(stopped.watch_stopped, true);
    assert.equal((await getRun(deps.stateRoot, 'acme/widget#12')).phase, 'paused');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
